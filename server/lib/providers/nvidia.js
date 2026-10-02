/**
 * NVIDIA NIM provider — uses NVIDIA's OpenAI-compatible API.
 * Reads NVIDIA_API_KEY and NVIDIA_MODEL from environment.
 * Uses the existing `openai` npm package — no new dependencies.
 */

import OpenAI from "openai";
import { buildSystemPrompt } from "../prompt.js";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

// Known-good stable fallback — used when the configured model is unavailable.
// meta/llama-3.3-70b-instruct is a first-party NVIDIA NIM model with high uptime.
const FALLBACK_MODEL = "meta/llama-3.3-70b-instruct";

// Cached client — keyed by API key so a key rotation picks up a fresh client.
let _client = null;
let _clientKey = null;

function getClient() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY is not set in environment.");

  // Rebuild client if the key changed (e.g. server restarted with new .env)
  if (!_client || _clientKey !== apiKey) {
    _client    = new OpenAI({ apiKey, baseURL: NVIDIA_BASE_URL });
    _clientKey = apiKey;
  }
  return _client;
}

/**
 * @param {string} message
 * @param {Array}  history   - [{ role, content }, ...]
 * @param {object|null} ctx  - AI context from buildAIContext()
 * @param {object|null} attachment - { type, data, mimeType, name }
 */
export async function generateWithNvidia(message, history = [], ctx = null, attachment = null) {
  const systemPrompt = buildSystemPrompt(ctx);

  // Read model fresh from env every call — never cache it, so .env edits apply
  // without a server restart. Fall back to the stable Llama model if not set.
  const primaryModel = (process.env.NVIDIA_MODEL || FALLBACK_MODEL).trim();

  // Build user content
  let userContent;
  if (attachment?.type === "image") {
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

  const tryModel = async (model) =>
    getClient().chat.completions.create({
      model,
      messages,
      temperature: 0.6,
      top_p: 0.7,
      max_tokens: 1024,
      stream: false,
    });

  // ── First attempt with the configured model ─────────────────────────────────
  let response;
  try {
    response = await tryModel(primaryModel);
  } catch (primaryErr) {
    const status = primaryErr?.status ?? 0;
    const msg    = primaryErr?.message || "";
    console.error("[NVIDIA] Primary model error:", status, msg, JSON.stringify(primaryErr?.error ?? {}));

    // Decide whether this is a model-level error (bad model ID, not found, invalid)
    // vs an account/key/rate error. Only retry with fallback on model errors.
    const isModelError =
      status === 404 || status === 410 || status === 422 ||
      msg.includes("model_not_found") ||
      msg.includes("does not exist") ||
      msg.includes("not found") ||
      msg.includes("Invalid model") ||
      msg.includes("is not supported") ||
      msg.includes("Unknown model");

    // Only retry if the fallback is different from what we just tried
    if (isModelError && primaryModel !== FALLBACK_MODEL) {
      console.warn(`[NVIDIA] Model "${primaryModel}" rejected — retrying with fallback "${FALLBACK_MODEL}"`);
      try {
        response = await tryModel(FALLBACK_MODEL);
      } catch (fallbackErr) {
        console.error("[NVIDIA] Fallback model also failed:", fallbackErr?.status, fallbackErr?.message);
        throw fallbackErr;
      }
    } else {
      throw primaryErr;
    }
  }

  return response.choices[0].message.content.trim();
}
