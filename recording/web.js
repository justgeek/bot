// recording/web.js - the recordings page at /recordings and its API.
// Nothing on the dashboard links to it. RECORDINGS_KEY (?key=...) and RECORDINGS_PASSWORD (asked on the page, kept in a cookie) are both required when both are set.
// Set RECORDINGS_KEY to require /recordings?key=... (falls back to DASHBOARD_KEY when only that is set).
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const store = require("./store");
const { peaksFromOgg, binsFor } = require("./peaks");
const { WORK_DIR, participants } = require("./util");
const drive = require("./drive");
const transcribe = require("./transcribe");
const processor = require("./processor");
const recorder = require("./index");
const { IDs, MemberColorOverrides } = require("../config");

module.exports = function registerRecordingsPage(app, client, opts = {}) {
  const touchViewer = typeof opts.touchViewer === "function" ? opts.touchViewer : () => {};
  // RECORDINGS_PASSWORD: asked on the page, remembered in a cookie (changing the password logs everyone out).
  // Without it the old RECORDINGS_KEY / DASHBOARD_KEY check applies.
  const password = () => process.env.RECORDINGS_PASSWORD || "";
  const requiredKey = () => process.env.RECORDINGS_KEY || process.env.DASHBOARD_KEY || "";
  const tokenFor = (pw) => crypto.createHash("sha256").update("banha-recordings:" + pw).digest("hex");
  const safeEq = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const cookieOf = (req, name) => {
    const m = new RegExp("(?:^|;\\s*)" + name + "=([^;]*)").exec(req.headers.cookie || "");
    return m ? decodeURIComponent(m[1]) : "";
  };
  // Both checks apply when both are set: the key (?key=...) first, then the password cookie
  const keyOk = (req) => {
    const required = requiredKey();
    return !required || safeEq(req.query.key || req.get("x-recordings-key") || "", required);
  };
  function guard(req, res, next) {
    touchViewer(req);
    if (!keyOk(req)) return res.status(404).send("Not found"); // looks like there's nothing here
    if (password() && !safeEq(cookieOf(req, "rec_auth"), tokenFor(password()))) return res.status(401).json({ error: "password_required" });
    next();
  }
  // The page itself needs the key; the password box is shown on the page
  const pageGuard = (req, res, next) => {
    touchViewer(req);
    return keyOk(req) ? next() : res.status(404).send("Not found");
  };

  app.get("/api/recordings/ping", (req, res) => {
    touchViewer(req);
    res.json({ ok: true });
  });

  // What this process has read from Supabase since it started, by table and by the columns asked for. The
  // free plan is 5 GB of egress, and Supabase's own page only shows the total per day: this says which query
  // it was (it is also printed in the log every 10 minutes).
  app.get("/api/recordings/egress", guard, (req, res) => {
    const { egressReport } = require("../db");
    const report = egressReport();
    res.set("Cache-Control", "no-store");
    res.json({
      ...report,
      process: processor.workerName,
      rows: report.rows.map((r) => ({ ...r, pretty: r.bytes >= 1048576 ? `${(r.bytes / 1048576).toFixed(1)} MB` : `${Math.round(r.bytes / 1024)} KB` })),
    });
  });

  const fails = new Map();
  app.post("/api/recordings/login", require("express").json({ limit: "2kb" }), (req, res) => {
    touchViewer(req);
    if (!keyOk(req)) return res.status(404).send("Not found");
    const pw = password();
    if (!pw) return res.json({ ok: true });
    const ip = String(req.get("x-forwarded-for") || req.ip || "").split(",")[0].trim();
    const f = fails.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) return res.status(429).json({ error: "too_many_attempts" });
    if (!safeEq(String(req.body?.password ?? ""), pw)) {
      f.n++;
      if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; }
      fails.set(ip, f);
      return res.status(401).json({ error: "wrong_password" });
    }
    fails.delete(ip);
    res.cookie("rec_auth", tokenFor(pw), { httpOnly: true, sameSite: "lax", secure: !!req.secure || req.get("x-forwarded-proto") === "https", maxAge: 365 * 86400e3 });
    res.json({ ok: true });
  });

  // Drive space, cached for a minute
  let quotaCache = { at: 0, v: null };
  async function driveQuota() {
    if (!drive.enabled) return null;
    if (Date.now() - quotaCache.at < 60000) return quotaCache.v;
    try {
      quotaCache = { at: Date.now(), v: await drive.quota() };
    } catch {
      quotaCache.at = Date.now();
    }
    return quotaCache.v;
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
      // A hand-picked colour is shown as it is, even where it would be too dark or too bright to read by itself
      ...(override && { fixed_color: true }),
      avatar: m?.displayAvatarURL({ size: 64, extension: "webp", forceStatic: true }) || null,
    };
  }

  // How many lines the live transcript has: the detail view has the whole array, the list and the poll only the
  // two numbers the light rows carry, so both work here
  const liveTranscriptLines = (r) => {
    const live = r.outputs?.liveTranscript || {};
    return live.segments?.length || live.count || 0;
  };

  const summary = (r) => {
    const end = r.ended_at ? Date.parse(r.ended_at) : Date.now();
    const prog = r.outputs?.progress || {};
    // A worker (this bot or the one on a PC) is on it right now: its claim is still being renewed. Without
    // this the page said "waiting for its turn" while npm run worker was already transcribing.
    const claimed = !!r.claimed_by && Date.parse(r.claim_expires_at || 0) > Date.now();
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
      audio_removed: !!r.outputs?.audioDeleted,
      audio_removed_why: r.outputs?.audioDeleted ? String(r.outputs.audioDeleted) : null,
      // Stored audio once it's on Drive, else the raw audio recorded so far
      size_bytes: r.outputs?.audioDeleted ? 0 : ((r.outputs?.files?.mix?.size || 0) + Object.values(r.outputs?.files?.tracks || {}).reduce((a, t) => a + (t.size || 0), 0)) || Object.values(r.speakers || {}).reduce((a, s) => a + (s.bytes || 0), 0),
      has_transcript: prog.transcript?.state === "done" || !!liveTranscriptLines(r),
      has_summary: prog.summary?.state === "done",
      // Each step's { state, detail } while it's being made (same as the panel in #record)
      progress: ["processing", "paused", "failed"].includes(r.status) ? {
        audio: prog.audio || null,
        transcript: r.options?.transcribe ? prog.transcript || null : { state: "off" },
        summary: r.options?.summarize ? prog.summary || null : { state: "off" },
        queued: r.status === "processing" && !processor.liveRecording(r.id) && !claimed,
        claimed_by: claimed ? r.claimed_by : null,
        error: r.status === "failed" ? r.error || null : null,
      } : null,
    };
  };
  // The one being processed or recorded right now has newer progress/state in memory than in the database
  const fresh = (r) => (r && (recorder.activeRecording(r.id) || processor.liveRecording(r.id))) || r;

  app.get("/recordings", pageGuard, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "..", "recordings.html"));
  });

  // The list is 300 rows and only changes when a recording starts or ends or a step finishes: a 20 s cache
  // means a reload, a second tab or the page booting twice costs no Supabase reads at all
  let listCache = { at: 0, rows: null };
  async function listRows(limit) {
    if (listCache.rows && Date.now() - listCache.at < 20000) return listCache.rows;
    const rows = await store.listRecordings(limit);
    listCache = { at: Date.now(), rows };
    return rows;
  }

  app.get("/api/recordings", guard, async (req, res) => {
    try {
      const rows = await listRows(300);
      res.set("Cache-Control", "no-store");
      res.json({ recordings: rows.map((r) => summary(fresh(r))), drive: await driveQuota() });
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
      const id = String(req.params.id);
      // A recording this process is recording or processing has fresher state in memory than in the database,
      // and reading the row as well used to download the whole thing (waveform, speech map, live transcript)
      // only to throw it away. The view read below leaves out the waveform, which only /peaks needs.
      const local = recorder.activeRecording(id) || processor.liveRecording(id);
      const rec = local ? fresh(local) : fresh(await store.getRecordingView(id));
      if (!rec || ["deleted", "discarded"].includes(rec.status)) return res.status(404).json({ error: "not_found" });
      const files = rec.outputs?.files || {};
      // While it's being recorded there are no saved lines yet: the live transcript below is the transcript
      let lines = local ? [] : await store.getLines(rec.id);
      if (!lines.length && rec.outputs?.liveTranscript?.segments?.length) {
        lines = rec.outputs.liveTranscript.segments
          .filter((s) => s.text && s.text.trim())
          .map((s) => ({
            start_ms: s.start,
            end_ms: s.end,
            user_id: s.user,
            name: rec.speakers?.[s.user]?.name || person(s.user, s.user).name,
            text: s.text,
          }));
      }
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
        activity: (() => {
          const speechObj = { ...(rec.outputs?.speech || {}) };
          const botSpeech = rec.outputs?.botSpeech || {};
          for (const [k, iv] of Object.entries(botSpeech)) {
            const u = k.startsWith("bot-") ? k.slice(4) : k;
            speechObj[u] = [...(speechObj[u] || []), ...iv].sort((a, b) => a[0] - b[0]);
          }
          return Object.fromEntries(
            Object.entries(speechObj).map(([u, iv]) => {
              const runs = [];
              for (const [s, e] of iv) {
                const last = runs[runs.length - 1];
                if (last && s - last[1] < 2000) last[1] = Math.max(last[1], e);
                else runs.push([s, e]);
              }
              return [u, runs];
            })
          );
        })(),
        // The waveform endpoint works the rest out; a finished mix always has one made for it
        has_peaks: !!rec.outputs?.peaks || !!(files.mix?.id && !rec.outputs?.audioDeleted),
      });
    } catch (err) {
      console.error("[API] /api/recordings/:id failed:", err);
      res.status(500).json({ error: "recording_failed" });
    }
  });

  // Polled by the page every few seconds while a recording is being processed (cheap: no transcript
  // lines, no audio blobs - the full row is ~300 KB and this used to download it on every poll)
  app.get("/api/recordings/:id/progress", guard, async (req, res) => {
    try {
      const id = String(req.params.id);
      // Being recorded or processed here: the row would only repeat what's in memory (and cost a read)
      const local = recorder.activeRecording(id) || processor.liveRecording(id);
      const rec = local ? fresh(local) : fresh(await store.getRecordingLight(id));
      if (!rec || ["deleted", "discarded"].includes(rec.status)) return res.status(404).json({ error: "not_found" });
      const s = summary(rec);
      const linesCount = liveTranscriptLines(rec);
      res.set("Cache-Control", "no-store");
      res.json({
        status: s.status,
        progress: s.progress,
        has_audio: s.has_audio,
        has_transcript: s.has_transcript,
        has_summary: s.has_summary,
        duration_ms: s.duration_ms,
        lines_count: linesCount,
        size_bytes: s.size_bytes,
      });
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
      const id = String(req.params.id);
      const rec = await store.getRecordingPeaks(id);
      if (!rec) return res.status(404).json({ error: "not_found" });
      const durationMs = Date.parse(rec.ended_at) - Date.parse(rec.started_at);
      let peaks = rec.outputs?.peaks;
      // Missing, or the coarser kind made before zooming existed
      if (!peaks || peaks.length < binsFor(durationMs) * 0.9) {
        const mixId = rec.outputs?.files?.mix?.id;
        if (!mixId || rec.outputs?.audioDeleted || !drive.enabled) return res.json({ peaks: peaks || null });
        if (!peaksJobs.has(id)) {
          peaksJobs.set(id, (async () => {
            const file = path.join(WORK_DIR, `peaks_${id}.ogg`);
            fs.mkdirSync(WORK_DIR, { recursive: true });
            try {
              await drive.download(mixId, file);
              // The read above only has the waveform's parts: saving that back would drop the speech map and
              // the live transcript, so the whole row comes in before the write (once per recording)
              const full = (await store.getRecording(id, { fresh: true })) || null;
              if (!full) return null;
              full.outputs = full.outputs || {};
              full.outputs.peaks = peaksFromOgg(file, durationMs);
              await store.saveRecording(full);
              return full.outputs.peaks;
            } finally {
              fs.unlink(file, () => { });
              peaksJobs.delete(id);
            }
          })());
        }
        peaks = (await peaksJobs.get(id)) || peaks;
      }
      res.set("Cache-Control", "private, max-age=86400");
      res.json({ peaks: peaks || null });
    } catch (err) {
      console.error("[API] /api/recordings/:id/peaks failed:", err.message || err);
      res.status(500).json({ error: "peaks_failed" });
    }
  });

  app.get("/api/recordings/:id/audio", guard, async (req, res) => {
    try {
      // Only the Drive ids: the row it used to read carried the whole waveform for a file stream
      const rec = await store.getRecordingAudio(String(req.params.id));
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
