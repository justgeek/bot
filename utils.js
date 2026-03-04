function sendToChannel(client, id, msg) {
  client.channels.fetch(id).then((channel) => {
    channel.send(msg);
  });
}

function now() {
  let today = new Date();
  // Opted to keep original exact logic, but note: native options like
  // new Date().toLocaleString("en-GB", { timeZone: "Africa/Cairo" }) automatically handle DST seamlessly.
  let utcHours = today.getUTCHours() + 2; // Egypt uses EET (UTC+2) year-round
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

module.exports = { sendToChannel, now, getAuthorDisplayName, sleep, sendResponse };