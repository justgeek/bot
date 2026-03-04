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
  connectionSubscription: null
};

async function textToSpeech(text) {
  // const voiceId = '21m00Tcm4TlvDq8ikWAM';
  // const voiceId = 'EXAVITQu4vr4xnSDxMaL';//sarah
  // const voiceId = '21m00Tcm4TlvDq8ikWAM';//jessica
  // const voiceId = 'vFedMyIZJ59tTsx3LZjA';//Malevolent
  // const voiceId = 'FZZ34QV5WgZK5N73m5cU';//testdisc
  // voiceid UR972wNGq3zluze0LoIp haytham
  // ghizlane u0TsaWvt0v8migutHM3M

  const isArabic = /^[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0660-\u0669\u066A-\u066F\u06D4\u060C\u061B\u061F\s]+$/.test(text);
  const voiceId = isArabic ? process.env.ELEVENLABS_VOICE_ID_ARABIC : process.env.ELEVENLABS_VOICE_ID;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const model = !text.includes("[") && !text.includes("]") ? process.env.ELEVENLABS_MODEL_ID : process.env.ELEVENLABS_MODEL_TEST_ID;

  try {
    const response = await axios({
      method: 'post',
      url: url,
      headers: {
        'Accept': 'audio/mpeg',
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      data: { text: text, model_id: model },
      responseType: 'arraybuffer'
    });

    // Optimization: Add unique timestamp to avoid race conditions overriding each other's audio files
    const outputPath = `output_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp3`;
    fs.writeFileSync(outputPath, response.data);
    console.log(`Audio saved to ${outputPath}`);

    return outputPath;
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    throw error;
  }
}

function shouldJoinVoiceChannel(client, channelId) {
  const channel = client.channels.cache.get(channelId);
  if (channel) {
    const totalMembers = channel.members.size;
    const botMember = channel.members.get(client.user.id);
    return totalMembers > 0 && !(totalMembers === 1 && botMember);
  }
  return false;
}

const joinBanhaVoiceChannel = async (client, channelToJoin) => {
  if (!shouldJoinVoiceChannel(client, channelToJoin)) {
    console.log(`Not joining voice channel ${channelToJoin} as it's empty or only contains bots.`);
    return null;
  }

  state.voiceCurrent = channelToJoin;
  state.connection = joinVoiceChannel({
    channelId: channelToJoin,
    guildId: IDs.guild,
    adapterCreator: client.guilds.cache.get(IDs.guild).voiceAdapterCreator,
  });

  try {
    await entersState(state.connection, VoiceConnectionStatus.Ready, 20000);
    console.log(`Bot joined voice channel: ${channelToJoin}`);
  } catch (err) {
    console.error("Voice connection failed to become ready:", err);
    try { state.connection.destroy(); } catch {}
    state.connection = null;
    return null;
  }

  if (!state.player) {
    state.player = createAudioPlayer();
    state.player.on('error', (e) => console.error('AudioPlayer error:', e));
    state.player.on('stateChange', (oldState, newState) => {
      try { console.log(`AudioPlayer state: ${oldState.status} -> ${newState.status}`); } catch {}
    });
  }

  try {
    state.connectionSubscription = state.connection.subscribe(state.player);
  } catch (e) {
    console.error('Failed to subscribe player to connection:', e);
  }

  return state.connection;
};

async function ensureVoiceReady(client, msg) {
  try {
    const targetChannelId = msg?.member?.voice?.channel?.id || state.voiceCurrent || IDs.voice3;
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
  if (!state.connection) return;

  const channel = client.channels.cache.get(IDs.voice3);
  const totalMembers = channel ? channel.members.size : 0;

  if (totalMembers === 1) {
    state.connection.destroy();
    state.connection = null;
    state.player = null;
    state.connectionSubscription = null;
    console.log("Bot left the voice channel as it was the only user.");
  }
}

module.exports = {
  state,
  textToSpeech,
  shouldJoinVoiceChannel,
  joinBanhaVoiceChannel,
  ensureVoiceReady,
  playVoice,
  leaveEmptyVoiceChannel
};