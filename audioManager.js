const {
  joinVoiceChannel,
  createAudioPlayer,
  VoiceConnectionStatus,
  entersState
} = require("@discordjs/voice");
const axios = require('axios');
const fs = require('fs');
const { IDs } = require('./config');

const state = {
  voiceCurrent: IDs.voice3,
  connection: null,
  player: null,
  connectionSubscription: null,
  // Set while a recording runs: the bot has one voice connection per server, so nothing may move it elsewhere
  pinnedChannelId: null
};

// Called with the connection each time it becomes ready (the recorder attaches to it)
const voiceReadyHooks = new Set();
function onVoiceReady(fn) {
  voiceReadyHooks.add(fn);
}

// In-memory mic speaking trackers
const activeSpeakers = new Map(); // userId -> start timestamp (ms)
const sessionSpeakingTally = new Map(); // userId -> accumulated speaking duration (ms)

function settleSpeaker(userId) {
  const started = activeSpeakers.get(userId);
  if (!started) return;
  const elapsedMs = Math.max(0, Date.now() - started);
  activeSpeakers.delete(userId);
  const currentTotal = sessionSpeakingTally.get(userId) || 0;
  sessionSpeakingTally.set(userId, currentTotal + elapsedMs);
}

function attachSpeakingTracker(conn) {
  if (!conn || !conn.receiver || !conn.receiver.speaking) return;
  const speaking = conn.receiver.speaking;

  // Swap out only our own listeners: the recorder listens on the same emitter
  if (conn.__speakingHandlers) {
    speaking.off('start', conn.__speakingHandlers.start);
    speaking.off('end', conn.__speakingHandlers.end);
  }

  // Triggered when member opens mic (green circle appears)
  const onStart = (userId) => {
    if (!activeSpeakers.has(userId)) activeSpeakers.set(userId, Date.now());
  };
  conn.__speakingHandlers = { start: onStart, end: settleSpeaker };
  speaking.on('start', onStart);

  // Triggered when member stops speaking
  speaking.on('end', settleSpeaker);

  // No 'end' event arrives once the connection drops, so close out whoever was mid-sentence
  if (!conn.__speakingSettleHooked) {
    conn.__speakingSettleHooked = true;
    conn.on('stateChange', (oldState, newState) => {
      if (newState.status !== VoiceConnectionStatus.Ready) {
        for (const userId of [...activeSpeakers.keys()]) settleSpeaker(userId);
      }
    });
  }
}

// Carries talk time saved before a restart over to the still-open session
function seedSpeakingSeconds(userId, seconds) {
  if (!(seconds > 0)) return;
  sessionSpeakingTally.set(userId, (sessionSpeakingTally.get(userId) || 0) + seconds * 1000);
}

function trackedSpeakerIds() {
  const ids = new Set([...sessionSpeakingTally.keys(), ...activeSpeakers.keys()]);
  for (const t of Object.values(flagTimers)) for (const id of [...t.active.keys(), ...t.tally.keys()]) ids.add(id);
  return [...ids];
}

// In-memory timers for on/off voice states, fed by voiceStateUpdate in events.js:
//   streaming = sharing their screen ("Go Live")
//   muted     = mic muted but still listening (deafening also mutes, so that time goes to "deafened" only)
//   deafened  = deafened
const FLAG_KINDS = ["streaming", "muted", "deafened"];
const flagTimers = Object.fromEntries(FLAG_KINDS.map((k) => [k, { active: new Map(), tally: new Map() }])); // userId -> start ms / accumulated ms

// flags: { streaming, muted, deafened } booleans describing the member right now
function setVoiceFlags(userId, flags) {
  for (const kind of FLAG_KINDS) {
    const t = flagTimers[kind];
    if (flags[kind]) {
      if (!t.active.has(userId)) t.active.set(userId, Date.now());
      continue;
    }
    const started = t.active.get(userId);
    if (!started) continue;
    t.active.delete(userId);
    t.tally.set(userId, (t.tally.get(userId) || 0) + Math.max(0, Date.now() - started));
  }
}

// -> { streaming, muted, deafened } seconds so far in the member's current session
function getLiveFlagSeconds(userId) {
  const out = {};
  for (const kind of FLAG_KINDS) {
    const t = flagTimers[kind];
    let totalMs = t.tally.get(userId) || 0;
    const started = t.active.get(userId);
    if (started) totalMs += Math.max(0, Date.now() - started);
    out[kind] = Math.round(totalMs / 1000);
  }
  return out;
}

function flushFlagSeconds(userId) {
  const out = getLiveFlagSeconds(userId);
  for (const kind of FLAG_KINDS) {
    flagTimers[kind].active.delete(userId);
    flagTimers[kind].tally.delete(userId);
  }
  return out;
}

// Carries time saved before a restart over to the still-open session
function seedFlagSeconds(userId, saved) {
  for (const kind of FLAG_KINDS) {
    const secs = Number(saved && saved[kind]) || 0;
    if (secs > 0) flagTimers[kind].tally.set(userId, (flagTimers[kind].tally.get(userId) || 0) + secs * 1000);
  }
}

function flushSpeakingSeconds(userId) {
  let totalMs = sessionSpeakingTally.get(userId) || 0;
  const started = activeSpeakers.get(userId);
  if (started) {
    totalMs += Math.max(0, Date.now() - started);
    activeSpeakers.delete(userId);
  }
  sessionSpeakingTally.delete(userId);
  return Math.round(totalMs / 1000);
}

function getLiveSpeakingSeconds(userId) {
  let totalMs = sessionSpeakingTally.get(userId) || 0;
  const started = activeSpeakers.get(userId);
  if (started) {
    totalMs += Math.max(0, Date.now() - started);
  }
  return Math.round(totalMs / 1000);
}

// Each suffix is one ElevenLabs account: '' = ELEVENLABS_*, '2' = ELEVENLABS_*2 (fallback).
// Fallback values that are unset reuse the primary's, except the API key.
const ELEVENLABS_ACCOUNT_SUFFIXES = ['', '2'];

function getElevenLabsAccount(suffix) {
  const env = (name) => process.env[`${name}${suffix}`] || process.env[name];
  return {
    label: suffix ? `account ${suffix}` : 'primary account',
    apiKey: process.env[`ELEVENLABS_API_KEY${suffix}`],
    voiceId: env('ELEVENLABS_VOICE_ID'),
    voiceIdArabic: env('ELEVENLABS_VOICE_ID_ARABIC'),
    modelId: env('ELEVENLABS_MODEL_ID'),
    modelTestId: env('ELEVENLABS_MODEL_TEST_ID'),
  };
}

function formatElevenLabsError(error) {
  const data = error.response?.data;
  if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
    return Buffer.from(data).toString('utf8');
  }
  return data || error.message;
}

async function textToSpeech(text) {
  const isArabic = /^[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0660-\u0669\u066A-\u066F\u06D4\u060C\u061B\u061F\s]+$/.test(text);
  const useMainModel = !text.includes("[") && !text.includes("]");
  const accounts = ELEVENLABS_ACCOUNT_SUFFIXES.map(getElevenLabsAccount).filter(account => account.apiKey);

  let lastError;
  for (const account of accounts) {
    const voiceId = isArabic ? account.voiceIdArabic : account.voiceId;
    const model = useMainModel ? account.modelId : account.modelTestId;

    try {
      const response = await axios({
        method: 'post',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': account.apiKey,
          'Content-Type': 'application/json',
        },
        data: { text: text, model_id: model },
        responseType: 'arraybuffer'
      });

      const outputPath = `output_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp3`;
      fs.writeFileSync(outputPath, response.data);
      console.log(`Audio saved to ${outputPath} (ElevenLabs ${account.label})`);
      return outputPath;
    } catch (error) {
      console.error(`ElevenLabs ${account.label} failed (${error.response?.status ?? 'no status'}):`, formatElevenLabsError(error));
      lastError = error;
    }
  }

  throw lastError || new Error('No ElevenLabs API key configured');
}

// Real people only: other bots (e.g. Craig/مخبر) don't count as company
function countHumans(channel) {
  return channel ? channel.members.filter((m) => !m.user.bot).size : 0;
}

function shouldJoinVoiceChannel(client, channelId) {
  return countHumans(client.channels.cache.get(channelId)) > 0;
}

const joinBanhaVoiceChannel = async (client, channelToJoin) => {
  if (state.pinnedChannelId && channelToJoin !== state.pinnedChannelId) {
    console.log(`Not moving to voice channel ${channelToJoin}: recording in ${state.pinnedChannelId}.`);
    return state.connection;
  }
  if (!shouldJoinVoiceChannel(client, channelToJoin)) {
    console.log(`Not joining voice channel ${channelToJoin} as it's empty or only contains bots.`);
    return null;
  }

  state.voiceCurrent = channelToJoin;
  state.connection = joinVoiceChannel({
    channelId: channelToJoin,
    guildId: IDs.guild,
    adapterCreator: client.guilds.cache.get(IDs.guild).voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  // joinVoiceChannel hands back the same connection while one exists, so hook it only once
  if (!state.connection.__banhaHooked) {
    state.connection.__banhaHooked = true;
    state.connection.on('stateChange', (oldState, newState) => {
      console.log(`Connection transitioned from ${oldState.status} to ${newState.status}`);
    });

    state.connection.on('error', (error) => {
      console.error('Connection Error:', error);
    });

    state.connection.on('debug', (message) => {
      console.log(`[Voice Debug] ${message}`);
    });
  }

  try {
    await entersState(state.connection, VoiceConnectionStatus.Ready, 20000);
    console.log(`Bot joined voice channel: ${channelToJoin}`);
    // Start tracking speaking timestamps
    attachSpeakingTracker(state.connection);
  } catch (err) {
    console.error("Voice connection failed to become ready:", err);
    try { state.connection.destroy(); } catch { }
    state.connection = null;
    return null;
  }

  if (!state.player) {
    state.player = createAudioPlayer();
    state.player.on('error', (e) => console.error('AudioPlayer error:', e));
    state.player.on('stateChange', (oldState, newState) => {
      try { console.log(`AudioPlayer state: ${oldState.status} -> ${newState.status}`); } catch { }
    });
  }

  try {
    state.connectionSubscription = state.connection.subscribe(state.player);
  } catch (e) {
    console.error('Failed to subscribe player to connection:', e);
  }

  for (const hook of voiceReadyHooks) {
    try { hook(state.connection); } catch (e) { console.error('Voice ready hook failed:', e); }
  }

  return state.connection;
};

async function ensureVoiceReady(client, msg) {
  try {
    const targetChannelId = state.pinnedChannelId || msg?.member?.voice?.channel?.id || state.voiceCurrent || IDs.voice3;
    if (!state.connection || state.connection.state?.status !== VoiceConnectionStatus.Ready || state.connection.joinConfig.channelId !== targetChannelId) {
      await joinBanhaVoiceChannel(client, targetChannelId);
    }
    return state.connection && state.connection.state?.status === VoiceConnectionStatus.Ready;
  } catch (e) {
    console.error('ensureVoiceReady error:', e);
    return false;
  }
}

const playVoice = (resourceToPlay) => {
  if (state.player) state.player.play(resourceToPlay);
};

function leaveEmptyVoiceChannel(client) {
  // A running recording decides itself when to leave (it stops a while after the channel empties)
  if (!state.connection || state.pinnedChannelId) return;

  const channel = client.channels.cache.get(IDs.voice3);

  if (countHumans(channel) === 0) {
    state.connection.destroy();
    state.connection = null;
    state.player = null;
    state.connectionSubscription = null;
    console.log("Bot left the voice channel as no real people were left.");
  }
}

module.exports = {
  state,
  onVoiceReady,
  countHumans,
  textToSpeech,
  shouldJoinVoiceChannel,
  joinBanhaVoiceChannel,
  ensureVoiceReady,
  playVoice,
  leaveEmptyVoiceChannel,
  attachSpeakingTracker,
  flushSpeakingSeconds,
  getLiveSpeakingSeconds,
  seedSpeakingSeconds,
  trackedSpeakerIds,
  FLAG_KINDS,
  setVoiceFlags,
  getLiveFlagSeconds,
  flushFlagSeconds,
  seedFlagSeconds
};