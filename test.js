const fs = require("fs");

const memesFolder = "./memes/";
const memeFiles = fs.readdirSync(memesFolder)

const memeFilesSorted = []
memeFiles.forEach(m => {
    let modDate = fs.statSync(memesFolder + m).mtimeMs
    memeFilesSorted.push(modDate + "|" + m)
})

// console.log("memeFilesSorted: %s", memeFilesSorted.sort())
let memes={};
memeFilesSorted.forEach(m => {
    memes['!' + m.toLowerCase().replace(/.[^.]*$/g, '').replace(/\d.+[|]/g, '')] = m.replace(/\d.+[|]/g, ''); 
})

// console.log("memes: %s", memes)
