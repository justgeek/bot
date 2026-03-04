const fs = require("fs");

const otherFolder = "./other/";
const memesFolder = "./memes/";
const memeFiles = fs.readdirSync(memesFolder);

const memeFilesSorted =[];
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

module.exports = { memes, memesFolder, otherFolder };