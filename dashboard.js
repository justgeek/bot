// dashboard.js - dashboard page (GET /) and JSON API (/api/*).
const path = require("path");
const express = require("express");
const Discord = require("discord.js");
const db = require("./db");
const { computeStats, hasDevice } = require("./stats");
const { computeReport } = require("./report");
const { makeTz, validTz, DEFAULT_TZ } = require("./tz");
const config = require("./config");
const audio = require("./audioManager");

const IDs = config.IDs || {};
const MemberColorOverrides = config.MemberColorOverrides || {};
const allowedShareChannels = config.allowedShareChannels || [];

const DAY = 86400e3;
const RANGES = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "365d": 365, all: null };
const ID_RE = /^\d{5,25}$/;
const STATUS_ORDER = { online: 0, idle: 1, dnd: 2 };
const DEVICES = ["desktop", "mobile", "web"]; // device filter values (Discord app: PC / phone / browser)

let lastShareTimestamp = 0;
const SHARE_COOLDOWN_MS = 60 * 1000;

module.exports = function registerDashboard(app, client) {
  function guard(req, res, next) {
    const required = process.env.DASHBOARD_KEY;
    const supplied = req.query.key || req.get("x-dashboard-key");
    if (!required || supplied === required) {
      touchViewer(req);
      return next();
    }
    res.status(401).send("Unauthorized");
  }

  // ---------- Who has the dashboard open (each open page polls every 20s) ----------
  const VIEWER_TTL_MS = 60000;
  const viewers = new Map(); // viewer id -> last seen (ms)
  function touchViewer(req) {
    const vid = req.query.vid;
    if (typeof vid === "string" && /^[\w-]{3,40}$/.test(vid)) viewers.set(vid, Date.now());
  }
  function activeViewers() {
    const cutoff = Date.now() - VIEWER_TTL_MS;
    for (const [vid, at] of viewers) if (at < cutoff) viewers.delete(vid);
    return Math.max(1, viewers.size);
  }

  // Sessions still in progress only get their talk time written at the end, so overlay the live tally
  const withLiveSpeaking = (rows) =>
    rows.map((r) =>
    {
      if (r.left_at) return r;
      const out = { ...r, speaking_seconds: Math.max(Number(r.speaking_seconds) || 0, audio.getLiveSpeakingSeconds(r.user_id)) };
      const live = audio.getLiveFlagSeconds(r.user_id); // streaming / muted / deafened
      for (const k of audio.FLAG_KINDS) out[k + "_seconds"] = Math.max(Number(r[k + "_seconds"]) || 0, live[k]);
      return out;
    });

  const getGuild = () => client.guilds.cache.get(IDs.guild);
  const liveName = (id) => getGuild()?.members.cache.get(id)?.displayName || null;
  const liveStatus = (id) => getGuild()?.members.cache.get(id)?.presence?.status || "offline";
  const hours = (secs) => Math.round((secs / 3600) * 10) / 10;

  const cache = new Map();
  function cached(key, ttlMs, fn) {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < ttlMs) return hit.p;
    const p = fn();
    cache.set(key, { at: now, p });
    p.catch(() => {
      if (cache.get(key)?.p === p) cache.delete(key);
    });
    if (cache.size > 200) {
      for (const [k, v] of cache) if (now - v.at > 300000) cache.delete(k);
    }
    return p;
  }

  function parseFilters(req) {
    const tz = validTz(req.query.tz) || DEFAULT_TZ;
    const dayStart = Math.min(23, Math.max(0, parseInt(req.query.dayStart, 10) || 18));
    let range = Object.prototype.hasOwnProperty.call(RANGES, req.query.range) ? req.query.range : "7d";
    let fromMs = null;
    let toMs = null;
    if (req.query.range === "custom") {
      const z = makeTz(tz, dayStart);
      fromMs = z.localToMs(req.query.from);
      toMs = z.localToMs(req.query.to);
      const good = Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs && toMs - fromMs <= 400 * DAY;
      range = good ? "custom" : "7d";
      if (!good) fromMs = toMs = null;
    }
    // One member id or a comma-separated list of them
    const user = [...new Set(String(req.query.user || "").split(",").map((s) => s.trim()).filter((id) => ID_RE.test(id)))].slice(0, 200).sort().join(",");
    const rawChan = req.query.channel || "";
    let channel = "";
    let includeAfk = false;

    if (rawChan === "__all__") {
      includeAfk = true;
      channel = "";
    } else if (ID_RE.test(rawChan)) {
      channel = rawChan;
      includeAfk = true;
    }

    const status = ["online", "idle", "dnd", "offline"].includes(req.query.status) ? req.query.status : "";
    const device = DEVICES.includes(req.query.device) ? req.query.device : "";
    return { range, user, channel, rawChan, includeAfk, tz, dayStart, status, fromMs, toMs, device };
  }

  function windowOf({ range, fromMs, toMs }) {
    if (range === "custom") return { since: fromMs, until: toMs };
    const days = RANGES[range];
    return { since: days ? Date.now() - days * DAY : null, until: null };
  }

  function loadRange(f) {
    return cached(`range:${f.range}:${f.fromMs}:${f.toMs}`, 30000, async () => {
      const { since, until } = windowOf(f);
      const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
      const [s, p] = await Promise.all([db.getSessionRows(iso(since), iso(until)), db.getPresenceRows(iso(since), iso(until))]);
      return {
        sessionRows: withLiveSpeaking(s.rows),
        presenceRows: p.rows,
        truncated: s.truncated || p.truncated,
        since,
        until,
      };
    });
  }

  app.get("/health", (req, res) => {
    res.send("BANHA FOREVER !!!!! BOT IS RUNNING OK");
  });

  app.get("/", guard, (req, res) => {
    res.sendFile(path.join(__dirname, "dashboard.html"));
  });

  // Voice recordings page: /recordings, deliberately not linked from the dashboard (see recording/web.js)
  require("./recording/web")(app, client);

  // ---------- Live snapshot ----------
  app.get("/api/overview", guard, async (req, res) => {
    try {
      const guild = getGuild();
      const counts = { online: 0, idle: 0, dnd: 0, offline: 0 };
      const channels = new Map();
      const membersOnline = [];

      if (guild) {
        guild.members.cache.forEach((m) => {
          if (m.user.bot) return;
          const status = m.presence?.status;
          const key = status in counts ? status : "offline";
          counts[key]++;
          if (key !== "offline") {
            // devices: which Discord apps they're on right now ("desktop", "mobile", "web")
            membersOnline.push({ user_id: m.id, name: m.displayName, status: key, devices: Object.keys(m.presence?.clientStatus || {}).sort() });
          }
        });

        guild.voiceStates.cache.forEach((vs) => {
          const user = vs.member?.user;
          if (!vs.channelId || !user || user.bot || !db.isTrackedChannel(vs.channelId)) return;
          const isAfk = db.isAfkChannel(vs.channelId, vs.channel?.name, client);

          if (!channels.has(vs.channelId)) {
            channels.set(vs.channelId, {
              channel_id: vs.channelId,
              channel_name: vs.channel?.name || "Voice",
              is_afk: isAfk,
              members: [],
            });
          }
          channels.get(vs.channelId).members.push({
            user_id: user.id,
            username: user.username,
            name: vs.member.displayName,
            devices: Object.keys(vs.member.presence?.clientStatus || {}).sort(),
          });
        });
      }

      membersOnline.sort(
        (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name)
      );
      const inVoice = [...channels.values()].sort((a, b) =>
        a.channel_name.localeCompare(b.channel_name, undefined, { numeric: true })
      );

      const inVoiceActiveCount = inVoice
        .filter((c) => !c.is_afk)
        .reduce((n, c) => n + c.members.length, 0);

      const totalSeconds = await db.getTotalVoiceSeconds(true, client);

      res.set("Cache-Control", "no-store");
      res.json({
        server_name: guild?.name || "Discord server",
        server_icon: guild?.iconURL?.({ size: 128, extension: "png", forceStatic: true }) || null,
        bot_ready: client.isReady(),
        bot_uptime_seconds: Math.floor(process.uptime()),
        counts,
        members_online: membersOnline,
        in_voice: inVoice,
        in_voice_count: inVoiceActiveCount,
        total_voice_seconds: totalSeconds,
        total_voice_hours: hours(totalSeconds),
        active_viewers: activeViewers(),
      });
    } catch (err) {
      console.error("[API] /api/overview failed:", err);
      res.status(500).json({ error: "overview_failed" });
    }
  });

  // Channels & members for filter dropdowns with live Discord channel names
  app.get("/api/filters", guard, (req, res) => {
    const guild = getGuild();
    const members = [];
    const channels = [];
    const roles = [];
    if (guild) {
      guild.members.cache.forEach((m) => {
        if (!m.user.bot) members.push({ user_id: m.id, name: m.displayName });
      });
      // Roles with a real name only: skips @everyone and the "." roles that exist just to colour members
      guild.roles.cache.forEach((r) => {
        if (r.id === guild.id || !/[\p{L}\p{N}]/u.test(r.name)) return;
        const memberIds = [];
        r.members.forEach((m) => { if (!m.user.bot) memberIds.push(m.id); });
        if (memberIds.length) roles.push({ id: r.id, name: r.name, color: r.color ? r.hexColor : null, member_ids: memberIds, pos: r.position });
      });
      roles.sort((a, b) => b.pos - a.pos);
      guild.channels.cache.forEach((c) => {
        if (c.isVoiceBased?.() && db.isTrackedChannel(c.id)) {
          const isAfk = db.isAfkChannel(c.id, c.name, client);
          channels.push({ channel_id: c.id, name: c.name, is_afk: isAfk, pos: c.rawPosition ?? 0 });
        }
      });
    }
    members.sort((a, b) => a.name.localeCompare(b.name));
    channels.sort((a, b) => a.pos - b.pos);

    const dynamicShareChannels = (allowedShareChannels || []).map((ch) => {
      const liveChan = client.channels.cache.get(ch.id);
      return {
        id: ch.id,
        name: liveChan ? `#${liveChan.name}` : (ch.name || `#${ch.id}`)
      };
    });

    res.set("Cache-Control", "no-store");
    res.json({
      members,
      channels: channels.map(({ pos, ...c }) => c),
      roles: roles.map(({ pos, ...r }) => r),
      share_channels: dynamicShareChannels
    });
  });

  // ---------- Analytics ----------
  app.get("/api/stats", guard, async (req, res) => {
    try {
      const f = parseFilters(req);
      const { range, user, channel, includeAfk, tz, dayStart, status, device } = f;
      const key = `stats:${range}:${f.fromMs}:${f.toMs}:${user}:${channel}:${includeAfk}:${tz}:${dayStart}:${status}:${device}`;
      const out = await cached(key, 20000, async () => {
        const d = await loadRange(f);
        const result = computeStats({
          sessionRows: d.sessionRows,
          presenceRows: d.presenceRows,
          now: d.until ? Math.min(Date.now(), d.until) : Date.now(),
          since: d.since,
          user,
          channel,
          includeAfk,
          liveName,
          liveStatus,
          tz,
          dayStart,
          status,
          client,
          device,
        });
        result.meta.range = range;
        result.meta.truncated = d.truncated;
        result.meta.generated_at = new Date().toISOString();
        return result;
      });
      res.set("Cache-Control", "no-store");
      res.json(out);
    } catch (err) {
      console.error("[API] /api/stats failed:", err);
      res.status(500).json({ error: "stats_failed" });
    }
  });

  async function sessionList(f) {
    const { channel, includeAfk } = f;
    const user = f.user ? new Set(f.user.split(",")) : null;
    const d = await loadRange(f);
    const now = Date.now();
    const rows = d.sessionRows
      .filter((r) => {
        if (user && !user.has(r.user_id)) return false;
        if (channel && r.channel_id !== channel) return false;
        if (!includeAfk && !channel && db.isAfkChannel(r.channel_id, r.channel_name, client)) return false;
        if (f.device && !hasDevice(r.devices, f.device)) return false;
        return true;
      })
      .map((r) => {
        const start = Date.parse(r.joined_at);
        const end = r.left_at ? Date.parse(r.left_at) : now;
        return {
          user_id: r.user_id,
          name: liveName(r.user_id) || r.display_name || r.username,
          username: r.username,
          channel_name: r.channel_name || "Voice",
          joined_at: r.joined_at,
          left_at: r.left_at,
          duration_seconds: Math.max(0, Math.round((end - start) / 1000)),
          speaking_seconds: Number(r.speaking_seconds) || 0,
          streaming_seconds: Number(r.streaming_seconds) || 0,
          devices: r.devices || null,
          muted_seconds: Number(r.muted_seconds) || 0,
          deafened_seconds: Number(r.deafened_seconds) || 0,
          open: !r.left_at,
        };
      });
    rows.sort((a, b) => Date.parse(b.joined_at) - Date.parse(a.joined_at));
    return rows;
  }

  app.get("/api/sessions", guard, async (req, res) => {
    try {
      const f = parseFilters(req);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
      const rows = await sessionList(f);
      res.set("Cache-Control", "no-store");
      res.json({ total: rows.length, rows: rows.slice(0, limit) });
    } catch (err) {
      console.error("[API] /api/sessions failed:", err);
      res.status(500).json({ error: "sessions_failed" });
    }
  });

  app.get("/api/sessions.csv", guard, async (req, res) => {
    try {
      const filters = parseFilters(req);
      const rows = await sessionList(filters);
      const local = new Intl.DateTimeFormat("en-CA", { timeZone: filters.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      const fmtLocal = (iso) => (iso ? local.format(new Date(iso)).replace(",", "") : "");
      const cell = (v) => {
        let s = String(v ?? "");
        if (/^[=+\-@]/.test(s)) s = "'" + s;
        return `"${s.replace(/"/g, '""')}"`;
      };
      const lines = [`member,username,user_id,channel,joined_local (${filters.tz}),left_local (${filters.tz}),joined_at_utc,left_at_utc,duration_seconds,speaking_seconds,streaming_seconds,muted_seconds,deafened_seconds,joined_from`];
      for (const r of rows) {
        lines.push(
          [r.name, r.username, r.user_id, r.channel_name, fmtLocal(r.joined_at), fmtLocal(r.left_at), r.joined_at, r.left_at || "", r.duration_seconds, r.speaking_seconds, r.streaming_seconds, r.muted_seconds, r.deafened_seconds, r.devices || ""]
            .map(cell)
            .join(",")
        );
      }
      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", 'attachment; filename="voice-sessions.csv"');
      res.send("\uFEFF" + lines.join("\n"));
    } catch (err) {
      console.error("[API] /api/sessions.csv failed:", err);
      res.status(500).send("export failed");
    }
  });

  app.get("/api/people", guard, (req, res) => {
    const guild = getGuild();
    const people = {};
    const overrides = MemberColorOverrides || {};
    if (guild) {
      guild.members.cache.forEach((m) => {
        if (m.user.bot) return;
        const override = overrides[m.id] || overrides[m.user.username.toLowerCase()] || overrides[m.displayName.toLowerCase()];
        const color = override || (m.displayHexColor && m.displayHexColor !== "#000000" ? m.displayHexColor : null);
        people[m.id] = {
          name: m.displayName,
          color,
          avatar: m.displayAvatarURL({ size: 64, extension: "webp", forceStatic: true }),
        };
      });
    }
    res.set("Cache-Control", "no-store");
    res.json({ people });
  });

  // ---------- Attendance & Slacker Reports ----------
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const validDate = (s) => {
    if (!DATE_RE.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  };
  const MAX_REPORT_DAYS = 92;

  app.get("/api/report", guard, async (req, res) => {
    try {
      const tz = validTz(req.query.tz) || DEFAULT_TZ;
      const dayStart = Math.min(23, Math.max(0, parseInt(req.query.dayStart, 10) || 18));
      const type = ["presence", "slackers"].includes(req.query.type) ? req.query.type : "voice";
      const z = makeTz(tz, dayStart);
      // from=all: from the first recorded activity up to today, with no day cap
      const allTime = req.query.from === "all";
      let from = String(req.query.from || "");
      let to = String(req.query.to || "");
      if (allTime) {
        to = z.dateOf(Date.now());
        const firstMs = await db.getFirstActivityMs();
        from = firstMs ? z.dateOf(firstMs) : to;
      }
      if (!validDate(from) || !validDate(to) || from > to) return res.status(400).json({ error: "bad_dates" });

      let days = 0;
      for (let d = from; d <= to && days <= MAX_REPORT_DAYS; d = z.addDays(d, 1)) days++;
      if (!allTime && days > MAX_REPORT_DAYS) return res.status(400).json({ error: "range_too_long", max_days: MAX_REPORT_DAYS });

      const rawUser = req.query.user || req.query.users || "";
      let userList = [];
      if (Array.isArray(rawUser)) {
        userList = rawUser.filter((id) => ID_RE.test(id));
      } else if (typeof rawUser === "string" && rawUser.trim()) {
        userList = rawUser.split(",").map((s) => s.trim()).filter((id) => ID_RE.test(id));
      }
      const userParam = userList.join(",");

      const rawChan = req.query.channel || "";
      let channel = "";
      let includeAfk = false;
      if (rawChan === "__all__") {
        includeAfk = true;
      } else if (ID_RE.test(rawChan)) {
        channel = rawChan;
        includeAfk = true;
      }

      const minMinutes = Math.min(Math.max(parseInt(req.query.min, 10) || 0, 0), 600);
      const mode = ["active", "idle", "dnd"].includes(req.query.mode) ? req.query.mode : "online";
      const roster = req.query.roster !== "0";
      const targetTime = req.query.targetTime || "21:00";
      const graceMinutes = parseInt(req.query.grace, 10) || 15;
      const device = DEVICES.includes(req.query.device) ? req.query.device : "";

      const key = `report:${type}:${from}:${to}:${tz}:${dayStart}:${userParam}:${channel}:${includeAfk}:${minMinutes}:${mode}:${roster}:${targetTime}:${graceMinutes}:${device}`;
      const out = await cached(key, 20000, async () => {
        const fromMs = z.startOfDate(from);
        const toMs = z.startOfDate(z.addDays(to, 1));
        const none = { rows: [], truncated: false };
        const [s, p, notices] = await Promise.all([
          type === "voice" || type === "slackers" ? db.getSessionRows(new Date(fromMs).toISOString(), new Date(toMs).toISOString()) : none,
          type === "presence" ? db.getPresenceRows(new Date(fromMs - 14 * DAY).toISOString(), new Date(toMs).toISOString()) : none,
          // a gaming day runs past midnight, so its notices can carry the next calendar date
          type === "slackers" ? db.getLateNotices(z.addDays(from, -1), z.addDays(to, 1)) : [],
        ]);
        s.rows = withLiveSpeaking(s.rows);
        const rosterIds = [];
        const guild = getGuild();
        if (roster && guild) guild.members.cache.forEach((m) => { if (!m.user.bot) rosterIds.push(m.id); });

        const result = computeReport({
          type, sessionRows: s.rows, presenceRows: p.rows, from, to, tz, dayStart,
          user: userList, channel, includeAfk,
          minSeconds: minMinutes * 60, mode, roster, rosterIds, now: Date.now(), liveName, liveStatus, client,
          targetTime, graceMinutes, notices, device,
        });
        result.meta.truncated = s.truncated || p.truncated;
        return result;
      });
      res.set("Cache-Control", "no-store");
      res.json(out);
    } catch (err) {
      console.error("[API] /api/report failed:", err);
      res.status(500).json({ error: "report_failed" });
    }
  });

  app.get("/api/voice-leaderboard", guard, async (req, res) => {
    try {
      const [last7Days, allTime] = await Promise.all([
        db.getVoiceLeaderboard(7, 10),
        db.getVoiceLeaderboard(null, 10),
      ]);
      const withName = (r) => ({ ...r, display_name: liveName(r.user_id) || r.display_name });
      res.set("Cache-Control", "no-store");
      res.json({ last_7_days: last7Days.map(withName), all_time: allTime.map(withName) });
    } catch (err) {
      console.error("[API] /api/voice-leaderboard failed:", err);
      res.status(500).json({ error: "leaderboard_failed" });
    }
  });

  app.get("/api/recent-logs", guard, async (req, res) => {
    try {
      const f = parseFilters(req);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 300);
      const kind = ["presence", "voice"].includes(req.query.type) ? req.query.type : "all";
      const { since, until } = windowOf(f);
      const logs = await db.getRecentLogs(limit, {
        userId: f.user,
        channelId: f.channel,
        status: f.status,
        device: f.device,
        kind,
        sinceIso: since ? new Date(since).toISOString() : null,
        untilIso: until ? new Date(until).toISOString() : null,
      });
      for (const l of logs) l.name = liveName(l.user_id) || l.display_name || l.username;
      res.set("Cache-Control", "no-store");
      res.json({ logs });
    } catch (err) {
      console.error("[API] /api/recent-logs failed:", err);
      res.status(500).json({ error: "logs_failed" });
    }
  });

  // ---------- Submitted late / absence notices ----------
  app.get("/api/late-notices", guard, async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 1), 1000);
      const serverTz = makeTz(DEFAULT_TZ, 0);
      const rows = await db.listLateNotices(limit);
      const notices = rows.map((r) => {
        // Targets are stored on the server clock; send absolute ms so the viewer formats them in their own timezone
        const targetMs = serverTz.localToMs(`${r.target_date}T${String(r.target_time || "").slice(0, 5)}`);
        const submittedMs = Date.parse(r.submitted_at);
        const delay = Number(r.delay_minutes) || 0;
        return {
          id: r.id,
          user_id: r.user_id,
          name: liveName(r.user_id) || r.display_name || r.username,
          username: r.username,
          type: delay > 0 ? "late" : "absent",
          delay_minutes: delay,
          reason: r.reason,
          target_ms: Number.isFinite(targetMs) ? targetMs : null,
          expected_ms: Number.isFinite(targetMs) && delay > 0 ? targetMs + delay * 60000 : null,
          submitted_ms: Number.isFinite(submittedMs) ? submittedMs : null,
          // same rule the slacker report uses: valid only if sent before its own start time
          is_valid: Number.isFinite(submittedMs) && Number.isFinite(targetMs) ? submittedMs < targetMs : !!r.is_valid,
        };
      });
      res.set("Cache-Control", "no-store");
      res.json({ notices });
    } catch (err) {
      console.error("[API] /api/late-notices failed:", err);
      res.status(500).json({ error: err.message || "late_notices_failed" });
    }
  });

  // ---------- Late notice: "I'll be X minutes late", announced in chat ----------
  // Only waives slacker penalties when it is submitted before the target start time.
  app.post("/api/late-notice", guard, express.json({ limit: "20kb" }), async (req, res) => {
    try {
      const body = req.body || {};
      const userId = String(body.userId || "");
      const member = ID_RE.test(userId) ? getGuild()?.members.cache.get(userId) : null;
      if (!member || member.user.bot) return res.status(400).json({ error: "Unknown member" });

      const tz = validTz(body.tz) || DEFAULT_TZ;
      const targetMs = makeTz(tz, 0).localToMs(body.targetAt);
      if (!Number.isFinite(targetMs)) return res.status(400).json({ error: "Pick a valid target date and time" });
      const now = Date.now();
      if (Math.abs(targetMs - now) > 30 * DAY) return res.status(400).json({ error: "Target time must be within 30 days" });

      // absent = won't come at all that night, stored as delay 0
      const absent = body.absent === true;
      const delayMinutes = absent ? 0 : parseInt(body.delayMinutes, 10);
      if (!absent && !(delayMinutes >= 1 && delayMinutes <= 720)) return res.status(400).json({ error: "Delay must be between 1 and 720 minutes" });
      const reason = String(body.reason || "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!reason) return res.status(400).json({ error: "Please enter a reason" });

      const isValid = now < targetMs;
      // Store the target on the server clock so every report reads the same moment
      const sp = makeTz(DEFAULT_TZ, 0).partsOf(targetMs);
      const notice = await db.addLateNotice({
        userId,
        username: member.user.username,
        displayName: member.displayName,
        targetDate: sp.date,
        targetTime: String(sp.hour).padStart(2, "0") + ":" + String(sp.minute).padStart(2, "0"),
        delayMinutes,
        reason,
        isValid,
      });
      for (const k of cache.keys()) if (k.startsWith("report:")) cache.delete(k);

      const unix = (ms) => Math.floor(ms / 1000);
      const text =
        (absent
          ? `📝 **Absence notice** - <@${userId}> won't make it for <t:${unix(targetMs)}:F>.\n`
          : `📝 **Late notice** - <@${userId}> will be about **${delayMinutes} min** late for <t:${unix(targetMs)}:F>` +
            ` (expected around <t:${unix(targetMs + delayMinutes * 60000)}:t>).\n`) +
        `> ${reason.replace(/[\\*_~`|>@]/g, "\\$&")}\n` +
        (isValid
          ? absent
            ? "✅ Submitted before the start time - excused, no penalty."
            : "✅ Submitted before the start time - late penalty waived up to that delay."
          : "⚠️ Submitted after the start time - recorded, but the penalty still counts.");
      let announced = false;
      try {
        const channelId = IDs.channelLateNotice || IDs.channelMain;
        const channel = client.channels.cache.get(channelId) || (await client.channels.fetch(channelId));
        await channel.send({ content: text, allowedMentions: { parse: [] } });
        announced = true;
      } catch (err) {
        console.error("[API] late notice announce failed:", err.message || err);
      }

      res.json({ success: true, notice, announced });
    } catch (err) {
      console.error("[API] /api/late-notice failed:", err);
      res.status(500).json({ error: err.message || "late_notice_failed" });
    }
  });

  // ---------- Share snapshot to Discord (1-min cooldown) ----------
  app.post("/api/share-discord", guard, express.json({ limit: "15mb" }), async (req, res) => {
    const now = Date.now();
    const elapsed = now - lastShareTimestamp;
    if (elapsed < SHARE_COOLDOWN_MS) {
      const remainingSeconds = Math.ceil((SHARE_COOLDOWN_MS - elapsed) / 1000);
      return res.status(429).json({ error: "cooldown", remainingSeconds });
    }

    const { channelId, title, summary, url, imageData } = req.body || {};
    const allowed = (allowedShareChannels || []).some((c) => c.id === channelId);
    if (!allowed) {
      return res.status(400).json({ error: "channel_not_allowed" });
    }

    let targetChannel = client.channels.cache.get(channelId);
    if (!targetChannel) {
      targetChannel = await client.channels.fetch(channelId).catch(() => null);
    }

    if (!targetChannel || !targetChannel.isTextBased()) {
      return res.status(404).json({ error: "channel_not_found" });
    }

    try {
      const files = [];
      const safeUrl = typeof url === "string" && /^https?:\/\/[^\s<>]+$/.test(url) && url.length < 1500 ? url : "";
      const cleanUrl = safeUrl ? `<${safeUrl}>` : "";
      const safeTitle = String(title || "📊 Banha Bot Report Snapshot").slice(0, 250);

      let embed = new Discord.EmbedBuilder()
        .setTitle(safeTitle)
        .setDescription(
          `${String(summary || "Here is a snapshot of the dashboard.").slice(0, 1500)}` +
          (safeUrl ? `\n\n🔗 **[Open the dashboard with these filters](${safeUrl})**` : "")
        )
        .setColor(0xdc143c)
        .setTimestamp();
      if (safeUrl) embed.setURL(safeUrl);

      if (imageData && typeof imageData === "string" && imageData.startsWith("data:image/")) {
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        const attachment = new Discord.AttachmentBuilder(buffer, { name: "report-snapshot.png" });
        files.push(attachment);
        embed.setImage("attachment://report-snapshot.png");
      }

      await targetChannel.send({
        content: `📊 **${safeTitle}**${cleanUrl ? `\n${cleanUrl}` : ""}`,
        embeds: [embed],
        files: files,
        allowedMentions: { parse: [] },
      });

      lastShareTimestamp = Date.now();
      res.json({ success: true, channelName: targetChannel.name });
    } catch (err) {
      console.error("[API] /api/share-discord failed:", err);
      res.status(500).json({ error: "discord_send_failed", details: err.message });
    }
  });
};