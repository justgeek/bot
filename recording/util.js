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

// Gemini's free daily quota is used up: the job waits until `until` (ms) and continues by itself
class QuotaPause extends Error {
  constructor(step, until) {
    super(`Gemini daily quota reached (${step})`);
    this.step = step;
    this.until = until;
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

// The recording's Drive folder: "2026-10-16 21.56 → 23.40", or "2026-10-16 21.56 → 2026-10-17 03.42" past
// midnight (server clock). While it's still recording the end is "…"; processing renames it once it's over.
function folderName(rec) {
  const start = localStamp(Date.parse(rec.started_at));
  if (!rec.ended_at) return `${start} → …`;
  const end = localStamp(Date.parse(rec.ended_at));
  return `${start} → ${end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end}`;
}

function threadName(rec) {
  return `🎙️ ${localStamp(Date.parse(rec.started_at))} · ${rec.channel_name || "Voice"}`.slice(0, 100);
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

// Next reset of Gemini's per-day quota (midnight Pacific time), plus a little slack
function nextQuotaReset() {
  const la = makeTz("America/Los_Angeles", 0);
  return la.startOfDate(la.addDays(la.dateOf(Date.now()), 1)) + 2 * 60000;
}

module.exports = { WORK_DIR, sleep, UserError, QuotaPause, newId, localStamp, folderName, threadName, safeName, isAdmin, memberName, nextQuotaReset };
