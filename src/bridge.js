'use strict';
// Connects the page to the Rust side (src-tauri/src/main.rs).
// Gives renderer.js the same `window.audify` API it had under Electron.
(() => {
  const { invoke } = window.__TAURI__.core;
  const baseName = (p) => p.split(/[\\/]/).pop();
  const readFile = async (p) => ({ path: p, name: baseName(p), data: await invoke('read_file', { path: p }) });

  window.audify = {
    openFile: async () => {
      const p = await invoke('open_dialog');
      return p ? readFile(p) : null;
    },
    readFile,
    // Used for both WAV and MP3. The file name picks the dialog filter.
    saveWav: (defaultName, data) =>
      invoke('save_file', new Uint8Array(data), { headers: { 'x-name': encodeURIComponent(defaultName) } }),
    setTitle: (t) => invoke('set_title', { title: t }),
    onOpenPath: (cb) => { invoke('start_path').then((p) => { if (p) cb(p); }); },
    // Ask before closing the window with unsaved changes.
    guardClose: (isDirty) => {
      window.__TAURI__.window.getCurrentWindow().onCloseRequested(async (e) => {
        if (!isDirty()) return;
        const ok = await window.__TAURI__.dialog.ask('You have unsaved changes. Close anyway?', { title: 'Audify', kind: 'warning' });
        if (!ok) e.preventDefault();
      });
    },
  };
})();
