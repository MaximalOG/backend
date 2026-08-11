/**
 * Server management — file-backed store.
 * Each record links the customer's userId to their Pterodactyl server + user IDs.
 * Pterodactyl handles actual server ops; this file tracks the mapping.
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
  return load().find(s => s.id === id && s.userId === userId) || null;
}

/** Get a server record by Pterodactyl server ID (panel-side ID). */
export function getServerByPterodactylId(pterodactylId) {
  return load().find(s => s.pterodactylId === pterodactylId) || null;
}

/**
 * Create a pending server record after payment.
 * The server is "pending_setup" until the user completes the setup wizard.
 */
export function createPendingServer({ userId, planName, email, ram, cpu, ssd, pterodactylUserId, invoiceOrderId }) {
  const servers = load();
  const server = {
    id:                 `srv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    userId,
    planName,
    name:               `${planName} Server`,
    status:             "pending_setup",   // awaiting user to complete setup wizard
    ram,
    cpu,
    ssd,
    subdomain:          null,              // set after Pterodactyl provisioning
    pterodactylId:      null,              // set after Pterodactyl provisioning
    pterodactylUserId:  pterodactylUserId ?? null,
    invoiceOrderId:     invoiceOrderId ?? null,
    email,
    serverType:         null,
    mcVersion:          null,
    createdAt:          new Date().toISOString(),
    provisionedAt:      null,
  };
  servers.push(server);
  save(servers);
  return server;
}

/** Atomically move a pending server into provisioning, preventing duplicate creates. */
export function beginServerProvisioning(id, userId) {
  const servers = load();
  const srv = servers.find(s => s.id === id && s.userId === userId);
  if (!srv || srv.status !== "pending_setup") return null;
  srv.status = "provisioning";
  save(servers);
  return srv;
}

/**
 * Mark a server as provisioned after Pterodactyl creates it.
 * Stores the Pterodactyl server ID, subdomain, type, version.
 */
export function markServerProvisioned(id, { pterodactylId, connectionAddress, serverType, mcVersion, name }) {
  const servers = load();
  const srv = servers.find(s => s.id === id);
  if (!srv) return null;
  srv.pterodactylId  = pterodactylId;
  srv.connectionAddress = connectionAddress ?? null;
  srv.subdomain      = null;
  srv.status         = "installing";   // Pterodactyl is installing the server
  srv.serverType     = serverType ?? srv.serverType;
  srv.mcVersion      = mcVersion  ?? srv.mcVersion;
  if (name) srv.name = name;
  srv.provisionedAt  = new Date().toISOString();
  save(servers);
  return srv;
}

/** Update server status. Used for start/stop polling. */
export function setServerStatus(id, userId, status) {
  const servers = load();
  const srv = servers.find(s => s.id === id && s.userId === userId);
  if (!srv) return null;
  srv.status = status;
  save(servers);
  return srv;
}

/** Update any fields on a server record. */
export function updateServer(id, fields) {
  const servers = load();
  const srv = servers.find(s => s.id === id);
  if (!srv) return null;
  Object.assign(srv, fields);
  save(servers);
  return srv;
}

/** Delete a server record. */
export function deleteServerRecord(id) {
  const servers = load();
  const idx = servers.findIndex(s => s.id === id);
  if (idx === -1) return false;
  servers.splice(idx, 1);
  save(servers);
  return true;
}
