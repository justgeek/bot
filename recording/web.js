// recording/web.js - the hidden recordings page at /recordings and its API.
// Nothing links to it (not the dashboard, not the bot); you open it by typing the address.
// Set RECORDINGS_KEY to require /recordings?key=... (falls back to DASHBOARD_KEY when only that is set).
const path = require("path");
const store = require("./store");
const drive = require("./drive");
const transcribe = require("./transcribe");
const { IDs, MemberColorOverrides } = require("../config");

module.exports = function registerRecordingsPage(app, client) {
  const requiredKey = () => process.env.RECORDINGS_KEY || process.env.DASHBOARD_KEY || "";
  function guard(req, res, next) {
    const required = requiredKey();
    if (!required || (req.query.key || req.get("x-recordings-key")) === required) return next();
    res.status(404).send("Not found"); // looks like there's nothing here
  }

  const guild = () => client.guilds.cache.get(IDs.guild);
  function person(userId, fallbackName) {
    const m = guild()?.members.cache.get(userId);
    const overrides = MemberColorOverrides || {};
    const override = m && (overrides[m.id] || overrides[m.user.username.toLowerCase()] || overrides[m.displayName.toLowerCase()]);
    return {
      user_id: userId,
      name: m?.displayName || fallbackName || userId,
      color: override || (m?.displayHexColor && m.displayHexColor !== "#000000" ? m.displayHexColor : null),
      avatar: m?.displayAvatarURL({ size: 64, extension: "webp", forceStatic: true }) || null,
    };
  }

  const summary = (r) => {
    const end = r.ended_at ? Date.parse(r.ended_at) : Date.now();
    const prog = r.outputs?.progress || {};
    return {
      id: r.id,
      channel_name: r.channel_name,
      started_at: r.started_at,
      ended_at: r.ended_at,
      duration_ms: end - Date.parse(r.started_at),
      status: r.status,
      speakers: Object.entries(r.speakers || {}).filter(([, s]) => !s.bot)
        .map(([u, s]) => ({ ...person(u, s.name), speaking_ms: s.speaking_ms || 0 }))
        .sort((a, b) => b.speaking_ms - a.speaking_ms),
      has_audio: !!r.outputs?.files?.mix?.id && !r.outputs?.audioDeleted,
      has_transcript: prog.transcript?.state === "done",
      has_summary: prog.summary?.state === "done",
    };
  };

  app.get("/recordings", guard, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "..", "recordings.html"));
  });

  app.get("/api/recordings", guard, async (req, res) => {
    try {
      const rows = await store.listRecordings(300);
      res.set("Cache-Control", "no-store");
      res.json({ recordings: rows.map(summary) });
    } catch (err) {
      console.error("[API] /api/recordings failed:", err);
      res.status(500).json({ error: "recordings_failed" });
    }
  });

  app.get("/api/recordings/search", guard, async (req, res) => {
    try {
      const q = String(req.query.q || "").slice(0, 200);
      const results = q ? await transcribe.search(q, 50) : [];
      res.set("Cache-Control", "no-store");
      res.json({ results: results.map((r) => ({ ...r, name: person(r.user_id, r.name).name })) });
    } catch (err) {
      console.error("[API] /api/recordings/search failed:", err);
      res.status(500).json({ error: "search_failed" });
    }
  });

  app.get("/api/recordings/:id", guard, async (req, res) => {
    try {
      const rec = await store.getRecording(String(req.params.id));
      if (!rec || ["deleted", "discarded"].includes(rec.status)) return res.status(404).json({ error: "not_found" });
      const files = rec.outputs?.files || {};
      const lines = await store.getLines(rec.id);
      res.set("Cache-Control", "no-store");
      res.json({
        ...summary(rec),
        end_reason: rec.end_reason,
        parts: rec.parts,
        events: rec.events || [],
        report: rec.report || null,
        summary_en: rec.summary_en || null,
        summary_ar: rec.summary_ar || null,
        tracks: Object.entries(files.tracks || {}).map(([u, t]) => ({ ...person(u, t.name), has_audio: !!t.id && !rec.outputs?.audioDeleted })),
        folder_url: rec.drive_folder_id ? drive.folderUrl(rec.drive_folder_id) : null,
        lines: lines.map((l) => ({ start_ms: l.start_ms, end_ms: l.end_ms, user_id: l.user_id, name: l.name, text: l.text })),
      });
    } catch (err) {
      console.error("[API] /api/recordings/:id failed:", err);
      res.status(500).json({ error: "recording_failed" });
    }
  });

  // Streams the mix (or one speaker's track) from Drive; passes the Range header through so the player can seek
  app.get("/api/recordings/:id/audio", guard, async (req, res) => {
    try {
      const rec = await store.getRecording(String(req.params.id));
      const files = rec?.outputs?.files || {};
      const track = String(req.query.track || "mix");
      const fileId = track === "mix" ? files.mix?.id : files.tracks?.[track]?.id;
      if (!fileId || rec.outputs?.audioDeleted || !drive.enabled) return res.status(404).send("No audio");
      const upstream = await drive.mediaStream(fileId, req.get("range"));
      const header = (h) => (typeof upstream.headers?.get === "function" ? upstream.headers.get(h) : upstream.headers?.[h]);
      res.status(upstream.status || 200);
      res.set("Content-Type", "audio/ogg");
      res.set("Accept-Ranges", "bytes");
      res.set("Cache-Control", "private, max-age=3600");
      for (const h of ["content-length", "content-range"]) if (header(h)) res.set(h, header(h));
      upstream.data.on("error", () => res.destroy());
      req.on("close", () => upstream.data.destroy?.());
      upstream.data.pipe(res);
    } catch (err) {
      const status = Number(err.status || err.response?.status) || 500;
      if (status === 416) return res.status(416).end();
      console.error("[API] /api/recordings/:id/audio failed:", err.message || err);
      if (!res.headersSent) res.status(502).send("Audio unavailable");
    }
  });
};
