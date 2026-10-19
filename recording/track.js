// recording/track.js - one speaker's audio in a recording.
// Places Discord's Opus packets on the recording's timeline, fills gaps with silence so all tracks stay in
// sync, and writes them to chunk files (a new file every chunkMinutes, so a bot restart only risks the open one).
const path = require("path");
const { OggOpusWriter, packetSamples, isSilence, FRAME } = require("./ogg");

const MS = 48; // samples per millisecond
const SPURT_GAP_MS = 200; // a pause longer than this starts a new talk spurt
const SPURT_REANCHOR = 150 * MS; // at a spurt start, trust arrival time over the RTP clock when they disagree by more
const DRIFT_REANCHOR = 1000 * MS; // ...and mid-spurt once they drift this far apart (open mics, clock drift)
const STALE = 400 * MS; // a packet this far behind what's already written is a late duplicate: dropped
const REORDER_PACKETS = 3; // small reorder buffer for packets arriving out of order
const RING_SAMPLES = 120e3 * MS; // keep the last 2 minutes in memory for clips

class TrackWriter {
  // partStartMs: where this run of the recording starts on its timeline (0, or later after a bot restart)
  constructor({ dir, userId, name, chunkMs, partStartMs = 0, part = 1, onChunk }) {
    this.dir = dir;
    this.userId = userId;
    this.name = name;
    this.part = part;
    this.chunkSamples = chunkMs * MS;
    this.partStart = Math.ceil((partStartMs * MS) / FRAME) * FRAME;
    this.onChunk = onChunk;
    this.writer = null;
    this.fileStart = 0;
    this.chunkEnd = 0;
    this.written = this.partStart; // timeline position right after the last packet written
    this.anchor = null; // { rtp, sample }: maps the sender's RTP clock onto the timeline
    this.lastArrivalMs = null;
    this.queue = [];
    this.ring = [];
    this.ringHead = 0;
    this.bytes = 0;
    this.speakingSamples = 0;
    this.lastAudioMs = 0;
  }

  // packet: Opus payload from the voice receiver (rtpTimestamp is attached by session.js when available)
  // atMs: when it arrived, on the recording timeline
  push(packet, atMs) {
    const arrival = Math.round(atMs * MS);
    let target = arrival;
    const rtp = packet.rtpTimestamp;
    if (rtp !== undefined) {
      const newSpurt = this.lastArrivalMs === null || atMs - this.lastArrivalMs > SPURT_GAP_MS;
      if (this.anchor) {
        // RTP timestamps are 32-bit and wrap; "| 0" gives the signed difference
        target = this.anchor.sample + ((rtp - this.anchor.rtp) | 0);
        const off = Math.abs(target - arrival);
        if ((newSpurt && off > SPURT_REANCHOR) || off > DRIFT_REANCHOR) this.anchor = null;
      }
      if (!this.anchor) {
        this.anchor = { rtp, sample: arrival };
        target = arrival;
      }
    }
    this.lastArrivalMs = atMs;

    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].target > target) i--;
    this.queue.splice(i, 0, { packet, target, hasRtp: rtp !== undefined });
    while (this.queue.length > REORDER_PACKETS) this.place(this.queue.shift());
  }

  drain() {
    while (this.queue.length) this.place(this.queue.shift());
  }

  place({ packet, target, hasRtp }) {
    const samples = packetSamples(packet) || FRAME;
    if (target < this.written) {
      if (hasRtp && this.written - target > STALE) return;
      target = this.written; // slightly behind (jitter): goes right after what's written
    }
    if (!this.writer || target >= this.chunkEnd) this.rotate(target);
    if (target > this.written) this.written += this.writer.writeSilence(target - this.written);
    const pos = this.written;
    this.writer.writePacket(packet, samples);
    this.written += samples;
    this.bytes += packet.length;
    if (!isSilence(packet)) {
      this.speakingSamples += samples;
      this.lastAudioMs = pos / MS;
    }
    this.ring.push({ pos, packet, samples });
    while (this.ringHead < this.ring.length && this.ring[this.ringHead].pos < pos - RING_SAMPLES) this.ringHead++;
    if (this.ringHead > 2000) {
      this.ring = this.ring.slice(this.ringHead);
      this.ringHead = 0;
    }
  }

  rotate(target) {
    this.closeChunk();
    const chunkStart = Math.floor(target / this.chunkSamples) * this.chunkSamples;
    // Starts on a whole millisecond (files are keyed by start_ms) and never before audio already written
    const start = Math.ceil(Math.max(chunkStart, this.partStart, this.written) / MS) * MS;
    this.fileStart = start;
    this.written = start;
    this.chunkEnd = chunkStart + this.chunkSamples;
    this.file = path.join(this.dir, `${this.userId}_${start / MS}.ogg`);
    this.writer = new OggOpusWriter(this.file, { tags: { ARTIST: this.name, TITLE: `${this.name} (from ${start / MS} ms)` } });
  }

  closeChunk() {
    if (!this.writer) return;
    const writer = this.writer;
    this.writer = null;
    writer.close();
    this.onChunk?.({ userId: this.userId, startMs: this.fileStart / MS, part: this.part, file: this.file, bytes: writer.bytes });
  }

  // Called about once a second: writes packets left in the reorder buffer, keeps pages flushed to disk,
  // and closes a chunk once its time is up even if this speaker went quiet (so it's uploaded on time)
  tick(nowMs) {
    if (this.queue.length && nowMs - this.lastArrivalMs > 60) this.drain();
    if (!this.writer) return;
    if (!this.queue.length && nowMs * MS >= this.chunkEnd + SPURT_GAP_MS * MS) this.closeChunk();
    else this.writer.flushIfOlder(1000);
  }

  // Packets placed within [fromSample, toSample), for clips
  recent(fromSample, toSample) {
    const out = [];
    for (let i = this.ringHead; i < this.ring.length; i++) {
      const r = this.ring[i];
      if (r.pos + r.samples > fromSample && r.pos < toSample) out.push(r);
    }
    return out;
  }

  close() {
    this.drain();
    this.closeChunk();
  }
}

// Adds [startMs, endMs] of someone's speech to their time-ordered list (pauses up to 250 ms merged)
function addSpeech(list, s, e) {
  const last = list[list.length - 1];
  if (last && s - last[1] <= 250) last[1] = Math.max(last[1], e);
  else list.push([s, e]);
}

module.exports = { TrackWriter, MS, addSpeech };
