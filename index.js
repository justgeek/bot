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
    Discord.GatewayIntentBits.DirectMessages, // needed to receive DMs
  ],
  // DM channels/messages aren't cached like guild ones, so discord.js needs
  // these "partials" enabled or it silently drops the messageCreate event for DMs.
  partials: [
    Discord.Partials.Channel,
    Discord.Partials.Message,
  ],
});

// Load Event Listeners
require("./events")(client);

// Login Bot
client.login(process.env.BOT_TOKEN);

// Heroku sends SIGTERM ~30 s before it stops the dyno (daily restart, deploys); Ctrl+C is SIGINT.
// A running recording saves itself and resumes after the restart.
const recording = require("./recording");
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, saving any recording before exiting...`);
    try {
      await recording.shutdown();
    } catch (e) {
      console.error("Recording shutdown failed:", e);
    }
    process.exit(0);
  });
}

// Optional HTTP Health check/Keep-Alive App
const app = express();
const port = process.env.PORT || 3000;

// Dashboard at "/" + JSON API at "/api/*" (plain-text check moved to "/health")
require("./dashboard")(app, client);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});