// recording/panel.js - the messages the recorder posts in #record, laid out like Craig's
// (Discord "Components V2": a container with text, separators and buttons).
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, SectionBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, StringSelectMenuBuilder, ChannelType,
} = require("discord.js");
const { Recording: cfg } = require("../config");
const { participants } = require("./util");

const RED = 0xed4245;
const GREY = 0x4f545c;
const GREEN = 0x3ba55c;
const BLURPLE = 0x5865f2;
const ACTIVITY_LINES = 12;

// ---------- Formatting ----------
function hms(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}
function human(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return ms < 60000 ? `${Math.round(ms / 1000)}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
function size(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}
const unix = (ms) => Math.floor(ms / 1000);
const oneLine = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
const onOff = (v) => (v ? "On" : "Off");

// ---------- Building blocks ----------
const text = (content) => new TextDisplayBuilder().setContent(content);
const sep = (large = false) => new SeparatorBuilder().setDivider(true).setSpacing(large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);
function button(id, label, style, emoji, disabled = false) {
  const b = new ButtonBuilder().setCustomId(id).setStyle(style);
  if (label) b.setLabel(label);
  if (emoji) b.setEmoji(emoji);
  if (disabled) b.setDisabled(true);
  return b;
}
const link = (url, label, emoji) => new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(label).setEmoji(emoji);
const row = (...items) => new ActionRowBuilder().addComponents(items.filter(Boolean));
const v2 = (container, extraFlags = 0) => ({ components: [container], flags: MessageFlags.IsComponentsV2 | extraFlags, allowedMentions: { parse: [] } });

// ---------- Activity log ----------
function eventLine(e) {
  const t = "`" + hms(e.t) + "`";
  const who = e.user ? `<@${e.user}>` : "";
  switch (e.type) {
    case "start": return `${t}: ${e.user ? `${who} started the recording.` : "Auto-recording started."}`;
    case "join": return `${t}: ${who} joined the recording.`;
    case "leave": return `${t}: ${who} left.`;
    case "note": return `${t}: 📝 ${who}: ${oneLine(e.text, 180)}`;
    case "clip": return `${t}: ✂️ ${who} clipped ${e.text}.`;
    case "sound": return e.kind === "tts" ? `${t}: 🗣️ ${who} (TTS): ${oneLine(e.text, 150)}` : `${t}: 🔊 ${who} played ${oneLine(e.text, 80)}`;
    case "reconnect": return `${t}: 🔁 Automatically reconnected.`;
    case "restart": return `${t}: ⚠️ The bot restarted (${e.text} gap).`;
    case "toggle": return `${t}: ⚙️ ${who} turned ${e.text}.`;
    case "stop": return `${t}: ⏹️ Recording stopped${e.user ? ` by ${who}` : ""}.`;
    default: return `${t}: ${oneLine(e.text || e.type, 180)}`;
  }
}
const activity = (events) => "### Activity\n" + ((events || []).slice(-ACTIVITY_LINES).map(eventLine).join("\n") || "-# Nothing yet.");

const header = (startedBy) => `-# ${startedBy ? `<@${startedBy}>'s recording` : "Auto-recording"}`;

// ---------- Live panel ----------
// view: { id, startedBy, channelId, startedAtMs, elapsedMs, bytes, speakers, region, pingMs, dave, options, events, state }
function livePanel(view) {
  const reconnecting = view.state === "reconnecting";
  const suspended = view.state === "suspended";
  const title = suspended ? "## ⚠️ Restarting…" : reconnecting ? "## 🔁 Reconnecting…" : "## 🔴 Recording…";
  const note = suspended
    ? "The bot is restarting. The recording picks up again by itself in a moment (the gap is noted below)."
    : "";
  const details = [
    `**Recording ID:** \`${view.id}\``,
    `**Channel:** <#${view.channelId}>`,
    `**Started:** <t:${unix(view.startedAtMs)}:T> (<t:${unix(view.startedAtMs)}:R>)`,
    `**Duration:** ${hms(view.elapsedMs)} · **Size:** ${size(view.bytes)} · **Speakers:** ${view.speakers}`,
    `**Voice Region:** ${view.region || "?"} · **Voice Server Latency:** ${Number.isFinite(view.pingMs) ? `${Math.round(view.pingMs)}ms` : "?"}`,
    `**Transcript:** ${onOff(view.options.transcribe)} · **Summary:** ${onOff(view.options.summarize)}`,
  ].join("\n");

  const c = new ContainerBuilder().setAccentColor(suspended || reconnecting ? GREY : RED);
  c.addTextDisplayComponents(text(`${header(view.startedBy)}\n${title}` + (note ? `\n${note}` : "")));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(details));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(activity(view.events)));
  const locked = suspended;
  c.addActionRowComponents(
    row(
      button(`rec:stop:${view.id}`, "Stop recording", ButtonStyle.Danger, "⏹️", locked),
      button(`rec:note:${view.id}`, "Add a note", ButtonStyle.Primary, "📝", locked),
      button(`rec:clip:${view.id}`, "Clip", ButtonStyle.Secondary, "✂️", locked),
      view.dave ? button(`rec:e2ee:${view.id}`, null, ButtonStyle.Success, "🔒", true) : null
    )
  );
  c.addActionRowComponents(
    row(
      button(`rec:tx:${view.id}`, `Transcript: ${onOff(view.options.transcribe)}`, view.options.transcribe ? ButtonStyle.Success : ButtonStyle.Secondary, "📄", locked),
      button(`rec:sum:${view.id}`, `Summary: ${onOff(view.options.summarize)}`, view.options.summarize ? ButtonStyle.Success : ButtonStyle.Secondary, "✨", locked)
    )
  );
  return v2(c);
}

// ---------- Ended / processing panel ----------
const END_REASONS = {
  stopped: (by) => `⏹️ Stopped${by ? ` by <@${by}>` : ""}.`,
  empty: () => "👋 Everyone left the channel.",
  max: () => `⏱️ Reached the ${cfg.maxHours}-hour limit.`,
  kicked: () => "👢 The bot was disconnected from the voice channel.",
  moved: () => "↪️ The bot was moved to another channel.",
  error: () => "❌ Stopped after the voice connection failed.",
  restart: () => "⚠️ The bot restarted and the channel was empty by then.",
};

const STEP_ICON = { done: "✅", running: "⏳", paused: "⏸️", failed: "❌", off: "➖", pending: "🕒" };
function stepLine(label, step) {
  if (!step) return `🕒 ${label}`;
  return `${STEP_ICON[step.state] || "🕒"} ${label}${step.detail ? `: ${step.detail}` : ""}`;
}

// rec: the recordings row (outputs.progress holds each step's { state, detail })
function endedPanel(rec) {
  const started = Date.parse(rec.started_at);
  const ended = rec.ended_at ? Date.parse(rec.ended_at) : Date.now();
  const stopEvent = [...(rec.events || [])].reverse().find((e) => e.type === "stop");
  const reason = (END_REASONS[rec.end_reason] || (() => ""))(stopEvent?.user);
  const out = rec.outputs || {};
  const prog = out.progress || {};
  const files = out.files || {};
  const deleted = rec.status === "deleted";
  const speakers = Object.values(participants(rec));

  const details = [
    `**Recording ID:** \`${rec.id}\``,
    `**Channel:** <#${rec.channel_id}>`,
    `**Started:** <t:${unix(started)}:f> · **Ended:** <t:${unix(ended)}:t>`,
    `**Duration:** ${hms(ended - started)} · **Speakers:** ${speakers.length}` + (rec.parts > 1 ? ` · **Parts:** ${rec.parts} (bot restarts)` : ""),
  ].join("\n");

  const steps = deleted
    ? `🗑️ Deleted${out.deletedBy ? ` by <@${out.deletedBy}>` : ""}.`
    : [
        stepLine("Audio", prog.audio),
        rec.options?.transcribe ? stepLine("Transcript", prog.transcript) : "➖ Transcript: off",
        rec.options?.summarize ? stepLine("Summary", prog.summary) : "➖ Summary: off",
        out.audioDeleted ? `🧹 Audio removed ${typeof out.audioDeleted === "number" ? `after ${out.audioDeleted} days` : out.audioDeleted} (text kept).` : "",
        rec.status === "failed" && rec.error ? `-# Error: ${oneLine(rec.error, 300)}` : "",
      ].filter(Boolean).join("\n");

  const c = new ContainerBuilder().setAccentColor(deleted ? GREY : rec.status === "failed" ? RED : rec.status === "done" ? GREEN : BLURPLE);
  c.addTextDisplayComponents(text(`${header(rec.started_by)}\n## Recording ended.` + (reason ? `\n${reason}` : "")));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(details));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text("### Processing\n" + steps));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(activity(rec.events)));

  if (!deleted) {
    const links = row(
      files.mix?.url && !out.audioDeleted ? link(files.mix.url, "Listen", "🎧") : null,
      rec.drive_folder_id && files.mix ? link(`https://drive.google.com/drive/folders/${rec.drive_folder_id}`, "Files", "📁") : null,
      files.transcript?.url ? link(files.transcript.url, "Transcript", "📄") : null
    );
    if (links.components.length) c.addActionRowComponents(links);
    const busy = ["recording", "suspended"].includes(rec.status);
    c.addActionRowComponents(
      row(
        rec.status === "failed" ? button(`rec:retry:${rec.id}`, "Retry", ButtonStyle.Primary, "🔁") : null,
        !rec.options?.transcribe ? button(`rec:runtx:${rec.id}`, "Transcribe", ButtonStyle.Primary, "📄", busy) : null,
        !rec.options?.summarize ? button(`rec:runsum:${rec.id}`, "Summarize", ButtonStyle.Primary, "✨", busy) : null,
        button(`rec:del:${rec.id}`, "Delete", ButtonStyle.Danger, "🗑️", busy)
      )
    );
  }
  return v2(c);
}

function deleteConfirm(id) {
  const c = new ContainerBuilder().setAccentColor(RED);
  c.addTextDisplayComponents(text(`### Delete recording \`${id}\`?\nIts Drive folder goes to the trash (recoverable there for 30 days), and its transcript leaves search.`));
  c.addActionRowComponents(row(button(`rec:delyes:${id}`, "Delete it", ButtonStyle.Danger, "🗑️")));
  return v2(c, MessageFlags.Ephemeral);
}

// ---------- Note modal ----------
function noteModal(id) {
  return new ModalBuilder()
    .setCustomId(`rec:notemodal:${id}`)
    .setTitle("Add a note")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Note")
        .setDescription("Saved at this moment of the recording (shows in the transcript and summary).")
        .setTextInputComponent(new TextInputBuilder().setCustomId("note").setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true))
    );
}

// ---------- Control panel (one persistent message) ----------
// info: { settings, active: { channelId } | null, quota: { usage, limit } | null, driveEnabled, dbEnabled, geminiKey }
function controlPanel({ settings, active, quota, driveEnabled, dbEnabled, geminiKey }) {
  const channels = settings.autoChannels?.length
    ? settings.autoChannels.map((id) => `<#${id}>`).join(", ")
    : "any voice channel (except the secret one and AFK)";
  const lines = [
    "## 🎙️ Recorder",
    `**Auto-record:** ${settings.autoRecord ? "**On**" : "Off"} — starts when **${settings.minPeople}+** people are in ${channels}; every recording stops ${cfg.emptyStopSeconds ? `${cfg.emptyStopSeconds} s after the channel empties` : "as soon as the last person leaves"}.`,
    `**After each recording:** transcript **${onOff(settings.transcribe)}** · summary **${onOff(settings.summarize)}** (English + Egyptian Arabic) · audio kept **${settings.retentionDays ? `${settings.retentionDays} days` : "forever"}** (text always kept)` + (cfg.minFreeGB ? `; when Drive has under ${cfg.minFreeGB} GB free, the oldest recordings' audio is deleted` : ""),
    "-# These are the defaults for new recordings; each recording's own panel can still switch its transcript/summary on or off.",
  ];
  if (quota?.limit) {
    const pct = Math.round((quota.usage / quota.limit) * 100);
    lines.push(`**Google Drive:** ${size(quota.usage)} of ${size(quota.limit)} used (${pct}%)` + (pct >= 90 ? " ⚠️ almost full" : ""));
  } else if (!driveEnabled) lines.push("⚠️ **Google Drive isn't connected** - recordings can't be kept (see scripts/drive-auth.js).");
  if (!geminiKey && (settings.transcribe || settings.summarize)) lines.push("⚠️ **RECORDING_GEMINI_API_KEY isn't set** - transcripts and summaries can't be made.");
  if (!dbEnabled) lines.push("⚠️ **No database** - recordings can't resume after a restart and these settings reset.");
  lines.push(active ? `**Now:** 🔴 recording in <#${active.channelId}>` : "**Now:** not recording");
  lines.push("-# Commands (this channel only): `!record` `!stoprecord` `!note <text>` `!clip [secs]` `!recordings` `!reclogs` `!autorecord on|off` `!search <words>` `!ask <question>`");

  const c = new ContainerBuilder().setAccentColor(active ? RED : BLURPLE);
  c.addTextDisplayComponents(text(lines.join("\n")));
  c.addActionRowComponents(
    row(
      button("recctl:start", "Start recording", ButtonStyle.Danger, "🔴", !!active),
      button("recctl:auto", `Auto-record: ${onOff(settings.autoRecord)}`, settings.autoRecord ? ButtonStyle.Success : ButtonStyle.Secondary, "🤖"),
      button("recctl:settings", "Settings", ButtonStyle.Secondary, "⚙️")
    )
  );
  c.addActionRowComponents(
    row(
      button("recctl:tx", `Transcripts: ${onOff(settings.transcribe)}`, settings.transcribe ? ButtonStyle.Success : ButtonStyle.Secondary, "📄"),
      button("recctl:sum", `Summaries: ${onOff(settings.summarize)}`, settings.summarize ? ButtonStyle.Success : ButtonStyle.Secondary, "✨")
    )
  );
  return v2(c);
}

const RETENTION_CHOICES = [0, 7, 14, 30, 60, 90, 180, 365];

function settingsPanel(settings, { ephemeral = true } = {}) {
  const c = new ContainerBuilder().setAccentColor(BLURPLE);
  c.addTextDisplayComponents(text("### ⚙️ Recorder settings\nChanges apply right away (admins only)."));
  c.addTextDisplayComponents(text("**Auto-record channels** (none picked = every voice channel except the secret one and AFK)"));
  c.addActionRowComponents(
    row(
      new ChannelSelectMenuBuilder()
        .setCustomId("recset:channels")
        .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setPlaceholder("Any voice channel (except secret & AFK)")
        .setMinValues(0)
        .setMaxValues(10)
        .setDefaultChannels(...(settings.autoChannels || []))
    )
  );
  c.addActionRowComponents(
    row(
      new StringSelectMenuBuilder()
        .setCustomId("recset:min")
        .setPlaceholder("People needed to auto-record")
        .addOptions([1, 2, 3, 4, 5, 6].map((n) => ({ label: `Auto-record with ${n}+ ${n === 1 ? "person" : "people"}`, value: String(n), default: n === settings.minPeople })))
    )
  );
  c.addActionRowComponents(
    row(
      new StringSelectMenuBuilder()
        .setCustomId("recset:keep")
        .setPlaceholder("How long to keep audio")
        .addOptions(RETENTION_CHOICES.map((d) => ({ label: d ? `Keep audio ${d} days (text kept forever)` : "Keep audio forever", value: String(d), default: d === (settings.retentionDays || 0) })))
    )
  );
  return v2(c, ephemeral ? MessageFlags.Ephemeral : 0);
}

// ---------- Report card ----------
const bar = (share) => {
  const n = Math.round(share * 10);
  return "`" + "▓".repeat(n) + "░".repeat(10 - n) + "`";
};

// report: { durationMs, talkMs, speakers: [{ user, name, talkMs, share, words }], longest, interrupter, notes, clips }
function reportCard(rec) {
  const r = rec.report;
  if (!r) return null;
  const lines = [`## 📊 Session report card`, `**Duration:** ${human(r.durationMs)} · **Someone talking:** ${human(r.talkMs)} · **Speakers:** ${r.speakers.length}`, "### Talk time"];
  for (const s of r.speakers.slice(0, 15)) {
    lines.push(`${bar(s.share)} <@${s.user}> **${human(s.talkMs)}** (${Math.round(s.share * 100)}%)` + (s.words ? ` · ${s.words.toLocaleString("en-US")} words` : ""));
  }
  if (r.longest) lines.push(`**🎤 Longest monologue:** <@${r.longest.user}> - ${human(r.longest.ms)} at \`${hms(r.longest.at)}\``);
  if (r.interrupter) lines.push(`**🗣️ Jumped in the most:** <@${r.interrupter.user}> (${r.interrupter.count} times)`);
  lines.push(`**📝 Notes:** ${r.notes} · **✂️ Clips:** ${r.clips}`);
  const c = new ContainerBuilder().setAccentColor(BLURPLE);
  c.addTextDisplayComponents(text(lines.join("\n").slice(0, 3900)));
  return v2(c);
}

// ---------- Summaries ----------
function splitText(s, max) {
  const out = [];
  let cur = "";
  for (const line of String(s).split("\n")) {
    if ((cur + "\n" + line).length > max && cur) {
      out.push(cur);
      cur = line;
    } else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) out.push(cur);
  return out.flatMap((p) => (p.length > max ? p.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")) : [p]));
}

function summaryMessages(rec) {
  const msgs = [];
  for (const [title, body] of [["## ✨ Summary (English)", rec.summary_en], ["## ✨ الملخص (بالمصري)", rec.summary_ar]]) {
    if (!body) continue;
    splitText(body, 3800).forEach((part, i) => {
      const c = new ContainerBuilder().setAccentColor(BLURPLE);
      c.addTextDisplayComponents(text((i === 0 ? title + "\n" : "") + part));
      msgs.push(v2(c));
    });
  }
  return msgs;
}

// ---------- Search results / lists ----------
const dateOf = (iso) => `<t:${unix(Date.parse(iso))}:d>`;

// results: [{ recording_id, start_ms, name, text, started_at }]
function searchResults(query, results) {
  const c = new ContainerBuilder().setAccentColor(BLURPLE);
  c.addTextDisplayComponents(text(`### 🔍 "${oneLine(query, 80)}"` + (results.length ? "" : "\nNothing found.")));
  for (const r of results) {
    c.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(text(`${dateOf(r.started_at)} · \`${hms(r.start_ms)}\` · **${oneLine(r.name, 40)}:** "${oneLine(r.text, 300)}"`))
        .setButtonAccessory(button(`recplay:${r.recording_id}:${r.start_ms}`, "Play", ButtonStyle.Secondary, "▶️"))
    );
  }
  return v2(c);
}

function recordingsList(rows) {
  const c = new ContainerBuilder().setAccentColor(BLURPLE);
  const lines = rows.map((r) => {
    const start = Date.parse(r.started_at);
    const end = r.ended_at ? Date.parse(r.ended_at) : Date.now();
    const folder = r.drive_folder_id ? ` · [Files](https://drive.google.com/drive/folders/${r.drive_folder_id})` : "";
    const state = r.status === "recording" ? " · 🔴 live" : r.status === "done" ? "" : ` · ${r.status}`;
    return `\`${r.id}\` · <t:${unix(start)}:f> · <#${r.channel_id}> · ${human(end - start)} · ${Object.keys(participants(r)).length} speakers${state}${folder}`;
  });
  c.addTextDisplayComponents(text("### 🎙️ Recent recordings\n" + (lines.join("\n") || "None yet.")));
  return v2(c);
}

function notice(content, { ephemeral = false, color = BLURPLE } = {}) {
  const c = new ContainerBuilder().setAccentColor(color);
  c.addTextDisplayComponents(text(content));
  return v2(c, ephemeral ? MessageFlags.Ephemeral : 0);
}

module.exports = {
  hms,
  human,
  size,
  livePanel,
  endedPanel,
  deleteConfirm,
  noteModal,
  controlPanel,
  settingsPanel,
  reportCard,
  summaryMessages,
  searchResults,
  recordingsList,
  notice,
  splitText,
};
