// recording/live.js - transcribes a recording while it's still going, so after the call only the last
// stretch (and the summary) is left. Works from the raw 5-minute chunks: every speaker's chunks line up on
// the same timeline windows, so once a window is over all of its audio is on disk. Requests are as large as
// the ones made after the call (~15 min of speech), so this costs no extra Gemini quota.
// What's been sent is kept in rec.outputs.liveTranscript = { untilMs, segments: [{ user, start, end, text }] }:
// everything before untilMs is transcribed, transcriptStep (transcribe.js) does the rest after the call.
// Google being busy (503), a per-minute limit or a request that fails doesn't end it: the clips go back in
// line and are asked again a little later, while the rest of the call is still being read from disk. Only
// when Gemini's day is used up does it stop, and the after-call step then picks up from untilMs.
const { readOggPackets, isSilence } = require("./ogg");
const { MS, addSpeech } = require("./track");
const transcribe = require("./transcribe");

const GRACE_MS = 3000; // after a window ends, before its chunks are read (tracks close theirs 200 ms late)
// Clips waiting for Gemini are held in memory (about 25 KB per minute of speech). If it stays unreachable
// this long, the live transcript stops here and the after-call step does the rest from the tracks.
const MAX_PENDING_MS = 60 * 60000;
const MAX_PENDING_BYTES = 48 * 1024 * 1024;
const RETRY_MS = [15000, 30000, 60000, 120000, 300000]; // waiting only while nothing else can be asked

class LiveTranscriber {
  // enabled: false after a bot restart (the earlier part's chunks aren't on this disk any more)
  constructor(session, { chunkMs, enabled = true }) {
    this.session = session;
    this.chunkMs = chunkMs;
    this.off = !enabled;
    this.chunks = new Map(); // window start (ms) -> [{ userId, startMs, file }]
    this.nextWindow = this.state.untilMs;
    this.pending = []; // [{ user, start, end, until, audio }]: cut, not sent yet
    this.pendingMs = 0;
    this.pendingBytes = 0;
    this.busy = null;
    this.failures = 0;
    this.retryAt = 0;
  }

  get rec() { return this.session.rec; }
  get state() {
    const out = (this.rec.outputs = this.rec.outputs || {});
    const live = (out.liveTranscript = out.liveTranscript || { untilMs: 0, segments: [] });
    if (!Array.isArray(live.segments)) live.segments = []; // a light row only carries untilMs/count
    return live;
  }
  get enabled() { return !this.off && !!this.rec.options?.transcribe && transcribe.hasGeminiKey(); }

  chunkClosed(c) {
    const w = Math.floor(c.startMs / this.chunkMs) * this.chunkMs;
    if (!this.chunks.has(w)) this.chunks.set(w, []);
    this.chunks.get(w).push(c);
  }

  // Once a second from the session: reads at most one finished window, sends when there's enough
  tick(nowMs) {
    if (!this.enabled) return;
    if (nowMs >= this.nextWindow + this.chunkMs + GRACE_MS) {
      try {
        this.readWindow(this.nextWindow);
      } catch (err) {
        return this.giveUp(`reading the audio failed: ${err.message}`);
      }
    }
    if (Date.now() < this.retryAt) return; // Google is having a moment: the clips wait, the call goes on
    if (this.pending.length && !this.busy) this.send();
  }

  // Speech in one window, per person (the bot's sounds aren't transcribed), cut into clips
  readWindow(w) {
    const end = w + this.chunkMs;
    const speech = {};
    const files = {};
    for (const c of this.chunks.get(w) || []) {
      const u = c.userId;
      if (u === "bot" || u.startsWith("bot-") || this.rec.speakers?.[u]?.bot) continue;
      const list = speech[u] || (speech[u] = []);
      (files[u] = files[u] || []).push(c);
      const base = c.startMs * MS;
      for (const { packet, start, samples } of readOggPackets(c.file)) {
        if (!isSilence(packet)) addSpeech(list, Math.round((base + start) / MS), Math.round((base + start + samples) / MS));
      }
    }
    const segments = transcribe.buildSegments(speech);
    for (const u of Object.keys(files)) files[u].sort((a, b) => a.startMs - b.startMs);
    const cutters = new Map();
    try {
      for (const seg of segments) {
        // The chunk it's in (usually the speaker's only one in this window)
        const chunk = files[seg.user].filter((c) => c.startMs <= seg.start).pop() || files[seg.user][0];
        let cutter = cutters.get(chunk.file);
        if (!cutter) cutters.set(chunk.file, (cutter = new transcribe.SegmentCutter(chunk.file)));
        const audio = cutter.cut(seg.start - chunk.startMs, seg.end - chunk.startMs);
        if (!audio) continue;
        this.pending.push({ user: seg.user, start: seg.start, end: seg.end, until: end, audio });
        this.pendingMs += seg.end - seg.start;
        this.pendingBytes += audio.length;
      }
    } finally {
      for (const c of cutters.values()) c.close();
    }
    this.chunks.delete(w);
    this.nextWindow = end;
    if (this.pendingMs > MAX_PENDING_MS || this.pendingBytes > MAX_PENDING_BYTES) {
      this.giveUp("Gemini is too far behind, the rest is done after the call");
    }
  }

  send() {
    const batch = this.pending;
    this.pending = [];
    this.pendingMs = 0;
    this.pendingBytes = 0;
    this.busy = this.request(batch).finally(() => {
      this.busy = null;
    });
  }

  // Back in line, in front of the newer clips (the transcript has to stay in order)
  requeue(batch) {
    this.pending = [...batch, ...this.pending];
    for (const s of batch) {
      this.pendingMs += s.end - s.start;
      this.pendingBytes += s.audio.length;
    }
  }

  async request(segs) {
    const names = Object.fromEntries(Object.entries(this.rec.speakers || {}).map(([u, s]) => [u, s.name || u]));
    const batch = segs.map((s, i) => ({ ...s, id: String(i + 1), name: names[s.user] || s.user }));
    const vocab = transcribe.vocabulary(this.rec);
    let result;
    try {
      // generate() (transcribe.js) asks the model, then its fallbacks, key by key, with no waiting
      result = await transcribe.transcribeBatch(batch, transcribe.geminiModelName(), vocab);
    } catch (err) {
      if (this.off) return;
      if (err.daily) return this.giveUp("Gemini's free limit is used up for now");
      // Nothing is thrown away: the clips wait here and are asked again a little later
      this.requeue(batch);
      const wait = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)];
      this.failures++;
      this.retryAt = Date.now() + wait;
      console.warn(
        `[Rec] ${this.rec.id}: live transcript request failed (${String(err.message || err).slice(0, 160)}), ` +
          `trying again in ${Math.round(wait / 1000)}s; the recording carries on`
      );
      return;
    }
    if (this.off) return; // stopped while waiting (the after-call step redoes this part)
    this.failures = 0;
    this.retryAt = 0;
    const state = this.state;
    for (const s of batch) {
      const r = result[s.id];
      state.segments.push({ user: s.user, start: s.start, end: s.end, text: r ? r.text : "" });
    }
    state.count = state.segments.length; // the light rows and the page's poll read this instead of the whole array
    state.untilMs = Math.max(state.untilMs, ...batch.map((s) => s.until || 0));
    console.log(`[Rec] ${this.rec.id}: transcribed live up to ${Math.round(state.untilMs / 60000)} min (${batch.length} clips)`);
    this.session.lastSaved = 0; // saved at the next tick
    this.session.refreshPanel(true);
  }

  giveUp(why) {
    if (this.off) return;
    console.warn(`[Rec] ${this.rec.id}: live transcript stopped (${why}); the rest is done after the call`);
    this.off = true;
    this.pending = [];
    this.pendingMs = 0;
    this.pendingBytes = 0;
    this.chunks.clear();
  }

  // When the recording ends: waits for a request that's on its way (up to maxMs), then stops
  async finish(maxMs) {
    if (this.busy) await Promise.race([this.busy, new Promise((r) => setTimeout(r, maxMs))]);
    this.off = true;
    this.pending = [];
    this.pendingMs = 0;
    this.pendingBytes = 0;
    this.chunks.clear();
  }
}

module.exports = { LiveTranscriber };
