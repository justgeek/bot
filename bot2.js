require('dotenv').config();
const { Client, GatewayIntentBits } = require("discord.js");
const _ = require("lodash");
const fs = require("fs");
const discordTTS = require("discord-tts");
const { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  StreamType 
} = require("@discordjs/voice");
const express = require("express");

// Error handling function
const handleError = (error, context) => {
  console.error(`Error in ${context}:`, error);
  // Optionally, you can add more sophisticated error handling here,
  // such as logging to a file or sending an alert
};

// Initialize Discord Client with necessary intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildInvites,
  ],
});

// Channel and Role IDs
const IDs = {
  guild: "247069115204763648",
  channels: {
    main: "247069115204763648",
    v: "460899681787052083",
    del: "1020388735390601317",
    edit: "1021447609983959050",
    voice: "1021812152186720256",
    status: "1020398542365401128",
    commands: "1020315442042122330",
  },
  voices: {
    primary: "247069115204763649",
    secondary: "248868783534505984",
    tertiary: "310083935298125825",
    afk: "310083935298125825",
  },
  users: {
    Moonscarlet: "234236035846897664",
    LORD: "946751602415521873",
    Mido: "329004546900885515",
    TDK: "223957971976192001",
  },
};

let voiceCurrent = IDs.voices.tertiary;
let resource, player, connection, connectionSubscription;

// Command prefix
const PREFIX = "$";

// Load Memes
const memesFolder = "./memes/";
const memeFiles = fs.readdirSync(memesFolder);
const memes = memeFiles
  .map(file => ({
    name: `!${file.toLowerCase().replace(/.[^.]*$/, "").replace(/\d.+\|/g, "")}`,
    file: file.replace(/\d.+\|/g, "")
  }))
  .sort((a, b) => fs.statSync(memesFolder + a.file).mtimeMs - fs.statSync(memesFolder + b.file).mtimeMs)
  .reduce((acc, meme) => {
    acc[meme.name] = meme.file;
    return acc;
  }, {});

// List of Games
const gamesList = [
  "Turbo",
  "Custom Hero Clash (CHC)",
  "Knight Squad 2",
  "Left 4 Dead 2",
  "Legion TD",
  "Ability Draft",
  "Cyberpunk 2077",
  "Ability Arena",
  "World of Warcraft",
  "Dead By Daylight",
  "Midnight Ghost Hunt",
  "Dota Arcade",
];

// Express Server Setup
const app = express();
const port = process.env.PORT || 3000;
app.get("/", (req, res) => {
  res.send("BANHA FOREVER !!!!! BOT IS RUNNING OK");
});
app.listen(port, () => {
  console.log(`Express server listening on port ${port}`);
});

// Utility Functions
const sendToChannel = async (id, msg) => {
  try {
    const channel = await client.channels.fetch(id);
    if (channel) channel.send(msg);
  } catch (error) {
    console.error(`Failed to send message to channel ${id}:`, error);
  }
};

const now = () => {
  const today = new Date();
  const utcHours = (today.getUTCHours() + 3) % 24;
  const hours = utcHours % 12 || 12;
  const ampm = utcHours >= 12 ? "PM" : "AM";
  return `${today.getUTCDate().toString().padStart(2, '0')}/${(today.getUTCMonth()+1).toString().padStart(2, '0')}/${today.getUTCFullYear()} ${hours.toString().padStart(2, '0')}:${today.getUTCMinutes().toString().padStart(2, '0')}:${today.getUTCSeconds().toString().padStart(2, '0')} ${ampm}`;
};

const getAuthorDisplayName = (msg) => {
  if (msg.guild) {
    const member = msg.guild.members.cache.get(msg.author.id);
    return member?.nickname || msg.author.username;
  }
  return msg.author.username;
};

const playVoice = (resource) => {
  if (!player) {
    player = createAudioPlayer();
    if (connection) connectionSubscription = connection.subscribe(player);
  }
  player.play(resource);
};

const shouldJoinVoiceChannel = (channelId) => {
  const channel = client.channels.cache.get(channelId);
  if (channel) {
    const totalMembers = channel.members.size;
    const botMember = channel.members.get(client.user.id);
    return totalMembers > (botMember ? 1 : 0);
  }
  return false;
};

const leaveEmptyVoiceChannel = () => {
  if (!connection) return;
  const channel = client.channels.cache.get(IDs.voices.tertiary);
  if (channel?.members.size <= 1) { // Only bot is left
    connection.destroy();
    connection = null;
    player = null;
    connectionSubscription = null;
    console.log("Bot left the voice channel as it was the only user.");
  }
};

// Voice Channel Management
const joinBanhaVoiceChannel = (channelToJoin) => {
  if (shouldJoinVoiceChannel(channelToJoin)) {
    connection = joinVoiceChannel({
      channelId: channelToJoin,
      guildId: IDs.guild,
      adapterCreator: client.guilds.cache.get(IDs.guild).voiceAdapterCreator,
    });
    console.log(`Bot joined voice channel: ${channelToJoin}`);
    player = createAudioPlayer();
    connectionSubscription = connection.subscribe(player);
    return connection;
  } else {
    console.log(`Not joining voice channel ${channelToJoin} as it's empty or only contains bots.`);
    return null;
  }
};

// Event Listeners
client.on("error", (error) => {
  console.error("Unhandled error:", error);
});

client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}!`);
  client.user.setStatus('invisible');
  sendToChannel(IDs.channels.v, `Sup!\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t("**${PREFIX}commands**" for stuff)`);

  if (shouldJoinVoiceChannel(IDs.voices.tertiary)) {
    joinBanhaVoiceChannel(IDs.voices.tertiary);
  }
});

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;

    let message = msg.content.toLowerCase();
    const displayName = getAuthorDisplayName(msg);

    // Commands Handling
    if (!message.startsWith(PREFIX)) return; // Check for command prefix

    const command = message.slice(PREFIX.length).trim(); // Extract command without prefix

    switch (true) {
      case command === "commands":
        const commands = [
          `**${PREFIX}youtube** or **${PREFIX}playlist**: Print YouTube "Our Games" playlist link.`,
          `**${PREFIX}games**: List possible games to play.`,
          `**${PREFIX}randomgame**: Choose a random game to play.`,
          `**${PREFIX}random <names (comma separated)>**: Shuffle provided players (e.g., **${PREFIX}random player1,player2,player3**).`,
          `**${PREFIX}randomall**: Create random teams of all players in your current voice channel.`,
          `**${PREFIX}randomall <exclusions (comma separated)>**: Exclude specific members by their row numbers (e.g., **${PREFIX}randomall 3,5**).`,
          `**${PREFIX}<anything>**: Text-To-Speech.`,
          `**${PREFIX}memes**: List available memes.`,
          `**${PREFIX}joinme**: Join your current voice channel for TTS and other features.`,
        ];
        await msg.channel.send("> **COMMANDS:**\n> " + commands.join("\n> "));
        break;

      case command === "games":
        const games = "> **" + gamesList.sort().join("**\n> **") + "**";
        await msg.reply(games);
        break;

      case command === "randomgame":
        const randomGame = "> **" + _.sample(gamesList) + "**";
        await msg.reply(randomGame);
        break;

      case command === "memes":
        const memesKeys = "> **" + Object.keys(memes).map(e => e.toUpperCase()).join(", ") + "**";
        await msg.reply(memesKeys);
        break;

      case command === "playlist" || command === "youtube":
        await msg.channel.send("https://www.youtube.com/playlist?list=PLhKVK0lPQ73sDSSxq09yx9QVgyr3MBR6d");
        break;

      case memes[`!${command}`]:
        const memeFile = memesFolder + memes[`!${command}`];
        resource = createAudioResource(memeFile);
        playVoice(resource);
        const logMessage = `${displayName} played meme: ${command}`;
        console.log(logMessage);
        await sendToChannel(IDs.channels.commands, logMessage);
        await msg.delete();
        break;

      case command.startsWith("random "):
        const playersInput = command.replace("random ", "").replace(/\s/g, "").split(",");
        if (playersInput.length === 1) {
          await msg.reply(`${playersInput[0]} can queue alone!`);
        } else {
          const shuffled = _.shuffle(playersInput);
          const teams = shuffled.reduce((acc, player, idx) => {
            const team = Math.floor(idx / 2) + 1;
            acc[`Team ${team}`] = acc[`Team ${team}`] ? [...acc[`Team ${team}`], player] : [player];
            return acc;
          }, {});
          const teamMessages = Object.entries(teams).map(([team, members]) => `> **${team}:** ${members.join(" - ")}`).join("\n");
          await msg.reply(`> **${playersInput.length} players:**\n${teamMessages}`);
        }
        break;

      case command.startsWith("randomall"):
        const exclusion = command.replace("randomall", "").trim();
        let excludedIdx = [];
        if (exclusion) {
          excludedIdx = exclusion.split(",").map(num => parseInt(num) - 1).filter(num => !isNaN(num));
        }

        const voiceChannel = msg.member.voice.channel;
        if (!voiceChannel) {
          await msg.reply("> You're not in a voice channel!");
          break;
        }

        const members = voiceChannel.members.filter(member => !member.user.bot).map(member => [`${member.displayName}`, `<@${member.id}>`]);
        const filteredMembers = members.filter((_, idx) => !excludedIdx.includes(idx));
        
        if (filteredMembers.length === 0) {
          await msg.reply("No players available for games!");
        } else if (filteredMembers.length === 1) {
          await msg.reply(`Lol ${filteredMembers[0][1]} go queue alone KEKW`);
        } else {
          const shuffledMembers = _.shuffle(filteredMembers);
          const teamsAll = shuffledMembers.reduce((acc, member, idx) => {
            const team = Math.floor(idx / 2) + 1;
            acc[`Team ${team}`] = acc[`Team ${team}`] ? [...acc[`Team ${team}`], member[1]] : [member[1]];
            return acc;
          }, {});
          const teamAllMessages = Object.entries(teamsAll).map(([team, members]) => `> **${team}:** ${members.join(" - ")}`).join("\n");
          await msg.reply(`> **${filteredMembers.length} players:**\n${teamAllMessages}`);
        }
        break;

      case command.startsWith("joinme"):
        try {
          const userVoiceChannel = msg.member.voice.channel;
          if (userVoiceChannel) {
            voiceCurrent = userVoiceChannel.id;
            console.log(`Current voice channel set to: ${voiceCurrent}`);
            joinBanhaVoiceChannel(voiceCurrent);
            await msg.delete();
          } else {
            await msg.reply("You need to join a voice channel first!");
          }
        } catch (error) {
          console.error("Error in $joinme command:", error);
        }
        break;

      default:
        // TTS handling
        let lang = "ja";
        const langRegex = /<([a-zA-Z-]+)>/;
        const langMatch = command.match(langRegex);

        if (langMatch) {
          lang = langMatch[1];
          message = command.replace(langMatch[0], "").trim();
        } else {
          message = command;
        }

        try {
          const stream = discordTTS.getVoiceStream(message, { lang: lang });
          const resource = createAudioResource(stream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true
          });

          playVoice(resource);

          const logMessage = `${displayName} TTS: ${message}`;
          console.log(logMessage);
          await sendToChannel(IDs.channels.commands, logMessage);
          await msg.delete();
        } catch (error) {
          handleError(error, 'TTS processing');
          await msg.reply("Sorry, there was an error processing your TTS request.");
        }
        break;
    }
  } catch (error) {
    handleError(error, 'messageCreate event');
  }
});

client.on("messageDelete", (msg) => {
  if (!msg.content.startsWith(PREFIX)) {
    const deleted = `${now()}\t **${msg.author.username}:** ${msg.content}`;
    console.log("deleted:", deleted);
    sendToChannel(IDs.channels.del, deleted);
  }
});

client.on("messageUpdate", (oldMsg, newMsg) => {
  if (oldMsg.content === newMsg.content) return;
  const edited = `${now()}\t **${newMsg.author.username}:**\n${oldMsg.content}\n>\n${newMsg.content}`;
  console.log("edited:", edited);
  sendToChannel(IDs.channels.del, edited);
});

client.on("presenceUpdate", (before, after) => {
  if (!after) return;
  const userID = after.userId;
  const user = client.users.cache.get(userID);
  const statusBefore = before?.status || " ";
  const statusAfter = after.status || " ";
  const statusMsg = `${now()}\t**${user.username}:** ${statusBefore} > ${statusAfter}`;
  const currentHour = new Date().getHours();

  if (statusBefore !== statusAfter) {
    console.log(statusMsg);
    sendToChannel(IDs.channels.status, statusMsg);
  }

  // User-specific status updates
  if (userID === IDs.users.Moonscarlet && statusAfter === "online" && statusBefore !== "online") {
    // Example: sendToChannel(IDs.channels.status, `Welcome back <@${IDs.users.Moonscarlet}>`);
  }
  if (userID === IDs.users.LORD && 
      ["online", "idle"].includes(statusAfter) && 
      ["offline", " "].includes(statusBefore) && 
      (currentHour >= 15 || currentHour <= 2)) {
    // Example: sendToChannel(IDs.channels.main, `<@${IDs.users.LORD}> has come online!`);
  }
});

client.on("voiceStateUpdate", (before, after) => {
  if (after.id === client.user.id) return;

  const person = after.member.user.username.toLowerCase();
  const PeopleTTS = {
    "ahmadgalal": "A G",
    "underageuser": "underage user",
    "hesham": "Hishaam",
    "fady_": "faadey",
    "mohamedhammad87": "middohh",
    "basseldesoky": "Supersonic",
    "prollygeek": "TDK",
    "ibrahimsp": "Heema",
    "omda": "om daa",
    "terezee.248": "zeikus",
    "tofa7009": "TOFA",
    "zqp1313": "BLACK PHANTOM",
    "isso1988": "esso",
  };
  const personTTS = PeopleTTS[person] || person;

  let chatMsg = "";

  // User left a voice channel
  if ((before.channelId && !after.channelId) || 
      (before.channelId && after.channelId && before.channelId !== after.channelId)) {
    chatMsg = `${now()} **${person}** left **${client.channels.cache.get(before.channelId).name}**`;
    if (before.channelId === voiceCurrent) {
      const stream = discordTTS.getVoiceStream(`${personTTS} left`, { lang: "ja" });
      const leaveResource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
      playVoice(leaveResource);
    }
    leaveEmptyVoiceChannel();
  }

  // User joined a voice channel
  if ((!before.channelId && after.channelId) || 
      (before.channelId && after.channelId && before.channelId !== after.channelId)) {
    chatMsg = `${now()} **${person}** joined **${client.channels.cache.get(after.channelId).name}**`;

    if (after.channelId === voiceCurrent) {
      if (!connection || shouldJoinVoiceChannel(IDs.voices.tertiary)) {
        joinBanhaVoiceChannel(IDs.voices.tertiary);
      }
      const stream = discordTTS.getVoiceStream(`${personTTS} joined`, { lang: "ja" });
      const joinResource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
      playVoice(joinResource);

      if (person === "prollygeek") {
        const memeFile = "./other/TDKJoin.mp3";
        const memeResource = createAudioResource(memeFile);
        playVoice(memeResource);
      }
    }
  }

  if (chatMsg) {
    console.log(chatMsg);
    sendToChannel(IDs.channels.voice, chatMsg);
  }
});

client.on("guildMemberAdd", (member) => {
  const chatMsg = `${member.user.username} has joined the server.`;
  console.log(chatMsg);
  sendToChannel(IDs.channels.main, chatMsg);
});

client.on("guildMemberRemove", (member) => {
  const chatMsg = `${member.user.username} has left the server.`;
  console.log(chatMsg);
  sendToChannel(IDs.channels.main, chatMsg);
});

// Global error handlers
process.on('uncaughtException', (error) => {
  handleError(error, 'Uncaught Exception');
});

process.on('unhandledRejection', (reason, promise) => {
  handleError(reason, 'Unhandled Rejection');
});

// Login the Bot
client.login(process.env.BOT_TOKEN2);
