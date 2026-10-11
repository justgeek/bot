// dashboard.js - dashboard page (GET /) and JSON API (/api/*).
const path = require("path");
const db = require("./db");
const { computeStats } = require("./stats");
const { IDs } = require("./config");

const DAY = 86400e3;
const RANGES = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "365d": 365, all: null };
const ID_RE = /^\d{5,25}$/;
const STATUS_ORDER = { online: 0, idle: 1, dnd: 2 };

module.exports = function registerDashboard(app, client) {
  // Optional protection: set DASHBOARD_KEY on Heroku and open /?key=YOUR_KEY.
  // If it isn't set, the dashboard is public.
  function guard(req, res, next) {
    const required = process.env.DASHBOARD_KEY;
    if (!required) return next();
    const supplied = req.query.key || req.get("x-dashboard-key");
    if (supplied === required) return next();
    res.status(401).send("Unauthorized");
  }

  const getGuild = () => client.guilds.cache.get(IDs.guild);
  // Server nickname if set, otherwise global display name, otherwise username.
  const liveName = (id) => getGuild()?.members.cache.get(id)?.displayName || null;
  const hours = (secs) => Math.round((secs / 3600) * 10) / 10;

  // ---- tiny TTL cache (also shares one in-flight request between viewers) ----
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
    const range = RANGES[req.query.range] !== undefined ? req.query.range : "7d";
    const user = ID_RE.test(req.query.user || "") ? req.query.user : "";
    const channel = ID_RE.test(req.query.channel || "") ? req.query.channel : "";
    return { range, user, channel };
  }

  function loadRange(range) {
    return cached(`range:${range}`, 30000, async () => {
      const days = RANGES[range];
      const since = days ? Date.now() - days * DAY : null;
      const sinceIso = since ? new Date(since).toISOString() : null;
      const [s, p] = await Promise.all([db.getSessionRows(sinceIso), db.getPresenceRows(sinceIso)]);
      return {
        sessionRows: s.rows,
        presenceRows: p.rows,
        truncated: s.truncated || p.truncated,
        since,
      };
    });
  }

  // Plain-text health check (the old root response), handy for uptime pingers.
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
          if (!channels.has(vs.channelId)) {
            channels.set(vs.channelId, {
              channel_id: vs.channelId,
              channel_name: vs.channel?.name || "Voice",
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
      const totalSeconds = await db.getTotalVoiceSeconds();

      res.set("Cache-Control", "no-store");
      res.json({
        server_name: guild?.name || "Discord server",
        bot_ready: client.isReady(),
        bot_uptime_seconds: Math.floor(process.uptime()),
        counts,
        members_online: membersOnline,
        in_voice: inVoice,
        in_voice_count: inVoice.reduce((n, c) => n + c.members.length, 0),
        total_voice_seconds: totalSeconds,
        total_voice_hours: hours(totalSeconds),
      });
    } catch (err) {
      console.error("[API] /api/overview failed:", err);
      res.status(500).json({ error: "overview_failed" });
    }
  });

  // Members and voice channels for the filter dropdowns.
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
          channels.push({ channel_id: c.id, name: c.name, pos: c.rawPosition ?? 0 });
        }
      });
    }
    members.sort((a, b) => a.name.localeCompare(b.name));
    channels.sort((a, b) => a.pos - b.pos);
    res.set("Cache-Control", "no-store");
    res.json({ members, channels: channels.map(({ pos, ...c }) => c) });
  });

  // ---------- Analytics ----------
  app.get("/api/stats", guard, async (req, res) => {
    try {
      const { range, user, channel } = parseFilters(req);
      const out = await cached(`stats:${range}:${user}:${channel}`, 20000, async () => {
        const d = await loadRange(range);
        const result = computeStats({
          sessionRows: d.sessionRows,
          presenceRows: d.presenceRows,
          now: Date.now(),
          since: d.since,
          user,
          channel,
          liveName,
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

  // Individual sessions (newest first), same filters as /api/stats.
  async function sessionList({ range, user, channel }) {
    const d = await loadRange(range);
    const now = Date.now();
    const rows = d.sessionRows
      .filter((r) => (!user || r.user_id === user) && (!channel || r.channel_id === channel))
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
      const rows = await sessionList(parseFilters(req));
      // Prefix cells that start with =,+,-,@ so spreadsheets don't run them as formulas.
      const cell = (v) => {
        let s = String(v ?? "");
        if (/^[=+\-@]/.test(s)) s = "'" + s;
        return `"${s.replace(/"/g, '""')}"`;
      };
      const lines = ["member,username,user_id,channel,joined_at_utc,left_at_utc,duration_seconds"];
      for (const r of rows) {
        lines.push(
          [r.name, r.username, r.user_id, r.channel_name, r.joined_at, r.left_at || "", r.duration_seconds]
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
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
      const user = ID_RE.test(req.query.user || "") ? req.query.user : "";
      const kind = ["presence", "voice"].includes(req.query.type) ? req.query.type : "all";
      const logs = await db.getRecentLogs(limit, { userId: user, kind });
      for (const l of logs) l.name = liveName(l.user_id) || l.display_name || l.username;
      res.set("Cache-Control", "no-store");
      res.json({ logs });
    } catch (err) {
      console.error("[API] /api/recent-logs failed:", err);
      res.status(500).json({ error: "logs_failed" });
    }
  });
};
