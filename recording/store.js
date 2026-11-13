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
const LIGHT_OUTPUTS =
  "progress:outputs->progress, files:outputs->files, audioDeleted:outputs->audioDeleted, liveTranscript:outputs->liveTranscript";
function rehydrateOutputs(row) {
  if (!row) return row;
  const { progress, files, audioDeleted, liveTranscript, ...rest } = row;
  const outputs = {};
  for (const [k, v] of [["progress", progress], ["files", files], ["audioDeleted", audioDeleted], ["liveTranscript", liveTranscript]]) {
    if (v != null) outputs[k] = v;
  }
  return { ...rest, outputs };
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
  const cols = "id, channel_name, status, started_at, ended_at, speakers, " + LIGHT_OUTPUTS;
  const row = await run("getRecordingLight", () => supabase.from("recordings").select(cols).eq("id", id).maybeSingle());
  if (row) return rehydrateOutputs(row);
  return memory.get(id) || null;
}

// light: trimmed rows for the queue scans and retention (no peaks/speech). They are never cached in
// `memory`, because a row without those blobs must not be written back over the saved one.
async function findRecordings(statuses, { light = false } = {}) {
  const cols = light
    ? "id, status, started_at, ended_at, resume_after, drive_folder_id, claimed_by, claim_expires_at, claim_step, " + LIGHT_OUTPUTS
    : "*";
  const rows = await run("findRecordings", () => supabase.from("recordings").select(cols).in("status", statuses).order("started_at", { ascending: true }), []);
  if (light) return rows.map(rehydrateOutputs);
  for (const r of rows) if (!memory.has(r.id)) memory.set(r.id, r);
  const ids = new Set(rows.map((r) => r.id));
  for (const r of memory.values()) if (statuses.includes(r.status) && !ids.has(r.id)) rows.push(r);
  return rows.map((r) => memory.get(r.id) || r);
}

// Newest first, without the bulky columns
async function listRecordings(limit = 50) {
  const cols = "id, channel_id, channel_name, started_by, started_at, ended_at, end_reason, status, speakers, drive_folder_id, options, " + LIGHT_OUTPUTS;
  const rows = await run("listRecordings", () => supabase.from("recordings").select(cols).not("status", "in", "(deleted,discarded)").order("started_at", { ascending: false }).limit(limit), null);
  if (rows) return rows.map(rehydrateOutputs);
  return [...memory.values()].filter((r) => !["deleted", "discarded"].includes(r.status)).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)).slice(0, limit);
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
async function claimRecording(id, worker, ttlMs, { force = false } = {}) {
  if (!supabase || !hasClaimCols) return true;
  const now = new Date();
  const until = new Date(now.getTime() + ttlMs).toISOString();
  try {
    let q = supabase.from("recordings").update({ claimed_by: worker, claim_expires_at: until }).eq("id", id);
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
  return (await findRecordings(["recording", "suspended"], { light: true })).length > 0;
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
  listRecordings,
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
