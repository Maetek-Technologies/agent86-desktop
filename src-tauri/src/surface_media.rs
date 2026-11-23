//! Workspace media for agent86UI surfaces (docs/agent86ui.md, "What the renderer must do itself").
//!
//! agent86 lets a surface's `Image`, `Video`, and `AudioPlayer` show a `data:` URL or a file given
//! as a path relative to the workspace, which the program serves. The webview loads such a file
//! from this app's own URI scheme, `agent86-media://localhost/<thread>/<path>` (on Windows
//! `http://agent86-media.localhost/...`; Tauri's `convertFileSrc` builds either), and nothing
//! else: the CSP allows media only from `'self'`, `data:`, and this scheme.
//!
//! A custom scheme rather than Tauri's asset protocol, because the asset protocol's scope is one
//! list for the whole app (every thread's workspace, any file type), where this resolves each
//! request against the workspace of the thread that named it. A request is served only if:
//! the thread is open; the path is relative; once canonicalized (symlinks followed) it lies inside
//! that workspace; it is a file; and its extension is an image, video, or audio type. Everything
//! else is refused with no detail beyond the status.

use crate::file_actions;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::http::{header, Request, Response, StatusCode};

/// The URI scheme the webview loads workspace media from.
pub const SCHEME: &str = "agent86-media";

/// The most one response carries; a larger file is played through range requests.
const MAX_BODY: u64 = 64 * 1024 * 1024;

/// The content type of a media file the scheme serves, by extension; `None` for anything else.
pub fn media_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        // An SVG loaded through <img> runs no script and loads nothing.
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        _ => return None,
    })
}

/// `relative` (as a surface gave it) resolved inside `workspace`: canonical, a file, and media.
pub fn resolve(workspace: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = relative.trim();
    let given = Path::new(relative);
    // agent86 only lets a surface name a path relative to the workspace; anything that roots
    // itself (`/etc/x`, `C:\x`, `\\server\x`) is refused before it is joined.
    if relative.is_empty()
        || given.is_absolute()
        || given.has_root()
        || relative.starts_with(['/', '\\'])
    {
        return Err("not a path relative to the workspace".into());
    }
    let path = file_actions::resolve(relative, &[workspace.to_owned()])?;
    if !path.is_file() {
        return Err("not a file".into());
    }
    media_type(&path).ok_or("not an image, video, or audio file")?;
    Ok(path)
}

/// The thread and the workspace-relative path a request's URI path names: `/<thread>/<path>`,
/// percent-encoded (`convertFileSrc` encodes the slashes too).
fn split(uri_path: &str) -> Option<(String, String)> {
    let decoded = percent_encoding::percent_decode_str(uri_path.trim_start_matches('/'))
        .decode_utf8()
        .ok()?;
    let (thread, path) = decoded.split_once('/')?;
    (!thread.is_empty() && !path.is_empty()).then(|| (thread.to_owned(), path.to_owned()))
}

/// A `Range: bytes=a-b` header over a file of `len` bytes, as the inclusive span it asks for.
fn byte_range(range: &str, len: u64) -> Option<(u64, u64)> {
    let spec = range.trim().strip_prefix("bytes=")?;
    // One range only; a multipart answer is not worth it for a media element.
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", "") => return None,
        // The last `n` bytes.
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            (len.saturating_sub(n), len.checked_sub(1)?)
        }
        (start, "") => (start.parse().ok()?, len.checked_sub(1)?),
        (start, end) => (
            start.parse().ok()?,
            end.parse::<u64>().ok()?.min(len.checked_sub(1)?),
        ),
    };
    (start <= end && end < len).then_some((start, end))
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = code;
    response
}

/// Answer one request: `workspace_of` gives an open thread's workspace by id.
pub fn serve(
    uri_path: &str,
    range: Option<&str>,
    workspace_of: impl FnOnce(&str) -> Option<PathBuf>,
) -> Response<Vec<u8>> {
    let Some((thread, relative)) = split(uri_path) else {
        return status(StatusCode::BAD_REQUEST);
    };
    let Some(workspace) = workspace_of(&thread) else {
        return status(StatusCode::NOT_FOUND);
    };
    let path = match resolve(&workspace, &relative) {
        Ok(path) => path,
        Err(why) => {
            log::warn!("Refused surface media {relative:?} for thread {thread}: {why}");
            return status(StatusCode::FORBIDDEN);
        }
    };
    let content_type = media_type(&path).unwrap_or("application/octet-stream");
    match read(&path, range) {
        Ok((code, body, content_range, len)) => {
            let mut response = Response::new(body);
            *response.status_mut() = code;
            let headers = response.headers_mut();
            let mut set = |name, value: String| {
                if let Ok(value) = value.parse() {
                    headers.insert(name, value);
                }
            };
            set(header::CONTENT_TYPE, content_type.to_owned());
            set(header::ACCEPT_RANGES, "bytes".to_owned());
            set(header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned());
            set(header::CACHE_CONTROL, "no-store".to_owned());
            match content_range {
                Some((start, end)) => {
                    set(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                }
                None if code == StatusCode::RANGE_NOT_SATISFIABLE => {
                    set(header::CONTENT_RANGE, format!("bytes */{len}"))
                }
                None => {}
            }
            response
        }
        Err(code) => status(code),
    }
}

/// A read's status, body, the span it covers (for a partial answer), and the file's length.
type Piece = (StatusCode, Vec<u8>, Option<(u64, u64)>, u64);

fn read(path: &Path, range: Option<&str>) -> Result<Piece, StatusCode> {
    let mut file = std::fs::File::open(path).map_err(|_| StatusCode::NOT_FOUND)?;
    let len = file
        .metadata()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .len();
    let (code, start, end) = match range {
        Some(range) => match byte_range(range, len) {
            Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end),
            None => return Ok((StatusCode::RANGE_NOT_SATISFIABLE, Vec::new(), None, len)),
        },
        None if len == 0 => return Ok((StatusCode::OK, Vec::new(), None, 0)),
        None => (StatusCode::OK, 0, len - 1),
    };
    // A large file is sent a piece at a time; the media element asks for the rest.
    let end = end.min(start + MAX_BODY - 1);
    let mut body = vec![0; (end - start + 1) as usize];
    file.seek(SeekFrom::Start(start))
        .and_then(|_| file.read_exact(&mut body))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // A whole file cut short is still a partial answer.
    let partial = code == StatusCode::PARTIAL_CONTENT || end + 1 < len;
    Ok(if partial {
        (StatusCode::PARTIAL_CONTENT, body, Some((start, end)), len)
    } else {
        (StatusCode::OK, body, None, len)
    })
}

/// The scheme's handler, for `tauri::Builder::register_asynchronous_uri_scheme_protocol`. Files
/// are read off the main thread.
pub fn handle<R: tauri::Runtime>(
    context: tauri::UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    use tauri::Manager;
    let app = context.app_handle().clone();
    std::thread::spawn(move || {
        let range = request
            .headers()
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let response = serve(request.uri().path(), range.as_deref(), |thread| {
            app.state::<crate::threads::ThreadManager>()
                .workspace(thread)
                .ok()
        });
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_owned();
        std::fs::create_dir_all(root.join("img")).unwrap();
        std::fs::write(root.join("img/cat.png"), b"0123456789").unwrap();
        std::fs::write(root.join("notes.txt"), b"secret plans").unwrap();
        (dir, root)
    }

    fn get(root: &Path, uri_path: &str, range: Option<&str>) -> Response<Vec<u8>> {
        serve(uri_path, range, |thread| {
            (thread == "t1").then(|| root.to_owned())
        })
    }

    #[test]
    fn serves_a_workspace_image_with_its_type() {
        let (_dir, root) = workspace();
        // As convertFileSrc encodes it: the slashes too.
        let response = get(&root, "/t1%2Fimg%2Fcat.png", None);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"0123456789");
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        assert_eq!(get(&root, "/t1/img/cat.png", None).status(), StatusCode::OK);
    }

    #[test]
    fn refuses_anything_outside_the_workspace_or_not_media() {
        let (_dir, root) = workspace();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("x.png"), b"x").unwrap();
        let absolute = outside.path().join("x.png").display().to_string();
        for path in [
            "/t1/notes.txt".to_owned(),
            "/t1/img/../../x.png".to_owned(),
            // An absolute path after the thread: `/t1//tmp/.../x.png`.
            format!("/t1/{absolute}"),
            "/t1/img".to_owned(),
            "/t1/missing.png".to_owned(),
        ] {
            let status = get(&root, &path, None).status();
            assert!(
                status == StatusCode::FORBIDDEN || status == StatusCode::BAD_REQUEST,
                "{path} gave {status}"
            );
        }
        assert_eq!(
            get(&root, "/t2/img/cat.png", None).status(),
            StatusCode::NOT_FOUND,
            "a thread that is not open has no workspace"
        );
        assert_eq!(get(&root, "/t1", None).status(), StatusCode::BAD_REQUEST);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_that_leaves_the_workspace() {
        let (_dir, root) = workspace();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("x.png"), b"x").unwrap();
        std::os::unix::fs::symlink(outside.path().join("x.png"), root.join("img/link.png"))
            .unwrap();
        assert_eq!(
            get(&root, "/t1/img/link.png", None).status(),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn answers_range_requests() {
        let (_dir, root) = workspace();
        let response = get(&root, "/t1/img/cat.png", Some("bytes=2-5"));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"2345");
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        let tail = get(&root, "/t1/img/cat.png", Some("bytes=-3"));
        assert_eq!(tail.body(), b"789");
        let open = get(&root, "/t1/img/cat.png", Some("bytes=8-"));
        assert_eq!(open.body(), b"89");
        let past = get(&root, "/t1/img/cat.png", Some("bytes=20-30"));
        assert_eq!(past.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(past.headers()[header::CONTENT_RANGE], "bytes */10");
    }

    #[test]
    fn knows_media_types_only() {
        assert_eq!(media_type(Path::new("a.JPG")), Some("image/jpeg"));
        assert_eq!(media_type(Path::new("a.webm")), Some("video/webm"));
        assert_eq!(media_type(Path::new("a.mp3")), Some("audio/mpeg"));
        assert_eq!(media_type(Path::new("a.html")), None);
        assert_eq!(media_type(Path::new("a")), None);
    }
}
