// report.js - attendance reports for voice channels and online status.
// Pure function (no Discord/Supabase) so it can be tested with fake data.
//
// A "day" is a calendar day on the viewer's clock (their timezone). Sessions and
// status periods that cross midnight are split, so each day only counts the time
// that really happened on that day.
const { makeTz } = require("./tz");

const STATUSES = ["online", "idle", "dnd"];

function computeReport(o) {
  const { type, sessionRows, presenceRows, from, to, user, channel, minSeconds, mode, roster, rosterIds, now, liveName } = o;
  const z = makeTz(o.tz);
  const voice = type === "voice";

  // ---- names ----
  const names = new Map();
  for (const r of sessionRows) names.set(r.user_id, r.display_name || r.username);
  for (const r of presenceRows) names.set(r.user_id, r.display_name || r.username);
  const nameOf = (id) => (liveName && liveName(id)) || names.get(id) || id;

  // ---- period ----
  const dates = [];
  for (let d = from; d <= to; d = z.addDays(d, 1)) dates.push(d);
  const fromMs = z.startOfDate(from);
  const toMs = Math.min(z.startOfDate(z.addDays(to, 1)), now);
  const today = z.dateOf(now);
  const elapsed = dates.filter((d) => d <= today);

  // ---- per member, per day records ----
  const recs = new Map();
  const rec = (uid, date) => {
    const key = uid + "|" + date;
    let r = recs.get(key);
    if (!r) {
      r = { uid, date, seconds: 0, n: 0, first: Infinity, last: -Infinity, ci: false, co: false, op: false, lastEnd: null, ch: new Map(), st: { online: 0, idle: 0, dnd: 0 } };
      recs.set(key, r);
    }
    return r;
  };

  // Splits [cs, ce) at local midnights and calls cb(date, a, b, dayStart, dayEnd).
  function eachDaySeg(cs, ce, cb) {
    let date = z.dateOf(cs);
    for (;;) {
      const [ds, de] = z.dayBounds(date);
      const a = Math.max(cs, ds);
      const b = Math.min(ce, de);
      if (b > a) cb(date, a, b, ds, de);
      if (ce <= de) break;
      date = z.addDays(date, 1);
    }
  }

  function addQualifying(R, a, b, ds, de, realStart, realEnd, stillGoing) {
    R.seconds += (b - a) / 1000;
    if (a !== R.lastEnd) R.n += 1; // back-to-back pieces count as one spell
    R.lastEnd = b;
    if (a < R.first) {
      R.first = a;
      R.ci = realStart < ds;
    }
    if (b > R.last) {
      R.last = b;
      R.co = realEnd > de;
      R.op = stillGoing && b === realEnd;
    }
  }

  if (voice) {
    for (const r of sessionRows) {
      if (user && r.user_id !== user) continue;
      if (channel && r.channel_id !== channel) continue;
      const start = Date.parse(r.joined_at);
      const end = r.left_at ? Date.parse(r.left_at) : now;
      const cs = Math.max(start, fromMs);
      const ce = Math.min(end, toMs);
      if (!(ce > cs)) continue;
      const chName = r.channel_name || "Voice";
      eachDaySeg(cs, ce, (date, a, b, ds, de) => {
        const R = rec(r.user_id, date);
        addQualifying(R, a, b, ds, de, start, end, !r.left_at);
        R.ch.set(chName, (R.ch.get(chName) || 0) + (b - a) / 1000);
      });
    }
  } else {
    const qualifies = (s) => (mode === "active" ? s !== "offline" : s === mode); // online, idle or dnd = exactly that status
    const byUser = new Map();
    for (const r of presenceRows) {
      if (user && r.user_id !== user) continue;
      if (r.status !== "offline" && !STATUSES.includes(r.status)) continue;
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id).push({ status: r.status, t: Date.parse(r.changed_at) });
    }
    for (const [uid, arr] of byUser) {
      arr.sort((a, b) => a.t - b.t);
      for (let i = 0; i < arr.length; i++) {
        const start = arr[i].t;
        const end = Math.min(i + 1 < arr.length ? arr[i + 1].t : now, now);
        const cs = Math.max(start, fromMs);
        const ce = Math.min(end, toMs);
        if (!(ce > cs)) continue;
        const status = arr[i].status;
        if (status === "offline") continue;
        const isLast = i + 1 >= arr.length;
        eachDaySeg(cs, ce, (date, a, b, ds, de) => {
          const R = rec(uid, date);
          R.st[status] += (b - a) / 1000;
          if (qualifies(status)) addQualifying(R, a, b, ds, de, start, end, isLast);
        });
      }
    }
  }

  // ---- members ----
  const attended = (R) => !!R && R.seconds >= minSeconds && R.seconds > 0;
  const ids = new Set();
  for (const R of recs.values()) if (R.seconds > 0) ids.add(R.uid);
  if (roster) for (const id of rosterIds || []) ids.add(id);
  if (user) ids.add(user);

  const minutesOf = (ms) => {
    const p = z.partsOf(ms);
    return p.hour * 60 + p.minute;
  };

  const members = [];
  for (const uid of ids) {
    let days = 0, total = 0, sessions = 0;
    const firstMins = [];
    let earliest = null, latest = null, firstAt = Infinity, lastAt = -Infinity, stillIn = false;
    for (const date of dates) {
      const R = recs.get(uid + "|" + date);
      if (!R || R.seconds <= 0) continue;
      total += R.seconds;
      sessions += R.n;
      if (!attended(R)) continue;
      days += 1;
      firstAt = Math.min(firstAt, R.first);
      lastAt = Math.max(lastAt, R.last);
      if (R.op) stillIn = true;
      if (!R.ci) {
        const m = minutesOf(R.first);
        firstMins.push(m);
        if (!earliest || m < earliest.min) earliest = { date, min: m };
      }
      if (!R.co) {
        const m = minutesOf(R.last);
        if (!latest || m > latest.min) latest = { date, min: m };
      }
    }

    // streaks over the days that have already happened
    let longest = 0, run = 0;
    for (const d of elapsed) {
      if (attended(recs.get(uid + "|" + d))) { run += 1; longest = Math.max(longest, run); } else run = 0;
    }
    let current = 0;
    let idx = elapsed.length - 1;
    if (idx >= 0 && elapsed[idx] === today && !attended(recs.get(uid + "|" + today))) idx -= 1; // today isn't over yet
    for (; idx >= 0 && attended(recs.get(uid + "|" + elapsed[idx])); idx--) current += 1;

    members.push({
      user_id: uid,
      name: nameOf(uid),
      days_attended: days,
      absent_days: Math.max(0, elapsed.length - days),
      attendance_pct: elapsed.length ? Math.round((days / elapsed.length) * 1000) / 10 : null,
      total_seconds: Math.round(total),
      avg_seconds_per_day: days ? Math.round(total / days) : 0,
      sessions,
      avg_first_min: firstMins.length ? Math.round(firstMins.reduce((a, b) => a + b, 0) / firstMins.length) : null,
      earliest,
      latest,
      first_at: firstAt === Infinity ? null : firstAt,
      last_at: lastAt === -Infinity ? null : lastAt,
      still_in: stillIn,
      longest_streak: longest,
      current_streak: current,
    });
  }

  members.sort((a, b) => b.days_attended - a.days_attended || b.total_seconds - a.total_seconds || a.name.localeCompare(b.name));
  members.forEach((m, i) => (m.rank = i + 1));

  // ---- daily sheet ----
  const cellOf = (R) =>
    R && R.seconds > 0
      ? { s: Math.round(R.seconds), f: R.first, l: R.last, n: R.n, ci: R.ci, co: R.co, op: R.op, i: Math.round(R.st.idle), d: Math.round(R.st.dnd) }
      : null;
  const grid = members.map((m) => ({
    user_id: m.user_id,
    cells: dates.map((d) => cellOf(recs.get(m.user_id + "|" + d))),
  }));

  // ---- day-by-day log ----
  const log = [];
  for (const R of recs.values()) {
    if (!(R.seconds > 0) || !ids.has(R.uid)) continue;
    log.push({
      date: R.date,
      user_id: R.uid,
      name: nameOf(R.uid),
      attended: attended(R),
      seconds: Math.round(R.seconds),
      first: R.first,
      last: R.last,
      count: R.n,
      carried_in: R.ci,
      carried_out: R.co,
      still_in: R.op,
      channels: [...R.ch.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n),
      idle: Math.round(R.st.idle),
      dnd: Math.round(R.st.dnd),
    });
  }
  log.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.name.localeCompare(b.name)));

  // ---- summary ----
  const pcts = members.map((m) => m.attendance_pct).filter((v) => v != null);
  const summary = {
    members_attended: members.filter((m) => m.days_attended > 0).length,
    members_listed: members.length,
    total_seconds: members.reduce((n, m) => n + m.total_seconds, 0),
    attended_member_days: members.reduce((n, m) => n + m.days_attended, 0),
    avg_attendance_pct: pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10 : null,
    best: members[0] && members[0].days_attended > 0 ? { user_id: members[0].user_id, name: members[0].name, days: members[0].days_attended } : null,
  };

  return {
    meta: {
      type,
      mode: voice ? null : mode,
      from,
      to,
      dates,
      today,
      period_days: elapsed.length,
      tz: z.tz,
      min_seconds: minSeconds,
      generated_at: new Date(now).toISOString(),
      channel: channel || null,
      user: user || null,
    },
    summary,
    members,
    grid,
    log,
  };
}

module.exports = { computeReport };
