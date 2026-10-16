// recording/clip.js - short audio clips: from a live recording's last 2 minutes (kept in memory by
// each track), or from a finished recording's mix on Drive (ffmpeg seeks it over HTTPS, so only that part
// is downloaded).
const fs = require("fs");
const path = require("path");
const { OggOpusWriter, isSilence } = require("./ogg");
const { MS } = require("./track");
const ffmpeg = require("./ffmpeg");
const drive = require("./drive");
const { Recording: cfg } = require("../config");

// tracks: TrackWriter[]; startMs/endMs on the recording timeline. Returns the clip's path, or null if nobody spoke.
async function fromTracks(tracks, startMs, endMs, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const from = Math.round(startMs * MS);
  const to = Math.round(endMs * MS);
  const stamp = Date.now();
  const inputs = [];
  for (const track of tracks) {
    const packets = track.recent(from, to);
    if (!packets.some((p) => !isSilence(p.packet))) continue;
    const file = path.join(dir, `in_${track.userId}_${stamp}.ogg`);
    const w = new OggOpusWriter(file);
    let written = from;
    for (const p of packets) {
      if (p.pos < written) continue;
      written += w.writeSilence(p.pos - written);
      w.writePacket(p.packet, p.samples);
      written += p.samples;
    }
    w.writeSilence(to - written);
    w.close();
    inputs.push(file);
  }
  if (!inputs.length) return null;
  const out = path.join(dir, `clip_${Math.round(startMs)}_${stamp}.ogg`);
  try {
    await ffmpeg.mix(inputs, out, { kbps: cfg.clipKbps });
  } finally {
    for (const f of inputs) fs.unlink(f, () => { });
  }
  return out;
}

// A clip out of a finished recording's mix file on Drive
async function fromDrive(fileId, startMs, seconds, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const token = await drive.accessToken();
  await ffmpeg.run([
    "-headers", `Authorization: Bearer ${token}\r\n`,
    "-ss", (Math.max(0, startMs) / 1000).toFixed(2),
    "-t", String(seconds),
    "-i", drive.mediaUrl(fileId),
    "-ac", "1", ...ffmpeg.opus(cfg.clipKbps),
    out,
  ]);
  return out;
}

module.exports = { fromTracks, fromDrive };
