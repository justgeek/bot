// dashboard.js - dashboard page (GET /) and JSON API (/api/*).
const path = require("path");
const db = require("./db");
const { IDs } = require("./config");

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
    const hours = (secs) => Math.round((secs / 3600) * 10) / 10;

    // Plain-text health check (the old root response), handy for uptime pingers.
    app.get("/health", (req, res) => {
        res.send("BANHA FOREVER !!!!! BOT IS RUNNING OK");
    });

    app.get("/", guard, (req, res) => {
        res.sendFile(path.join(__dirname, "dashboard.html"));
    });

    app.get("/api/overview", guard, async (req, res) => {
        try {
            const guild = getGuild();
            const counts = { online: 0, idle: 0, dnd: 0, offline: 0 };
            const channels = new Map();

            if (guild) {
                guild.members.cache.forEach((m) => {
                    if (m.user.bot) return;
                    const status = m.presence?.status;
                    counts[status in counts ? status : "offline"]++;
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
                    channels.get(vs.channelId).members.push({ user_id: user.id, username: user.username });
                });
            }

            const inVoice = [...channels.values()].sort((a, b) =>
                a.channel_name.localeCompare(b.channel_name, undefined, { numeric: true })
            );
            const totalSeconds = await db.getTotalVoiceSeconds();

            res.set("Cache-Control", "no-store");
            res.json({
                server_name: guild?.name || "Discord server",
                bot_ready: client.isReady(),
                counts,
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

    app.get("/api/voice-leaderboard", guard, async (req, res) => {
        try {
            const [last7Days, allTime] = await Promise.all([
                db.getVoiceLeaderboard(7, 10),
                db.getVoiceLeaderboard(null, 10),
            ]);
            res.set("Cache-Control", "no-store");
            res.json({ last_7_days: last7Days, all_time: allTime });
        } catch (err) {
            console.error("[API] /api/voice-leaderboard failed:", err);
            res.status(500).json({ error: "leaderboard_failed" });
        }
    });

    app.get("/api/recent-logs", guard, async (req, res) => {
        try {
            const logs = await db.getRecentLogs(30);
            res.set("Cache-Control", "no-store");
            res.json({ logs });
        } catch (err) {
            console.error("[API] /api/recent-logs failed:", err);
            res.status(500).json({ error: "logs_failed" });
        }
    });
};