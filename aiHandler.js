const { GoogleGenerativeAI } = require("@google/generative-ai");
const Groq = require("groq-sdk");
const { sendResponse } = require("./utils");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function handleAICommand(msg, userPrompt) {
  const preferredService = process.env.AI_SERVICE?.toLowerCase();

  const imageParts = [];
  if (msg.attachments && msg.attachments.size > 0) {
    for (const [id, attachment] of msg.attachments) {
      if (attachment.contentType && attachment.contentType.startsWith("image/")) {
        try {
          const response = await fetch(attachment.url);
          const buffer = await response.arrayBuffer();
          imageParts.push({
            inlineData: {
              data: Buffer.from(buffer).toString("base64"),
              mimeType: attachment.contentType
            }
          });
        } catch (err) {
          console.error("Error fetching attachment:", err);
        }
      }
    }
  }

  const geminiRequest = [userPrompt];
  if (imageParts.length > 0) {
    geminiRequest.push(...imageParts);
  }

  let groqUserContent = userPrompt;
  if (imageParts.length > 0) {
    groqUserContent = [];
    if (userPrompt) {
      groqUserContent.push({ type: "text", text: userPrompt });
    }
    for (const part of imageParts) {
      groqUserContent.push({
        type: "image_url",
        image_url: {
          url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
        }
      });
    }
  }
      
  if (preferredService === 'gemini') {
    // Try Gemini first
    try {
      console.log("Attempting Gemini first...");
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const modelName = process.env.GEMINI_AI_MODEL || "gemini-2.5-pro-preview-03-25"; 
      const model = genAI.getGenerativeModel({
        model: modelName,
        safetySettings:[
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ],
        systemInstruction: process.env.systemInstruction,
      });

      const result = await model.generateContent(geminiRequest);
      const response = await result.response;

      let text;
      if (response.candidates[0].content?.parts?.length > 1) {
        text = response.candidates[0].content.parts[1].text;
      } else {
        text = response.text();
      }
      sendResponse(msg, text);
      console.log("Gemini Response:", text);

    } catch (geminiError) {
      console.error("Gemini Error:", geminiError);
      console.log("Falling back to Groq...");

      // Fallback to Groq
      try {
        const tools = [];
        const completion = await groq.chat.completions.create({
          messages: [
            { role: "system", content: process.env.systemInstruction },
            { role: "user", content: groqUserContent },
          ],
          model: process.env.GROQ_AI_MODEL,
          temperature: parseFloat(process.env.AI_TEMPERATURE),
          tools: tools
        });

        let response = completion.choices[0]?.message?.content || "";
        response = response.replace(/<think>[\s\S]*?<\/think>/g, '');
        sendResponse(msg, response);
        console.log("Groq Response:", response);
      } catch (groqError) {
        console.error("Groq Fallback Error:", groqError);
        msg.reply("Sorry, both AI services failed to process your request.");
      }
    }
  } else {
    // Default to Groq first (or if AI_SERVICE is not 'gemini')
    try {
      console.log("Attempting Groq first...");
      const tools = [];
      const completion = await groq.chat.completions.create({
        messages: [
          { role: "system", content: process.env.systemInstruction },
          { role: "user", content: groqUserContent },
        ],
        model: process.env.GROQ_AI_MODEL,
        temperature: parseFloat(process.env.AI_TEMPERATURE),
        tools: tools
      });

      let response = completion.choices[0]?.message?.content || "";
      response = response.replace(/<think>[\s\S]*?<\/think>/g, '');
      sendResponse(msg, response);
      console.log("Groq Response:", response);

    } catch (groqError) {
      console.error("Groq Error:", groqError);
      console.log("Falling back to Gemini...");

      // Fallback to Gemini
      try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const modelName = process.env.GEMINI_AI_MODEL || "gemini-2.5-pro-preview-03-25"; 
        const model = genAI.getGenerativeModel({
          model: modelName,
          safetySettings:[
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ],
          systemInstruction: process.env.systemInstruction,
        });

        const result = await model.generateContent(geminiRequest);
        const response = await result.response;

        let text;
        if (response.candidates[0].content?.parts?.length > 1) {
          text = response.candidates[0].content.parts[1].text;
        } else {
          text = response.text();
        }
        sendResponse(msg, text);
        console.log("Gemini Response:", text);
      } catch (geminiError) {
        console.error("Gemini Fallback Error:", geminiError);
        msg.reply("Sorry, both AI services failed to process your request.");
      }
    }
  }
}

module.exports = { handleAICommand };
