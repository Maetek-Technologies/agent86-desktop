//! Links an agent86UI surface opens (`openUrl`; docs/agent86ui.md, "What the renderer must do
//! itself"). The webview shows the URL and asks the user first; Rust then opens it only if it is
//! `http` or `https`, since a URL from a binding or a function is known only once the renderer
//! resolves it, after agent86 checked the surface.

use tauri::Url;

/// `raw` as a link the app will open: `http` or `https`, with a host, and no user name or
/// password (`https://bank.example@evil.example` reads as the bank but goes elsewhere).
pub fn checked(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "That is not a web address.".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!(
            "Only http and https links open from a surface, not {}:.",
            url.scheme()
        ));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("That link has no host.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("A link with a user name or password in it is not opened.".into());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_plain_web_links() {
        assert_eq!(
            checked(" https://example.com/a?b=1 ").unwrap().as_str(),
            "https://example.com/a?b=1"
        );
        assert!(checked("http://localhost:8080/").is_ok());
        for refused in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:a@example.com",
            "tauri://localhost/",
            "https://bank.example@evil.example/",
            "https://user:pw@example.com/",
            "example.com",
            "",
        ] {
            assert!(checked(refused).is_err(), "{refused} was accepted");
        }
    }
}
