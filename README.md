Just another discord bot with random stuff!

## Recording processing on your own PC (`npm run worker`)

After a recording ends, the bot builds a track per speaker, cuts/mixes them, transcribes and summarizes. That
is the slow part on a Heroku dyno (hours for a long night). `worker.js` does the same job on your PC instead,
while the bot on Heroku keeps recording.

**They never fight over a recording.** Both copies share the `recordings` table, and a recording is only worked
on by the copy holding its claim (`claimed_by` / `claim_expires_at`, renewed every ~30 s). Whichever copy picks a
job up first is the one that does it: the other sees the claim and leaves it alone. A step that's already done is
never repeated. If one copy dies (Heroku restarts, you close the laptop), its claim expires after 3 minutes and
the other copy carries on from the last finished step. A copy that loses the job mid-step stops within ~30 s and
writes nothing over the winner's work.

**Finished recordings are processed even while a new one is being recorded** - they're different files, so
there's nothing to protect. The worker on the PC has priority: while its heartbeat is fresh, Heroku's bot waits
(up to 10 minutes per job) for it to take the job, and only starts it itself if the PC isn't around. Whichever
copy claims a recording first is the one that does it, so the other never repeats the work.

### Setup (once)

1. Run `schema.sql` in Supabase again: it adds the claim columns (safe on the existing tables).
2. On the PC, put the same variables as Heroku in this folder's `.env`: `BOT_TOKEN`, `SUPABASE_URL`,
   `SUPABASE_KEY`, the `GDRIVE_*` three, and `RECORDING_GEMINI_API_KEY` (the last two are what actually let it
   finish a job: without Drive the audio can't be kept, without Gemini there's no transcript or summary).
3. `npm install` if you haven't, then start it.

### Running it

```bash
npm run worker            # picks up finished recordings as they appear, and watches in between
npm run worker -- --take  # also grabs a recording Heroku is processing right now (Heroku stops ~30 s later)
```

The worker is a plain REST + database client: it does **not** open a Discord gateway connection, so it never
appears online, never answers commands and never joins voice. It only edits the recording's panel, posts in its
thread, and uploads to Drive. Ctrl+C stops it; a job in progress is left for whichever copy is around next.

Optional variables: `PROCESSOR_NAME` (what this machine is called in the database, default: its host name),
`RECORDINGS_DIR` (working files; default is the OS temp folder - the mix of a long night needs a few GB there),
`FFMPEG_PATH` (use an ffmpeg you installed instead of the bundled one).

### What still costs time on the PC

Mixing/encoding/uploading are now as fast as your CPU and connection. Transcription and the summary are Gemini
API calls (the recorder's own `RECORDING_GEMINI_API_KEY`), so they stay network- and free-tier-bound wherever the
job runs - a faster PC doesn't speed those two up, it only stops them queueing behind a slow dyno. Transcribing a
long night with a local model (Whisper on your GPU) would be a separate change to `recording/transcribe.js`.
