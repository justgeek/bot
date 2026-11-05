// worker.js - runs the recording processor on this PC instead of Heroku (`npm run worker`).
//
// It shares the recordings database with the bot on Heroku: only one of them works on a recording at a
// time (a claim in the database, renewed while it works), so whichever finishes a step first is the one
// that counts and the other stops as soon as it notices. Finished recordings are processed even while a
// new one is being recorded (they're different files). No gateway connection: it never appears online
// and can't join voice.
//
// Setup: the same variables as Heroku in this folder's .env (BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY,
// GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN, and RECORDING_GEMINI_API_KEY for
// transcripts and summaries), plus optionally:
//   PROCESSOR_NAME             what this machine is called in the database (default: its host name)
//   RECORDINGS_DIR             where the working files go (default: the OS temp folder; the mix of a long
//                              night needs a few GB there)
//   FFMPEG_PATH                a faster ffmpeg than the bundled one, if you have it
//
// npm run worker            pick up finished recordings as they appear
// npm run worker -- --take  also take over a recording another copy is processing right now (it stops)
require("dotenv").config({ override: true });
require("node:dns").setDefaultResultOrder("ipv4first");

const os = require("os");
const processor = require("./recording/processor");
const store = require("./recording/store");
const drive = require("./recording/drive");
const transcribe = require("./recording/transcribe");
const { makeRestClient } = require("./recording/rest");
const { WORK_DIR } = require("./recording/util");
const { Recording: cfg } = require("./config");

const takeOver = process.argv.includes("--take") || process.env.TAKE_OVER === "1";

if (!process.env.BOT_TOKEN) {
  console.error("BOT_TOKEN isn't set - put it in this folder's .env (the same one Heroku uses).");
  process.exit(1);
}
if (!store.enabled) {
  console.error("SUPABASE_URL / SUPABASE_KEY aren't set - the worker reads the bot's recordings from that database.");
  process.exit(1);
}

console.log(`[Rec] Processor worker on ${process.env.PROCESSOR_NAME || os.hostname()} (node ${process.version})`);
console.log(`[Rec] Working files: ${WORK_DIR}`);
console.log(`[Rec] Google Drive: ${drive.enabled ? "connected" : "NOT connected - the audio would stay on this PC"}`);
console.log(`[Rec] Gemini: ${transcribe.hasGeminiKey() ? "key set" : "no RECORDING_GEMINI_API_KEY (transcripts and summaries can't be made)"}`);
console.log(
  `[Rec] Watching for finished recordings every ${cfg.workerPollSeconds}s.` +
    (takeOver ? " Taking over a job another copy is on." : "")
);

const client = makeRestClient(process.env.BOT_TOKEN);

processor.startLocalWorker(client, { takeOver }).catch((err) => {
  console.error("[Rec] The worker couldn't start:", err);
  process.exit(1);
});

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: stopping (the job stays in the database for whichever copy is around)...`);
    processor.shutdown();
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
