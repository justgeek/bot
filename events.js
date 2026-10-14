const Discord = require("discord.js");
const fs = require("fs");
const _lodash = require("lodash");
const discordTTS = require("discord-tts");
const { createAudioResource, StreamType, generateDependencyReport } = require("@discordjs/voice");

const { IDs, gamesList, PeopleTTS } = require("./config");
const { sendToChannel, now, getAuthorDisplayName, isCraigMember, renameCraigToMokhber } = require("./utils");
const { memes, memesFolder, otherFolder } = require("./memes");
const audio = require("./audioManager");
const { handleAICommand } = require("./aiHandler");
const { clearHistory } = require("./history");
const { getRelevantEmojis } = require('./ai.js');
const { buildMemeMenus } = require("./menuBuilder");
const db = require("./db");

// What a member's voice state counts as right now. Deafening always mutes too, so that time is
// "deafened" only and "muted" means muted while still listening. Self and server mute/deafen both count.
function voiceFlags(vs) {
  const tracked = !!(vs.channelId && db.isTrackedChannel(vs.channelId));
  return {
    streaming: tracked && !!vs.streaming,
    deafened: tracked && !!vs.deaf,
    muted: tracked && !!vs.mute && !vs.deaf,
  };
}

module.exports = (client) => {
  client.on("error", (e) => console.error("ERR NOT HANDLED:", e));

  client.on("ready", () => {
    console.log(`Logged in as ${client.user.tag}!`);
    try {
      const voicePkg = require('@discordjs/voice/package.json');
      console.log(`Runtime Node: ${process.version}`);
      console.log(`@discordjs/voice version: ${voicePkg.version}`);
    } catch { }
    client.user.setStatus('invisible');
    sendToChannel(client, IDs.channelStatus, 'Sup!\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t("**!commands**" for stuff)');

    try { console.log(generateDependencyReport()); } catch { }

    if (audio.shouldJoinVoiceChannel(client, IDs.voice3)) {
      audio.joinBanhaVoiceChannel(client, IDs.voice3);
    }

    const guild = client.guilds.cache.get(IDs.guild);
    const membersLoaded = guild
      ? guild.members.fetch({ withPresences: true }).catch((e) => console.warn("Member fetch warning:", e.message))
      : Promise.resolve();
    membersLoaded
      .then(() => db.reconcileVoiceSessions(client))
      .then((carried) => {
        for (const [userId, saved] of carried || []) {
          audio.seedSpeakingSeconds(userId, saved.speaking);
          audio.seedFlagSeconds(userId, saved);
        }
        // Pick up anyone already streaming, muted or deafened when the bot started
        guild?.voiceStates.cache.forEach((vs) => {
          if (!vs.member?.user?.bot) audio.setVoiceFlags(vs.id, voiceFlags(vs));
        });
      });

    // Save running mic talk / stream time once a minute so open sessions show it and a restart doesn't lose it
    const lastSavedSpeaking = new Map();
    setInterval(() => {
      const guild = client.guilds.cache.get(IDs.guild);
      for (const userId of audio.trackedSpeakerIds()) {
        if (!guild?.voiceStates.cache.get(userId)?.channelId) continue;
        const secs = audio.getLiveSpeakingSeconds(userId);
        const flagSecs = audio.getLiveFlagSeconds(userId);
        const stamp = secs + ":" + Object.values(flagSecs).join(":");
        if (lastSavedSpeaking.get(userId) === stamp) continue;
        lastSavedSpeaking.set(userId, stamp);
        db.checkpointSpeaking(userId, secs, flagSecs);
      }
    }, 60000);
  });

  client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;

    if (!msg.guild) {
      if (msg.author.id === IDs.Moonscarlet) {
        const dmMessage = msg.content.toLowerCase();
        if (dmMessage === "!!clear" || dmMessage === "!!reset") {
          clearHistory(msg);
          msg.reply("🧹 Cleared the AI conversation history for this DM.");
          return;
        }
        if (dmMessage.startsWith("!!")) {
          const userPrompt = msg.content.substring(msg.content.toLowerCase().indexOf("!!") + 2).trim();
          await handleAICommand(msg, userPrompt);
        }
        return;
      }

      let moonscarlet;
      try {
        moonscarlet = await client.users.fetch(IDs.Moonscarlet);
        let forward = `📩 **DM from ${msg.author.username}** (\`${msg.author.id}\`):\n${msg.content || "*(no text)*"}`;
        if (msg.attachments.size > 0) {
          const urls = [...msg.attachments.values()].map((a) => a.url).join("\n");
          forward += `\n📎 Attachments:\n${urls}`;
        }
        if (forward.length > 1900) forward = forward.slice(0, 1900) + "… (truncated)";
        await moonscarlet.send(forward);
      } catch (err) {
        console.error("Error forwarding DM to moonscarlet:", err);
      }

      await handleAICommand(msg, msg.content, {
        onReply: async (assistantText) => {
          if (!moonscarlet) return;
          try {
            let replyNotice = `🤖 **Bot replied to ${msg.author.username}:**\n${assistantText}`;
            if (replyNotice.length > 1900) replyNotice = replyNotice.slice(0, 1900) + "… (truncated)";
            await moonscarlet.send(replyNotice);
          } catch (err) {
            console.error("Error forwarding bot reply to moonscarlet:", err);
          }
        },
      });
      return;
    }

    let message = msg.content.toLowerCase();
    if (msg.author.username + "#" + msg.author.discriminator == "Malevolent#0025") return;

    const displayName = getAuthorDisplayName(msg);

    const reactTo = ['ASD'];
    if ((reactTo.includes(msg.author.username) && !message.startsWith("!")) || message.startsWith("_")) {
      try {
        const suggestedEmojis = await getRelevantEmojis(msg.content, 5, 'openai/gpt-oss-120b');
        for (const emoji of suggestedEmojis) {
          try {
            await msg.react(emoji);
            await new Promise(resolve => setTimeout(resolve, 300));
          } catch (error) {
            console.error(`Error reacting with emoji ${emoji}:`, error);
            continue;
          }
        }
      } catch (error) {
        console.error('Error in AI emoji reaction:', error);
      }
    }

    if (message === "!commands" || message === "!help") {
      const commands = [
        '`!youtube` or `!playlist`: print YouTube playlist link.',
        '`!random <names (comma separated)>`: shuffle provided players.',
        "`!randomall`: create random teams of all players in your current voice channel.",
        '`!randomall <row numbers to exclude>` (e.g. `!randomall 3,5`).',
        "`!<anything>`: Text-To-Speech.",
        "`!!<anything>`: AI response.",
        "`!!clear`: clear the AI conversation history for this channel.",
        "`!memes`: list memes.",
        "`!joinme`: Join your current voice channel.",
        "`!restartbot`: Restart the bot.",
      ];
      msg.channel.send("> **COMMANDS:**\n> " + commands.join("\n> "));
    } else if (message === "!memes") {
      const messages = buildMemeMenus();
      for (const payload of messages) {
        await msg.channel.send(payload);
      }
    } else if (message == "!playlist" || message == "!youtube") {
      msg.channel.send("https://www.youtube.com/playlist?list=PLhKVK0lPQ73sDSSxq09yx9QVgyr3MBR6d");
    } else if (memes[message]) {
      const voiceChannel = msg.member.voice.channel;
      if (!voiceChannel) {
        msg.reply("You need to be in a voice channel to play a meme!");
        return;
      }
      const memeFile = memesFolder + memes[message];
      const resource = createAudioResource(memeFile);

      await audio.ensureVoiceReady(client, msg);
      audio.playVoice(resource);
      const logMessage = msg.member.displayName + " " + message;
      console.log(logMessage);
      sendToChannel(client, IDs.channelCommands, logMessage);
      msg.delete();
    } else if (message.startsWith("!random ")) {
      message = message.replace("!random ", "").replaceAll(" ", "");
      let players = message.split(",");
      if (players.length == 1) {
        msg.reply(players.shift() + " can queue alone!");
      } else {
        players = _lodash.shuffle(players);
        let teams = `> **${players.length} players:**`, teamNumber = 1;
        while (players.length > 0) {
          if (players.length > 1) {
            teams += `\n> **Team ${teamNumber}:** ${players.shift()} - ${players.shift()}`;
          } else {
            teams += `\n> **Team ${teamNumber}:** ${players.shift()}`;
          }
          teamNumber++;
        }
        msg.reply(teams);
      }
    } else if (message.startsWith("!randomall")) {
      const voiceChannel = msg.member?.voice?.channel;
      if (!voiceChannel) {
        msg.reply("> You're not in a voice channel!");
      } else {
        try {
          await msg.guild.members.fetch().catch((e) => console.warn("Guild members fetch warning:", e));
          let players = [];
          voiceChannel.members.forEach((mem) => {
            let memberNickname = mem.displayName;
            let memberId = mem.user.id;
            if (isCraigMember(mem)) renameCraigToMokhber(mem, "!randomall check");
            if (!mem.user.bot && mem.user.id !== client.user.id) {
              players.push({ displayName: memberNickname, mention: `<@${memberId}>`, id: memberId });
            }
          });

          players.sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { numeric: true }));

          let excludedPlayers = [];
          const argsStr = message.slice("!randomall".length).trim();
          if (argsStr.length > 0) {
            const tokens = argsStr.replace(/[,،，٫;]+/g, " ").split(/\s+/).filter(Boolean);
            const excludedIndices = new Set();
            for (const token of tokens) {
              const rowNum = parseInt(token, 10);
              if (!isNaN(rowNum) && rowNum >= 1 && rowNum <= players.length) {
                excludedIndices.add(rowNum - 1);
              } else {
                const foundIdx = players.findIndex((p) => p.displayName.toLowerCase() === token.toLowerCase());
                if (foundIdx !== -1) excludedIndices.add(foundIdx);
              }
            }
            const remainingPlayers = [];
            players.forEach((player, idx) => {
              if (excludedIndices.has(idx)) excludedPlayers.push(player);
              else remainingPlayers.push(player);
            });
            players = remainingPlayers;
          }

          if (players.length === 0) {
            msg.reply("no players no games!");
          } else if (players.length === 1) {
            let replyText = "";
            if (excludedPlayers.length > 0) replyText += `> **Excluded:** ${excludedPlayers.map((p) => p.displayName).join(", ")}\n`;
            const solo = players.shift();
            replyText += "lol " + (solo?.mention || solo?.displayName) + " go queue alone KEKW";
            msg.reply(replyText);
          } else {
            players = _lodash.shuffle(players);
            let teams = "";
            if (excludedPlayers.length > 0) teams += `> **Excluded:** ${excludedPlayers.map((p) => p.displayName).join(", ")}\n`;
            teams += `> **${players.length} players:**`;
            let teamNumber = 1;
            while (players.length > 0) {
              if (players.length > 1) {
                const p1 = players.shift();
                const p2 = players.shift();
                teams += `\n> **Team ${teamNumber}:** ${p1?.mention || p1?.displayName} - ${p2?.mention || p2?.displayName}`;
              } else {
                const p1 = players.shift();
                teams += `\n> **Team ${teamNumber}:** ${p1?.mention || p1?.displayName}`;
              }
              teamNumber++;
            }
            msg.reply(teams);
          }
        } catch (err) {
          console.error("Error in !randomall:", err);
          msg.reply(`An error occurred while creating teams: ${err.message || err}`);
        }
      }
    } else if (message.startsWith("!joinme")) {
      try {
        let vc = msg.member.voice.channel.id;
        if (vc) {
          await audio.joinBanhaVoiceChannel(client, vc);
          msg.delete();
        }
      } catch { }
    } else if (message === "!!clear" || message === "!!reset") {
      clearHistory(msg);
      msg.delete();
      return;
    } else if (message.startsWith("!!")) {
      const userPrompt = msg.content.substring(msg.content.toLowerCase().indexOf("!!") + 2).trim();
      await handleAICommand(msg, userPrompt);
      return;
    } else if (message.startsWith("!restartbot")) {
      msg.delete();
      console.log("Restarting bot...");
      process.exit(1);
    } else if (message.startsWith("!")) {
      message = message.replace("!", "").trim();
      let lang = "ja";
      try {
        const audioPath = await audio.textToSpeech(message);
        const resource = createAudioResource(audioPath);
        await audio.ensureVoiceReady(client, msg);
        audio.playVoice(resource);
        setTimeout(() => {
          fs.unlink(audioPath, (err) => { if (err) console.error('Error deleting audio file:', err); });
        }, 5000);
      } catch (error) {
        console.error('ElevenLabs TTS failed, falling back to default TTS:', error);
        const stream = discordTTS.getVoiceStream(message, { lang: lang });
        const resource = createAudioResource(stream);
        await audio.ensureVoiceReady(client, msg);
        audio.playVoice(resource);
      }
      const logMessage = `${msg.member.displayName} ${message}`;
      console.log(logMessage);
      sendToChannel(client, IDs.channelCommands, logMessage);
      msg.delete();
    }
  });

  client.on("messageDelete", (msg) => {
    if (msg.author?.bot) return;
    const message = msg.content.toLowerCase();
    if (message.startsWith("!") || message == "!commands" || message == "!playlist") return;
    const deleted = `${now()}\t **${msg.author.username}:** ${msg.content}`;
    console.log("deleted:", deleted);
    sendToChannel(client, IDs.channelDel, deleted);
  });

  client.on("messageUpdate", (oldMessage, newMessage) => {
    if (newMessage.author?.bot) return;
    if (oldMessage == newMessage) return;
    const edited = `${now()}\t **${newMessage.author.username}:**\n${oldMessage.content}\n>\n${newMessage.content}`;
    console.log("edited:", edited);
    sendToChannel(client, IDs.channelDel, edited);
  });

  client.on("presenceUpdate", (before, after) => {
    const userID = after.userId;
    const user = client.users.cache.get(userID);
    const statusBefore = !before ? " " : before.status;
    const statusAfter = !after ? " " : after.status;

    if (statusBefore != statusAfter) {
      const msg = now() + "\t**" + user.username + ":\t**" + statusBefore + "\t>\t" + statusAfter;
      console.log(msg);
      sendToChannel(client, IDs.channelStatus, msg);
    }

    const dbStatusBefore = before?.status || "offline";
    const dbStatusAfter = after?.status || "offline";
    // Which apps they're on: "desktop", "mobile", "web" or a mix like "desktop,mobile"
    const devicesOf = (p) => Object.keys(p?.clientStatus || {}).sort().join(",");
    const devicesAfter = dbStatusAfter === "offline" ? "" : devicesOf(after);
    const devicesChanged = dbStatusAfter !== "offline" && devicesOf(before) !== devicesAfter;
    // A row also goes in when only the device changes (e.g. left the PC, still online on the phone)
    if ((dbStatusBefore !== dbStatusAfter || devicesChanged) && !user?.bot) {
      db.logPresence(
        userID,
        user?.username || after.user?.username || userID,
        dbStatusAfter,
        after.member?.displayName,
        devicesAfter
      );
    }

    const beforeActivities = before ? before.activities : [];
    const afterActivities = after ? after.activities : [];

    afterActivities.forEach(activity => {
      if (activity.name === "Hang Status") return;
      const isNewActivity = !beforeActivities.some(a => a.name === activity.name);

      if (isNewActivity) {
        let action = "Activity:";
        switch (activity.type) {
          case Discord.ActivityType.Playing: action = "🎮 Playing"; break;
          case Discord.ActivityType.Listening: action = "🎵 Listening to"; break;
          case Discord.ActivityType.Watching: action = "📺 Watching"; break;
          case Discord.ActivityType.Streaming: action = "🔴 Streaming"; break;
          case Discord.ActivityType.Competing: action = "🏆 Competing in"; break;
          case Discord.ActivityType.Custom: action = "💬 Custom Status:"; break;
        }
        const details = activity.details ? ` | ${activity.details}` : "";
        const stateStr = activity.state ? ` | ${activity.state}` : "";
        const msg2 = now() + "\t**" + user.username + ":\t**" + action + " " + activity.name + details + stateStr;
        console.log(msg2);
        sendToChannel(client, IDs.channelActivity, msg2);
      }
    });
  });

  client.on("voiceStateUpdate", async (before, after) => {
    if (after.id == client.user.id) return;

    // --- Database logging: voice sessions with mic speaking tracking ---
    if (before.channelId !== after.channelId && !after.member?.user?.bot) {
      const dbUserId = after.id;
      const dbUsername = after.member?.user?.username || dbUserId;

      if (before.channelId) {
        // Retrieve and flush the member's speaking and screen-share seconds for this session
        const speakingSecs = audio.flushSpeakingSeconds ? audio.flushSpeakingSeconds(dbUserId) : 0;
        db.endVoiceSession(dbUserId, speakingSecs, audio.flushFlagSeconds(dbUserId));
      }
      if (after.channelId && db.isTrackedChannel(after.channelId)) {
        // remember which app(s) they joined from (empty when they show as invisible)
        const joinDevices = Object.keys(after.member?.presence?.clientStatus || {}).sort().join(",");
        db.startVoiceSession(dbUserId, dbUsername, after.channelId, after.channel?.name, after.member?.displayName, joinDevices);
      }
    }
    // Screen share, mute or deafen toggled (all of them end when the member leaves voice)
    if (!after.member?.user?.bot) audio.setVoiceFlags(after.id, voiceFlags(after));

    let chatMsg = " ";
    const person = after.member.user.username;
    let personTTS = PeopleTTS[person] ? PeopleTTS[person] : person;

    if ((before.channelId && !after.channelId) || (before.channelId && after.channelId && before.channelId != after.channelId)) {
      chatMsg = now() + " **" + person + "** left **" + client.channels.cache.get(before.channelId).name + "**";
      console.log(chatMsg);
      if (before.channelId != IDs.voice2 && after.channelId != IDs.voice2) {
        sendToChannel(client, IDs.channelVoice, chatMsg);
      }

      if (before.channelId == audio.state.voiceCurrent) {
        const stream = discordTTS.getVoiceStream(personTTS + " left", { lang: "ja" });
        const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
        audio.playVoice(resource);
      }
      audio.leaveEmptyVoiceChannel(client);
    }

    if ((!before.channelId && after.channelId) || (before.channelId && after.channelId && before.channelId != after.channelId)) {
      let member = after.member;
      if (!member && after.guild) {
        member = await after.guild.members.fetch(after.id).catch(() => null);
      }
      if (member && isCraigMember(member)) {
        setTimeout(async () => {
          const freshMember = await after.guild.members.fetch(after.id).catch(() => null);
          await renameCraigToMokhber(freshMember, "after join delay");
        }, 500);
      }

      if (after.channelId == audio.state.voiceCurrent) {
        if (!audio.state.connection || audio.shouldJoinVoiceChannel(client, IDs.voice3)) {
          await audio.joinBanhaVoiceChannel(client, IDs.voice3);
        }

        const stream = discordTTS.getVoiceStream(personTTS + " joined", { lang: "ja" });
        const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
        audio.playVoice(resource);

        if (person == "prollygeek") {
          const memeFile = otherFolder + "TDKJoin.mp3";
          let resource2 = createAudioResource(memeFile);
          audio.playVoice(resource2);
        }
      }

      if (after.id == 272937604339466240) return;
      chatMsg = now() + " **" + person + "** joined **" + client.channels.cache.get(after.channelId).name + "**";
      console.log(chatMsg);
      if (before.channelId != IDs.voice2 && after.channelId != IDs.voice2) {
        sendToChannel(client, IDs.channelVoice, chatMsg);
      }
    }
  });

  client.on("guildMemberUpdate", async (oldMember, newMember) => {
    if (isCraigMember(newMember) && newMember.voice?.channelId && newMember.nickname !== "مخبر") {
      setTimeout(async () => {
        const freshMember = await newMember.guild.members.fetch(newMember.id).catch(() => null);
        if (freshMember && freshMember.voice?.channelId && freshMember.nickname !== "مخبر") {
          await renameCraigToMokhber(freshMember, "guildMemberUpdate override");
        }
      }, 1500);
    }
  });

  client.on("guildMemberAdd", (member) => {
    const chatMsg = member.user.username + " has joined the server.";
    sendToChannel(client, IDs.channelMain, chatMsg);
  });

  client.on("guildMemberRemove", (member) => {
    const chatMsg = member.user.username + " has left the server.";
    sendToChannel(client, IDs.channelMain, chatMsg);
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith("meme_select_")) {
        const memeKey = interaction.values[0];
        const memeFile = memes[memeKey];

        if (!memeFile) {
          await interaction.deferUpdate();
          return;
        }

        await interaction.update({ components: interaction.message.components });

        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
          await interaction.followUp({
            content: "You need to be in a voice channel to play a meme!",
            ephemeral: true,
          });
          return;
        }

        const resource = createAudioResource(memesFolder + memeFile);
        await audio.ensureVoiceReady(client, interaction);
        audio.playVoice(resource);

        const logMessage = interaction.member.displayName + " " + memeKey;
        console.log(logMessage);
        sendToChannel(client, IDs.channelCommands, logMessage);
      }
    } catch (err) {
      console.error("Error handling meme interaction:", err);
    }
  });
};