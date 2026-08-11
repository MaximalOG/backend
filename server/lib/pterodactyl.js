/**
 * Pterodactyl Application API wrapper.
 * All panel communication happens here — never exposed to the frontend.
 *
 * Node:     1  (node.nethernodes.online)
 * Location: 1
 * Eggs (Nest 1 — Minecraft):
 *   1 = Vanilla Minecraft
 *   2 = Sponge (SpongeVanilla)
 *   3 = Bungeecord
 *   4 = Forge Minecraft
 *   5 = Paper
 */

const PANEL_URL = process.env.PTERODACTYL_URL?.replace(/\/$/, "") || "";
const API_KEY   = process.env.PTERODACTYL_API_KEY || "";
const NODE_ID   = 1;
const LOCATION_ID = 1;
const NEST_ID   = 1;

// ── Egg catalogue — fetched dynamically and cached ───────────────────────────
let _eggCache = null;

export const EGG_NAMES = {
  1: "Vanilla",
  2: "Sponge",
  3: "Bungeecord",
  4: "Forge",
  5: "Paper",
};

// Friendly server type → egg ID mapping for the setup UI
export const SERVER_TYPES = [
  { id: "paper",     label: "Paper",      description: "High-performance, plugin-ready (recommended)", eggId: 5 },
  { id: "vanilla",   label: "Vanilla",    description: "Pure Minecraft — no plugins or mods",           eggId: 1 },
  { id: "forge",     label: "Forge",      description: "Full mod support via Minecraft Forge",          eggId: 4 },
  { id: "bungeecord",label: "BungeeCord", description: "Multi-server network proxy",                    eggId: 3 },
  { id: "sponge",    label: "Sponge",     description: "Vanilla server with SpongeAPI mod support",     eggId: 2 },
];

// ── Low-level fetch helper ────────────────────────────────────────────────────
async function panelFetch(path, options = {}) {
  const url = `${PANEL_URL}/api/application${path}`;
  if (!PANEL_URL || !API_KEY) throw new Error("Pterodactyl is not configured.");

  // Never let an unavailable panel hold a customer request indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const abortParent = () => controller.abort();
  options.signal?.addEventListener?.("abort", abortParent, { once: true });
  let res;
  try {
    res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener?.("abort", abortParent);
  }
  if (!res.ok) {
    let body = "";
    try { body = JSON.stringify(await res.json()); } catch { /* ignore */ }
    throw new Error(`Pterodactyl API error ${res.status} on ${path}: ${body}`);
  }

  // 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

// ── Users ─────────────────────────────────────────────────────────────────────

/** Find an existing Pterodactyl user by email. Returns null if not found. */
export async function getPterodactylUser(email) {
  const data = await panelFetch(`/users?filter[email]=${encodeURIComponent(email)}`);
  return data?.data?.[0]?.attributes ?? null;
}

/** Create a Pterodactyl user account. Returns the user attributes object. */
export async function createPterodactylUser({ email, username, firstName, lastName }) {
  // Pterodactyl usernames: alphanumeric + _ - . (3-255 chars)
  const safeUsername = username
    .replace(/[^a-zA-Z0-9_\-.]/g, "_")
    .slice(0, 32)
    .toLowerCase();

  const data = await panelFetch("/users", {
    method: "POST",
    body: JSON.stringify({
      email,
      username:   safeUsername + "_" + Date.now().toString(36),
      first_name: firstName || "NetherNodes",
      last_name:  lastName  || "User",
      password:   generatePassword(), // they'll use their nethernodes.online login
    }),
  });
  return data.attributes;
}

/** Get or create a Pterodactyl user for the given email. */
export async function ensurePterodactylUser({ email, username, name }) {
  const existing = await getPterodactylUser(email);
  if (existing) return existing;

  const parts = (name || "NetherNodes User").split(" ");
  return createPterodactylUser({
    email,
    username: username || email.split("@")[0],
    firstName: parts[0] || "NetherNodes",
    lastName:  parts.slice(1).join(" ") || "User",
  });
}

// ── Servers ───────────────────────────────────────────────────────────────────

/** Plan name → RAM MB mapping. */
const PLAN_RAM = {
  Nano:    1024,
  Basic:   2048,
  Plus:    3072,
  Starter: 4096,
  Pro:     6144,
  Elite:   8192,
  Ultra:   10240,
  Max:     12288,
  Titan:   16384,
};

/** Plan name → disk MB mapping. */
const PLAN_DISK = {
  Nano:    5120,
  Basic:   10240,
  Plus:    15360,
  Starter: 25600,
  Pro:     40960,
  Elite:   61440,
  Ultra:   81920,
  Max:     102400,
  Titan:   143360,
};

/**
 * Provision a new Minecraft server on Pterodactyl.
 * @param {object} opts
 * @param {number} opts.pterodactylUserId  - Pterodactyl user ID
 * @param {string} opts.serverName         - Display name for the server
 * @param {string} opts.planName           - e.g. "Starter"
 * @param {number} opts.eggId              - Pterodactyl egg ID (1-5)
 * @param {string} opts.mcVersion          - Minecraft version, e.g. "latest" or "1.20.4"
 * @param {string} opts.javaVersion        - Docker image key, e.g. "Java 21"
 * @returns {object} Server attributes from Pterodactyl
 */
export async function provisionServer({ pterodactylUserId, serverName, planName, eggId, mcVersion, javaVersion }) {
  const ram  = PLAN_RAM[planName]  ?? 4096;
  const disk = PLAN_DISK[planName] ?? 25600;

  // Fetch egg to get docker images + variables
  const eggData = await panelFetch(`/nests/${NEST_ID}/eggs/${eggId}?include=variables`);
  const egg      = eggData.attributes;

  // Pick docker image
  const imageMap     = egg.docker_images ?? {};
  const imageKeys    = Object.keys(imageMap);
  const preferredKey = javaVersion && imageKeys.find(k => k === javaVersion);
  const dockerImage  = preferredKey
    ? imageMap[preferredKey]
    : imageMap[imageKeys[0]] ?? egg.docker_image;

  // Build environment variables from egg defaults, overriding MC version
  const environment = {};
  if (egg.relationships?.variables?.data) {
    for (const v of egg.relationships.variables.data) {
      const attr = v.attributes;
      environment[attr.env_variable] = attr.default_value ?? "";
    }
  }
  // Override common version variables
  if (mcVersion && mcVersion !== "latest") {
    if ("MINECRAFT_VERSION" in environment) environment.MINECRAFT_VERSION = mcVersion;
    if ("VANILLA_VERSION"   in environment) environment.VANILLA_VERSION   = mcVersion;
    if ("MC_VERSION"        in environment) environment.MC_VERSION        = mcVersion;
  }
  if ("SERVER_JARFILE" in environment && !environment.SERVER_JARFILE) {
    environment.SERVER_JARFILE = "server.jar";
  }

  const body = {
    name:         serverName.slice(0, 48),
    user:         pterodactylUserId,
    egg:          eggId,
    docker_image: dockerImage,
    startup:      egg.startup,
    environment,
    limits: {
      memory: ram,
      swap:   0,
      disk,
      io:     500,
      cpu:    0,   // unlimited — panel enforces node limits
    },
    feature_limits: {
      databases:   planName === "Nano" || planName === "Basic" || planName === "Plus" ? 1 : 3,
      allocations: 1,
      backups:     planName === "Nano" || planName === "Basic" || planName === "Plus" ? 0 : 3,
    },
    allocation: {
      default: await getNextFreeAllocation(),
    },
  };

  const data = await panelFetch("/servers", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return data.attributes;
}

/** Get the first unassigned allocation on NODE_ID. */
async function getNextFreeAllocation() {
  const data = await panelFetch(`/nodes/${NODE_ID}/allocations?per_page=100`);
  const free = data?.data?.find(a => !a.attributes.assigned);
  if (!free) throw new Error("No free allocations available on node. Contact support.");
  return free.attributes.id;
}

/** Get a server by its Pterodactyl server ID. Accepts an optional AbortSignal for timeout control. */
export async function getPterodactylServer(pterodactylServerId, signal) {
  try {
    const data = await panelFetch(`/servers/${pterodactylServerId}`, signal ? { signal } : {});
    return data?.attributes ?? null;
  } catch {
    return null;
  }
}

/** List all servers for a Pterodactyl user ID. */
export async function getServersByPterodactylUser(pterodactylUserId) {
  const data = await panelFetch(`/servers?filter[user]=${pterodactylUserId}&per_page=50`);
  return data?.data?.map(s => s.attributes) ?? [];
}

/** Suspend a server. */
export async function suspendServer(pterodactylServerId) {
  return panelFetch(`/servers/${pterodactylServerId}/suspend`, { method: "POST" });
}

/** Unsuspend a server. */
export async function unsuspendServer(pterodactylServerId) {
  return panelFetch(`/servers/${pterodactylServerId}/unsuspend`, { method: "POST" });
}

/** Delete a server permanently. */
export async function deleteServer(pterodactylServerId) {
  return panelFetch(`/servers/${pterodactylServerId}`, { method: "DELETE" });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generatePassword(len = 24) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$";
  let pw = "";
  for (let i = 0; i < len; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

/** Returns public server type options for the setup UI. Internal fields (eggId etc.) are not included. */
export function getServerTypes() {
  return SERVER_TYPES.map(({ id, label, description }) => ({ id, label, description }));
}

/** Resolve a public type ID to its private provisioning configuration. */
export function getServerTypeConfig(typeId) {
  return SERVER_TYPES.find(type => type.id === typeId) ?? null;
}
