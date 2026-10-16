// recording/drive.js - Google Drive storage for recordings, as your own Google account.
// Uses an OAuth refresh token with the "drive.file" scope: the bot only ever sees files it created itself.
// Service accounts can't be used: they have no storage quota on a personal Gmail Drive. Setup: scripts/drive-auth.js.
const fs = require("fs");
const { drive: makeDrive, auth } = require("@googleapis/drive");
const { Recording: cfg } = require("../config");

const enabled = !!(process.env.GDRIVE_CLIENT_ID && process.env.GDRIVE_CLIENT_SECRET && process.env.GDRIVE_REFRESH_TOKEN);
let oauth = null;
let api = null;
if (enabled) {
  oauth = new auth.OAuth2(process.env.GDRIVE_CLIENT_ID, process.env.GDRIVE_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: process.env.GDRIVE_REFRESH_TOKEN });
  api = makeDrive({ version: "v3", auth: oauth });
} else {
  console.warn("[Rec] GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN not set - recordings stay on the bot's disk only (lost on a Heroku restart).");
}

const FOLDER = "application/vnd.google-apps.folder";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function statusOf(err) {
  return Number(err?.status || err?.response?.status || (typeof err?.code === "number" ? err.code : 0)) || 0;
}

// Network blips, rate limits and Google's 5xx are retried with backoff (1 s, 2 s, 4 s, 8 s)
async function withRetry(label, fn, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = statusOf(err);
      const retryable = !status || status === 429 || status >= 500 || (status === 403 && /rate|quota exceeded for quota/i.test(err.message || ""));
      if (!retryable || i >= attempts) {
        err.message = `${label}: ${err.message}`;
        throw err;
      }
      await sleep(1000 * 2 ** (i - 1));
    }
  }
}

const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function findChild(parentId, name, mimeType) {
  const res = await withRetry("list", () =>
    api.files.list({
      q: `name = '${q(name)}' and '${q(parentId)}' in parents and trashed = false` + (mimeType ? ` and mimeType = '${mimeType}'` : ""),
      fields: "files(id, name, size, webViewLink)",
      pageSize: 1,
      spaces: "drive",
    })
  );
  return res.data.files?.[0] || null;
}

const folderCache = new Map(); // "parent/name" -> id
async function ensureFolder(parentId, name) {
  const key = `${parentId}/${name}`;
  if (folderCache.has(key)) return folderCache.get(key);
  let folder = await findChild(parentId, name, FOLDER);
  if (!folder) {
    folder = (await withRetry("create folder", () => api.files.create({ requestBody: { name, mimeType: FOLDER, parents: [parentId] }, fields: "id" }))).data;
  }
  folderCache.set(key, folder.id);
  return folder.id;
}

const rootFolder = () => ensureFolder("root", cfg.driveRootFolder || "Discord Recordings");

// The recording's own folder (created once, shared as "anyone with the link can view" so the
// Listen/Files buttons in #record open for everyone; files inside inherit that)
async function recordingFolder(rec, folderName) {
  if (rec.drive_folder_id) return rec.drive_folder_id;
  const id = await ensureFolder(await rootFolder(), folderName);
  await withRetry("share folder", () => api.permissions.create({ fileId: id, requestBody: { role: "reader", type: "anyone" } }));
  rec.drive_folder_id = id;
  return id;
}

// Uploads a file or Buffer into a folder; a file with the same name there is replaced (so re-runs
// after a restart don't leave duplicates). Returns { id, size, url }.
async function upload(parentId, name, source, mimeType = "application/octet-stream") {
  const existing = await findChild(parentId, name);
  const body = () => (Buffer.isBuffer(source) ? require("stream").Readable.from([source]) : fs.createReadStream(source));
  const res = await withRetry(`upload ${name}`, () =>
    existing
      ? api.files.update({ fileId: existing.id, media: { mimeType, body: body() }, fields: "id, size, webViewLink" })
      : api.files.create({ requestBody: { name, parents: [parentId] }, media: { mimeType, body: body() }, fields: "id, size, webViewLink" })
  );
  return { id: res.data.id, size: Number(res.data.size) || 0, url: res.data.webViewLink || fileUrl(res.data.id) };
}

async function download(fileId, dest) {
  const res = await withRetry("download", () => api.files.get({ fileId, alt: "media" }, { responseType: "stream" }));
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.data.on("error", reject).pipe(out).on("finish", resolve).on("error", reject);
  });
}

// Moves to Drive's trash (recoverable there for 30 days)
async function trash(fileId) {
  if (!fileId) return;
  try {
    await withRetry("trash", () => api.files.update({ fileId, requestBody: { trashed: true } }));
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
  }
}

// Trashes a file/folder by name inside a folder, if it's there
async function trashChild(parentId, name) {
  const child = await findChild(parentId, name);
  if (child) await trash(child.id);
  folderCache.delete(`${parentId}/${name}`);
}

async function quota() {
  const res = await withRetry("quota", () => api.about.get({ fields: "storageQuota(limit, usage)" }));
  const s = res.data.storageQuota || {};
  return { usage: Number(s.usage) || 0, limit: Number(s.limit) || 0 };
}

// For the /recordings page: streams a file, honouring an HTTP Range so the audio player can seek
async function mediaStream(fileId, range) {
  return api.files.get({ fileId, alt: "media" }, { responseType: "stream", headers: range ? { Range: range } : {} });
}

async function accessToken() {
  const { token } = await oauth.getAccessToken();
  return token;
}

const fileUrl = (id) => `https://drive.google.com/file/d/${id}/view`;
const folderUrl = (id) => `https://drive.google.com/drive/folders/${id}`;
const mediaUrl = (id) => `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;

module.exports = { enabled, ensureFolder, recordingFolder, upload, download, trash, trashChild, quota, mediaStream, accessToken, fileUrl, folderUrl, mediaUrl };
