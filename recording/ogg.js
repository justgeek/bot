// recording/ogg.js - minimal Ogg Opus writer/reader.
// Discord already sends Opus, so the recorder stores each packet exactly as it arrives (no re-encoding,
// original quality, almost no CPU) in standard .ogg files that any player or ffmpeg can open.
const fs = require("fs");
const crypto = require("crypto");

const SAMPLE_RATE = 48000;
const FRAME = 960; // 20 ms at 48 kHz
// Discord's 20 ms Opus silence frame. Gaps are filled with it so every track stays on the recording's timeline.
const SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);

// CRC-32 as Ogg defines it (polynomial 0x04c11db7, not reflected)
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  CRC_TABLE[i] = r >>> 0;
}
function crc32(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc;
}

// Samples (at 48 kHz) in one Opus packet, read from its TOC byte (RFC 6716 section 3.1)
function packetSamples(packet) {
  if (!packet || !packet.length) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  let frame;
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3]; // SILK 10/20/40/60 ms
  else if (config < 16) frame = [480, 960][config & 1]; // Hybrid 10/20 ms
  else frame = [120, 240, 480, 960][config & 3]; // CELT 2.5/5/10/20 ms
  const code = toc & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : packet.length > 1 ? packet[1] & 0x3f : 0;
  return frame * frames;
}

const isSilence = (packet) => packet.length === 3 && packet[0] === 0xf8 && packet[1] === 0xff && packet[2] === 0xfe;

function lacingCount(len) {
  return Math.floor(len / 255) + 1;
}
function lacing(len) {
  const out = new Array(Math.floor(len / 255)).fill(255);
  out.push(len % 255);
  return out;
}

function opusHead(preSkip, channels) {
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "latin1");
  head[8] = 1; // version
  head[9] = channels;
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(SAMPLE_RATE, 12);
  head.writeInt16LE(0, 16); // output gain
  head[18] = 0; // channel mapping family 0 (mono/stereo)
  return head;
}

function opusTags(tags) {
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const vendor = Buffer.from("banha-recorder", "utf8");
  const comments = Object.entries(tags || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => Buffer.from(`${k}=${v}`, "utf8"));
  const parts = [Buffer.from("OpusTags", "latin1"), u32(vendor.length), vendor, u32(comments.length)];
  for (const c of comments) parts.push(u32(c.length), c);
  return Buffer.concat(parts);
}

// Writes an Ogg Opus stream to a file (or to memory when file is null; see toBuffer()).
// Pages are flushed every ~4 KB and by flushIfOlder(), so a crash still leaves a playable file.
class OggOpusWriter {
  constructor(file, { preSkip = 0, channels = 2, tags = {} } = {}) {
    this.fd = file ? fs.openSync(file, "w") : null;
    this.memory = file ? null : [];
    this.serial = crypto.randomBytes(4).readUInt32LE(0);
    this.seq = 0;
    this.granule = 0; // samples written so far
    this.packets = []; // packets waiting for the next page
    this.laces = 0;
    this.pendingBytes = 0;
    this.pageStartedAt = 0;
    this.bytes = 0;
    this.closed = false;
    this.writePage(0x02, 0, [opusHead(preSkip, channels)]);
    this.writePage(0, 0, [opusTags(tags)]);
  }

  writePage(flags, granule, packets) {
    const segments = [];
    for (const p of packets) segments.push(...lacing(p.length));
    const header = Buffer.alloc(27 + segments.length);
    header.write("OggS", 0, "latin1");
    header[4] = 0; // version
    header[5] = flags;
    header.writeBigInt64LE(BigInt(granule), 6);
    header.writeUInt32LE(this.serial, 14);
    header.writeUInt32LE(this.seq++, 18);
    header[26] = segments.length;
    for (let i = 0; i < segments.length; i++) header[27 + i] = segments[i];
    const page = Buffer.concat([header, ...packets]);
    page.writeUInt32LE(crc32(page), 22);
    if (this.memory) this.memory.push(page);
    else fs.writeSync(this.fd, page);
    this.bytes += page.length;
  }

  // samples: the packet's duration (defaults to what its TOC byte says)
  writePacket(packet, samples = packetSamples(packet)) {
    const laces = lacingCount(packet.length);
    if (this.laces + laces > 255) this.flush();
    if (!this.packets.length) this.pageStartedAt = Date.now();
    this.packets.push(packet);
    this.laces += laces;
    this.pendingBytes += packet.length;
    this.granule += samples;
    if (this.pendingBytes >= 4000) this.flush();
  }

  // Fills with 20 ms silence frames; returns the samples actually written (a multiple of 960)
  writeSilence(samples) {
    const frames = Math.max(0, Math.floor(samples / FRAME));
    for (let i = 0; i < frames; i++) this.writePacket(SILENCE, FRAME);
    return frames * FRAME;
  }

  flush(eos = false) {
    if (!this.packets.length && !eos) return;
    this.writePage(eos ? 0x04 : 0, this.granule, this.packets);
    this.packets = [];
    this.laces = 0;
    this.pendingBytes = 0;
  }

  flushIfOlder(ms) {
    if (this.packets.length && Date.now() - this.pageStartedAt >= ms) this.flush();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.flush(true);
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }

  toBuffer() {
    this.close();
    return Buffer.concat(this.memory || []);
  }
}

function parseHead(packet) {
  if (packet.length < 19 || packet.toString("latin1", 0, 8) !== "OpusHead") throw new Error("not an Ogg Opus stream");
  return { channels: packet[9], preSkip: packet.readUInt16LE(10) };
}

// Reads an Ogg Opus file page by page (constant memory) and yields its audio packets:
// { packet, start, samples }, start = sample position on the decoded output (pre-skip removed).
// Stops quietly at a page cut short (a file whose writer crashed is still readable up to there).
function* readOggPackets(file) {
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(27 + 255);
    let pos = 0;
    let pending = [];
    let index = 0;
    let head = null;
    let sample = 0;
    for (;;) {
      if (fs.readSync(fd, header, 0, 27, pos) < 27 || header.toString("latin1", 0, 4) !== "OggS") break;
      const nseg = header[26];
      if (fs.readSync(fd, header, 27, nseg, pos + 27) < nseg) break;
      let size = 0;
      for (let i = 0; i < nseg; i++) size += header[27 + i];
      const body = Buffer.alloc(size);
      if (fs.readSync(fd, body, 0, size, pos + 27 + nseg) < size) break;
      let off = 0;
      for (let i = 0; i < nseg; i++) {
        const lace = header[27 + i];
        pending.push(body.subarray(off, off + lace));
        off += lace;
        if (lace === 255) continue;
        const packet = pending.length === 1 ? pending[0] : Buffer.concat(pending);
        pending = [];
        if (index === 0) head = parseHead(packet);
        else if (index > 1) {
          const samples = packetSamples(packet);
          yield { packet, start: sample - head.preSkip, samples };
          sample += samples;
        }
        index++;
      }
      pos += 27 + nseg + size;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// { channels, preSkip } from a file's OpusHead
function readOggHead(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(27 + 255 + 64);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n < 28 || buf.toString("latin1", 0, 4) !== "OggS") throw new Error("not an Ogg file");
    return parseHead(buf.subarray(27 + buf[26]));
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { SAMPLE_RATE, FRAME, SILENCE, isSilence, packetSamples, OggOpusWriter, readOggPackets, readOggHead };
