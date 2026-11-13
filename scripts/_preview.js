// Temporary: serves the real /recordings page with the real database, so the player can be reproduced.
// No Discord login, no auth key (they are cleared before recording/web.js reads them). Safe to delete.
require("dotenv").config();
process.env.RECORDINGS_PASSWORD = "";
process.env.RECORDINGS_KEY = "";
process.env.DASHBOARD_KEY = "";

const express = require("express");
const app = express();
const client = { guilds: { cache: new Map() }, channels: { cache: new Map() } };

require("../recording/web")(app, client, {});

const port = Number(process.env.PREVIEW_PORT) || 8899;
app.listen(port, "127.0.0.1", () => console.log(`preview on http://localhost:${port}/recordings`));
