const { GoogleGenerativeAI } = require("@google/generative-ai");
const Groq = require("groq-sdk");
const { sendResponse } = require("./utils");
const { getHistory, addToHistory } = require("./history");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function handleAICommand(msg, userPrompt, options = {}) {
  const { onReply } = options;
  const preferredService = process.env.AI_SERVICE?.toLowerCase();

  // Gemini can take inline images, video, and audio (base64 + mimeType).
  // Groq's vision models only take images - video/audio only ever go to
  // Gemini, with a text note left for Groq so it knows what it's missing.
  const MAX_INLINE_BYTES = 19 * 1024 * 1024; // stay under Gemini's ~20MB inline request cap

  // Discord doesn't always set attachment.contentType correctly (or at all)
  // for less common formats, so we fall back to guessing from the file
  // extension. Add more extensions here as needed.
  const EXTENSION_MIME_MAP = {
    image: {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
      webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
      tiff: "image/tiff", tif: "image/tiff", heic: "image/heic", heif: "image/heif",
    },
    video: {
      mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
      avi: "video/x-msvideo", mkv: "video/x-matroska", wmv: "video/x-ms-wmv",
      flv: "video/x-flv", m4v: "video/x-m4v", mpeg: "video/mpeg", mpg: "video/mpeg",
      "3gp": "video/3gpp",
    },
    audio: {
      mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
      m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac", wma: "audio/x-ms-wma",
      opus: "audio/opus", weba: "audio/webm",
    },
  };

  function resolveAttachmentType(attachment) {
    const declared = (attachment.contentType || "").split(";")[0].trim().toLowerCase();
    if (declared.startsWith("image/")) return { category: "image", mimeType: declared };
    if (declared.startsWith("video/")) return { category: "video", mimeType: declared };
    if (declared.startsWith("audio/")) return { category: "audio", mimeType: declared };

    const ext = (attachment.name || "").split(".").pop()?.toLowerCase();
    if (!ext) return { category: null, mimeType: null };

    for (const category of ["image", "video", "audio"]) {
      if (EXTENSION_MIME_MAP[category][ext]) {
        return { category, mimeType: EXTENSION_MIME_MAP[category][ext] };
      }
    }
    return { category: null, mimeType: null };
  }

  const imageParts = [];
  const videoParts = [];
  const audioParts = [];
  const skippedNotes = [];

  if (msg.attachments && msg.attachments.size > 0) {
    for (const [id, attachment] of msg.attachments) {
      const { category, mimeType } = resolveAttachmentType(attachment);
      if (!category) continue; // not image/video/audio - ignore (e.g. .txt, .zip)

      if (attachment.size && attachment.size > MAX_INLINE_BYTES) {
        skippedNotes.push(
          `[Attachment "${attachment.name}" (${(attachment.size / (1024 * 1024)).toFixed(1)}MB) is too large to process and was skipped]`
        );
        continue;
      }

      try {
        const response = await fetch(attachment.url);
        const buffer = await response.arrayBuffer();
        const part = {
          inlineData: {
            data: Buffer.from(buffer).toString("base64"),
            mimeType,
          },
        };
        if (category === "image") imageParts.push(part);
        else if (category === "video") videoParts.push(part);
        else if (category === "audio") audioParts.push(part);
      } catch (err) {
        console.error(`Error fetching ${category} attachment:`, err);
      }
    }
  }

  // Text prompt used for Groq: images are attached as image_url parts below,
  // but video/audio can't be represented for Groq at all, so just tell it
  // what was there in case the reply seems to be missing context.
  let groqPromptText = userPrompt;
  const groqUnsupportedNotes = [];
  if (videoParts.length > 0) groqUnsupportedNotes.push(`${videoParts.length} video attachment(s)`);
  if (audioParts.length > 0) groqUnsupportedNotes.push(`${audioParts.length} audio attachment(s)`);
  if (groqUnsupportedNotes.length > 0) {
    groqPromptText = `${groqPromptText}\n\n[Note: ${groqUnsupportedNotes.join(" and ")} were included. This AI service can't process video or audio (only Gemini can) - answer based on any text/images only.]`;
  }
  if (skippedNotes.length > 0) {
    groqPromptText = `${groqPromptText}\n\n${skippedNotes.join("\n")}`;
  }

  let groqUserContent = groqPromptText;
  if (imageParts.length > 0) {
    groqUserContent = [];
    if (groqPromptText) {
      groqUserContent.push({ type: "text", text: groqPromptText });
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

  // Pull recent conversation history (text-only; images/video/audio aren't
  // replayed into older turns) and shape it for each provider's format.
  const history = getHistory(msg);

  const groqHistoryMessages = history.map((h) => ({
    role: h.role,
    content: h.content,
  }));

  const geminiHistoryContents = history.map((h) => ({
    role: h.role === "assistant" ? "model" : "user",
    parts: [{ text: h.content }],
  }));

  const geminiCurrentParts = [];
  let geminiPromptText = userPrompt;
  if (skippedNotes.length > 0) {
    geminiPromptText = `${geminiPromptText}\n\n${skippedNotes.join("\n")}`;
  }
  if (geminiPromptText) geminiCurrentParts.push({ text: geminiPromptText });
  geminiCurrentParts.push(...imageParts, ...videoParts, ...audioParts);

  const geminiContents = [
    ...geminiHistoryContents,
    { role: "user", parts: geminiCurrentParts },
  ];

  // Call this once, right after a provider call succeeds, to record the
  // exchange for the next "!!" message in this channel, and to let the
  // caller (e.g. events.js) know what the AI actually said, if it wants to.
  function recordExchange(assistantText) {
    addToHistory(msg, "user", userPrompt);
    addToHistory(msg, "assistant", assistantText);
    if (typeof onReply === "function") {
      try {
        onReply(assistantText);
      } catch (err) {
        console.error("onReply callback error:", err);
      }
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

      const result = await model.generateContent({ contents: geminiContents });
      const response = await result.response;

      let text;
      if (response.candidates[0].content?.parts?.length > 1) {
        text = response.candidates[0].content.parts[1].text;
      } else {
        text = response.text();
      }
      sendResponse(msg, text);
      console.log("Gemini Response:", text);
      recordExchange(text);

    } catch (geminiError) {
      console.error("Gemini Error:", geminiError);
      console.log("Falling back to Groq...");

      // Fallback to Groq
      try {
        const tools = [];
        const completion = await groq.chat.completions.create({
          messages: [
            { role: "system", content: process.env.systemInstruction },
            ...groqHistoryMessages,
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
        recordExchange(response);
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
          ...groqHistoryMessages,
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
      recordExchange(response);

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

        const result = await model.generateContent({ contents: geminiContents });
        const response = await result.response;

        let text;
        if (response.candidates[0].content?.parts?.length > 1) {
          text = response.candidates[0].content.parts[1].text;
        } else {
          text = response.text();
        }
        sendResponse(msg, text);
        console.log("Gemini Response:", text);
        recordExchange(text);
      } catch (geminiError) {
        console.error("Gemini Fallback Error:", geminiError);
        msg.reply("Sorry, both AI services failed to process your request.");
      }
    }
  }
}

module.exports = { handleAICommand };