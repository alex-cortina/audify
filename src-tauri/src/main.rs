// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;

const AUDIO_EXTS: &[&str] = &["wav", "mp3", "ogg", "flac", "m4a", "aac", "webm", "opus", "aiff", "aif"];
const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "mov", "mkv", "webm"];

/// Show the Open dialog. Returns the chosen path, or None if cancelled.
#[tauri::command]
async fn open_dialog(window: WebviewWindow) -> Option<String> {
    let all: Vec<&str> = AUDIO_EXTS.iter().chain(VIDEO_EXTS).copied().collect();
    let picked = window
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("Audio & Video", &all)
        .add_filter("Audio", AUDIO_EXTS)
        .add_filter("Video (audio is extracted)", VIDEO_EXTS)
        .add_filter("All Files", &["*"])
        .blocking_pick_file()?;
    Some(picked.into_path().ok()?.to_string_lossy().into_owned())
}

/// Read a whole file. The bytes reach JS as an ArrayBuffer.
#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

/// Show the Save dialog and write the raw request body to the chosen file.
/// The suggested file name comes in the `x-name` header (URI-encoded).
#[tauri::command]
async fn save_file(window: WebviewWindow, request: Request<'_>) -> Result<Option<String>, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .map(decode_uri)
        .unwrap_or_else(|| "audio.wav".into());
    let is_mp3 = name.to_lowercase().ends_with(".mp3");
    let (label, ext) = if is_mp3 { ("MP3 Audio", "mp3") } else { ("WAV Audio", "wav") };
    let Some(picked) = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(&name)
        .add_filter(label, &[ext])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// The file passed on the command line (or by a double-click in Explorer), if any.
#[tauri::command]
fn start_path() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).is_file())
        .and_then(|a| std::fs::canonicalize(&a).ok().or_else(|| Some(PathBuf::from(&a))))
        .map(|p| strip_unc(&p.to_string_lossy()))
}

#[tauri::command]
fn set_title(window: WebviewWindow, title: String) {
    let _ = window.set_title(&title);
}

/// canonicalize() on Windows gives `\\?\C:\...`. Show the normal form.
fn strip_unc(p: &str) -> String {
    p.strip_prefix(r"\\?\").unwrap_or(p).to_string()
}

/// Minimal decodeURIComponent for the file name header.
fn decode_uri(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_dialog, read_file, save_file, start_path, set_title])
        .run(tauri::generate_context!())
        .expect("error while running Audify");
}
