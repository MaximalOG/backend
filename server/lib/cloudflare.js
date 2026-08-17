/**
 * Cloudflare DNS API helper for NetherNodes custom Minecraft domains.
 *
 * Creates SRV records so customers can connect with:
 *   myserver.nethernodes.online
 * instead of:
 *   mc.nethernodes.online:25571
 *
 * SECURITY: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID are read from
 * process.env at call time — never at module load. They never leave the backend.
 */

const CF_BASE = "https://api.cloudflare.com/client/v4";
const DOMAIN  = "nethernodes.online";
const MC_HOST = "mc.nethernodes.online"; // SRV target — never expose raw IP to customers

// ── Reserved names customers cannot claim ─────────────────────────────────────
export const RESERVED_NAMES = new Set([
  "www", "api", "panel", "mc", "mail", "ftp", "cdn", "status", "admin",
  "support", "billing", "dashboard", "assets", "node", "ns1", "ns2",
  "smtp", "pop", "imap", "dev", "staging", "test", "backup", "monitor",
  "play", "join", "login", "auth", "app", "static", "media", "img",
]);

// ── Validation ────────────────────────────────────────────────────────────────
export function validateHostname(name) {
  if (!name || typeof name !== "string") return "Hostname is required.";
  const clean = name.trim().toLowerCase();
  if (clean.length < 3)   return "Hostname must be at least 3 characters.";
  if (clean.length > 32)  return "Hostname must be 32 characters or less.";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(clean)) {
    return "Hostname can only contain letters, numbers, and hyphens. It cannot start or end with a hyphen.";
  }
  if (RESERVED_NAMES.has(clean)) return `"${clean}" is a reserved name and cannot be used.`;
  return null; // valid
}

export function parseHostname(name) {
  return name.trim().toLowerCase();
}

export function fullHostname(name) {
  return `${parseHostname(name)}.${DOMAIN}`;
}

// ── Cloudflare API fetch ──────────────────────────────────────────────────────
async function cfFetch(path, options = {}) {
  const token  = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;

  if (!token || !zoneId) {
    throw new Error("Cloudflare is not configured (CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID missing).");
  }

  const url = `${CF_BASE}/zones/${zoneId}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const data = await res.json();

  if (!data.success) {
    const errMsg = data.errors?.map(e => `${e.code}: ${e.message}`).join(", ") ?? "Unknown Cloudflare error";
    throw new Error(`Cloudflare API error: ${errMsg}`);
  }

  return data;
}

// ── SRV record management ─────────────────────────────────────────────────────

/**
 * Create an SRV record:
 *   _minecraft._tcp.{name}.nethernodes.online → mc.nethernodes.online:{port}
 *
 * @param {string} name  - subdomain label, e.g. "survival"
 * @param {number} port  - Minecraft server port, e.g. 25571
 * @returns {string}     - Cloudflare record ID
 */
export async function createSrvRecord(name, port) {
  const hostname = parseHostname(name);
  const data = await cfFetch("/dns_records", {
    method: "POST",
    body: JSON.stringify({
      type:    "SRV",
      name:    `_minecraft._tcp.${hostname}`,
      data: {
        service:  "_minecraft",
        proto:    "_tcp",
        name:     `${hostname}.${DOMAIN}`,
        priority: 0,
        weight:   0,
        port:     Number(port),
        target:   MC_HOST,
      },
      ttl: 120,
      comment: `NetherNodes customer: ${hostname}.${DOMAIN}`,
    }),
  });

  const recordId = data.result?.id;
  if (!recordId) throw new Error("Cloudflare did not return a record ID.");
  console.log(`[Cloudflare] SRV created: ${hostname}.${DOMAIN} → ${MC_HOST}:${port} (${recordId})`);
  return recordId;
}

/**
 * Update an existing SRV record (e.g. when port changes).
 */
export async function updateSrvRecord(recordId, name, port) {
  const hostname = parseHostname(name);
  await cfFetch(`/dns_records/${recordId}`, {
    method: "PUT",
    body: JSON.stringify({
      type:    "SRV",
      name:    `_minecraft._tcp.${hostname}`,
      data: {
        service:  "_minecraft",
        proto:    "_tcp",
        name:     `${hostname}.${DOMAIN}`,
        priority: 0,
        weight:   0,
        port:     Number(port),
        target:   MC_HOST,
      },
      ttl: 120,
      comment: `NetherNodes customer: ${hostname}.${DOMAIN}`,
    }),
  });
  console.log(`[Cloudflare] SRV updated: ${hostname}.${DOMAIN} → ${MC_HOST}:${port} (${recordId})`);
}

/**
 * Delete a DNS record by its Cloudflare record ID.
 * Safe to call even if the record was already deleted (logs a warning).
 */
export async function deleteSrvRecord(recordId) {
  if (!recordId) return;
  try {
    await cfFetch(`/dns_records/${recordId}`, { method: "DELETE" });
    console.log(`[Cloudflare] SRV deleted: ${recordId}`);
  } catch (err) {
    // 81044 = record not found — treat as success
    if (err.message.includes("81044") || err.message.includes("not found")) {
      console.warn(`[Cloudflare] Record ${recordId} already gone — skipping`);
      return;
    }
    throw err;
  }
}

/**
 * Check if a hostname is already in use as a Cloudflare DNS record.
 * Returns true if available, false if taken.
 */
export async function checkHostnameAvailability(name) {
  const hostname = parseHostname(name);
  const data = await cfFetch(`/dns_records?type=SRV&name=_minecraft._tcp.${hostname}.${DOMAIN}&per_page=1`);
  return (data.result?.length ?? 0) === 0;
}

/**
 * List all NetherNodes SRV records in the zone (for admin/reconciliation).
 */
export async function listAllSrvRecords() {
  const data = await cfFetch("/dns_records?type=SRV&per_page=100&comment.contains=NetherNodes+customer");
  return data.result ?? [];
}
