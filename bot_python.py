import os
import random
import asyncio
from discord.ext import commands
import discord
from dotenv import load_dotenv
from PIL import Image
from gtts import gTTS

load_dotenv()
TOKEN = os.getenv('BOT_TOKEN2')

intents = discord.Intents.default()
intents.guilds = True
intents.messages = True
intents.message_content = True
intents.voice_states = True
intents.members = True
intents.presences = True

bot = commands.Bot(command_prefix='!', intents=intents)

IDs = {
    'guild': '247069115204763648',
    'channelMain': '247069115204763648',
    'channelV': '460899681787052083',
    'channelDel': '1020388735390601317',
    'channelEdit': '1021447609983959050',
    'channelVoice': '1021812152186720256',
    'channelStatus': '1020398542365401128',
    'channelCommands': '1020315442042122330',
    'voice1': '247069115204763649',
    'voice2': '248868783534505984',
    'voice3': '310083935298125825',
    'voiceAFK': '310083935298125825',
    'Moonscarlet': '234236035846897664',
    'LORD': '946751602415521873',
    'Mido': '329004546900885515',
    'TDK': '223957971976192001'
}

voice_current = IDs['voice3']

other_folder = "./other/"
memes_folder = "./memes/"
meme_files = os.listdir(memes_folder)
meme_files_sorted = sorted([(os.path.getmtime(os.path.join(memes_folder, m)), m) for m in meme_files])

memes = {f"!{m[1].rsplit('.', 1)[0].replace(' ', '').lower()}": m[1] for m in meme_files_sorted}

games_list = [
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
    print(f'Logged in as {bot.user}!')
    channel = bot.get_channel(int(IDs['channelV']))
    await channel.send('Sup!\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t("**!commands**" for stuff)')
    await join_banha_voice_channel(IDs['voice3'])

async def join_banha_voice_channel(channel_id):
    channel = bot.get_channel(int(channel_id))
    if channel and isinstance(channel, discord.VoiceChannel):
        await channel.connect()

@bot.event
async def on_message(message):
    if message.author == bot.user:
        return

    content = message.content.lower()
    if str(message.author) == "Malevolent#0025":
        return

    if content == "!commands":
        commands = [
            '**!youtube** or **!playlist**: print YouTube "Our Games" playlist link.',
            "**!games**: list possible games to play.",
            "**!randomgame**: choose a random game to play.",
            '**!random <names (comma separated)>**: shuffle provided players("**!random player1,player2,player3**").',
            "**!randomall**: create random teams of all players in your current voice channel.",
            '**!randomall <voice channel members row numbers to exclude (comma separated)>** (to exclude 3rd and 5th "**!randomall 3,5**").',
            "**!<anything>**: Text-To-Speech.",
            "**!memes**: list memes.",
            "**!joinme**: Join your current voice channel for TTS and stuff.",
        ]
        await message.channel.send("> **COMMANDS:**\n> " + "\n> ".join(commands))
    elif content == "!games":
        games = "> **" + "\n> **".join(sorted(games_list)) + "**"
        await message.reply(games)
    elif content == "!randomgame":
        random_game = "> **" + random.choice(games_list) + "**"
        await message.reply(random_game)
    elif content == "!memes":
        memes_keys = "> **" + ", ".join(memes.keys()).upper() + "**"
        await message.reply(memes_keys)
    elif content in memes:
        meme_file = os.path.join(memes_folder, memes[content])
        await play_voice(meme_file)
        log_message = f"{message.author.display_name} {content}"
        print(log_message)
        await send_to_channel(IDs['channelCommands'], log_message)
        await message.delete()
    elif content.startswith("!random "):
        players = content.replace("!random ", "").replace(" ", "").split(',')
        if len(players) == 1:
            await message.reply(players[0] + " can queue alone!")
        else:
            random.shuffle(players)
            teams = f"> **{len(players)} players:**"
            for i in range(0, len(players), 2):
                teams += f"\n> **Team {i//2 + 1}:** {players[i]} - {players[i+1] if i+1 < len(players) else ''}"
            await message.reply(teams)
    elif content.startswith("!randomall"):
        voice_channel = message.author.voice.channel if message.author.voice else None
        if voice_channel:
            players = [member for member in voice_channel.members if member != bot.user]
            if content != "!randomall":
                excluded_indices = [int(i)-1 for i in content.split()[1:]]
                players = [p for i, p in enumerate(players) if i not in excluded_indices]
            if not players:
                await message.reply("no players no games!")
            elif len(players) == 1:
                await message.reply(f"lol {players[0].mention} go queue alone KEKW")
            else:
                random.shuffle(players)
                teams = f"> **{len(players)} players:**"
                for i in range(0, len(players), 2):
                    teams += f"\n> **Team {i//2 + 1}:** {players[i].mention} - {players[i+1].mention if i+1 < len(players) else ''}"
                await message.reply(teams)
        else:
            await message.reply("> You're not in a voice channel!")
    elif content.startswith("!joinme"):
        if message.author.voice:
            voice_channel = message.author.voice.channel
            if voice_channel:
                await join_banha_voice_channel(voice_channel.id)
                await message.delete()
    elif content.startswith("!"):
        text = content[1:]
        await tts(text, message)

async def tts(text, message):
    tts = gTTS(text=text, lang='ja')
    file_path = "tts_output.mp3"
    tts.save(file_path)

    await play_voice(file_path)
    await message.delete()

async def play_voice(file_path):
    voice_client = discord.utils.get(bot.voice_clients, guild__id=int(IDs['guild']))
    if voice_client and voice_client.is_connected():
        audio_source = discord.FFmpegPCMAudio(file_path)
        if not voice_client.is_playing():
            voice_client.play(audio_source)
    else:
        print("Bot is not connected to a voice channel.")

async def send_to_channel(channel_id, msg):
    channel = bot.get_channel(int(channel_id))
    if channel:
        await channel.send(msg)

def now():
    return discord.utils.utcnow().strftime("%d/%m/%Y %H:%M:%S")

@bot.event
async def on_message_delete(message):
    if not message.content.startswith("!"):
        deleted_message = f"{now()}\t **{message.author.name}:** {message.content}"
        await send_to_channel(IDs['channelDel'], deleted_message)

@bot.event
async def on_message_edit(before, after):
    if before.content != after.content:
        edited_message = f"{now()}\t **{after.author.name}:**\n{before.content}\n>\n{after.content}"
        await send_to_channel(IDs['channelEdit'], edited_message)

@bot.event
async def on_presence_update(before, after):
    if before.status != after.status:
        status_message = f"{now()}\t**{after.name}:** {before.status} > {after.status}"
        await send_to_channel(IDs['channelStatus'], status_message)

@bot.event
async def on_voice_state_update(member, before, after):
    if member.id == bot.user.id:
        return

    person = member.name
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

bot.run(TOKEN)
