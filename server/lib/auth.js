/**
 * Admin authentication — production-ready.
 * bcrypt for password hashing, Bearer tokens for sessions.
 * Persists admin/staff users to data/users.json.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import bcrypt from "bcrypt";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const USERS_PATH = resolve(__dirname, "../../data/users.json");
const BCRYPT_ROUNDS = 12;
const SESSION_TTL   = 8 * 60 * 60 * 1000; // 8 hours

const SESSIONS = new Map(); // token → { userId, expiresAt }

// ── Persistence ───────────────────────────────────────────────────────────────
function loadUsers() {
  if (!existsSync(USERS_PATH)) return { users: [] };
  try { return JSON.parse(readFileSync(USERS_PATH, "utf-8")); }
  catch { return { users: [] }; }
}

function saveUsers(data) {
  writeFileSync(USERS_PATH, JSON.stringify(data, null, 2), "utf-8");
}

// ── Login ─────────────────────────────────────────────────────────────────────
// Supports both legacy SHA-256 hashes and new bcrypt hashes transparently.
export async function login(username, password) {
  const { users } = loadUsers();
  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return null;

  let valid = false;

  // Detect hash type: bcrypt hashes start with "$2b$" or "$2a$"
  if (user.passwordHash.startsWith("$2")) {
    valid = await bcrypt.compare(password, user.passwordHash).catch(() => false);
  } else {
    // Legacy SHA-256 — compare and migrate to bcrypt on success
    const sha = crypto.createHash("sha256").update(password).digest("hex");
    if (sha === user.passwordHash) {
      valid = true;
      // Migrate: replace SHA-256 hash with bcrypt
      user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      saveUsers({ users });
      console.log(`[Auth] Migrated ${username} password to bcrypt`);
    }
  }

  if (!valid) {
    console.warn(`[Auth] Failed admin login: ${username}`);
    return null;
  }

  const token = crypto.randomBytes(32).toString("hex");
  SESSIONS.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL });
  console.log(`[Auth] Admin login: ${username}`);

  return {
    token,
    user: { id: user.id, username: user.username, role: user.role, permissions: user.permissions },
  };
}

export function logout(token) {
  SESSIONS.delete(token);
}

export function getSession(token) {
  if (!token) return null;
  const session = SESSIONS.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) { SESSIONS.delete(token); return null; }
  const { users } = loadUsers();
  const user = users.find(u => u.id === session.userId);
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role, permissions: user.permissions };
}

// ── Middleware ────────────────────────────────────────────────────────────────
export function requireAuth(req, res, next) {
  const token = req.headers["x-admin-token"] || req.cookies?.adminToken;
  const user  = getSession(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  req.adminUser = user;
  next();
}

export function requireOwner(req, res, next) {
  if (req.adminUser?.role !== "owner") return res.status(403).json({ error: "Owner access required" });
  next();
}

// ── Staff management ──────────────────────────────────────────────────────────
export function getAllStaff() {
  const { users } = loadUsers();
  return users.filter(u => u.role !== "owner").map(u => ({
    id: u.id, username: u.username, role: u.role,
    permissions: u.permissions, createdAt: u.createdAt,
  }));
}

export async function createStaff({ username, password, permissions }) {
  if (!username || !password) throw new Error("Username and password required.");
  if (password.length < 6)    throw new Error("Password must be at least 6 characters.");

  const data = loadUsers();
  if (data.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error("Username already exists");
  }

  const staff = {
    id:           `staff_${Date.now()}`,
    username:     username.trim().replace(/[<>"']/g, ""),
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    role:         "staff",
    permissions:  permissions || [],
    createdAt:    new Date().toISOString(),
  };

  data.users.push(staff);
  saveUsers(data);
  return { id: staff.id, username: staff.username, role: staff.role, permissions: staff.permissions };
}

export async function updateStaff(id, { permissions, password }) {
  const data = loadUsers();
  const user = data.users.find(u => u.id === id);
  if (!user || user.role === "owner") throw new Error("Staff not found");
  if (permissions !== undefined) user.permissions = permissions;
  if (password) {
    if (password.length < 6) throw new Error("Password must be at least 6 characters.");
    user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  }
  saveUsers(data);
  return { id: user.id, username: user.username, permissions: user.permissions };
}

export function deleteStaff(id) {
  const data = loadUsers();
  const idx  = data.users.findIndex(u => u.id === id && u.role !== "owner");
  if (idx === -1) throw new Error("Staff not found");
  data.users.splice(idx, 1);
  saveUsers(data);
}

export const ALL_PERMISSIONS = [
  { key: "tickets",          label: "Support Tickets" },
  { key: "banner_sale",      label: "Banner Sale" },
  { key: "promo_codes",      label: "Promo Codes" },
  { key: "feedback",         label: "Customer Feedback" },
  { key: "staff_management", label: "Staff Management (Owner only)" },
];
