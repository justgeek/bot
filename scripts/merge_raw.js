// scripts/merge_raw.js - Merges raw Discord recording chunk files mid-recording and strips silence.
// Can be run via:
//   npm run merge-raw [files or folders...]
//   node scripts/merge_raw.js [files or folders...]
//   Or drag & drop files onto merge_raw.bat
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { spawn, spawnSync, exec } = require("child_process");

const config = require("../config");
const { readOggPackets, OggOpusWriter, SAMPLE_RATE } = require("../recording/ogg");
const ffmpegPath = process.env.FFMPEG_PATH || require("ffmpeg-static");
const { WORK_DIR } = require("../recording/util");

const MS = 48; // 48 samples per millisecond at 48kHz

// Resolve known speaker display names
function resolveSpeakerName(rawId) {
  const isBotAudio = rawId.startsWith("bot-");
  const userId = isBotAudio ? rawId.slice(4) : rawId;

  // Search config.IDs
  let name = null;
  if (config.IDs) {
    for (const [key, val] of Object.entries(config.IDs)) {
      if (String(val) === String(userId)) {
        name = key;
        break;
      }
    }
  }

  // Search config.PeopleTTS
  if (!name && config.PeopleTTS && config.PeopleTTS[userId]) {
    name = config.PeopleTTS[userId];
  }

  if (!name) name = `User-${userId.slice(-4)}`;
  return isBotAudio ? `${name} (bot sounds)` : name;
}

// Parse a chunk file name like:
// "bot-946751602415521873_12600000.ogg" or "946751602415521873_12600000.ogg"
function parseChunkFile(filePath) {
  const base = path.basename(filePath);
  const m = /^((?:bot-)?.*)_(\d+)\.ogg$/i.exec(base);
  if (m) {
    return {
      file: path.resolve(filePath),
      base,
      source: m[1], // e.g. "946751602415521873" or "bot-946751602415521873"
      isBot: m[1].startsWith("bot-"),
      userId: m[1].startsWith("bot-") ? m[1].slice(4) : m[1],
      startMs: parseInt(m[2], 10),
    };
  }

  // Fallback for non-timestamped audio files
  const nameOnly = path.basename(filePath, path.extname(filePath));
  return {
    file: path.resolve(filePath),
    base,
    source: nameOnly,
    isBot: nameOnly.startsWith("bot-"),
    userId: nameOnly.startsWith("bot-") ? nameOnly.slice(4) : nameOnly,
    startMs: 0,
  };
}

// Collect all audio files from given inputs (file paths or directories)
function collectAudioFiles(inputs) {
  const files = [];
  for (const item of inputs) {
    const clean = item.replace(/^["']|["']$/g, "").trim();
    if (!clean) continue;
    if (!fs.existsSync(clean)) {
      console.warn(`[Warn] Path not found: ${clean}`);
      continue;
    }
    const stat = fs.statSync(clean);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(clean);
      for (const e of entries) {
        if (/\.(ogg|opus|wav|mp3)$/i.test(e)) {
          files.push(path.join(clean, e));
        }
      }
    } else if (stat.isFile()) {
      files.push(clean);
    }
  }
  return files;
}

// Remux one speaker's chunks onto a continuous timeline starting from minStartMs
function remuxSpeaker(chunks, outFile, minStartMs) {
  const w = new OggOpusWriter(outFile);
  let written = 0;
  for (const c of chunks) {
    const base = Math.max(0, (c.startMs - minStartMs) * MS);
    for (const { packet, start, samples } of readOggPackets(c.file)) {
      const pos = base + Math.max(0, start);
      if (pos + samples <= written) continue;
      if (pos > written) written += w.writeSilence(pos - written);
      w.writePacket(packet, samples);
      written += samples;
    }
  }
  w.close();
  return written;
}

// Format milliseconds as HH:MM:SS or MM:SS
function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Format duration from seconds
function formatSec(sec) {
  return formatDuration(sec * 1000);
}

// Check ffmpeg version / availability
function checkFFmpeg() {
  if (!fs.existsSync(ffmpegPath)) {
    throw new Error(`FFmpeg executable not found at: ${ffmpegPath}`);
  }
}

// Run FFmpeg with real-time progress
function runFFmpeg(args, onProgress) {
  return new Promise((resolve, reject) => {
    const full = ["-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-y", ...args];
    const child = spawn(ffmpegPath, full, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";

    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-4000);
    });

    child.stdout.on("data", (d) => {
      if (!onProgress) return;
      const m = /out_time_us=(\d+)/.exec(String(d));
      if (m) onProgress(Number(m[1]) / 1000000);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (code ${code}): ${stderr.trim()}`));
    });
  });
}

// Get file duration in seconds using FFmpeg
function getFileDurationSec(file) {
  try {
    const res = spawnSync(ffmpegPath, ["-i", file], { encoding: "utf8" });
    const output = res.stderr || "";
    const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(output);
    if (m) {
      return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }
  } catch {}
  return 0;
}

// Prompt for text input if needed
function promptUser(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function main() {
  console.log("\n=======================================================");
  console.log("       Discord Raw Recording Merger & Silence Remover   ");
  console.log("=======================================================\n");

  checkFFmpeg();

  // Parse command line flags and file inputs
  const rawArgs = process.argv.slice(2);
  let inputs = [];
  let silenceRemove = true;
  let threshold = "-45dB";
  let minSilence = "0.5";
  let keepSilence = "0.25";
  let autoPlay = true;
  let outFormat = "mp3"; // "mp3" or "ogg"
  let customOut = null;

  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === "--no-silence" || a === "--no-silence-remove" || a === "--raw") {
      silenceRemove = false;
    } else if (a === "--threshold" && rawArgs[i + 1]) {
      threshold = rawArgs[++i];
      if (!threshold.endsWith("dB")) threshold += "dB";
    } else if (a === "--min-silence" && rawArgs[i + 1]) {
      minSilence = rawArgs[++i];
    } else if (a === "--keep-silence" && rawArgs[i + 1]) {
      keepSilence = rawArgs[++i];
    } else if (a === "--no-play") {
      autoPlay = false;
    } else if (a === "--play") {
      autoPlay = true;
    } else if (a === "--ogg" || a === "--format" && rawArgs[i + 1] === "ogg") {
      outFormat = "ogg";
      if (a === "--format") i++;
    } else if (a === "--mp3" || a === "--format" && rawArgs[i + 1] === "mp3") {
      outFormat = "mp3";
      if (a === "--format") i++;
    } else if (a === "--out" && rawArgs[i + 1]) {
      customOut = rawArgs[++i];
    } else if (!a.startsWith("--")) {
      inputs.push(a);
    }
  }

  // If no inputs given, check default folder ./raw_input
  const defaultDir = path.resolve(__dirname, "..", "raw_input");
  if (!inputs.length && fs.existsSync(defaultDir)) {
    const defaultFiles = fs.readdirSync(defaultDir).filter((f) => /\.(ogg|opus|wav|mp3)$/i.test(f));
    if (defaultFiles.length > 0) {
      console.log(`[Info] Found ${defaultFiles.length} file(s) in ./raw_input directory.`);
      inputs.push(defaultDir);
    }
  }

  // If still no inputs, check active recording in temp directory
  if (!inputs.length && fs.existsSync(WORK_DIR)) {
    try {
      const recFolders = fs.readdirSync(WORK_DIR).filter((f) => {
        const full = path.join(WORK_DIR, f, "chunks");
        return fs.existsSync(full) && fs.readdirSync(full).length > 0;
      });
      if (recFolders.length > 0) {
        const latestRec = recFolders[recFolders.length - 1];
        const chunksPath = path.join(WORK_DIR, latestRec, "chunks");
        const chunkCount = fs.readdirSync(chunksPath).length;
        console.log(`[Info] Detected active local recording in temp: ${latestRec} (${chunkCount} chunks)`);
        const ans = await promptUser(`Use active local recording chunks? (Y/n) or paste folder path: `);
        if (!ans || ans.toLowerCase() === "y" || ans.toLowerCase() === "yes") {
          inputs.push(chunksPath);
        } else if (ans.length > 1) {
          inputs.push(ans);
        }
      }
    } catch {}
  }

  // If still no inputs, prompt user to supply folder or files
  if (!inputs.length) {
    console.log("No files provided.");
    console.log("You can:");
    console.log("  1. Drop your .ogg chunk files into the 'raw_input' folder");
    console.log("  2. Or drag & drop the files/folder directly onto merge_raw.bat");
    console.log("  3. Or enter the folder path right here:\n");
    const entered = await promptUser("Enter folder path or file path: ");
    if (entered) inputs.push(entered);
  }

  const rawFiles = collectAudioFiles(inputs);
  if (!rawFiles.length) {
    console.error("\n[Error] No valid audio files found to process. Exiting.");
    return;
  }

  console.log(`\nFound ${rawFiles.length} chunk file(s). Analyzing timestamps and speakers...`);

  // Parse chunks
  const chunks = rawFiles.map(parseChunkFile);

  // Group by source (e.g. "946751602415521873" or "bot-946751602415521873")
  const bySource = new Map();
  for (const c of chunks) {
    if (!bySource.has(c.source)) bySource.set(c.source, []);
    bySource.get(c.source).push(c);
  }

  // Calculate timeline bounds
  const minStartMs = Math.min(...chunks.map((c) => c.startMs));
  const maxStartMs = Math.max(...chunks.map((c) => c.startMs));

  // Determine chunk duration (default ~5 min = 300s if not probed)
  let maxChunkLenSec = 0;
  for (const c of rawFiles.slice(0, 5)) {
    const d = getFileDurationSec(c);
    if (d > maxChunkLenSec) maxChunkLenSec = d;
  }
  const chunkSpanMs = Math.round((maxChunkLenSec > 0 ? maxChunkLenSec : 300) * 1000);
  const estimatedSpanMs = Math.max(chunkSpanMs, (maxStartMs - minStartMs) + chunkSpanMs);

  console.log("\n--- Speakers Detected ---");
  for (const [source, list] of bySource.entries()) {
    const name = resolveSpeakerName(source);
    console.log(` • ${name} (${source}): ${list.length} chunk(s)`);
  }
  console.log(`\nTimeline offset: ${formatDuration(minStartMs)} -> ${formatDuration(maxStartMs)} (Estimated span: ${formatDuration(estimatedSpanMs)})`);

  // Create temporary directory for building tracks
  const tempDir = path.join(os.tmpdir(), `merge_raw_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const builtTracks = [];

  try {
    console.log("\n[1/3] Remuxing and aligning speaker tracks...");
    let sourceIdx = 0;
    for (const [source, list] of bySource.entries()) {
      sourceIdx++;
      const name = resolveSpeakerName(source);
      list.sort((a, b) => a.startMs - b.startMs);
      const trackFile = path.join(tempDir, `track_${sourceIdx}.ogg`);
      process.stdout.write(`  [${sourceIdx}/${bySource.size}] Aligning ${name}... `);

      try {
        remuxSpeaker(list, trackFile, minStartMs);
        if (fs.existsSync(trackFile) && fs.statSync(trackFile).size > 100) {
          builtTracks.push(trackFile);
          console.log("Done.");
        } else {
          console.log("Skipped (empty).");
        }
      } catch (err) {
        console.log(`Failed with Ogg remux, using FFmpeg direct... (${err.message})`);
        // Fallback: if not raw Discord Ogg, use ffmpeg directly
        builtTracks.push(list[0].file);
      }
    }

    if (!builtTracks.length) {
      throw new Error("No speaker tracks could be assembled.");
    }

    // Determine output file path
    const outDir = path.resolve(__dirname, "..", "output");
    fs.mkdirSync(outDir, { recursive: true });
    const timestampStr = new Date().toISOString().replace(/T/, "_").replace(/[:.]/g, "-").slice(0, 19);
    const outputFile = customOut || path.join(outDir, `merged_mid_recording_${timestampStr}.${outFormat}`);
    const latestFile = path.join(outDir, `latest_merged.${outFormat}`);

    console.log("\n[2/3] Mixing tracks and applying silence removal...");
    if (silenceRemove) {
      console.log(`  Silence filter: pause > ${minSilence}s at < ${threshold} collapsed to ${keepSilence}s`);
    } else {
      console.log("  Silence removal: DISABLED (raw timing preserved)");
    }

    // Build FFmpeg filter graph
    const ffmpegArgs = [];
    for (const t of builtTracks) {
      ffmpegArgs.push("-i", t);
    }

    const n = builtTracks.length;
    let filterGraph = "";

    if (n === 1) {
      // Single speaker
      if (silenceRemove) {
        filterGraph = `[0:a]dynaudnorm=f=250:g=15:m=5,silenceremove=start_periods=1:start_duration=0.1:start_threshold=${threshold}:stop_periods=-1:stop_duration=${minSilence}:stop_threshold=${threshold}:stop_silence=${keepSilence}[out]`;
      } else {
        filterGraph = `[0:a]dynaudnorm=f=250:g=15:m=5[out]`;
      }
    } else {
      // Multiple speakers: level each, amix together, then remove silence
      const leveled = [];
      const parts = [];
      for (let i = 0; i < n; i++) {
        parts.push(`[${i}:a]dynaudnorm=f=250:g=15:m=5[n${i}]`);
        leveled.push(`[n${i}]`);
      }
      parts.push(`${leveled.join("")}amix=inputs=${n}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[mix]`);

      if (silenceRemove) {
        parts.push(`[mix]silenceremove=start_periods=1:start_duration=0.1:start_threshold=${threshold}:stop_periods=-1:stop_duration=${minSilence}:stop_threshold=${threshold}:stop_silence=${keepSilence}[out]`);
      } else {
        parts.push(`[mix]anull[out]`);
      }
      filterGraph = parts.join(";");
    }

    ffmpegArgs.push("-filter_complex", filterGraph, "-map", "[out]");

    // Encoding format options
    if (outFormat === "mp3") {
      ffmpegArgs.push("-c:a", "libmp3lame", "-b:a", "128k", "-ar", "48000");
    } else {
      ffmpegArgs.push("-c:a", "libopus", "-b:a", "64k", "-vbr", "on", "-application", "voip");
    }
    ffmpegArgs.push(outputFile);

    process.stdout.write("  Encoding: 0%");
    let lastReportedSec = 0;
    await runFFmpeg(ffmpegArgs, (currentSec) => {
      if (currentSec - lastReportedSec >= 2) {
        lastReportedSec = currentSec;
        process.stdout.write(`\r  Encoding progress: ${formatSec(currentSec)} rendered`);
      }
    });
    console.log(`\r  Encoding complete!                   `);

    // Copy to latest_merged
    try {
      fs.copyFileSync(outputFile, latestFile);
    } catch {}

    // Calculate final metrics
    const finalSec = getFileDurationSec(outputFile);
    const estSpanSec = Math.round(estimatedSpanMs / 1000);
    const savedSec = Math.max(0, estSpanSec - Math.round(finalSec));
    const savedPct = estSpanSec > 0 ? Math.round((savedSec / estSpanSec) * 100) : 0;

    console.log("\n=======================================================");
    console.log("                  MERGE SUCCESSFUL!                    ");
    console.log("=======================================================");
    console.log(`Output File:      ${outputFile}`);
    console.log(`Shortcut Link:    ${latestFile}`);
    console.log(`Original Span:    ~${formatSec(estSpanSec)}`);
    console.log(`Condensed Audio:  ${formatSec(finalSec)}`);
    if (silenceRemove && savedSec > 0) {
      console.log(`Silence Removed:  ${formatSec(savedSec)} (${savedPct}% dead air skipped!)`);
    }
    console.log("=======================================================\n");

    // Automatically play in default system player
    if (autoPlay) {
      console.log("Opening file in default media player...");
      if (process.platform === "win32") {
        exec(`start "" "${outputFile}"`);
      } else if (process.platform === "darwin") {
        exec(`open "${outputFile}"`);
      } else {
        exec(`xdg-open "${outputFile}"`);
      }
    }
  } finally {
    // Cleanup temp dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error("\n[Error] Failed to merge recording:", err.message || err);
  process.exit(1);
});
