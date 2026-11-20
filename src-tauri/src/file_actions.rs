//! "Open" and "Reveal in Explorer/Finder" for the files tool cards show (docs/PROJECT_PLAN.md §5).
//!
//! The webview names a path; Rust decides. The path is made absolute (relative ones are taken
//! from the workspace, as agent86's tools take them), canonicalized with symlinks followed, and
//! must then lie inside the thread's workspace or a worktree one of its sub-agents kept. Opening
//! hands the file to its default app, which for a program or script would run it, so those can
//! only be revealed.

use std::path::{Path, PathBuf};

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
}
