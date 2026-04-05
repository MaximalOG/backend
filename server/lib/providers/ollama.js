import { buildSystemPrompt } from "../prompt.js";

const OLLAMA_ENDPOINT = process.env.OLLAMA_ENDPOINT || "http://localhost:11434/api/generate";
const OLLAMA_MODEL    = process.env.OLLAMA_MODEL    || "llama3";

export async function generateWithOllama(message, history = [], ctx = null) {
  const systemPrompt = buildSystemPrompt(ctx);
  const historyText  = history
    .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  const prompt = `${systemPrompt}\n\n${historyText}\nUser: ${message}\nAssistant:`;

  const res  = await fetch(OLLAMA_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  });
  const data = await res.json();
  return data.response.trim();
}
