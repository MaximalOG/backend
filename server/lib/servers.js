/**
 * Server management — file-backed store.
 * In production, replace with Pterodactyl API or your panel integration.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../data/servers.json");

function load() {
  if (!existsSync(DB_PATH)) return [];
  try { return JSON.parse(readFileSync(DB_PATH, "utf-8")); }
  catch { return []; }
}

function save(servers) {
  const dir = resolve(__dirname, "../../data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(servers, null, 2), "utf-8");
}

/** Get all servers belonging to a user. */
export function getServersByUser(userId) {
  return load().filter(s => s.userId === userId);
}

/** Get a single server by ID, verifying ownership. */
export function getServer(id, userId) {
  const servers = load();
  return servers.find(s => s.id === id && s.userId === userId) || null;
}

/** Create a server record after successful payment. */
export function createServer({ userId, planName, email, ram, cpu, ssd }) {
  const servers = load();
  const subdomain = `${email.split("@")[0].replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 16)}-${Date.now().toString(36)}`;
  const server = {
    id: `srv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    userId,
    name: `${planName} Server`,
    plan: planName,
    status: "stopped",
    ram,
    cpu,
    ssd,
    subdomain: `${subdomain}.nethernodes.in`,
    createdAt: new Date().toISOString(),
  };
  servers.push(server);
  save(servers);
  return server;
}

/** Update server status. */
export function setServerStatus(id, userId, status) {
  const servers = load();
  const srv = servers.find(s => s.id === id && s.userId === userId);
  if (!srv) return null;
  srv.status = status;
  save(servers);
  return srv;
}
