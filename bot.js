const Discord = require("discord.js");
const _lodash = require("lodash");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayer, StreamType, entersState, VoiceConnectionStatus,
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

const bottokenPath = "./bottoken.txt";
const bottoken = fs.readFileSync(bottokenPath, "utf8");

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
};


const memesFolder = "./memes/";
const memeFiles = fs.readdirSync(memesFolder)

const memeFilesSorted = []
memeFiles.forEach(m => {
    let modDate = fs.statSync(memesFolder + m).mtimeMs
    memeFilesSorted.push(modDate + "|" + m)
})
memeFilesSorted.sort()

let memes={};
// let memesList = []
memeFilesSorted.forEach(m => {
    memes['!' + m.toLowerCase().replace(/.[^.]*$/g, '').replace(/\d.+[|]/g, '')] = m.replace(/\d.+[|]/g, ''); 
    // memesList.push(m.toLowerCase().replace(/.[^.]*$/g, '').replace(/\d.+[|]/g, ''));
})

// console.log("memesList: %s", memesList)


// memes = {
//   "!bruh": "Bruh",
//   "!nooo": "nooo",
//   "!sees": "sees",
//   "!maaa": "Sheep1",
//   "!cry": "Baby Crying",
//   "!letmein": "LET ME IN",
//   "!hamood": "hamood",
//   "!wait": "no no no no wait wait wait",
//   "!lazaza": "lazaza2",
//   "!omgwow": "omgwow",
//   "!ok": "ok",
//   "!nice": "nice",
//   "!kekw": "kekw",
//   "!mad": "mad",
//   "!ablaa": "ablaa",
//   "!antesh": "anteshwagry",
//   "!bom": "bom",
//   "!acatch": "acatch",
//   "!a3asal": "a3asal",
//   "!pyre": "pyre",
//   "!hello": "hello",
//   "!mido": "mido",
//   "!nasarny": "nasarny",
//   "!qowa": "qowa",
//   "!brb": "brb",
//   "!adab": "adab",
//   "!ashaf": "ashaf",
//   "!shan2ollak": "SHAN2OLLAK",
//   "!borra7a": "borra7a",
//   "!cringe": "cringe",
//   "!sheraton": "sheraton",
//   "!5odlak": "5odlak",
//   "!mayenfa3sh": "mayenfa3sh",
//   "!ma3lesh": "ma3lesh",
//   "!unacceptable": "unacceptable",
//   "!o2mor": "o2mor",
//   "!sennakkam": "sennakkam",
//   "!7omar": "7omar",
//   "!welcome": "welcome",
//   "!malaksh3aza": "malaksh3aza",
//   "!bravo": "bravo",
//   "!cheer": "cheer",
//   "!hru": "hru",
//   "!t3ebt": "t3ebt",
//   "!elwad": "elwad",
//   "!aheh": "aheh",
//   "!kim": "kim",
//   "!tayyeb": "tayyeb",
//   "!5od": "5od",
//   "!bash": "bash",
//   "!ah": "ah",
//   "!howa": "howa",
//   "!seya7": "seya7",
//   "!relax": "relax",
//   "!ezay": "ezay",
//   "!ezay2": "ezay2",
//   "!salamtak": "salamtak",
//   "!kazeefa": "kazeefa",
//   "!yes": "yes",
//   "!maaa2": "maaa2",
//   "!3ar": "3ar",
//   "!kambyotar": "kambyotar",
//   "!uhuh": "uhuh",
//   "!dang": "dang",
//   "!za2loot": "za2loot",
// };

const gamesList = [
  "Turbo",
  "Custom Hero Clash (CHC)",
  "Overwatch",
  "Overthrow 3",
  "Knight Squad 2",
  "Left 4 Dead 2",
  "Legion TD",
  "Ability Draft",
  "Stumble Guys",
  "Cyberpunk 2077",
  "Ability Arena",
  "World of Warcraft",
]

let resource, player, connection;
var currentWindow = "habal";

client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}!`);
  // console.log("client.user:", client.user)


  // client.user.setPresence('invisible');

  sendToChannel(
    IDs.channelV,
    'Sup!\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t("**!commands**" for stuff)'
  );

  connection = joinVoiceChannel({
    channelId: IDs.voice3,
    guildId: IDs.guild,
    adapterCreator: client.guilds.cache.get(IDs.guild).voiceAdapterCreator,
  });
  player = createAudioPlayer();
  connection.subscribe(player);
});

client.on("messageCreate", (msg) => {
  let message = msg.content.toLowerCase();
  if (msg.author.username + "#" + msg.author.discriminator == "Malevolent#0025") return;

  // console.log(msg.guild.emojis.cache)//show all emojis
  if (msg.author.username + "#" + msg.author.discriminator == "exorcismus#7611" && !message.startsWith("!")) {
    // if (msg.author.username + '#' + msg.author.discriminator == 'Moonscarlet#4105') {
    // msg.react(msg.guild.emojis.cache.get('515873f6898e0b26daf51921c65a43f7'))//BRUH
    // msg.react(':regional_indicator_a:')
    msg.react(msg.guild.emojis.cache.get("1018204796689322014")); //BRUH
  }

  if (message === "!commands") {
    // msg.delete();
    const commands = [
      // '**!round**: Prints the current CHC round number',
      '**!youtube** or **!playlist**: print YouTube "Our Games" playlist link.',
      '**!games**: list possible games to play.',
      '**!randomgame**: choose a random game to play.',
      '**!random <names (comma separated)>**: shuffle provided players("**!random player1,player2,player3**").',
      "**!randomall**: create random teams of all players in your current voice channel.",
      '**!randomall <voice channel members row numbers to exclude (comma separated)>** (to exclude 3rd and 5th "**!randomall 3,5**").',
      '**!<anything>**: Text-To-Speech.',
      '**!memes**: list memes.',
    ];

    msg.channel.send("> **COMMANDS:**\n> " + commands.join("\n> "));
  } else if (message === "!games") {
    const games = '> **' + gamesList.sort().join("**\n> **") + '**';
    msg.reply(games);
  } else if (message === "!randomgame") {
    const randomGame = '> **' + gamesList[Math.floor(Math.random() * gamesList.length)] + '**';
    msg.reply(randomGame);
  } else if (message === "!memes") {
    const memesKeys = '> **' + Object.keys(memes).map((e) => e.toUpperCase()).join(", ") + '**';
    
    msg.reply(memesKeys);
  } else if (message == "!playlist" || message == "!youtube") {
    // msg.delete();
    msg.channel.send(
      "https://www.youtube.com/playlist?list=PLhKVK0lPQ73sDSSxq09yx9QVgyr3MBR6d"
    );
  } else if (memes[message]) {
    //MEMES > if key is found in memes object play its value (file)
    const memeFile = memesFolder + memes[message];
    resource = createAudioResource(memeFile);

    player.play(resource);
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

    console.log(
      "-----------------------------------------------------------------------"
    );
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

              console.log(
                memberNickname + " " + memberId + " " + memberVoiceChannelName
              );
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
              if (excludedIdx.find((e) => e == idx) == undefined)
                playersTemp.push(e);
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
                teams += `\n> **Team ${teamNumber}:** ${players.shift()[1]} - ${players.shift()[1]
                  }`;
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
    console.log(
      "-----------------------------------------------------------------------"
    );
  } else if (message.startsWith("!")) {
    message = message.replace("!", "")//.replaceAll(" ", "");
    const stream = discordTTS.getVoiceStream(message);
    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
    player.play(resource);
    const logMessage = msg.member.displayName + " " + message; //"Playing " + message + ' by ' + msg.member.displayName
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
  if (oldMessage == oldMessage) return;
  const edited = `${now()}\t **${newMessage.author.username}:**\n${oldMessage.content
    }\n>\n${newMessage.content}`;
  console.log("edited:", edited);
  sendToChannel(IDs.channelEdit, edited);
  console.log(
    "-----------------------------------------------------------------------"
  );
});


client.on("presenceUpdate", (before, after) => {
  // console.log("before: %s", before)
  // console.log("after: %s", after)

  // if (!before || !after) return

  const userID = after.userId;
  const user = client.users.cache.get(userID);
  const userTag = user.username + "#" + user.discriminator;

  const statusBefore = !before ? " " : before.status;
  const statusAfter = !after ? " " : after.status;

  const msg =
    now() + "\t**" + userTag + ":\t**" + statusBefore + "\t>\t" + statusAfter;

  const currentHour = new Date().getHours();

  if (statusBefore != statusAfter) {
    console.log(msg);
    sendToChannel(IDs.channelStatus, msg);
  }

  if (
    userID == IDs.Moonscarlet &&
    (statusBefore == "offline" || statusBefore == "") &&
    statusAfter == "online"
  ) {
    // sendToChannel(IDs.channelStatus, 'E2FESH <@' + IDs.Moonscarlet + '> CHC ¿¿¿? xdDDD¡¡¡');
    // sendToChannel(IDs.channelStatus, 'Welcome back <@' + IDs.Moonscarlet + '>');
  } else if (
    userID == IDs.LORD &&
    (currentHour >= 18 || currentHour <= 2) &&
    (statusBefore == "offline" || statusBefore == " ") &&
    statusAfter == "online"
  ) {
    // sendToChannel(IDs.channelMain, 'E2FESH <@' + IDs.LORD + '> CHC ¿¿¿? xdDDD¡!¡!¡');
    const chatMsg =
      "<@" + IDs.LORD + "> \n1-7etta fel tricks?\nOR\n2-7etta fel trade?";
    sendToChannel(IDs.channelMain, chatMsg);
  }
  // console.log("-----------------------------------------------------------------------");
});


client.on('voiceStateUpdate', (before, after) => {
  // console.log("-----------------------------------------------------------------------");
  // console.log("before: %s", before)
  // console.log("after: %s", after)

  // after.guild.channels.cache.some(channel => {
  //   if (channel.type === 'voice' && channel.members.has(client.user.id)) {
  //     const botVoiceChannel = after.channel.name
  //     console.log("botVoiceChannel: %s", botVoiceChannel) 
  //   }
  // });

  // console.log("botVoiceChannel: %s", botVoiceChannel)

  if (after.id == client.user.id) return//if bot return
  let chatMsg = ' ';

  const person = after.member.user.username + "#" + after.member.user.discriminator
  let personTTS;
  if (after.member.displayName == 'AG') {
    personTTS = 'A G';
  } else if (after.member.displayName == 'underageuser') {
    personTTS = 'underage user';
  }
  else if (after.member.displayName == 'Hesham') {
    personTTS = 'Hishaam';
  } 
  else if (after.member.displayName == 'Exorcismus') {
    personTTS = 'faadey';
  }   
  else if (after.member.displayName == 'Mido') {
    personTTS = 'Meedo';
  } 
  else if (after.member.displayName == 'Bassel Desoky') {
    personTTS = 'Supersonic';
  } 
  else if (after.member.displayName == 'prollygeek') {
    personTTS = 'TDK';
  } 
  else if (after.member.displayName == 'Ibrahim Taher') {
    personTTS = 'Heema';
  } 

  else {
    personTTS = after.member.displayName
  }

  if (before.channelId && !after.channelId || ((before.channelId && after.channelId) && before.channelId != after.channelId)) { //no after = left
    chatMsg = now() + ' **' + person + '** left **' + client.channels.cache.get(before.channelId).name + '**';

    if (before.channelId == IDs.voice3) {
      const stream = discordTTS.getVoiceStream(personTTS + ' left');
      const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
      player.play(resource);
    }
  }

  if ((!before.channelId && after.channelId) || ((before.channelId && after.channelId) && before.channelId != after.channelId)) {//no before or there is before and after that are not the same
    chatMsg = now() + ' **' + person + '** joined **' + client.channels.cache.get(after.channelId).name + '**'; //= joined

    if (after.channelId == IDs.voice3) {
      const stream = discordTTS.getVoiceStream(personTTS + ' joined');
      const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
      player.play(resource);
    }
  }

  if (chatMsg != ' ') {
    console.log(chatMsg);
    sendToChannel(IDs.channelVoice, chatMsg)
  }
})


client.on('guildMemberAdd', member => {
  const chatMsg = member.user.username + "#" + member.user.discriminator + ' (' + member.displayName + ') has joined the server.'
  console.log(chatMsg)
  sendToChannel(IDs.channelMain, chatMsg)
})


client.on('guildMemberRemove', member => {
  const chatMsg = member.user.username + "#" + member.user.discriminator + ' (' + member.displayName + ') has left the server.'
  console.log(chatMsg)
  sendToChannel(IDs.channelMain, chatMsg)
})

client.login(bottoken);

function sendToChannel(id, msg) {
  client.channels.fetch(id).then((channel) => {
    channel.send(msg);
  });
}
function now() {
  let today = new Date();
  let now =
    (today.getDate() < 10 ? "0" : "") +
    today.getDate() +
    "/" +
    (today.getMonth() < 9 ? "0" : "") +
    (today.getMonth() + 1) +
    "/" +
    today.getFullYear() +
    " " +
    (today.getHours() < 10 ? "0" : "") +
    today.getHours() +
    ":" +
    (today.getMinutes() < 10 ? "0" : "") +
    today.getMinutes() +
    ":" +
    (today.getSeconds() < 10 ? "0" : "") +
    today.getSeconds();
  return now;
}
function sleep(ms) {
  const waitTill = new Date(new Date().getTime() + ms);
  while (waitTill > new Date()) { }
}
function getCurrentWindow() {
  const myPromise = new Promise();
  monitor.getActiveWindow((window) => {
    try {
      // console.log("App: " + window.app);
      console.log("Title: " + window.title);
      currentWindow = window.title;
      myPromise.resolve(window.title);
    } catch (err) {
      console.log(err);
    }
  });
  return myPromise;
}
