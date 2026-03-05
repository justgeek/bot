require('dotenv').config({ override: true });
require('node:dns').setDefaultResultOrder('ipv4first'); // Force IPv4 (fixes Heroku Node 20+ UDP drops)

const Discord = require("discord.js");
const express = require("express");

// Unused but preserved imports (from your original code)
const screenshot = require("screenshot-desktop");
const sharp = require("sharp");
const tesseract = require("node-tesseract-ocr");
const monitor = require("active-window");
const ffmpeg = require("ffmpeg");

// Create Discord Client
const client = new Discord.Client({
  intents:[
    Discord.GatewayIntentBits.Guilds,
    Discord.GatewayIntentBits.GuildMessages,
    Discord.GatewayIntentBits.MessageContent,
    Discord.GatewayIntentBits.GuildVoiceStates,
    Discord.GatewayIntentBits.GuildMembers,
    Discord.GatewayIntentBits.GuildPresences,
    Discord.GatewayIntentBits.GuildInvites,
  ],
});

// Load Event Listeners
require("./events")(client);

// Login Bot
client.login(process.env.BOT_TOKEN);

// Optional HTTP Health check/Keep-Alive App
const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("BANHA FOREVER !!!!! BOT IS RUNNING OK");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});