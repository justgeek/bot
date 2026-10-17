// recording/session.js - one live recording: listens to the voice connection, writes each speaker's track,
// keeps the activity log and the live panel in #record, and rides out reconnects and bot restarts.
const fs = require("fs");
const path = require("path");
const { EndBehaviorType, VoiceConnectionStatus, entersState } = require("@discordjs/voice");
const { IDs, Recording: cfg } = require("../config");
const audio = require("../audioManager");
const { TrackWriter, MS } = require("./track");
const { isSilence } = require("./ogg");
const store = require("./store");
const drive = require("./drive");
const panel = require("./panel");
const clip = require("./clip");
const { WORK_DIR, sleep, UserError, folderName, threadName, memberName } = require("./util");

// The voice library hands over only each packet's Opus payload. This wraps its packet parser (an internal
// of @discordjs/voice 0.19.2, which package.json pins) to also attach the RTP timestamp from the header,
// so packets can be placed exactly (see track.js). Without it, tracks fall back to arrival times.
function tagRtp(receiver) {
  if (receiver.__rtpTagged || typeof receiver.parsePacket !== "function") return;
  receiver.__rtpTagged = true;
  const parse = receiver.parsePacket;
  receiver.parsePacket = function (buffer, ...rest) {
    const packet = parse.call(this, buffer, ...rest);
    if (packet && buffer.length >= 12) {
      packet.rtpSequence = buffer.readUInt16BE(2);
      packet.rtpTimestamp = buffer.readUInt32BE(4);
    }
    return packet;
  };
}

// Discord never sends the bot its own audio back, so what the bot plays (memes, TTS, join/leave
// announcements) is copied on its way out: every packet the player hands to the connection passes
// through here first. conn.__recTap is the recording listening on that connection, if any.
function tapOutgoing(conn) {
  if (conn.__recTapped || typeof conn.prepareAudioPacket !== "function") return;
  conn.__recTapped = true;
  const prepare = conn.prepareAudioPacket;
  conn.prepareAudioPacket = function (buffer) {
    try {
      conn.__recTap?.(buffer);
    } catch (err) {
      console.warn("[Rec] Copying the bot's own audio failed:", err.message);
    }
    return prepare.call(this, buffer);
  };
}

class RecordingSession {
  // rec: the recordings row; onEnded(rec, hadAudio) runs once the recording has fully stopped
  constructor(client, rec, { onEnded } = {}) {
    this.client = client;
    this.rec = rec;
    this.onEnded = onEnded;
    this.tracks = new Map(); // userId -> TrackWriter
    this.streams = new Map(); // userId -> AudioReceiveStream
    this.conn = null;
    this.uploads = Promise.resolve();
    this.state = "starting";
    this.active = false;
    this.stopping = null;
    this.emptySince = null;
    this.lastSaved = 0;
    this.lastPanel = 0;
    this.panelTimer = null;
    this.panelMessage = null;
    this.thread = null;
    this.clipBusy = false;
    this.lastClipAt = 0;
    this.dir = path.join(WORK_DIR, rec.id, "chunks");
    // Totals from earlier parts (before a bot restart); this part's tracks add to them
    this.baseSpeakers = JSON.parse(JSON.stringify(rec.speakers || {}));
  }

  get id() { return this.rec.id; }
  get channelId() { return this.rec.channel_id; }
  get guild() { return this.client.guilds.cache.get(this.rec.guild_id); }
  get channel() { return this.client.channels.cache.get(this.rec.channel_id); }
  get startedAtMs() { return Date.parse(this.rec.started_at); }

  // Position on the recording's timeline (ms since it started); monotonic clock within this run
  nowMs() {
    return this.partOffsetMs + Number(process.hrtime.bigint() - this.hrBase) / 1e6;
  }

  humans() {
    return [...(this.channel?.members.values() || [])].filter((m) => !m.user.bot);
  }

  // fresh: a new recording; otherwise this continues one that a bot restart cut off
  async begin({ fresh }) {
    fs.mkdirSync(this.dir, { recursive: true });
    this.hrBase = process.hrtime.bigint();
    this.partOffsetMs = Date.now() - this.startedAtMs;
    this.part = this.rec.parts || 1;
    this.active = true;
    this.state = "recording";
    audio.state.pinnedChannelId = this.channelId;

    if (fresh) {
      this.addEvent("start", this.rec.started_by, null, 0);
      for (const m of this.humans()) this.addEvent("join", m.id, null, 0);
    } else {
      const cutAt = Date.parse(this.rec.suspended_at || this.rec.heartbeat_at || this.rec.started_at);
      this.addEvent("restart", null, panel.human(Math.max(0, Date.now() - cutAt)));
      this.rec.suspended_at = null;
    }
    this.rec.status = "recording";
    this.rec.heartbeat_at = new Date().toISOString();
    await store.saveRecording(this.rec);
    await this.postPanel();

    const conn = await audio.joinBanhaVoiceChannel(this.client, this.channelId);
    if (!conn || conn.state.status !== VoiceConnectionStatus.Ready) {
      await this.stop("error");
      throw new UserError("I couldn't join that voice channel.");
    }
    this.attach(conn);
    this.timer = setInterval(() => this.tick(), 1000);
    this.refreshPanel(true);
  }

  // Hooks onto a (new or re-joined) voice connection; safe to call repeatedly
  attach(conn) {
    if (!this.active || !conn || conn.joinConfig?.channelId !== this.channelId) return;
    if (this.conn !== conn) {
      this.detachConnection();
      this.conn = conn;
      tagRtp(conn.receiver);
      tapOutgoing(conn);
      conn.__recTap = (packet) => this.onBotPacket(packet);
      this.onSpeaking = (userId) => this.subscribe(userId);
      conn.receiver.speaking.on("start", this.onSpeaking);
      this.onConnState = (oldState, newState) => this.connectionChanged(newState);
      conn.on("stateChange", this.onConnState);
    }
    // Subscribing early means their very first packet is kept
    for (const m of this.humans()) this.subscribe(m.id);
  }

  detachConnection() {
    if (!this.conn) return;
    this.conn.__recTap = null;
    this.conn.receiver?.speaking.off("start", this.onSpeaking);
    this.conn.off("stateChange", this.onConnState);
    this.conn = null;
  }

  subscribe(userId) {
    if (!this.active || !this.conn || this.streams.has(userId) || userId === this.client.user.id) return;
    if (cfg.ignoreBots && this.guild?.members.cache.get(userId)?.user?.bot) return;
    let stream;
    try {
      stream = this.conn.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    } catch (err) {
      console.warn(`[Rec] Couldn't listen to ${userId}: ${err.message}`);
      return;
    }
    this.streams.set(userId, stream);
    stream.on("data", (packet) => this.onPacket(userId, packet));
    stream.on("error", (err) => console.warn(`[Rec] Audio stream of ${userId} failed: ${err.message}`));
    stream.once("close", () => {
      if (this.streams.get(userId) === stream) this.streams.delete(userId);
      // The library closes a stream after repeated decrypt failures (E2EE key changes); listen again
      if (this.active) setTimeout(() => this.subscribe(userId), 250);
    });
  }

  onPacket(userId, packet) {
    if (!this.active) return;
    this.trackFor(userId).push(packet, this.nowMs());
  }

  // The bot's own sounds go to one track per member who played them ("bot-<their id>"), or "bot" for
  // automatic ones (join/leave announcements); each new sound is logged with who played it
  onBotPacket(packet) {
    if (!this.active) return;
    const playing = audio.state.nowPlaying;
    if (!playing && isSilence(packet)) return; // the player's trailing silence after a sound
    const key = playing?.userId ? `bot-${playing.userId}` : "bot";
    // (join/leave announcements are recorded but not logged: the log already says who joined/left)
    if (playing && playing.playId !== this.lastPlayId && playing.kind !== "announce") {
      this.lastPlayId = playing.playId;
      const e = this.addEvent("sound", playing.userId || null, String(playing.text || "").slice(0, 300));
      e.kind = playing.kind || "sound";
      if (playing.userId) e.name = memberName(this.guild, playing.userId);
    }
    const name = playing?.userId ? `${memberName(this.guild, playing.userId)} (bot sounds)` : "Bot (announcements)";
    this.trackFor(key, name, true).push(packet, this.nowMs());
  }

  trackFor(userId, displayName = null, bot = false) {
    let track = this.tracks.get(userId);
    if (!track) {
      const name = displayName || memberName(this.guild, userId);
      track = new TrackWriter({
        dir: this.dir,
        userId,
        name,
        chunkMs: cfg.chunkMinutes * 60000,
        partStartMs: this.partOffsetMs,
        part: this.part,
        onChunk: (c) => this.chunkClosed(c),
      });
      this.tracks.set(userId, track);
      if (!this.rec.speakers[userId]) this.rec.speakers[userId] = { name, bytes: 0, speaking_ms: 0, ...(bot && { bot: true }) };
    }
    return track;
  }

  // ---------- Uploads (raw chunks go to Drive while recording, so a restart loses at most one) ----------
  driveFolder() {
    return drive.recordingFolder(this.rec, folderName(this.rec));
  }

  queueUpload(task) {
    this.uploads = this.uploads.then(task).catch((err) => console.error("[Rec] Upload failed:", err.message || err));
    return this.uploads;
  }

  chunkClosed(c) {
    this.queueUpload(async () => {
      let driveFileId = null;
      if (drive.enabled) {
        try {
          const raw = await drive.ensureFolder(await this.driveFolder(), "raw");
          driveFileId = (await drive.upload(raw, path.basename(c.file), c.file, "audio/ogg")).id;
        } catch (err) {
          console.error(`[Rec] Chunk upload failed (${path.basename(c.file)}), it stays on this disk only:`, err.message);
        }
      }
      await store.saveChunk(this.id, { ...c, driveFileId });
    });
  }

  // ---------- Clock ----------
  tick() {
    if (!this.active) return;
    const now = this.nowMs();
    for (const t of this.tracks.values()) t.tick(now);

    if (this.humans().length) this.emptySince = null;
    else {
      if (this.emptySince === null) this.emptySince = Date.now();
      if (Date.now() - this.emptySince >= (cfg.emptyStopSeconds || 0) * 1000) return void this.stop("empty");
    }
    if (now >= cfg.maxHours * 3600e3) return void this.stop("max");

    if (Date.now() - this.lastSaved >= 30000) this.persist();
    if (Date.now() - this.lastPanel >= 60000) this.refreshPanel();
  }

  updateSpeakerStats() {
    for (const [userId, t] of this.tracks) {
      const base = this.baseSpeakers[userId] || {};
      const s = this.rec.speakers[userId] || (this.rec.speakers[userId] = { name: t.name });
      s.bytes = (base.bytes || 0) + t.bytes;
      s.speaking_ms = (base.speaking_ms || 0) + Math.round(t.speakingSamples / MS);
    }
  }

  persist() {
    this.updateSpeakerStats();
    this.rec.heartbeat_at = new Date().toISOString();
    this.lastSaved = Date.now();
    return store.saveRecording(this.rec);
  }

  addEvent(type, user = null, textValue = null, t = this.nowMs()) {
    const e = { t: Math.max(0, Math.round(t)), type };
    if (user) e.user = user;
    if (textValue) e.text = textValue;
    (this.rec.events = this.rec.events || []).push(e);
    this.lastSaved = 0; // saved at the next tick
    this.refreshPanel(true);
    return e;
  }

  memberJoined(userId) {
    this.addEvent("join", userId);
    this.subscribe(userId);
  }

  memberLeft(userId) {
    this.addEvent("leave", userId);
  }

  // ---------- Controls ----------
  async note(userId, textValue) {
    const t = this.nowMs();
    const clean = String(textValue).trim().slice(0, 1000);
    this.addEvent("note", userId, clean, t);
    await this.thread?.send({ content: `📝 <@${userId}> at \`${panel.hms(t)}\`: ${clean}`, allowedMentions: { parse: [] } }).catch(() => { });
  }

  setOption(key, value, userId) {
    const o = (this.rec.options = this.rec.options || {});
    o[key] = value;
    // A summary is written from the transcript, so they go together
    if (key === "summarize" && value) o.transcribe = true;
    if (key === "transcribe" && !value) o.summarize = false;
    this.addEvent("toggle", userId, `the ${key === "transcribe" ? "transcript" : "summary"} ${value ? "on" : "off"}`);
  }

  async clip(userId, seconds) {
    if (this.clipBusy) throw new UserError("A clip is already being made, give it a second.");
    if (Date.now() - this.lastClipAt < 10000) throw new UserError("Wait a few seconds between clips.");
    this.clipBusy = true;
    try {
      const end = this.nowMs();
      const start = Math.max(0, end - seconds * 1000);
      for (const t of this.tracks.values()) t.drain();
      const file = await clip.fromTracks([...this.tracks.values()], start, end, path.join(WORK_DIR, this.id, "clips"));
      if (!file) throw new UserError(`Nobody said anything in the last ${seconds} seconds.`);
      const span = `\`${panel.hms(start)}\`–\`${panel.hms(end)}\``;
      this.addEvent("clip", userId, span, end);
      const name = `clip ${panel.hms(start).replace(/:/g, ".")}.ogg`;
      await this.thread?.send({ content: `✂️ Clip by <@${userId}> · ${span}`, files: [{ attachment: file, name }], allowedMentions: { parse: [] } });
      this.queueUpload(async () => {
        if (drive.enabled) await drive.upload(await drive.ensureFolder(await this.driveFolder(), "clips"), name, file, "audio/ogg");
      });
      return file;
    } finally {
      this.clipBusy = false;
      this.lastClipAt = Date.now();
    }
  }

  // ---------- Voice connection trouble ----------
  connectionChanged(newState) {
    if (!this.active) return;
    if (newState.status === VoiceConnectionStatus.Disconnected) this.recover(false);
    else if (newState.status === VoiceConnectionStatus.Destroyed) this.recover(true);
  }

  async recover(destroyed) {
    if (this.recovering || !this.active) return;
    this.recovering = true;
    this.state = "reconnecting";
    this.refreshPanel(true);
    const conn = this.conn;
    try {
      if (!destroyed && conn) {
        // Often the library sorts itself out (e.g. Discord moved the voice server)
        try {
          await Promise.race([entersState(conn, VoiceConnectionStatus.Signalling, 5000), entersState(conn, VoiceConnectionStatus.Connecting, 5000)]);
          await entersState(conn, VoiceConnectionStatus.Ready, 20000);
          return this.reconnected();
        } catch { }
      }
      for (let attempt = 1; attempt <= 3 && this.active; attempt++) {
        await sleep(500 * attempt);
        if (!this.active) return;
        try {
          if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) {
            conn.rejoin();
            await entersState(conn, VoiceConnectionStatus.Ready, 15000);
          } else {
            const fresh = await audio.joinBanhaVoiceChannel(this.client, this.channelId);
            if (!fresh || fresh.state.status !== VoiceConnectionStatus.Ready) throw new Error("join failed");
            this.attach(fresh);
          }
          return this.reconnected();
        } catch (err) {
          console.warn(`[Rec] Reconnect attempt ${attempt} failed: ${err.message}`);
        }
      }
      if (this.active) this.stop("error");
    } finally {
      this.recovering = false;
    }
  }

  reconnected() {
    if (!this.active) return;
    this.state = "recording";
    this.addEvent("reconnect");
    if (this.conn) this.attach(this.conn);
  }

  // ---------- Panel & thread in #record ----------
  view() {
    const conn = this.conn;
    const endpoint = conn?.packets?.server?.endpoint || "";
    const ping = conn?.ping;
    this.updateSpeakerStats();
    return {
      id: this.id,
      startedBy: this.rec.started_by,
      channelId: this.channelId,
      startedAtMs: this.startedAtMs,
      elapsedMs: this.active ? this.nowMs() : Date.now() - this.startedAtMs,
      bytes: Object.values(this.rec.speakers).reduce((a, s) => a + (s.bytes || 0), 0),
      speakers: Object.values(this.rec.speakers).filter((s) => !s.bot).length,
      region: endpoint.split(".")[0] || null,
      pingMs: ping?.ws ?? ping?.udp,
      dave: (conn?.state?.networking?.state?.dave?.protocolVersion || 0) > 0,
      options: this.rec.options || {},
      events: this.rec.events,
      state: this.state,
    };
  }

  async postPanel() {
    const channel = await this.client.channels.fetch(IDs.channelRecord).catch(() => null);
    if (!channel) return console.warn("[Rec] #record channel not found (IDs.channelRecord).");
    if (this.rec.panel_message_id) this.panelMessage = await channel.messages.fetch(this.rec.panel_message_id).catch(() => null);
    if (!this.panelMessage) {
      this.panelMessage = await channel.send(panel.livePanel(this.view())).catch((err) => console.error("[Rec] Couldn't post the panel:", err.message));
      if (this.panelMessage) this.rec.panel_message_id = this.panelMessage.id;
    }
    if (this.rec.thread_id) this.thread = await this.client.channels.fetch(this.rec.thread_id).catch(() => null);
    if (!this.thread && this.panelMessage) {
      this.thread = await this.panelMessage.startThread({ name: threadName(this.rec), autoArchiveDuration: 1440 }).catch((err) => {
        console.warn("[Rec] Couldn't start the recording's thread:", err.message);
        return null;
      });
      if (this.thread) this.rec.thread_id = this.thread.id;
    }
    store.saveRecording(this.rec);
  }

  // Edits are spaced at least 3 s apart (Discord rate limits); soon = within 3 s, else right away
  refreshPanel(soon = false) {
    if (this.panelTimer) return;
    const wait = soon ? Math.max(0, 3000 - (Date.now() - this.lastPanel)) : 0;
    this.panelTimer = setTimeout(() => {
      this.panelTimer = null;
      this.renderPanel();
    }, wait);
  }

  async renderPanel() {
    this.lastPanel = Date.now();
    if (!this.panelMessage || this.state === "stopped") return;
    await this.panelMessage.edit(panel.livePanel(this.view())).catch((err) => console.warn("[Rec] Panel update failed:", err.message));
  }

  // ---------- Ending ----------
  closeTracks() {
    for (const s of this.streams.values()) s.destroy();
    this.streams.clear();
    this.detachConnection();
    for (const t of this.tracks.values()) t.close();
    this.updateSpeakerStats();
  }

  // reason: stopped | empty | max | kicked | moved | error
  stop(reason, byUserId = null) {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      const wasActive = this.active;
      if (wasActive) this.addEvent("stop", reason === "stopped" ? byUserId : null);
      this.active = false;
      this.state = "stopped";
      clearInterval(this.timer);
      clearTimeout(this.panelTimer);
      this.closeTracks();
      this.rec.ended_at = new Date().toISOString();
      this.rec.end_reason = reason;
      const hadAudio = Object.values(this.rec.speakers || {}).some((s) => s.speaking_ms > 0);
      this.rec.status = hadAudio ? "processing" : "discarded";
      this.rec.outputs = this.rec.outputs || {};
      if (hadAudio) this.rec.outputs.progress = { audio: { state: "pending", detail: "waiting for the last uploads" } };

      await this.uploads;
      await store.saveRecording(this.rec);
      await this.releaseVoice();

      if (!hadAudio) {
        await this.panelMessage?.delete().catch(() => { });
        await this.thread?.delete().catch(() => { });
        fs.rm(path.join(WORK_DIR, this.id), { recursive: true, force: true }, () => { });
      } else {
        await this.panelMessage?.edit(panel.endedPanel(this.rec)).catch(() => { });
      }
      this.onEnded?.(this.rec, hadAudio);
    })();
    return this.stopping;
  }

  // Back to normal voice behaviour: home channel (voice3) if people are there, else leave
  async releaseVoice() {
    audio.state.pinnedChannelId = null;
    if (this.channelId === IDs.voice3) return audio.leaveEmptyVoiceChannel(this.client);
    if (audio.countHumans(this.client.channels.cache.get(IDs.voice3)) > 0) {
      await audio.joinBanhaVoiceChannel(this.client, IDs.voice3);
    } else if (audio.state.connection) {
      try { audio.state.connection.destroy(); } catch { }
      audio.state.connection = null;
      audio.state.player = null;
      audio.state.connectionSubscription = null;
    }
  }

  // Bot shutting down (Heroku restart, deploy, Ctrl+C): save everything, the next start resumes it
  async suspend() {
    if (!this.active) return;
    this.active = false;
    this.state = "suspended";
    clearInterval(this.timer);
    clearTimeout(this.panelTimer);
    this.closeTracks();
    this.rec.status = "suspended";
    this.rec.suspended_at = new Date().toISOString();
    await store.saveRecording(this.rec);
    await Promise.race([this.uploads, sleep(20000)]);
    await store.saveRecording(this.rec);
    if (this.panelMessage) await this.panelMessage.edit(panel.livePanel(this.view())).catch(() => { });
  }
}

module.exports = { RecordingSession, tagRtp };
