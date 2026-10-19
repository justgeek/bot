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
const { peaksFromOgg } = require("./peaks");
const { WORK_DIR, QuotaPause, folderName, safeName } = require("./util");

let client = null;
const queue = [];
let running = null;
let live = null; // the row being processed (its progress is only saved at checkpoints; the recordings page reads it from here)
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
    live = null;
    setImmediate(pump);
  }
}

const isBusy = (id) => running === id || queue.includes(id);
const liveRecording = (id) => (live && live.id === id ? live : null);

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
    // all: every track (the mix needs the bot's too), else only the people's (for the transcript)
    async trackFiles({ all = false } = {}) {
      const out = {};
      const onDrive = rec.outputs.files?.tracks || {};
      for (const userId of Object.keys(all ? onDrive : rec.outputs.speech || {})) {
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

  // Only turns of 2 s+ count, so "yeah"s and laughs over someone aren't interruptions
  const jumpedIn = {};
  for (const u of users) {
    for (const [s, e] of runs[u]) {
      if (e - s < 2000) continue;
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

// Builds the audio one speaker at a time (rebuild their track from its pieces, level + compress it,
// upload it), saving after each, then mixes the finished tracks. A restart in the middle only redoes the
// speaker (or the mix) that was in progress.
async function audioStep(rec, ctx) {
  const out = rec.outputs;
  out.files = out.files || {};
  out.files.tracks = out.files.tracks || {};
  out.speech = out.speech || {};
  ctx.progress("audio", "running", "gathering the audio");
  const chunksDir = path.join(ctx.dir, "chunks");
  const rawDir = path.join(ctx.dir, "raw");
  const tracksDir = path.join(ctx.dir, "tracks");
  for (const d of [chunksDir, rawDir, tracksDir]) fs.mkdirSync(d, { recursive: true });

  const byUser = new Map();
  for (const row of await store.getChunks(rec.id)) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row);
  }
  // One file per person: what the bot played for them (their memes/TTS, the "X joined/left" about them,
  // recorded as "bot-<their id>") is mixed into their own track. Only unattributed bot audio ("bot") stays apart.
  const person = (u) => (u.startsWith("bot-") ? u.slice(4) : u);
  const nameOf = (u) => rec.speakers?.[u]?.name || rec.speakers?.[`bot-${u}`]?.name?.replace(/ \(bot sounds\)$/, "") || u;
  // Most talkative first: "01 Name.ogg" is the person who talked the most
  const users = [...new Set([...[...byUser.keys()].map(person), ...Object.keys(out.files.tracks).filter((k) => !k.startsWith("bot-"))])].sort(
    (a, b) => (a === "bot") - (b === "bot") || (rec.speakers?.[b]?.speaking_ms || 0) - (rec.speakers?.[a]?.speaking_ms || 0)
  );
  if (!users.length) throw new Error("no audio was found");
  const totalMs = Date.parse(rec.ended_at) - Date.parse(rec.started_at);

  let folder = null;
  let tracksFolder = null;
  if (drive.enabled) {
    folder = await drive.recordingFolder(rec, folderName(rec));
    await drive.rename(folder, folderName(rec)); // "start → …" becomes "start → end" now that it's over
    tracksFolder = await drive.ensureFolder(folder, "tracks");
  }

  let lost = 0;
  for (const [i, userId] of users.entries()) {
    if (out.files.tracks[userId]?.done) continue;
    const name = nameOf(userId);
    ctx.progress("audio", "running", `speaker track ${i + 1} of ${users.length} (${name})`);
    const raws = [];
    const used = [];
    for (const source of [userId, `bot-${userId}`].filter((k) => byUser.has(k))) {
      // Their pieces are on this disk, or (after a restart) on Drive
      const chunks = [];
      for (const row of byUser.get(source).sort((a, b) => a.start_ms - b.start_ms)) {
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
        chunks.push({ file, startMs: Number(row.start_ms) });
      }
      if (!chunks.length) continue;
      const raw = path.join(rawDir, `${source}.ogg`);
      const intervals = remux(chunks, raw, Math.ceil(totalMs * MS), name);
      // Only their own voice is transcribed and counted as talking; the bot's sounds are already in the log
      if (source === userId && !rec.speakers?.[source]?.bot) out.speech[userId] = intervals;
      raws.push(raw);
      used.push(...chunks);
    }
    if (!raws.length) continue;
    const local = path.join(tracksDir, `${userId}.ogg`);
    await ffmpeg.encodeTrack(raws, local, { kbps: cfg.trackKbps });
    for (const f of raws) fs.unlink(f, () => { });
    for (const c of used) fs.unlink(c.file, () => { }); // Drive keeps a copy until the audio is done
    const entry = { name, done: true };
    if (tracksFolder) Object.assign(entry, await drive.upload(tracksFolder, `${String(i + 1).padStart(2, "0")} ${safeName(name)}.ogg`, local, "audio/ogg"));
    out.files.tracks[userId] = entry;
    await ctx.save();
  }
  if (!Object.keys(out.files.tracks).length) throw new Error(lost ? "the audio didn't reach Google Drive before the bot restarted" : "no audio was found");
  if (lost) console.warn(`[Rec] ${rec.id}: ${lost} chunk(s) were lost`);
  rec.report = buildReport(rec, out.speech, totalMs);
  await ctx.save();

  // Everyone mixed together, from the finished (already levelled) tracks
  const files = await ctx.trackFiles({ all: true });
  ctx.trackPaths = files;
  const mixFile = path.join(ctx.dir, "mix.ogg");
  if (!out.files.mix) {
    ctx.progress("audio", "running", "mixing (0%)");
    let lastPct = -1;
    await ffmpeg.mixTracks(Object.values(files), mixFile, {
      kbps: cfg.mixKbps,
      onProgress: (ms) => {
        const pct = Math.min(99, Math.floor((ms / Math.max(1, totalMs)) * 100));
        if (pct > lastPct) ctx.progress("audio", "running", `mixing (${(lastPct = pct)}%)`);
      },
    });
    out.peaks = peaksFromOgg(mixFile, totalMs); // the waveform on the /recordings page
    if (folder) {
      ctx.progress("audio", "running", "uploading the mix");
      out.files.mix = await drive.upload(folder, "mix.ogg", mixFile, "audio/ogg");
      await ctx.save();
    }
  }

  const count = Object.keys(out.files.tracks).length;
  if (drive.enabled) {
    const total = (out.files.mix?.size || 0) + Object.values(out.files.tracks).reduce((a, f) => a + (f.size || 0), 0);
    ctx.progress("audio", "done", `mix + ${count} track${count === 1 ? "" : "s"} (${panel.size(total)})`);
    await ctx.save();
    // The raw 5-minute pieces were only a safety net while recording: gone for good (not to the trash, which
    // would keep counting against the Drive space for 30 days)
    await drive.trashChild(rec.drive_folder_id, "raw", { permanent: true });
    await store.deleteChunks(rec.id);
  } else {
    // Without Drive the only copy is this disk; post the mix in the thread when it's small enough
    out.files.local = { mix: mixFile };
    const thread = await ctx.thread();
    const posted = thread && (await thread.send({ content: "🎧 Mix (Google Drive isn't connected)", files: [{ attachment: mixFile, name: "mix.ogg" }] }).then(() => true, () => false));
    ctx.progress("audio", "done", `mix + ${count} tracks on the bot's disk only (Drive isn't connected)${posted ? "; mix posted in the thread" : ""}`);
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
    await drive.trashChild(rec.drive_folder_id, "raw", { permanent: true });
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
  live = rec;
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
      out.progress[err.step] = { state: "paused", detail: `Gemini's free limit is used up - tries again by itself <t:${Math.floor(err.until / 1000)}:R>` };
    } else {
      console.error(`[Rec] Processing ${id} failed (${step}):`, err);
      rec.status = "failed";
      rec.error = String(err.message || err).slice(0, 500);
      if (step !== "finish") out.progress[step] = { state: "failed", detail: String(err.message || err).replace(/\s+/g, " ").slice(0, 150) };
      // The full error, where people will see it (the panel only has room for a short version)
      const thread = await ctx.thread();
      await thread?.send({ content: `❌ Processing stopped at the **${step}** step:\n\`\`\`\n${String(err.message || err).replace(/```/g, "'''").slice(0, 1700)}\n\`\`\`Press **Retry** on the panel to try again. For more details type \`!reclogs\` in #record.`, allowedMentions: { parse: [] } }).catch(() => { });
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

// Deletes a recording's audio for good (mix, speaker tracks, clips); transcripts, summaries and info stay.
// why: shown on its panel ("after 30 days" / "to free up Drive space")
async function removeAudio(rec, why) {
  const out = rec.outputs || (rec.outputs = {});
  if (out.files?.mix?.id) await drive.remove(out.files.mix.id);
  await drive.trashChild(rec.drive_folder_id, "tracks", { permanent: true });
  await drive.trashChild(rec.drive_folder_id, "clips", { permanent: true });
  out.audioDeleted = why;
  await store.saveRecording(rec);
  await updatePanel(rec);
}

// Finished recordings that still have audio on Drive, oldest first
async function withAudio() {
  return (await store.findRecordings(["done"]))
    .filter((r) => !r.outputs?.audioDeleted && r.drive_folder_id && r.outputs?.files?.mix?.id)
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
}

// Audio older than `days` is deleted
async function applyRetention(days) {
  if (!drive.enabled || !(days > 0)) return;
  const cutoff = Date.now() - days * 86400e3;
  for (const rec of await withAudio()) {
    if (Date.parse(rec.ended_at || rec.started_at) > cutoff) continue;
    try {
      await removeAudio(rec, `after ${days} days`);
    } catch (err) {
      console.warn(`[Rec] Retention cleanup of ${rec.id} failed:`, err.message);
    }
  }
}

// While Drive has less than minFreeBytes free, the oldest recordings' audio is deleted. Returns the quota.
async function freeUpSpace(minFreeBytes) {
  if (!drive.enabled) return null;
  let q = await drive.quota();
  if (!(minFreeBytes > 0) || !q.limit) return q;
  for (const rec of await withAudio()) {
    if (q.limit - q.usage >= minFreeBytes) break;
    try {
      await removeAudio(rec, "to free up Drive space");
      console.log(`[Rec] Deleted the audio of ${rec.id} (${rec.started_at}) to free up Drive space.`);
    } catch (err) {
      console.warn(`[Rec] Couldn't free space with ${rec.id}:`, err.message);
      break;
    }
    q = await drive.quota();
  }
  return q;
}

module.exports = { init, enqueue, isBusy, liveRecording, shutdown, updatePanel, deleteRecording, applyRetention, freeUpSpace, buildReport, remux };
