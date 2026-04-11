import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../data/feedback.json");

function load() {
  if (!existsSync(DB_PATH)) return [];
  try { return JSON.parse(readFileSync(DB_PATH, "utf-8")); }
  catch { return []; }
}

function save(items) {
  const dir = resolve(__dirname, "../../data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(items, null, 2), "utf-8");
}

export function createFeedback({ ticketId, email, rating, comment }) {
  const items = load();
  const entry = {
    id: `fb_${Date.now()}`,
    ticketId: ticketId || null,
    email: email || null,
    rating,           // 1–5
    comment: comment || "",
    replies: [],      // [{ message, timestamp }]
    createdAt: new Date().toISOString(),
  };
  items.push(entry);
  save(items);
  return entry;
}

export function getAllFeedback() {
  return load().reverse();
}

export function addFeedbackReply(id, message) {
  const items = load();
  const entry = items.find(f => f.id === id);
  if (!entry) return null;
  if (!entry.replies) entry.replies = [];
  entry.replies.push({ message, timestamp: new Date().toISOString() });
  save(items);
  return entry;
}

export function clearAllFeedback() {
  const count = load().length;
  save([]);
  return { removed: count };
}
