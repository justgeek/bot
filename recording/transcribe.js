// recording/transcribe.js - transcripts (who said what) and summaries with Gemini, made for the free tier:
// few, large requests, and when the daily quota runs out the job pauses and carries on after the reset.
// Who said what is exact without any guessing: every speaker has their own track, and each request
// carries labelled clips cut from those tracks.
const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const { gamesList, PeopleTTS } = require("../config");
const { readOggPackets, readOggHead, OggOpusWriter } = require("./ogg");
const { MS } = require("./track");
const store = require("./store");
const drive = require("./drive");
const panel = require("./panel");
const { sleep, QuotaPause, UserError, nextQuotaReset, localStamp } = require("./util");

// Same as aiHandler.js: casual voice chat trips the default filters
const SAFETY = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"].map((category) => ({ category, threshold: "BLOCK_NONE" }));

// Recordings use their own Gemini key, not the "!!" chat's GEMINI_API_KEY, so they never eat its quota.
// Free-tier limits count per Google Cloud project: make this key in a different project from the other one.
const apiKey = () => process.env.RECORDING_GEMINI_API_KEY || "";
const geminiModelName = () => process.env.RECORDING_GEMINI_MODEL || "gemini-flash-latest";
const fallbackModel = () => process.env.RECORDING_GEMINI_FALLBACK_MODEL || null; // e.g. a Flash-Lite model, which gets more free requests
const NO_KEY = "RECORDING_GEMINI_API_KEY isn't set (Heroku config var), so there's no Gemini to ask";

// Segments: one person's stretch of speech. Pauses under 1.5 s are merged when nobody else started
// talking in between (keeps the conversation's order exact), up to 30 s each.
const MERGE_GAP_MS = 1500;
const MAX_SEGMENT_MS = 30000;
const MIN_SEGMENT_MS = 300;
// Per request: ~45 min of speech, well under Gemini's 20 MB inline limit (a 6-hour night is ~12 requests)
const BATCH_SPEECH_MS = 45 * 60000;
const BATCH_BYTES = 12 * 1024 * 1024;
const BATCH_SEGMENTS = 900;

// ---------- Text helpers ----------
// For search: lower case, Arabic diacritics dropped and letter variants unified (أ إ آ -> ا, ى -> ي, ة -> ه)
function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const wordCount = (s) => String(s || "").replace(/\[[^\]]*\]/g, " ").split(/\s+/).filter(Boolean).length;

function timestamp(ms, sep) {
  const t = Math.max(0, Math.round(ms));
  return `${panel.hms(t)}${sep}${String(t % 1000).padStart(3, "0")}`;
}

// ---------- Segments ----------
// speech: { userId: [[startMs, endMs], ...] } (from processor.js) -> [{ id, user, start, end }] in time order
function buildSegments(speech) {
  const all = [];
  for (const [user, intervals] of Object.entries(speech || {})) {
    for (const [s, e] of intervals) {
      // An open mic can give one endless stretch; cut it into pieces
      for (let a = s; a < e; a += MAX_SEGMENT_MS) all.push({ user, start: a, end: Math.min(e, a + MAX_SEGMENT_MS) });
    }
  }
  all.sort((a, b) => a.start - b.start || (a.user < b.user ? -1 : 1));

  // Did someone other than `user` start talking within (from, to)?
  const othersStarted = (from, to, user) => {
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid].start <= from) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < all.length && all[i].start < to; i++) if (all[i].user !== user) return true;
    return false;
  };

  const segments = [];
  const open = new Map(); // user -> their current segment
  for (const iv of all) {
    const cur = open.get(iv.user);
    if (cur && iv.start - cur.end < MERGE_GAP_MS && iv.end - cur.start <= MAX_SEGMENT_MS && !othersStarted(cur.end, iv.start, iv.user)) {
      cur.end = Math.max(cur.end, iv.end);
      continue;
    }
    const seg = { user: iv.user, start: iv.start, end: iv.end };
    segments.push(seg);
    open.set(iv.user, seg);
  }
  return segments
    .filter((s) => s.end - s.start >= MIN_SEGMENT_MS)
    .sort((a, b) => a.start - b.start || (a.user < b.user ? -1 : 1))
    .map((s, i) => ({ id: String(i + 1), ...s }));
}

// Cuts pieces out of one speaker's compressed track without re-encoding (the packets are copied as is).
// Calls must go forward in time; the file is read once from start to end.
class SegmentCutter {
  constructor(file) {
    this.head = readOggHead(file);
    this.iter = readOggPackets(file);
    this.buf = [];
    this.eof = false;
  }

  cut(startMs, endMs) {
    const from = Math.round(startMs * MS);
    const to = Math.round(endMs * MS);
    const preroll = from - 80 * MS; // the decoder needs a little audio before the cut to settle
    while (!this.eof && (!this.buf.length || this.buf[this.buf.length - 1].start < to)) {
      const next = this.iter.next();
      if (next.done) this.eof = true;
      else if (next.value.start + next.value.samples > preroll) this.buf.push(next.value);
    }
    let drop = 0;
    while (drop < this.buf.length && this.buf[drop].start + this.buf[drop].samples <= preroll) drop++;
    if (drop) this.buf.splice(0, drop);
    const packets = this.buf.filter((p) => p.start < to);
    if (!packets.length) return null;
    const preSkip = Math.max(0, Math.min(65535, from - packets[0].start));
    const w = new OggOpusWriter(null, { channels: this.head.channels, preSkip });
    for (const p of packets) w.writePacket(p.packet, p.samples);
    return w.toBuffer();
  }

  close() {
    this.iter.return?.();
  }
}

// ---------- Gemini ----------
function geminiModel(name, { schema, system } = {}) {
  if (!apiKey()) throw new Error(NO_KEY);
  const generationConfig = { temperature: 0.2 };
  if (schema) Object.assign(generationConfig, { responseMimeType: "application/json", responseSchema: schema });
  return new GoogleGenerativeAI(apiKey()).getGenerativeModel({ model: name, safetySettings: SAFETY, systemInstruction: system, generationConfig });
}

const isDailyQuota = (err) => /PerDay|per day|daily/i.test(JSON.stringify(err.errorDetails || []) + " " + (err.message || ""));
function retryDelayMs(err) {
  for (const d of err.errorDetails || []) if (d?.retryDelay) return (parseFloat(d.retryDelay) || 60) * 1000;
  return 60000;
}

// Retries rate limits (per minute) and Google's hiccups; err.daily = the day's quota is used up
async function generate(modelName, parts, opts) {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await geminiModel(modelName, opts).generateContent({ contents: [{ role: "user", parts }] });
      return result.response;
    } catch (err) {
      const status = Number(err.status) || 0;
      if (status === 429) {
        if (isDailyQuota(err) || attempt > 8) {
          err.daily = true;
          throw err;
        }
        await sleep(retryDelayMs(err) + 1000);
        continue;
      }
      if ((status >= 500 || !status) && attempt <= 4 && !(err instanceof SyntaxError)) {
        await sleep(10000 * attempt);
        continue;
      }
      throw err;
    }
  }
}

const TRANSCRIPT_SCHEMA = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: { id: { type: SchemaType.STRING }, text: { type: SchemaType.STRING } },
    required: ["id", "text"],
  },
};

function vocabulary(rec) {
  const names = new Set(Object.values(rec.speakers || {}).map((s) => s.name).filter(Boolean));
  for (const spoken of Object.values(PeopleTTS || {})) names.add(spoken);
  return { names: [...names], games: gamesList || [] };
}

function transcribePrompt({ names, games }) {
  return [
    "You transcribe a Discord voice chat between a group of Egyptian friends (usually while gaming).",
    'Every audio clip comes right after its label "[id] speaker name" and holds one stretch of that one person\'s speech.',
    'For EVERY id return {"id": "<id>", "text": "<what they said>"}:',
    "- Write exactly what was said, in the language spoken: Egyptian Arabic in Arabic script, English and game words in Latin letters, mixed the way they mix them.",
    "- Do not translate, summarize, censor, fix grammar or add words. Keep slang and swearing as said.",
    '- Mark non-speech only when it matters, briefly in brackets like [laughs] or [unclear]. Use "" when a clip has no speech.',
    "- Never merge clips together and never skip an id.",
    names.length ? `People in this chat (and their nicknames): ${names.join(", ")}.` : "",
    games.length ? `Games and words that often come up: ${games.join(", ")}.` : "",
  ].filter(Boolean).join("\n");
}

// Sends one batch; when the reply can't be used (cut off, blocked), splits the batch and tries the halves
async function transcribeBatch(batch, model, vocab) {
  const parts = [{ text: `Transcribe these ${batch.length} clips.` }];
  for (const seg of batch) {
    parts.push({ text: `[${seg.id}] ${seg.name}` });
    parts.push({ inlineData: { mimeType: "audio/ogg", data: seg.audio.toString("base64") } });
  }
  try {
    const response = await generate(model, parts, { schema: TRANSCRIPT_SCHEMA, system: transcribePrompt(vocab) });
    const map = {};
    for (const item of JSON.parse(response.text())) {
      if (item && item.id !== undefined) map[String(item.id).replace(/[[\]\s]/g, "")] = String(item.text || "").trim();
    }
    // Ids it skipped get one more (smaller) request
    const missed = batch.filter((s) => !(s.id in map));
    if (missed.length && missed.length < batch.length) Object.assign(map, await transcribeBatch(missed, model, vocab));
    return map;
  } catch (err) {
    // Only problems with this batch's content are worth splitting for (a cut-off or blocked reply, too big);
    // a bad key or model name would fail for every piece, so those stop the step
    const batchProblem = err instanceof SyntaxError || /blocked|safety|recitation|max_tokens/i.test(err.message || "") || (Number(err.status) === 400 && /size|large|exceed|token/i.test(err.message || ""));
    if (err.daily || !batchProblem) throw err;
    if (batch.length === 1) {
      console.warn(`[Rec] Clip ${batch[0].id} couldn't be transcribed: ${err.message}`);
      return { [batch[0].id]: "" };
    }
    console.warn(`[Rec] A transcript batch of ${batch.length} failed (${err.message}), splitting it`);
    const half = Math.ceil(batch.length / 2);
    return { ...(await transcribeBatch(batch.slice(0, half), model, vocab)), ...(await transcribeBatch(batch.slice(half), model, vocab)) };
  }
}

// ---------- Transcript step (called by processor.js) ----------
async function transcriptStep(rec, ctx) {
  const out = rec.outputs;
  const segments = buildSegments(out.speech);
  const names = Object.fromEntries(Object.entries(rec.speakers || {}).map(([u, s]) => [u, s.name || u]));
  const done = out.transcriptParts || (out.transcriptParts = {});
  const pending = segments.filter((s) => !(s.id in done));

  if (pending.length) {
    if (!apiKey()) throw new Error(NO_KEY);
    const files = await ctx.trackFiles();
    const missing = [...new Set(pending.map((s) => s.user))].filter((u) => !files[u]);
    if (missing.length) throw new Error(`the audio of ${missing.map((u) => names[u] || u).join(", ")} isn't available to transcribe`);
    const vocab = vocabulary(rec);
    const pendingMs = pending.reduce((a, s) => a + s.end - s.start, 0);
    const estimate = Math.max(1, Math.ceil(pendingMs / BATCH_SPEECH_MS));
    const cutters = new Map();
    let model = geminiModelName();
    let onFallback = false;
    let batch = [];
    let batchMs = 0;
    let batchBytes = 0;
    let batchNo = 0;

    const flush = async () => {
      if (!batch.length) return;
      batchNo++;
      ctx.progress("transcript", "running", `request ${batchNo} of ~${estimate}`);
      let result;
      for (;;) {
        try {
          result = await transcribeBatch(batch, model, vocab);
          break;
        } catch (err) {
          if (!err.daily) throw err;
          if (fallbackModel() && !onFallback) {
            console.warn(`[Rec] ${model} is out of free quota for today, switching to ${fallbackModel()}`);
            model = fallbackModel();
            onFallback = true;
            continue;
          }
          throw new QuotaPause("transcript", nextQuotaReset());
        }
      }
      for (const seg of batch) done[seg.id] = result[seg.id] ?? "";
      await ctx.save(); // a restart or a quota pause keeps what's done
      batch = [];
      batchMs = 0;
      batchBytes = 0;
    };

    ctx.progress("transcript", "running", `0 of ~${estimate} requests`);
    try {
      for (const seg of pending) {
        let cutter = cutters.get(seg.user);
        if (!cutter) cutters.set(seg.user, (cutter = new SegmentCutter(files[seg.user])));
        const audioClip = cutter.cut(seg.start, seg.end);
        if (!audioClip) {
          done[seg.id] = "";
          continue;
        }
        batch.push({ ...seg, name: names[seg.user] || seg.user, audio: audioClip });
        batchMs += seg.end - seg.start;
        batchBytes += audioClip.length;
        if (batchMs >= BATCH_SPEECH_MS || batchBytes >= BATCH_BYTES || batch.length >= BATCH_SEGMENTS) await flush();
      }
      await flush();
    } finally {
      for (const c of cutters.values()) c.close();
    }
  }

  const lines = segments
    .map((s) => ({ s, text: (done[s.id] || "").trim() }))
    .filter(({ text }) => text && !/^(\[[^\]]*\]\s*)+$/.test(text))
    .map(({ s, text }) => ({ start_ms: s.start, end_ms: s.end, user_id: s.user, name: names[s.user] || s.user, text, norm: normalizeText(text) }));
  ctx.lines = lines;

  // Words per person for the report card
  if (rec.report?.speakers) {
    const words = {};
    for (const l of lines) words[l.user_id] = (words[l.user_id] || 0) + wordCount(l.text);
    for (const s of rec.report.speakers) s.words = words[s.user] || 0;
  }

  const filesOut = writeTranscriptFiles(rec, lines, ctx.dir);
  out.files = out.files || {};
  if (drive.enabled && rec.drive_folder_id) {
    ctx.progress("transcript", "running", "uploading");
    out.files.transcript = await drive.upload(rec.drive_folder_id, "transcript.txt", filesOut.txt, "text/plain; charset=utf-8");
    await drive.upload(rec.drive_folder_id, "transcript.srt", filesOut.srt, "application/x-subrip");
    await drive.upload(rec.drive_folder_id, "transcript.vtt", filesOut.vtt, "text/vtt");
    await drive.upload(rec.drive_folder_id, "transcript.json", filesOut.json, "application/json");
  }
  await store.replaceLines(rec.id, lines);
  delete out.transcriptParts; // the lines now live in recording_lines and on Drive
  ctx.progress("transcript", "done", `${lines.length} lines`);
  await ctx.save();

  const thread = await ctx.thread();
  if (thread && !out.posted?.transcript) {
    await ctx.postReport();
    await thread.send({ content: `📄 Transcript (${lines.length} lines)`, files: [{ attachment: filesOut.txt, name: "transcript.txt" }] }).catch((err) => console.warn("[Rec] Couldn't post the transcript:", err.message));
    out.posted.transcript = true;
    await ctx.save();
  }
}

function writeTranscriptFiles(rec, lines, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const nameOf = (u) => rec.speakers?.[u]?.name || u;
  const notes = (rec.events || []).filter((e) => e.type === "note").map((e) => ({ start_ms: e.t, name: `📝 NOTE (${nameOf(e.user)})`, text: e.text }));
  const all = [...lines, ...notes].sort((a, b) => a.start_ms - b.start_ms);
  const started = Date.parse(rec.started_at);
  const head = [
    `Recording ${rec.id} - ${rec.channel_name || "Voice"} - ${localStamp(started)} (Cairo time)`,
    `Speakers: ${Object.values(rec.speakers || {}).map((s) => s.name).join(", ")}`,
    "",
  ];
  const txt = head.concat(all.map((l) => `[${panel.hms(l.start_ms)}] ${l.name}: ${l.text}`)).join("\n") + "\n";
  const srt = lines.map((l, i) => `${i + 1}\n${timestamp(l.start_ms, ",")} --> ${timestamp(l.end_ms, ",")}\n${l.name}: ${l.text}\n`).join("\n");
  const vtt = "WEBVTT\n\n" + lines.map((l) => `${timestamp(l.start_ms, ".")} --> ${timestamp(l.end_ms, ".")}\n<v ${l.name.replace(/[<>]/g, "")}>${l.text}\n`).join("\n");
  const json = JSON.stringify({ id: rec.id, channel: rec.channel_name, started_at: rec.started_at, speakers: rec.speakers, lines: lines.map(({ norm, ...l }) => l), notes }, null, 1);
  const files = { txt: path.join(dir, "transcript.txt"), srt: path.join(dir, "transcript.srt"), vtt: path.join(dir, "transcript.vtt"), json: path.join(dir, "transcript.json") };
  fs.writeFileSync(files.txt, txt);
  fs.writeFileSync(files.srt, srt);
  fs.writeFileSync(files.vtt, vtt);
  fs.writeFileSync(files.json, json);
  return files;
}

// ---------- Summary step ----------
const SUMMARY_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: { en: { type: SchemaType.STRING }, ar: { type: SchemaType.STRING } },
  required: ["en", "ar"],
};

const SUMMARY_SYSTEM = [
  "You summarize recorded Discord voice sessions of a group of Egyptian friends (mostly gaming nights).",
  'You get the session details and a transcript where each line is "[hh:mm:ss] Speaker: what they said".',
  "Write the same summary twice: `en` in English, and `ar` in Egyptian Arabic (Arabic script, casual Egyptian wording, not formal Arabic).",
  "Each one in Discord markdown with these sections as ### headings:",
  "TL;DR (2-4 bullets) · Timeline (the main stretches and topics, each with its [hh:mm:ss]) · Highlights & funny moments (short quotes in their original language, with who said them) · Plans & decisions (or that there were none) · People (one line per person on what they were up to) · Notes (only if people added notes).",
  "Be concrete and only use what is in the transcript. Keep each version under 3500 characters.",
].join("\n");

function sessionHeader(rec) {
  const started = Date.parse(rec.started_at);
  const ended = rec.ended_at ? Date.parse(rec.ended_at) : Date.now();
  const lines = [`Session: ${rec.channel_name || "Voice"}, ${localStamp(started)} (Cairo time), ${panel.human(ended - started)} long.`];
  if (rec.report?.speakers?.length) lines.push("Talk time: " + rec.report.speakers.map((s) => `${s.name} ${panel.human(s.talkMs)}`).join(", ") + ".");
  const notes = (rec.events || []).filter((e) => e.type === "note");
  if (notes.length) lines.push("Notes added during the recording:\n" + notes.map((e) => `[${panel.hms(e.t)}] ${rec.speakers?.[e.user]?.name || "someone"}: ${e.text}`).join("\n"));
  const clips = (rec.events || []).filter((e) => e.type === "clip");
  if (clips.length) lines.push(`Moments people clipped: ${clips.map((e) => e.text.replace(/`/g, "")).join(", ")}.`);
  return lines.join("\n");
}

const transcriptText = (lines) => lines.map((l) => `[${panel.hms(l.start_ms)}] ${l.name}: ${l.text}`).join("\n");

async function summaryStep(rec, ctx) {
  ctx.progress("summary", "running", "writing it");
  const lines = ctx.lines || (await store.getLines(rec.id));
  if (!lines.length) {
    ctx.progress("summary", "done", "nothing was said to summarize");
    return;
  }
  if (!apiKey()) throw new Error(NO_KEY);
  let response;
  try {
    response = await generate(geminiModelName(), [{ text: `${sessionHeader(rec)}\n\nTranscript:\n${transcriptText(lines)}` }], { schema: SUMMARY_SCHEMA, system: SUMMARY_SYSTEM });
  } catch (err) {
    if (err.daily) throw new QuotaPause("summary", nextQuotaReset());
    throw err;
  }
  const { en, ar } = JSON.parse(response.text());
  rec.summary_en = String(en || "").trim();
  rec.summary_ar = String(ar || "").trim();
  if (drive.enabled && rec.drive_folder_id) {
    await drive.upload(rec.drive_folder_id, "summary.en.md", Buffer.from(rec.summary_en + "\n"), "text/markdown; charset=utf-8");
    await drive.upload(rec.drive_folder_id, "summary.ar.md", Buffer.from(rec.summary_ar + "\n"), "text/markdown; charset=utf-8");
  }
  ctx.progress("summary", "done", "English + Egyptian Arabic, in the thread");
  await ctx.save();
  const thread = await ctx.thread();
  if (thread && !rec.outputs.posted?.summary) {
    for (const msg of panel.summaryMessages(rec)) await thread.send(msg).catch((err) => console.warn("[Rec] Couldn't post the summary:", err.message));
    rec.outputs.posted.summary = true;
    await ctx.save();
  }
}

// ---------- !search ----------
async function search(query, limit = 5) {
  const words = normalizeText(query).split(" ").filter((w) => w.length >= 2);
  const rows = await store.searchLines(words, limit);
  for (const r of rows) r.started_at = (await store.getRecording(r.recording_id))?.started_at || new Date().toISOString();
  return rows;
}

// ---------- !ask ----------
const ASK_SYSTEM = [
  "You answer questions about a group of Egyptian friends' recorded Discord voice sessions.",
  "You get summaries of recent sessions and the full transcripts of the most relevant ones ([hh:mm:ss] Speaker: text).",
  "Answer in the language of the question (Egyptian Arabic if they asked in Arabic). Be short and concrete.",
  "Point to where it came from like (16 Oct · 01:23:45 · Mido). If the recordings don't say, just say so - never make things up.",
].join("\n");

const MAX_ASK_CHARS = 600000; // ~200k tokens: stays inside the free tier's tokens-per-minute

async function ask(question) {
  if (!apiKey()) throw new UserError("RECORDING_GEMINI_API_KEY isn't set yet (Heroku config var).");
  const since = new Date(Date.now() - 30 * 86400e3).toISOString();
  const summaries = await store.recentSummaries(since);
  // Read in full the sessions with the most lines matching the question's words (else the latest one)
  const hits = new Map();
  for (const w of normalizeText(question).split(" ").filter((x) => x.length >= 3).slice(0, 8)) {
    for (const r of await store.searchLines([w], 50)) hits.set(r.recording_id, (hits.get(r.recording_id) || 0) + 1);
  }
  let ids = [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  if (!ids.length && summaries[0]) ids = [summaries[0].id];

  const parts = [`Question: ${question}`];
  if (summaries.length) {
    parts.push("Summaries of the last 30 days:\n" + summaries.map((s) => `## ${localStamp(Date.parse(s.started_at))} · ${s.channel_name}\n${s.summary_en}`).join("\n\n"));
  }
  let budget = MAX_ASK_CHARS - parts.join("\n").length;
  for (const id of ids.slice(0, 4)) {
    const rec = await store.getRecording(id);
    const body = transcriptText(await store.getLines(id));
    if (!rec || !body) continue;
    const block = `Transcript of ${localStamp(Date.parse(rec.started_at))} · ${rec.channel_name}:\n${body}`;
    if (block.length > budget) {
      if (budget > 50000) parts.push(block.slice(0, budget));
      break;
    }
    parts.push(block);
    budget -= block.length;
  }
  if (parts.length === 1) throw new UserError("There are no transcribed recordings to look through yet.");
  try {
    const response = await generate(geminiModelName(), [{ text: parts.join("\n\n") }], { system: ASK_SYSTEM });
    return response.text().trim() || "I couldn't find anything about that.";
  } catch (err) {
    if (err.daily) throw new UserError(`Gemini's free daily limit is used up - try again after <t:${Math.floor(nextQuotaReset() / 1000)}:t>.`);
    throw err;
  }
}

const hasGeminiKey = () => !!apiKey();

module.exports = { normalizeText, buildSegments, SegmentCutter, transcriptStep, summaryStep, search, ask, writeTranscriptFiles, hasGeminiKey };
