// report.js - attendance and slacker/penalty reports for voice channels and online status.
const { makeTz } = require("./tz");
const db = require("./db");

const STATUSES = ["online", "idle", "dnd"];

// Devices = which Discord app: "desktop" (PC app), "mobile", "web". Rows from before device tracking have none.
const devList = (devices) => String(devices || "").split(",").filter(Boolean);
const DEVICE_GROUPS = ["desktop", "mobile", "web", "multi", "unknown"];
const deviceGroup = (devices) => {
  const l = devList(devices);
  return !l.length ? "unknown" : l.length > 1 ? "multi" : DEVICE_GROUPS.includes(l[0]) ? l[0] : "unknown";
};
const roundAll = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v >= 1).map(([k, v]) => [k, Math.round(v)]));

function computeReport(o) {
  const {
    type,
    sessionRows,
    presenceRows,
    from,
    to,
    user,
    channel,
    minSeconds,
    mode,
    roster,
    rosterIds,
    now,
    liveName,
    liveStatus,
    dayStart = 18,
    includeAfk = false,
    client = null,
    targetTime = "21:00",
    graceMinutes = 15,
    device = "", // only count voice joined from / time online on this device
  } = o;

  const z = makeTz(o.tz, dayStart);
  const voice = type === "voice";
  const isSlackers = type === "slackers";

  // Parse multi-select user filter
  let userFilter = null;
  if (Array.isArray(user)) {
    const valid = user.filter(Boolean);
    if (valid.length > 0) userFilter = new Set(valid);
  } else if (typeof user === "string" && user.trim()) {
    const valid = user.split(",").map((s) => s.trim()).filter(Boolean);
    if (valid.length > 0) userFilter = new Set(valid);
  }

  const names = new Map();
  for (const r of sessionRows) names.set(r.user_id, r.display_name || r.username);
  for (const r of presenceRows) names.set(r.user_id, r.display_name || r.username);
  const nameOf = (id) => (liveName && liveName(id)) || names.get(id) || id;

  const dates = [];
  for (let d = from; d <= to; d = z.addDays(d, 1)) dates.push(d);
  const fromMs = z.startOfDate(from);
  const toMs = Math.min(z.startOfDate(z.addDays(to, 1)), now);
  const today = z.dateOf(now);
  const elapsed = dates.filter((d) => d <= today);

  const recs = new Map();
  const rec = (uid, date) => {
    const key = uid + "|" + date;
    let r = recs.get(key);
    if (!r) {
      r = {
        uid,
        date,
        seconds: 0,
        spk: 0,
        strm: 0,
        mute: 0,
        deaf: 0,
        n: 0,
        first: Infinity,
        last: -Infinity,
        ci: false,
        co: false,
        op: false,
        lastEnd: null,
        iv: [], // qualifying [start, end] intervals, for arrival at the target time
        ch: new Map(),
        st: { online: 0, idle: 0, dnd: 0 },
        jd: new Set(), // voice: devices they joined from
        dv: {}, // online: seconds per device group
      };
      recs.set(key, r);
    }
    return r;
  };

  function eachDaySeg(cs, ce, cb) {
    let date = z.dateOf(cs);
    for (; ;) {
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
    if (a !== R.lastEnd) R.n += 1;
    R.lastEnd = b;
    R.iv.push([a, b]);
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

  if (voice || isSlackers) {
    for (const r of sessionRows) {
      if (userFilter && !userFilter.has(r.user_id)) continue;
      if (channel && r.channel_id !== channel) continue;
      if (!includeAfk && !channel && db.isAfkChannel(r.channel_id, r.channel_name, client)) continue;
      if (device && !devList(r.devices).includes(device)) continue;

      const start = Date.parse(r.joined_at);
      const end = r.left_at ? Date.parse(r.left_at) : now;
      const cs = Math.max(start, fromMs);
      const ce = Math.min(end, toMs);
      if (!(ce > cs)) continue;
      const chName = r.channel_name || "Voice";
      // Talk / stream time is stored per session; each day gets the share matching its slice of the session
      const spkRate = (Number(r.speaking_seconds) || 0) / (end - start);
      const strmRate = (Number(r.streaming_seconds) || 0) / (end - start);
      const muteRate = (Number(r.muted_seconds) || 0) / (end - start);
      const deafRate = (Number(r.deafened_seconds) || 0) / (end - start);
      eachDaySeg(cs, ce, (date, a, b, ds, de) => {
        const R = rec(r.user_id, date);
        addQualifying(R, a, b, ds, de, start, end, !r.left_at);
        R.spk += spkRate * (b - a);
        R.strm += strmRate * (b - a);
        R.mute += muteRate * (b - a);
        R.deaf += deafRate * (b - a);
        R.ch.set(chName, (R.ch.get(chName) || 0) + (b - a) / 1000);
        for (const d of devList(r.devices).length ? devList(r.devices) : ["unknown"]) R.jd.add(d);
      });
    }
  } else {
    const qualifies = (s) => (mode === "active" ? s !== "offline" : s === mode);
    const byUser = new Map();
    for (const r of presenceRows) {
      if (userFilter && !userFilter.has(r.user_id)) continue;
      if (r.status !== "offline" && !STATUSES.includes(r.status)) continue;
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id).push({ id: Number(r.id) || 0, status: r.status, devices: r.devices, t: Date.parse(r.changed_at) });
    }

    for (const [uid, arr] of byUser) {
      arr.sort((a, b) => a.t - b.t || a.id - b.id);
      for (let i = 0; i < arr.length; i++) {
        const start = arr[i].t;
        let end = Math.min(i + 1 < arr.length ? arr[i + 1].t : now, now);

        if (end <= start) continue;
        if (i + 1 >= arr.length && arr[i].status !== "offline" && liveStatus) {
          if (liveStatus(uid) === "offline") end = start;
        }

        const cs = Math.max(start, fromMs);
        const ce = Math.min(end, toMs);
        if (!(ce > cs)) continue;
        const status = arr[i].status;
        if (status === "offline") continue;
        if (device && !devList(arr[i].devices).includes(device)) continue; // only time on that device
        const grp = deviceGroup(arr[i].devices);
        const isLast = i + 1 >= arr.length;
        eachDaySeg(cs, ce, (date, a, b, ds, de) => {
          const R = rec(uid, date);
          R.st[status] += (b - a) / 1000;
          R.dv[grp] = (R.dv[grp] || 0) + (b - a) / 1000;
          if (qualifies(status)) addQualifying(R, a, b, ds, de, start, end, isLast);
        });
      }
    }
  }

  // =========================================================
  // SLACKERS & PENALTY REPORT CALCULATION
  // =========================================================
  if (isSlackers) {
    const [tHour, tMin] = (targetTime || "21:00").split(":").map(Number);
    const graceMs = (parseInt(graceMinutes, 10) || 15) * 60000;

    const ids = new Set();
    if (userFilter) {
      for (const uid of userFilter) ids.add(uid);
    } else {
      for (const R of recs.values()) if (R.seconds > 0) ids.add(R.uid);
      if (roster) for (const id of rosterIds || []) ids.add(id);
    }

    const slackerMembers = [];
    const slackerLog = [];

    // Late notices per member per gaming day; one submitted in time beats one that wasn't
    const noticeOf = new Map();
    for (const n of o.notices || []) {
      const at = z.localToMs(`${n.target_date}T${String(n.target_time || "").slice(0, 5)}`);
      if (!Number.isFinite(at)) continue;
      const key = n.user_id + "|" + z.dateOf(at);
      const prev = noticeOf.get(key);
      if (!prev || n.is_valid || !prev.is_valid) noticeOf.set(key, n);
    }

    for (const uid of ids) {
      let totalSecs = 0, totalSpk = 0, totalStrm = 0, totalMute = 0, totalDeaf = 0;
      let daysLate = 0;
      let daysExcused = 0;
      const usedDevices = new Set();
      let daysOnTime = 0;
      let daysAbsent = 0;
      let totalLateMinutes = 0;
      let totalPenaltyPoints = 0;
      let worstLate = null;

      for (const date of dates) {
        if (date > today) continue;

        const R = recs.get(uid + "|" + date);
        if (R) { totalSecs += R.seconds; totalSpk += R.spk; totalStrm += R.strm; totalMute += R.mute; totalDeaf += R.deaf; R.jd.forEach((d) => usedDevices.add(d)); }
        const dayStartMs = z.startOfDate(date);

        let targetMs = dayStartMs;
        if (tHour < dayStart) {
          targetMs += ((24 - dayStart) + tHour) * 3600e3 + tMin * 60e3;
        } else {
          targetMs += (tHour - dayStart) * 3600e3 + tMin * 60e3;
        }

        const attendedDay = R && R.seconds >= (minSeconds || 300);
        const notice = noticeOf.get(uid + "|" + date);
        const excuse = notice ? `${notice.delay_minutes}m notice: ${notice.reason}${notice.is_valid ? "" : " - sent too late"}` : undefined;
        const excusedMs = notice && notice.is_valid ? notice.delay_minutes * 60000 : 0;

        // Arrival counts from the target time onward: already in voice at the target = arrived at the target,
        // otherwise the first join after it. Time spent before the target (and left) doesn't count.
        let arrival = Infinity;
        if (R) for (const [a, b] of R.iv) if (b > targetMs) arrival = Math.min(arrival, Math.max(a, targetMs));
        const hasArrival = attendedDay && Number.isFinite(arrival);

        // Target (plus grace / announced delay) hasn't passed yet and they're not in: nothing to judge yet
        if (!hasArrival && now < targetMs + graceMs + excusedMs) continue;

        if (!hasArrival) {
          daysAbsent += 1;
          totalPenaltyPoints += 3;
          slackerLog.push({
            date,
            user_id: uid,
            name: nameOf(uid),
            target_time: targetMs,
            actual_time: null,
            status: "absent",
            late_minutes: 0,
            penalty_points: 3,
            excuse,
          });
        } else {
          const firstJoin = arrival;
          const diffMs = firstJoin - targetMs;

          if (diffMs <= graceMs) {
            daysOnTime += 1;
            slackerLog.push({
              date,
              user_id: uid,
              name: nameOf(uid),
              target_time: targetMs,
              actual_time: firstJoin,
              status: "on_time",
              late_minutes: 0,
              penalty_points: 0,
              excuse,
            });
          } else if (excusedMs && diffMs <= excusedMs + graceMs) {
            // Announced beforehand and arrived within the announced delay: no penalty
            daysExcused += 1;
            slackerLog.push({
              date,
              user_id: uid,
              name: nameOf(uid),
              target_time: targetMs,
              actual_time: firstJoin,
              status: "excused",
              late_minutes: Math.round(diffMs / 60000),
              penalty_points: 0,
              excuse,
            });
          } else {
            daysLate += 1;
            // With a valid notice only the minutes beyond the announced delay are penalised
            const lateMin = Math.round((diffMs - excusedMs) / 60000);
            totalLateMinutes += lateMin;
            const points = Math.max(1, Math.ceil(lateMin / 15));
            totalPenaltyPoints += points;

            if (!worstLate || lateMin > worstLate.minutes) {
              worstLate = { date, minutes: lateMin, actual_time: firstJoin };
            }

            slackerLog.push({
              date,
              user_id: uid,
              name: nameOf(uid),
              target_time: targetMs,
              actual_time: firstJoin,
              status: excusedMs ? "late_excess" : "late",
              late_minutes: lateMin,
              penalty_points: points,
              excuse,
            });
          }
        }
      }

      const totalEvaluatedDays = daysLate + daysOnTime + daysExcused + daysAbsent;
      const punctualityPct = totalEvaluatedDays > 0 ? Math.round((daysOnTime / totalEvaluatedDays) * 100) : 0;
      const avgLateMin = daysLate > 0 ? Math.round(totalLateMinutes / daysLate) : 0;

      slackerMembers.push({
        user_id: uid,
        name: nameOf(uid),
        penalty_points: totalPenaltyPoints,
        days_late: daysLate,
        days_on_time: daysOnTime,
        days_excused: daysExcused,
        days_absent: daysAbsent,
        total_speaking_seconds: Math.round(totalSpk),
        talk_ratio_pct: totalSecs > 0 ? Math.round((totalSpk / totalSecs) * 1000) / 10 : 0,
        total_streaming_seconds: Math.round(totalStrm),
        total_muted_seconds: Math.round(totalMute),
        total_deafened_seconds: Math.round(totalDeaf),
        devices: [...usedDevices],
        total_days: totalEvaluatedDays,
        punctuality_pct: punctualityPct,
        avg_late_minutes: avgLateMin,
        total_late_minutes: totalLateMinutes,
        worst_late: worstLate,
      });
    }

    const dayExtras = (l) => {
      const R = recs.get(l.user_id + "|" + l.date);
      l.speaking_seconds = R ? Math.round(R.spk) : 0;
      l.streaming_seconds = R ? Math.round(R.strm) : 0;
      l.muted_seconds = R ? Math.round(R.mute) : 0;
      l.deafened_seconds = R ? Math.round(R.deaf) : 0;
      l.devices = R ? [...R.jd] : [];
    };
    slackerLog.forEach(dayExtras);
    slackerMembers.sort((a, b) => b.penalty_points - a.penalty_points || b.days_late - a.days_late || b.total_late_minutes - a.total_late_minutes);
    slackerMembers.forEach((m, idx) => (m.rank = idx + 1));
    slackerLog.sort((a, b) => b.date.localeCompare(a.date) || b.penalty_points - a.penalty_points);

    return {
      meta: {
        type: "slackers",
        from,
        to,
        dates,
        today,
        period_days: elapsed.length,
        tz: z.tz,
        dayStart: z.dayStartHour,
        target_time: targetTime,
        grace_minutes: graceMinutes,
        generated_at: new Date(now).toISOString(),
        user: userFilter ? [...userFilter].join(",") : null,
        user_count: userFilter ? userFilter.size : null,
        channel: channel || null,
      },
      summary: {
        total_penalties: slackerMembers.reduce((acc, m) => acc + m.penalty_points, 0),
        chief_slacker: slackerMembers[0] && slackerMembers[0].penalty_points > 0 ? slackerMembers[0] : null,
        total_late_occurrences: slackerMembers.reduce((acc, m) => acc + m.days_late, 0),
        avg_punctuality: slackerMembers.length
          ? Math.round(slackerMembers.reduce((acc, m) => acc + m.punctuality_pct, 0) / slackerMembers.length)
          : 0,
      },
      members: slackerMembers,
      log: slackerLog,
    };
  }

  // =========================================================
  // ATTENDANCE REPORT
  // =========================================================
  const attended = (R) => !!R && R.seconds >= minSeconds && R.seconds > 0;
  const ids = new Set();
  if (userFilter) {
    for (const uid of userFilter) ids.add(uid);
  } else {
    for (const R of recs.values()) if (R.seconds > 0) ids.add(R.uid);
    if (roster) for (const id of rosterIds || []) ids.add(id);
  }

  const minutesOf = (ms) => {
    const p = z.partsOf(ms);
    return p.hour * 60 + p.minute;
  };

  const members = [];
  for (const uid of ids) {
    let days = 0, total = 0, sessions = 0, spk = 0, strm = 0, mute = 0, deaf = 0;
    const usedDevices = new Set(), deviceSecs = {};
    const firstMins = [];
    let earliest = null, latest = null, firstAt = Infinity, lastAt = -Infinity, stillIn = false;
    for (const date of dates) {
      const R = recs.get(uid + "|" + date);
      if (!R || R.seconds <= 0) continue;
      total += R.seconds;
      spk += R.spk;
      strm += R.strm;
      mute += R.mute;
      deaf += R.deaf;
      R.jd.forEach((d) => usedDevices.add(d));
      for (const [k, v] of Object.entries(R.dv)) deviceSecs[k] = (deviceSecs[k] || 0) + v;
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

    let longest = 0, run = 0;
    for (const d of elapsed) {
      if (attended(recs.get(uid + "|" + d))) { run += 1; longest = Math.max(longest, run); } else run = 0;
    }
    let current = 0;
    let idx = elapsed.length - 1;
    if (idx >= 0 && elapsed[idx] === today && !attended(recs.get(uid + "|" + today))) idx -= 1;
    for (; idx >= 0 && attended(recs.get(uid + "|" + elapsed[idx])); idx--) current += 1;

    members.push({
      user_id: uid,
      name: nameOf(uid),
      days_attended: days,
      absent_days: Math.max(0, elapsed.length - days),
      attendance_pct: elapsed.length ? Math.round((days / elapsed.length) * 1000) / 10 : null,
      total_seconds: Math.round(total),
      total_speaking_seconds: Math.round(spk),
      talk_ratio_pct: total > 0 ? Math.round((spk / total) * 1000) / 10 : 0,
      total_streaming_seconds: Math.round(strm),
      total_muted_seconds: Math.round(mute),
      total_deafened_seconds: Math.round(deaf),
      devices: [...usedDevices], // voice: apps they joined from
      device_seconds: roundAll(deviceSecs), // online: time per app
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

  const cellOf = (R) =>
    R && R.seconds > 0
      ? { s: Math.round(R.seconds), spk: Math.round(R.spk), ratio: Math.round((R.spk / R.seconds) * 1000) / 10, strm: Math.round(R.strm), mute: Math.round(R.mute), deaf: Math.round(R.deaf), dev: [...R.jd], dvs: roundAll(R.dv), f: R.first, l: R.last, n: R.n, ci: R.ci, co: R.co, op: R.op, i: Math.round(R.st.idle), d: Math.round(R.st.dnd) }
      : null;
  const grid = members.map((m) => ({
    user_id: m.user_id,
    cells: dates.map((d) => cellOf(recs.get(m.user_id + "|" + d))),
  }));

  const log = [];
  for (const R of recs.values()) {
    if (!(R.seconds > 0) || !ids.has(R.uid)) continue;
    log.push({
      date: R.date,
      user_id: R.uid,
      name: nameOf(R.uid),
      attended: attended(R),
      seconds: Math.round(R.seconds),
      speaking_seconds: Math.round(R.spk),
      talk_ratio_pct: Math.round((R.spk / R.seconds) * 1000) / 10,
      streaming_seconds: Math.round(R.strm),
      muted_seconds: Math.round(R.mute),
      deafened_seconds: Math.round(R.deaf),
      devices: [...R.jd],
      device_seconds: roundAll(R.dv),
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

  const pcts = members.map((m) => m.attendance_pct).filter((v) => v != null);
  const summary = {
    members_attended: members.filter((m) => m.days_attended > 0).length,
    members_listed: members.length,
    total_seconds: members.reduce((n, m) => n + m.total_seconds, 0),
    total_speaking_seconds: members.reduce((n, m) => n + m.total_speaking_seconds, 0),
    total_streaming_seconds: members.reduce((n, m) => n + m.total_streaming_seconds, 0),
    total_muted_seconds: members.reduce((n, m) => n + m.total_muted_seconds, 0),
    total_deafened_seconds: members.reduce((n, m) => n + m.total_deafened_seconds, 0),
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
      dayStart: z.dayStartHour,
      min_seconds: minSeconds,
      generated_at: new Date(now).toISOString(),
      channel: channel || null,
      user: userFilter ? [...userFilter].join(",") : null,
      user_count: userFilter ? userFilter.size : null,
    },
    summary,
    members,
    grid,
    log,
  };
}

module.exports = { computeReport };