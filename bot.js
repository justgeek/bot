require('dotenv').config();
const Discord = require("discord.js");
//require('discord-reply');

const _lodash = require("lodash");
const ffmpeg = require("ffmpeg");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayer,
  StreamType,
  entersState,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const fs = require("fs");
const discordTTS = require("discord-tts");
const screenshot = require("screenshot-desktop");
const sharp = require("sharp");
const tesseract = require("node-tesseract-ocr");
const monitor = require("active-window");

const client = new Discord.Client({
  intents: [
    Discord.GatewayIntentBits.Guilds,
    Discord.GatewayIntentBits.GuildMessages,
    Discord.GatewayIntentBits.MessageContent,
    Discord.GatewayIntentBits.GuildVoiceStates,
    Discord.GatewayIntentBits.GuildMembers,
    Discord.GatewayIntentBits.GuildPresences,
    Discord.GatewayIntentBits.GuildInvites,
  ],
});

const IDs = {
  guild: "247069115204763648", //GUILD

  channelMain: "247069115204763648", //main text channel
  channelV: "460899681787052083", //v text channel
  channelDel: "1020388735390601317", //del text channel
  channelEdit: "1021447609983959050", //edit text channel
  channelVoice: "1021812152186720256", //voice text channel
  channelStatus: "1020398542365401128", //status text channel
  channelCommands: "1020315442042122330", //commands text channel

  voice1: "247069115204763649", //1st voice channel
  voice2: "248868783534505984", //2nd voice channel
  voice3: "310083935298125825", //3rd voice channel
  voiceAFK: "310083935298125825", //AFK voice channel

  Moonscarlet: "234236035846897664",
  LORD: "946751602415521873",
  Mido: "329004546900885515",
  TDK: "223957971976192001",
};
let voiceCurrent = IDs.voice3;

const otherFolder = "./other/";
const memesFolder = "./memes/";
const memeFiles = fs.readdirSync(memesFolder);

const memeFilesSorted = [];
memeFiles.forEach((m) => {
  let modDate = fs.statSync(memesFolder + m).mtimeMs;
  memeFilesSorted.push(modDate + "|" + m);
});
memeFilesSorted.sort();

let memes = {};
memeFilesSorted.forEach((m) => {
  memes[
    "!" +
    m
      .toLowerCase()
      .replace(/.[^.]*$/g, "")
      .replace(/\d.+[|]/g, "")
  ] = m.replace(/\d.+[|]/g, "");
});

const gamesList = [
  "Turbo",
  "Custom Hero Clash (CHC)",
  // "Overwatch",
  // "Overthrow 3",
  "Knight Squad 2",
  "Left 4 Dead 2",
  "Legion TD",
  "Ability Draft",
  // "Stumble Guys",
  "Cyberpunk 2077",
  "Ability Arena",
  "World of Warcraft",
  "Dead By Daylight",
  "Midnight Ghost Hunt",
  "Dota Arcade",
];

let resource, player, connection, connectionSubscription;

const joinBanhaVoiceChannel = (channelToJoin) => {
  if (shouldJoinVoiceChannel(channelToJoin)) {
    connection = joinVoiceChannel({
      channelId: channelToJoin,
      guildId: IDs.guild,
      adapterCreator: client.guilds.cache.get(IDs.guild).voiceAdapterCreator,
    });
    console.log(`Bot joined voice channel: ${channelToJoin}`);
    return connection;
  } else {
    console.log(`Not joining voice channel ${channelToJoin} as it's empty or only contains bots.`);
    return null;
  }
};

client.on("error", (e) => {
  console.error("ERR NOT HANDLED:", e);
});

client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}!`);
  client.user.setStatus('invisible');
  sendToChannel(IDs.channelV, 'Sup!\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t("**!commands**" for stuff)');

  if (shouldJoinVoiceChannel(IDs.voice3)) {
    joinBanhaVoiceChannel(IDs.voice3);
    player = createAudioPlayer();
    connectionSubscription = connection.subscribe(player);
  }
});

client.on("messageCreate", (msg) => {
  let message = msg.content.toLowerCase();
  if (msg.author.username + "#" + msg.author.discriminator == "Malevolent#0025") return;

  const displayName = getAuthorDisplayName(msg);
  const idtest = '329004546900885515'
  console.log(msg.author.username);



  // console.log(msg.guild.emojis.cache)//show all emojis


  if (msg.author.username + "#" + msg.author.discriminator == "exorcismus#7611" && !message.startsWith("!")) {
    // if (msg.author.username + '#' + msg.author.discriminator == 'Moonscarlet#4105') {
    // msg.react(msg.guild.emojis.cache.get('515873f6898e0b26daf51921c65a43f7'))//BRUH
    // msg.react(':regional_indicator_a:')
    // msg.react(msg.guild.emojis.cache.get("1018204796689322014")); //BRUH
  }

  // if (msg.author.username + "#" + msg.author.discriminator == "Ibrahim Taher#7708" && !message.startsWith("!")) {
    if (msg.author.username + '#' + msg.author.discriminator == 'Moonscarlet#4105') {
    // msg.react(msg.guild.emojis.cache.get('515873f6898e0b26daf51921c65a43f7'))//BRUH
    // msg.react(':regional_indicator_a:')
    msg.react('🤷‍♂️');
    msg.react('🤷‍♀️');
  }

  if (message === "!commands") {
    // msg.delete();
    const commands = [
      // '**!round**: Prints the current CHC round number',
      '**!youtube** or **!playlist**: print YouTube "Our Games" playlist link.',
      // "**!games**: list possible games to play.",
      // "**!randomgame**: choose a random game to play.",
      '**!random <names (comma separated)>**: shuffle provided players("**!random player1,player2,player3**").',
      "**!randomall**: create random teams of all players in your current voice channel.",
      '**!randomall <voice channel members row numbers to exclude (comma separated)>** (to exclude 3rd and 5th "**!randomall 3,5**").',
      "**!<anything>**: Text-To-Speech.",
      "**!memes**: list memes.",
      "**!joinme**: Join your current voice channel.",
    ];

    msg.channel.send("> **COMMANDS:**\n> " + commands.join("\n> "));
    // } else if (message === "!games") {
    //   const games = "> **" + gamesList.sort().join("**\n> **") + "**";
    //   msg.reply(games);
    // } else if (message === "!randomgame") {
    //   const randomGame = "> **" + gamesList[Math.floor(Math.random() * gamesList.length)] + "**";
    //   msg.reply(randomGame);
  } else if (message === "!memes") {
    const memesKeys =
      "> **" +
      Object.keys(memes)
        .map((e) => e.toUpperCase())
        .join(", ") +
      "**";

    msg.reply(memesKeys);
    //msg.lineReply(memesKeys);
  } else if (message == "!playlist" || message == "!youtube") {
    // msg.delete();
    msg.channel.send("https://www.youtube.com/playlist?list=PLhKVK0lPQ73sDSSxq09yx9QVgyr3MBR6d");
  } else if (memes[message]) {
    //MEMES > if key is found in memes object play its value (file)
    const memeFile = memesFolder + memes[message];
    resource = createAudioResource(memeFile);

    playVoice(resource);
    const logMessage = msg.member.displayName + " " + message; //"Playing " + message + ' by ' + msg.member.displayName
    console.log(logMessage);
    sendToChannel(IDs.channelCommands, logMessage);
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

      let teams = `> **${players.length} players:**`,
        teamNumber = 1;

      [1, 2, 3, 4];
      for (let i = 0; i < players.length / 2; i + 2) {
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
    let players = [],
      currentVoiceChannelName,
      currentVoiceChannelId,
      memberFullTag,
      memberId,
      memberVoiceChannelName,
      memberVoiceChannelId;

    if (!_lodash.isNull(msg.member.voice.channel)) {
      currentVoiceChannelName = msg.member.voice.channel.name;
      currentVoiceChannelId = msg.member.voice.channel.id;
      console.log("Current Voice Channel:" + currentVoiceChannelName);

      //GET ALL MEMBERS OF SERVER
      client.guilds.cache
        .get(msg.guild.id)
        .members.fetch()
        .then((members) => {
          members.forEach((mem) => {
            memberNickname = mem.displayName;
            memberFullTag = mem.user.username + "#" + mem.user.discriminator;
            memberId = mem.user.id;

            if (!_lodash.isNull(mem.voice.channel)) {
              //if member is in a voice channel
              memberVoiceChannelName = mem.voice.channel.name;
              memberVoiceChannelId = mem.voice.channel.id;

              console.log(memberNickname + " " + memberId + " " + memberVoiceChannelName);
              if (
                memberVoiceChannelId == currentVoiceChannelId &&
                // mem.displayName != "!Malevolent"
                mem.user.tag != client.user.tag
              ) {
                //if member is in the same voice channel as me
                players.push([memberNickname, `<@${memberId}>`]); //TO TAG IN CHAT `<@${id}>` // users  `<@&${id}>` // roles
              }
            }
          });
          console.log("Players:", players);
          players.sort();
          console.log("Sorted Players:", players);

          //REMOVE UNWANTED IDX HERE
          if (message.startsWith("!randomall ")) {
            let playersTemp = [];
            message = message.replace("!randomall ", "").replaceAll(" ", "");
            console.log("message:", message);

            let excludedIdx = message.split(",");
            excludedIdx.forEach((e, idx, arr) => (arr[idx] -= 1)); //make it IDX instead of row number
            console.log("excludedIdx:", excludedIdx);
            players.forEach((e, idx) => {
              //if player idx is in the excluded idx array don't push to finalplayers
              if (excludedIdx.find((e) => e == idx) == undefined) playersTemp.push(e);
            });
            console.log("playersTemp", playersTemp);
            players = playersTemp;
          }

          if (players.length == 0) {
            //just one player
            msg.reply("no players no games!");
          } else if (players.length == 1) {
            //just one player
            msg.reply("lol " + players.shift()[1] + " go queue alone KEKW");
          } else {
            players = _lodash.shuffle(players);
            console.log("shuffled players:", players);

            let teams = `> **${players.length} players:**`,
              teamNumber = 1;

            for (let i = 0; i < players.length / 2; i + 2) {
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
      voiceCurrent = msg.member.voice.channel.id; // Get the voice channel of the user
      if (voiceCurrent) {
        console.log("voiceCurrent: %s", voiceCurrent)

        joinBanhaVoiceChannel(voiceCurrent);
        player = createAudioPlayer();
        connectionSubscription = connection.subscribe(player);
        msg.delete();
      }
    } catch {
    }
  }
   else if (message.startsWith("!")) {
    // Let's create a queue here
    message = message.replace("!", "").trim();

    // Set default language to "ja"
    let lang = "ja";

    // Regular expression to match a language code enclosed in angle brackets
    const langRegex = /<([a-zA-Z-]+)>/;

    // Check if the message contains a language code
    const langMatch = message.match(langRegex);

    if (langMatch) {
      // Extract the language code
      lang = langMatch[1];

      // Remove the language code from the message
      message = message.replace(langMatch[0], "").trim();
  }

  // Get the voice stream with the specified language
  const stream = discordTTS.getVoiceStream(message, { lang: lang });

  const resource = createAudioResource(stream, {
    inputType: StreamType.Arbitrary,
    inlineVolume: true
  });

  playVoice(resource);

  const logMessage = `${msg.member.displayName} ${message}`;
  console.log(logMessage);
  sendToChannel(IDs.channelCommands, logMessage);
  msg.delete();
  }

});

client.on("messageDelete", (msg) => {
  const message = msg.content.toLowerCase();
  if (message.startsWith("!")) return;

  if (message == "!commands" || message == "!playlist") {
    return;
  }
  const deleted = `${now()}\t **${msg.author.username}:** ${msg.content}`;
  console.log("deleted:", deleted);
  sendToChannel(IDs.channelDel, deleted);
});


client.on("messageUpdate", (oldMessage, newMessage) => {
  if (oldMessage == newMessage) return;
  const edited = `${now()}\t **${newMessage.author.username}:**\n${oldMessage.content}\n>\n${newMessage.content}`;
  console.log("edited:", edited);
  sendToChannel(IDs.channelDel, edited);
  console.log("-----------------------------------------------------------------------");
});


client.on("presenceUpdate", (before, after) => {
  // console.log("before: %s", before)
  // console.log("after: %s", after)

  // if (!before || !after) return

  const userID = after.userId;
  const user = client.users.cache.get(userID);

  const statusBefore = !before ? " " : before.status;
  const statusAfter = !after ? " " : after.status;

  const msg = now() + "\t**" + user.username + ":\t**" + statusBefore + "\t>\t" + statusAfter;

  const currentHour = new Date().getHours();

  if (statusBefore != statusAfter) {
    console.log(msg);
    sendToChannel(IDs.channelStatus, msg);
  }

  if (userID == IDs.Moonscarlet && (statusBefore == "offline" || statusBefore == "") && statusAfter == "online") {
    // sendToChannel(IDs.channelStatus, 'E2FESH <@' + IDs.Moonscarlet + '> CHC ¿¿¿? xdDDD¡¡¡');
    // sendToChannel(IDs.channelStatus, 'Welcome back <@' + IDs.Moonscarlet + '>');
    // sendToChannel(IDs.channelStatus, '<@' + IDs.Moonscarlet + '> RIP in pieces Lady Demashkash 🦇');
  } else if (
    userID == IDs.LORD &&
    (currentHour >= 15 || currentHour <= 2) &&
    (statusBefore == "offline" || statusBefore == " ") &&
    (statusAfter == "online" || statusAfter == "idle")
  ) {
    // sendToChannel(IDs.channelMain, 'E2FESH <@' + IDs.LORD + '> CHC ¿¿¿? xdDDD¡!¡!¡');
    // const chatMsg ="<@" + IDs.LORD + "> \n1-7etta fel tricks?\nOR\n2-7etta fel trade?";
    // const chatMsg = "<@" + IDs.LORD + "> 🦇🧛‍♀️🦇 RIP IN PIECES LADY DEMETGHASHKAR 🦇🧛‍♀️🦇";
    // const chatMsg = "<@" + IDs.LORD + "> Lady Dimitrescu in the village is waiting for you (approximately 290 centimeters tall in her heels and fabulous hat)";
    //sendToChannel(IDs.channelMain, chatMsg);
  }
  // console.log("-----------------------------------------------------------------------");
});


client.on("voiceStateUpdate", (before, after) => {
  if (after.id == client.user.id) return; //if bot return
  let chatMsg = " ";

  const person = after.member.user.username;
  const PeopleTTS = {
    "ahmadgalal": "A G",
    "underageuser": "underage user",
    "hesham": "Hishaam",
    "fady_": "faadey",
    "mohamedhammad87": "middohh",
    "basseldesoky": "Supersonic",
    "prollygeek": "TDK",
    "ibrahimsp": "Heema",
    "OMDA": "om daa",
    "terezee.248": "zeikus",
    "tofa7009": "TOFA",
    "zqp1313": "BLACK PHANTOM",
    "isso1988": "esso",
    "3la27229": "aalaaa",
  }
  let personTTS = PeopleTTS[person] ? PeopleTTS[person] : person;

  if ((before.channelId && !after.channelId) || (before.channelId && after.channelId && before.channelId != after.channelId)) {
    //no after = left
    chatMsg = now() + " **" + person + "** left **" + client.channels.cache.get(before.channelId).name + "**";

    if (before.channelId == voiceCurrent) {
      const stream = discordTTS.getVoiceStream(personTTS + " left", { lang: "ja" });
      const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
      playVoice(resource);
    }
    leaveEmptyVoiceChannel();
  }

  if ((!before.channelId && after.channelId) || (before.channelId && after.channelId && before.channelId != after.channelId)) {
    //no before or there is before and after that are not the same
    chatMsg = now() + " **" + person + "** joined **" + client.channels.cache.get(after.channelId).name + "**"; //= joined

    if (after.channelId == voiceCurrent) {

      // Join the channel if the bot isn't already in it
      if (!connection || shouldJoinVoiceChannel(IDs.voice3)) {
        joinBanhaVoiceChannel(IDs.voice3);
        player = createAudioPlayer();
        connectionSubscription = connection.subscribe(player);
      }

      const stream = discordTTS.getVoiceStream(personTTS + " joined", { lang: "ja" });
      const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
      playVoice(resource);


      if (person == "prollygeek") {
        const memeFile = otherFolder + "TDKJoin.mp3";
        let resource2 = createAudioResource(memeFile);
        playVoice(resource2);
      }
      //  else if (person == "ibrahimsp") {
      //   const memeFile = memesFolder + "cough.m4a";
      //   let resource2 = createAudioResource(memeFile);
      //   playVoice(resource2);
      // }

    }
  }

  if (chatMsg != " ") {
    console.log(chatMsg);
    sendToChannel(IDs.channelVoice, chatMsg);
  }
});

client.on("guildMemberAdd", (member) => {
  // const chatMsg = member.user.username + "#" + member.user.discriminator + " (" + member.displayName + ") has joined the server.";
  const chatMsg = member.user.username + " has joined the server.";
  console.log(chatMsg);
  sendToChannel(IDs.channelMain, chatMsg);
});

client.on("guildMemberRemove", (member) => {
  // const chatMsg = member.user.username + "#" + member.user.discriminator + " (" + member.displayName + ") has left the server.";
  const chatMsg = member.user.username + " has left the server.";
  console.log(chatMsg);
  sendToChannel(IDs.channelMain, chatMsg);
});

function sendToChannel(id, msg) {
  client.channels.fetch(id).then((channel) => {
    channel.send(msg);
  });
}
function now() {
  let today = new Date();
  let utcHours = today.getUTCHours() + 2;
  let hours = utcHours % 12 === 0 ? 12 : utcHours % 12;
  let ampm = utcHours >= 12 ? "PM" : "AM";

  let now =
    (today.getUTCDate() < 10 ? "0" : "") +
    today.getUTCDate() +
    "/" +
    (today.getUTCMonth() < 9 ? "0" : "") +
    (today.getUTCMonth() + 1) +
    "/" +
    today.getUTCFullYear() +
    " " +
    (hours < 10 ? "0" : "") +
    hours +
    ":" +
    (today.getUTCMinutes() < 10 ? "0" : "") +
    today.getUTCMinutes() +
    ":" +
    (today.getUTCSeconds() < 10 ? "0" : "") +
    today.getUTCSeconds() +
    " " +
    ampm;
  return now;
}

const getAuthorDisplayName = (msg) => {
  if (msg.guild) {
    const member = msg.guild.members.cache.get(msg.author.id);
    return member ? (member.nickname || msg.author.username) : msg.author.username;
  } else {
    return msg.author.username;
  }
}

function sleep(ms) {
  const waitTill = new Date(new Date().getTime() + ms);
  while (waitTill > new Date()) { }
}

client.login(process.env.BOT_TOKEN);
// client.login(process.env.BOT_TOKEN2);

const playVoice = (resource) => {
  player.play(resource);
};


function shouldJoinVoiceChannel(channelId) {
  const channel = client.channels.cache.get(channelId);
  if (channel) {
    const totalMembers = channel.members.size;
    const botMember = channel.members.get(client.user.id);

    // Return true if there are members and it's not just the bot
    return totalMembers > 0 && !(totalMembers === 1 && botMember);
  }
  return false;
}

function leaveEmptyVoiceChannel() {
  if (!connection) return

  const channel = client.channels.cache.get(IDs.voice3);
  const totalMembers = channel.members.size;

  if (totalMembers === 1) {
    connection.destroy();
    connection = null;
    player = null;
    connectionSubscription = null;
    console.log("Bot left the voice channel as it was the only user.");
  }
}

const express = require("express");
const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("BANHA FOREVER !!!!! BOT IS RUNNING OK");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
