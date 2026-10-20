'use strict';
// Connects the page to the Rust side (src-tauri/src). Rust owns the document,
// the edits, undo/redo, decoding and export. The page keeps a mirror of the
// samples for drawing and playback.
(() => {
  const { invoke, Channel } = window.__TAURI__.core;
  const baseName = (p) => p.split(/[\\/]/).pop();

  // Rust replies to open/edit with: u32 jsonLen, JSON, pad to 4, u32 count,
  // then per splice: u32 at, u32 remove, u32 newLen, u32 channels, planar f32 data.
  function unpack(buf) {
    const dv = new DataView(buf);
    const jsonLen = dv.getUint32(0, true);
    const state = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jsonLen)));
    let o = (4 + jsonLen + 3) & ~3;
    const count = dv.getUint32(o, true); o += 4;
    const splices = [];
    for (let i = 0; i < count; i++) {
      const at = dv.getUint32(o, true), remove = dv.getUint32(o + 4, true);
      const n = dv.getUint32(o + 8, true), nCh = dv.getUint32(o + 12, true);
      o += 16;
      const data = [];
      for (let c = 0; c < nCh; c++) { data.push(new Float32Array(buf, o, n)); o += n * 4; }
      splices.push({ at, remove, data });
    }
    return { state, splices };
  }

  // Big replies arrive as WebView2 shared memory instead of through the reply itself
  // (see src-tauri/src/transport.rs). The reply is then a 4-byte 0xFFFFFFFF marker,
  // and the data comes as a 'sharedbufferreceived' event tagged with our request id.
  const waiting = new Map();
  let nextReq = 1;
  window.chrome?.webview?.addEventListener('sharedbufferreceived', (e) => {
    const w = waiting.get(e.additionalData?.req);
    if (w) w(e.getBuffer());
  });
  async function call(cmd, args) {
    const req = nextReq++;
    const shared = new Promise((resolve) => waiting.set(req, resolve));
    try {
      const r = await invoke(cmd, { ...args, req });
      const isMarker = r.byteLength === 4 && new DataView(r).getUint32(0, true) === 0xffffffff;
      if (!isMarker) return unpack(r);
      const buf = await shared;
      // release() frees the shared memory once the page has copied what it needs.
      return { ...unpack(buf), release: () => window.chrome.webview.releaseBuffer(buf) };
    } finally {
      waiting.delete(req);
    }
  }

  window.audify = {
    openDialog: () => invoke('open_dialog'),
    // Decode in Rust. Rejects if Rust cannot read the codec.
    openPath: (path) => call('open_path', { path }),
    readFile: async (path) => ({ name: baseName(path), data: await invoke('read_file', { path }) }),
    // Hand Rust samples the page decoded itself.
    loadSamples: (name, rate, channels) => {
      const n = channels[0].length, all = new Float32Array(n * channels.length);
      channels.forEach((c, i) => all.set(c, i * n));
      const meta = encodeURIComponent(JSON.stringify({ name, rate, channels: channels.length }));
      return invoke('load_samples', new Uint8Array(all.buffer), { headers: { 'x-meta': meta } });
    },
    edit: (op, sel, cursor, db) => call('edit', { op, sel: sel ? [sel.start, sel.end] : null, cursor, db }),
    exportWav: () => invoke('export_wav'),
    exportMp3: (kbps, onProgress) => {
      const progress = new Channel();
      progress.onmessage = onProgress;
      return invoke('export_mp3', { kbps, progress });
    },
    setTitle: (t) => invoke('set_title', { title: t }),
    onOpenPath: (cb) => { invoke('start_path').then((p) => { if (p) cb(p); }); },
    // Files dropped on the window. `over(bool)` lights up the drop zone.
    onDrop: (over, drop) => {
      window.__TAURI__.webview.getCurrentWebview().onDragDropEvent((e) => {
        const t = e.payload.type;
        if (t === 'enter' || t === 'over') over(true);
        else if (t === 'leave') over(false);
        else if (t === 'drop') { over(false); if (e.payload.paths.length) drop(e.payload.paths[0]); }
      });
    },
    // Ask before closing the window with unsaved changes.
    guardClose: () => {
      window.__TAURI__.window.getCurrentWindow().onCloseRequested(async (e) => {
        if (!(await invoke('is_dirty'))) return;
        const ok = await window.__TAURI__.dialog.ask('You have unsaved changes. Close anyway?', { title: 'Audify', kind: 'warning' });
        if (!ok) e.preventDefault();
      });
    },
  };
})();
