// db.js - Supabase logging for voice sessions and member status changes.
const { createClient } = require("@supabase/supabase-js");
const { IDs } = require("./config");

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
if (typeof globalThis.WebSocket === "undefined") {
  try {
    clientOptions.realtime = { transport: require("ws") };
  } catch {
    console.warn("[DB] No global WebSocket and the 'ws' package is missing. Run: npm i ws");
  }
}

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, clientOptions)
    : null;

if (!supabase) {
  console.warn("[DB] SUPABASE_URL / SUPABASE_KEY not set - database logging is disabled.");
}

const UNTRACKED_CHANNELS = new Set([IDs.voice2]);
const isTrackedChannel = (channelId) => !UNTRACKED_CHANNELS.has(channelId);

function isAfkChannel(channelId, channelName, client) {
  if (client) {
    const guild = client.guilds?.cache.get(IDs.guild);
    if (guild && guild.afkChannelId && guild.afkChannelId === channelId) return true;
    const ch = guild?.channels.cache.get(channelId);
    if (ch && /\bafk\b/i.test(ch.name)) return true;
  }
  if (channelName && /\bafk\b/i.test(channelName)) return true;
  if (IDs.voiceAFK && channelId === IDs.voiceAFK && IDs.voiceAFK !== IDs.voice3 && IDs.voiceAFK !== IDs.voice1) return true;
  return false;
}

const chains = new Map();
function serialize(key, task) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(task);
  chains.set(key, next);
  next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
}

// ---------- Writes ----------
async function logPresence(userId, username, status, displayName) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from("presence_logs").insert({
      user_id: String(userId),
      username,
      display_name: displayName || null,
      status,
    });
    if (error) throw error;
  } catch (err) {
    console.error("[DB] logPresence failed:", err.message || err);
  }
}

async function _endVoiceSession(userId) {
  if (!supabase) return;
  try {
    const { error } = await supabase.rpc("end_voice_session", { p_user_id: String(userId) });
    if (error) throw error;
  } catch (err) {
    console.error("[DB] endVoiceSession failed:", err.message || err);
  }
}

async function _startVoiceSession(userId, username, channelId, channelName, displayName) {
  if (!supabase) return;
  try {
    await _endVoiceSession(userId);
    const { error } = await supabase.from("voice_sessions").insert({
      user_id: String(userId),
      username,
      display_name: displayName || null,
      channel_id: String(channelId),
      channel_name: channelName || null,
      left_at: null,
    });
    if (error) throw error;
  } catch (err) {
    console.error("[DB] startVoiceSession failed:", err.message || err);
  }
}

const endVoiceSession = (userId) =>
  serialize(String(userId), () => _endVoiceSession(userId));

const startVoiceSession = (userId, username, channelId, channelName, displayName) =>
  serialize(String(userId), () =>
    _startVoiceSession(userId, username, channelId, channelName, displayName)
  );

async function reconcileVoiceSessions(client) {
  if (!supabase) return;
  try {
    const guild = client.guilds.cache.get(IDs.guild);
    if (!guild) return;

    const current = new Map();
    guild.voiceStates.cache.forEach((vs) => {
      const user = vs.member?.user;
      if (!vs.channelId || !user || user.bot || !isTrackedChannel(vs.channelId)) return;
      current.set(vs.id, {
        channelId: vs.channelId,
        username: user.username,
        displayName: vs.member.displayName,
        channelName: vs.channel?.name,
      });
    });

    const { data: open, error } = await supabase
      .from("voice_sessions")
      .select("user_id, channel_id")
      .is("left_at", null);
    if (error) throw error;

    const stillValid = new Set();
    for (const row of open || []) {
      const now = current.get(row.user_id);
      if (now && now.channelId === row.channel_id) stillValid.add(row.user_id);
      else await endVoiceSession(row.user_id);
    }

    for (const [userId, info] of current) {
      if (!stillValid.has(userId)) {
        await startVoiceSession(userId, info.username, info.channelId, info.channelName, info.displayName);
      }
    }
    console.log(`[DB] Voice sessions reconciled (${current.size} user(s) in voice).`);
  } catch (err) {
    console.error("[DB] reconcileVoiceSessions failed:", err.message || err);
  }
}

// ---------- Reads ----------
const PAGE = 1000;
const MAX_ROWS = 50000;
async function fetchAll(makeQuery) {
  const rows = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

async function getSessionRows(sinceIso, untilIso) {
  if (!supabase) return { rows: [], truncated: false };
  try {
    return await fetchAll(() => {
      let q = supabase
        .from("voice_sessions")
        .select("id, user_id, username, display_name, channel_id, channel_name, joined_at, left_at")
        .order("id", { ascending: true });
      if (sinceIso) q = q.or(`left_at.is.null,left_at.gte.${sinceIso}`);
      if (untilIso) q = q.lte("joined_at", untilIso);
      return q;
    });
  } catch (err) {
    console.error("[DB] getSessionRows failed:", err.message || err);
    return { rows: [], truncated: false };
  }
}

async function getPresenceRows(sinceIso, untilIso) {
  if (!supabase) return { rows: [], truncated: false };
  try {
    return await fetchAll(() => {
      let q = supabase
        .from("presence_logs")
        .select("id, user_id, username, display_name, status, changed_at")
        .order("id", { ascending: true });
      if (sinceIso) q = q.gte("changed_at", sinceIso);
      if (untilIso) q = q.lte("changed_at", untilIso);
      return q;
    });
  } catch (err) {
    console.error("[DB] getPresenceRows failed:", err.message || err);
    return { rows: [], truncated: false };
  }
}

// Computes true wall-clock channel occupancy (union of overlapping intervals)
function unionIntervals(intervals) {
  if (!intervals.length) return 0;
  intervals.sort((a, b) => a[0] - b[0]);
  let totalSecs = 0;
  let curStart = intervals[0][0];
  let curEnd = intervals[0][1];

  for (let i = 1; i < intervals.length; i++) {
    const [s, e] = intervals[i];
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      totalSecs += Math.max(0, Math.round((curEnd - curStart) / 1000));
      curStart = s;
      curEnd = e;
    }
  }
  totalSecs += Math.max(0, Math.round((curEnd - curStart) / 1000));
  return totalSecs;
}

async function getTotalVoiceSeconds(excludeAfk = false, client = null) {
  if (!supabase) return 0;
  try {
    const { rows } = await getSessionRows(null, null);
    const now = Date.now();
    const intervals = [];
    for (const r of rows) {
      if (excludeAfk && isAfkChannel(r.channel_id, r.channel_name, client)) continue;
      const start = Date.parse(r.joined_at);
      const end = r.left_at ? Date.parse(r.left_at) : now;
      if (end > start) intervals.push([start, end]);
    }
    return unionIntervals(intervals);
  } catch (err) {
    console.error("[DB] getTotalVoiceSeconds failed:", err.message || err);
    return 0;
  }
}

async function getVoiceLeaderboard(days = null, limit = 10) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.rpc("voice_leaderboard", {
      p_days: days,
      p_limit: limit,
    });
    if (error) throw error;
    return (data || []).map((r) => {
      const total_seconds = Number(r.secs) || 0;
      return {
        username: r.uname,
        display_name: r.dname || r.uname,
        user_id: r.uid,
        total_seconds,
        total_hours: Math.round((total_seconds / 3600) * 100) / 100,
      };
    });
  } catch (err) {
    console.error("[DB] getVoiceLeaderboard failed:", err.message || err);
    return [];
  }
}

async function getRecentLogs(limit = 30, opts = {}) {
  if (!supabase) return [];
  const { userId, channelId, status, sinceIso, untilIso } = opts;
  let kind = opts.kind || "all";
  try {
    let wantPresence = kind === "all" || kind === "presence";
    let wantVoice = kind === "all" || kind === "voice";
    if (status) wantVoice = false;
    if (channelId) wantPresence = false;
    const none = Promise.resolve({ data: [], error: null });
    const window = (q, col) => {
      if (sinceIso) q = q.gte(col, sinceIso);
      if (untilIso) q = q.lte(col, untilIso);
      return q;
    };

    const presenceQ = wantPresence
      ? (() => {
        let q = supabase
          .from("presence_logs")
          .select("id, user_id, username, display_name, status, changed_at")
          .order("changed_at", { ascending: false })
          .limit(limit);
        if (userId) q = q.eq("user_id", userId);
        if (status) q = q.eq("status", status);
        return window(q, "changed_at");
      })()
      : none;
    const joinsQ = wantVoice
      ? (() => {
        let q = supabase
          .from("voice_sessions")
          .select("id, user_id, username, display_name, channel_name, joined_at")
          .order("joined_at", { ascending: false })
          .limit(limit);
        if (userId) q = q.eq("user_id", userId);
        if (channelId) q = q.eq("channel_id", channelId);
        return window(q, "joined_at");
      })()
      : none;
    const leavesQ = wantVoice
      ? (() => {
        let q = supabase
          .from("voice_sessions")
          .select("id, user_id, username, display_name, channel_name, left_at, duration_seconds")
          .not("left_at", "is", null)
          .order("left_at", { ascending: false })
          .limit(limit);
        if (userId) q = q.eq("user_id", userId);
        if (channelId) q = q.eq("channel_id", channelId);
        return window(q, "left_at");
      })()
      : none;

    const [presence, joins, leaves] = await Promise.all([presenceQ, joinsQ, leavesQ]);
    for (const r of [presence, joins, leaves]) if (r.error) throw r.error;

    const events = [
      ...presence.data.map((r) => ({ id: r.id, type: "presence", user_id: r.user_id, username: r.username, display_name: r.display_name, status: r.status, at: r.changed_at })),
      ...joins.data.map((r) => ({ id: r.id, type: "voice_join", user_id: r.user_id, username: r.username, display_name: r.display_name, channel_name: r.channel_name, at: r.joined_at })),
      ...leaves.data.map((r) => ({ id: r.id, type: "voice_leave", user_id: r.user_id, username: r.username, display_name: r.display_name, channel_name: r.channel_name, duration_seconds: r.duration_seconds, at: r.left_at })),
    ];

    events.sort((a, b) => new Date(b.at) - new Date(a.at) || (Number(b.id) || 0) - (Number(a.id) || 0));
    return events.slice(0, limit);
  } catch (err) {
    console.error("[DB] getRecentLogs failed:", err.message || err);
    return [];
  }
}

module.exports = {
  isTrackedChannel,
  isAfkChannel,
  logPresence,
  startVoiceSession,
  endVoiceSession,
  reconcileVoiceSessions,
  getSessionRows,
  getPresenceRows,
  getTotalVoiceSeconds,
  getVoiceLeaderboard,
  getRecentLogs,
};