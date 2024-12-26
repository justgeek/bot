const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

async function textToSpeech(text) {
    // const voiceId = '21m00Tcm4TlvDq8ikWAM';
    // const voiceId = 'EXAVITQu4vr4xnSDxMaL';//sarah
    // const voiceId = '21m00Tcm4TlvDq8ikWAM';//jessica
    const voiceId = 'vFedMyIZJ59tTsx3LZjA';//Malevolent
    // const voiceId = 'FZZ34QV5WgZK5N73m5cU';//testdisc

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    const apiKey = process.env.ELEVENLABS_API_KEY;

    try {
        const response = await axios({
            method: 'post',
            url: url,
            headers: {
                'Accept': 'audio/mpeg',
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
            },
            data: {
                text: text,
                model_id: 'eleven_flash_v2_5'
            },
            responseType: 'arraybuffer'
        });

        // Save the audio file
        const outputPath = 'output.mp3';
        fs.writeFileSync(outputPath, response.data);
        console.log(`Audio saved to ${outputPath}`);
        
        return outputPath;
    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
        throw error;
    }
}

const text = 'come bas yasta';
textToSpeech(text)
    .catch(console.error);
