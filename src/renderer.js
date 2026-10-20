'use strict';

// ---------- State ----------
// Rust (src-tauri/src/editor.rs) owns the document, edits and undo history.
// `doc.channels` is the page's mirror of the samples, used for drawing and playback.
const doc = {
  channels: null,      // Float32Array[]
  sampleRate: 44100,
  name: '',
  dirty: false,
};
const rs = { canUndo: false, canRedo: false, hasClip: false }; // flags from Rust
const view = { start: 0, spp: 1 };            // first visible sample, samples per pixel
let sel = null;                               // { start, end } in samples (start < end)
let cursor = 0;                               // samples
let peaks = null;                            // per channel: { min: Float32Array, max: Float32Array }
const PEAK_BLOCK = 256;

// Playback
let actx = null, source = null, playing = false, playStartCtx = 0, playStartSample = 0, playEndSample = 0, rafId = 0;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const wave = $('wave'), ruler = $('ruler'), waveWrap = $('waveWrap'), empty = $('empty');
const scrollbar = $('scrollbar'), thumb = $('thumb');
const wctx = wave.getContext('2d'), rctx = ruler.getContext('2d');

const hasDoc = () => !!doc.channels;
const length = () => (hasDoc() ? doc.channels[0].length : 0);
const hasSel = () => !!sel && sel.end > sel.start;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- Helpers ----------
function fmtTime(samples, withMs = true) {
  const s = samples / doc.sampleRate;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return withMs ? `${m}:${sec.toFixed(3).padStart(6, '0')}` : `${m}:${Math.floor(sec).toString().padStart(2, '0')}`;
}
function setMsg(t) {
  $('stMsg').textContent = t;
  if (t && !exporting) setTimeout(() => { if ($('stMsg').textContent === t) $('stMsg').textContent = ''; }, 3000);
}
// ---------- Rust ----------
// Calls run one at a time, so replies are applied in the order the edits were made.
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch((e) => { console.error(e); setMsg('Error: ' + e); }));

function syncFlags(state) {
  doc.dirty = state.dirty;
  rs.canUndo = state.canUndo; rs.canRedo = state.canRedo; rs.hasClip = state.hasClip;
}
// Apply an edit reply: replay Rust's splices on the mirror, then take its selection and cursor.
function applyEdit({ state, splices, release }) {
  for (const sp of splices) replaceRange(sp.at, sp.at + sp.remove, sp.data);
  if (release) release(); // the mirror holds copies now
  syncFlags(state);
  sel = state.sel ? { start: state.sel[0], end: state.sel[1] } : null;
  cursor = state.cursor;
  if (splices.length) afterEdit(); else { updateUI(); draw(); }
  if (state.msg) setMsg(state.msg);
}
function run(op, db) {
  if (!hasDoc()) return queue;
  return enqueue(async () => applyEdit(await window.audify.edit(op, hasSel() ? sel : null, cursor, db)));
}
function undo() { if (rs.canUndo) run('undo'); }
function redo() { if (rs.canRedo) run('redo'); }

function buildPeaks() {
  peaks = doc.channels.map(ch => {
    const n = Math.ceil(ch.length / PEAK_BLOCK);
    const min = new Float32Array(n), max = new Float32Array(n);
    for (let b = 0; b < n; b++) {
      let lo = 1, hi = -1;
      const end = Math.min(ch.length, (b + 1) * PEAK_BLOCK);
      for (let i = b * PEAK_BLOCK; i < end; i++) { const v = ch[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      min[b] = lo; max[b] = hi;
    }
    return { min, max };
  });
}

function afterEdit() {
  stopSource();
  dataVersion++;
  buildPeaks();
  const len = length();
  cursor = clamp(cursor, 0, len);
  if (sel) {
    sel.start = clamp(sel.start, 0, len); sel.end = clamp(sel.end, 0, len);
    if (sel.end <= sel.start) sel = null;
  }
  clampView();
  updateUI();
  draw();
}

// ---------- Load / Save ----------

// Read the sample rate straight from the file header (WAV, FLAC, OGG, MP3).
function sniffSampleRate(ab) {
  const b = new Uint8Array(ab), dv = new DataView(ab);
  const tag = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length < 16) return 0;
  try {
    if (tag(0, 4) === 'RIFF' && tag(8, 4) === 'WAVE') {
      let o = 12;
      while (o + 8 <= b.length) {
        const id = tag(o, 4), size = dv.getUint32(o + 4, true);
        if (id === 'fmt ') return dv.getUint32(o + 12, true);
        o += 8 + size + (size & 1);
      }
    }
    if (tag(4, 4) === 'ftyp') {
      // MP4 / MOV: find the 'mp4a' sample entry; its sample rate is a 16.16 number at +28.
      const limit = Math.min(b.length - 32, 64 << 20);
      for (let o = 0; o < limit; o++) {
        if (b[o] === 0x6d && b[o + 1] === 0x70 && b[o + 2] === 0x34 && b[o + 3] === 0x61) { // 'mp4a'
          const r = dv.getUint32(o + 28, false) >>> 16;
          if (r >= 8000 && r <= 192000) return r;
        }
        if (b[o] === 0x4f && b[o + 1] === 0x70 && b[o + 2] === 0x75 && b[o + 3] === 0x73) return 48000; // 'Opus'
      }
    }
    if (tag(0, 4) === 'fLaC') return (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
    if (tag(0, 4) === 'OggS') {
      const head = tag(0, Math.min(b.length, 4096));
      const v = head.indexOf('vorbis');
      if (v >= 0) return dv.getUint32(v + 12, true);
      if (head.indexOf('OpusHead') >= 0) return 48000;
    }
    let o = 0;
    if (tag(0, 3) === 'ID3') o = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
    for (; o + 3 < b.length && o < 1 << 20; o++) {
      if (b[o] === 0xff && (b[o + 1] & 0xe0) === 0xe0) {
        const ver = (b[o + 1] >> 3) & 3, idx = (b[o + 2] >> 2) & 3;
        if (idx === 3 || ver === 1) continue;
        const base = [11025, 12000, 8000][idx];
        return ver === 3 ? base * 4 : ver === 2 ? base * 2 : base;
      }
    }
  } catch (_) { /* fall through */ }
  return 0;
}
const isVideoName = (name) => /\.(mp4|m4v|mov|mkv|webm)$/i.test(name);
function showDoc(name, channels, rate) {
  doc.channels = channels;
  doc.sampleRate = rate;
  doc.name = name;
  dataVersion++;
  sel = null; cursor = 0;
  buildPeaks();
  empty.hidden = true; empty.classList.remove('loading'); waveWrap.hidden = false;
  resize();
  zoomFit();
  updateUI();
  setMsg(isVideoName(name) ? `Ripped audio from ${name}` : `Loaded ${name}`);
  console.log('[audify] loaded', name, doc.sampleRate, 'Hz', doc.channels.length, 'ch', length(), 'samples');
}
// Rust decodes the file. If it cannot (Opus in WEBM/MKV, for example), the page's own
// decoder takes over and hands the samples to Rust.
function loadPath(path) {
  const name = path.split(/[\\/]/).pop();
  setMsg(isVideoName(name) ? 'Ripping audio from video…' : 'Decoding…');
  stopSource();
  // Before the first file is shown, say what is happening instead of showing the drop box.
  if (!hasDoc()) { $('opening').textContent = `Opening ${name}…`; empty.classList.add('loading'); }
  return enqueue(async () => {
    try {
      const { state, splices } = await window.audify.openPath(path);
      syncFlags(state);
      showDoc(state.name, splices[0].data, state.rate);
      return;
    } catch (e) { console.warn('[audify] Rust could not decode, using the page decoder:', e); }
    try {
      const { data } = await window.audify.readFile(path);
      // Decode at the file's own sample rate so nothing gets resampled.
      const rate = sniffSampleRate(data) || getCtx().sampleRate;
      const buf = await new OfflineAudioContext(1, 1, rate).decodeAudioData(data);
      const chans = [];
      for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c).slice());
      syncFlags(await window.audify.loadSamples(name, buf.sampleRate, chans));
      showDoc(name, chans, buf.sampleRate);
    } catch (e) {
      console.error(e);
      empty.classList.remove('loading');
      setMsg(isVideoName(name) ? 'No audio track found in that video (or the codec is not supported).' : 'Could not decode that file.');
    }
  });
}
async function openFile() {
  const p = await window.audify.openDialog();
  if (p) loadPath(p);
}
window.audify.onOpenPath(loadPath);

let exporting = false;
async function exportWith(fn, label) {
  if (!hasDoc() || exporting) return;
  exporting = true; updateUI();
  try {
    await queue; // let pending edits land first
    const saved = await fn();
    if (saved) { doc.dirty = false; setMsg('Saved ' + saved); } else setMsg('Export cancelled');
  } catch (e) {
    console.error(e); setMsg(`${label} export failed: ${e}`);
  } finally {
    exporting = false; updateUI();
  }
}
const exportWav = () => exportWith(() => window.audify.exportWav(), 'WAV');
const exportMp3 = () => exportWith(() => {
  const kbps = parseInt($('mp3Rate').value, 10) || 192;
  return window.audify.exportMp3(kbps, (pct) => setMsg(`Encoding MP3… ${pct}%`));
}, 'MP3');

// ---------- Playback ----------
function getCtx() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  return actx;
}
function play() {
  if (!hasDoc()) return;
  if (playing) { pause(); return; }
  const ctx = getCtx();
  if (ctx.state === 'suspended') ctx.resume();
  const from = hasSel() ? (cursor >= sel.start && cursor < sel.end ? cursor : sel.start) : cursor;
  const to = hasSel() ? sel.end : length();
  if (from >= to) return;
  const buf = ctx.createBuffer(doc.channels.length, to - from, doc.sampleRate);
  for (let c = 0; c < doc.channels.length; c++) buf.copyToChannel(doc.channels[c].subarray(from, to), c);
  source = ctx.createBufferSource();
  source.buffer = buf;
  source.loop = $('chkLoop').checked;
  source.connect(ctx.destination);
  const mySource = source;
  source.onended = () => { if (source === mySource && !mySource.loop) finishPlayback(); };
  playStartCtx = ctx.currentTime; playStartSample = from; playEndSample = to;
  source.start();
  playing = true;
  updateUI();
  tick();
}
// The audio time you hear right now. currentTime moves in jumps (one audio block at a time)
// and runs ahead of the speakers, so use the output timestamp and fill the gap with the
// frame clock. This makes the playhead glide instead of stutter.
function audioNow() {
  const ts = actx.getOutputTimestamp ? actx.getOutputTimestamp() : null;
  if (!ts || !ts.performanceTime) return actx.currentTime;
  return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
}
function playheadSample() {
  if (!playing) return cursor;
  const elapsed = Math.max(0, audioNow() - playStartCtx) * doc.sampleRate;
  const span = playEndSample - playStartSample;
  return playStartSample + (source.loop ? elapsed % span : Math.min(elapsed, span));
}
function tick() {
  if (!playing) return;
  const p = playheadSample();
  const px = (p - view.start) / view.spp;
  if (px > wave.clientWidth || px < 0) { view.start = p; clampView(); }
  drawNow();
  $('stCursor').textContent = fmtTime(p);
  rafId = requestAnimationFrame(tick);
}
function pause() {
  if (!playing) return;
  cursor = Math.floor(playheadSample());
  stopSource();
  updateUI(); draw();
}
function finishPlayback() {
  playing = false; source = null;
  cancelAnimationFrame(rafId);
  cursor = hasSel() ? sel.start : playStartSample;
  updateUI(); draw();
}
function stopSource() {
  playing = false;
  cancelAnimationFrame(rafId);
  if (source) { source.onended = null; try { source.stop(); } catch (_) { /* already stopped */ } source = null; }
}
function stop() {
  if (playing) { stopSource(); cursor = hasSel() ? sel.start : playStartSample; }
  updateUI(); draw();
}

// ---------- Editing ----------
// The edits run in Rust (editor.rs). Each one replies with the samples it changed.

// Replace [start, end) of the mirror with `insert` (Float32Array[] or null).
function replaceRange(start, end, insert) {
  const nCh = doc.channels.length;
  const insLen = insert ? insert[0].length : 0;
  for (let c = 0; c < nCh; c++) {
    const src = doc.channels[c];
    const ins = insert && insert[c % insert.length];
    if (insLen === end - start) { if (ins) src.set(ins, start); continue; } // same length: in place
    const dst = new Float32Array(src.length - (end - start) + insLen);
    dst.set(src.subarray(0, start), 0);
    if (ins) dst.set(ins, start);
    dst.set(src.subarray(end), start + insLen);
    doc.channels[c] = dst;
  }
}
function copySel() { if (hasSel()) run('copy'); }
function deleteSel() { if (hasSel()) run('delete'); }
function cutSel() { if (hasSel()) run('cut'); }
function paste() { if (rs.hasClip) run('paste'); }
function trim() { if (hasSel()) run('trim').then(zoomFit); }
function silence() { if (hasSel()) run('silence'); }
function fadeIn() { run('fadeIn'); }
function fadeOut() { run('fadeOut'); }
function reverse() { run('reverse'); }
function normalize() { run('normalize'); }
function gain() { run('gain', parseFloat($('gainDb').value) || 0); }
function selectAll() { if (hasDoc()) { sel = { start: 0, end: length() }; cursor = 0; updateUI(); draw(); } }

// ---------- View / Zoom ----------
function clampView() {
  const w = wave.clientWidth || 1;
  const minSpp = 1 / 32, maxSpp = Math.max(minSpp, length() / w);
  view.spp = clamp(view.spp, minSpp, maxSpp);
  view.start = clamp(Math.floor(view.start), 0, Math.max(0, length() - w * view.spp));
  updateScrollbar();
}
function zoomFit() { view.start = 0; view.spp = length() / (wave.clientWidth || 1); clampView(); draw(); }
function zoomAt(factor, pxAnchor) {
  const anchorSample = view.start + pxAnchor * view.spp;
  view.spp *= factor;
  view.start = anchorSample - pxAnchor * view.spp;
  clampView(); draw();
}
function zoomSel() {
  if (!hasSel()) return;
  const w = wave.clientWidth;
  view.spp = (sel.end - sel.start) / (w * 0.9);
  view.start = sel.start - w * 0.05 * view.spp;
  clampView(); draw();
}
function updateScrollbar() {
  const len = length() || 1, w = scrollbar.clientWidth;
  const visible = wave.clientWidth * view.spp;
  const tw = Math.max(20, w * Math.min(1, visible / len));
  const tx = (w - tw) * (view.start / Math.max(1, len - visible));
  thumb.style.width = tw + 'px'; thumb.style.left = (isFinite(tx) ? tx : 0) + 'px';
}

// ---------- Drawing ----------
function resize() {
  const dpr = window.devicePixelRatio || 1;
  for (const cv of [wave, ruler]) {
    const r = cv.getBoundingClientRect();
    cv.width = Math.max(1, Math.round(r.width * dpr));
    cv.height = Math.max(1, Math.round(r.height * dpr));
  }
  if (hasDoc()) { clampView(); draw(); }
}
function xOf(sample) { return (sample - view.start) / view.spp; }
const cssCache = {};
const cssVar = (n) => cssCache[n] || (cssCache[n] = getComputedStyle(document.documentElement).getPropertyValue(n).trim());

// Coalesce draw requests: at most one real draw per screen frame.
let drawPending = false;
function draw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; drawNow(); });
}
// Waveform is rendered once into an offscreen layer and reused until the view or data changes.
const waveLayer = document.createElement('canvas');
const lctx = waveLayer.getContext('2d');
let layerKey = '';
let dataVersion = 0;

function renderWaveLayer(W, H, dpr) {
  if (waveLayer.width !== wave.width || waveLayer.height !== wave.height) {
    waveLayer.width = wave.width; waveLayer.height = wave.height;
  }
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lctx.fillStyle = cssVar('--bg'); lctx.fillRect(0, 0, W, H);
  const nCh = doc.channels.length, chH = H / nCh;
  for (let c = 0; c < nCh; c++) {
    const ch = doc.channels[c], top = c * chH, mid = top + chH / 2, amp = chH / 2 * 0.92;
    lctx.fillStyle = cssVar('--border');
    lctx.fillRect(0, Math.round(mid), W, 1);
    if (c > 0) lctx.fillRect(0, Math.round(top), W, 1);

    lctx.fillStyle = cssVar('--wave');
    lctx.strokeStyle = cssVar('--wave');
    if (view.spp >= 2) {
      const usePeaks = view.spp >= PEAK_BLOCK;
      for (let x = 0; x < W; x++) {
        const s0 = Math.floor(view.start + x * view.spp), s1 = Math.floor(view.start + (x + 1) * view.spp);
        if (s0 >= ch.length) break;
        let lo = 1, hi = -1;
        if (usePeaks) {
          const b0 = Math.floor(s0 / PEAK_BLOCK), b1 = Math.min(peaks[c].min.length - 1, Math.floor(s1 / PEAK_BLOCK));
          for (let b = b0; b <= b1; b++) {
            if (peaks[c].min[b] < lo) lo = peaks[c].min[b];
            if (peaks[c].max[b] > hi) hi = peaks[c].max[b];
          }
        } else {
          const e = Math.min(s1, ch.length);
          for (let i = s0; i < e; i++) { const v = ch[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        }
        if (lo > hi) continue;
        const y0 = mid - hi * amp, y1 = mid - lo * amp;
        lctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    } else {
      lctx.lineWidth = 1.2;
      lctx.beginPath();
      const s0 = Math.max(0, Math.floor(view.start)), s1 = Math.min(ch.length, Math.ceil(view.start + W * view.spp) + 1);
      for (let i = s0; i < s1; i++) {
        const x = xOf(i), y = mid - ch[i] * amp;
        if (i === s0) lctx.moveTo(x, y); else lctx.lineTo(x, y);
      }
      lctx.stroke();
      if (view.spp < 0.25) {
        lctx.fillStyle = cssVar('--wave2');
        for (let i = s0; i < s1; i++) lctx.fillRect(xOf(i) - 2, mid - ch[i] * amp - 2, 4, 4);
      }
    }
  }
}

function drawNow() {
  if (!hasDoc()) return;
  const dpr = window.devicePixelRatio || 1;
  const W = wave.clientWidth, H = wave.clientHeight;
  const key = `${view.start}|${view.spp}|${wave.width}|${wave.height}|${dataVersion}`;
  if (key !== layerKey) { renderWaveLayer(W, H, dpr); layerKey = key; }

  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.drawImage(waveLayer, 0, 0);
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (hasSel()) {
    const x0 = clamp(xOf(sel.start), 0, W), x1 = clamp(xOf(sel.end), 0, W);
    wctx.fillStyle = cssVar('--sel');
    wctx.fillRect(x0, 0, x1 - x0, H);
  }

  const p = playing ? playheadSample() : cursor;
  const px = xOf(p);
  if (px >= 0 && px <= W) {
    // Snap to whole screen pixels so the line stays one sharp color on any display scale.
    wctx.setTransform(1, 0, 0, 1, 0, 0);
    wctx.fillStyle = cssVar('--cursor');
    wctx.fillRect(Math.round(px * dpr), 0, Math.max(1, Math.round(dpr)), wave.height);
    wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  drawRuler();
}
function drawRuler() {
  const dpr = window.devicePixelRatio || 1;
  const W = ruler.clientWidth, H = ruler.clientHeight;
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rctx.fillStyle = cssVar('--panel'); rctx.fillRect(0, 0, W, H);
  rctx.fillStyle = cssVar('--muted'); rctx.font = '11px system-ui'; rctx.textBaseline = 'top';
  const secPerPx = view.spp / doc.sampleRate;
  const steps = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 600];
  const step = steps.find(s => s / secPerPx >= 80) || 600;
  const t0 = Math.floor((view.start / doc.sampleRate) / step) * step;
  for (let t = t0; ; t += step) {
    const x = (t - view.start / doc.sampleRate) / secPerPx;
    if (x > W) break;
    if (x < 0) continue;
    rctx.fillRect(Math.round(x), H - 6, 1, 6);
    rctx.fillText(fmtTime(t * doc.sampleRate, step < 1), x + 3, 3);
  }
}

// ---------- UI ----------
let lastTitle = null;
function updateUI() {
  const d = hasDoc(), s = hasSel();
  for (const id of ['btnExport', 'btnExportMp3', 'btnPlay', 'btnStop', 'btnFadeIn', 'btnFadeOut', 'btnNormalize', 'btnReverse', 'btnGain', 'btnZoomIn', 'btnZoomOut', 'btnZoomFit'])
    $(id).disabled = !d;
  for (const id of ['btnCut', 'btnCopy', 'btnDelete', 'btnTrim', 'btnSilence', 'btnZoomSel']) $(id).disabled = !s;
  $('btnPaste').disabled = !d || !rs.hasClip;
  $('btnExport').disabled = !d || exporting;
  $('btnExportMp3').disabled = !d || exporting;
  $('btnUndo').disabled = !rs.canUndo;
  $('btnRedo').disabled = !rs.canRedo;
  $('btnPlay').innerHTML = playing ? '&#10074;&#10074; Pause' : '&#9654; Play';
  $('stFile').textContent = d ? (doc.dirty ? '* ' : '') + doc.name : 'No file';
  const chName = !d ? '' : doc.channels.length === 1 ? 'Mono' : doc.channels.length === 2 ? 'Stereo' : doc.channels.length + ' ch';
  $('stInfo').textContent = d ? `${chName} | ${doc.sampleRate} Hz | ${fmtTime(length())}` : '';
  $('stCursor').textContent = d ? fmtTime(cursor) : '';
  $('stSel').textContent = s ? `Sel ${fmtTime(sel.start)} - ${fmtTime(sel.end)} (${fmtTime(sel.end - sel.start)})` : '';
  const title = d ? `${doc.dirty ? '* ' : ''}${doc.name} - Audify` : 'Audify';
  if (title !== lastTitle) { lastTitle = title; window.audify.setTitle(title); }
}

// ---------- Mouse ----------
let dragAnchor = null;
function sampleAtMouse(e) {
  return clamp(Math.round(view.start + (e.clientX - wave.getBoundingClientRect().left) * view.spp), 0, length());
}
function setSelFromDrag(s) {
  if (dragAnchor === null) return;
  const a = Math.min(dragAnchor, s), b = Math.max(dragAnchor, s);
  sel = b > a ? { start: a, end: b } : null;
}
wave.addEventListener('mousedown', (e) => {
  if (!hasDoc() || e.button !== 0) return;
  const s = sampleAtMouse(e);
  if (e.shiftKey) {
    dragAnchor = hasSel() ? (Math.abs(s - sel.start) > Math.abs(s - sel.end) ? sel.start : sel.end) : cursor;
  } else {
    dragAnchor = s;
    sel = null;
  }
  const wasPlaying = playing;
  if (wasPlaying) stopSource();
  cursor = Math.min(dragAnchor, s);
  setSelFromDrag(s);
  updateUI(); draw();
  const move = (ev) => { const x = sampleAtMouse(ev); setSelFromDrag(x); cursor = Math.min(dragAnchor, x); updateUI(); draw(); };
  const up = () => {
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
    dragAnchor = null;
    if (wasPlaying) play();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});
wave.addEventListener('dblclick', selectAll);
wave.addEventListener('wheel', (e) => {
  if (!hasDoc()) return;
  e.preventDefault();
  const px = e.clientX - wave.getBoundingClientRect().left;
  if (e.ctrlKey) zoomAt(e.deltaY > 0 ? 1.25 : 0.8, px);
  else { view.start += (e.deltaY || e.deltaX) * view.spp; clampView(); draw(); }
}, { passive: false });

thumb.addEventListener('mousedown', (e) => {
  e.preventDefault(); e.stopPropagation();
  const startX = e.clientX, startView = view.start;
  const w = scrollbar.clientWidth, tw = thumb.clientWidth;
  const visible = wave.clientWidth * view.spp;
  const move = (ev) => {
    view.start = startView + (ev.clientX - startX) / Math.max(1, w - tw) * (length() - visible);
    clampView(); draw();
  };
  const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
});
scrollbar.addEventListener('mousedown', (e) => {
  if (e.target === thumb || !hasDoc()) return;
  const frac = (e.clientX - scrollbar.getBoundingClientRect().left) / scrollbar.clientWidth;
  view.start = frac * length() - wave.clientWidth * view.spp / 2; clampView(); draw();
});

// drag & drop (the window hands us the file path, so Rust can read it directly)
window.audify.onDrop((over) => empty.classList.toggle('drag', over), loadPath);

// ---------- Keyboard ----------
window.addEventListener('keydown', (e) => {
  if ((e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') && e.key !== 'Escape') return;
  const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
  const act = {
    ' ': play, escape: stop, delete: () => deleteSel(), backspace: () => deleteSel(),
    '+': () => zoomAt(0.5, wave.clientWidth / 2), '=': () => zoomAt(0.5, wave.clientWidth / 2),
    '-': () => zoomAt(2, wave.clientWidth / 2),
    '0': zoomFit, z: zoomSel,
    home: () => { cursor = 0; view.start = 0; clampView(); updateUI(); draw(); },
    end: () => { cursor = length(); view.start = length(); clampView(); updateUI(); draw(); },
    arrowleft: () => { cursor = clamp(cursor - Math.round(view.spp * 10), 0, length()); updateUI(); draw(); },
    arrowright: () => { cursor = clamp(cursor + Math.round(view.spp * 10), 0, length()); updateUI(); draw(); },
  };
  const ctrlAct = {
    o: openFile, s: e.shiftKey ? exportMp3 : exportWav, z: e.shiftKey ? redo : undo, y: redo,
    x: cutSel, c: copySel, v: paste, t: trim, l: silence, a: selectAll,
  };
  const fn = ctrl ? ctrlAct[k] : act[k];
  if (fn) { e.preventDefault(); fn(); }
});

// ---------- Buttons ----------
const bind = (id, fn) => $(id).addEventListener('click', fn);
bind('btnOpen', openFile); bind('btnExport', exportWav); bind('btnExportMp3', exportMp3);
bind('btnPlay', play); bind('btnStop', stop);
bind('btnUndo', undo); bind('btnRedo', redo);
bind('btnCut', cutSel); bind('btnCopy', copySel); bind('btnPaste', paste); bind('btnDelete', () => deleteSel());
bind('btnTrim', trim); bind('btnSilence', silence);
bind('btnFadeIn', fadeIn); bind('btnFadeOut', fadeOut); bind('btnNormalize', normalize); bind('btnReverse', reverse); bind('btnGain', gain);
bind('btnZoomIn', () => zoomAt(0.5, wave.clientWidth / 2)); bind('btnZoomOut', () => zoomAt(2, wave.clientWidth / 2));
bind('btnZoomFit', zoomFit); bind('btnZoomSel', zoomSel);
$('chkLoop').addEventListener('change', () => { if (source) source.loop = $('chkLoop').checked; });
// Give focus back to the page after using toolbar controls so keyboard shortcuts keep working.
for (const id of ['mp3Rate', 'chkLoop', 'gainDb']) $(id).addEventListener('change', (e) => e.target.blur());
$('btnGain').addEventListener('click', () => $('btnGain').blur());

window.addEventListener('resize', resize);
window.audify.guardClose();
resize();
updateUI();
