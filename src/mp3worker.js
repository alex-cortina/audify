'use strict';
// Runs the MP3 encoder off the main thread so the window never freezes.
importScripts('vendor/lame.min.js');

self.onmessage = (e) => {
  const { left, right, sampleRate, kbps } = e.data;
  try {
    const nCh = right ? 2 : 1;
    const enc = new lamejs.Mp3Encoder(nCh, sampleRate, kbps);
    const n = left.length, BLOCK = 1152 * 32, parts = [];
    let lastPct = -1;
    for (let i = 0; i < n; i += BLOCK) {
      const out = nCh === 2 ? enc.encodeBuffer(left.subarray(i, i + BLOCK), right.subarray(i, i + BLOCK)) : enc.encodeBuffer(left.subarray(i, i + BLOCK));
      if (out.length) parts.push(out);
      const pct = Math.floor(i / n * 100);
      if (pct !== lastPct) { lastPct = pct; self.postMessage({ type: 'progress', pct }); }
    }
    const end = enc.flush();
    if (end.length) parts.push(end);
    const total = parts.reduce((a, b) => a + b.length, 0);
    const data = new Uint8Array(total);
    let o = 0; for (const p of parts) { data.set(p, o); o += p.length; }
    self.postMessage({ type: 'done', data: data.buffer }, [data.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
