// recording/rest.js - a Discord client for the processor-only worker (worker.js on a PC), with no gateway
// connection: it can read channels, edit the recording's panel and post in its thread, but it never shows
// up online and can't join voice, so it can't get in the way of the bot that's running on Heroku.
const fs = require("fs");
const path = require("path");
const { REST, Routes } = require("discord.js");

const VOICE_TYPES = new Set([2, 13]); // GuildVoice, GuildStageVoice
// The panels are Component (v2) builders: JSON.stringify runs their toJSON
const plain = (payload) => JSON.parse(JSON.stringify(payload || {}));

function makeRestClient(token) {
  const rest = new REST({ version: "10" }).setToken(token);
  const cache = new Map(); // channel id -> channel (the panel and a thread are looked up over and over)

  const post = async (route, payload) => {
    const body = plain(payload);
    const files = body.files || [];
    delete body.files;
    if (!files.length) return rest.post(route, { body });
    return rest.post(route, {
      body,
      files: files.map((f) => ({ name: f.name || path.basename(f.attachment), data: fs.readFileSync(f.attachment) })),
    });
  };

  const wrapMessage = (channelId, data) => ({
    id: data.id,
    edit: (payload) => rest.patch(Routes.channelMessage(channelId, data.id), { body: plain(payload) }),
    delete: () => rest.delete(Routes.channelMessage(channelId, data.id)).catch(() => {}),
  });

  const wrapChannel = (data) => ({
    id: data.id,
    name: data.name,
    type: data.type,
    isVoiceBased: () => VOICE_TYPES.has(data.type),
    send: (payload) => post(Routes.channelMessages(data.id), payload).then((m) => wrapMessage(data.id, m)),
    messages: {
      fetch: async (id) => {
        try {
          return wrapMessage(data.id, await rest.get(Routes.channelMessage(data.id, id)));
        } catch (err) {
          if (err.status !== 404) console.warn(`[Rec] Couldn't fetch message ${id}:`, err.message);
          return null;
        }
      },
    },
  });

  return {
    rest,
    channels: {
      cache: { get: () => null, values: () => [][Symbol.iterator]() },
      fetch: async (id) => {
        if (cache.has(id)) return cache.get(id);
        try {
          const channel = wrapChannel(await rest.get(Routes.channel(id)));
          cache.set(id, channel);
          return channel;
        } catch (err) {
          if (err.status !== 404) console.warn(`[Rec] Couldn't load channel ${id}:`, err.message);
          return null;
        }
      },
    },
  };
}

module.exports = { makeRestClient };
