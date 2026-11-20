//! The workspace's files, for `@` mentions: finding them as the user types, and inlining the ones a
//! prompt mentions.
//!
//! agent86's CLI inlines `@path` mentions itself (agent86-core's SDK takes the goal as it is), so
//! the app does the same here, inside the workspace jail: a mentioned path must resolve, symlinks
//! followed, to a file inside the workspace, and no larger than the CLI's `mention_max_bytes`.

use ignore::WalkBuilder;
use std::path::{Path, PathBuf};

/// The most files one search looks at, and how deep it goes (agent86-web's bounds).
const MAX_FILES_SCANNED: usize = 5_000;
const MAX_DEPTH: usize = 8;
/// Folders skipped even when no `.gitignore` names them.
const SKIPPED_DIRS: &[&str] = &["node_modules", "target", "__pycache__", "dist", "build"];

/// Workspace files whose path matches `query`, best first, as `/`-separated relative paths.
/// Hidden files and folders, `.gitignore`d ones, and [`SKIPPED_DIRS`] are left out.
pub fn find(workspace: &Path, query: &str, limit: usize) -> Vec<String> {
    let query = query.to_lowercase().replace('\\', "/");
    let mut scored: Vec<(u8, String)> = Vec::new();
    let walk = WalkBuilder::new(workspace)
        .max_depth(Some(MAX_DEPTH))
        .hidden(true)
        .git_ignore(true)
        .git_global(false)
        .require_git(false)
        .filter_entry(|entry| {
            !(entry.file_type().is_some_and(|t| t.is_dir())
                && SKIPPED_DIRS.contains(&entry.file_name().to_string_lossy().as_ref()))
        })
        .build();
    for entry in walk
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_some_and(|t| t.is_file()))
        .take(MAX_FILES_SCANNED)
    {
        let Ok(relative) = entry.path().strip_prefix(workspace) else {
            continue;
        };
        let path = relative.to_string_lossy().replace('\\', "/");
        if let Some(score) = score(&path, &query) {
            scored.push((score, path));
        }
    }
    scored.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.len().cmp(&b.1.len()))
            .then(a.1.cmp(&b.1))
    });
    scored
        .into_iter()
        .take(limit)
        .map(|(_, path)| path)
        .collect()
}

/// Lower is better: the file name starts with the query, then contains it, then the path does.
fn score(path: &str, query: &str) -> Option<u8> {
    if query.is_empty() {
        return Some(3);
    }
    let lower = path.to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    if name.starts_with(query) {
        Some(0)
    } else if name.contains(query) {
        Some(1)
    } else if lower.contains(query) {
        Some(2)
    } else {
        None
    }
}

/// `text` with the content of each mentioned file appended, as the model should see it. The
/// transcript keeps what the user typed; this is only what the turn sends.
pub fn expand(
    workspace: &Path,
    text: &str,
    mentions: &[String],
    max_bytes: u64,
) -> Result<String, String> {
    let mut expanded = text.to_owned();
    let mut seen = Vec::new();
    for mention in mentions {
        if seen.contains(mention) {
            continue;
        }
        seen.push(mention.clone());
        let path = resolve(workspace, mention)?;
        let size = std::fs::metadata(&path)
            .map_err(|error| format!("@{mention}: {error}"))?
            .len();
        if max_bytes > 0 && size > max_bytes {
            return Err(format!(
                "@{mention} is {size} bytes, over the {max_bytes}-byte limit for a mention."
            ));
        }
        let bytes = std::fs::read(&path).map_err(|error| format!("@{mention}: {error}"))?;
        let content = String::from_utf8_lossy(&bytes);
        expanded.push_str(&format!(
            "\n\n<file path=\"{mention}\">\n{}{}</file>",
            content,
            if content.ends_with('\n') { "" } else { "\n" }
        ));
    }
    Ok(expanded)
}

/// A mentioned path as a file inside the workspace, or why it is not one.
fn resolve(workspace: &Path, mention: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(workspace).map_err(|error| error.to_string())?;
    let path = std::fs::canonicalize(root.join(mention))
        .map_err(|error| format!("@{mention}: {error}"))?;
    if !path.starts_with(&root) {
        return Err(format!("@{mention} is outside the workspace."));
    }
    if !path.is_file() {
        return Err(format!("@{mention} is not a file."));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("README.md"), "# Readme\n").unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(root.join("src/deep/mainframe.txt"), "x").unwrap();
        std::fs::write(root.join("node_modules/pkg/main.js"), "x").unwrap();
        std::fs::write(root.join(".git/config"), "x").unwrap();
        std::fs::write(root.join(".env"), "SECRET=1").unwrap();
        dir
    }

    #[test]
    fn finds_by_name_first_and_skips_hidden_and_vendored_files() {
        let dir = workspace();
        assert_eq!(
            find(dir.path(), "main", 10),
            vec!["src/main.rs", "src/deep/mainframe.txt"]
        );
        assert_eq!(find(dir.path(), "readme", 10), vec!["README.md"]);
        let all = find(dir.path(), "", 10);
        assert!(!all
            .iter()
            .any(|p| p.contains("node_modules") || p.starts_with('.')));
        assert_eq!(find(dir.path(), "", 1).len(), 1);
    }

    #[test]
    fn expands_mentions_once_each_in_order() {
        let dir = workspace();
        let text = expand(
            dir.path(),
            "look at @src/main.rs and @README.md",
            &[
                "src/main.rs".into(),
                "README.md".into(),
                "src/main.rs".into(),
            ],
            1000,
        )
        .unwrap();
        assert_eq!(
            text,
            "look at @src/main.rs and @README.md\n\n<file path=\"src/main.rs\">\nfn main() {}\n</file>\n\n<file path=\"README.md\">\n# Readme\n</file>"
        );
    }

    #[test]
    fn refuses_mentions_outside_the_workspace_missing_or_too_big() {
        let dir = workspace();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "no").unwrap();
        let escape = format!(
            "../{}/secret.txt",
            outside.path().file_name().unwrap().to_string_lossy()
        );
        // The temp dirs are siblings, so `..` from one reaches the other.
        assert!(expand(dir.path(), "x", &[escape], 1000)
            .unwrap_err()
            .contains("outside the workspace"));
        assert!(expand(dir.path(), "x", &["nope.txt".into()], 1000).is_err());
        assert!(expand(dir.path(), "x", &["src".into()], 1000)
            .unwrap_err()
            .contains("not a file"));
        assert!(expand(dir.path(), "x", &["README.md".into()], 3)
            .unwrap_err()
            .contains("limit"));
        // 0 means no cap, as in the CLI.
        assert!(expand(dir.path(), "x", &["README.md".into()], 0).is_ok());
    }
}
