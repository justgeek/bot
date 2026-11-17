// recording/processor.js - turns a finished recording into the files kept on Google Drive, step by step:
// audio (mix + one track per speaker) -> transcript -> summary -> finish. Each finished step is saved in
// recordings.outputs, so after a bot restart (or a Gemini quota pause) the job continues where it was.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { IDs, Recording: cfg } = require("../config");
const { OggOpusWriter, readOggPackets, isSilence } = require("./ogg");
const { MS, addSpeech } = require("./track");
const ffmpeg = require("./ffmpeg");
const store = require("./store");
const drive = require("./drive");
const panel = require("./panel");
const transcribe = require("./transcribe");
const { peaksFromOgg } = require("./peaks");
const { WORK_DIR, QuotaPause, JobStopped, busyRetryAt, resetBusyCount, watchStep, folderName, safeName } = require("./util");

let client = null;
const queue = [];
const queuedAt = new Map(); // recording id -> when it was queued (the local worker's grace reads it)
const takeFromRemote = new Set(); // ids the local scan found held by another live copy (the fast PC takes those over)
const retryAt = new Map(); // recording id -> don't try to claim it again before this (another copy holds it)
let running = null;
let live = null; // the row being processed (its progress is only saved at checkpoints; the recordings page reads it from here)
let stopping = false;
let localMode = false; // startLocalWorker(): this copy processes recordings and never records
let takeOver = false; // the worker was asked to take the job over from the copy that has it now

// Which copy of the bot this is, as the claim columns see it ("heroku" on a dyno, the PC's name for
// worker.js). Two copies share the recordings table; the claim decides which one may work on one at a time.
const isHeroku = !!process.env.DYNO;
const WORKER = String(process.env.PROCESSOR_NAME || (isHeroku ? `heroku-${process.env.DYNO}` : (os.hostname() || "bot"))).slice(0, 40);
const CLAIM_MS = (cfg.claimTtlSeconds || 180) * 1000;
const CLAIM_BEAT_MS = Math.max(10000, Math.min(30000, Math.round(CLAIM_MS / 3)));

function init(c) {
  client = c;
}

// One job at a time: mixing is the heavy part and the bot shares its CPU
function enqueue(id) {
  if (stopping || running === id || queue.includes(id)) return;
  queue.push(id);
  if (!queuedAt.has(id)) queuedAt.set(id, Date.now());
  pump();
}

// One pump at a time: two calls used to interleave around a claim (the same recording asked for twice, or two
// jobs starting in this process). Every path below schedules the next pump itself, so a call ignored here is
// never lost.
let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    await pumpStep();
  } finally {
    pumping = false;
  }
}

async function pumpStep() {
  if (running || stopping || !queue.length) return;
  // Skip whatever another copy is still holding (it comes back after its own 5 s backoff), so one job that can't
  // be claimed can never block the recordings behind it in the queue
  const now = Date.now();
  const id = queue.find((q) => (retryAt.get(q) || 0) <= now);
  if (!id) {
    const soonest = Math.min(...queue.map((q) => retryAt.get(q) || now));
    setTimeout(pump, Math.max(1000, Math.min(15000, soonest - now)));
    return;
  }
  if (await waitForLocalProcessor(id)) return;
  const force = takeOver || takeFromRemote.has(id);
  const claimed = await store.claimRecording(id, WORKER, CLAIM_MS, { force });
  if (!claimed) {
    // Refused: another copy holds it, or there's nothing left to do on it. Either way this one waits 5 s (each
    // try is a Supabase request, and a tight loop there burns the free tier) while the next recording starts.
    retryAt.set(id, Date.now() + 5000);
    const state = await store.getRecordingState(id).catch(() => null);
    // Only when the database positively says there is no work left: no answer at all (a blip) keeps it in line
    if (state && !["processing", "paused"].includes(state.status)) {
      // Finished, deleted or still being recorded: out of the queue for good (the scan adds it again if it ever
      // needs work, and a finished one never does)
      const at = queue.indexOf(id);
      if (at >= 0) queue.splice(at, 1);
      retryAt.delete(id);
      queuedAt.delete(id);
      console.log(`[Rec] ${id}: ${state.status}, nothing to process`);
      setImmediate(pump);
      return;
    }
    setTimeout(pump, 0); // straight on to the next recording that's ready
    return;
  }
  const qi = queue.indexOf(id);
  if (qi >= 0) queue.splice(qi, 1);
  retryAt.delete(id);
  queuedAt.delete(id);
  takeFromRemote.delete(id);
  takeOver = false;
  running = id;
  if (localMode) {
    await store.setProcessorBeat({ name: WORKER, kind: "local", at: new Date().toISOString(), job: id }).catch(() => {});
  }
  try {
    await processRecording(id);
  } catch (err) {
    console.error(`[Rec] Processing ${id} crashed:`, err);
  } finally {
    running = null;
    live = null;
    if (localMode) {
      await store.setProcessorBeat({ name: WORKER, kind: "local", at: new Date().toISOString(), job: null }).catch(() => {});
    }
    await store.releaseClaim(id, WORKER).catch(() => { }); // done, paused or failed: free for whichever copy is around
    setImmediate(pump);
  }
}

// A worker on someone's own PC is much faster than a dyno, so while one is running this bot waits a little
// before starting a job: the worker gets first go, and if it isn't there this bot starts right away.
async function waitForLocalProcessor(id) {
  const grace = (cfg.localProcessorGraceSeconds || 0) * 1000;
  if (!(grace > 0) || localMode) return false;
  if (!queuedAt.has(id)) return false;
  // While a worker on a PC is alive this copy waits for it, however long the job takes. It used to take the
  // job anyway after 10 minutes, and that is what had the two copies pulling the same recording back and forth
  // ("picked up" / "stopped" every few seconds, each time throwing away the Gemini request in flight).
  // The moment the worker stops beating (closed laptop, killed process) this copy takes the job over.
  const beat = await store.getProcessorBeat();
  if (!beat?.name || beat.name === WORKER || beat.kind !== "local") return false;
  if (Date.now() - Date.parse(beat.at || 0) > Math.max(60000, grace)) return false;
  // A worker that beats but hasn't started this job for a quarter of an hour is stuck (its scan failing, a
  // folder it can't write to): this copy takes over rather than leaving the recording waiting for ever.
  const since = queuedAt.get(id);
  if (!beat.job && since && Date.now() - since > 15 * 60000) {
    console.warn(`[Rec] ${id}: ${beat.name} has been idle for 15 min without starting it, starting here instead`);
    return false;
  }
  setTimeout(pump, 15000);
  return true;
}

// ---------- The processor-only worker (worker.js on a PC) ----------
// It doesn't log into the gateway or join voice, so it can't duplicate anything the bot on Heroku does: it
// only takes finished recordings over the database and processes them here. A recording that's still going
// is a different file, so finished jobs are processed even while the bot is in a voice channel.
async function startLocalWorker(c, { takeOver: take = false } = {}) {
  client = c;
  localMode = true;
  takeOver = take;
  // The heartbeat also holds the claim on the job being worked on: a dyno that starts (or a copy that was left
  // running from before an update) can't take it away for more than 30 s, so the fast PC is the one that
  // finishes the recording. Only the row being finished stops this. Every extra beat is a Supabase request,
  // so it stays at 30 s (the claim lasts 3 minutes: plenty of room).
  const beat = (currentJob = running || null) =>
    Promise.all([
      store.setProcessorBeat({ name: WORKER, kind: "local", at: new Date().toISOString(), job: currentJob }),
      currentJob ? store.claimRecording(currentJob, WORKER, CLAIM_MS, { force: true, anyStatus: true }).catch(() => false) : null,
    ]);
  await beat();
  setInterval(() => beat(), 30000).unref();
  let lastIdleLog = 0;
  const scan = async () => {
    // Only while this PC is actually working on something: a queue entry waiting out a claim backoff must not
    // stop new recordings from being found (enqueue() already ignores one that's still queued)
    if (stopping || running) return;
    try {
      // Scan rows: status and claim only. This runs every 30 s, and a full row carries the live transcript and
      // the speech map (megabytes on a long night), which was most of the Supabase egress.
      const rows = [...(await store.findRecordings(["processing"], { scan: true })), ...(await store.findRecordings(["paused"], { scan: true }))];
      const next = rows
        .filter((r) => r.status !== "paused" || Date.parse(r.resume_after || 0) <= Date.now())
        .filter((r) => !isBusy(r.id))
        .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))[0];
      if (next) {
        // This PC is the fast copy: when it's idle it takes the job over from the bot on Heroku, which stops
        // quickly to save CPU and AI requests. It doesn't take it from another PC worker that is really on it,
        // or the two would keep pulling the same job back and forth.
        if (heldElsewhere(next)) {
          const liveBeat = await store.getProcessorBeat().catch(() => null);
          const holderIsLocal = liveBeat?.kind === "local" && liveBeat.name === next.claimed_by && Date.now() - Date.parse(liveBeat.at || 0) < 60000;
          if (holderIsLocal) {
            console.log(`[Rec] ${next.id}: ${next.claimed_by} is on it (${next.claim_step || next.status}), leaving it there`);
            return;
          }
          console.log(`[Rec] ${next.id}: taking it over from ${next.claimed_by} (${next.claim_step || next.status})`);
          takeFromRemote.add(next.id);
        } else {
          console.log(`[Rec] ${next.id}: picked up (${next.status}), processing here on ${WORKER}`);
        }
        enqueue(next.id);
        return;
      }
      if (Date.now() - lastIdleLog > 10 * 60000) {
        lastIdleLog = Date.now();
        console.log("[Rec] Nothing to process right now (watching for finished recordings).");
      }
    } catch (err) {
      console.warn("[Rec] Looking for a recording to process failed:", err.message || err);
    }
  };
  // Not unref'd: when there's no job running this timer is the only thing keeping the process alive
  // (the heartbeat is unref'd, and an idle worker used to just exit after "Nothing to process right now")
  setInterval(scan, (cfg.workerPollSeconds || 15) * 1000);
  await scan();
}

const isBusy = (id) => running === id || queue.includes(id);
// Another copy's claim counts only while it keeps being renewed. Without this the worker picked rows the bot on
// Heroku was already on, failed the claim silently, and logged the same "picked up" line every 30 s.
const heldElsewhere = (r) => !!r.claimed_by && r.claimed_by !== WORKER && Date.parse(r.claim_expires_at || 0) > Date.now();
const liveRecording = (id) => (live && live.id === id ? live : null);

function shutdown() {
  stopping = true;
  ffmpeg.killAll();
}

// ---------- Panel / thread ----------
async function recordChannel() {
  return client?.channels.fetch(IDs.channelRecord).catch(() => null);
}

// A bot can only edit messages it posted itself, so a copy of the bot started with a different token can't
// touch a panel another bot posted: worth saying once, not on every progress tick.
const panelNotOurs = new Set();
async function updatePanel(rec) {
  if (!rec.panel_message_id) return;
  const channel = await recordChannel();
  const msg = await channel?.messages.fetch(rec.panel_message_id).catch(() => null);
  await msg?.edit(panel.endedPanel(rec)).catch((err) => {
    if (/authored by another user/i.test(err.message || "")) {
      if (panelNotOurs.has(rec.id)) return;
      panelNotOurs.add(rec.id);
      console.warn(`[Rec] ${rec.id}: its panel was posted by a different bot, so this one can't update it. Every copy of the bot needs the same BOT_TOKEN.`);
      return;
    }
    console.warn("[Rec] Panel update failed:", err.message);
  });
}

function makeCtx(rec, state = {}, abortController = null) {
  const dir = path.join(WORK_DIR, rec.id);
  const signal = abortController?.signal || null;
  let panelTimer = null;
  let lastPanel = 0;
  let lastBeat = Date.now(); // when the step last said it did something (the watchdog reads it)
  let lastCheck = 0;
  const ctx = {
    dir,
    lines: null,
    trackPaths: null,
    currentStep: "audio",
    abortSignal: signal,
    isLost: async ({ forceCheck = false } = {}) => {
      if (state.lost || signal?.aborted) return true;
      if (!localMode && (forceCheck || Date.now() - lastCheck > 2500)) {
        lastCheck = Date.now();
        const mine = await store.renewClaim(rec.id, WORKER, CLAIM_MS, ctx.currentStep).catch(() => true);
        if (!mine) {
          state.lost = true;
          console.warn(`[Rec] ${rec.id}: another copy of the bot took this job over, stopping here.`);
          abortController?.abort(new JobStopped("another copy of the bot is processing this recording"));
          ffmpeg.killAll();
          return true;
        }
      }
      return false;
    },
    // Once another copy of the bot has taken the job over, nothing from here may be written anymore
    save: () => {
      if (state.lost || signal?.aborted) throw new JobStopped("another copy of the bot is processing this recording");
      return store.saveRecording(rec);
    },
    beat: () => lastBeat,
    // something is happening that doesn't change the panel (a downloaded piece, an ffmpeg run ticking along)
    pulse: () => { lastBeat = Date.now(); },
    progress(step, state, detail) {
      rec.outputs.progress[step] = { state, detail };
      lastBeat = Date.now();
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
    // Rebuilds the report card from the speech found (word counts are kept)
    refreshReport() {
      const o = rec.outputs;
      const old = rec.report;
      rec.report = buildReport(rec, o.speech || {}, Date.parse(rec.ended_at) - Date.parse(rec.started_at));
      for (const s of rec.report.speakers) {
        const prev = old?.speakers?.find((x) => x.user === s.user);
        if (prev && prev.words !== undefined) s.words = prev.words;
      }
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
      if (!isSilence(packet)) addSpeech(speech, Math.round(at / MS), Math.round((at + samples) / MS));
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

// Audio, phase 1: rebuilds every speaker's track (from the raw pieces, levelled and compressed) on this disk,
// one speaker at a time, saving after each. Nothing goes to Drive yet: the transcript looks at the tracks
// first, so anything that must not be kept is cut out before it's uploaded or mixed. A restart only redoes
// the speaker that was in progress (tracks lost with the disk are rebuilt from the pieces on Drive).
async function audioBuild(rec, ctx) {
  const out = rec.outputs;
  out.files = out.files || {};
  out.files.tracks = out.files.tracks || {};
  out.speech = out.speech || {};
  ctx.progress("audio", "running", "gathering the audio");
  const chunksDir = path.join(ctx.dir, "chunks");
  const rawDir = path.join(ctx.dir, "raw");
  const tracksDir = path.join(ctx.dir, "tracks");
  for (const d of [chunksDir, rawDir, tracksDir]) fs.mkdirSync(d, { recursive: true });
  if (drive.enabled) await drive.recordingFolder(rec, folderName(rec));

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

  console.log(`[Rec] ${rec.id}: building ${users.length} speaker track(s) from ${[...byUser.values()].reduce((n, l) => n + l.length, 0)} pieces`);
  let lost = 0;
  let skipped = 0;
  for (const [i, userId] of users.entries()) {
    if (await ctx.isLost?.()) throw new JobStopped("another copy of the bot is processing this recording");
    const local = path.join(tracksDir, `${userId}.ogg`);
    const have = out.files.tracks[userId];
    if (have?.done || (have?.built && fs.existsSync(local))) {
      skipped++;
      continue;
    }
    const name = nameOf(userId);
    const startedAt = Date.now();
    console.log(`[Rec] ${rec.id}: ${name}: starting track ${i + 1} of ${users.length}`);
    ctx.progress("audio", "running", `speaker track ${i + 1} of ${users.length} (${name})`);
    const raws = [];
    let got = 0;
    const used = [];
    for (const source of [userId, `bot-${userId}`].filter((k) => byUser.has(k))) {
      // Their pieces are on this disk, or (after a restart) on Drive
      const chunks = [];
      for (const row of byUser.get(source).sort((a, b) => a.start_ms - b.start_ms)) {
        if (await ctx.isLost?.()) throw new JobStopped("another copy of the bot is processing this recording");
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
        ctx.pulse();
        if (++got % 10 === 0) console.log(`[Rec] ${rec.id}: ${name}: ${got} pieces ready`);
      }
      if (!chunks.length) continue;
      const raw = path.join(rawDir, `${source}.ogg`);
      const intervals = remux(chunks, raw, Math.ceil(totalMs * MS), name);
      // Only their own voice is transcribed and counted as talking; the bot's sounds are already in the log
      if (source === userId && !rec.speakers?.[source]?.bot) out.speech[userId] = intervals;
      else { out.botSpeech = out.botSpeech || {}; out.botSpeech[source] = intervals; }
      raws.push(raw);
      used.push(...chunks);
    }
    if (!raws.length) continue;
    if (await ctx.isLost?.()) throw new JobStopped("another copy of the bot is processing this recording");
    await ffmpeg.encodeTrack(raws, local, { kbps: cfg.trackKbps, onProgress: () => ctx.pulse() });
    for (const f of raws) fs.unlink(f, () => { });
    for (const c of used) fs.unlink(c.file, () => { }); // Drive keeps a copy until the audio is done
    out.files.tracks[userId] = { name, built: true, idx: i };
    console.log(`[Rec] ${rec.id}: ${name}: track ${i + 1} of ${users.length} is built in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    await ctx.save();
  }
  if (!Object.keys(out.files.tracks).length) throw new Error(lost ? "the audio didn't reach Google Drive before the bot restarted" : "no audio was found");
  if (skipped) console.log(`[Rec] ${rec.id}: ${skipped} track(s) were already built, skipped them`);
  if (lost) console.warn(`[Rec] ${rec.id}: ${lost} chunk(s) were lost`);
  ctx.refreshReport();
  ctx.progress("audio", "running", rec.options?.transcribe ? "tracks ready, waiting for the transcript" : "tracks ready");
  await ctx.save();
}

// Audio, phase 2 (after the transcript): uploads the tracks, mixes and uploads the mix
async function audioPublish(rec, ctx) {
  if (await ctx.isLost?.({ forceCheck: true })) throw new JobStopped("another copy of the bot is processing this recording");
  const out = rec.outputs;
  const tracks = out.files.tracks;
  const totalMs = Date.parse(rec.ended_at) - Date.parse(rec.started_at);
  const files = await ctx.trackFiles({ all: true });
  ctx.trackPaths = files;

  let folder = null;
  let tracksFolder = null;
  if (drive.enabled) {
    folder = await drive.recordingFolder(rec, folderName(rec));
    await drive.rename(folder, folderName(rec)); // "start → …" becomes "start → end" now that it's over
    tracksFolder = await drive.ensureFolder(folder, "tracks");
  }
  const entries = Object.entries(tracks).sort((a, b) => (a[1].idx ?? 99) - (b[1].idx ?? 99));
  for (const [userId, entry] of entries) {
    if (await ctx.isLost?.()) throw new JobStopped("another copy of the bot is processing this recording");
    if (entry.done) continue;
    if (!files[userId]) throw new Error(`the track of ${entry.name} isn't on this disk anymore`);
    if (tracksFolder) {
      ctx.progress("audio", "running", `uploading ${entry.name}'s track`);
      Object.assign(entry, await drive.upload(tracksFolder, `${String((entry.idx ?? 0) + 1).padStart(2, "0")} ${safeName(entry.name)}.ogg`, files[userId], "audio/ogg"));
    }
    entry.done = true;
    await ctx.save();
  }

  // Everyone mixed together, from the finished (already levelled and cut) tracks
  const mixFile = path.join(ctx.dir, "mix.ogg");
  if (!out.files.mix) {
    if (await ctx.isLost?.({ forceCheck: true })) throw new JobStopped("another copy of the bot is processing this recording");
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
    const posted = thread && (await thread.send({ content: "ðŸŽ§ Mix (Google Drive isn't connected)", files: [{ attachment: mixFile, name: "mix.ogg" }] }).then(() => true, () => false));
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
  // Fresh from the database: the other copy of the bot may already have done some of the steps
  const rec = await store.getRecording(id, { fresh: true });
  if (!rec || ["deleted", "discarded", "recording", "suspended"].includes(rec.status)) return;
  rec.outputs = rec.outputs || {};
  let out = rec.outputs;
  out.progress = out.progress || {};
  out.posted = out.posted || {};
  rec.status = "processing";
  rec.resume_after = null;
  rec.error = null;
  live = rec;
  const state = { lost: false };
  const abortController = new AbortController();
  const ctx = makeCtx(rec, state, abortController);
  let step = "audio";
  ctx.currentStep = step;

  // On Heroku check every 15 s so a local worker taking over stops it quickly. (It was 3.5 s, which was 25k
  // claim writes a day for nothing: the PC's own heartbeat takes the job within 30 s anyway.)
  const beatIntervalMs = localMode ? CLAIM_BEAT_MS : Math.min(CLAIM_BEAT_MS, 15000);
  let reclaimed = false; // already said "took it back" for this grab, so the log isn't spammed every 30 s
  const beat = setInterval(async () => {
    if (state.lost) return;
    const mine = await store.renewClaim(id, WORKER, CLAIM_MS, step).catch(() => true);
    if (mine) { reclaimed = false; return; }
    // A worker on a PC is the fast copy and owns the job: take it straight back from whoever grabbed it and
    // carry on with the step. Stopping here restarted the track build from zero every time the other copy
    // helped itself to the job, which is why a recording never got past the first speaker.
    if (localMode) {
      const row = await store.getRecording(id, { fresh: true }).catch(() => null);
      if (row && ["done", "deleted", "discarded"].includes(row.status)) {
        state.lost = true;
        abortController.abort(new JobStopped(`already ${row.status}`));
        ffmpeg.killAll();
        return;
      }
      if (await store.claimRecording(id, WORKER, CLAIM_MS, { force: true, anyStatus: true }).catch(() => false)) {
        if (!reclaimed) console.warn(`[Rec] ${id}: ${row?.claimed_by || "another copy"} grabbed the job, took it back (${WORKER} is the fast processor).`);
        reclaimed = true;
        return;
      }
      // Couldn't yet: keep working and try again on the next beat rather than throwing the step away
      console.warn(`[Rec] ${id}: couldn't take the job back from ${row?.claimed_by || "another copy"} yet, carrying on`);
      return;
    }
    state.lost = true;
    console.warn(`[Rec] ${id}: another copy of the bot took this job over, stopping here.`);
    abortController.abort(new JobStopped("another copy of the bot is processing this recording"));
    ffmpeg.killAll();
  }, beatIntervalMs);
  beat.unref?.();

  // Each step is done once, by whichever copy is on the job: read what's saved before starting one
  const sync = async () => {
    if (state.lost || ctx.abortSignal?.aborted) throw new JobStopped("another copy of the bot is processing this recording");
    const fresh = await store.getRecording(id, { fresh: true }).catch(() => null);
    if (!fresh) return;
    if (["done", "deleted", "discarded"].includes(fresh.status)) throw new JobStopped(`already ${fresh.status}`);
    if (fresh.outputs) {
      rec.outputs = out = fresh.outputs;
      out.progress = out.progress || {};
      out.posted = out.posted || {};
    }
    rec.options = fresh.options || rec.options;
    rec.report = fresh.report || rec.report;
    rec.summary_en = fresh.summary_en ?? rec.summary_en;
    rec.summary_ar = fresh.summary_ar ?? rec.summary_ar;
  };

  try {
    await sync();
    if (out.progress.audio?.state !== "done") await watchStep(audioBuild(rec, ctx), "audio", { stallMs: 5 * 60000, beat: ctx.beat, signal: ctx.abortSignal });
    step = "transcript";
    ctx.currentStep = step;
    await sync();
    if (rec.options?.transcribe && out.progress.transcript?.state !== "done") await watchStep(transcribe.transcriptStep(rec, ctx), "transcript", { beat: ctx.beat, signal: ctx.abortSignal });
    step = "audio";
    ctx.currentStep = step;
    await sync();
    if (out.progress.audio?.state !== "done") await watchStep(audioPublish(rec, ctx), "audio", { beat: ctx.beat, signal: ctx.abortSignal });
    step = "summary";
    ctx.currentStep = step;
    await sync();
    if (rec.options?.summarize && out.progress.summary?.state !== "done") await watchStep(transcribe.summaryStep(rec, ctx), "summary", { beat: ctx.beat, signal: ctx.abortSignal });
    step = "finish";
    ctx.currentStep = step;
    await sync();
    await watchStep(finishStep(rec, ctx), "finish", { beat: ctx.beat, signal: ctx.abortSignal });
    resetBusyCount(id); // clear backoff counter after a clean run
    rec.status = "done";
  } catch (err) {
    if (stopping) return; // the bot is shutting down: it stays "processing" and continues after the restart
    if (state.lost || err instanceof JobStopped || ctx.abortSignal?.aborted) {
      // Another copy has the job now: leave the row exactly as that copy keeps it
      console.log(`[Rec] ${id}: stopped (${err.message || "taken over"}), another copy is finishing it.`);
      return;
    }
    // Quota/busy pauses, and network or stall trouble inside a step (err.transient): wait and come back
    if (err instanceof QuotaPause || err.transient) {
      const until = err.until || busyRetryAt(id);
      const at = err.step || step;
      rec.status = "paused";
      rec.resume_after = new Date(until).toISOString();
      out.progress[at] = { state: "paused", detail: err.detail || `Something went wrong (${String(err.message || err).slice(0, 120)}) - tries again by itself <t:${Math.floor(until / 1000)}:R>` };
      console.warn(`[Rec] Processing ${id} paused at the ${at} step (${err.message}), tries again by itself.`);
    } else {
      console.error(`[Rec] Processing ${id} failed (${step}):`, err);
      rec.status = "failed";
      rec.error = String(err.message || err).slice(0, 500);
      if (step !== "finish") out.progress[step] = { state: "failed", detail: String(err.message || err).replace(/\s+/g, " ").slice(0, 150) };
      // The full error, where people will see it (the panel only has room for a short version)
      const thread = await ctx.thread();
      await thread?.send({ content: `âŒ Processing stopped at the **${step}** step:\n\`\`\`\n${String(err.message || err).replace(/```/g, "'''").slice(0, 1700)}\n\`\`\`Press **Retry** on the panel to try again. For more details type \`!reclogs\` in #record.`, allowedMentions: { parse: [] } }).catch(() => { });
    }
  } finally {
    clearInterval(beat);
  }
  // Only the copy that still holds the job writes the result down: a takeover in the last second must not
  // be overwritten with this one's older view of it
  if (state.lost || ctx.abortSignal?.aborted || !(await store.renewClaim(id, WORKER, CLAIM_MS, "finish"))) {
    console.log(`[Rec] ${id}: finished or yielded, but the job had been taken over; leaving the row alone.`);
    return;
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
  // The retention scans pass trimmed rows (no peaks/speech), and this saves the whole record: load the
  // full row first so nothing already saved is lost.
  rec = (await store.getRecording(String(rec.id), { fresh: true }).catch(() => null)) || rec;
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
  return (await store.findRecordings(["done"], { light: true }))
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

module.exports = { init, startLocalWorker, enqueue, isBusy, liveRecording, shutdown, updatePanel, deleteRecording, applyRetention, freeUpSpace, buildReport, remux, workerName: WORKER };
