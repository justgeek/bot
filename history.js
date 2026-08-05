// history.js
// Simple in-memory conversation history for the AI command ("!!").
//
// Why in-memory (a plain Map) instead of a file:
// On Heroku, the filesystem is ephemeral and dynos restart on every deploy
// (and at least once/day on eco/basic dynos), so anything written to disk
// gets wiped anyway. A Map in process memory behaves exactly the same way
// (cleared on restart) but with zero setup and no disk I/O. If you later
// want history to survive restarts, swap the Map for Heroku Redis - only
// getHistory/addToHistory/clearHistory below would need to change.
//
// Configure via env vars (Heroku config vars):
//   HISTORY_MAX_MESSAGES - how many messages to keep per conversation (default 6)
//   HISTORY_TTL_HOURS    - reset history if idle this long, in hours (default 2)

const MAX_HISTORY_MESSAGES = parseInt(process.env.HISTORY_MAX_MESSAGES, 10) || 30;
const HISTORY_TTL_HOURS = parseFloat(process.env.HISTORY_TTL_HOURS) || 24;
const HISTORY_TTL_MS = HISTORY_TTL_HOURS * 60 * 60 * 1000;

// key -> { messages: [{ role: 'user' | 'assistant', content: string }], lastUpdated: number }
const historyStore = new Map();

// History is scoped per-channel by default (shared context for everyone
// talking to the bot in that channel). Change this to `msg.author.id` if
// you'd rather keep a separate history per user instead.
function getHistoryKey(msg) {
  return msg.channel.id;
}

function isExpired(entry) {
  return !entry || Date.now() - entry.lastUpdated > HISTORY_TTL_MS;
}

// Returns the current (non-expired) history as a plain array, oldest first.
function getHistory(msg) {
  const key = getHistoryKey(msg);
  const entry = historyStore.get(key);

  if (isExpired(entry)) {
    historyStore.delete(key);
    return [];
  }

  return entry.messages;
}

// Appends a message ({ role, content }) and trims to the configured max.
function addToHistory(msg, role, content) {
  if (!content) return;

  const key = getHistoryKey(msg);
  const entry = historyStore.get(key);
  const messages = isExpired(entry) ? [] : entry.messages;

  messages.push({ role, content });
  while (messages.length > MAX_HISTORY_MESSAGES) {
    messages.shift();
  }

  historyStore.set(key, { messages, lastUpdated: Date.now() });
}

function clearHistory(msg) {
  historyStore.delete(getHistoryKey(msg));
}

module.exports = { getHistory, addToHistory, clearHistory };
