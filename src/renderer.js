'use strict';

// ---------- State ----------
const doc = {
  channels: null,      // Float32Array[]
  sampleRate: 44100,
  name: '',
  dirty: false,
};
const view = { start: 0, spp: 1 };            // first visible sample, samples per pixel
let sel = null;                               // { start, end } in samples (start < end)
let cursor = 0;                               // samples
let clipboard = null;                         // { channels, sampleRate }
const undoStack = [], redoStack = [];
const MAX_UNDO = 30;
let peaks = null;                             // per channel: { min: Float32Array, max: Float32Array }
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
function cloneChannels(chs) { return chs.map(c => new Float32Array(c)); }

function pushUndo() {
  undoStack.push({ channels: cloneChannels(doc.channels), sel: sel && { ...sel }, cursor });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  doc.dirty = true;
}
function applySnapshot(s) {
  doc.channels = s.channels; sel = s.sel; cursor = s.cursor;
  afterEdit();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push({ channels: doc.channels, sel: sel && { ...sel }, cursor });
  applySnapshot(undoStack.pop());
  setMsg('Undo');
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push({ channels: doc.channels, sel: sel && { ...sel }, cursor });
  applySnapshot(redoStack.pop());
  setMsg('Redo');
}

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
async function loadArrayBuffer(name, ab) {
  try {
    const isVideo = /\.(mp4|m4v|mov|mkv|webm)$/i.test(name);
    setMsg(isVideo ? 'Ripping audio from video…' : 'Decoding…');
    stopSource();
    // Decode at the file's own sample rate so nothing gets resampled.
    const rate = sniffSampleRate(ab) || getCtx().sampleRate;
    const buf = await new OfflineAudioContext(1, 1, rate).decodeAudioData(ab.slice(0));
    doc.channels = [];
    for (let c = 0; c < buf.numberOfChannels; c++) doc.channels.push(buf.getChannelData(c).slice());
    doc.sampleRate = buf.sampleRate;
    doc.name = name;
    doc.dirty = false;
    dataVersion++;
    undoStack.length = 0; redoStack.length = 0;
    sel = null; cursor = 0;
    buildPeaks();
    empty.hidden = true; waveWrap.hidden = false;
    resize();
    zoomFit();
    updateUI();
    setMsg(isVideo ? `Ripped audio from ${name}` : `Loaded ${name}`);
    console.log('[audify] loaded', name, doc.sampleRate, 'Hz', doc.channels.length, 'ch', length(), 'samples');
  } catch (e) {
    console.error(e);
    setMsg(/\.(mp4|m4v|mov|mkv|webm)$/i.test(name) ? 'No audio track found in that video (or the codec is not supported).' : 'Could not decode that file.');
  }
}
async function openFile() {
  const r = await window.audify.openFile();
  if (r) loadArrayBuffer(r.name, r.data);
}
window.audify.onOpenPath(async (p) => {
  try {
    const r = await window.audify.readFile(p);
    if (r) loadArrayBuffer(r.name, r.data);
  } catch (e) { console.error(e); setMsg('Could not open ' + p); }
});

function encodeWav(channels, sampleRate) {
  const nCh = channels.length, n = channels[0].length, bytesPerSample = 2;
  const dataSize = n * nCh * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nCh, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * nCh * bytesPerSample, true);
  dv.setUint16(32, nCh * bytesPerSample, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const v = clamp(channels[c][i], -1, 1);
      dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return buf;
}
async function exportWav() {
  if (!hasDoc()) return;
  const base = doc.name.replace(/\.[^.]+$/, '') || 'audio';
  const data = encodeWav(doc.channels, doc.sampleRate);
  const p = await window.audify.saveWav(base + '.wav', data);
  if (p) { doc.dirty = false; setMsg('Saved ' + p); updateUI(); }
}

let exporting = false;
const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
async function exportMp3() {
  if (!hasDoc() || exporting) return;
  exporting = true; updateUI();
  let worker = null;
  try {
    const kbps = parseInt($('mp3Rate').value, 10) || 192;
    // LAME only accepts these rates; resample anything else to 44100.
    let chans = doc.channels.slice(0, 2), rate = doc.sampleRate;
    if (!MP3_RATES.includes(rate)) { chans = chans.map(c => resample(c, rate, 44100)); rate = 44100; }
    const toInt16 = (f) => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const v = clamp(f[i], -1, 1); o[i] = v < 0 ? v * 0x8000 : v * 0x7fff; } return o; };
    const left = toInt16(chans[0]), right = chans[1] ? toInt16(chans[1]) : null;
    setMsg('Encoding MP3… 0%');
    worker = new Worker('mp3worker.js');
    const data = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') setMsg(`Encoding MP3… ${m.pct}%`);
        else if (m.type === 'done') resolve(m.data);
        else reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'worker failed'));
      const transfer = right ? [left.buffer, right.buffer] : [left.buffer];
      worker.postMessage({ left, right, sampleRate: rate, kbps }, transfer);
    });
    const base = doc.name.replace(/\.[^.]+$/, '') || 'audio';
    setMsg('Choose where to save…');
    const saved = await window.audify.saveWav(base + '.mp3', data);
    if (saved) { doc.dirty = false; setMsg('Saved ' + saved); } else setMsg('Export cancelled');
  } catch (e) {
    console.error(e); setMsg('MP3 export failed: ' + (e && e.message ? e.message : e));
  } finally {
    if (worker) worker.terminate();
    exporting = false; updateUI();
  }
}

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
function playheadSample() {
  if (!playing) return cursor;
  const elapsed = (actx.currentTime - playStartCtx) * doc.sampleRate;
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
function selOrAll() { return hasSel() ? { ...sel } : { start: 0, end: length() }; }

function replaceRange(start, end, insert /* Float32Array[] or null */) {
  const nCh = doc.channels.length;
  const insLen = insert ? insert[0].length : 0;
  const out = [];
  for (let c = 0; c < nCh; c++) {
    const src = doc.channels[c];
    const dst = new Float32Array(src.length - (end - start) + insLen);
    dst.set(src.subarray(0, start), 0);
    if (insert) dst.set(insert[c % insert.length], start);
    dst.set(src.subarray(end), start + insLen);
    out.push(dst);
  }
  doc.channels = out;
}
function copySel() {
  if (!hasSel()) return;
  clipboard = { channels: doc.channels.map(c => c.slice(sel.start, sel.end)), sampleRate: doc.sampleRate };
  setMsg(`Copied ${fmtTime(sel.end - sel.start)}`);
  updateUI();
}
function deleteSel(msg = 'Deleted') {
  if (!hasSel()) return;
  pushUndo();
  const s = sel.start;
  replaceRange(sel.start, sel.end, null);
  sel = null; cursor = s;
  afterEdit(); setMsg(msg);
}
function cutSel() { if (!hasSel()) return; copySel(); deleteSel('Cut'); }
function paste() {
  if (!clipboard || !hasDoc()) return;
  pushUndo();
  let at = cursor;
  if (hasSel()) { at = sel.start; replaceRange(sel.start, sel.end, null); }
  let ins = clipboard.channels;
  if (clipboard.sampleRate !== doc.sampleRate) ins = ins.map(c => resample(c, clipboard.sampleRate, doc.sampleRate));
  replaceRange(at, at, ins);
  sel = { start: at, end: at + ins[0].length }; cursor = at;
  afterEdit(); setMsg('Pasted');
}
function resample(src, from, to) {
  const ratio = from / to, n = Math.round(src.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, i0 = Math.min(Math.floor(x), src.length - 1), i1 = Math.min(i0 + 1, src.length - 1), t = x - i0;
    out[i] = src[i0] * (1 - t) + src[i1] * t;
  }
  return out;
}
function trim() {
  if (!hasSel()) return;
  pushUndo();
  doc.channels = doc.channels.map(c => c.slice(sel.start, sel.end));
  sel = null; cursor = 0;
  afterEdit(); zoomFit(); setMsg('Trimmed');
}
function applyRange(fn, label) {
  if (!hasDoc()) return;
  const r = selOrAll();
  pushUndo();
  for (const ch of doc.channels) fn(ch, r.start, r.end);
  afterEdit(); setMsg(label);
}
function silence() { if (hasSel()) applyRange((ch, s, e) => ch.fill(0, s, e), 'Silenced'); }
function fadeIn() { applyRange((ch, s, e) => { const n = e - s; for (let i = s; i < e; i++) ch[i] *= (i - s) / n; }, 'Fade in'); }
function fadeOut() { applyRange((ch, s, e) => { const n = e - s; for (let i = s; i < e; i++) ch[i] *= 1 - (i - s) / n; }, 'Fade out'); }
function reverse() { applyRange((ch, s, e) => ch.subarray(s, e).reverse(), 'Reversed'); }
function normalize() {
  if (!hasDoc()) return;
  const r = selOrAll();
  let peak = 0;
  for (const ch of doc.channels) for (let i = r.start; i < r.end; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  if (peak === 0) { setMsg('Nothing to normalize (silence)'); return; }
  const g = 0.977 / peak; // about -0.2 dB
  applyRange((ch, s, e) => { for (let i = s; i < e; i++) ch[i] *= g; }, `Normalized (x${g.toFixed(2)})`);
}
function gain() {
  const db = parseFloat($('gainDb').value) || 0;
  const g = Math.pow(10, db / 20);
  applyRange((ch, s, e) => { for (let i = s; i < e; i++) ch[i] *= g; }, `Gain ${db > 0 ? '+' : ''}${db} dB`);
}
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
    wctx.fillStyle = cssVar(playing ? '--playhead' : '--cursor');
    wctx.fillRect(Math.round(px), 0, 1, H);
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
  $('btnPaste').disabled = !d || !clipboard;
  $('btnExport').disabled = !d || exporting;
  $('btnExportMp3').disabled = !d || exporting;
  $('btnUndo').disabled = !undoStack.length;
  $('btnRedo').disabled = !redoStack.length;
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

// drag & drop
document.body.addEventListener('dragover', (e) => { e.preventDefault(); empty.classList.add('drag'); });
document.body.addEventListener('dragleave', () => empty.classList.remove('drag'));
document.body.addEventListener('drop', async (e) => {
  e.preventDefault(); empty.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f) loadArrayBuffer(f.name, await f.arrayBuffer());
});

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
window.addEventListener('beforeunload', (e) => { if (doc.dirty) { e.preventDefault(); e.returnValue = ''; } });
resize();
updateUI();
