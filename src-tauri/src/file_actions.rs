//! "Open" and "Reveal in Explorer/Finder" for the files tool cards show (docs/PROJECT_PLAN.md §5).
//!
//! The webview names a path; Rust decides. The path is made absolute (relative ones are taken
//! from the workspace, as agent86's tools take them), canonicalized with symlinks followed, and
//! must then lie inside the thread's workspace or a worktree one of its sub-agents kept. Opening
//! hands the file to its default app, which for a program or script would run it, so those can
//! only be revealed.
//!
//! Viewers read text files through the same `resolve` (`read_text`): UTF-8 only, with a size cap.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// Extensions whose default "open" runs something (programs, scripts, shortcuts, installers).
const RUNS_WHEN_OPENED: &[&str] = &[
    // Windows
    "exe",
    "com",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "msi",
    "msp",
    "msc",
    "scr",
    "pif",
    "cpl",
    "hta",
    "lnk",
    "url",
    "reg",
    "jar",
    "appref-ms",
    "scf",
    "inf",
    "application",
    "gadget",
    "settingcontent-ms",
    "library-ms",
    "website",
    // macOS
    "app",
    "command",
    "tool",
    "terminal",
    "workflow",
    "action",
    "pkg",
    "mpkg",
    "dmg",
    "scpt",
    "applescript",
    "webloc",
    "inetloc",
    "fileloc",
    // Linux and Unix
    "desktop",
    "sh",
    "bash",
    "zsh",
    "csh",
    "ksh",
    "fish",
    "run",
    "bin",
    "appimage",
    "deb",
    "rpm",
    "flatpakref",
];

/// `raw` resolved and checked against `roots` (the workspace first). The result exists, is
/// canonical, and lies inside one of the roots.
pub fn resolve(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("No file to open.".into());
    }
    let workspace = roots.first().ok_or("This thread has no workspace.")?;
    let given = Path::new(raw);
    let joined = if given.is_absolute() {
        given.to_owned()
    } else {
        workspace.join(given)
    };
    let path = std::fs::canonicalize(&joined).map_err(|error| format!("{raw}: {error}"))?;
    let inside = roots.iter().any(|root| {
        std::fs::canonicalize(root)
            .map(|root| path.starts_with(root))
            .unwrap_or(false)
    });
    if !inside {
        return Err(format!(
            "{raw} is outside this thread's workspace, so the app will not open it."
        ));
    }
    Ok(path)
}

/// Whether opening `path` with its default app would run it.
pub fn runs_when_opened(path: &Path) -> bool {
    if path.is_dir() {
        // A macOS bundle is a folder that opens as an app.
        return path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "app" | "workflow"));
    }
    let risky_extension = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| RUNS_WHEN_OPENED.contains(&e.to_ascii_lowercase().as_str()));
    risky_extension || executable(path)
}

#[cfg(unix)]
fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn executable(_path: &Path) -> bool {
    false
}

/// The path as the OS's file manager and apps read it (no `\\?\` prefix on Windows).
pub fn shown(path: PathBuf) -> PathBuf {
    crate::commands::strip_verbatim(path)
}

/// The most a viewer reads of one file. Markdown past this is not a document anyone reads in a
/// pane, and the whole text crosses IPC as one string.
pub const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

/// A text file read for a viewer (the Markdown viewer, docs/PROJECT_PLAN.md §7a).
#[derive(Debug, Serialize, PartialEq, Eq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    /// Absolute, canonical, as the OS shows it: relative links in the file are taken from its
    /// folder.
    pub path: String,
    /// The whole file, UTF-8, without a byte-order mark.
    pub text: String,
}

/// Read `path` (already through `resolve`) as UTF-8 text of at most `max` bytes.
pub fn read_text(path: &Path, max: u64) -> Result<TextFile, String> {
    let name = shown(path.to_owned()).display().to_string();
    let metadata = std::fs::metadata(path).map_err(|error| format!("{name}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{name} is not a file."));
    }
    let too_big = || {
        let limit = if max >= 1024 * 1024 {
            format!("{} MB", max / (1024 * 1024))
        } else {
            format!("{max} bytes")
        };
        format!("{name} is larger than {limit}, so the app will not show it.")
    };
    if metadata.len() > max {
        return Err(too_big());
    }
    // The file can grow between the check and the read: never take more than `max`.
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::fs::File::open(path)
        .and_then(|file| file.take(max + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("{name}: {error}"))?;
    if bytes.len() as u64 > max {
        return Err(too_big());
    }
    let mut text = String::from_utf8(bytes).map_err(|_| format!("{name} is not UTF-8 text."))?;
    if text.starts_with('\u{feff}') {
        text.drain(..'\u{feff}'.len_utf8());
    }
    Ok(TextFile { path: name, text })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(dir: &Path) -> Vec<PathBuf> {
        vec![dir.to_owned()]
    }

    #[test]
    fn paths_inside_the_workspace_resolve_relative_or_absolute() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/a.rs"), "x").unwrap();
        let canonical = std::fs::canonicalize(dir.path().join("src/a.rs")).unwrap();
        assert_eq!(resolve("src/a.rs", &roots(dir.path())).unwrap(), canonical);
        let absolute = dir.path().join("src/a.rs").display().to_string();
        assert_eq!(resolve(&absolute, &roots(dir.path())).unwrap(), canonical);
        assert!(resolve("src", &roots(dir.path())).unwrap().is_dir());
    }

    #[test]
    fn paths_outside_every_root_or_missing_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join("secret.txt"), "x").unwrap();
        std::fs::create_dir(dir.path().join("ws")).unwrap();
        let ws = dir.path().join("ws");
        let outside = other.path().join("secret.txt").display().to_string();
        let error = resolve(&outside, &roots(&ws)).unwrap_err();
        assert!(error.contains("outside"), "{error}");
        // `..` cannot climb out either.
        std::fs::write(dir.path().join("up.txt"), "x").unwrap();
        assert!(resolve("../up.txt", &roots(&ws)).is_err());
        assert!(resolve("missing.txt", &roots(&ws)).is_err());
        assert!(resolve("  ", &roots(&ws)).is_err());
        // A kept worktree is a root too.
        let with_worktree = vec![ws.clone(), other.path().to_owned()];
        assert!(resolve(&outside, &with_worktree).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_workspace_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join("t.txt"), "x").unwrap();
        std::os::unix::fs::symlink(other.path().join("t.txt"), dir.path().join("link")).unwrap();
        assert!(resolve("link", &roots(dir.path())).is_err());
    }

    #[test]
    fn programs_and_scripts_are_not_opened() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["run.BAT", "x.ps1", "a.exe", "s.sh", "l.lnk", "x.desktop"] {
            let path = dir.path().join(name);
            std::fs::write(&path, "x").unwrap();
            assert!(runs_when_opened(&path), "{name}");
        }
        for name in ["main.rs", "README.md", "notes.txt", "Makefile"] {
            let path = dir.path().join(name);
            std::fs::write(&path, "x").unwrap();
            assert!(!runs_when_opened(&path), "{name}");
        }
        assert!(!runs_when_opened(dir.path()));
    }

    #[test]
    fn a_text_file_inside_the_workspace_is_read_without_its_bom() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("docs")).unwrap();
        std::fs::write(dir.path().join("docs/plan.md"), "\u{feff}# Plan\n\nü\n").unwrap();
        let path = resolve("docs/plan.md", &roots(dir.path())).unwrap();
        let file = read_text(&path, MAX_TEXT_BYTES).unwrap();
        assert_eq!(file.text, "# Plan\n\nü\n");
        assert_eq!(file.path, shown(path).display().to_string());
        assert!(Path::new(&file.path).is_absolute());
    }

    #[test]
    fn folders_large_files_and_non_utf8_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let error = read_text(dir.path(), MAX_TEXT_BYTES).unwrap_err();
        assert!(error.contains("not a file"), "{error}");

        let big = dir.path().join("big.md");
        std::fs::write(&big, vec![b'a'; 11]).unwrap();
        assert!(read_text(&big, 11).is_ok());
        let error = read_text(&big, 10).unwrap_err();
        assert!(error.contains("larger than"), "{error}");

        let binary = dir.path().join("image.md");
        std::fs::write(&binary, [0x89, b'P', b'N', b'G', 0xff, 0xfe]).unwrap();
        let error = read_text(&binary, MAX_TEXT_BYTES).unwrap_err();
        assert!(error.contains("not UTF-8"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_workspace_is_never_read() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join("secret.md"), "x").unwrap();
        std::os::unix::fs::symlink(other.path().join("secret.md"), dir.path().join("notes.md"))
            .unwrap();
        // `read_text` is only ever reached through `resolve`, which refuses the link.
        let error = resolve("notes.md", &roots(dir.path())).unwrap_err();
        assert!(error.contains("outside"), "{error}");
    }
}
