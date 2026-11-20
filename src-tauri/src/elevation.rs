//! The app should not run as administrator: every command the agent runs would too, and Windows
//! will not let an elevated process follow the symlinks a normal user created (the Hugging Face
//! cache is made of them, so memory fell back to the hash embedder).
//!
//! Updating a per-machine (MSI) install elevates the installer, and its "launch the app" step
//! starts the app with the installer's admin token. So the app checks first thing: when elevated,
//! it starts itself again through `explorer.exe`, which runs programs as the signed-in user
//! without elevation, and exits.
//!
//! It stays elevated, and says why in the log, when:
//! - `AGENT86_DESKTOP_ALLOW_ELEVATED` is set (running as admin on purpose);
//! - `AGENT86_DESKTOP_CONFIG_DIR` is set (a separate profile; Explorer would not pass the variable
//!   on, so the relaunch would open the real one);
//! - it relaunched itself moments ago (with UAC off, Explorer is elevated too, and a relaunch
//!   would come back elevated forever).

/// What the startup check decided, logged once the log is set up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    NotElevated,
    /// Elevated, and staying so for this reason.
    Stayed(String),
}

/// Relaunch the app unelevated and exit if it is elevated, unless one of the exceptions in the
/// module docs applies. Returns only when the app should carry on in this process.
pub fn ensure_not_elevated() -> Outcome {
    #[cfg(windows)]
    {
        windows::ensure_not_elevated()
    }
    #[cfg(not(windows))]
    {
        Outcome::NotElevated
    }
}

/// Log what [`ensure_not_elevated`] decided.
pub fn log(outcome: &Outcome) {
    if let Outcome::Stayed(reason) = outcome {
        log::warn!("Running as administrator: {reason}");
    }
}

#[cfg(windows)]
mod windows {
    use super::Outcome;
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// A relaunch younger than this that comes back elevated is not tried again.
    const RELAUNCH_GUARD: Duration = Duration::from_secs(60);

    pub fn ensure_not_elevated() -> Outcome {
        if !is_elevated() {
            return Outcome::NotElevated;
        }
        if std::env::var_os("AGENT86_DESKTOP_ALLOW_ELEVATED").is_some() {
            return Outcome::Stayed("AGENT86_DESKTOP_ALLOW_ELEVATED is set.".into());
        }
        if std::env::var_os("AGENT86_DESKTOP_CONFIG_DIR").is_some() {
            return Outcome::Stayed(
                "a separate profile (AGENT86_DESKTOP_CONFIG_DIR) cannot be relaunched without \
                 elevation."
                    .into(),
            );
        }
        let marker = marker();
        if relaunched_recently(&marker) {
            return Outcome::Stayed(
                "it was relaunched without elevation and came back elevated (is UAC off?).".into(),
            );
        }
        let exe = match std::env::current_exe() {
            Ok(exe) => exe,
            Err(error) => return Outcome::Stayed(format!("its own path is unknown ({error}).")),
        };
        let _ = std::fs::write(&marker, b"");
        let explorer = std::env::var_os("WINDIR")
            .map(|dir| PathBuf::from(dir).join("explorer.exe"))
            .unwrap_or_else(|| PathBuf::from("explorer.exe"));
        match std::process::Command::new(explorer).arg(&exe).spawn() {
            // Gone before the new instance starts, so single-instance sees no other instance.
            Ok(_) => std::process::exit(0),
            Err(error) => {
                let _ = std::fs::remove_file(&marker);
                Outcome::Stayed(format!("Explorer could not relaunch it ({error})."))
            }
        }
    }

    /// Whether this process holds an elevated (administrator) token.
    fn is_elevated() -> bool {
        // SAFETY: the token handle is checked before use and closed after; the buffer is a
        // TOKEN_ELEVATION of the size passed.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut returned = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                (&raw mut elevation).cast(),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            );
            CloseHandle(token);
            ok != 0 && elevation.TokenIsElevated != 0
        }
    }

    fn marker() -> PathBuf {
        std::env::temp_dir().join("agent86-desktop-unelevated-relaunch")
    }

    fn relaunched_recently(marker: &std::path::Path) -> bool {
        std::fs::metadata(marker)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age < RELAUNCH_GUARD)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_fresh_marker_stops_a_second_relaunch_and_an_old_or_missing_one_does_not() {
            let dir = tempfile::tempdir().unwrap();
            let marker = dir.path().join("m");
            assert!(!relaunched_recently(&marker), "no marker");
            std::fs::write(&marker, b"").unwrap();
            assert!(relaunched_recently(&marker), "just written");
            let old = SystemTime::now() - RELAUNCH_GUARD - Duration::from_secs(5);
            std::fs::File::options()
                .write(true)
                .open(&marker)
                .unwrap()
                .set_modified(old)
                .unwrap();
            assert!(!relaunched_recently(&marker), "older than the guard");
        }

        #[test]
        fn the_test_runner_is_not_elevated() {
            // CI and this machine run tests as a normal user; a check that misread the token
            // would relaunch every normal start.
            if std::env::var_os("CI").is_none() {
                assert!(!is_elevated());
            }
        }
    }
}
