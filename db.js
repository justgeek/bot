// db.js - Supabase logging for voice sessions and member status changes.
// Only two things are stored: voice sessions and online/idle/dnd/offline changes.
// No games, Spotify, or rich presence data is ever written.
const { createClient } = require("@supabase/supabase-js");
const { IDs } = require("./config");

const supabase =
    process.env.SUPABASE_URL && process.env.SUPABASE_KEY
        ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
            auth: { persistSession: false },
        })
        : null;

if (!supabase) {
    console.warn("[DB] SUPABASE_URL / SUPABASE_KEY not set - database logging is disabled.");
}

// The "secret" voice channel is hidden from the public voice log in events.js,
// so it is also kept out of the database and the (public) dashboard.
const UNTRACKED_CHANNELS = new Set([IDs.voice2]);
const isTrackedChannel = (channelId) => !UNTRACKED_CHANNELS.has(channelId);

// Runs tasks for the same key one after another, so a quick leave+join
// for one user can't hit the database out of order.
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

async function logPresence(userId, username, status) {
    if (!supabase) return;
    try {
        const { error } = await supabase
            .from("presence_logs")
            .insert({ user_id: String(userId), username, status });
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

async function _startVoiceSession(userId, username, channelId, channelName) {
    if (!supabase) return;
    try {
        // Never leave two open sessions for the same user.
        await _endVoiceSession(userId);
        const { error } = await supabase.from("voice_sessions").insert({
            user_id: String(userId),
            username,
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

const startVoiceSession = (userId, username, channelId, channelName) =>
    serialize(String(userId), () => _startVoiceSession(userId, username, channelId, channelName));

// Heroku restarts the bot regularly, which can leave sessions open or miss
// joins/leaves. On startup, compare the database with who is actually in voice.
async function reconcileVoiceSessions(client) {
    if (!supabase) return;
    try {
        const guild = client.guilds.cache.get(IDs.guild);
        if (!guild) return;

        const current = new Map(); // userId -> { channelId, username, channelName }
        guild.voiceStates.cache.forEach((vs) => {
            const user = vs.member?.user;
            if (!vs.channelId || !user || user.bot || !isTrackedChannel(vs.channelId)) return;
            current.set(vs.id, {
                channelId: vs.channelId,
                username: user.username,
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
                await startVoiceSession(userId, info.username, info.channelId, info.channelName);
            }
        }
        console.log(`[DB] Voice sessions reconciled (${current.size} user(s) in voice).`);
    } catch (err) {
        console.error("[DB] reconcileVoiceSessions failed:", err.message || err);
    }
}

// ---------- Reads (dashboard) ----------

async function getTotalVoiceSeconds() {
    if (!supabase) return 0;
    try {
        const { data, error } = await supabase.rpc("voice_total_seconds");
        if (error) throw error;
        return Number(data) || 0;
    } catch (err) {
        console.error("[DB] getTotalVoiceSeconds failed:", err.message || err);
        return 0;
    }
}

// days = null means all time.
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

async function getRecentLogs(limit = 30) {
    if (!supabase) return [];
    try {
        const [presence, joins, leaves] = await Promise.all([
            supabase
                .from("presence_logs")
                .select("user_id, username, status, changed_at")
                .order("changed_at", { ascending: false })
                .limit(limit),
            supabase
                .from("voice_sessions")
                .select("user_id, username, channel_name, joined_at")
                .order("joined_at", { ascending: false })
                .limit(limit),
            supabase
                .from("voice_sessions")
                .select("user_id, username, channel_name, left_at, duration_seconds")
                .not("left_at", "is", null)
                .order("left_at", { ascending: false })
                .limit(limit),
        ]);
        for (const r of [presence, joins, leaves]) if (r.error) throw r.error;

        const events = [
            ...presence.data.map((r) => ({
                type: "presence",
                user_id: r.user_id,
                username: r.username,
                status: r.status,
                at: r.changed_at,
            })),
            ...joins.data.map((r) => ({
                type: "voice_join",
                user_id: r.user_id,
                username: r.username,
                channel_name: r.channel_name,
                at: r.joined_at,
            })),
            ...leaves.data.map((r) => ({
                type: "voice_leave",
                user_id: r.user_id,
                username: r.username,
                channel_name: r.channel_name,
                duration_seconds: r.duration_seconds,
                at: r.left_at,
            })),
        ];

        events.sort((a, b) => new Date(b.at) - new Date(a.at));
        return events.slice(0, limit);
    } catch (err) {
        console.error("[DB] getRecentLogs failed:", err.message || err);
        return [];
    }
}

module.exports = {
    isTrackedChannel,
    logPresence,
    startVoiceSession,
    endVoiceSession,
    reconcileVoiceSessions,
    getTotalVoiceSeconds,
    getVoiceLeaderboard,
    getRecentLogs,
};