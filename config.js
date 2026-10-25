module.exports = {
  IDs: {
    guild: "247069115204763648", // GUILD

    channelMain: "247069115204763648", // main text channel
    channelV: "460899681787052083", // v text channel
    channelDel: "1020388735390601317", // del text channel
    channelEdit: "1021447609983959050", // edit text channel
    channelVoice: "1021812152186720256", // voice text channel
    channelStatus: "1020398542365401128", // status text channel
    channelActivity: "1474888679183876228", // activity text channel
    channelCommands: "1020315442042122330", // commands text channel
    channelLateNotice: "247069115204763648", // where dashboard "late notices" are announced (main chat)
    channelRecord: "1560616047462318170", // record text channel: recording panels, and the only place recording commands work

    voice1: "247069115204763649", // 1st voice channel
    voice2: "248868783534505984", // 2nd voice channel (secret)
    voice3: "310083935298125825", // 3rd voice channel
    voiceAFK: "310083935298125825", // AFK voice channel (or auto-detected via Discord)

    Moonscarlet: "234236035846897664",
    LORD: "946751602415521873",
    Mido: "329004546900885515",
    TDK: "223957971976192001",
    ZEKUS: "644899011236724787",
  },

  // Hardcoded member colors (supports User ID, global username, or display name)
  MemberColorOverrides: {
    "234236035846897664": "#ff0000", // Moonscarlet: pure red
    "moonscarlet": "#ff0000",
    "coldzero96": "#1200fc",        // Coldzero: the blue he has on Discord
  },

  // Voice recording (recording/). Auto-record on/off, its channels, min people and the transcript/summary
  // defaults are changed from the control panel in #record; these are the fixed limits and formats.
  Recording: {
    chunkMinutes: 5, // raw audio goes to Drive in pieces this long while recording, so a restart risks at most one
    maxHours: 12, // safety cap per recording
    emptyStopSeconds: 600, // stop once the channel has had no people for this long (0 = as soon as the last one leaves)
    autoMinPeople: 2, // default people needed for auto-record to start
    autoStartDelaySeconds: 5, // the channel must stay that full this long (ignores quick join/leave)
    resumeWindowMinutes: 30, // after a restart, resume a recording only if it was cut off less than this ago
    ignoreBots: true, // don't record other bots (music bots etc.)
    mixKbps: 32, // everyone mixed together, Opus mono
    trackKbps: 24, // one file per speaker, Opus mono
    clipKbps: 48,
    clipSeconds: 30,
    clipMaxSeconds: 120,
    driveRootFolder: "Discord Recordings",
    minFreeGB: 1, // when Google Drive has less free than this, the oldest recordings' audio is deleted (text kept); 0 = off
  },

  // Allowed channels for the Dashboard "Share to Discord" feature
  allowedShareChannels: [
    { id: "1020315442042122330", name: "#commands" },
    { id: "247069115204763648", name: "#some_chat_room" },
    { id: "460899681787052083", name: "#v" },
  ],

  gamesList: [
    "Turbo",
    "Custom Hero Clash (CHC)",
    "Knight Squad 2",
    "Left 4 Dead 2",
    "Legion TD",
    "Ability Draft",
    "Cyberpunk 2077",
    "Ability Arena",
    "World of Warcraft",
    "Dead By Daylight",
    "Midnight Ghost Hunt",
    "Dota Arcade",
  ],

  PeopleTTS: {
    "ahmadgalal": "A G",
    "underageuser": "underage user",
    "hesham": "Hishaam",
    "fady_": "faadey",
    "mohamedhammad87": "middohh",
    "basseldesoky": "Supersonic",
    "prollygeek": "TDK",
    "ibrahimsp": "Heema",
    "omda5863": "omdaa",
    "terezee.248": "zeikus",
    "tofa7009": "TOFA",
    "zqp1313": "BLACK PHANTOM",
    "isso1988": "esso",
    "3la27229": "aalaaa",
    "abo_hamza_elmasry": "eslam",
    "assalamalssydrshadalssy": "eslam",
    "coldzero96": "helmy",
  }
};