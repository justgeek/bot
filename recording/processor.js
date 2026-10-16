// recording/processor.js - turns a finished recording into the files kept on Google Drive, step by step:
// audio (mix + one track per speaker) -> transcript -> summary -> finish. Each finished step is saved in
// recordings.outputs, so after a bot restart (or a Gemini quota pause) the job continues where it was.
const fs = require("fs");
const path = require("path");
const { IDs, Recording: cfg } = require("../config");
const { OggOpusWriter, readOggPackets, isSilence } = require("./ogg");
const { MS } = require("./track");
const ffmpeg = require("./ffmpeg");
const store = require("./store");
const drive = require("./drive");
const panel = require("./panel");
const transcribe = require("./transcribe");
const { WORK_DIR, QuotaPause, folderName, safeName } = require("./util");

let client = null;
const queue = [];
let running = null;
let stopping = false;

function init(c) {
  client = c;
}

// One job at a time: mixing is the heavy part and the bot shares its CPU
function enqueue(id) {
  if (stopping || running === id || queue.includes(id)) return;
  queue.push(id);
  pump();
}

async function pump() {
  if (running || stopping || !queue.length) return;
  running = queue.shift();
  try {
    await processRecording(running);
  } catch (err) {
    console.error(`[Rec] Processing ${running} crashed:`, err);
  } finally {
    running = null;
    setImmediate(pump);
  }
}

const isBusy = (id) => running === id || queue.includes(id);

function shutdown() {
  stopping = true;
  ffmpeg.killAll();
}

// ---------- Panel / thread ----------
async function recordChannel() {
  return client?.channels.fetch(IDs.channelRecord).catch(() => null);
}

async function updatePanel(rec) {
  if (!rec.panel_message_id) return;
  const channel = await recordChannel();
  const msg = await channel?.messages.fetch(rec.panel_message_id).catch(() => null);
  await msg?.edit(panel.endedPanel(rec)).catch((err) => console.warn("[Rec] Panel update failed:", err.message));
}

function makeCtx(rec) {
  const dir = path.join(WORK_DIR, rec.id);
  let panelTimer = null;
  let lastPanel = 0;
  const ctx = {
    dir,
    lines: null,
    trackPaths: null,
    save: () => store.saveRecording(rec),
    progress(step, state, detail) {
      rec.outputs.progress[step] = { state, detail };
      if (panelTimer) return;
      panelTimer = setTimeout(() => {
        panelTimer = null;
        lastPanel = Date.now();
        updatePanel(rec);
      }, Math.max(0, 3000 - (Date.now() - lastPanel)));
    },
    async thread() {
      if (!rec.thread_id) return null;
      return client?.channels.fetch(rec.thread_id).catch(() => null);
    },
    // Each speaker's compressed track on this disk (downloaded again from Drive after a restart)
    async trackFiles() {
      const out = {};
      const onDrive = rec.outputs.files?.tracks || {};
      for (const userId of new Set([...Object.keys(rec.outputs.speech || {}), ...Object.keys(onDrive)])) {
        const local = ctx.trackPaths?.[userId] || path.join(dir, "tracks", `${userId}.ogg`);
        if (!fs.existsSync(local) && onDrive[userId]?.id && drive.enabled) {
          fs.mkdirSync(path.dirname(local), { recursive: true });
          await drive.download(onDrive[userId].id, local);
        }
        if (fs.existsSync(local)) out[userId] = local;
      }
      return out;
    },
    async postReport() {
      if (rec.outputs.posted.report || !rec.report) return;
      const thread = await ctx.thread();
      if (!thread) return;
      await thread.send(panel.reportCard(rec)).catch((err) => console.warn("[Rec] Couldn't post the report card:", err.message));
      rec.outputs.posted.report = true;
      await ctx.save();
    },
  };
  return ctx;
}

// ---------- Audio ----------
// Rebuilds one speaker's continuous track from their chunk files (packets copied as they are, gaps
// silence-filled, padded to the recording's full length so all tracks line up). Returns their speech
// as [[startMs, endMs], ...] (pauses up to 250 ms merged), used for the transcript and the report card.
function remux(chunks, outFile, totalSamples, name) {
  const w = new OggOpusWriter(outFile, { tags: { ARTIST: name } });
  const speech = [];
  let cur = null;
  let written = 0;
  for (const c of chunks) {
    const base = c.startMs * MS;
    for (const { packet, start, samples } of readOggPackets(c.file)) {
      const pos = base + start;
      if (pos + samples <= written) continue; // overlaps what's already there
      if (pos > written) written += w.writeSilence(pos - written);
      const at = written;
      w.writePacket(packet, samples);
      written += samples;
      if (isSilence(packet)) continue;
      const s = Math.round(at / MS);
      const e = Math.round((at + samples) / MS);
      if (cur && s - cur[1] <= 250) cur[1] = e;
      else speech.push((cur = [s, e]));
    }
  }
  if (totalSamples > written) w.writeSilence(totalSamples - written);
  w.close();
  return speech;
}

// Does any of these sorted [start, end] intervals overlap (from, to)?
function overlapsAny(intervals, from, to) {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (intervals[mid][1] <= from) lo = mid + 1;
    else hi = mid - 1;
  }
  return lo < intervals.length && intervals[lo][0] < to;
}

// A run of someone's speech: their pauses under 1.5 s are bridged, unless somebody else spoke in the pause
function runsOf(user, speech) {
  const others = Object.entries(speech).filter(([u]) => u !== user).map(([, iv]) => iv);
  const runs = [];
  for (const [s, e] of speech[user]) {
    const last = runs[runs.length - 1];
    if (last && s - last[1] < 1500 && !others.some((iv) => overlapsAny(iv, last[1], s))) last[1] = Math.max(last[1], e);
    else runs.push([s, e]);
  }
  return runs;
}

// Is someone in the middle of a run at time t (started > 0.3 s before, keeps going > 0.3 s after)?
function midRun(runs, t) {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid][1] <= t) lo = mid + 1;
    else hi = mid - 1;
  }
  const r = runs[lo];
  return !!r && r[0] < t - 300 && r[1] > t + 300;
}

function buildReport(rec, speech, durationMs) {
  const users = Object.keys(speech);
  const runs = Object.fromEntries(users.map((u) => [u, runsOf(u, speech)]));
  const speakers = users
    .map((u) => ({ user: u, name: rec.speakers?.[u]?.name || u, talkMs: speech[u].reduce((a, [s, e]) => a + (e - s), 0) }))
    .sort((a, b) => b.talkMs - a.talkMs);
  const sumTalk = speakers.reduce((a, s) => a + s.talkMs, 0) || 1;
  for (const s of speakers) s.share = s.talkMs / sumTalk;

  let longest = null;
  for (const u of users) for (const [s, e] of runs[u]) if (!longest || e - s > longest.ms) longest = { user: u, ms: e - s, at: s };

  const jumpedIn = {};
  for (const u of users) {
    for (const [s] of runs[u]) {
      if (users.some((o) => o !== u && midRun(runs[o], s))) jumpedIn[u] = (jumpedIn[u] || 0) + 1;
    }
  }
  const top = Object.entries(jumpedIn).sort((a, b) => b[1] - a[1])[0];

  // Time anyone at all was talking (overlaps counted once)
  const all = users.flatMap((u) => speech[u]).sort((a, b) => a[0] - b[0]);
  let talkMs = 0;
  let curS = -1;
  let curE = -1;
  for (const [s, e] of all) {
    if (s > curE) {
      talkMs += curE - curS;
      curS = s;
      curE = e;
    } else if (e > curE) curE = e;
  }
  talkMs += curE - curS;

  const events = rec.events || [];
  return {
    durationMs,
    talkMs: Math.max(0, talkMs),
    speakers,
    longest,
    interrupter: top ? { user: top[0], count: top[1] } : null,
    notes: events.filter((e) => e.type === "note").length,
    clips: events.filter((e) => e.type === "clip").length,
  };
}

async function audioStep(rec, ctx) {
  const out = rec.outputs;
  ctx.progress("audio", "running", "gathering the audio");
  const chunksDir = path.join(ctx.dir, "chunks");
  const rawDir = path.join(ctx.dir, "raw");
  const tracksDir = path.join(ctx.dir, "tracks");
  for (const d of [chunksDir, rawDir, tracksDir]) fs.mkdirSync(d, { recursive: true });

  // Chunks are on this disk, or (after a restart) on Drive
  const byUser = new Map();
  let lost = 0;
  for (const row of await store.getChunks(rec.id)) {
    const file = path.join(chunksDir, `${row.user_id}_${row.start_ms}.ogg`);
    if (!fs.existsSync(file)) {
      if (!row.drive_file_id || !drive.enabled) {
        lost++;
        continue;
      }
      try {
        await drive.download(row.drive_file_id, file);
      } catch (err) {
        console.warn(`[Rec] Chunk ${row.user_id}_${row.start_ms} couldn't be downloaded:`, err.message);
        lost++;
        continue;
      }
    }
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push({ file, startMs: Number(row.start_ms) });
  }
  if (!byUser.size) throw new Error(lost ? "the audio didn't reach Google Drive before the bot restarted" : "no audio was found");
  if (lost) console.warn(`[Rec] ${rec.id}: ${lost} chunk(s) were lost`);

  const totalMs = Date.parse(rec.ended_at) - Date.parse(rec.started_at);
  const speech = {};
  const tracks = [];
  // Most talkative first: "01 Name.ogg" is the person who talked the most
  const users = [...byUser.keys()].sort((a, b) => (rec.speakers?.[b]?.speaking_ms || 0) - (rec.speakers?.[a]?.speaking_ms || 0));
  for (const userId of users) {
    const name = rec.speakers?.[userId]?.name || userId;
    const chunks = byUser.get(userId).sort((a, b) => a.startMs - b.startMs);
    const raw = path.join(rawDir, `${userId}.ogg`);
    speech[userId] = remux(chunks, raw, Math.ceil(totalMs * MS), name);
    for (const c of chunks) fs.unlink(c.file, () => { }); // Drive keeps a copy until the recording is finished
    tracks.push({ userId, name, file: raw, out: path.join(tracksDir, `${userId}.ogg`), upload: `${String(tracks.length + 1).padStart(2, "0")} ${safeName(name)}.ogg` });
  }
  out.speech = speech;
  rec.report = buildReport(rec, speech, totalMs);
  await ctx.save();

  ctx.progress("audio", "running", "mixing (0%)");
  const mixFile = path.join(ctx.dir, "mix.ogg");
  let lastPct = -1;
  await ffmpeg.encodeTracksAndMix(tracks, mixFile, {
    trackKbps: cfg.trackKbps,
    mixKbps: cfg.mixKbps,
    onProgress: (ms) => {
      const pct = Math.min(99, Math.floor((ms / Math.max(1, totalMs)) * 100));
      if (pct >= lastPct + 5) ctx.progress("audio", "running", `mixing (${(lastPct = pct)}%)`);
    },
  });
  for (const t of tracks) fs.unlink(t.file, () => { });
  ctx.trackPaths = Object.fromEntries(tracks.map((t) => [t.userId, t.out]));

  out.files = out.files || {};
  if (drive.enabled) {
    ctx.progress("audio", "running", "uploading to Google Drive");
    const folder = await drive.recordingFolder(rec, folderName(rec));
    await drive.rename(folder, folderName(rec)); // "start → …" becomes "start → end" now that it's over
    out.files.mix = await drive.upload(folder, "mix.ogg", mixFile, "audio/ogg");
    await ctx.save();
    const tracksFolder = await drive.ensureFolder(folder, "tracks");
    out.files.tracks = out.files.tracks || {};
    for (const t of tracks) {
      out.files.tracks[t.userId] = { ...(await drive.upload(tracksFolder, t.upload, t.out, "audio/ogg")), name: t.name };
      await ctx.save();
    }
    const total = out.files.mix.size + Object.values(out.files.tracks).reduce((a, f) => a + (f.size || 0), 0);
    ctx.progress("audio", "done", `mix + ${tracks.length} speaker track${tracks.length === 1 ? "" : "s"} (${panel.size(total)})`);
  } else {
    // Without Drive the only copy is this disk; post the mix in the thread when it's small enough
    out.files.local = { mix: mixFile, tracks: ctx.trackPaths };
    const thread = await ctx.thread();
    const posted = thread && (await thread.send({ content: "🎧 Mix (Google Drive isn't connected)", files: [{ attachment: mixFile, name: "mix.ogg" }] }).then(() => true, () => false));
    ctx.progress("audio", "done", `mix + ${tracks.length} tracks on the bot's disk only (Drive isn't connected)${posted ? "; mix posted in the thread" : ""}`);
  }
  await ctx.save();
  if (!rec.options?.transcribe) await ctx.postReport();
}

async function finishStep(rec, ctx) {
  const out = rec.outputs;
  if (drive.enabled && rec.drive_folder_id) {
    const info = {
      id: rec.id,
      channel: { id: rec.channel_id, name: rec.channel_name },
      started_at: rec.started_at,
      ended_at: rec.ended_at,
      end_reason: rec.end_reason,
      started_by: rec.started_by,
      parts: rec.parts,
      speakers: rec.speakers,
      report: rec.report,
      events: rec.events,
      options: rec.options,
      files: { mix: out.files?.mix?.id, tracks: Object.fromEntries(Object.entries(out.files?.tracks || {}).map(([u, f]) => [u, f.id])), transcript: out.files?.transcript?.id },
    };
    await drive.upload(rec.drive_folder_id, "info.json", Buffer.from(JSON.stringify(info, null, 2)), "application/json");
    // The raw chunks were only a safety net while recording
    await drive.trashChild(rec.drive_folder_id, "raw");
    await store.deleteChunks(rec.id);
    fs.rm(ctx.dir, { recursive: true, force: true }, () => { });
  }
  await ctx.postReport();
}

// ---------- The job ----------
async function processRecording(id) {
  const rec = await store.getRecording(id);
  if (!rec || ["deleted", "discarded", "recording", "suspended"].includes(rec.status)) return;
  rec.outputs = rec.outputs || {};
  const out = rec.outputs;
  out.progress = out.progress || {};
  out.posted = out.posted || {};
  rec.status = "processing";
  rec.resume_after = null;
  rec.error = null;
  const ctx = makeCtx(rec);
  let step = "audio";
  try {
    if (out.progress.audio?.state !== "done") await audioStep(rec, ctx);
    step = "transcript";
    if (rec.options?.transcribe && out.progress.transcript?.state !== "done") await transcribe.transcriptStep(rec, ctx);
    step = "summary";
    if (rec.options?.summarize && out.progress.summary?.state !== "done") await transcribe.summaryStep(rec, ctx);
    step = "finish";
    await finishStep(rec, ctx);
    rec.status = "done";
  } catch (err) {
    if (stopping) return; // the bot is shutting down: it stays "processing" and continues after the restart
    if (err instanceof QuotaPause) {
      rec.status = "paused";
      rec.resume_after = new Date(err.until).toISOString();
      out.progress[err.step] = { state: "paused", detail: `Gemini's free daily limit is used up - continues by itself <t:${Math.floor(err.until / 1000)}:R>` };
    } else {
      console.error(`[Rec] Processing ${id} failed (${step}):`, err);
      rec.status = "failed";
      rec.error = String(err.message || err).slice(0, 500);
      if (step !== "finish") out.progress[step] = { state: "failed", detail: String(err.message || err).replace(/\s+/g, " ").slice(0, 150) };
    }
  }
  await store.saveRecording(rec);
  await updatePanel(rec);
}

// ---------- Delete / retention ----------
async function deleteRecording(rec, byUserId) {
  if (drive.enabled && rec.drive_folder_id) await drive.trash(rec.drive_folder_id);
  await store.deleteLines(rec.id);
  await store.deleteChunks(rec.id);
  rec.status = "deleted";
  rec.outputs = { ...(rec.outputs || {}), deletedBy: byUserId };
  await store.saveRecording(rec);
  await updatePanel(rec);
  fs.rm(path.join(WORK_DIR, rec.id), { recursive: true, force: true }, () => { });
}

// Audio older than `days` goes to Drive's trash; transcripts, summaries and info stay
async function applyRetention(days) {
  if (!drive.enabled || !(days > 0)) return;
  const cutoff = Date.now() - days * 86400e3;
  for (const rec of await store.findRecordings(["done"])) {
    const out = rec.outputs || {};
    if (out.audioDeleted || !rec.drive_folder_id || Date.parse(rec.ended_at || rec.started_at) > cutoff) continue;
    try {
      if (out.files?.mix?.id) await drive.trash(out.files.mix.id);
      await drive.trashChild(rec.drive_folder_id, "tracks");
      await drive.trashChild(rec.drive_folder_id, "clips");
      out.audioDeleted = days;
      await store.saveRecording(rec);
      await updatePanel(rec);
    } catch (err) {
      console.warn(`[Rec] Retention cleanup of ${rec.id} failed:`, err.message);
    }
  }
}

module.exports = { init, enqueue, isBusy, shutdown, updatePanel, deleteRecording, applyRetention, buildReport, remux };
