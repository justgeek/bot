// recording/web.js - the recordings page at /recordings and its API.
// The dashboard's sidebar links to it, passing on the dashboard's ?key=.
// Set RECORDINGS_KEY to require /recordings?key=... (falls back to DASHBOARD_KEY when only that is set).
const fs = require("fs");
const path = require("path");
const store = require("./store");
const { peaksFromOgg, binsFor } = require("./peaks");
const { WORK_DIR, participants } = require("./util");
const drive = require("./drive");
const transcribe = require("./transcribe");
const processor = require("./processor");
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
      // Who talked and who only used TTS/memes, most talk first
      speakers: Object.entries(participants(r))
        .map(([u, p]) => ({ ...person(u, p.name), speaking_ms: p.speaking_ms, sound_ms: p.sound_ms }))
        .sort((a, b) => b.speaking_ms - a.speaking_ms || b.sound_ms - a.sound_ms),
      has_audio: !!r.outputs?.files?.mix?.id && !r.outputs?.audioDeleted,
      has_transcript: prog.transcript?.state === "done",
      has_summary: prog.summary?.state === "done",
      // Each step's { state, detail } while it's being made (same as the panel in #record)
      progress: ["processing", "paused", "failed"].includes(r.status) ? {
        audio: prog.audio || null,
        transcript: r.options?.transcribe ? prog.transcript || null : { state: "off" },
        summary: r.options?.summarize ? prog.summary || null : { state: "off" },
        queued: r.status === "processing" && !processor.liveRecording(r.id),
        error: r.status === "failed" ? r.error || null : null,
      } : null,
    };
  };
  // The one being processed right now has newer progress in memory than in the database
  const fresh = (r) => (r && processor.liveRecording(r.id)) || r;

  app.get("/recordings", guard, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "..", "recordings.html"));
  });

  app.get("/api/recordings", guard, async (req, res) => {
    try {
      const rows = await store.listRecordings(300);
      res.set("Cache-Control", "no-store");
      res.json({ recordings: rows.map((r) => summary(fresh(r))) });
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
      const live = processor.liveRecording(String(req.params.id));
      const rec = live || (await store.getRecording(String(req.params.id), { fresh: true }));
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
        aliases: rec.outputs?.aliases || {},
        // Names for everyone in the activity log, including who joined but never talked
        people: [...new Map((rec.events || []).filter((e) => e.user).map((e) => [e.user, rec.speakers?.[e.user]?.name || files.tracks?.[e.user]?.name || e.name])).entries()].map(([u, name]) => person(u, name)),
        tracks: Object.entries(files.tracks || {}).map(([u, t]) => ({ ...person(u, t.name), has_audio: !!t.id && !rec.outputs?.audioDeleted })),
        folder_url: rec.drive_folder_id ? drive.folderUrl(rec.drive_folder_id) : null,
        lines: lines.map((l) => ({ start_ms: l.start_ms, end_ms: l.end_ms, user_id: l.user_id, name: l.name, text: l.text })),
        // "Who's talking" lanes under the waveform: each person's speech, pauses under 2 s joined
        activity: Object.fromEntries(
          Object.entries(rec.outputs?.speech || {}).map(([u, iv]) => {
            const runs = [];
            for (const [s, e] of iv) {
              const last = runs[runs.length - 1];
              if (last && s - last[1] < 2000) last[1] = e;
              else runs.push([s, e]);
            }
            return [u, runs];
          })
        ),
        has_peaks: !!rec.outputs?.peaks,
      });
    } catch (err) {
      console.error("[API] /api/recordings/:id failed:", err);
      res.status(500).json({ error: "recording_failed" });
    }
  });

  // Polled by the page while a recording is being processed (cheap: no transcript lines)
  app.get("/api/recordings/:id/progress", guard, async (req, res) => {
    try {
      const rec = fresh(await store.getRecording(String(req.params.id)));
      if (!rec || ["deleted", "discarded"].includes(rec.status)) return res.status(404).json({ error: "not_found" });
      const s = summary(rec);
      res.set("Cache-Control", "no-store");
      res.json({ status: s.status, progress: s.progress, has_audio: s.has_audio, has_transcript: s.has_transcript, has_summary: s.has_summary });
    } catch (err) {
      console.error("[API] /api/recordings/:id/progress failed:", err);
      res.status(500).json({ error: "progress_failed" });
    }
  });

  // Streams the mix (or one speaker's track) from Drive; passes the Range header through so the player can seek
  // The player's waveform. Made while processing; recordings from before that get it made once here
  // (the mix is fetched from Drive and read, then the result is saved)
  const peaksJobs = new Map();
  app.get("/api/recordings/:id/peaks", guard, async (req, res) => {
    try {
      const rec = await store.getRecording(String(req.params.id));
      if (!rec) return res.status(404).json({ error: "not_found" });
      const durationMs = Date.parse(rec.ended_at) - Date.parse(rec.started_at);
      // Missing, or the coarser kind made before zooming existed
      if (!rec.outputs?.peaks || rec.outputs.peaks.length < binsFor(durationMs) * 0.9) {
        const mixId = rec.outputs?.files?.mix?.id;
        if (!mixId || rec.outputs?.audioDeleted || !drive.enabled) return res.json({ peaks: rec.outputs?.peaks || null });
        if (!peaksJobs.has(rec.id)) {
          peaksJobs.set(rec.id, (async () => {
            const file = path.join(WORK_DIR, `peaks_${rec.id}.ogg`);
            fs.mkdirSync(WORK_DIR, { recursive: true });
            try {
              await drive.download(mixId, file);
              rec.outputs.peaks = peaksFromOgg(file, durationMs);
              await store.saveRecording(rec);
            } finally {
              fs.unlink(file, () => { });
              peaksJobs.delete(rec.id);
            }
          })());
        }
        await peaksJobs.get(rec.id);
      }
      res.set("Cache-Control", "private, max-age=86400");
      res.json({ peaks: rec.outputs.peaks });
    } catch (err) {
      console.error("[API] /api/recordings/:id/peaks failed:", err.message || err);
      res.status(500).json({ error: "peaks_failed" });
    }
  });

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
