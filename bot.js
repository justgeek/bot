require('dotenv').config();
const Discord = require("discord.js");
//require('discord-reply');
const axios = require('axios');

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
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Groq = require("groq-sdk");
const { getRelevantEmojis, isValidDiscordEmoji } = require('./ai.js');
// const { textToSpeech } = require('./tts.js');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

  try {
      const response = await axios({
          method: 'post',
          url: url,
          headers: {
              'Accept': 'audio/mpeg',
              'xi-api-key': apiKey,
              'Content-Type': 'application/json',
          },
          data: {
              text: text,
              model_id: 'eleven_flash_v2_5'
          },
          responseType: 'arraybuffer'
      });

      // Save the audio file
      const outputPath = 'output.mp3';
      fs.writeFileSync(outputPath, response.data);
      console.log(`Audio saved to ${outputPath}`);
      
      return outputPath;
  } catch (error) {
      console.error('Error:', error.response?.data || error.message);
      throw error;
  }
}

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
  ZEKUS: "644899011236724787",

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

client.on("messageCreate", async (msg) => {
  let message = msg.content.toLowerCase();
  if (msg.author.username + "#" + msg.author.discriminator == "Malevolent#0025") return;

  const displayName = getAuthorDisplayName(msg);
  const idtest = '329004546900885515'
  // console.log(msg.author.username);



  // console.log(msg.guild.emojis.cache)//show all emojis


  if (msg.author.username + "#" + msg.author.discriminator == "exorcismus#7611" && !message.startsWith("!")) {
    // if (msg.author.username + '#' + msg.author.discriminator == 'Moonscarlet#4105') {
    // msg.react(msg.guild.emojis.cache.get('515873f6898e0b26daf51921c65a43f7'))//BRUH
    // msg.react(':regional_indicator_a:')
    // msg.react(msg.guild.emojis.cache.get("1018204796689322014")); //BRUH
  }

  // AI emoji reactions for specific users
  const reactTo = ['underageuser']
  if ((reactTo.includes(msg.author.username) && !message.startsWith("!")) || message.startsWith("_")) {
    try {
      // Get AI-suggested emojis based on message content
      const suggestedEmojis = await getRelevantEmojis(msg.content, 5, 'qwen-qwq-32b');
      
      // React with each emoji, handling errors for each one individually
      for (const emoji of suggestedEmojis) {
        try {
          await msg.react(emoji);
          // Small delay to prevent rate limiting
          await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
          console.error(`Error reacting with emoji ${emoji}:`, error);
          // Continue with next emoji if one fails
          continue;
        }
      }
    } catch (error) {
      console.error('Error in AI emoji reaction:', error);
      // Just log the error and continue with the bot's operation
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
      "**!!<anything>**: AI response.",
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

  else if (message.startsWith("!!")) {
  // else if (message.startsWith("$$")) {
    try {
      // Try Groq first
      const completion = await groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content: process.env.systemInstruction,
            // content: "You talk like Dr. Robert Ford from the tv show 'westworld', but instead of using the word westworld you replace it with Banha anytime you mention it",
          },
          {
            role: "user",
            content: message.slice(2).trim(),
          },
        ],
        model: "deepseek-r1-distill-llama-70b",
        temperature: 0.3,
      });

      let response = completion.choices[0]?.message?.content || "";
      console.log("response: ", response);
      response = response.replace(/<think>[\s\S]*?<\/think>/g, '');
      
      if (response.length > 2000) {
        for (let i = 0; i < response.length; i += 2000) {
          const chunk = response.substring(i, i + 2000);
          msg.reply(chunk);
        }
      } else {
        msg.reply(response);
      }
      
    } catch (error) {
      console.error("Groq Error:", error);
      console.log("Falling back to Gemini...");
      
      try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const modelName = "gemini-2.0-flash-exp";
        const model = genAI.getGenerativeModel({
          model: modelName,
          safetySettings: [
            {
              category: "HARM_CATEGORY_HARASSMENT",
              threshold: "BLOCK_NONE"
            },
            {
              category: "HARM_CATEGORY_HATE_SPEECH",
              threshold: "BLOCK_NONE"
            },
            {
              category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
              threshold: "BLOCK_NONE"
            },
            {
              category: "HARM_CATEGORY_DANGEROUS_CONTENT",
              threshold: "BLOCK_NONE"
            }
          ],
          systemInstruction: process.env.systemInstruction,
        });

        const prompt = message.slice(2).trim();
        const result = await model.generateContent(prompt);
        const response = await result.response;
        
        let text;
        if (response.candidates[0].content?.parts?.length > 1) {
          text = response.candidates[0].content.parts[1].text;
        } else {
          text = response.text();
        }

        if (text.length > 2000) {
          for (let i = 0; i < text.length; i += 2000) {
            const chunk = text.substring(i, i + 2000);
            msg.reply(chunk);
          }
        } else {
          msg.reply(text);
        }        
        
      } catch (error) {
        console.error("AI Error:", error);
        msg.reply("Sorry, I encountered an error processing your request.");
      }
    }
    return;
  }

  else if (message.startsWith("!")) {
    message = message.replace("!", "").trim();
    
    // Set default language to "ja" for fallback TTS
    let lang = "ja";
    const langRegex = /<([a-zA-Z-]+)>/;
    const langMatch = message.match(langRegex);

    if (langMatch) {
      lang = langMatch[1];
      message = message.replace(langMatch[0], "").trim();
    }

    try {
      // Try ElevenLabs first
      const audioPath = await textToSpeech(message);
      const resource = createAudioResource(audioPath);

      playVoice(resource);

      // Clean up the audio file after playing
      setTimeout(() => {
        fs.unlink(audioPath, (err) => {
          if (err) console.error('Error deleting audio file:', err);
        });
      }, 5000); // Wait 5 seconds before deleting to ensure the file is done playing

    } catch (error) {
      console.error('ElevenLabs TTS failed, falling back to default TTS:', error);
      
      // Fallback to original TTS
      const stream = discordTTS.getVoiceStream(message, { lang: lang });
      const resource = createAudioResource(stream);

      playVoice(resource);
    }

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

  // CURRENTHOUR IN EGYPT TIME BY USING OTHER THAN GETHOURS AND HANDLE DAYLIGHT SAVINGS TIME
  const nowdatetime = new Date();
  const utc = nowdatetime.getTime() + nowdatetime.getTimezoneOffset() * 60000;
  const egyptTime = new Date(utc + 3600000 * 2);
  const currentHour = egyptTime.getHours();


  if (statusBefore != statusAfter) {
    console.log(msg);
    sendToChannel(IDs.channelStatus, msg);
  }

  
  if (userID == IDs.Moonscarlet && (statusBefore == "offline" || statusBefore == "") && statusAfter == "online") {
    // chatMsg = "<@" + IDs.Moonscarlet + "> is back online";
    // sendToChannel(IDs.channelDel, chatMsg);
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
  }else if (
    userID == IDs.ZEKUS &&
    (currentHour == 23 || currentHour == 0) &&
    (statusBefore == "offline" || statusBefore == " ") &&
    (statusAfter == "online")
  ) {
    // const messages = [
    //   "Hey <@" + IDs.ZEKUS + "> 🚨, what's going on? 🤔 You're late again 🕰️, starting to think you're allergic to being on time 🤣. Seriously though, your unreliability is becoming a habit 📝, and it's getting old 🙄. Get your act together, dude! 😂",
    //   "<@" + IDs.ZEKUS + ">, are you running on moon time or something? 🌕 Because you're definitely not on schedule 📅",
    //   "<@" + IDs.ZEKUS + "> , tardy again 🚨! Starting to think you have a PhD in procrastination 📚",
    //   "<@" + IDs.ZEKUS + ">, where's the fire? 🚒 Because you're moving slower than a snail on valium 🐌",
    //   "<@" + IDs.ZEKUS + "> , where have you been? 📍 Lost in space or just lost in general? 🚀",
    //   "<@" + IDs.ZEKUS + ">, fashionably late or just plain late? 🕰️ Either way, you're here now, so let's get this party started 🎉",
    //   "<@" + IDs.ZEKUS + ">, are you trying to set a new record for most times late in a row? 🏆 Because you're definitely a contender 🤣",
    //   "<@" + IDs.ZEKUS + "> , what's your secret? 🤫 How do you manage to be late every single time? 🕰️ It's like you have a sixth sense for it 🤯",
    //   "<@" + IDs.ZEKUS + ">, don't you know that punctuality is a virtue? 🙏 Because you're definitely not practicing what you preach 🙅‍♂️",
    //   "<@" + IDs.ZEKUS + "> , are you stuck in a time loop or something? 🕳️ Because it feels like we're having this same conversation every day 📆",
    //   "<@" + IDs.ZEKUS + ">, late again 🕰️! I'm starting to think you're allergic to being on time 🤣",
    //   "<@" + IDs.ZEKUS + ">, what's going on? 🤔 You're usually more reliable than this 📈",
    //   "<@" + IDs.ZEKUS + "> , are you on island time or something? 🌴 Because you're definitely not on our schedule 📅",
    //   "<@" + IDs.ZEKUS + ">, I'm starting to think you're not taking this seriously 🤔. Punctuality is key, my friend 🗝️",
    //   "<@" + IDs.ZEKUS + ">, where did you go? 📍 Did you get lost in the Bermuda Triangle or something? 🌊",
    //   "<@" + IDs.ZEKUS + "> , this is getting ridiculous 🤣. How many times can one person be late in a row? 🕰️",
    //   "<@" + IDs.ZEKUS + ">, are you having trouble telling time? 🕰️ Because it seems like you're always running behind schedule 📆",
    //   "<@" + IDs.ZEKUS + "> , this is not a joke 🤣. Being late is not funny, it's frustrating 😠",
    //   "<@" + IDs.ZEKUS + ">, are you trying to drive me crazy? 🤯 Because it feels like you're intentionally showing up late every time 🕰️"
    // ];
    
    // const chatMsg = messages[Math.floor(Math.random() * messages.length)];
    // console.log(chatMsg);    
    // sendToChannel(IDs.channelMain, chatMsg);
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


