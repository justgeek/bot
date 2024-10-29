import os
import random
import asyncio
import logging
from pathlib import Path

import discord
from discord.ext import commands
from dotenv import load_dotenv
from gtts import gTTS

# Load environment variables
load_dotenv()
TOKEN = os.getenv('BOT_TOKEN2')

# Configure logging
logging.basicConfig(level=logging.INFO)

# Discord Intents
intents = discord.Intents.default()
intents.guilds = True
intents.messages = True
intents.message_content = True
intents.voice_states = True
intents.members = True
intents.presences = True

# Command Prefix
COMMAND_PREFIX = '$'

# Initialize Bot
bot = commands.Bot(command_prefix=COMMAND_PREFIX, intents=intents)

# Constants and IDs
IDs = {
    'guild': 247069115204763648,
    'channelMain': 247069115204763648,
    'channelV': 460899681787052083,
    'channelDel': 1020388735390601317,
    'channelEdit': 1021447609983959050,
    'channelVoice': 1021812152186720256,
    'channelStatus': 1020398542365401128,
    'channelCommands': 1020315442042122330,
    'voice1': 247069115204763649,
    'voice2': 248868783534505984,
    'voice3': 310083935298125825,
    'voiceAFK': 310083935298125825,
    'Moonscarlet': 234236035846897664,
    'LORD': 946751602415521873,
    'Mido': 329004546900885515,
    'TDK': 223957971976192001
}

VOICE_CURRENT = IDs['voice3']

# Directory Paths
OTHER_FOLDER = Path("./other/")
MEMES_FOLDER = Path("./memes/")

# Meme Files
meme_files = sorted(MEMES_FOLDER.iterdir(), key=lambda f: f.stat().st_mtime)
memes = {
    f"!{m.stem.replace(' ', '').lower()}": m.name 
    for m in meme_files if m.is_file()
}

# Games List
GAMES_LIST = [
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
]

@bot.event
async def on_ready():
    """Event handler when the bot is ready."""
    logging.info(f'Logged in as {bot.user}!')
    await bot.change_presence(status=discord.Status.invisible)
    channel = bot.get_channel(IDs['channelV'])
    if channel:
        await channel.send(
            'Sup!' + '\t' * 24 + f'("{COMMAND_PREFIX}commands" for stuff)'
        )
    # await join_banha_voice_channel(VOICE_CURRENT)

async def join_banha_voice_channel(channel_id: int):
    """Connect to the specified voice channel."""
    channel = bot.get_channel(channel_id)
    if isinstance(channel, discord.VoiceChannel):
        if not channel.guild.voice_client:
            await channel.connect()
        else:
            await channel.guild.voice_client.move_to(channel)

@bot.event
async def on_message(message: discord.Message):
    """Event handler for incoming messages."""
    if message.author == bot.user or str(message.author) == "Malevolent#0025":
        return

    content = message.content.lower()

    if content == f"{COMMAND_PREFIX}commands":
        commands = [
            f'**{COMMAND_PREFIX}youtube** or **{COMMAND_PREFIX}playlist**: print YouTube "Our Games" playlist link.',
            f"**{COMMAND_PREFIX}games**: list possible games to play.",
            f"**{COMMAND_PREFIX}randomgame**: choose a random game to play.",
            f'**{COMMAND_PREFIX}random <names (comma separated)>**: shuffle provided players ("**{COMMAND_PREFIX}random player1,player2,player3**").',
            f"**{COMMAND_PREFIX}randomall**: create random teams of all players in your current voice channel.",
            f'**{COMMAND_PREFIX}randomall <voice channel members row numbers to exclude (comma separated)>** (to exclude 3rd and 5th "**{COMMAND_PREFIX}randomall 3,5**").',
            f'**{COMMAND_PREFIX}<anything>**: Text-To-Speech.',
            f'**{COMMAND_PREFIX}memes**: list memes.',
            f'**{COMMAND_PREFIX}joinme**: Join your current voice channel for TTS and stuff.',
        ]
        commands_message = "> **COMMANDS:**\n> " + "\n> ".join(commands)
        await message.channel.send(commands_message)

    elif content == f"{COMMAND_PREFIX}games":
        games_message = "> **" + "\n> **".join(sorted(GAMES_LIST)) + "**"
        await message.reply(games_message)

    elif content == f"{COMMAND_PREFIX}randomgame":
        random_game = "> **" + random.choice(GAMES_LIST) + "**"
        await message.reply(random_game)

    elif content == f"{COMMAND_PREFIX}memes":
        memes_keys = "> **" + ", ".join(memes.keys()).upper() + "**"
        await message.reply(memes_keys)

    elif content in memes:
        meme_file = MEMES_FOLDER / memes[content]
        if meme_file.exists():
            await play_voice(meme_file)
            log_message = f"{message.author.display_name} {content}"
            logging.info(log_message)
            await send_to_channel(IDs['channelCommands'], log_message)
            await message.delete()
        else:
            logging.warning(f"Meme file not found: {meme_file}")

    elif content.startswith(f"{COMMAND_PREFIX}random "):
        players = [p.strip() for p in content[len(COMMAND_PREFIX) + 7:].split(',')]
        if len(players) == 1:
            await message.reply(f"{players[0]} can queue alone!")
        else:
            random.shuffle(players)
            teams = f"> **{len(players)} players:**"
            for i in range(0, len(players), 2):
                team_members = " - ".join(players[i:i+2])
                teams += f"\n> **Team {i//2 + 1}:** {team_members}"
            await message.reply(teams)

    elif content.startswith(f"{COMMAND_PREFIX}randomall"):
        voice_channel = message.author.voice.channel if message.author.voice else None
        if voice_channel:
            players = [member for member in voice_channel.members if not member.bot]
            if len(players) == 0:
                await message.reply("no players no games!")
                return
            if len(players) == 1:
                await message.reply(f"lol {players[0].mention} go queue alone KEKW")
                return

            # Handle exclusions
            parts = content.split()
            if len(parts) > 1:
                try:
                    excluded_indices = [int(i)-1 for i in parts[1].split(',')]
                    players = [p for idx, p in enumerate(players) if idx not in excluded_indices]
                except ValueError:
                    await message.reply("Invalid format for exclusions. Use numbers separated by commas.")
                    return

            if not players:
                await message.reply("no players left after exclusions!")
                return

            random.shuffle(players)
            teams = f"> **{len(players)} players:**"
            for i in range(0, len(players), 2):
                team = players[i:i+2]
                team_mentions = " - ".join([member.mention for member in team])
                teams += f"\n> **Team {i//2 + 1}:** {team_mentions}"
            await message.reply(teams)
        else:
            await message.reply("> You're not in a voice channel!")

    elif content.startswith(f"{COMMAND_PREFIX}joinme"):
        if message.author.voice:
            voice_channel = message.author.voice.channel
            await join_banha_voice_channel(voice_channel.id)
            await message.delete()
    elif content == f"{COMMAND_PREFIX}youtube" or content == f"{COMMAND_PREFIX}playlist":
        await message.channel.send("https://www.youtube.com/playlist?list=PLhKVK0lPQ73sDSSxq09yx9QVgyr3MBR6d")
    elif content.startswith(COMMAND_PREFIX):
        text = content[1:]
        await tts(text, message)

async def tts(text: str, message: discord.Message):
    """Convert text to speech and play it."""
    try:
        tts = gTTS(text=text, lang='ja')
        file_path = "tts_output.mp3"
        tts.save(file_path)

        await play_voice(file_path)
        await message.delete()
        os.remove(file_path)
    except Exception as e:
        logging.error(f"TTS Error: {e}")

async def play_voice(file_path: str):
    """Play audio file in the connected voice channel."""
    voice_client = discord.utils.get(bot.voice_clients, guild__id=IDs['guild'])
    if voice_client and voice_client.is_connected():
        try:
            audio_source = discord.FFmpegPCMAudio(file_path)
            if not voice_client.is_playing():
                voice_client.play(audio_source)
        except Exception as e:
            logging.error(f"Error playing voice: {e}")
    else:
        logging.warning("Bot is not connected to a voice channel.")

async def send_to_channel(channel_id: int, msg: str):
    """Send a message to the specified channel."""
    channel = bot.get_channel(channel_id)
    if channel:
        await channel.send(msg)
    else:
        logging.warning(f"Channel ID {channel_id} not found.")

def now() -> str:
    """Return the current UTC time formatted."""
    return discord.utils.utcnow().strftime("%d/%m/%Y %H:%M:%S")

@bot.event
async def on_message_delete(message: discord.Message):
    """Log message deletions."""
    if not message.content.startswith(COMMAND_PREFIX):
        deleted_message = f"{now()}\t **{message.author.name}:** {message.content}"
        await send_to_channel(IDs['channelDel'], deleted_message)

@bot.event
async def on_message_edit(before: discord.Message, after: discord.Message):
    """Log message edits."""
    if before.content != after.content:
        edited_message = (
            f"{now()}\t **{after.author.name}:**\n"
            f"{before.content}\n>\n{after.content}"
        )
        await send_to_channel(IDs['channelEdit'], edited_message)

@bot.event
async def on_presence_update(before: discord.Member, after: discord.Member):
    """Log presence updates."""
    if before.status != after.status:
        status_message = f"{now()}\t**{after.name}:** {before.status} > {after.status}"
        await send_to_channel(IDs['channelStatus'], status_message)

@bot.event
async def on_voice_state_update(member: discord.Member, before: discord.VoiceState, after: discord.VoiceState):
    """Log voice state updates."""
    if member.id == bot.user.id:
        return

    person = member.display_name
    channel_name_before = before.channel.name if before.channel else None
    channel_name_after = after.channel.name if after.channel else None

    if channel_name_before and not channel_name_after:
        log_message = f"{now()}\t**{person}** left **{channel_name_before}**"
    elif channel_name_after and not channel_name_before:
        log_message = f"{now()}\t**{person}** joined **{channel_name_after}**"
    elif channel_name_before != channel_name_after:
        log_message = f"{now()}\t**{person}** moved from **{channel_name_before}** to **{channel_name_after}**"
    else:
        return

    await send_to_channel(IDs['channelVoice'], log_message)

# Run the bot
if __name__ == "__main__":
    bot.run(TOKEN)
