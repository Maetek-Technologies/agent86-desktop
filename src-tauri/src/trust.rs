//! Project trust (docs/PROJECT_PLAN.md §4): what a workspace brings with it is loaded only once
//! the user has reviewed and trusted it. That is its skills (`.agent86/skills`, `.claude/skills`),
//! its specialists (`.agent86/agents`), and the MCP servers in its `.agent86/config.toml`, the
//! parts of a repository someone else may have written that can make the agent run programs or
//! follow instructions. Nothing else in a project's config is used; the app's own settings decide
//! the rest.
//!
//! Trust is recorded by the SHA-256 of exactly what would be loaded (every file's path and
//! contents), in `{app config dir}/trusted-projects.json`, so any change, including one a model
//! made, is asked about again. The CLI keeps its own record (it trusts the config file only).

use crate::settings::McpServerSettings;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use ts_rs::TS;

/// Skill folders a project may bring, highest precedence first (agent86's order).
pub const SKILL_DIRS: [&str; 2] = [".agent86/skills", ".claude/skills"];
/// Where a project's specialists are defined (`<name>.md`).
pub const AGENTS_DIR: &str = ".agent86/agents";
/// The project config; only its MCP servers are used.
pub const CONFIG_FILE: &str = ".agent86/config.toml";

/// Past these, a project is refused rather than hashed: nobody reviews that much.
const MAX_FILES: usize = 2000;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectFile {
    /// Relative to the workspace, with `/`.
    pub path: String,
    #[ts(type = "number")]
    pub bytes: u64,
}

/// Everything a workspace would load once trusted.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectContent {
    pub workspace: String,
    /// Skill names (folders holding a `SKILL.md`).
    pub skills: Vec<String>,
    /// Specialist names (`<name>.md` in `.agent86/agents`).
    pub specialists: Vec<String>,
    /// The MCP servers its config defines (empty when it has no config).
    pub mcp_servers: BTreeMap<String, McpServerSettings>,
    /// The config file's text, shown whole for review.
    pub config: Option<String>,
    /// What to know: servers skipped, values read from the environment or keyring.
    pub notes: Vec<String>,
    /// Every file that counts toward the hash.
    pub files: Vec<ProjectFile>,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TrustState {
    /// Trusted as it is now: loaded.
    Trusted,
    /// Never trusted: not loaded.
    Untrusted,
    /// Trusted once, and changed since: not loaded until trusted again.
    Changed,
}

/// What the thread view shows about its project.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectStatus {
    pub state: TrustState,
    pub skills: Vec<String>,
    pub specialists: Vec<String>,
    pub mcp_servers: Vec<String>,
}

impl ProjectContent {
    pub fn status(&self, state: TrustState) -> ProjectStatus {
        ProjectStatus {
            state,
            skills: self.skills.clone(),
            specialists: self.specialists.clone(),
            mcp_servers: self.mcp_servers.keys().cloned().collect(),
        }
    }

    /// The project's skill folders that exist, highest precedence first.
    pub fn skill_dirs(&self) -> Vec<PathBuf> {
        let workspace = Path::new(&self.workspace);
        SKILL_DIRS
            .iter()
            .map(|dir| workspace.join(dir))
            .filter(|dir| dir.is_dir())
            .collect()
    }

    /// The project's specialists folder, if it has one.
    pub fn agents_dir(&self) -> Option<PathBuf> {
        Some(Path::new(&self.workspace).join(AGENTS_DIR)).filter(|dir| dir.is_dir())
    }
}

/// What `workspace` would load once trusted; `None` when it brings nothing.
pub fn scan(workspace: &Path) -> Result<Option<ProjectContent>, String> {
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for dir in SKILL_DIRS.iter().chain([&AGENTS_DIR]) {
        walk(workspace, &workspace.join(dir), &mut files)?;
    }

    let config_path = workspace.join(CONFIG_FILE);
    let mut config = None;
    let mut mcp_servers = BTreeMap::new();
    let mut notes = Vec::new();
    if config_path.is_file() {
        let text = std::fs::read_to_string(&config_path)
            .map_err(|error| format!("{}: {error}", config_path.display()))?;
        match crate::cli_import::mcp_servers(&text) {
            Ok((servers, server_notes)) => {
                mcp_servers = servers;
                notes.extend(server_notes);
            }
            Err(error) => notes.push(format!(
                "{CONFIG_FILE} could not be read ({error}), so none of its MCP servers load."
            )),
        }
        // A config with no servers brings nothing, and is left out of the review.
        if !mcp_servers.is_empty() {
            files.push((CONFIG_FILE.to_owned(), config_path));
            config = Some(text);
        }
    }

    let skills = names(workspace, &SKILL_DIRS, |path| {
        path.is_dir() && path.join("SKILL.md").is_file()
    });
    let specialists = names(workspace, &[AGENTS_DIR], |path| {
        path.extension().is_some_and(|ext| ext == "md")
    })
    .into_iter()
    .map(|name| name.trim_end_matches(".md").to_owned())
    .collect::<Vec<_>>();
    if files.is_empty() {
        return Ok(None);
    }

    for (name, server) in &mcp_servers {
        let values = server
            .args
            .iter()
            .chain(server.env.values())
            .chain(server.headers.values())
            .chain([&server.url, &server.command]);
        if values.into_iter().any(|value| value.contains("${")) {
            notes.push(format!(
                "MCP server {name} reads ${{NAME}} values from your environment or OS keyring, \
                 and sends them wherever the server goes."
            ));
        }
    }

    files.sort();
    let mut digest = Sha256::new();
    let mut listed = Vec::new();
    let mut total = 0u64;
    for (relative, path) in &files {
        let bytes = std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
        total += bytes.len() as u64;
        if total > MAX_TOTAL_BYTES {
            return Err(format!(
                "This project's skills, specialists, and config are over {} MB, too much to \
                 review, so none of them load.",
                MAX_TOTAL_BYTES / (1024 * 1024)
            ));
        }
        digest.update(relative.as_bytes());
        digest.update([0]);
        digest.update(hex(&Sha256::digest(&bytes)).as_bytes());
        digest.update(b"\n");
        listed.push(ProjectFile {
            path: relative.clone(),
            bytes: bytes.len() as u64,
        });
    }
    Ok(Some(ProjectContent {
        workspace: workspace.display().to_string(),
        skills,
        specialists,
        mcp_servers,
        config,
        notes,
        files: listed,
        sha256: hex(&digest.finalize()),
    }))
}

/// Every file under `dir` (not following folder links), as (path relative to `workspace`, path).
fn walk(workspace: &Path, dir: &Path, files: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            walk(workspace, &path, files)?;
        } else if kind.is_file() || (kind.is_symlink() && path.is_file()) {
            if files.len() >= MAX_FILES {
                return Err(format!(
                    "This project has over {MAX_FILES} files of skills and specialists, too many \
                     to review, so none of them load."
                ));
            }
            let relative = path
                .strip_prefix(workspace)
                .unwrap_or(&path)
                .components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            files.push((relative, path));
        }
    }
    Ok(())
}

/// The names of the entries in `dirs` (relative to `workspace`) that `keep` accepts, sorted,
/// without repeats.
fn names(workspace: &Path, dirs: &[&str], keep: impl Fn(&Path) -> bool) -> Vec<String> {
    let mut found: Vec<String> = dirs
        .iter()
        .filter_map(|dir| std::fs::read_dir(workspace.join(dir)).ok())
        .flat_map(|entries| entries.flatten())
        .filter(|entry| keep(&entry.path()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    found.sort();
    found.dedup();
    found
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A trusted project, for the list in Settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrustedProject {
    pub workspace: String,
    pub sha256: String,
}

/// The trust records, in `{app config dir}/trusted-projects.json`.
pub struct TrustStore {
    file: Option<PathBuf>,
    records: Mutex<Option<BTreeMap<String, String>>>,
}

impl TrustStore {
    /// The store in `config_dir`. Without one, trust lasts until the app quits.
    pub fn open(config_dir: Option<&Path>) -> Self {
        Self {
            file: config_dir.map(|dir| dir.join("trusted-projects.json")),
            records: Mutex::new(None),
        }
    }

    /// How `content` stands.
    pub fn state(&self, content: &ProjectContent) -> TrustState {
        self.with(|records| match records.get(&content.workspace) {
            Some(sha) if *sha == content.sha256 => TrustState::Trusted,
            Some(_) => TrustState::Changed,
            None => TrustState::Untrusted,
        })
    }

    /// Trust `workspace` as it is now, provided it is still what the user reviewed (`sha256`).
    pub fn trust(&self, workspace: &Path, sha256: &str) -> Result<ProjectContent, String> {
        let content = scan(workspace)?.ok_or("This project has nothing to trust.")?;
        if content.sha256 != sha256 {
            return Err(
                "The project changed after you reviewed it. Review it again before trusting it."
                    .into(),
            );
        }
        self.update(|records| {
            records.insert(content.workspace.clone(), content.sha256.clone());
        })?;
        Ok(content)
    }

    /// Stop trusting `workspace`; whether it was trusted.
    pub fn forget(&self, workspace: &str) -> Result<bool, String> {
        let mut removed = false;
        self.update(|records| removed = records.remove(workspace).is_some())?;
        Ok(removed)
    }

    pub fn list(&self) -> Vec<TrustedProject> {
        self.with(|records| {
            records
                .iter()
                .map(|(workspace, sha256)| TrustedProject {
                    workspace: workspace.clone(),
                    sha256: sha256.clone(),
                })
                .collect()
        })
    }

    fn with<T>(&self, f: impl FnOnce(&BTreeMap<String, String>) -> T) -> T {
        let mut guard = self.lock();
        f(guard.get_or_insert_with(|| self.read()))
    }

    fn update(&self, f: impl FnOnce(&mut BTreeMap<String, String>)) -> Result<(), String> {
        let mut guard = self.lock();
        let records = guard.get_or_insert_with(|| self.read());
        f(records);
        let Some(file) = &self.file else {
            return Ok(());
        };
        write(file, records).map_err(|error| format!("{}: {error}", file.display()))
    }

    fn read(&self) -> BTreeMap<String, String> {
        self.file
            .as_deref()
            .and_then(|file| std::fs::read_to_string(file).ok())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<BTreeMap<String, String>>> {
        self.records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn write(path: &Path, records: &BTreeMap<String, String>) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(records).map_err(std::io::Error::other)?;
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, text + "\n")?;
    std::fs::rename(partial, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".agent86/skills/lint/scripts")).unwrap();
        std::fs::write(
            root.join(".agent86/skills/lint/SKILL.md"),
            "---\nname: lint\n---\n",
        )
        .unwrap();
        std::fs::write(root.join(".agent86/skills/lint/scripts/run.sh"), "echo hi").unwrap();
        std::fs::create_dir_all(root.join(".agent86/agents")).unwrap();
        std::fs::write(
            root.join(".agent86/agents/auditor.md"),
            "---\nname: auditor\n---\n",
        )
        .unwrap();
        std::fs::write(
            root.join(".agent86/config.toml"),
            "[model]\ndefault = \"x:y\"\n[mcp.servers.files]\ncommand = \"npx\"\nargs = [\"${TOKEN}\"]\n",
        )
        .unwrap();
        dir
    }

    #[test]
    fn a_plain_folder_brings_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(scan(dir.path()).unwrap(), None);
        // A config without servers brings nothing either.
        std::fs::create_dir_all(dir.path().join(".agent86")).unwrap();
        std::fs::write(
            dir.path().join(".agent86/config.toml"),
            "[limits]\nmax_steps = 3\n",
        )
        .unwrap();
        assert_eq!(scan(dir.path()).unwrap(), None);
    }

    #[test]
    fn scans_skills_specialists_and_servers() {
        let dir = project();
        let content = scan(dir.path()).unwrap().unwrap();
        assert_eq!(content.skills, vec!["lint"]);
        assert_eq!(content.specialists, vec!["auditor"]);
        assert_eq!(content.mcp_servers["files"].command, "npx");
        assert!(content
            .config
            .as_deref()
            .unwrap()
            .contains("[mcp.servers.files]"));
        let paths: Vec<_> = content.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                ".agent86/agents/auditor.md",
                ".agent86/config.toml",
                ".agent86/skills/lint/SKILL.md",
                ".agent86/skills/lint/scripts/run.sh",
            ]
        );
        assert!(
            content.notes.iter().any(|n| n.contains("keyring")),
            "{:?}",
            content.notes
        );
        assert_eq!(
            content.skill_dirs(),
            vec![dir.path().join(".agent86/skills")]
        );
        assert_eq!(
            content.agents_dir(),
            Some(dir.path().join(".agent86/agents"))
        );
    }

    #[test]
    fn any_change_to_a_file_needs_trust_again() {
        let dir = project();
        let config = tempfile::tempdir().unwrap();
        let store = TrustStore::open(Some(config.path()));
        let content = scan(dir.path()).unwrap().unwrap();
        assert_eq!(store.state(&content), TrustState::Untrusted);
        store.trust(dir.path(), &content.sha256).unwrap();
        assert_eq!(store.state(&content), TrustState::Trusted);
        // Remembered across a restart.
        let again = TrustStore::open(Some(config.path()));
        assert_eq!(again.state(&content), TrustState::Trusted);
        assert_eq!(again.list()[0].sha256, content.sha256);

        std::fs::write(
            dir.path().join(".agent86/skills/lint/scripts/run.sh"),
            "rm -rf /",
        )
        .unwrap();
        let changed = scan(dir.path()).unwrap().unwrap();
        assert_ne!(changed.sha256, content.sha256);
        assert_eq!(again.state(&changed), TrustState::Changed);
        // Trusting what was reviewed before the change is refused.
        assert!(again.trust(dir.path(), &content.sha256).is_err());
        assert!(again.forget(&content.workspace).unwrap());
        assert_eq!(again.state(&changed), TrustState::Untrusted);
    }
}
