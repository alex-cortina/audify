//! Getting big replies to the page fast.
//!
//! A normal Tauri reply copies the bytes through WebView2's request pipe, which runs at
//! about 100 MB/s. A 4-minute song is about 90 MB of samples, so that is a one-second wait.
//! WebView2 can instead hand the page a block of shared memory (a "shared buffer"):
//! Rust fills it, the page reads it as an ArrayBuffer, and nothing is copied across.
//!
//! The page passes a request id. For a big reply, Rust posts the bytes as a shared buffer
//! tagged with that id and the command returns a 4-byte marker instead. If anything about
//! the shared buffer fails, the bytes go back the normal way.

use std::sync::Arc;

use tauri::ipc::Response;
use tauri::WebviewWindow;

/// Replies smaller than this go the normal way.
const SHARED_MIN: usize = 1 << 20;
/// Tells the page "the data arrives as a shared buffer".
const MARKER: [u8; 4] = [0xff, 0xff, 0xff, 0xff];

pub async fn reply(window: &WebviewWindow, req: Option<u32>, bytes: Vec<u8>) -> Response {
    let Some(req) = req else { return Response::new(bytes) };
    if bytes.len() < SHARED_MIN {
        return Response::new(bytes);
    }
    let bytes = Arc::new(bytes);
    let (tx, rx) = std::sync::mpsc::channel();
    let shared = Arc::clone(&bytes);
    let queued = window.with_webview(move |wv| {
        // Runs on the UI thread, where WebView2 objects live.
        let _ = tx.send(post_shared(&wv, req, &shared));
    });
    if queued.is_ok() && matches!(rx.recv(), Ok(true)) {
        return Response::new(MARKER.to_vec());
    }
    // Fall back to a normal reply.
    Response::new(Arc::try_unwrap(bytes).unwrap_or_else(|b| (*b).clone()))
}

#[cfg(windows)]
fn post_shared(wv: &tauri::webview::PlatformWebview, req: u32, bytes: &[u8]) -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment12, ICoreWebView2_17, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE,
    };
    use windows_core::{Interface, HSTRING, PCWSTR};

    let attempt = || -> windows_core::Result<()> {
        unsafe {
            let env: ICoreWebView2Environment12 = wv.environment().cast()?;
            let core: ICoreWebView2_17 = wv.controller().CoreWebView2()?.cast()?;
            let shared = env.CreateSharedBuffer(bytes.len() as u64)?;
            let mut ptr: *mut u8 = std::ptr::null_mut();
            shared.Buffer(&mut ptr)?;
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
            let meta = HSTRING::from(format!("{{\"req\":{req}}}"));
            let posted = core.PostSharedBufferToScript(&shared, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE, PCWSTR(meta.as_ptr()));
            // The page keeps its own mapping; Rust's side can go now.
            let _ = shared.Close();
            posted
        }
    };
    attempt().is_ok()
}

#[cfg(not(windows))]
fn post_shared(_wv: &tauri::webview::PlatformWebview, _req: u32, _bytes: &[u8]) -> bool {
    false
}
