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

// One speaker's track: levelled and compressed (one small ffmpeg run per speaker, so progress is saved per speaker)
async function encodeTrack(input, out, { kbps }) {
  await run(["-i", input, "-af", level, "-ac", "1", ...opus(kbps), out]);
}

// The mix, from tracks that are already levelled
async function mixTracks(files, out, { kbps, onProgress }) {
  const args = [];
  for (const f of files) args.push("-i", f);
  args.push("-filter_complex", `${sum(files.map((_, i) => `[${i}:a]`))}[mix]`, "-map", "[mix]", "-ac", "1", ...opus(kbps), out);
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

module.exports = { run, opus, encodeTrack, mixTracks, mix, killAll };
