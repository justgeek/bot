const { GatewayIntentBits } = require('discord.js');
const Discord = require("discord.js");
const _lodash = require('lodash');
const { isNull } = require('lodash');
const { joinVoiceChannel, createAudioPlayer, createAudioResource } = require('@discordjs/voice');
const fs = require('fs');
const screenshot = require('screenshot-desktop');
const sharp = require('sharp');
const tesseract = require('node-tesseract-ocr');
const monitor = require('active-window');

const client = new Discord.Client({
  intents: [GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences]
});

const bottokenPath = "./bottoken.txt";
const bottoken = fs.readFileSync(bottokenPath, 'utf8')

const IDs = {
  guild: '247069115204763648',//GUILD

  channelMain: '247069115204763648',//main text channel
  channelV: '460899681787052083',//v text channel
  channelDel: '1020388735390601317',//del text channel
  channelEdit: '1021447609983959050',//edit text channel
  channelVoice: '1021812152186720256',//voice text channel
  channelStatus: '1020398542365401128',//status text channel
  channelCommands: '1020315442042122330',//commands text channel

  voice3: '310083935298125825',//3rd voice channel

  Moonscarlet: '234236035846897664',
  LORD: '946751602415521873',
  Mido: '329004546900885515',

}

const memesFolder = './memes/'
const ext = '.m4a';
const memes = {
  '!bruh': "Bruh" + ext,
  '!nooo': "nooo" + ext,
  '!sees': "sees" + ext,
  '!maaa': "Sheep1" + ext,
  '!cry': "Baby Crying" + ext,
  '!letmein': "LET ME IN" + ext,
  '!hamood': "hamood" + ext,
  '!wait': "no no no no wait wait wait" + ext,
  '!lazaza': "lazaza2" + ext,
  '!omgwow': "omgwow" + ext,
  '!ok': "ok" + ext,
  '!nice': "nice" + ext,
  '!kekw': "kekw" + ext,
  '!mad': "mad" + ext,
  '!ablaa': "ablaa" + ext,
  '!anteshwagry': "anteshwagry" + ext,
}

let resource, player, connection;
var currentWindow = 'habal';


client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}!`)

  client.user.setActivity('!commands', { type: "PLAYING" });

  sendToChannel(IDs.channelV, 'Sup!\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t("**!commands**" for stuff)');

  connection = joinVoiceChannel({
    channelId: IDs.voice3,
    guildId: IDs.guild,
    adapterCreator: client.guilds.cache.get(IDs.guild).voiceAdapterCreator
  })
  player = createAudioPlayer();
  connection.subscribe(player);
})


client.on("messageCreate", msg => {
  if (msg.author.username + '#' + msg.author.discriminator == 'Malevolent#0025') return

  // console.log(msg.guild.emojis.cache)//show all emojis
  if (msg.author.username + '#' + msg.author.discriminator == 'exorcismus#7611') {
    // if (msg.author.username + '#' + msg.author.discriminator == 'Moonscarlet#4105') {    
    // msg.react(msg.guild.emojis.cache.get('515873f6898e0b26daf51921c65a43f7'))//BRUH
    // msg.react(':regional_indicator_a:')
    msg.react(msg.guild.emojis.cache.get('1018204796689322014'))//BRUH
  }

  let message = msg.content.toLowerCase();

  if (message === "!commands") {
    // msg.delete();
    const commands = [
      '**COMMANDS:**',
      // '**!round**: Prints the current CHC round number',
      '**!playlist**: Prints YouTube "Our Games" playlist link.',
      '**!random <names (comma separated)>**: shuffle provided players.\nExample: "**!random player1,player2,player3**"',
      '**!randomall**: create random teams of all players in your current voice channel',
      '**!randomall <voice channel members row numbers to exclude (comma separated)>**.\nExample: to exclude 3rd and 5th "**!randomall 3,5**"',
    ]
    const memesKeys = Object.keys(memes).map(e => e.toUpperCase()).join(', ');
    msg.channel.send(commands.join("\n\n") + '\n\n**' + memesKeys + '**');


  }
  else if (message === "!round") {
    //   let currentWindow= awai;
    //   getCurrentWindow();

    //   console.log("currentWindow: ", currentWindow)

    //   if (currentWindow != 'Dota 2') return

    //   const ext = 'png'
    //   const imgPath = './stuff/dota.' + ext
    //   const imgPathCropped = './stuff/dota-cropped.' + ext
    //   const x1 = 0
    //   const y1 = 80
    //   const x2 = 58
    //   const y2 = 208
    //   const w = x2 - x1
    //   const h = y2 - y1

    //   fs.unlink(imgPath, () => { })
    //   fs.unlink(imgPathCropped, () => { })

    //   screenshot({ filename: imgPath, format: ext }).then((img) => {
    //   }).catch((err) => {

    //   })

    //   sleep(2000)

    //   sharp(imgPath)
    //     .extract({ left: x1, top: y1, width: w, height: h })
    //     .toFile(imgPathCropped)
    //     .then(info => { })
    //     .catch(err => { });

    //   const config = {
    //     lang: "eng",
    //     oem: 1,
    //     psm: 3,
    //   }

    //   let result;
    //   tesseract.recognize(imgPathCropped, config).then((text) => {
    //     console.log("Result:", text);
    //     result = text;
    //   })
    //     .catch((error) => {
    //       console.log(error.message);
    //     })

    //   const chatMsg = 'Round: ' + result;
    //   msg.channel.send({ files: [imgPathCropped] });
  }
  else if (message === "!playlist") {
    // msg.delete();
    msg.channel.send("https://www.youtube.com/playlist?list=PLhKVK0lPQ73sDSSxq09yx9QVgyr3MBR6d");
  }
  else if (memes[message]) {//MEMES > if key is found in memes object play its value (file)
    msg.delete();
    resource = createAudioResource(memesFolder + memes[message]);
    player.play(resource);
    const logMessage = msg.member.displayName + ' ' + message //"Playing " + message + ' by ' + msg.member.displayName
    console.log(logMessage);
    // sendToChannel(IDs.channelVoice, logMessage);
    sendToChannel(IDs.channelCommands, logMessage);
  }

  else if (message.startsWith("!random ")) {
    message = message.replace("!random ", "").replaceAll(" ", "");
    console.log("message: %s", message)

    let players = message.split(',')
    console.log("players: %s", players)

    if (players.length == 1) {
      msg.reply(players.shift() + ' can queue alone!');
    } else {
      players = _lodash.shuffle(players)
      console.log("shuffled players: %s", players)

      let teams = `**${players.length} players:**`, teamNumber = 1;

      [1, 2, 3, 4]
      for (let i = 0; i < players.length / 2; i + 2) {
        if (players.length > 1) {
          teams += `\n**Team ${teamNumber}:** ${players.shift()} - ${players.shift()}`
        } else {
          teams += `\n**Team ${teamNumber}:** ${players.shift()}`
        }
        teamNumber++;
      }
      console.log("Teams: %s", teams)
      msg.reply(teams);
    }

    console.log('-----------------------------------------------------------------------')
  }

  else if (message.startsWith("!randomall")) {
    let players = [], currentVoiceChannelName, currentVoiceChannelId, memberFullTag, memberId, memberVoiceChannelName, memberVoiceChannelId;

    if (!isNull(msg.member.voice.channel)) {
      currentVoiceChannelName = msg.member.voice.channel.name;
      currentVoiceChannelId = msg.member.voice.channel.id;
      console.log('Current Voice Channel:' + currentVoiceChannelName)

      //GET ALL MEMBERS OF SERVER
      client.guilds.cache.get(msg.guild.id).members.fetch().then(members => {
        members.forEach(mem => {
          memberNickname = mem.displayName;
          memberFullTag = mem.user.username + '#' + mem.user.discriminator;
          memberId = mem.user.id;

          if (!isNull(mem.voice.channel)) {//if member is in a voice channel
            memberVoiceChannelName = mem.voice.channel.name
            memberVoiceChannelId = mem.voice.channel.id

            console.log(memberNickname + ' ' + memberId + ' ' + memberVoiceChannelName);
            if (memberVoiceChannelId == currentVoiceChannelId && mem.displayName != '!Malevolent') { //if member is in the same voice channel as me
              players.push([memberNickname, `<@${memberId}>`]);//TO TAG IN CHAT `<@${id}>` // users  `<@&${id}>` // roles
            }
          };
        })
        console.log("Players:", players);
        players.sort();
        console.log("Sorted Players:", players);

        //REMOVE UNWANTED IDX HERE
        if (message.startsWith("!randomall ")) {
          let playersTemp = [];
          message = message.replace("!randomall ", "").replaceAll(" ", "");
          console.log("message:", message)

          let excludedIdx = message.split(',');
          excludedIdx.forEach((e, idx, arr) => arr[idx] -= 1);//make it IDX instead of row number
          console.log("excludedIdx:", excludedIdx);
          players.forEach((e, idx) => {//if player idx is in the excluded idx array don't push to finalplayers
            if (excludedIdx.find(e => e == idx) == undefined)
              playersTemp.push(e);
          })
          console.log('playersTemp', playersTemp);
          players = playersTemp;
        }


        if (players.length == 0) {//just one player
          msg.reply('no players no games!');
        } else if (players.length == 1) {//just one player
          msg.reply('lol ' + players.shift()[1] + ' go queue alone KEKW');
        } else {
          players = _lodash.shuffle(players)
          console.log("shuffled players:", players)

          let teams = `**${players.length} players:**`, teamNumber = 1;

          for (let i = 0; i < players.length / 2; i + 2) {
            if (players.length > 1) {
              teams += `\n**Team ${teamNumber}:** ${players.shift()[1]} - ${players.shift()[1]}`
            } else {
              teams += `\n**Team ${teamNumber}:** ${players.shift()[1]}`
            }
            teamNumber++;
          }
          console.log("Teams: ", teams)
          msg.reply(teams);
        }
      })
    } else {
      msg.reply("You're not in a voice channel!");
    }
    console.log('-----------------------------------------------------------------------')
  }

}
)


client.on("messageDelete", msg => {
  const message = msg.content.toLowerCase();
  if (memes[message]) return;

  if (message == "!commands" || message == "!playlist") {
    return
  }
  const deleted = `${now()}\t **${msg.author.username}:** ${msg.content}`;
  console.log("deleted:", deleted)
  sendToChannel(IDs.channelDel, deleted);
})


client.on("messageUpdate", (oldMessage, newMessage) => {

  const edited = `${now()}\t **${newMessage.author.username}:**\n${oldMessage.content}\n>\n${newMessage.content}`;
  console.log("edited:", edited)
  sendToChannel(IDs.channelEdit, edited);
  console.log('-----------------------------------------------------------------------')

})


client.on("presenceUpdate", (before, after) => {
  // console.log("before: %s", before)
  // console.log("after: %s", after)

  // if (!before || !after) return

  const userID = after.userId
  const user = client.users.cache.get(userID)
  const userTag = user.username + '#' + user.discriminator

  const statusBefore = !before ? ' ' : before.status;
  const statusAfter = !after ? ' ' : after.status;


  const msg = now() + '\t**' + userTag + ':\t**' + statusBefore + '\t>\t' + statusAfter

  const currentHour = new Date().getHours();

  if (statusBefore != statusAfter) {
    console.log(msg);
    sendToChannel(IDs.channelStatus, msg);
  }

  if (userID == IDs.Moonscarlet && (statusBefore == 'offline' || statusBefore == '') && statusAfter == 'online') {
    // sendToChannel(IDs.channelStatus, 'E2FESH <@' + IDs.Moonscarlet + '> CHC ¿¿¿? xdDDD¡¡¡');
    // sendToChannel(IDs.channelStatus, 'Welcome back <@' + IDs.Moonscarlet + '>');
  }
  else if (userID == IDs.LORD && (currentHour >= 18 || currentHour <= 2) && (statusBefore == 'offline' || statusBefore == ' ') && statusAfter == 'online') {
    // sendToChannel(IDs.channelMain, 'E2FESH <@' + IDs.LORD + '> CHC ¿¿¿? xdDDD¡!¡!¡');
    const chatMsg = '<@' + IDs.LORD + '> \n1-7etta fel tricks?\nOR\n2-7etta fel trade?'
    sendToChannel(IDs.channelMain, chatMsg);
  }
  console.log('-----------------------------------------------------------------------')
})


// client.on('voiceStateUpdate', (before, after) => {

//   after= _lodash.get(after,'member.voice.channel.name',-1)
//   console.log("after: %s", after)
//   if (after!= -1) {
//   if (after == before.member.voice.channel.name) return
//   const chatMsg = after.member.displayName + ' has joined ' + after.member.voice.channel.name;
//   console.log(chatMsg);
// sendToChannel(IDs.channelVoice, chatMsg)
//   }
// })











client.login(bottoken);



function sendToChannel(id, msg) {
  client.channels.fetch(id)
    .then(channel => {
      channel.send(msg);
    })
}

function now() {
  let today = new Date();
  let now = (today.getDate() < 10 ? '0' : '') + today.getDate() + '/' + (today.getMonth() < 10 ? '0' : '') + (today.getMonth() + 1) + '/' + today.getFullYear() + ' '
    + (today.getHours() < 10 ? '0' : '') + today.getHours() + ':' + (today.getMinutes() < 10 ? '0' : '') + today.getMinutes() + ':' + (today.getSeconds() < 10 ? '0' : '') + today.getSeconds()
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