// stats.js - turns raw voice sessions + status logs into dashboard analytics.
const { makeTz } = require("./tz");
const db = require("./db");
const HOUR = 3600e3;
const DAY = 86400e3;

const HIST_BUCKETS = [
  { label: "Under 5 min", max: 5 * 60 },
  { label: "5-15 min", max: 15 * 60 },
  { label: "15-30 min", max: 30 * 60 },
  { label: "30-60 min", max: 60 * 60 },
  { label: "1-2 h", max: 2 * 3600 },
  { label: "2-4 h", max: 4 * 3600 },
  { label: "4 h +", max: Infinity },
];

const STATUSES = ["online", "idle", "dnd", "offline"];

function computeStats({ sessionRows, presenceRows, now, since, user, channel, liveName, liveStatus, tz, status, dayStart = 0, includeAfk = false, client = null }) {
  const z = makeTz(tz, dayStart);
  const eachHourSlice = z.eachHourSlice;
  const dateKey = z.dateOf;

  const names = new Map();
  const chanNames = new Map();
  for (const r of sessionRows) {
    names.set(r.user_id, r.display_name || r.username);
    if (r.channel_id && r.channel_name) chanNames.set(r.channel_id, r.channel_name);
  }
  for (const r of presenceRows) names.set(r.user_id, r.display_name || r.username);
  const nameOf = (id) => (liveName && liveName(id)) || names.get(id) || id;
  const chanOf = (id) => chanNames.get(id) || "Voice";

  // ---- sessions clipped to the window ----
  const win = [];
  for (const r of sessionRows) {
    // Exclude AFK channel if not explicitly requested
    if (!includeAfk && !channel && db.isAfkChannel(r.channel_id, r.channel_name, client)) continue;
    const start = Date.parse(r.joined_at);
    const end = r.left_at ? Date.parse(r.left_at) : now;
    const cs = Math.max(start, since == null ? start : since);
    const ce = Math.min(end, now);
    if (!(ce > cs)) continue;
    win.push({
      userId: r.user_id,
      channelId: r.channel_id,
      channelName: r.channel_name,
      cs,
      ce,
      secs: (ce - cs) / 1000,
      open: !r.left_at,
    });
  }

  let sinceEff = since;
  if (sinceEff == null) {
    let min = Infinity;
    for (const s of win) if (s.cs < min) min = s.cs;
    for (const p of presenceRows) {
      const t = Date.parse(p.changed_at);
      if (t < min) min = t;
    }
    sinceEff = min === Infinity ? now - 7 * DAY : min;
  }

  const scopedChan = channel ? win.filter((s) => s.channelId === channel) : win;
  const scoped = user ? scopedChan.filter((s) => s.userId === user) : scopedChan;

  // ---- time distributions ----
  const hourly = new Array(24).fill(0);
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const dailyMap = new Map();
  const memberMap = new Map();
  const chanMap = new Map();

  for (const s of scoped) {
    let m = memberMap.get(s.userId);
    if (!m) {
      m = { seconds: 0, sessions: 0, longest: 0, days: new Set(), chans: new Map(), first: s.cs, last: s.ce, open: false };
      memberMap.set(s.userId, m);
    }
    m.seconds += s.secs;
    m.sessions += 1;
    m.longest = Math.max(m.longest, s.secs);
    m.first = Math.min(m.first, s.cs);
    m.last = Math.max(m.last, s.ce);
    if (s.open) m.open = true;
    m.chans.set(s.channelId, (m.chans.get(s.channelId) || 0) + s.secs);

    let c = chanMap.get(s.channelId);
    if (!c) chanMap.set(s.channelId, (c = { seconds: 0, sessions: 0 }));
    c.seconds += s.secs;
    c.sessions += 1;

    let first = true;
    eachHourSlice(s.cs, s.ce, (b, sec) => {
      hourly[b.hour] += sec;
      heat[b.dow][b.hour] += sec;
      let d = dailyMap.get(b.date);
      if (!d) dailyMap.set(b.date, (d = { seconds: 0, sessions: 0, users: new Set() }));
      d.seconds += sec;
      d.users.add(s.userId);
      if (first) d.sessions += 1;
      first = false;
      m.days.add(b.date);
    });
  }

  // ---- day axis ----
  const dayKeys = [];
  let lastKey = null;
  for (let t = sinceEff; t <= now; t += 6 * HOUR) {
    const k = dateKey(t);
    if (k !== lastKey) dayKeys.push(k);
    lastKey = k;
  }
  const nowKey = dateKey(now);
  if (lastKey !== nowKey) dayKeys.push(nowKey);
  const days = dayKeys.slice(-400);

  const daily = days.map((date) => {
    const d = dailyMap.get(date);
    return {
      date,
      voice_seconds: d ? Math.round(d.seconds) : 0,
      sessions: d ? d.sessions : 0,
      users: d ? d.users.size : 0,
    };
  });

  // ---- co-presence: Unique clusters of members hanging out together ----
  const byChan = new Map();
  for (const s of scopedChan) {
    if (!byChan.has(s.channelId)) byChan.set(s.channelId, []);
    byChan.get(s.channelId).push(s);
  }
  const groupMap = new Map();
  let personTotal = 0;
  let personTogether = 0;

  for (const list of byChan.values()) {
    const ev = [];
    for (const s of list) {
      ev.push([s.cs, 1, s.userId]);
      ev.push([s.ce, -1, s.userId]);
    }
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const active = new Map();
    let last = null;

    for (const [t, type, uid] of ev) {
      if (last !== null && t > last && active.size && (!user || active.has(user))) {
        const dt = (t - last) / 1000;
        const ids = [...active.keys()];
        if (user) {
          personTotal += dt;
          if (ids.length >= 2) personTogether += dt;
        } else {
          personTotal += dt * ids.length;
          if (ids.length >= 2) personTogether += dt * ids.length;
        }

        // Only log unique groups of 2 or more members
        if (ids.length >= 2) {
          const sortedIds = ids.slice().sort();
          const key = sortedIds.join("|");
          groupMap.set(key, (groupMap.get(key) || 0) + dt);
        }
      }
      last = t;
      if (type === 1) active.set(uid, (active.get(uid) || 0) + 1);
      else {
        const n = (active.get(uid) || 1) - 1;
        if (n > 0) active.set(uid, n);
        else active.delete(uid);
      }
    }
  }

  const pairs = [...groupMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, seconds]) => {
      const uids = key.split("|");
      const members = uids.map((id) => ({ user_id: id, name: nameOf(id) }));
      return {
        key,
        members,
        a: members[0] || { user_id: "", name: "" },
        b: members[1] || { user_id: "", name: "" },
        seconds: Math.round(seconds),
      };
    });

  // ---- peak concurrency ----
  let peak = { count: 0, at: null };
  {
    const ev = [];
    for (const s of scopedChan) {
      ev.push([s.cs, 1]);
      ev.push([s.ce, -1]);
    }
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0;
    for (const [t, d] of ev) {
      cur += d;
      if (cur > peak.count) peak = { count: cur, at: new Date(t).toISOString() };
    }
  }

  // ---- KPIs ----
  const totalSeconds = scoped.reduce((n, s) => n + s.secs, 0);
  const sorted = scoped.map((s) => s.secs).sort((a, b) => a - b);
  const median = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : 0;
  const longestSessions = [...scoped]
    .sort((a, b) => b.secs - a.secs)
    .slice(0, 10)
    .map((s) => ({
      user_id: s.userId,
      name: nameOf(s.userId),
      channel_name: chanOf(s.channelId),
      started_at: new Date(s.cs).toISOString(),
      seconds: Math.round(s.secs),
      open: s.open,
    }));

  const histogram = HIST_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  for (const s of scoped) {
    const i = HIST_BUCKETS.findIndex((b) => s.secs < b.max);
    histogram[i].count += 1;
  }

  const members = [...memberMap.entries()]
    .map(([id, m]) => {
      let fav = null;
      let favSecs = -1;
      for (const [cid, secs] of m.chans) if (secs > favSecs) ((fav = cid), (favSecs = secs));
      return {
        user_id: id,
        name: nameOf(id),
        seconds: Math.round(m.seconds),
        sessions: m.sessions,
        avg_session_seconds: Math.round(m.seconds / m.sessions),
        longest_seconds: Math.round(m.longest),
        favorite_channel: fav ? chanOf(fav) : null,
        active_days: m.days.size,
        last_seen_at: new Date(m.last).toISOString(),
        in_voice_now: m.open,
      };
    })
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 100);

  const channels = [...chanMap.entries()]
    .map(([id, c]) => ({ channel_id: id, name: chanOf(id), seconds: Math.round(c.seconds), sessions: c.sessions }))
    .sort((a, b) => b.seconds - a.seconds);

  // ---- status (presence) analytics ----
  // Preserve database ID to guarantee chronological order during same-second events
  const prs = presenceRows
    .filter((r) => !user || r.user_id === user)
    .map((r) => ({
      id: Number(r.id) || 0,
      u: r.user_id,
      status: r.status,
      t: Date.parse(r.changed_at)
    }))
    .filter((r) => r.t <= now && (since == null || r.t >= since) && STATUSES.includes(r.status));

  const byUser = new Map();
  for (const r of prs) {
    if (!byUser.has(r.u)) byUser.set(r.u, []);
    byUser.get(r.u).push(r);
  }

  const totals = { online: 0, idle: 0, dnd: 0, offline: 0 };
  const hourlyBy = Object.fromEntries(STATUSES.map((k) => [k, new Array(24).fill(0)]));
  const perMember = [];

  for (const [uid, arr] of byUser) {
    // Sort primarily by timestamp, then by database auto-increment ID
    arr.sort((a, b) => a.t - b.t || a.id - b.id);

    // Remove redundant consecutive same-status events
    const cleanArr = [];
    for (const item of arr) {
      if (cleanArr.length > 0 && cleanArr[cleanArr.length - 1].status === item.status && cleanArr[cleanArr.length - 1].t === item.t) {
        continue;
      }
      cleanArr.push(item);
    }

    const row = { user_id: uid, name: nameOf(uid), online: 0, idle: 0, dnd: 0, offline: 0 };
    for (let i = 0; i < cleanArr.length; i++) {
      const start = cleanArr[i].t;
      let end = i + 1 < cleanArr.length ? cleanArr[i + 1].t : now;

      // If user went online and offline in the same second, duration is 0
      if (end <= start) continue;

      // If user is currently confirmed offline, do not project an old online state to `now`
      if (i + 1 >= cleanArr.length && cleanArr[i].status !== "offline" && liveStatus) {
        const curStatus = liveStatus(uid);
        if (curStatus === "offline") {
          end = start; // cap at 0 duration
        }
      }

      if (!(end > start)) continue;
      const secs = (end - start) / 1000;
      row[cleanArr[i].status] += secs;
      totals[cleanArr[i].status] += secs;

      const target = hourlyBy[cleanArr[i].status];
      eachHourSlice(start, end, (b, sec) => {
        target[b.hour] += sec;
      });
    }
    for (const k of STATUSES) row[k] = Math.round(row[k]);
    perMember.push(row);
  }

  const rankBy = STATUSES.includes(status) ? status : "online";
  perMember.sort((a, b) => b[rankBy] - a[rankBy] || b.online - a.online);

  const changesMap = new Map();
  const changesByStatus = { online: 0, idle: 0, dnd: 0, offline: 0 };
  const prsShown = STATUSES.includes(status) ? prs.filter((r) => r.status === status) : prs;
  for (const r of prs) changesByStatus[r.status] += 1;
  for (const r of prsShown) {
    const k = dateKey(r.t);
    changesMap.set(k, (changesMap.get(k) || 0) + 1);
  }

  const round = (n) => Math.round(n);
  return {
    meta: {
      since: new Date(sinceEff).toISOString(),
      until: new Date(now).toISOString(),
      user: user || null,
      channel: channel || null,
      tz: z.tz,
      dayStart: z.dayStartHour,
      status: STATUSES.includes(status) ? status : null,
      sessions_loaded: sessionRows.length,
      presence_loaded: presenceRows.length,
      truncated: false,
    },
    kpis: {
      total_seconds: round(totalSeconds),
      sessions: scoped.length,
      avg_session_seconds: scoped.length ? round(totalSeconds / scoped.length) : 0,
      median_session_seconds: round(median),
      longest: longestSessions[0] || null,
      unique_members: memberMap.size,
      active_days: new Set([...dailyMap.keys()]).size,
      peak_concurrent: peak,
      together_pct: personTotal > 0 ? Math.round((personTogether / personTotal) * 1000) / 10 : null,
      presence_changes: prsShown.length,
    },
    daily,
    hourly: hourly.map(round),
    heatmap: heat.map((row) => row.map(round)),
    channels,
    members,
    histogram,
    pairs,
    longest_sessions: longestSessions,
    presence: {
      totals: Object.fromEntries(STATUSES.map((k) => [k, round(totals[k])])),
      per_member: perMember.slice(0, 25),
      hourly_by_status: Object.fromEntries(STATUSES.map((k) => [k, hourlyBy[k].map(round)])),
      daily_changes: days.map((date) => ({ date, count: changesMap.get(date) || 0 })),
      changes_by_status: changesByStatus,
    },
  };
}

module.exports = { computeStats };