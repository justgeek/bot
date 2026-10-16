// recording/ffmpeg.js - runs the bundled ffmpeg (ffmpeg-static) at low priority, so mixing a long recording
// never starves the bot's own voice connection.
const { spawn } = require("child_process");
const os = require("os");
const ffmpegPath = require("ffmpeg-static");

const running = new Set();

// onProgress(ms): how far into the output ffmpeg is
function run(args, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const full = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...(onProgress ? ["-progress", "pipe:1", "-nostats"] : []), ...args];
    const child = spawn(ffmpegPath, full, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    running.add(child);
    try {
      os.setPriority(child.pid, 10);
    } catch { }
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.stdout.on("data", (d) => {
      if (!onProgress) return;
      const m = /out_time_us=(\d+)/.exec(String(d));
      if (m) onProgress(Number(m[1]) / 1000);
    });
    child.on("error", (err) => {
      running.delete(child);
      reject(err);
    });
    child.on("close", (code, signal) => {
      running.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg ${signal ? `was stopped (${signal})` : `exited with ${code}`}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`));
    });
  });
}

const opus = (kbps) => ["-c:a", "libopus", "-b:a", `${kbps}k`, "-vbr", "on", "-application", "voip", "-frame_duration", "60"];

// Each speaker is levelled on their own (people's mic volumes differ a lot), then everyone is summed
// (not averaged, so nobody gets quieter as others join) and a limiter catches the peaks.
const level = "dynaudnorm=f=250:g=15:m=5";
const sum = (labels) => `${labels.join("")}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95`;

// One pass for everything: decodes each raw track once, writes its compressed copy and the mix
// tracks: [{ file, out }] (same length, already silence-filled on the recording's timeline)
async function encodeTracksAndMix(tracks, mixOut, { trackKbps, mixKbps, onProgress }) {
  const args = [];
  for (const t of tracks) args.push("-i", t.file);
  const graph = [];
  tracks.forEach((_, i) => graph.push(`[${i}:a]asplit=2[t${i}][m${i}]`, `[m${i}]${level}[n${i}]`));
  graph.push(`${sum(tracks.map((_, i) => `[n${i}]`))}[mix]`);
  args.push("-filter_complex", graph.join(";"));
  tracks.forEach((t, i) => args.push("-map", `[t${i}]`, "-ac", "1", ...opus(trackKbps), t.out));
  args.push("-map", "[mix]", "-ac", "1", ...opus(mixKbps), mixOut);
  await run(args, { onProgress });
}

async function mix(files, out, { kbps }) {
  const args = [];
  for (const f of files) args.push("-i", f);
  const graph = files.map((_, i) => `[${i}:a]${level}[n${i}]`);
  graph.push(`${sum(files.map((_, i) => `[n${i}]`))}[mix]`);
  args.push("-filter_complex", graph.join(";"), "-map", "[mix]", "-ac", "1", ...opus(kbps), out);
  await run(args);
}

function killAll() {
  for (const child of running) {
    try {
      child.kill();
    } catch { }
  }
}

module.exports = { run, opus, encodeTracksAndMix, mix, killAll };
