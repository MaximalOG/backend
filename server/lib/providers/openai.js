import OpenAI from "openai";
import { buildSystemPrompt } from "../prompt.js";

let client = null;
function getClient() {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    const isOpenRouter = (apiKey || "").startsWith("sk-or-");
    client = new OpenAI({
      apiKey,
      ...(isOpenRouter && { baseURL: "https://openrouter.ai/api/v1" }),
    });
  }
  return client;
}

/**
 * @param {string} message
 * @param {Array} history
 * @param {object|null} ctx
 * @param {object|null} attachment - { type: "image"|"text", data: string, mimeType: string, name: string }
 */
export async function generateWithOpenAI(message, history = [], ctx = null, attachment = null) {
  const systemPrompt = buildSystemPrompt(ctx);

  // Build user content — supports text + image vision
  let userContent;
  if (attachment?.type === "image") {
    userContent = [
      { type: "text", text: message || "Please analyze this image." },
      {
        type: "image_url",
        image_url: {
          url: `data:${attachment.mimeType};base64,${attachment.data}`,
          detail: "low", // low = faster + cheaper, sufficient for screenshots
        },
      },
    ];
  } else if (attachment?.type === "text") {
    // Inject file content as context in the message
    userContent = `${message}\n\n[Attached file: ${attachment.name}]\n\`\`\`\n${attachment.data}\n\`\`\``;
  } else {
    userContent = message;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userContent },
  ];

  const response = await getClient().chat.completions.create({
    model: process.env.OPENAI_MODEL || "openai/gpt-4o-mini",
    messages,
    max_tokens: 500,
  });

  return response.choices[0].message.content.trim();
}
