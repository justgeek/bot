// recording/util.js - small helpers shared by the recorder's modules.
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { PermissionFlagsBits } = require("discord.js");
const { IDs } = require("../config");
const { makeTz, DEFAULT_TZ } = require("../tz");

// Working files (raw chunks, encodes) - on Heroku this disk is wiped on restart, Drive holds the real copies
const WORK_DIR = process.env.RECORDINGS_DIR || path.join(os.tmpdir(), "banha-recordings");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A message meant for the person who clicked/typed, not a bug
class UserError extends Error {}

// The job isn't this copy's anymore (another copy of the bot took it over, or someone finished it): stop
// quietly, without writing over what that copy saved.
class JobStopped extends Error {}

// Gemini's free daily quota is used up: the job waits until `until` (ms) and continues by itself
class QuotaPause extends Error {
  constructor(step, until, detail) {
    super(`Gemini daily quota reached (${step})`);
    this.step = step;
    this.until = until;
    this.detail = detail || `Gemini's free limit is used up - tries again by itself <t:${Math.floor(until / 1000)}:R>`;
  }
}

// Google's side was too busy or unreachable (503, timeout, reset connection): the step waits a few minutes
// and is tried again by itself, as often as it takes - nothing for anyone to press
class BusyPause extends QuotaPause {
  constructor(step, until, why) {
    super(step, until);
    this.message = `Gemini was busy or unreachable (${step}): ${String(why || "").slice(0, 200)}`;
    this.detail = `Gemini is busy or unreachable - tries again by itself <t:${Math.floor(until / 1000)}:R>`;
  }
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function newId(length = 12) {
  let id = "";
  for (const b of crypto.randomBytes(length)) id += B62[b % 62];
  return id;
}

const pad = (n) => String(n).padStart(2, "0");
const serverClock = makeTz(DEFAULT_TZ, 0);
// "2026-10-16 21.56" on the server clock (Cairo)
function localStamp(ms) {
  const p = serverClock.partsOf(ms);
  return `${p.date} ${pad(p.hour)}.${pad(p.minute)}`;
}

// The recording's Drive folder: "2026-10-16 21.56 -> 23.40", or "2026-10-16 21.56 -> 2026-10-17 03.42" past
// midnight (server clock). While it's still recording the end is "..."; processing renames it once it's over.
function folderName(rec) {
  const start = localStamp(Date.parse(rec.started_at));
  if (!rec.ended_at) return `${start} \u2192 \u2026`;
  const end = localStamp(Date.parse(rec.ended_at));
  return `${start} \u2192 ${end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end}`;
}

function threadName(rec) {
  return `\uD83C\uDF99\uFE0F ${localStamp(Date.parse(rec.started_at))} \u00B7 ${rec.channel_name || "Voice"}`.slice(0, 100);
}

// Safe for file names on Drive and on disk
function safeName(name) {
  return String(name || "unknown").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().slice(0, 60) || "unknown";
}

const isAdmin = (member) => !!member && (member.id === IDs.Moonscarlet || !!member.permissions?.has?.(PermissionFlagsBits.ManageGuild));

function memberName(guild, userId) {
  const m = guild?.members.cache.get(userId);
  return m?.displayName || m?.user?.username || guild?.client.users.cache.get(userId)?.username || String(userId);
}

// Everyone who took part: who talked, plus who only played TTS/memes through the bot (their "bot-<id>" track)
// -> { userId: { name, speaking_ms, sound_ms } }
function participants(rec) {
  const out = {};
  for (const [key, s] of Object.entries(rec.speakers || {})) {
    const sounds = key.startsWith("bot-");
    if (s.bot && !sounds) continue; // "bot": the automatic announcements
    const id = sounds ? key.slice(4) : key;
    const p = out[id] || (out[id] = { name: null, speaking_ms: 0, sound_ms: 0 });
    if (sounds) p.sound_ms += s.speaking_ms || 0;
    else p.speaking_ms += s.speaking_ms || 0;
    if (!sounds || !p.name) p.name = sounds ? String(s.name || "").replace(/ \(bot sounds\)$/, "") || null : s.name || p.name;
  }
  return out;
}

// Next reset of Gemini's per-day quota (midnight Pacific time), plus a little slack
function nextQuotaReset() {
  const la = makeTz("America/Los_Angeles", 0);
  return la.startOfDate(la.addDays(la.dateOf(Date.now()), 1)) + 2 * 60000;
}

// When a quota-paused job tries again: in an hour, or at the daily reset if that comes sooner
function quotaRetryAt() {
  return Math.min(Date.now() + 60 * 60000, nextQuotaReset());
}

// When a job paused because Google was busy comes back to the step it was on.
// Consecutive busy pauses for the same recording back off: 5 min, 10, 20, 30 (capped),
// so a recording that keeps hitting 503s doesn't hammer the API every 10 min forever.
const busyPauseCount = new Map(); // recId -> consecutive count; cleared when a step completes cleanly
function busyRetryAt(recId) {
  const n = recId ? (busyPauseCount.get(recId) || 0) + 1 : 1;
  if (recId) busyPauseCount.set(recId, n);
  const minutes = Math.min(30, 5 * Math.pow(2, n - 1)); // 5, 10, 20, 30, 30, ...
  return Date.now() + minutes * 60000;
}
function resetBusyCount(recId) { if (recId) busyPauseCount.delete(recId); }

// A step that stops making progress (a download or an ffmpeg run that hangs) would hold the job forever:
// after `stallMs` with nothing happening it's given up on and the step is started again by itself.
// Use a shorter stallMs for steps that pulse frequently (audio chunk downloads), so a single hung
// operation doesn't prevent the watchdog from ever firing.
function watchStep(promise, step, { stallMs = 20 * 60000, everyMs = 30000, beat, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new JobStopped("another copy of the bot is processing this recording"));
    const start = Date.now();
    let stream = null;
    const cleanup = () => {
      if (stream) clearInterval(stream);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason || new JobStopped("another copy of the bot is processing this recording"));
    };
    if (signal?.addEventListener) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    stream = setInterval(() => {
      // beat() is the timestamp of the last meaningful progress event; use start if no beat provided
      const lastBeat = beat ? beat() : start;
      if (Date.now() - lastBeat < stallMs) return;
      cleanup();
      const until = busyRetryAt(); // processor.js drives the per-recording escalation via its own recId calls
      reject(new QuotaPause(step, until, `Stuck with no progress for ${stallMs / 60000} min - starts this step again by itself <t:${Math.floor(until / 1000)}:R>`));
    }, everyMs);
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (err) => { cleanup(); reject(err); }
    );
  });
}

module.exports = { WORK_DIR, sleep, UserError, JobStopped, QuotaPause, BusyPause, watchStep, resetBusyCount, newId, localStamp, folderName, threadName, safeName, isAdmin, memberName, participants, nextQuotaReset, quotaRetryAt, busyRetryAt };