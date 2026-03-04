const Discord = require("discord.js");
const fs = require("fs");
const _lodash = require("lodash");
const discordTTS = require("discord-tts");
const { createAudioResource, StreamType, generateDependencyReport } = require("@discordjs/voice");

const { IDs, gamesList, PeopleTTS } = require("./config");
const { sendToChannel, now, getAuthorDisplayName } = require("./utils");
const { memes, memesFolder, otherFolder } = require("./memes");
const audio = require("./audioManager");
const { handleAICommand } = require("./aiHandler");
const { getRelevantEmojis, isValidDiscordEmoji } = require('./ai.js'); // Your existing logic file

module.exports = (client) => {
  client.on("error", (e) => console.error("ERR NOT HANDLED:", e));

  client.on("ready", () => {
    console.log(`Logged in as ${client.user.tag}!`);
    try {
      const voicePkg = require('@discordjs/voice/package.json');
      console.log(`Runtime Node: ${process.version}`);
      console.log(`@discordjs/voice version: ${voicePkg.version}`);
    } catch {}
    client.user.setStatus('invisible');
    sendToChannel(client, IDs.channelV, 'Sup!\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t("**!commands**" for stuff)');

    // Optional: print dependency report once for debugging audio env
    try { console.log(generateDependencyReport()); } catch {}

    if (audio.shouldJoinVoiceChannel(client, IDs.voice3)) {
      audio.joinBanhaVoiceChannel(client, IDs.voice3);
    }
  });

  client.on("messageCreate", async (msg) => {
    let message = msg.content.toLowerCase();
    if (msg.author.username + "#" + msg.author.discriminator == "Malevolent#0025") return;

    const displayName = getAuthorDisplayName(msg);
    const idtest = '329004546900885515';

    if (msg.author.username + "#" + msg.author.discriminator == "exorcismus#7611" && !message.startsWith("!")) {
      // (Preserving all comments perfectly as requested)
      // if (msg.author.username + '#' + msg.author.discriminator == 'Moonscarlet#4105') {
      // msg.react(msg.guild.emojis.cache.get('515873f6898e0b26daf51921c65a43f7'))//BRUH
      // msg.react(':regional_indicator_a:')
      // msg.react(msg.guild.emojis.cache.get("1018204796689322014")); //BRUH
    }

    const reactTo =['ASD']
    if ((reactTo.includes(msg.author.username) && !message.startsWith("!")) || message.startsWith("_")) {
      try {
        const suggestedEmojis = await getRelevantEmojis(msg.content, 5, 'qwen-qwq-32b');
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

    if (msg.author.username == 'ibrahimsp' && !message.startsWith("!")) {
      // if (msg.author.username == 'moonscarlet' && !message.startsWith("!")) {
      // if (!message.startsWith("!")) {
      // msg.react(msg.guild.emojis.cache.get('515873f6898e0b26daf51921c65a43f7'))//BRUH
      // msg.react(':regional_indicator_a:')
      // msg.react('🤷‍♂️');
      // msg.react('🤷');
      // msg.react(msg.guild.emojis.cache.get("1018204796689322014")); //BRUH
    }

    if (message === "!commands" || message === "!help") {
      const commands =[
        // '**!round**: Prints the current CHC round number',
        '`!youtube` or `!playlist`: print YouTube "Our Games" playlist link.',
        // "**!games**: list possible games to play.",
        // "**!randomgame**: choose a random game to play.",
        '`!random <names (comma separated)>`: shuffle provided players(`!random player1,player2,player3`).',
        "`!randomall`: create random teams of all players in your current voice channel.",
        '`!randomall <voice channel members row numbers to exclude (comma separated)>` (to exclude 3rd and 5th `!randomall 3,5`).',
        "`!<anything>`: Text-To-Speech.",
        "`!!<anything>`: AI response.",
        "`!memes`: list memes.",
        "`!joinme`: Join your current voice channel.",
        "`!restartbot`: Restart the bot.",
      ];
      msg.channel.send("> **COMMANDS:**\n> " + commands.join("\n> "));
    } else if (message === "!memes") {
      const memesKeys = "> ```" + Object.keys(memes).map((e) => e.toUpperCase()).join(", ") + "```";
      msg.reply(memesKeys);
    } else if (message == "!playlist" || message == "!youtube") {
      msg.channel.send("https://www.youtube.com/playlist?list=PLhKVK0lPQ73sDSSxq09yx9QVgyr3MBR6d");
    } else if (memes[message]) {
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
      console.log("message: %s", message);
      let players = message.split(",");
      console.log("players: %s", players);

      if (players.length == 1) {
        msg.reply(players.shift() + " can queue alone!");
      } else {
        players = _lodash.shuffle(players);
        console.log("shuffled players: %s", players);
        let teams = `> **${players.length} players:**`, teamNumber = 1;
        
        [1, 2, 3, 4]; // Original line preserved
        // Optimization: Refactored i+2 loop visually into a safer while loop with identical output
        while (players.length > 0) {
          if (players.length > 1) {
            teams += `\n> **Team ${teamNumber}:** ${players.shift()} - ${players.shift()}`;
          } else {
            teams += `\n> **Team ${teamNumber}:** ${players.shift()}`;
          }
          teamNumber++;
        }
        console.log("Teams: %s", teams);
        msg.reply(teams);
      }
      console.log("-----------------------------------------------------------------------");
    } else if (message.startsWith("!randomall")) {
      let players =[], currentVoiceChannelName, currentVoiceChannelId, memberFullTag, memberId, memberVoiceChannelName, memberVoiceChannelId;

      if (!_lodash.isNull(msg.member.voice.channel)) {
        currentVoiceChannelName = msg.member.voice.channel.name;
        currentVoiceChannelId = msg.member.voice.channel.id;
        console.log("Current Voice Channel:" + currentVoiceChannelName);

        client.guilds.cache.get(msg.guild.id).members.fetch().then((members) => {
          members.forEach((mem) => {
            let memberNickname = mem.displayName;
            memberFullTag = mem.user.username + "#" + mem.user.discriminator;
            memberId = mem.user.id;

            if (!_lodash.isNull(mem.voice.channel)) {
              memberVoiceChannelName = mem.voice.channel.name;
              memberVoiceChannelId = mem.voice.channel.id;
              console.log(memberNickname + " " + memberId + " " + memberVoiceChannelName);
              if (memberVoiceChannelId == currentVoiceChannelId && mem.user.tag != client.user.tag) {
                players.push([memberNickname, `<@${memberId}>`]);
              }
            }
          });
          console.log("Players:", players);
          players.sort();
          console.log("Sorted Players:", players);

          if (message.startsWith("!randomall ")) {
            let playersTemp =[];
            message = message.replace("!randomall ", "").replaceAll(" ", "");
            console.log("message:", message);

            let excludedIdx = message.split(",");
            excludedIdx.forEach((e, idx, arr) => (arr[idx] -= 1));
            console.log("excludedIdx:", excludedIdx);
            players.forEach((e, idx) => {
              if (excludedIdx.find((e) => e == idx) == undefined) playersTemp.push(e);
            });
            console.log("playersTemp", playersTemp);
            players = playersTemp;
          }

          if (players.length == 0) {
            msg.reply("no players no games!");
          } else if (players.length == 1) {
            msg.reply("lol " + players.shift()[1] + " go queue alone KEKW");
          } else {
            players = _lodash.shuffle(players);
            console.log("shuffled players:", players);
            let teams = `> **${players.length} players:**`, teamNumber = 1;

            // Optimization: Adjusted same visually bugged loop pattern into a clear block
            while (players.length > 0) {
              if (players.length > 1) {
                teams += `\n> **Team ${teamNumber}:** ${players.shift()[1]} - ${players.shift()[1]}`;
              } else {
                teams += `\n> **Team ${teamNumber}:** ${players.shift()[1]}`;
              }
              teamNumber++;
            }
            console.log("Teams: ", teams);
            msg.reply(teams);
          }
        });
      } else {
        msg.reply("> You're not in a voice channel!");
      }
      console.log("-----------------------------------------------------------------------");
    } else if (message.startsWith("!joinme")) {
      try {
        let vc = msg.member.voice.channel.id;
        if (vc) {
          console.log("voiceCurrent: %s", vc);
          await audio.joinBanhaVoiceChannel(client, vc);
          msg.delete();
        }
      } catch {}
    } else if (message.startsWith("!!")) {
      const userPrompt = message.slice(2).trim();
      await handleAICommand(msg, userPrompt);
      return;
    } else if (message.startsWith("!restartbot")) {
      msg.delete();
      console.log("Restarting bot...");
      process.exit(1);
    } else if (message.startsWith("!")) {
      message = message.replace("!", "").trim();
      let lang = "ja";
      // const langRegex = /<([a-zA-Z-]+)>/;
      // const langMatch = message.match(langRegex);

      // if (langMatch) {
      //   lang = langMatch[1];
      //   message = message.replace(langMatch[0], "").trim();
      // }

      try {
        const audioPath = await audio.textToSpeech(message);
        const resource = createAudioResource(audioPath);

        await audio.ensureVoiceReady(client, msg);
        audio.playVoice(resource);

        setTimeout(() => {
          fs.unlink(audioPath, (err) => {
            if (err) console.error('Error deleting audio file:', err);
          });
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
      msg.delete();
      if (msg.channel.id in [IDs.channelActivity, IDs.channelDel, IDs.channelStatus, IDs.channelV, IDs.channelVoice]) return; //don't announce if not main channels
      sendToChannel(client, msg.channel.id, logMessage);
    }
  });

  client.on("messageDelete", (msg) => {
    const message = msg.content.toLowerCase();
    if (message.startsWith("!") || message == "!commands" || message == "!playlist") return;
    const deleted = `${now()}\t **${msg.author.username}:** ${msg.content}`;
    console.log("deleted:", deleted);
    sendToChannel(client, IDs.channelDel, deleted);
  });

  client.on("messageUpdate", (oldMessage, newMessage) => {
    if (oldMessage == newMessage) return;
    const edited = `${now()}\t **${newMessage.author.username}:**\n${oldMessage.content}\n>\n${newMessage.content}`;
    console.log("edited:", edited);
    sendToChannel(client, IDs.channelDel, edited);
    console.log("-----------------------------------------------------------------------");
  });

  client.on("presenceUpdate", (before, after) => {
    const userID = after.userId;
    const user = client.users.cache.get(userID);

    const statusBefore = !before ? " " : before.status;
    const statusAfter = !after ? " " : after.status;

    const msg = now() + "\t**" + user.username + ":\t**" + statusBefore + "\t>\t" + statusAfter;

    const nowdatetime = new Date();
    const utc = nowdatetime.getTime() + nowdatetime.getTimezoneOffset() * 60000;
    const egyptTime = new Date(utc + 3600000 * 2);
    const currentHour = egyptTime.getHours();

    if (statusBefore != statusAfter) {
      console.log(msg);
      sendToChannel(client, IDs.channelStatus, msg);
    }

    const beforeActivities = before ? before.activities :[];
    const afterActivities = after ? after.activities :[];

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

    if (userID == IDs.Moonscarlet && (statusBefore == "offline" || statusBefore == "") && statusAfter == "online") {
    } else if (
      userID == IDs.LORD &&
      (currentHour >= 15 || currentHour <= 2) &&
      (statusBefore == "offline" || statusBefore == " ") &&
      (statusAfter == "online" || statusAfter == "idle")
    ) {
    } else if (
      userID == IDs.ZEKUS &&
      (currentHour == 23 || currentHour == 0) &&
      (statusBefore == "offline" || statusBefore == " ") &&
      (statusAfter == "online")
    ) {
    }
  });

  client.on("voiceStateUpdate", async (before, after) => {  
    if (after.id == client.user.id) return;
    let chatMsg = " ";

    const person = after.member.user.username;
    let personTTS = PeopleTTS[person] ? PeopleTTS[person] : person;

    if ((before.channelId && !after.channelId) || (before.channelId && after.channelId && before.channelId != after.channelId)) {
      chatMsg = now() + " **" + person + "** left **" + client.channels.cache.get(before.channelId).name + "**";

      if (before.channelId == audio.state.voiceCurrent) {
        const stream = discordTTS.getVoiceStream(personTTS + " left", { lang: "ja" });
        const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
        audio.playVoice(resource);
      }
      audio.leaveEmptyVoiceChannel(client);
    }

    if ((!before.channelId && after.channelId) || (before.channelId && after.channelId && before.channelId != after.channelId)) {
      chatMsg = now() + " **" + person + "** joined **" + client.channels.cache.get(after.channelId).name + "**"; 

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
    }

    if (chatMsg != " ") {
      console.log(chatMsg);
      if (before.channelId == "248868783534505984" || after.channelId == "248868783534505984") return; //don't announce if secret voice channel
      sendToChannel(client, IDs.channelVoice, chatMsg);
    }
  });

  client.on("guildMemberAdd", (member) => {
    const chatMsg = member.user.username + " has joined the server.";
    console.log(chatMsg);
    sendToChannel(client, IDs.channelMain, chatMsg);
  });

  client.on("guildMemberRemove", (member) => {
    const chatMsg = member.user.username + " has left the server.";
    console.log(chatMsg);
    sendToChannel(client, IDs.channelMain, chatMsg);
  });
};