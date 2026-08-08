import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../data/tickets.json");

function load() {
  if (!existsSync(DB_PATH)) return [];
  try { return JSON.parse(readFileSync(DB_PATH, "utf-8")); }
  catch { return []; }
}

function save(tickets) {
  const dir = resolve(__dirname, "../../data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(tickets, null, 2), "utf-8");
}

export function createTicket({ email, issue, chat_history }) {
  const tickets = load();
  const id = "NN-" + String(Math.floor(100000 + Math.random() * 900000));
  const ticket = {
    id,
    email,
    issue,
    chat_history,
    status: "open",
    replies: [],
    created_at: new Date().toISOString(),
  };
  tickets.push(ticket);
  save(tickets);
  return ticket;
}

export function getAllTickets() {
  return load();
}

export function updateTicketStatus(id, status) {
  const tickets = load();
  const t = tickets.find(t => t.id === id);
  if (!t) return null;
  t.status = status;
  save(tickets);
  return t;
}

export function updateTicketMessageId(id, messageId) {
  const tickets = load();
  const t = tickets.find(t => t.id === id);
  if (!t) return null;
  t.messageId = messageId;
  save(tickets);
  return t;
}

export function addReply(id, { from, message }) {
  const tickets = load();
  const t = tickets.find(t => t.id === id);
  if (!t) return null;
  if (!t.replies) t.replies = [];
  t.replies.push({ from, message, timestamp: new Date().toISOString() });
  save(tickets);
  return t;
}

export function clearClosedTickets() {
  const tickets = load();
  const kept = tickets.filter(t => t.status !== "closed");
  const removed = tickets.length - kept.length;
  save(kept);
  return { removed, remaining: kept.length };
}
