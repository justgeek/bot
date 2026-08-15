const { ActionRowBuilder, StringSelectMenuBuilder } = require("discord.js");
const { memes } = require("./memes");

const PAGE_SIZE = 25;
const MENUS_PER_MESSAGE = 5;

// Sort alphabetically so each menu's letter-range label is meaningful
const memeKeys = Object.keys(memes).sort((a, b) => a.localeCompare(b));

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function labelFor(group) {
  const first = group[0].replace("!", "")[0].toUpperCase();
  const last = group[group.length - 1].replace("!", "")[0].toUpperCase();
  return first === last ? first : `${first}-${last}`;
}

function buildMemeMenus() {
  const groups = chunk(memeKeys, PAGE_SIZE);

  const rows = groups.map((group, i) =>
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`meme_select_${i}`)
        .setPlaceholder(labelFor(group))
        .addOptions(group.map((key) => ({ label: key.replace("!", ""), value: key })))
    )
  );

  return chunk(rows, MENUS_PER_MESSAGE).map((rowGroup) => ({
    components: rowGroup, // no "content" — see point 3
  }));
}

module.exports = { buildMemeMenus };