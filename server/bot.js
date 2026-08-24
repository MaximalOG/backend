/**
 * NetherNodes Bot API — /bot/* routes
 *
 * Authentication: static secret key via X-Bot-Key header.
 * This is a system-actor API — not user-scoped.
 * All Pterodactyl/Cloudflare credentials stay server-side.
 * The bot gets results, never raw credentials.
 *
 * Add to backend/.env:
 *   BOT_API_KEY=some-long-random-secret
 */

import express from "express";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// ── Bot auth middleware ───────────────────────────────────────────────────────
router.use((req, res, next) => {
  const key = req.headers["x-bot-key"];
  const expected = process.env.BOT_API_KEY;

  if (!expected) {
    return res.status(503).json({ error: "Bot API not configured on this server." });
  }
  if (!key || key !== expected) {
    console.warn(`[Bot] Unauthorized request from ${req.ip} to ${req.path}`);
    return res.status(401).json({ error: "Unauthorized — invalid or missing X-Bot-Key." });
  }
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadJson(relPath) {
  const full = resolve(__dirname, "../data", relPath);
  if (!existsSync(full)) return [];
  try { return JSON.parse(readFileSync(full, "utf-8")); } catch { return []; }
}

function safeUser(u) {
  if (!u) return null;
  return {
    id:            u.id,
    name:          u.name,
    username:      u.username,
    email:         u.email,
    emailVerified: u.emailVerified,
    createdAt:     u.createdAt,
    // Never expose passwordHash, tokens, etc.
  };
}

function safeServer(s) {
  if (!s) return null;
  return {
    id:                 s.id,
    userId:             s.userId,
    email:              s.email,
    name:               s.name,
    planName:           s.planName,
    status:             s.status,
    ram:                s.ram,
    cpu:                s.cpu,
    ssd:                s.ssd,
    serverType:         s.serverType,
    mcVersion:          s.mcVersion,
    connectionAddress:  s.connectionAddress,
    hostname:           s.hostname ?? null,
    hostnameStatus:     s.hostnameStatus ?? null,
    customAddress:      s.hostname ? `${s.hostname}.nethernodes.online` : null,
    pterodactylId:      s.pterodactylId,
    createdAt:          s.createdAt,
    provisionedAt:      s.provisionedAt,
  };
}

// ── GET /bot/ping ─────────────────────────────────────────────────────────────
// Health check — bot uses this to verify connectivity + key validity.
router.get("/ping", (_req, res) => {
  res.json({ ok: true, service: "NetherNodes Bot API", timestamp: new Date().toISOString() });
});

// ── GET /bot/plans ────────────────────────────────────────────────────────────
// All plans with live prices — used for bot pricing responses.
router.get("/plans", (_req, res) => {
  const path = resolve(__dirname, "../data/plan_prices.json");
  const DEFAULT = {
    Nano:    { ram: "1GB",  cpu: "50%",  ssd: "5GB",   priceInr: 69,   tier: "Entry" },
    Basic:   { ram: "2GB",  cpu: "100%", ssd: "10GB",  priceInr: 0,    tier: "Entry" },
    Plus:    { ram: "3GB",  cpu: "150%", ssd: "15GB",  priceInr: 129,  tier: "Entry" },
    Starter: { ram: "4GB",  cpu: "200%", ssd: "25GB",  priceInr: 199,  tier: "Community" },
    Pro:     { ram: "6GB",  cpu: "250%", ssd: "40GB",  priceInr: 329,  tier: "Community" },
    Elite:   { ram: "8GB",  cpu: "300%", ssd: "60GB",  priceInr: 469,  tier: "Community" },
    Ultra:   { ram: "10GB", cpu: "350%", ssd: "80GB",  priceInr: 649,  tier: "Advanced" },
    Max:     { ram: "12GB", cpu: "400%", ssd: "100GB", priceInr: 829,  tier: "Advanced" },
    Titan:   { ram: "16GB", cpu: "450%", ssd: "140GB", priceInr: 1099, tier: "Advanced" },
  };
  let overrides = {};
  try { if (existsSync(path)) overrides = JSON.parse(readFileSync(path, "utf-8")); } catch {}
  const plans = Object.entries(DEFAULT).map(([name, spec]) => ({
    name,
    ...spec,
    ...(overrides[name] ?? {}),
  }));
  res.json(plans);
});

// ── GET /bot/servers ──────────────────────────────────────────────────────────
// All servers across all users. Bot uses this for status commands.
router.get("/servers", (req, res) => {
  const servers = loadJson("servers.json");
  const { status, userId, email } = req.query;

  let filtered = servers;
  if (status)  filtered = filtered.filter(s => s.status === status);
  if (userId)  filtered = filtered.filter(s => s.userId === userId);
  if (email)   filtered = filtered.filter(s => s.email === email);

  res.json(filtered.map(safeServer));
});

// ── GET /bot/servers/:id ──────────────────────────────────────────────────────
// Single server by NetherNodes server ID.
router.get("/servers/:id", (req, res) => {
  const servers = loadJson("servers.json");
  const srv = servers.find(s => s.id === req.params.id);
  if (!srv) return res.status(404).json({ error: "Server not found." });
  res.json(safeServer(srv));
});

// ── GET /bot/servers/by-email/:email ─────────────────────────────────────────
// All servers for a given customer email — for "my server" type bot commands.
router.get("/servers/by-email/:email", (req, res) => {
  const servers = loadJson("servers.json");
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const matches = servers.filter(s => s.email === email);
  res.json(matches.map(safeServer));
});

// ── POST /bot/servers/:id/power ───────────────────────────────────────────────
// Send a power signal to a server. Bot uses this for restart/stop commands.
// Requires the sendPowerSignal function — imported from main index via the
// exported helper. We re-implement the call here to stay self-contained.
router.post("/servers/:id/power", async (req, res) => {
  const { signal } = req.body;
  if (!["start", "stop", "restart", "kill"].includes(signal)) {
    return res.status(400).json({ error: "signal must be start, stop, restart, or kill" });
  }

  const servers = loadJson("servers.json");
  const srv = servers.find(s => s.id === req.params.id);
  if (!srv) return res.status(404).json({ error: "Server not found." });
  if (!srv.pterodactylId) return res.status(400).json({ error: "Server is not yet provisioned." });

  const identifier = srv.pterodactylIdentifier || srv.pterodactylId;
  const panelUrl   = process.env.PTERODACTYL_URL?.replace(/\/$/, "");
  const clientKey  = process.env.PTERODACTYL_CLIENT_KEY;

  if (!panelUrl || !clientKey) {
    return res.status(503).json({ error: "Pterodactyl Client API not configured." });
  }

  try {
    const ptRes = await fetch(`${panelUrl}/api/client/servers/${identifier}/power`, {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${clientKey}`,
        "Content-Type": "application/json",
        Accept:         "application/json",
      },
      body: JSON.stringify({ signal }),
    });
    if (!ptRes.ok && ptRes.status !== 204) {
      const body = await ptRes.json().catch(() => ({}));
      return res.status(502).json({ error: `Panel error: ${body?.errors?.[0]?.detail ?? ptRes.status}` });
    }
    console.log(`[Bot] Power signal "${signal}" → server ${srv.id} (${identifier})`);
    res.json({ ok: true, signal, serverId: srv.id, serverName: srv.name });
  } catch (err) {
    res.status(502).json({ error: `Network error: ${err.message}` });
  }
});

// ── GET /bot/users ────────────────────────────────────────────────────────────
// All NetherNodes user accounts — bot uses this for account lookup.
router.get("/users", (req, res) => {
  const users = loadJson("users_app.json");
  const { email, username } = req.query;

  let filtered = users;
  if (email)    filtered = filtered.filter(u => u.email === email.toLowerCase());
  if (username) filtered = filtered.filter(u => u.username === username.toLowerCase());

  res.json(filtered.map(safeUser));
});

// ── GET /bot/users/:id ────────────────────────────────────────────────────────
// Single user by NetherNodes user ID.
router.get("/users/:id", (req, res) => {
  const users = loadJson("users_app.json");
  const u = users.find(u => u.id === req.params.id);
  if (!u) return res.status(404).json({ error: "User not found." });
  res.json(safeUser(u));
});

// ── GET /bot/tickets ──────────────────────────────────────────────────────────
// Open/pending support tickets — bot can relay these to a Discord channel.
router.get("/tickets", (req, res) => {
  const tickets = loadJson("tickets.json");
  const { status } = req.query;
  const filtered = status ? tickets.filter(t => t.status === status) : tickets;
  res.json(filtered.map(t => ({
    id:         t.id,
    email:      t.email,
    status:     t.status,
    issue:      t.issue,
    createdAt:  t.created_at,
    replies:    (t.replies ?? []).length,
  })));
});

// ── GET /bot/stats ────────────────────────────────────────────────────────────
// High-level platform stats — useful for admin bot commands.
router.get("/stats", (req, res) => {
  const servers = loadJson("servers.json");
  const users   = loadJson("users_app.json");
  const tickets = loadJson("tickets.json");

  const serversByStatus = servers.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});

  res.json({
    totalUsers:          users.length,
    verifiedUsers:       users.filter(u => u.emailVerified).length,
    totalServers:        servers.length,
    activeServers:       servers.filter(s => s.status === "running").length,
    pendingSetupServers: servers.filter(s => s.status === "pending_setup").length,
    serversByStatus,
    openTickets:         tickets.filter(t => t.status === "open").length,
    pendingTickets:      tickets.filter(t => t.status === "pending").length,
  });
});

export default router;
