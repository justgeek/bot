// dashboard.js - dashboard page (GET /) and JSON API (/api/*).
const path = require("path");
const Discord = require("discord.js");
const db = require("./db");
const { computeStats } = require("./stats");
const { computeReport } = require("./report");
const { makeTz, validTz, DEFAULT_TZ } = require("./tz");
const { IDs, MemberColorOverrides, allowedShareChannels } = require("./config");

const DAY = 86400e3;
const RANGES = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "365d": 365, all: null };
const ID_RE = /^\d{5,25}$/;
const STATUS_ORDER = { online: 0, idle: 1, dnd: 2 };

// 3-minute rate limiting for Discord report sharing
let lastShareTimestamp = 0;
const SHARE_COOLDOWN_MS = 3 * 60 * 1000;

module.exports = function registerDashboard(app, client) {
  function guard(req, res, next) {
    const required = process.env.DASHBOARD_KEY;
    if (!required) return next();
    const supplied = req.query.key || req.get("x-dashboard-key");
    if (supplied === required) return next();
    res.status(401).send("Unauthorized");
  }

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
    const dayStart = Math.min(23, Math.max(0, parseInt(req.query.dayStart, 10) || 0));
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
    const user = ID_RE.test(req.query.user || "") ? req.query.user : "";
    const rawChan = req.query.channel || "";
    let channel = "";
    let includeAfk = false;

    if (rawChan === "__all__") {
      includeAfk = true;
      channel = "";
    } else if (ID_RE.test(rawChan)) {
      channel = rawChan;
      includeAfk = true; // explicitly picked channel
    }

    const status = ["online", "idle", "dnd", "offline"].includes(req.query.status) ? req.query.status : "";
    return { range, user, channel, rawChan, includeAfk, tz, dayStart, status, fromMs, toMs };
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
        sessionRows: s.rows,
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
            membersOnline.push({ user_id: m.id, name: m.displayName, status: key });
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
          });
        });
      }

      membersOnline.sort(
        (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name)
      );
      const inVoice = [...channels.values()].sort((a, b) =>
        a.channel_name.localeCompare(b.channel_name, undefined, { numeric: true })
      );

      // In-voice count excludes members idling in the AFK channel
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
      });
    } catch (err) {
      console.error("[API] /api/overview failed:", err);
      res.status(500).json({ error: "overview_failed" });
    }
  });

  // Channels & members for filter dropdowns
  app.get("/api/filters", guard, (req, res) => {
    const guild = getGuild();
    const members = [];
    const channels = [];
    if (guild) {
      guild.members.cache.forEach((m) => {
        if (!m.user.bot) members.push({ user_id: m.id, name: m.displayName });
      });
      guild.channels.cache.forEach((c) => {
        if (c.isVoiceBased?.() && db.isTrackedChannel(c.id)) {
          const isAfk = db.isAfkChannel(c.id, c.name, client);
          channels.push({ channel_id: c.id, name: c.name, is_afk: isAfk, pos: c.rawPosition ?? 0 });
        }
      });
    }
    members.sort((a, b) => a.name.localeCompare(b.name));
    channels.sort((a, b) => a.pos - b.pos);
    res.set("Cache-Control", "no-store");
    res.json({
      members,
      channels: channels.map(({ pos, ...c }) => c),
      share_channels: allowedShareChannels || []
    });
  });

  // ---------- Analytics ----------
  app.get("/api/stats", guard, async (req, res) => {
    try {
      const f = parseFilters(req);
      const { range, user, channel, includeAfk, tz, dayStart, status } = f;
      const key = `stats:${range}:${f.fromMs}:${f.toMs}:${user}:${channel}:${includeAfk}:${tz}:${dayStart}:${status}`;
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
    const { user, channel, includeAfk } = f;
    const d = await loadRange(f);
    const now = Date.now();
    const rows = d.sessionRows
      .filter((r) => {
        if (user && r.user_id !== user) return false;
        if (channel && r.channel_id !== channel) return false;
        if (!includeAfk && !channel && db.isAfkChannel(r.channel_id, r.channel_name, client)) return false;
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
      const lines = [`member,username,user_id,channel,joined_local (${filters.tz}),left_local (${filters.tz}),joined_at_utc,left_at_utc,duration_seconds`];
      for (const r of rows) {
        lines.push(
          [r.name, r.username, r.user_id, r.channel_name, fmtLocal(r.joined_at), fmtLocal(r.left_at), r.joined_at, r.left_at || "", r.duration_seconds]
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

  // Role color + avatar with support for MemberColorOverrides
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

  // ---------- Attendance reports ----------
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
      const dayStart = Math.min(23, Math.max(0, parseInt(req.query.dayStart, 10) || 0));
      const type = req.query.type === "presence" ? "presence" : "voice";
      const from = String(req.query.from || "");
      const to = String(req.query.to || "");
      if (!validDate(from) || !validDate(to) || from > to) return res.status(400).json({ error: "bad_dates" });

      const z = makeTz(tz, dayStart);
      let days = 0;
      for (let d = from; d <= to && days <= MAX_REPORT_DAYS; d = z.addDays(d, 1)) days++;
      if (days > MAX_REPORT_DAYS) return res.status(400).json({ error: "range_too_long", max_days: MAX_REPORT_DAYS });

      const user = ID_RE.test(req.query.user || "") ? req.query.user : "";
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

      const key = `report:${type}:${from}:${to}:${tz}:${dayStart}:${user}:${channel}:${includeAfk}:${minMinutes}:${mode}:${roster}`;
      const out = await cached(key, 20000, async () => {
        const fromMs = z.startOfDate(from);
        const toMs = z.startOfDate(z.addDays(to, 1));
        const none = { rows: [], truncated: false };
        const [s, p] = await Promise.all([
          type === "voice" ? db.getSessionRows(new Date(fromMs).toISOString(), new Date(toMs).toISOString()) : none,
          type === "presence" ? db.getPresenceRows(new Date(fromMs - 14 * DAY).toISOString(), new Date(toMs).toISOString()) : none,
        ]);
        const rosterIds = [];
        const guild = getGuild();
        if (roster && !user && guild) guild.members.cache.forEach((m) => { if (!m.user.bot) rosterIds.push(m.id); });
        const result = computeReport({
          type, sessionRows: s.rows, presenceRows: p.rows, from, to, tz, dayStart, user, channel, includeAfk,
          minSeconds: minMinutes * 60, mode, roster, rosterIds, now: Date.now(), liveName, liveStatus, client,
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

  // ---------- Share snapshot to Discord (3-min cooldown) ----------
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

    const targetChannel = client.channels.cache.get(channelId);
    if (!targetChannel || !targetChannel.isTextBased()) {
      return res.status(404).json({ error: "channel_not_found" });
    }

    try {
      const files = [];
      let embed = new Discord.EmbedBuilder()
        .setTitle(title || "📊 Banha Bot Report Snapshot")
        .setDescription(
          `${summary || "Here is a snapshot of the dashboard."}\n\n🔗 **Open with Active Filters:**\n<${url}>`
        )
        .setColor(0x5865f2)
        .setTimestamp();

      if (imageData && typeof imageData === "string" && imageData.startsWith("data:image/")) {
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        files.push({ attachment: buffer, name: "report-snapshot.png" });
        embed.setImage("attachment://report-snapshot.png");
      }

      await targetChannel.send({
        embeds: [embed],
        files: files,
        flags: [Discord.MessageFlags.SuppressEmbeds],
      });

      lastShareTimestamp = Date.now();
      res.json({ success: true, channelName: targetChannel.name });
    } catch (err) {
      console.error("[API] /api/share-discord failed:", err);
      res.status(500).json({ error: "discord_send_failed", details: err.message });
    }
  });
};