// recording/peaks.js - a lightweight waveform for the /recordings player, read from the mix file without
// decoding it: Opus packets are tiny during silence and big while people talk, so bytes per time slice
// (on a square-root scale) trace where the sound is. Gives `bins` values from 0 to 100.
const { readOggPackets } = require("./ogg");

function peaksFromOgg(file, durationMs, bins = 1600) {
  const total = Math.max(1, durationMs * 48);
  const bytes = new Float64Array(bins);
  const samples = new Float64Array(bins);
  for (const p of readOggPackets(file)) {
    if (p.start < 0) continue;
    const b = Math.min(bins - 1, Math.floor((p.start / total) * bins));
    bytes[b] += p.packet.length;
    samples[b] += p.samples;
  }
  // Bytes per second in each slice; the quietest slice is the "silence" floor
  const rate = Array.from(bytes, (n, i) => (samples[i] ? n / (samples[i] / 48000) : 0));
  const present = rate.filter((r) => r > 0).sort((a, b) => a - b);
  if (!present.length) return new Array(bins).fill(0);
  const floor = present[0];
  const top = present[Math.floor((present.length - 1) * 0.99)] - floor || 1;
  return rate.map((r) => (r ? Math.round(Math.min(1, Math.sqrt(Math.max(0, r - floor) / top)) * 100) : 0));
}

module.exports = { peaksFromOgg };
