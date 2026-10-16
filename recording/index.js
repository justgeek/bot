// recording/index.js - the recorder's entry point (Craig-style multi-track recording).
// Starts/stops recordings (control panel button, !record, or auto-record), handles every button and
// command in #record, and after a bot restart resumes the recording and any unfinished processing.
// Recording commands only count in #record; anywhere else events.js treats them as normal TTS.
const fs = require("fs");
const path = require("path");
const { MessageFlags } = require("discord.js");
const { IDs, Recording: cfg } = require("../config");
const audio = require("../audioManager");
const db = require("../db");
const store = require("./store");
const drive = require("./drive");
const panel = require("./panel");
const processor = require("./processor");
const transcribe = require("./transcribe");
const clip = require("./clip");
const { RecordingSession } = require("./session");
const { WORK_DIR, UserError, newId, isAdmin, sleep } = require("./util");

const DEFAULT_SETTINGS = {
  autoRecord: false,
  autoChannels: [], // none = every voice channel except the secret one and AFK
  minPeople: cfg.autoMinPeople,
  transcribe: true,
  summarize: true,
  retentionDays: 0, // 0 = keep audio forever
  controlPanelMessageId: null,
};

let client = null;
let settings = { ...DEFAULT_SETTINGS };
let active = null; // the RecordingSession running now (one at a time: one voice connection per server)
let starting = false;
let resuming = false; // right after startup, while a recording a restart cut off is being picked up again
let shuttingDown = false;
let initialized = false;
let autoTimer = null;
let autoSnooze = null; // channel id auto-record leaves alone after someone stopped its recording
let quotaCache = null;
let lastRetention = 0;

const saveSettings = () => store.setSetting("recording", settings);
const guild = () => client?.guilds.cache.get(IDs.guild);

// ---------- Start / stop ----------
async function startSession(rec, { fresh }) {
  if (!fresh) rec.parts = (rec.parts || 1) + 1;
  const session = new RecordingSession(client, rec, { onEnded: (r, hadAudio) => ended(session, r, hadAudio) });
  active = session;
  try {
    await session.begin({ fresh });
  } catch (err) {
    if (active === session) active = null;
    throw err;
  }
  refreshControlPanel();
  return session;
}

async function startRecording(channel, startedBy) {
  if (shuttingDown) throw new UserError("The bot is restarting, try again in a moment.");
  if (resuming) throw new UserError("I'm still starting up (picking up the last recording), try again in a moment.");
  if (active || starting) throw new UserError(active ? `Already recording in <#${active.channelId}>.` : "A recording is starting already.");
  if (!channel?.isVoiceBased?.()) throw new UserError("Join a voice channel first.");
  if (audio.countHumans(channel) === 0) throw new UserError("Nobody's in that voice channel.");
  starting = true;
  try {
    const rec = {
      id: newId(),
      guild_id: channel.guild.id,
      channel_id: channel.id,
      channel_name: channel.name,
      started_by: startedBy || null,
      started_at: new Date().toISOString(),
      status: "recording",
      parts: 1,
      options: { transcribe: !!settings.transcribe, summarize: !!(settings.transcribe && settings.summarize) },
      events: [],
      speakers: {},
      outputs: {},
    };
    return await startSession(rec, { fresh: true });
  } finally {
    starting = false;
  }
}

function ended(session, rec, hadAudio) {
  if (active === session) active = null;
  // After someone stopped it (or the bot got kicked/moved), auto-record leaves that channel alone until it empties
  if (rec.end_reason !== "max") autoSnooze = rec.channel_id;
  if (hadAudio) processor.enqueue(rec.id);
  refreshControlPanel({ repost: true }); // back below the finished recording
  setTimeout(evaluateAuto, 3000);
}

// ---------- Auto-record ----------
function autoCandidates() {
  const g = guild();
  if (!g) return [];
  const picked = settings.autoChannels || [];
  const out = [];
  for (const ch of g.channels.cache.values()) {
    if (!ch.isVoiceBased?.()) continue;
    if (picked.length ? !picked.includes(ch.id) : ch.id === IDs.voice2 || db.isAfkChannel(ch.id, ch.name, client)) continue;
    const humans = audio.countHumans(ch);
    if (ch.id === autoSnooze) {
      if (humans < settings.minPeople) autoSnooze = null;
      continue;
    }
    if (humans >= settings.minPeople) out.push({ channel: ch, humans });
  }
  return out.sort((a, b) => b.humans - a.humans);
}

function evaluateAuto() {
  if (!client) return;
  const candidates = autoCandidates(); // also clears a snooze once that channel empties
  if (!settings.autoRecord || active || starting || resuming || shuttingDown) return;
  if (!candidates.length) {
    clearTimeout(autoTimer);
    autoTimer = null;
    return;
  }
  if (autoTimer) return;
  // The channel has to stay full for a few seconds (ignores someone popping in and out)
  autoTimer = setTimeout(async () => {
    autoTimer = null;
    const best = autoCandidates()[0];
    if (!best || !settings.autoRecord || active || starting || shuttingDown) return;
    try {
      await startRecording(best.channel, null);
    } catch (err) {
      console.warn("[Rec] Auto-record didn't start:", err.message);
    }
  }, cfg.autoStartDelaySeconds * 1000);
}

// ---------- Voice state changes (from events.js) ----------
function onVoiceStateUpdate(before, after) {
  try {
    if (!client) return;
    if (after.id === client.user.id) {
      // The bot itself was disconnected from voice or dragged elsewhere
      if (active?.active && !active.recovering) {
        if (!after.channelId && before.channelId === active.channelId) active.stop("kicked");
        else if (after.channelId && after.channelId !== active.channelId) active.stop("moved");
      }
      return;
    }
    if (before.channelId === after.channelId || after.member?.user?.bot) return;
    if (active?.active) {
      if (after.channelId === active.channelId) active.memberJoined(after.id);
      else if (before.channelId === active.channelId) active.memberLeft(after.id);
    }
    evaluateAuto();
  } catch (err) {
    console.error("[Rec] voiceStateUpdate failed:", err);
  }
}

// ---------- Control panel ----------
let controlMsg = null;
let controlChain = Promise.resolve();
function refreshControlPanel({ repost = false } = {}) {
  controlChain = controlChain.then(() => renderControlPanel(repost)).catch((err) => console.warn("[Rec] Control panel update failed:", err.message));
  return controlChain;
}

const controlPayload = () =>
  panel.controlPanel({ settings, active: active ? { channelId: active.channelId } : null, quota: quotaCache, driveEnabled: drive.enabled, dbEnabled: store.enabled, geminiKey: transcribe.hasGeminiKey() });

async function renderControlPanel(repost) {
  const channel = await client.channels.fetch(IDs.channelRecord).catch(() => null);
  if (!channel) return console.warn("[Rec] #record channel not found (IDs.channelRecord).");
  if (!controlMsg && settings.controlPanelMessageId) controlMsg = await channel.messages.fetch(settings.controlPanelMessageId).catch(() => null);
  if (controlMsg && repost) {
    await controlMsg.delete().catch(() => { });
    controlMsg = null;
  }
  // Someone deleted it by hand: post a new one
  if (controlMsg) await controlMsg.edit(controlPayload()).catch(() => (controlMsg = null));
  if (!controlMsg) {
    controlMsg = await channel.send(controlPayload());
    settings.controlPanelMessageId = controlMsg.id;
    await saveSettings();
  }
}

// ---------- Permissions ----------
function requireAdmin(member) {
  if (!isAdmin(member)) throw new UserError("Only admins can do that.");
}

// Anyone in the voice channel being recorded (or an admin)
function requireInChannel(member, channelId) {
  if (isAdmin(member) || member?.voice?.channelId === channelId) return;
  throw new UserError(`Only people in <#${channelId}> can do that.`);
}

// People who were in the recording (or an admin)
function requireParticipant(member, rec) {
  if (isAdmin(member) || rec.speakers?.[member?.id] || (rec.events || []).some((e) => e.user === member?.id)) return;
  throw new UserError("Only people who were in that recording can do that.");
}

function liveSession(recId) {
  if (!active || active.id !== recId || !active.active) throw new UserError("That recording isn't running anymore.");
  return active;
}

function clampSeconds(arg) {
  const n = parseInt(arg, 10);
  return Math.min(cfg.clipMaxSeconds, Math.max(5, Number.isFinite(n) ? n : cfg.clipSeconds));
}

// ---------- Commands (only in #record) ----------
const COMMAND_RE = /^!(record|stoprecord|note|clip|recordings|autorecord|search|ask)(?=\s|$)/i;

async function handleCommand(msg) {
  if (!client || msg.channel.id !== IDs.channelRecord) return false;
  const content = msg.content.trim();
  const m = COMMAND_RE.exec(content);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const arg = content.slice(m[0].length).trim();
  try {
    if (cmd === "record") {
      await startRecording(msg.member?.voice?.channel, msg.author.id);
      await msg.react("🔴").catch(() => { });
    } else if (cmd === "stoprecord") {
      if (!active) throw new UserError("Nothing is being recorded.");
      requireInChannel(msg.member, active.channelId);
      await msg.react("⏹️").catch(() => { });
      await active.stop("stopped", msg.author.id);
    } else if (cmd === "note") {
      if (!arg) throw new UserError("Write the note after the command: `!note <text>`");
      if (!active) throw new UserError("Nothing is being recorded.");
      requireInChannel(msg.member, active.channelId);
      await active.note(msg.author.id, arg);
      await msg.react("📝").catch(() => { });
    } else if (cmd === "clip") {
      if (!active) throw new UserError("Nothing is being recorded.");
      requireInChannel(msg.member, active.channelId);
      await msg.channel.sendTyping().catch(() => { });
      await active.clip(msg.author.id, clampSeconds(arg));
      await msg.react("✂️").catch(() => { });
    } else if (cmd === "recordings") {
      await msg.reply(panel.recordingsList(await store.listRecordings(10)));
    } else if (cmd === "autorecord") {
      requireAdmin(msg.member);
      settings.autoRecord = /^(on|enable|yes|1)$/i.test(arg) ? true : /^(off|disable|no|0)$/i.test(arg) ? false : !settings.autoRecord;
      await saveSettings();
      refreshControlPanel();
      await msg.reply({ content: `🤖 Auto-record is **${settings.autoRecord ? "on" : "off"}**.`, allowedMentions: { parse: [] } });
      evaluateAuto();
    } else if (cmd === "search") {
      if (!arg) throw new UserError("What should I look for? `!search <words>`");
      await msg.reply(panel.searchResults(arg, await transcribe.search(arg, 5)));
    } else if (cmd === "ask") {
      if (!arg) throw new UserError("Ask something: `!ask <question>`");
      await msg.channel.sendTyping().catch(() => { });
      const answer = await transcribe.ask(arg);
      for (const part of panel.splitText(answer, 1900)) await msg.reply({ content: part, allowedMentions: { parse: [] } });
    }
  } catch (err) {
    if (!(err instanceof UserError)) console.error(`[Rec] !${cmd} failed:`, err);
    await msg.reply({ content: err instanceof UserError ? `⚠️ ${err.message}` : "❌ That didn't work (details are in the bot's logs).", allowedMentions: { parse: [] } }).catch(() => { });
  }
  return true;
}

// ---------- Buttons, selects and modals ----------
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

async function handleInteraction(i) {
  const id = i.customId || "";
  if (!/^(rec|recctl|recset|recplay):/.test(id)) return false;
  const [kind, a, b] = id.split(":");
  try {
    if (kind === "recctl") await controlInteraction(i, a);
    else if (kind === "recset") await settingsInteraction(i, a);
    else if (kind === "recplay") await playInteraction(i, a, Number(b));
    else await recordingInteraction(i, a, b);
  } catch (err) {
    if (!(err instanceof UserError)) console.error("[Rec] Interaction failed:", err);
    const reply = ephemeral(err instanceof UserError ? `⚠️ ${err.message}` : "❌ That didn't work (details are in the bot's logs).");
    if (i.deferred || i.replied) await i.followUp(reply).catch(() => { });
    else await i.reply(reply).catch(() => { });
  }
  return true;
}

async function recordingInteraction(i, action, recId) {
  if (action === "stop") {
    const s = liveSession(recId);
    requireInChannel(i.member, s.channelId);
    await i.deferUpdate();
    await s.stop("stopped", i.user.id);
  } else if (action === "note") {
    const s = liveSession(recId);
    requireInChannel(i.member, s.channelId);
    await i.showModal(panel.noteModal(recId));
  } else if (action === "notemodal") {
    const s = liveSession(recId);
    await s.note(i.user.id, i.fields.getTextInputValue("note"));
    await i.reply(ephemeral("📝 Note added."));
  } else if (action === "clip") {
    const s = liveSession(recId);
    requireInChannel(i.member, s.channelId);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await s.clip(i.user.id, cfg.clipSeconds);
    await i.editReply(s.thread ? `✂️ Clip posted in <#${s.thread.id}>.` : "✂️ Clip made.");
  } else if (action === "tx" || action === "sum") {
    const s = liveSession(recId);
    requireInChannel(i.member, s.channelId);
    const key = action === "tx" ? "transcribe" : "summarize";
    s.setOption(key, !s.rec.options?.[key], i.user.id);
    await i.update(panel.livePanel(s.view()));
  } else if (["runtx", "runsum", "retry"].includes(action)) {
    const rec = await store.getRecording(recId);
    if (!rec || ["deleted", "discarded"].includes(rec.status)) throw new UserError("That recording is gone.");
    requireParticipant(i.member, rec);
    if (["recording", "suspended"].includes(rec.status)) throw new UserError("It's still recording; the toggles on its panel do that.");
    rec.options = rec.options || {};
    if (action !== "retry") {
      rec.options.transcribe = true;
      if (action === "runsum") rec.options.summarize = true;
    }
    if (rec.status !== "paused" || action === "retry") rec.status = "processing";
    await store.saveRecording(rec);
    await i.update(panel.endedPanel(rec));
    if (rec.status === "processing") processor.enqueue(rec.id);
  } else if (action === "del") {
    requireAdmin(i.member);
    await i.reply(panel.deleteConfirm(recId));
  } else if (action === "delyes") {
    requireAdmin(i.member);
    const rec = await store.getRecording(recId);
    if (!rec || rec.status === "deleted") throw new UserError("It's already gone.");
    if (["recording", "suspended"].includes(rec.status) || processor.isBusy(rec.id)) throw new UserError("It's still being recorded or processed; try again when it's done.");
    await i.deferUpdate();
    await processor.deleteRecording(rec, i.user.id);
    await i.editReply(panel.notice(`🗑️ Recording \`${recId}\` deleted.`));
  }
}

async function controlInteraction(i, action) {
  if (action === "start") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await startRecording(i.member?.voice?.channel, i.user.id);
    await i.editReply("🔴 Recording started.");
  } else if (action === "auto") {
    requireAdmin(i.member);
    settings.autoRecord = !settings.autoRecord;
    await saveSettings();
    await i.update(controlPayload());
    evaluateAuto();
  } else if (action === "tx" || action === "sum") {
    // Defaults for new recordings (a summary is written from the transcript, so they go together)
    requireAdmin(i.member);
    if (action === "tx") {
      settings.transcribe = !settings.transcribe;
      if (!settings.transcribe) settings.summarize = false;
    } else {
      settings.summarize = !settings.summarize;
      if (settings.summarize) settings.transcribe = true;
    }
    await saveSettings();
    await i.update(controlPayload());
  } else if (action === "settings") {
    requireAdmin(i.member);
    await i.reply(panel.settingsPanel(settings));
  }
}

async function settingsInteraction(i, action) {
  requireAdmin(i.member);
  if (action === "channels") settings.autoChannels = [...i.values];
  else if (action === "min") settings.minPeople = Number(i.values[0]) || cfg.autoMinPeople;
  else if (action === "keep") settings.retentionDays = Number(i.values[0]) || 0;
  await saveSettings();
  await i.update(panel.settingsPanel(settings, { ephemeral: false }));
  refreshControlPanel();
  evaluateAuto();
}

// ▶ on a search result: a 30 s clip around that moment, from the recording's mix on Drive
async function playInteraction(i, recId, startMs) {
  const rec = await store.getRecording(recId);
  const mixId = rec?.outputs?.files?.mix?.id;
  if (!mixId || rec.outputs.audioDeleted || rec.status === "deleted" || !drive.enabled) throw new UserError("That recording's audio isn't available anymore.");
  await i.deferReply();
  const file = path.join(WORK_DIR, "clips", `${recId}_${startMs}_${Date.now()}.ogg`);
  try {
    await clip.fromDrive(mixId, startMs - 5000, cfg.clipSeconds, file);
    await i.editReply({ content: `▶️ \`${panel.hms(startMs)}\` in recording \`${recId}\` (<t:${Math.floor(Date.parse(rec.started_at) / 1000)}:d>)`, files: [{ attachment: file, name: "moment.ogg" }], allowedMentions: { parse: [] } });
  } finally {
    fs.unlink(file, () => { });
  }
}

// ---------- Startup, background jobs, shutdown ----------
// Recordings a restart cut off are resumed when people are still there (else finished and processed);
// processing that was interrupted carries on
async function resumeAll() {
  for (const rec of await store.findRecordings(["recording", "suspended", "processing", "paused"])) {
    try {
      if (rec.status === "recording" || rec.status === "suspended") {
        // A "recording" row with a fresh heartbeat may still belong to another copy of the bot that's shutting down
        if (rec.status === "recording") {
          const age = Date.now() - Date.parse(rec.heartbeat_at || rec.started_at);
          if (age < 60000) await sleep(60000 - age);
        }
        const cutAt = Date.parse(rec.suspended_at || rec.heartbeat_at || rec.started_at);
        const channel = client.channels.cache.get(rec.channel_id);
        if (!active && Date.now() - cutAt < cfg.resumeWindowMinutes * 60000 && audio.countHumans(channel) > 0) {
          try {
            await startSession(rec, { fresh: false });
            console.log(`[Rec] Resumed recording ${rec.id} in #${channel.name} (part ${rec.parts}).`);
            continue;
          } catch (err) {
            console.warn(`[Rec] Couldn't resume ${rec.id}:`, err.message);
          }
        }
        rec.status = "processing";
        rec.ended_at = new Date(Math.max(cutAt, Date.parse(rec.started_at))).toISOString();
        rec.end_reason = "restart";
        rec.outputs = rec.outputs || {};
        rec.outputs.progress = { audio: { state: "pending" } };
        await store.saveRecording(rec);
        await processor.updatePanel(rec);
        processor.enqueue(rec.id);
      } else if (rec.status === "processing" || Date.parse(rec.resume_after || 0) <= Date.now()) {
        processor.enqueue(rec.id);
      }
    } catch (err) {
      console.error(`[Rec] Resuming ${rec.id} failed:`, err);
    }
  }
}

async function housekeeping() {
  if (shuttingDown) return;
  try {
    for (const rec of await store.findRecordings(["paused"])) {
      if (Date.parse(rec.resume_after || 0) <= Date.now()) processor.enqueue(rec.id);
    }
    if (settings.retentionDays > 0 && Date.now() - lastRetention > 3600e3) {
      lastRetention = Date.now();
      await processor.applyRetention(settings.retentionDays);
    }
    // Keep at least cfg.minFreeGB free on Drive by deleting the oldest recordings' audio (checks the quota too)
    if (drive.enabled) {
      const q = await processor.freeUpSpace(cfg.minFreeGB * 1024 ** 3);
      const changed = !quotaCache || Math.abs(q.usage - quotaCache.usage) > 1024 ** 2;
      quotaCache = { at: Date.now(), ...q };
      if (changed) refreshControlPanel();
    }
  } catch (err) {
    console.warn("[Rec] Housekeeping failed:", err.message);
  }
}

async function init(c) {
  if (initialized) return;
  initialized = true;
  client = c;
  processor.init(c);
  settings = await store.getSetting("recording", DEFAULT_SETTINGS);
  audio.onVoiceReady((conn) => active?.attach(conn));
  if (!process.env.RECORDINGS_KEY && !process.env.DASHBOARD_KEY) {
    console.warn("[Rec] /recordings is open to anyone who finds it - set RECORDINGS_KEY to require /recordings?key=...");
  }
  resuming = true;
  try {
    await resumeAll();
  } finally {
    resuming = false;
  }
  await refreshControlPanel();
  setInterval(housekeeping, 10 * 60000);
  housekeeping();
  evaluateAuto();
}

// Called on SIGTERM/SIGINT and !restartbot: a live recording is saved and resumes after the restart
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(autoTimer);
  processor.shutdown();
  if (active) await Promise.race([active.suspend(), sleep(25000)]);
}

module.exports = { init, onVoiceStateUpdate, handleCommand, handleInteraction, shutdown, isRecording: () => !!active?.active };
