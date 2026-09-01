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

/** Get all servers belonging to a user — matches by userId, with email fallback. */
export function getServersByUser(userId, email) {
  const servers = load();
  const owned = servers.filter(s => s.userId === userId);
  if (owned.length > 0 || !email) return owned;

  // Fallback: match by email for servers created before userId was correctly set.
  // Re-stamp userId so future lookups work correctly.
  const byEmail = servers.filter(s => s.email === email && s.userId !== userId);
  if (byEmail.length > 0) {
    byEmail.forEach(s => { s.userId = userId; });
    save(servers);
  }
  return byEmail;
}

/** Get a single server by ID, verifying ownership (userId or email). */
export function getServer(id, userId, email) {
  const servers = load();
  const srv = servers.find(s => s.id === id && (s.userId === userId || (email && s.email === email)));
  if (!srv) return null;
  // Fix ownership if matched by email
  if (srv.userId !== userId) {
    srv.userId = userId;
    save(servers);
  }
  return srv;
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
    status:             "pending_setup",
    ram,
    cpu,
    ssd,
    subdomain:          null,
    pterodactylId:      null,
    pterodactylIdentifier: null,
    pterodactylUserId:  pterodactylUserId ?? null,
    invoiceOrderId:     invoiceOrderId ?? null,
    email,
    serverType:         null,
    mcVersion:          null,
    // ── Custom domain fields ────────────────────────────────────────────────
    hostname:           null,   // e.g. "survival" (the subdomain label only)
    hostnameStatus:     null,   // "activating" | "active" | "error" | "removed"
    cloudflareRecordId: null,   // Cloudflare DNS record ID for cleanup
    hostnameCreatedAt:  null,
    hostnameDeclined:   false,  // true if customer explicitly skipped the hostname step
    // ── Subscription fields ─────────────────────────────────────────────────
    subscriptionId:     null,   // internal sub_xxx ID from subscriptions.json
    razorpaySubId:      null,   // Razorpay subscription ID
    subscriptionStatus: null,   // active | pending_payment | halted | cancelled
    expiryDate:         null,   // ISO — when current paid period ends
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
 * Stores the Pterodactyl server ID, identifier, subdomain, type, version.
 */
export function markServerProvisioned(id, { pterodactylId, pterodactylIdentifier, connectionAddress, serverType, mcVersion, name }) {
  const servers = load();
  const srv = servers.find(s => s.id === id);
  if (!srv) return null;
  srv.pterodactylId         = pterodactylId;
  srv.pterodactylIdentifier = pterodactylIdentifier ?? null;
  srv.connectionAddress     = connectionAddress ?? null;
  srv.subdomain             = null;
  srv.status                = "installing";
  srv.serverType            = serverType ?? srv.serverType;
  srv.mcVersion             = mcVersion  ?? srv.mcVersion;
  if (name) srv.name        = name;
  srv.provisionedAt         = new Date().toISOString();
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

/** Check if a hostname is already claimed by any server (excluding a given serverId). */
export function isHostnameTaken(hostname, excludeServerId = null) {
  const servers = load();
  return servers.some(s =>
    s.hostname === hostname &&
    s.hostnameStatus !== "removed" &&
    s.id !== excludeServerId
  );
}

/** Clear hostname fields from a server record (on delete or manual removal). */
export function clearServerHostname(id) {
  const servers = load();
  const srv = servers.find(s => s.id === id);
  if (!srv) return false;
  srv.hostname            = null;
  srv.hostnameStatus      = null;
  srv.cloudflareRecordId  = null;
  srv.hostnameCreatedAt   = null;
  srv.hostnameDeclined    = srv.hostnameDeclined ?? false; // preserve decline flag
  save(servers);
  return true;
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
