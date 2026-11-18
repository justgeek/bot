// recording/store.js - Supabase persistence for recordings (tables are in schema.sql).
// Rows are also kept in memory, so without a database the recorder still works; it just can't resume
// after a restart and its settings go back to the defaults on every start.
const { supabase } = require("../db");

const enabled = !!supabase;
const memory = new Map(); // recording id -> row
const memorySettings = new Map();
const memoryChunks = new Map(); // recording id -> chunk rows

let warnedMissing = false;
function missingTable(error) {
  if (!error || !["42P01", "PGRST205"].includes(error.code)) return false;
  if (!warnedMissing) {
    warnedMissing = true;
    console.warn("[Rec] The recording tables are missing - run schema.sql in Supabase to keep recordings across restarts.");
  }
  return true;
}

async function run(label, query, fallback = null) {
  if (!supabase) return fallback;
  try {
    const { data, error } = await query();
    if (error) {
      if (!missingTable(error)) console.error(`[Rec] ${label} failed:`, error.message || error);
      return fallback;
    }
    return data ?? fallback;
  } catch (err) {
    console.error(`[Rec] ${label} failed:`, err.message || err);
    return fallback;
  }
}

// Writes for one recording run in order (a heartbeat must not overwrite a newer status)
const chains = new Map();
function serialize(key, task) {
  const next = (chains.get(key) || Promise.resolve()).then(task, task);
  chains.set(key, next);
  next.finally(() => chains.get(key) === next && chains.delete(key));
  return next;
}

const ROW_COLUMNS = [
  "id", "guild_id", "channel_id", "channel_name", "started_by", "started_at", "ended_at", "end_reason",
  "status", "heartbeat_at", "suspended_at", "resume_after", "parts", "panel_message_id", "thread_id",
  "options", "events", "speakers", "report", "summary_en", "summary_ar", "drive_folder_id", "outputs", "error",
];
const pick = (rec) => Object.fromEntries(ROW_COLUMNS.filter((k) => rec[k] !== undefined).map((k) => [k, rec[k]]));

// outputs.peaks and outputs.speech are most of a finished recording's row (~230 KB each, 7.9 MB for the
// whole table). The list, the queue scans and the page's fast poll never read them, so those reads ask
// PostgREST for just the parts they use and put the row back together below. Supabase bills egress, so
// this is the difference between a few KB and a few MB per read.
// The live transcript is the one part of a row that grows all night (a 10-hour call is a few hundred KB). The
// list, the scans and the page's 3-second progress poll only need "how far it got" and "how many lines", so
// they ask for those two numbers rather than the whole array. Supabase bills every byte it sends back.
const LIGHT_OUTPUTS =
  "progress:outputs->progress, files:outputs->files, audioDeleted:outputs->audioDeleted, liveUntil:outputs->liveTranscript->untilMs, liveCount:outputs->liveTranscript->count";
const LIGHT_OUTPUTS_WHOLE =
  "progress:outputs->progress, files:outputs->files, audioDeleted:outputs->audioDeleted, liveTranscript:outputs->liveTranscript";
// Not every PostgREST understands a nested JSON path in a select ("outputs->liveTranscript->untilMs"). The first
// time one refuses it, the whole liveTranscript is asked for instead: a little more egress, but the list, the
// queue scans and the page's poll must never come back empty over a select the server doesn't support.
let liveScalarSelect = true;
function rehydrateOutputs(row) {
  if (!row) return row;
  const { progress, files, audioDeleted, liveUntil, liveCount, liveTranscript: wholeLive, ...rest } = row;
  const outputs = {};
  for (const [k, v] of [["progress", progress], ["files", files], ["audioDeleted", audioDeleted]]) {
    if (v != null) outputs[k] = v;
  }
  if (liveUntil != null || liveCount != null) outputs.liveTranscript = { untilMs: Number(liveUntil) || 0, count: Number(liveCount) || 0 };
  else if (wholeLive != null) outputs.liveTranscript = wholeLive;
  return { ...rest, outputs };
}

// An error that means "PostgREST didn't like this select" rather than "the request never got there"
const selectProblem = (error) =>
  /^PGRST1/.test(String(error?.code || "")) ||
  ["42703", "PGRST204"].includes(String(error?.code || "")) ||
  /column|select|json|path|syntax/i.test(String(error?.message || ""));

// One of the trimmed reads: tries the two tiny live-transcript fields, and the whole liveTranscript only if this
// Supabase refuses the nested path. Returns null when there is no answer at all (the caller keeps its old
// behaviour then); an empty result is [] (or null for `single`).
async function runLight(label, build, { single = false } = {}) {
  if (!supabase) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const trimmed = liveScalarSelect;
    try {
      const { data, error } = await build(trimmed ? LIGHT_OUTPUTS : LIGHT_OUTPUTS_WHOLE);
      if (!error) return single ? data ?? null : data ?? [];
      if (!missingTable(error)) console.error(`[Rec] ${label} failed:`, error.message || error);
      if (attempt === 0 && trimmed && selectProblem(error)) {
        liveScalarSelect = false;
        console.warn(
          "[Rec] This Supabase doesn't accept the trimmed live-transcript select (outputs->liveTranscript->untilMs); " +
            "reading the whole liveTranscript from now on (a bit more egress, nothing missing)."
        );
        continue;
      }
      return null;
    } catch (err) {
      console.error(`[Rec] ${label} failed:`, err.message || err);
      return null;
    }
  }
  return null;
}

// ---------- Recordings ----------
function saveRecording(rec) {
  memory.set(rec.id, rec);
  const row = pick(rec);
  return serialize(rec.id, () => run("saveRecording", () => supabase.from("recordings").upsert(row)));
}

async function getRecording(id, { fresh = false } = {}) {
  if (!fresh && memory.has(id)) return memory.get(id);
  const row = await run("getRecording", () => supabase.from("recordings").select("*").eq("id", id).maybeSingle());
  if (row) memory.set(id, row);
  return row || memory.get(id) || null;
}

// Status and progress only, for the recordings page poll that runs every few seconds. Deliberately not
// put in `memory`: a trimmed row must never be saved back over the audio blobs.
async function getRecordingLight(id) {
  const row = await runLight(
    "getRecordingLight",
    (live) => supabase.from("recordings").select(`id, channel_name, status, started_at, ended_at, speakers, ${live}`).eq("id", id).maybeSingle(),
    { single: true }
  );
  if (row) return rehydrateOutputs(row);
  return memory.get(id) || null;
}

// Everything the recordings page draws (transcript, speakers, events, summaries, the live transcript) but not
// the waveform: outputs.peaks is up to ~210 KB on a long recording and only /peaks needs it, so a page view
// that took the whole row downloaded it every time for nothing.
const VIEW_COLUMNS =
  "id, guild_id, channel_id, channel_name, started_by, started_at, ended_at, end_reason, parts, panel_message_id, thread_id, " +
  "status, options, events, speakers, report, summary_en, summary_ar, drive_folder_id, error, " +
  "progress:outputs->progress, files:outputs->files, audioDeleted:outputs->audioDeleted, aliases:outputs->aliases, " +
  "speech:outputs->speech, botSpeech:outputs->botSpeech, liveTranscript:outputs->liveTranscript";
const VIEW_PARTS = ["progress", "files", "audioDeleted", "aliases", "speech", "botSpeech", "liveTranscript"];
function rehydrateView(row) {
  if (!row) return row;
  const rest = { ...row };
  const outputs = {};
  for (const k of VIEW_PARTS) {
    if (rest[k] != null) outputs[k] = rest[k];
    delete rest[k];
  }
  return { ...rest, outputs };
}
async function getRecordingView(id) {
  const row = await run("getRecordingView", () => supabase.from("recordings").select(VIEW_COLUMNS).eq("id", id).maybeSingle());
  if (row) return rehydrateView(row);
  return memory.get(id) || null; // a network blip: the copy from earlier is better than nothing
}

// The little a job running on this recording needs from the database: did another copy change the status or a
// step? Its speech map, its tracks and the live transcript are already in memory (read once when the job
// started), so they aren't asked for again before every step. That used to be six whole rows per job.
const SYNC_COLUMNS = "id, status, options, resume_after, report, summary_en, summary_ar, progress:outputs->progress, files:outputs->files, posted:outputs->posted, audioDeleted:outputs->audioDeleted";
async function getRecordingSync(id) {
  const row = await run("getRecordingSync", () => supabase.from("recordings").select(SYNC_COLUMNS).eq("id", id).maybeSingle());
  if (!row) return null;
  const { progress, files, posted, audioDeleted, ...rest } = row;
  const outputs = {};
  for (const [k, v] of [["progress", progress], ["files", files], ["posted", posted], ["audioDeleted", audioDeleted]]) {
    if (v != null) outputs[k] = v;
  }
  return { ...rest, outputs };
}

// Streaming one file needs its Drive id and nothing else (the row also carries the whole waveform)
async function getRecordingAudio(id) {
  const row = await run("getRecordingAudio", () =>
    supabase.from("recordings").select("id, files:outputs->files, audioDeleted:outputs->audioDeleted").eq("id", id).maybeSingle()
  );
  if (!row) return memory.get(id) || null;
  const outputs = {};
  if (row.files != null) outputs.files = row.files;
  if (row.audioDeleted != null) outputs.audioDeleted = row.audioDeleted;
  return { id: row.id, outputs };
}

// The waveform itself, for the player
async function getRecordingPeaks(id) {
  const row = await run("getRecordingPeaks", () =>
    supabase
      .from("recordings")
      .select("id, started_at, ended_at, peaks:outputs->peaks, files:outputs->files, audioDeleted:outputs->audioDeleted")
      .eq("id", id)
      .maybeSingle()
  );
  if (!row) return memory.get(id) || null;
  const { peaks, files, audioDeleted, ...rest } = row;
  const outputs = {};
  if (peaks != null) outputs.peaks = peaks;
  if (files != null) outputs.files = files;
  if (audioDeleted != null) outputs.audioDeleted = audioDeleted;
  return { ...rest, outputs };
}

// Status and claim only, for the queue when a claim is refused: is another copy on it, or is there nothing left
// to do on it at all?
async function getRecordingState(id) {
  return run("getRecordingState", () => supabase.from("recordings").select("id, status, claimed_by, claim_expires_at").eq("id", id).maybeSingle());
}

// light: trimmed rows for the queue scans and retention (no peaks/speech). They are never cached in
// `memory`, because a row without those blobs must not be written back over the saved one.
// scan: status and claim only, for the "is there something to process" polls that run every 30 s. The live
// transcript and the file list grow all night, so reading them on every poll is megabytes of egress a day.
const SCAN_COLUMNS = "id, status, started_at, resume_after, claimed_by, claim_expires_at, claim_step";
async function findRecordings(statuses, { light = false, scan = false } = {}) {
  if (scan) {
    const rows = await run("findRecordings", () => supabase.from("recordings").select(SCAN_COLUMNS).in("status", statuses).order("started_at", { ascending: true }), []);
    return rows.map((r) => ({ ...r, outputs: {} }));
  }
  if (light) {
    const rows = await runLight("findRecordings", (live) =>
      supabase
        .from("recordings")
        .select(`id, status, started_at, ended_at, resume_after, drive_folder_id, claimed_by, claim_expires_at, claim_step, ${live}`)
        .in("status", statuses)
        .order("started_at", { ascending: true })
    );
    return (rows || []).map(rehydrateOutputs);
  }
  const rows = await run("findRecordings", () => supabase.from("recordings").select("*").in("status", statuses).order("started_at", { ascending: true }), []);
  for (const r of rows) if (!memory.has(r.id)) memory.set(r.id, r);
  const ids = new Set(rows.map((r) => r.id));
  for (const r of memory.values()) if (statuses.includes(r.status) && !ids.has(r.id)) rows.push(r);
  return rows.map((r) => memory.get(r.id) || r);
}

// Newest first, without the bulky columns
async function listRecordings(limit = 50) {
  const rows = await runLight("listRecordings", (live) =>
    supabase
      .from("recordings")
      .select(`id, channel_id, channel_name, started_by, started_at, ended_at, end_reason, status, speakers, drive_folder_id, options, claimed_by, claim_expires_at, ${live}`)
      .not("status", "in", "(deleted,discarded)")
      .order("started_at", { ascending: false })
      .limit(limit)
  );
  if (rows) return rows.map(rehydrateOutputs);
  return [...memory.values()].filter((r) => !["deleted", "discarded"].includes(r.status)).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)).slice(0, limit);
}

// Which recording, when, in which channel: what a result list or an answer's source line needs. Reading the
// whole row for each hit (a search returns up to 50) used to pull in every waveform it touched.
async function getRecordingHeads(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  const map = new Map();
  if (!uniq.length) return map;
  const rows = await run(
    "getRecordingHeads",
    () => supabase.from("recordings").select("id, channel_name, started_at").in("id", uniq),
    []
  );
  for (const r of rows) map.set(r.id, r);
  for (const id of uniq) if (!map.has(id) && memory.has(id)) map.set(id, memory.get(id));
  return map;
}

async function recentSummaries(sinceIso) {
  const rows = await run("recentSummaries", () => supabase.from("recordings").select("id, channel_name, started_at, ended_at, summary_en, speakers").gte("started_at", sinceIso).not("summary_en", "is", null).order("started_at", { ascending: false }).limit(60), null);
  if (rows) return rows;
  return [...memory.values()].filter((r) => r.summary_en && r.started_at >= sinceIso);
}

// ---------- Chunk files (raw audio while recording) ----------
async function saveChunk(recordingId, c) {
  const row = { recording_id: recordingId, user_id: c.userId, start_ms: c.startMs, part: c.part, bytes: c.bytes, drive_file_id: c.driveFileId || null };
  const list = memoryChunks.get(recordingId) || [];
  const i = list.findIndex((x) => x.user_id === row.user_id && x.start_ms === row.start_ms);
  if (i >= 0) list[i] = { ...list[i], ...row };
  else list.push(row);
  memoryChunks.set(recordingId, list);
  await run("saveChunk", () => supabase.from("recording_chunks").upsert(row));
}

async function getChunks(recordingId) {
  const rows = await run("getChunks", () => supabase.from("recording_chunks").select("*").eq("recording_id", recordingId).order("start_ms", { ascending: true }), null);
  const mem = memoryChunks.get(recordingId) || [];
  if (!rows) return mem;
  // Rows saved in this process win (they may know a local file the database doesn't)
  const key = (r) => `${r.user_id}:${r.start_ms}`;
  const merged = new Map(rows.map((r) => [key(r), r]));
  for (const r of mem) merged.set(key(r), { ...merged.get(key(r)), ...r });
  return [...merged.values()].sort((a, b) => a.start_ms - b.start_ms);
}

async function deleteChunks(recordingId) {
  memoryChunks.delete(recordingId);
  await run("deleteChunks", () => supabase.from("recording_chunks").delete().eq("recording_id", recordingId));
}

// ---------- Who is processing a recording ----------
// The bot runs on Heroku and, sometimes, a copy of the processor runs on a PC (worker.js). Both see the same
// rows, so one recording is only worked on by the copy holding its claim. The claim is renewed while it works
// and is free again once it expires (a restarted dyno, a closed laptop, a killed process), so the other copy
// picks the job up where it stopped. Without the columns (an older schema.sql) there is nothing to coordinate
// with, and each copy works on its own.
let hasClaimCols = true;
function claimColsMissing(error) {
  if (!hasClaimCols || !error || !["42703", "PGRST204"].includes(error.code)) return false;
  if (!/claimed_by|claim_expires_at|claim_step/.test(String(error.message || ""))) return false;
  hasClaimCols = false;
  console.warn("[Rec] recordings.claimed_by is missing - run schema.sql, or two copies of the bot can process the same recording.");
  return true;
}

// Takes the job if nobody (or nobody still alive) has it. true when this copy may work on it.
// anyStatus: a worker on a PC taking its own job back also claims one that is still "recording"/"suspended" by
// a stale row - it only refuses a finished, deleted or discarded one.
async function claimRecording(id, worker, ttlMs, { force = false, anyStatus = false } = {}) {
  if (!supabase || !hasClaimCols) return true;
  const now = new Date();
  const until = new Date(now.getTime() + ttlMs).toISOString();
  try {
    // Never a finished/deleted recording: a copy that lost the job must not pull it back after another copy
    // already finished it
    let q = supabase.from("recordings").update({ claimed_by: worker, claim_expires_at: until }).eq("id", id);
    q = anyStatus ? q.not("status", "in", "(done,deleted,discarded)") : q.in("status", ["processing", "paused"]);
    // Someone else's claim counts only while it's still being renewed
    if (!force) q = q.or(`claim_expires_at.is.null,claim_expires_at.lt.${now.toISOString()}`);
    const { data, error } = await q.select("id");
    if (error) {
      if (claimColsMissing(error)) return true;
      console.error("[Rec] Claiming the recording failed:", error.message || error);
      return false;
    }
    return (data || []).length > 0;
  } catch (err) {
    console.error("[Rec] Claiming the recording failed:", err.message || err);
    return false;
  }
}

// Still ours? Renewing is also the heartbeat that keeps the other copy off the job. True when there's no
// database (or it blips: a lost connection must never throw away work in progress).
async function renewClaim(id, worker, ttlMs, step = null) {
  if (!supabase || !hasClaimCols) return true;
  const until = new Date(Date.now() + ttlMs).toISOString();
  try {
    const { data, error } = await supabase
      .from("recordings")
      .update({ claim_expires_at: until, ...(step ? { claim_step: step } : {}) })
      .eq("id", id)
      .eq("claimed_by", worker)
      .select("id");
    if (error) {
      if (claimColsMissing(error)) return true;
      console.warn("[Rec] Renewing the claim failed (carrying on):", error.message || error);
      return true;
    }
    return (data || []).length > 0;
  } catch (err) {
    console.warn("[Rec] Renewing the claim failed (carrying on):", err.message || err);
    return true;
  }
}

async function releaseClaim(id, worker) {
  if (!supabase || !hasClaimCols) return;
  await run("releaseClaim", () =>
    supabase.from("recordings").update({ claimed_by: null, claim_expires_at: null, claim_step: null }).eq("id", id).eq("claimed_by", worker)
  );
}

// ---------- Which processors are around ----------
// A worker on a PC writes a heartbeat here; the bot on Heroku reads it to give that worker first go at a job.
async function setProcessorBeat(value) {
  memorySettings.set("processor", value);
  if (!supabase) return;
  try {
    const { error } = await supabase.from("bot_settings").upsert({ key: "processor", value, updated_at: new Date().toISOString() });
    if (error && !missingTable(error)) console.error("[Rec] setProcessorBeat failed:", error.message || error);
  } catch (err) {
    console.error("[Rec] setProcessorBeat failed:", err.message || err);
  }
}

// Straight from the database: what matters is another machine's write, not this process's memory
async function getProcessorBeat() {
  const row = await run("getProcessorBeat", () => supabase.from("bot_settings").select("value").eq("key", "processor").maybeSingle());
  return row?.value || null;
}

// A recording is going on right now (or a suspended one may still resume)
async function liveRecordingExists() {
  return (await findRecordings(["recording", "suspended"], { scan: true })).length > 0;
}

// ---------- Settings ----------
async function getSetting(key, fallback) {
  const row = await run("getSetting", () => supabase.from("bot_settings").select("value").eq("key", key).maybeSingle());
  if (row) memorySettings.set(key, row.value);
  return memorySettings.has(key) ? { ...fallback, ...memorySettings.get(key) } : { ...fallback };
}

async function setSetting(key, value) {
  memorySettings.set(key, value);
  await run("setSetting", () => supabase.from("bot_settings").upsert({ key, value, updated_at: new Date().toISOString() }));
}

// ---------- Transcript lines (search) ----------
async function replaceLines(recordingId, lines) {
  if (!supabase) return;
  await run("deleteLines", () => supabase.from("recording_lines").delete().eq("recording_id", recordingId));
  for (let i = 0; i < lines.length; i += 500) {
    const batch = lines.slice(i, i + 500).map((l) => ({ recording_id: recordingId, ...l }));
    await run("insertLines", () => supabase.from("recording_lines").insert(batch));
  }
}

async function getLines(recordingId) {
  const out = [];
  for (let from = 0; from < 200000; from += 1000) {
    const rows = await run("getLines", () => supabase.from("recording_lines").select("start_ms, end_ms, user_id, name, text").eq("recording_id", recordingId).order("start_ms", { ascending: true }).range(from, from + 999), []);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// norm: text already passed through normalizeText(); every word must appear
async function searchLines(normWords, limit = 5, recordingId = null) {
  const words = normWords.filter(Boolean).slice(0, 6);
  if (!words.length) return [];
  return run("searchLines", () => {
    let q = supabase.from("recording_lines").select("recording_id, start_ms, end_ms, user_id, name, text");
    for (const w of words) q = q.ilike("norm", `%${w.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    if (recordingId) q = q.eq("recording_id", recordingId);
    return q.order("id", { ascending: false }).limit(limit);
  }, []);
}

async function deleteLines(recordingId) {
  await run("deleteLines", () => supabase.from("recording_lines").delete().eq("recording_id", recordingId));
}

module.exports = {
  enabled,
  saveRecording,
  getRecording,
  findRecordings,
  getRecordingLight,
  getRecordingView,
  getRecordingSync,
  getRecordingAudio,
  getRecordingPeaks,
  getRecordingState,
  listRecordings,
  getRecordingHeads,
  recentSummaries,
  saveChunk,
  getChunks,
  deleteChunks,
  claimRecording,
  renewClaim,
  releaseClaim,
  setProcessorBeat,
  getProcessorBeat,
  liveRecordingExists,
  getSetting,
  setSetting,
  replaceLines,
  getLines,
  searchLines,
  deleteLines,
};
