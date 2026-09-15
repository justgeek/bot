function sendToChannel(client, id, msg) {
  client.channels.fetch(id).then((channel) => {
    channel.send(msg);
  });
}

function now() {
  let today = new Date();
  // Opted to keep original exact logic, but note: native options like
  // new Date().toLocaleString("en-GB", { timeZone: "Africa/Cairo" }) automatically handle DST seamlessly.
  let utcHours = today.getUTCHours() + 3; // Egypt uses EET (UTC+2) year-round
  let hours = utcHours % 12 === 0 ? 12 : utcHours % 12;
  let ampm = utcHours >= 12 ? "PM" : "AM";

  let nowStr =
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
  return "`" + nowStr + "`";
}

const getAuthorDisplayName = (msg) => {
  if (msg.guild) {
    const member = msg.guild.members.cache.get(msg.author.id);
    return member ? (member.nickname || msg.author.username) : msg.author.username;
  } else {
    return msg.author.username;
  }
};

function sleep(ms) {
  // Optimization: Swapped blocking while-loop to native async promise to prevent event-loop freezing
  return new Promise(resolve => setTimeout(resolve, ms));
}

const sendResponse = (msg, responseText) => {
  if (responseText.length > 2000) {
    for (let i = 0; i < responseText.length; i += 2000) {
      const chunk = responseText.substring(i, i + 2000);
      msg.reply(chunk);
    }
  } else {
    msg.reply(responseText);
  }
};

function isCraig(user) {
  if (!user) return false;
  const username = (user.username || "").toLowerCase();
  const discriminator = user.discriminator || "";
  const tag = (user.tag || "").toLowerCase();
  const fullTag = discriminator && discriminator !== "0" ? `${username}#${discriminator}` : tag;

  return (
    tag === "craig#1289" ||
    fullTag === "craig#1289" ||
    discriminator === "1289" ||
    user.id === "272937604339466240" ||
    username === "craig" ||
    (user.bot && username.includes("craig"))
  );
}

function isCraigMember(member) {
  if (!member) return false;
  if (isCraig(member.user)) return true;
  const displayName = (member.displayName || "").toLowerCase();
  const nickname = (member.nickname || "").toLowerCase();
  if (member.user?.bot && (nickname === "مخبر" || displayName === "مخبر" || displayName.includes("craig"))) return true;
  return false;
}

async function renameCraigToMokhber(member, reason = "delayed") {
  console.log(`[Craig] renameCraigToMokhber called. reason=${reason}, member=${member?.id}, isCraigMember=${isCraigMember(member)}, currentNickname=${JSON.stringify(member?.nickname)}, displayName=${JSON.stringify(member?.displayName)}, username=${JSON.stringify(member?.user?.username)}`);

  if (!member) {
    console.log('[Craig] abort: no member');
    return;
  }
  if (!isCraigMember(member)) {
    console.log('[Craig] abort: isCraigMember=false');
    return;
  }

  // Skip if already renamed or if Craig is actively recording (e.g. "![RECORDING] مخبر")
  if (member.nickname === "مخبر" || member.nickname?.includes("مخبر")) {
    console.log('[Craig] abort: nickname already مخبر or contains مخبر');
    return;
  }

  // Pre-check role hierarchy and permissions to avoid unhandled 50013 errors
  if (!member.manageable) {
    console.warn(
      `[Craig] ⚠️ Cannot rename Craig: Bot lacks role hierarchy over Craig. Ensure your bot's role is placed HIGHER than Craig's role in Server Settings -> Roles.`
    );
    return;
  }

  try {
    console.log(`[Craig] Attempting setNickname('مخبر') on ${member.user?.tag || member.id}...`);
    await member.setNickname("مخبر");
    console.log(`[Craig] ✅ Successfully renamed Craig (${member.user?.tag || member.id}) to مخبر (${reason})`);
  } catch (err) {
    if (err.code === 50013) {
      console.error(
        "[Craig] ❌ Failed to rename Craig to مخبر: Missing Permissions (50013). " +
        "Ensure the bot has 'Manage Nicknames' permission and its highest role is placed HIGHER than Craig's role in Server Settings -> Roles."
      );
    } else {
      console.error(`[Craig] ❌ Failed to rename Craig to مخبر (${reason}): code=${err.code}`, err.message);
    }
  }
}

module.exports = {
  sendToChannel,
  now,
  getAuthorDisplayName,
  sleep,
  sendResponse,
  isCraig,
  isCraigMember,
  renameCraigToMokhber,
};