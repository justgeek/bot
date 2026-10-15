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

// ---------- Writes ----------
// presence_logs.devices (each app with its status, see splitDevices) is added by schema.sql;
// until it exists, presence is logged and read without it.
let hasDevicesCol = true;
function devicesColMissing(error) {
  if (!hasDevicesCol || !error || !["42703", "PGRST204"].includes(error.code) || !String(error.message || "").includes("devices")) return false;
  hasDevicesCol = false;
  console.warn("[DB] presence_logs.devices is missing - run schema.sql to record which device members are on.");
  return true;
}

async function logPresence(userId, username, status, displayName, devices = "") {
  if (!supabase) return;
  try {
    const row = { user_id: String(userId), username, display_name: displayName || null, status };
    if (hasDevicesCol) row.devices = devices || null;
    let { error } = await supabase.from("presence_logs").insert(row);
    if (error && devicesColMissing(error)) {
      delete row.devices;
      ({ error } = await supabase.from("presence_logs").insert(row));
    }
    if (error) throw error;
  } catch (err) {
    console.error("[DB] logPresence failed:", err.message || err);
  }
}

// Stream / muted / deafened time live in columns added by schema.sql. Until that has been run,
// carry on without whichever of them is missing.
const EXTRA_KINDS = ["streaming", "muted", "deafened"];
// "devices" = which Discord app(s) they joined voice from, e.g. "mobile" or "desktop,web"
const extraCols = new Set([...EXTRA_KINDS.map((k) => k + "_seconds"), "devices"]);
const isMissingColumn = (error) => !!error && (error.code === "42703" || error.code === "PGRST204");
// true when the error was about one of the optional columns (which is then dropped, so a retry can work)
function dropMissingCol(error) {
  if (!isMissingColumn(error)) return false;
  const col = [...extraCols].find((c) => String(error.message || "").includes(c));
  if (!col) return false;
  extraCols.delete(col);
  console.warn(`[DB] voice_sessions.${col} is missing - run schema.sql to record it.`);
  return true;
}

// extras: { streaming, muted, deafened } seconds for the member's open session
async function writeExtras(userId, extras) {
  if (!supabase || !extras) return;
  for (let attempt = 0; attempt <= EXTRA_KINDS.length; attempt++) {
    const patch = {};
    for (const k of EXTRA_KINDS) {
      const secs = parseInt(extras[k], 10) || 0;
      if (secs > 0 && extraCols.has(k + "_seconds")) patch[k + "_seconds"] = secs;
    }
    if (!Object.keys(patch).length) return;
    const { error } = await supabase.from("voice_sessions").update(patch).eq("user_id", String(userId)).is("left_at", null);
    if (!error) return;
    if (!dropMissingCol(error)) return console.error("[DB] writeExtras failed:", error.message || error);
  }
}

async function _endVoiceSession(userId, speakingSeconds = 0, extras = null) {
  if (!supabase) return;
  try {
    await writeExtras(userId, extras);
    const { error } = await supabase.rpc("end_voice_session", {
      p_user_id: String(userId),
      p_speaking_seconds: parseInt(speakingSeconds, 10) || 0
    });
    if (error) {
      // Direct update fallback in case RPC update has not run yet
      const secs = parseInt(speakingSeconds, 10) || 0;
      const { error: updErr } = await supabase
        .from("voice_sessions")
        .update(secs > 0 ? { left_at: new Date().toISOString(), speaking_seconds: secs } : { left_at: new Date().toISOString() })
        .eq("user_id", String(userId))
        .is("left_at", null);
      if (updErr) throw updErr;
    }
  } catch (err) {
    console.error("[DB] endVoiceSession failed:", err.message || err);
  }
}

async function _startVoiceSession(userId, username, channelId, channelName, displayName, devices) {
  if (!supabase) return;
  try {
    await _endVoiceSession(userId, 0);
    const row = {
      user_id: String(userId),
      username,
      display_name: displayName || null,
      channel_id: String(channelId),
      channel_name: channelName || null,
      left_at: null,
      speaking_seconds: 0,
    };
    if (extraCols.has("devices")) row.devices = devices || null;
    let { error } = await supabase.from("voice_sessions").insert(row);
    if (error && dropMissingCol(error)) {
      delete row.devices;
      ({ error } = await supabase.from("voice_sessions").insert(row));
    }
    if (error) throw error;
  } catch (err) {
    console.error("[DB] startVoiceSession failed:", err.message || err);
  }
}

const endVoiceSession = (userId, speakingSeconds = 0, extras = null) =>
  serialize(String(userId), () => _endVoiceSession(userId, speakingSeconds, extras));

const startVoiceSession = (userId, username, channelId, channelName, displayName, devices) =>
  serialize(String(userId), () =>
    _startVoiceSession(userId, username, channelId, channelName, displayName, devices)
  );

// Saves the running mic talk / stream / muted / deafened time on a still-open session, so it survives a bot restart.
const checkpointSpeaking = (userId, speakingSeconds, extras = null) =>
  serialize(String(userId), async () => {
    if (!supabase) return;
    try {
      await writeExtras(userId, extras);
      const { error } = await supabase
        .from("voice_sessions")
        .update({ speaking_seconds: parseInt(speakingSeconds, 10) || 0 })
        .eq("user_id", String(userId))
        .is("left_at", null);
      if (error) throw error;
    } catch (err) {
      console.error("[DB] checkpointSpeaking failed:", err.message || err);
    }
  });

// Returns Map(userId -> { speaking, streaming, muted, deafened } seconds already saved) for sessions that stayed open across a restart.
async function reconcileVoiceSessions(client) {
  const carried = new Map();
  if (!supabase) return carried;
  try {
    const guild = client.guilds.cache.get(IDs.guild);
    if (!guild) return carried;

    const current = new Map();
    guild.voiceStates.cache.forEach((vs) => {
      const user = vs.member?.user;
      if (!vs.channelId || !user || user.bot || !isTrackedChannel(vs.channelId)) return;
      current.set(vs.id, {
        channelId: vs.channelId,
        username: user.username,
        displayName: vs.member.displayName,
        channelName: vs.channel?.name,
        devices: Object.keys(vs.member.presence?.clientStatus || {}).sort().join(","),
      });
    });

    const { data: open, error } = await supabase
      .from("voice_sessions")
      .select("*")
      .is("left_at", null);
    if (error) throw error;

    const stillValid = new Set();
    for (const row of open || []) {
      const now = current.get(row.user_id);
      const saved = { speaking: Number(row.speaking_seconds) || 0 };
      for (const k of EXTRA_KINDS) saved[k] = Number(row[k + "_seconds"]) || 0;
      if (now && now.channelId === row.channel_id) {
        stillValid.add(row.user_id);
        carried.set(row.user_id, saved);
      } else await endVoiceSession(row.user_id, saved.speaking, saved);
    }

    for (const [userId, info] of current) {
      if (!stillValid.has(userId)) {
        await startVoiceSession(userId, info.username, info.channelId, info.channelName, info.displayName, info.devices);
      }
    }
    console.log(`[DB] Voice sessions reconciled (${current.size} user(s) in voice).`);
  } catch (err) {
    console.error("[DB] reconcileVoiceSessions failed:", err.message || err);
  }
  return carried;
}

// ---------- Late notices ----------
async function addLateNotice(n) {
  if (!supabase) throw new Error("Database is not configured");
  const { data, error } = await supabase
    .from("late_notices")
    .insert({
      user_id: String(n.userId),
      username: n.username,
      display_name: n.displayName || null,
      target_date: n.targetDate, // "YYYY-MM-DD" + "HH:mm" on the server clock (DEFAULT_TZ)
      target_time: n.targetTime,
      delay_minutes: n.delayMinutes,
      reason: n.reason,
      is_valid: n.isValid,
    })
    .select()
    .single();
  if (error) {
    // 42P01 / PGRST205: the table has not been created yet
    if (error.code === "42P01" || error.code === "PGRST205") {
      throw new Error("late_notices table is missing - run schema.sql in Supabase first");
    }
    throw new Error(error.message || "insert failed");
  }
  return data;
}

async function getLateNotices(fromDate, toDate) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from("late_notices")
      .select("id, user_id, target_date, target_time, delay_minutes, reason, is_valid, submitted_at")
      .gte("target_date", fromDate)
      .lte("target_date", toDate)
      .order("id", { ascending: true })
      .limit(5000);
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error("[DB] getLateNotices failed:", err.message || err);
    return [];
  }
}

// Newest submissions first, for the dashboard's notice list
async function listLateNotices(limit = 300) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("late_notices")
    .select("id, user_id, username, display_name, target_date, target_time, delay_minutes, reason, is_valid, submitted_at")
    .order("submitted_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message || "read failed");
  return data || [];
}

// ---------- Reads ----------
// Earliest recorded voice join / presence change, in ms (null when there is nothing yet)
async function getFirstActivityMs() {
  if (!supabase) return null;
  try {
    const [v, p] = await Promise.all([
      supabase.from("voice_sessions").select("joined_at").order("joined_at", { ascending: true }).limit(1),
      supabase.from("presence_logs").select("changed_at").order("changed_at", { ascending: true }).limit(1),
    ]);
    const times = [v.data?.[0]?.joined_at, p.data?.[0]?.changed_at].map((t) => Date.parse(t)).filter(Number.isFinite);
    return times.length ? Math.min(...times) : null;
  } catch (err) {
    console.error("[DB] getFirstActivityMs failed:", err.message || err);
    return null;
  }
}

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
  const load = () =>
    fetchAll(() => {
      let q = supabase
        .from("voice_sessions")
        .select("id, user_id, username, display_name, channel_id, channel_name, joined_at, left_at, duration_seconds, speaking_seconds" + [...extraCols].map((c) => ", " + c).join(""))
        .order("id", { ascending: true });
      if (sinceIso) q = q.or(`left_at.is.null,left_at.gte.${sinceIso}`);
      if (untilIso) q = q.lte("joined_at", untilIso);
      return q;
    });
  try {
    for (; ;) {
      try {
        return await load();
      } catch (err) {
        if (!dropMissingCol(err)) throw err;
      }
    }
  } catch (err) {
    console.error("[DB] getSessionRows failed:", err.message || err);
    return { rows: [], truncated: false };
  }
}

// Coming online for a few seconds then straight back offline (a reconnect flicker) is noise in the
// stats. The rows stay in the table (and the status channel still posts them); the dashboard just
// skips both rows of such an offline > online > offline blip.
const PRESENCE_BLIP_MS = 4000;

// ids of the rows that are part of a blip. Rows must hold every change of their users over the
// span checked; a blip's earlier row is looked up when it isn't in them.
async function presenceBlipIds(rows) {
  const byUser = new Map();
  for (const r of [...rows].sort((a, b) => Number(a.id) - Number(b.id))) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }
  const ids = new Set();
  const lookups = [];
  for (const list of byUser.values()) {
    for (let i = 0; i + 1 < list.length; i++) {
      const on = list[i], off = list[i + 1];
      if (on.status === "offline" || off.status !== "offline") continue;
      if (Date.parse(off.changed_at) - Date.parse(on.changed_at) > PRESENCE_BLIP_MS) continue;
      const mark = () => { ids.add(on.id); ids.add(off.id); };
      // Only a flicker up from offline counts, not e.g. idle > online > offline
      if (i > 0) {
        if (list[i - 1].status === "offline") mark();
        continue;
      }
      lookups.push(
        supabase.from("presence_logs").select("status").eq("user_id", on.user_id).lt("id", on.id)
          .order("id", { ascending: false }).limit(1)
          .then(({ data, error }) => {
            if (error) throw error;
            if (!data.length || data[0].status === "offline") mark();
          })
      );
    }
  }
  await Promise.all(lookups);
  return ids;
}

// presence_logs.devices holds each app's own status ("desktop:idle,mobile:online"); older rows
// hold only the apps ("desktop,mobile"). Readers get devices as the plain app list plus
// device_status { desktop: "idle", ... } (null for older rows).
function splitDevices(r) {
  const parts = String(r.devices || "").split(",").filter(Boolean).map((p) => p.split(":"));
  const devices = parts.map(([d]) => d).join(",") || null;
  const device_status = parts.length && parts.every((p) => p[1]) ? Object.fromEntries(parts) : null;
  return { ...r, devices, device_status };
}
// Each app's status on a split row ({} when offline), or null for an older row that doesn't say
const appStatuses = (r) => r.device_status || (r.status === "offline" ? {} : null);
// One app's status on a split row; older rows count the overall status for each app listed
function statusOnApp(r, d) {
  if (!r) return "offline";
  if (r.device_status) return r.device_status[d] || "offline";
  return r.status !== "offline" && String(r.devices || "").split(",").includes(d) ? r.status : "offline";
}

async function getPresenceRows(sinceIso, untilIso) {
  if (!supabase) return { rows: [], truncated: false };
  const load = () =>
    fetchAll(() => {
      let q = supabase
        .from("presence_logs")
        .select("id, user_id, username, display_name, status, changed_at" + (hasDevicesCol ? ", devices" : ""))
        .order("id", { ascending: true });
      if (sinceIso) q = q.gte("changed_at", sinceIso);
      if (untilIso) q = q.lte("changed_at", untilIso);
      return q;
    });
  try {
    let res;
    try {
      res = await load();
    } catch (err) {
      if (!devicesColMissing(err)) throw err;
      res = await load();
    }
    const blips = await presenceBlipIds(res.rows);
    return { ...res, rows: res.rows.filter((r) => !blips.has(r.id)).map(splitDevices) };
  } catch (err) {
    console.error("[DB] getPresenceRows failed:", err.message || err);
    return { rows: [], truncated: false };
  }
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
  const { channelId, status, sinceIso, untilIso } = opts;
  // userId may be one id or a comma-separated list
  const userIds = String(opts.userId || "").split(",").filter(Boolean);
  const userId = userIds.length > 0;
  const byUser = (q) => (userIds.length === 1 ? q.eq("user_id", userIds[0]) : q.in("user_id", userIds));
  let kind = opts.kind || "all";
  try {
    let wantPresence = kind === "all" || kind === "presence";
    let wantVoice = kind === "all" || kind === "voice";
    if (status) wantVoice = false;
    if (channelId) wantPresence = false;
    // Device filter ("desktop" / "mobile" / "web"): rows logged without device info can't match it
    const device = ["desktop", "mobile", "web"].includes(opts.device) ? opts.device : "";
    if (device && !hasDevicesCol) wantPresence = false;
    if (device && !extraCols.has("devices")) wantVoice = false;
    const byDevice = (q) => (device ? q.ilike("devices", `%${device}%`) : q);
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
          .select("*") // includes devices once schema.sql has added it
          .order("changed_at", { ascending: false })
          // headroom for the blips dropped below; with a device filter the rows are picked
          // below (that app's own status changed), so status/device can't be queried here
          .limit(device ? limit * 5 : limit * 2);
        if (userId) q = byUser(q);
        if (status && !device) q = q.eq("status", status);
        return window(q, "changed_at");
      })()
      : none;
    const joinsQ = wantVoice
      ? (() => {
        let q = supabase
          .from("voice_sessions")
          .select("id, user_id, username, display_name, channel_name, joined_at" + (extraCols.has("devices") ? ", devices" : ""))
          .order("joined_at", { ascending: false })
          .limit(limit);
        if (userId) q = byUser(q);
        if (channelId) q = q.eq("channel_id", channelId);
        return window(byDevice(q), "joined_at");
      })()
      : none;
    const leavesQ = wantVoice
      ? (() => {
        let q = supabase
          .from("voice_sessions")
          .select("id, user_id, username, display_name, channel_name, left_at, duration_seconds, speaking_seconds")
          .not("left_at", "is", null)
          .order("left_at", { ascending: false })
          .limit(limit);
        if (userId) q = byUser(q);
        if (channelId) q = q.eq("channel_id", channelId);
        return window(byDevice(q), "left_at");
      })()
      : none;

    const [presence, joins, leaves] = await Promise.all([presenceQ, joinsQ, leavesQ]);
    for (const r of [presence, joins, leaves]) if (r.error) throw r.error;

    // Each status row gets its member's previous row, so the page can show what changed on each
    // app however the list is filtered. Every change those members made over the page's span (and
    // the one before it) is loaded for that; blips are dropped here too.
    if (presence.data.length) {
      const times = presence.data.map((r) => Date.parse(r.changed_at));
      const cols = "id, user_id, status, changed_at" + (hasDevicesCol ? ", devices" : "");
      const { rows: around } = await fetchAll(() =>
        supabase
          .from("presence_logs")
          .select(cols)
          .in("user_id", [...new Set(presence.data.map((r) => r.user_id))])
          .gte("changed_at", new Date(Math.min(...times) - PRESENCE_BLIP_MS).toISOString())
          .lte("changed_at", new Date(Math.max(...times) + PRESENCE_BLIP_MS).toISOString())
          .order("id", { ascending: true })
      );
      const blips = await presenceBlipIds(around);
      const firstId = new Map();
      for (const r of around) if (!firstId.has(r.user_id)) firstId.set(r.user_id, r.id);
      const earlier = await Promise.all(
        [...firstId].map(([uid, id]) =>
          supabase.from("presence_logs").select(cols).eq("user_id", uid).lt("id", id).order("id", { ascending: false }).limit(1)
            .then(({ data, error }) => {
              if (error) throw error;
              return data;
            })
        )
      );
      const prevOf = new Map(), last = new Map();
      const ordered = [...earlier.flat(), ...around].filter((r) => !blips.has(r.id)).map(splitDevices).sort((a, b) => Number(a.id) - Number(b.id));
      for (const r of ordered) {
        prevOf.set(r.id, last.get(r.user_id) || null);
        last.set(r.user_id, r);
      }
      presence.data = presence.data.filter((r) => !blips.has(r.id)).map(splitDevices).map((r) => ({ ...r, prev: prevOf.get(r.id) || null }));
      // Device filter: only rows where that app's own status changed (incl. it going offline)
      if (device) presence.data = presence.data.filter((r) => {
        const s = statusOnApp(r, device);
        return s !== statusOnApp(r.prev, device) && (!status || s === status);
      });
    }

    const events = [
      ...presence.data.map((r) => ({ id: r.id, type: "presence", user_id: r.user_id, username: r.username, display_name: r.display_name, status: r.status, devices: r.devices, device_status: r.device_status, device_before: r.prev ? appStatuses(r.prev) : {}, at: r.changed_at })),
      ...joins.data.map((r) => ({ id: r.id, type: "voice_join", user_id: r.user_id, username: r.username, display_name: r.display_name, channel_name: r.channel_name, devices: r.devices || null, at: r.joined_at })),
      ...leaves.data.map((r) => ({ id: r.id, type: "voice_leave", user_id: r.user_id, username: r.username, display_name: r.display_name, channel_name: r.channel_name, duration_seconds: r.duration_seconds, speaking_seconds: r.speaking_seconds, at: r.left_at })),
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
  unionIntervals,
  logPresence,
  startVoiceSession,
  endVoiceSession,
  reconcileVoiceSessions,
  checkpointSpeaking,
  addLateNotice,
  getLateNotices,
  listLateNotices,
  getFirstActivityMs,
  getSessionRows,
  getPresenceRows,
  getTotalVoiceSeconds,
  getVoiceLeaderboard,
  getRecentLogs,
};