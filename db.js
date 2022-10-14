const mongoose = require('mongoose');

mongoose.connect("mongodb://localhost:27017/discordDB");

const gamesList = [
    "Turbo",
    "Custom Hero Clash (CHC)",
    "Overwatch",
    "Overthrow 3",
    "Knight Squad 2",
    "Left 4 Dead 2",
    "Legion TD",
    "Ability Draft",
    "Stumble Guys",
    "Cyberpunk 2077",
    "Ability Arena",
    "World of Warcraft",
]

const gameSchema = new mongoose.Schema({
    name: String,
    chosen: Number
});

const Game = mongoose.model("Game", gameSchema)

gamesList.forEach(e => {
    const game = new Game({
        name: e,
        chosen: 0
    })
    game.save();
    console.log("inserted: " + e);
})