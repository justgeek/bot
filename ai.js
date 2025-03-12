// Simple AI request using Groq with customizable model selection
require('dotenv').config();
const { Groq } = require('groq-sdk');

// Initialize the Groq client with API key from .env
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

async function makeGroqRequest(prompt, model = 'deepseek-r1-distill-qwen-32b') {
  try {
    console.log(`Sending request to Groq API using model: ${model}...`);
    
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      model: model,
    });

    console.log('Response received!');
    return chatCompletion.choices[0]?.message?.content || 'No response received';
  } catch (error) {
    console.error('Error making Groq API request:', error);
    return `Error: ${error.message}`;
  }
}

/**
 * Analyzes a message and returns relevant emojis using Groq AI
 * @param {string} messageContent - The content of the message to analyze
 * @param {number} maxEmojis - Maximum number of emojis to return (default: 5)
 * @param {string} model - The Groq model to use
 * @returns {Promise<string[]>} - Array of emoji characters
 */
async function getRelevantEmojis(messageContent, maxEmojis = 5, model = 'deepseek-r1-distill-qwen-32b') {
  try {
    console.log(`Analyzing message for emoji reactions using ${model}...`);
    
    // List of common, well-supported Discord emojis
    const safeEmojis = [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', 
      '😇', '😍', '🥰', '😘', '😗', '😚', '😙', '😋', '😛', '😜', '😝', '🤑',
      '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄',
      '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮',
      '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '🧐', '😕',
      '😟', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰',
      '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤',
      '😡', '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺', '👻',
      '👽', '👾', '🤖', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾',
      '🙈', '🙉', '🙊', '💋', '💌', '💘', '💝', '💖', '💗', '💓', '💞', '💕',
      '💟', '❣️', '💔', '❤️', '🧡', '💛', '💚', '💙', '💜', '🤎', '🖤', '🤍',
      '💯', '💢', '💥', '💫', '💦', '💨', '🕳️', '💣', '💬', '👁️‍🗨️', '🗨️', '🗯️',
      '💭', '💤', '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞',
      '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊',
      '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳',
      '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷',
      '🦴', '👀', '👁️', '👅', '👄', '💋', '🩸', '🎮', '🎯', '🎲', '🧩', '🎭',
      '🎨', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🎷', '🎺', '🎸', '🎻', '🪕',
      '🎾', '🏈', '⚽', '🏀', '⚾', '🥎', '🏐', '🏉', '🎱', '🏓', '🏸', '🏒',
      '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋',
      '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼',
      '🤸', '⛹️', '🤺', '🤾', '🏌️', '🏇', '🧘', '🏄', '🏊', '🤽', '🚣', '🧗',
      '🚵', '🚴', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🏵️', '🎗️', '🎫', '🎟️',
      '🎪', '🎭', '🎨', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🎷', '🎺', '🎸',
      '🎻', '🪕', '🎲', '♟️', '🎯', '🎳', '🎮', '🎰', '🧩', '🚗', '🚕', '🚙',
      '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜', '🦯',
      '🦽', '🦼', '🛴', '🚲', '🛵', '🏍️', '🛺', '🚨', '🚔', '🚍', '🚘', '🚖',
      '🚡', '🚠', '🚟', '🚃', '🚋', '🚞', '🚝', '🚄', '🚅', '🚈', '🚂', '🚆',
      '🚇', '🚊', '🚉', '✈️', '🛫', '🛬', '🛩️', '💺', '🛰️', '🚀', '🛸', '🚁',
      '🛶', '⛵', '🚤', '🛥️', '🛳️', '⛴️', '🚢', '⚓', '🚧', '⛽', '🚏', '🚦',
      '🚥', '🗿', '🗽', '🗼', '🏰', '🏯', '🏟️', '🎡', '🎢', '🎠', '⛲', '⛱️',
      '🏖️', '🏝️', '🏜️', '🌋', '⛰️', '🏔️', '🗻', '🏕️', '⛺', '🏠', '🏡', '🏘️',
      '🏚️', '🏗️', '🏢', '🏭', '🏬', '🏣', '🏤', '🏥', '🏦', '🏨', '🏪', '🏫',
      '🏩', '💒', '🏛️', '⛪', '🕌', '🕍', '🛕', '🕋', '⛩️', '🛤️', '🛣️', '🗾',
      '🎑', '🏞️', '🌅', '🌄', '🌠', '🎇', '🎆', '🌇', '🌆', '🏙️', '🌃', '🌌',
      '🌉', '🌁', '⌚', '📱', '📲', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '🖲️', '🕹️',
      '🗜️', '💽', '💾', '💿', '📀', '📼', '📷', '📸', '📹', '🎥', '📽️', '🎞️',
      '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '🎚️', '🎛️', '🧭', '⏱️', '⏲️',
      '⏰', '🕰️', '⌛', '⏳', '📡', '🔋', '🔌', '💡', '🔦', '🕯️', '🪔', '🧯',
      '🛢️', '💸', '💵', '💴', '💶', '💷', '🪙', '💰', '💳', '💎', '⚖️', '🪜',
      '🧰', '🪛', '🔧', '🔨', '⚒️', '🛠️', '🧲', '🔩', '⚙️', '🧱', '⛓️', '🧪',
      '🧫', '🧬', '🔬', '🔭', '📡', '💉', '🩸', '💊', '🩹', '🩺', '🚪', '🛗',
      '🪞', '🪟', '🛏️', '🛋️', '🪑', '🚽', '🪠', '🚿', '🛁', '🪤', '🪒', '🧴',
      '🧷', '🧹', '🧺', '🧻', '🪣', '🧼', '🪥', '🧽', '🧯', '🛒', '🚬', '⚰️',
      '🪦', '⚱️', '🗿', '🪧', '🏧', '🚮', '🚰', '♿', '🚹', '🚺', '🚻', '🚼',
      '🚾', '🛂', '🛃', '🛄', '🛅', '⚠️', '🚸', '⛔', '🚫', '🚳', '🚭', '🚯',
      '🚱', '🚷', '📵', '🔞', '☢️', '☣️', '⬆️', '↗️', '➡️', '↘️', '⬇️', '↙️',
      '⬅️', '↖️', '↕️', '↔️', '↩️', '↪️', '⤴️', '⤵️', '🔃', '🔄', '🔙', '🔚',
      '🔛', '🔜', '🔝', '🛐', '⚛️', '🕉️', '✡️', '☸️', '☯️', '✝️', '☦️', '☪️',
      '☮️', '🕎', '🔯', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑',
      '♒', '♓', '⛎', '🔀', '🔁', '🔂', '▶️', '⏩', '⏭️', '⏯️', '◀️', '⏪', '⏮️',
      '🔼', '⏫', '🔽', '⏬', '⏸️', '⏹️', '⏺️', '⏏️', '🎦', '🔅', '🔆', '📶',
      '📳', '📴', '♀️', '♂️', '⚧️', '✖️', '➕', '➖', '➗', '♾️', '‼️', '⁉️',
      '❓', '❔', '❕', '❗', '〰️', '💱', '💲', '⚕️', '♻️', '⚜️', '🔱', '📛',
      '🔰', '⭕', '✅', '☑️', '✔️', '❌', '❎', '➰', '➿', '〽️', '✳️', '✴️',
      '❇️', '©️', '®️', '™️', '#️⃣', '*️⃣', '0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣',
      '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟', '🔠', '🔡', '🔢', '🔣', '🔤',
      '🅰️', '🆎', '🅱️', '🆑', '🆒', '🆓', 'ℹ️', '🆔', 'Ⓜ️', '🆕', '🆖', '🅾️',
      '🆗', '🅿️', '🆘', '🆙', '🆚', '🈁', '🈂️', '🈷️', '🈶', '🈯', '🉐', '🈹',
      '🈚', '🈲', '🉑', '🈸', '🈴', '🈳', '㊗️', '㊙️', '🈺', '🈵', '🔴', '🟠',
      '🟡', '🟢', '🔵', '🟣', '🟤', '⚫', '⚪', '🟥', '🟧', '🟨', '🟩', '🟦',
      '🟪', '🟫', '⬛', '⬜', '◼️', '◻️', '◾', '◽', '▪️', '▫️', '🔶', '🔷',
      '🔸', '🔹', '🔺', '🔻', '💠', '🔘', '🔳', '🔲', '🏁', '🚩', '🎌', '🏴',
      '🏳️', '🏳️‍🌈', '🏳️‍⚧️', '🏴‍☠️'
    ];
    
    const prompt = `
Analyze this message and suggest ${maxEmojis} relevant emojis that would be appropriate reactions:
"${messageContent}"

Return ONLY the emoji characters with no explanation, separated by spaces. 
For example: "😊 👍 🎉 🤔 ❤️"

Important: Only use standard Unicode emojis that are widely supported in all platforms.
`;
    
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that analyzes message content and returns only relevant emoji characters. No text explanations, just emojis separated by spaces.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      model: model,
      temperature: 0.3, // Lower temperature for more predictable results
    });

    const response = chatCompletion.choices[0]?.message?.content || '';
    console.log('Raw emoji response:', response);
    
    // Extract only emoji characters from the response
    const emojiRegex = /[\p{Emoji}]/gu;
    let emojis = [...response.matchAll(emojiRegex)].map(match => match[0]);
    
    // Filter to only include emojis from our safe list
    emojis = emojis.filter(emoji => safeEmojis.includes(emoji));
    
    // If we don't have enough emojis, add some safe defaults based on message sentiment
    if (emojis.length < 1) {
      // Add some default safe emojis
      emojis = ['👍', '😊', '🙂', '👋', '🎮'];
    }
    
    // Limit to maxEmojis
    const limitedEmojis = emojis.slice(0, maxEmojis);
    
    console.log('Extracted emojis:', limitedEmojis);
    return limitedEmojis;
  } catch (error) {
    console.error('Error getting emoji suggestions:', error);
    // Return some safe default emojis in case of error
    return ['👍', '😊', '🙂', '👋', '🎮'];
  }
}

/**
 * Validates if an emoji is supported by Discord
 * @param {string} emoji - The emoji to validate
 * @returns {boolean} - Whether the emoji is valid
 */
function isValidDiscordEmoji(emoji) {
  // Basic validation - ensure it's a single character emoji
  return emoji && emoji.length === 1 || emoji.length === 2 && /\p{Emoji}/u.test(emoji);
}

// Display usage information if --help flag is provided
if (process.argv.includes('--help')) {
  console.log(`
Usage: node ai.js [prompt] [--model=MODEL_NAME]

Arguments:
  prompt             The prompt to send to the AI (in quotes)
  --model=MODEL_NAME The Groq model to use (default: deepseek-r1-distill-qwen-32b)

Examples:
  node ai.js "What is the capital of France?"
  node ai.js "Explain quantum computing" --model=llama3-70b-8192
  `);
  process.exit(0);
}

// Parse command line arguments
let userPrompt = 'Explain quantum computing in simple terms.';
let model = 'deepseek-r1-distill-qwen-32b';

// Get the prompt (first non-flag argument)
const nonFlagArgs = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
if (nonFlagArgs.length > 0) {
  userPrompt = nonFlagArgs[0];
}

// Check for model flag
const modelArg = process.argv.find(arg => arg.startsWith('--model='));
if (modelArg) {
  model = modelArg.split('=')[1];
}

// Run the request if script is called directly
if (require.main === module) {
  makeGroqRequest(userPrompt, model)
    .then(response => {
      console.log('\nPrompt:', userPrompt);
      console.log('\nResponse:', response);
    })
    .catch(error => {
      console.error('Error:', error);
    });
}

// Export the functions for use in other files
module.exports = { 
  makeGroqRequest,
  getRelevantEmojis,
  isValidDiscordEmoji
};
