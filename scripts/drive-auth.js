// scripts/drive-auth.js - one-time setup so the bot can save recordings to your Google Drive.
//
// 1. https://console.cloud.google.com : create a project and enable the "Google Drive API".
// 2. "OAuth consent screen": External, add the scope ".../auth/drive.file", then "Publish app" (In production).
//    Leave it in "Testing" and Google expires the token after 7 days.
// 3. "Credentials" -> "Create credentials" -> "OAuth client ID" -> type "Desktop app". Copy its ID and secret.
// 4. Run:  node scripts/drive-auth.js <client id> <client secret>
//    (or put GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET in .env and run it without arguments)
//    Open the link, sign in with the Google account whose Drive should hold the recordings, and allow it.
//    Then put the three printed values in Heroku's config vars.
//
// The "drive.file" scope only lets the bot see files it created itself (its "Discord Recordings" folder).
require("dotenv").config();
const http = require("http");
const { auth } = require("@googleapis/drive");

const clientId = process.argv[2] || process.env.GDRIVE_CLIENT_ID;
const clientSecret = process.argv[3] || process.env.GDRIVE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Usage: node scripts/drive-auth.js <client id> <client secret>");
  process.exit(1);
}

const server = http.createServer();
server.listen(0, "127.0.0.1", () => {
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const oauth = new auth.OAuth2(clientId, clientSecret, redirect);
  const url = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: ["https://www.googleapis.com/auth/drive.file"] });
  console.log("Open this link, sign in and allow access:\n\n" + url + "\n\nWaiting for Google...");

  server.on("request", async (req, res) => {
    const params = new URL(req.url, redirect).searchParams;
    if (!params.get("code")) {
      res.end(params.get("error") ? `Google said: ${params.get("error")}` : "Waiting for Google's reply...");
      return;
    }
    try {
      const { tokens } = await oauth.getToken(params.get("code"));
      res.end("Done - you can close this tab and go back to the terminal.");
      if (!tokens.refresh_token) {
        console.log("\nGoogle didn't send a refresh token. Remove the app at https://myaccount.google.com/permissions and run this again.");
      } else {
        console.log(`\nGDRIVE_CLIENT_ID=${clientId}\nGDRIVE_CLIENT_SECRET=${clientSecret}\nGDRIVE_REFRESH_TOKEN=${tokens.refresh_token}`);
        console.log("\nOn Heroku:\n  heroku config:set GDRIVE_CLIENT_ID=... GDRIVE_CLIENT_SECRET=... GDRIVE_REFRESH_TOKEN=...");
      }
    } catch (err) {
      res.end(`That didn't work: ${err.message}`);
      console.error("Token exchange failed:", err.message);
    }
    server.close();
  });
});
