/**
 * NVIDIA NIM provider — uses NVIDIA's OpenAI-compatible API.
 * Reads NVIDIA_API_KEY and NVIDIA_MODEL from environment.
 * Uses the existing `openai` npm package — no new dependencies.
 */

import OpenAI from "openai";
import { buildSystemPrompt } from "../prompt.js";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODEL   = "z-ai/glm-5-3";

let client = null;

function getClient() {
  if (!client) {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      throw new Error("NVIDIA_API_KEY is not set in environment.");
    }
    client = new OpenAI({
      apiKey,
      baseURL: NVIDIA_BASE_URL,
    });
  }
  return client;
}

/**
 * @param {string} message
 * @param {Array}  history   - [{ role, content }, ...]
 * @param {object|null} ctx  - AI context from buildAIContext()
 * @param {object|null} attachment - { type, data, mimeType, name }
 */
export async function generateWithNvidia(message, history = [], ctx = null, attachment = null) {
  const systemPrompt = buildSystemPrompt(ctx);
  const primaryModel  = process.env.NVIDIA_MODEL || DEFAULT_MODEL;

  // Build user content — preserve existing attachment handling
  let userContent;
  if (attachment?.type === "image") {
    // NVIDIA NIM supports vision on compatible models; send as image_url
    userContent = [
      { type: "text", text: message || "Please analyze this image." },
      {
        type: "image_url",
        image_url: {
          url: `data:${attachment.mimeType};base64,${attachment.data}`,
          detail: "low",
        },
      },
    ];
  } else if (attachment?.type === "text") {
    userContent = `${message}\n\n[Attached file: ${attachment.name}]\n\`\`\`\n${attachment.data}\n\`\`\``;
  } else {
    userContent = message;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userContent },
  ];

  const tryModel = async (model) => {
    return getClient().chat.completions.create({
      model,
      messages,
      temperature: 0.6,
      top_p: 0.7,
      max_tokens: 1024,
      stream: false,
    });
  };

  let response;
  try {
    response = await tryModel(primaryModel);
  } catch (err) {
    const status  = err?.status ?? 0;
    const errMsg  = err?.message || "";
    console.error("[NVIDIA Provider Error]", status, errMsg, JSON.stringify(err?.error ?? {}));

    // If the configured model doesn't exist / is unavailable, retry with the
    // known-good fallback instead of surfacing a confusing "server busy" error.
    const isModelError = status === 404 || status === 422
      || errMsg.includes("model_not_found")
      || errMsg.includes("does not exist")
      || errMsg.includes("not found")
      || errMsg.includes("Invalid model");

    if (isModelError && primaryModel !== DEFAULT_MODEL) {
      console.warn(`[NVIDIA] Model "${primaryModel}" unavailable — retrying with fallback "${DEFAULT_MODEL}"`);
      try {
        response = await tryModel(DEFAULT_MODEL);
      } catch (fallbackErr) {
        console.error("[NVIDIA Fallback Error]", fallbackErr?.status, fallbackErr?.message);
        throw fallbackErr;
      }
    } else {
      throw err;
    }
  }

  return response.choices[0].message.content.trim();
}
