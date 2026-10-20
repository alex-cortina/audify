// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod decode;
mod editor;
mod encode;
mod transport;
mod wire;

use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};

use serde_json::json;
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use editor::{Editor, Outcome, PageSplice};

type Doc<'a> = State<'a, Mutex<Editor>>;

const AUDIO_EXTS: &[&str] = &["wav", "mp3", "ogg", "flac", "m4a", "aac", "webm", "opus", "aiff", "aif"];
const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "mov", "mkv", "webm"];

fn lock<'a>(doc: &'a Doc<'_>) -> std::sync::MutexGuard<'a, Editor> {
    // A panic mid-edit should not brick the app; keep using the data.
    doc.lock().unwrap_or_else(|e| e.into_inner())
}

/// Everything the page needs to know besides the samples.
fn state(ed: &Editor, o: Option<&Outcome>) -> serde_json::Value {
    json!({
        "name": ed.name,
        "rate": ed.rate,
        "channels": ed.chans.len(),
        "length": ed.len(),
        "dirty": ed.dirty,
        "canUndo": ed.can_undo(),
        "canRedo": ed.can_redo(),
        "hasClip": ed.has_clip(),
        "sel": o.and_then(|o| o.sel).map(|(s, e)| [s, e]),
        "cursor": o.map_or(0, |o| o.cursor),
        "msg": o.map_or("", |o| o.msg.as_str()),
    })
}

fn file_name(p: &Path) -> String {
    p.file_name().map_or_else(|| "audio".into(), |n| n.to_string_lossy().into_owned())
}

fn base_name(ed: &Editor) -> String {
    let stem = Path::new(&ed.name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    if stem.is_empty() { "audio".into() } else { stem }
}

// ---------- Files ----------

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

/// Decode a file in Rust and make it the open document. The reply carries all samples.
/// Fails for codecs Rust cannot read (Opus); the page then decodes it and calls `load_samples`.
#[tauri::command]
async fn open_path(
    window: WebviewWindow,
    doc: Doc<'_>,
    early: State<'_, EarlyDecode>,
    path: String,
    req: Option<u32>,
) -> Result<Response, String> {
    let p = PathBuf::from(&path);
    let (chans, rate) = early.take(&path).unwrap_or_else(|| decode::decode_file(&p))?;
    let bytes = {
        let mut ed = lock(&doc);
        ed.load(file_name(&p), chans, rate);
        let st = state(&ed, None);
        wire::pack(&st, &[PageSplice { at: 0, remove: 0, data: &ed.chans }])
    };
    Ok(transport::reply(&window, req, bytes).await)
}

/// Read a whole file (for the page's own decoder). The bytes reach JS as an ArrayBuffer.
#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

/// Samples the page decoded itself. Body: planar f32. Header `x-meta`: {"name","rate","channels"} (URI-encoded JSON).
#[tauri::command]
async fn load_samples(doc: Doc<'_>, request: Request<'_>) -> Result<serde_json::Value, String> {
    let InvokeBody::Raw(data) = request.body() else { return Err("expected raw bytes".into()) };
    let meta = request.headers().get("x-meta").and_then(|v| v.to_str().ok()).map(decode_uri).ok_or("missing x-meta")?;
    let meta: serde_json::Value = serde_json::from_str(&meta).map_err(|e| e.to_string())?;
    let n_ch = meta["channels"].as_u64().filter(|&n| n > 0).ok_or("bad channels")? as usize;
    let rate = meta["rate"].as_u64().ok_or("bad rate")? as u32;
    let name = meta["name"].as_str().unwrap_or("audio").to_string();
    let floats: Vec<f32> = data.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let len = floats.len() / n_ch;
    let chans = floats.chunks_exact(len.max(1)).take(n_ch).map(<[f32]>::to_vec).collect();
    let mut ed = lock(&doc);
    ed.load(name, chans, rate);
    Ok(state(&ed, None))
}

// ---------- Editing ----------

/// Run an edit (delete, paste, fadeIn, undo, ...) and reply with the splices for the page.
#[tauri::command]
async fn edit(
    window: WebviewWindow,
    doc: Doc<'_>,
    op: String,
    sel: Option<(usize, usize)>,
    cursor: usize,
    db: Option<f64>,
    req: Option<u32>,
) -> Result<Response, String> {
    let bytes = {
        let mut ed = lock(&doc);
        let out = ed.run(&op, sel, cursor, db.unwrap_or(0.0))?;
        let st = state(&ed, Some(&out));
        wire::pack(&st, &ed.page_changes(&out.changes))
    };
    Ok(transport::reply(&window, req, bytes).await)
}

#[tauri::command]
fn is_dirty(doc: Doc<'_>) -> bool {
    lock(&doc).dirty
}

// ---------- Export ----------

async fn save_dialog(window: &WebviewWindow, name: String, label: &str, ext: &str) -> Option<PathBuf> {
    window
        .dialog()
        .file()
        .set_parent(window)
        .set_file_name(&name)
        .add_filter(label, &[ext])
        .blocking_save_file()?
        .into_path()
        .ok()
}

#[tauri::command]
async fn export_wav(window: WebviewWindow, doc: Doc<'_>) -> Result<Option<String>, String> {
    let name = format!("{}.wav", base_name(&lock(&doc)));
    let Some(path) = save_dialog(&window, name, "WAV Audio", "wav").await else { return Ok(None) };
    let mut ed = lock(&doc);
    if !ed.has_doc() {
        return Err("No file open".into());
    }
    std::fs::write(&path, encode::wav(&ed.chans, ed.rate)).map_err(|e| e.to_string())?;
    ed.dirty = false;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Ask where to save, then encode with progress (0..=100) on `progress`.
#[tauri::command]
async fn export_mp3(window: WebviewWindow, doc: Doc<'_>, kbps: u32, progress: Channel<u32>) -> Result<Option<String>, String> {
    let name = format!("{}.mp3", base_name(&lock(&doc)));
    let Some(path) = save_dialog(&window, name, "MP3 Audio", "mp3").await else { return Ok(None) };
    let mut ed = lock(&doc);
    if !ed.has_doc() {
        return Err("No file open".into());
    }
    let data = encode::mp3(&ed.chans, ed.rate, kbps, |pct| {
        let _ = progress.send(pct);
    })?;
    let _ = progress.send(100);
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    ed.dirty = false;
    Ok(Some(path.to_string_lossy().into_owned()))
}

// ---------- Window ----------

/// The file passed on the command line (or by a double-click in Explorer), if any.
#[tauri::command]
fn start_path() -> Option<String> {
    launch_file()
}

fn launch_file() -> Option<String> {
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

/// Minimal decodeURIComponent for header values.
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

/// The file Audify was launched with starts decoding at once, while the window and the
/// WebView2 engine are still starting (about half a second). `open_path` then picks up
/// the result instead of decoding the file again.
#[derive(Default)]
struct EarlyDecode(Mutex<Option<(String, mpsc::Receiver<Decoded>)>>);

type Decoded = Result<(editor::Chans, u32), String>;

impl EarlyDecode {
    fn start(path: String) -> Self {
        let (tx, rx) = mpsc::channel();
        let p = PathBuf::from(&path);
        std::thread::spawn(move || {
            let _ = tx.send(decode::decode_file(&p));
        });
        Self(Mutex::new(Some((path, rx))))
    }

    /// The early result for `path`, waiting for it if it is still decoding. Only used once.
    fn take(&self, path: &str) -> Option<Decoded> {
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|(p, _)| p == path) {
            let (_, rx) = slot.take()?;
            return rx.recv().ok();
        }
        None
    }
}

fn main() {
    let early = launch_file().map(EarlyDecode::start).unwrap_or_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(Editor::default()))
        .manage(early)
        .invoke_handler(tauri::generate_handler![
            open_dialog,
            open_path,
            read_file,
            load_samples,
            edit,
            is_dirty,
            export_wav,
            export_mp3,
            start_path,
            set_title
        ])
        .run(tauri::generate_context!())
        .expect("error while running Audify");
}
