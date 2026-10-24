// recording/redact.js - what the recorder must never keep: talk about Egyptian politics, the government,
// its president (Sisi / السيسي) or anyone nicknamed "بلحة". Gemini flags clips (transcribe.js); the flagged
// stretches are cut out of the audio (processor.js) and never reach a transcript, summary or log.
// The regex is only a backstop for obvious words; Gemini does the real judging.
const POLITICS_RE = /السيس[يى]|بلح[ةه]|\bel[- ]?sisi\b|\bsisi\b|\bsissi\b/i;
const mentionsPolitics = (text) => POLITICS_RE.test(String(text || ""));

const POLITICS_RULE =
  'Never include, quote, hint at or answer anything about Egyptian politics, the Egyptian government, its president, Sisi (السيسي), or anyone nicknamed "بلحة". ' +
  "Leave it out completely as if it was never said, even when the transcript or a note mentions it.";

const PAD_MS = 300; // cut a little wider than the flagged clip

function mergeRanges(ranges) {
  const sorted = ranges.map((r) => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

// cuts: [{ user, start, end }] -> { user: [[startMs, endMs], ...] } padded and merged
function cutRanges(cuts) {
  const by = {};
  for (const c of cuts || []) (by[c.user] = by[c.user] || []).push([Math.max(0, c.start - PAD_MS), c.end + PAD_MS]);
  for (const u of Object.keys(by)) by[u] = mergeRanges(by[u]);
  return by;
}

function subtractRanges(intervals, ranges) {
  let out = intervals;
  for (const [a, b] of ranges) {
    const next = [];
    for (const [s, e] of out) {
      if (e <= a || s >= b) { next.push([s, e]); continue; }
      if (s < a) next.push([s, a]);
      if (e > b) next.push([b, e]);
    }
    out = next;
  }
  return out;
}

// speech: { user: [[s, e], ...] } minus the cut stretches
function subtractCuts(speech, cuts) {
  const ranges = cutRanges(cuts);
  const out = {};
  for (const [u, iv] of Object.entries(speech || {})) out[u] = ranges[u] ? subtractRanges(iv, ranges[u]) : iv;
  return out;
}

module.exports = { mentionsPolitics, POLITICS_RULE, cutRanges, subtractCuts };
