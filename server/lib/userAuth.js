/**
 * User authentication — production-ready.
 * bcrypt for password hashing, Bearer tokens for sessions.
 * Persists users to data/users_app.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import bcrypt from "bcrypt";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = resolve(__dirname, "../../data/users_app.json");
const BCRYPT_ROUNDS = 12;
const SESSION_TTL   = 7 * 24 * 60 * 60 * 1000; // 7 days

// In-memory session store: token → { userId, expiresAt }
const USER_SESSIONS = new Map();

// ── Persistence ───────────────────────────────────────────────────────────────
function loadUsers() {
  if (!existsSync(DB_PATH)) return [];
  try { return JSON.parse(readFileSync(DB_PATH, "utf-8")); }
  catch { return []; }
}

function saveUsers(users) {
  const dir = resolve(__dirname, "../../data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(users, null, 2), "utf-8");
}

// ── Validation helpers ────────────────────────────────────────────────────────
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim());
}

function sanitizeName(name) {
  return String(name).trim().replace(/[<>"']/g, "").slice(0, 80);
}

// ── Signup ────────────────────────────────────────────────────────────────────
export async function userSignup(name, email, password) {
  // Input validation
  if (!name || !email || !password) throw new Error("Name, email and password are required.");
  if (!isValidEmail(email))         throw new Error("Please enter a valid email address.");
  if (password.length < 6)          throw new Error("Password must be at least 6 characters.");

  const cleanEmail = email.trim().toLowerCase();
  const cleanName  = sanitizeName(name);

  const users = loadUsers();
  if (users.find(u => u.email === cleanEmail)) {
    throw new Error("An account with this email already exists.");
  }

  // bcrypt hash — never store plain text
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const user = {
    id:           `user_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    name:         cleanName,
    email:        cleanEmail,
    passwordHash,
    emailVerified: false, // placeholder for future email verification
    createdAt:    new Date().toISOString(),
  };

  users.push(user);
  saveUsers(users);

  console.log(`[Auth] Signup: ${cleanEmail} (${user.id})`);

  const token = _createSession(user.id);
  return { token, user: _publicUser(user) };
}

// ── Login ─────────────────────────────────────────────────────────────────────
export async function userLogin(email, password) {
  if (!email || !password) throw new Error("Email and password are required.");
  if (!isValidEmail(email)) throw new Error("Please enter a valid email address.");

  const cleanEmail = email.trim().toLowerCase();
  const users = loadUsers();
  const user  = users.find(u => u.email === cleanEmail);

  // Use bcrypt.compare — timing-safe, works with both old SHA256 and new bcrypt hashes
  const valid = user && await bcrypt.compare(password, user.passwordHash).catch(() => false);

  if (!valid) {
    console.warn(`[Auth] Failed login attempt: ${cleanEmail}`);
    throw new Error("Invalid email or password.");
  }

  console.log(`[Auth] Login: ${cleanEmail}`);
  const token = _createSession(user.id);
  return { token, user: _publicUser(user) };
}

// ── Logout ────────────────────────────────────────────────────────────────────
export function userLogout(token) {
  USER_SESSIONS.delete(token);
}

// ── Token verification ────────────────────────────────────────────────────────
export function getUserFromToken(token) {
  if (!token) return null;
  const session = USER_SESSIONS.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    USER_SESSIONS.delete(token);
    return null;
  }
  const users = loadUsers();
  const user  = users.find(u => u.id === session.userId);
  if (!user) return null;
  return _publicUser(user);
}

// ── Express middleware ────────────────────────────────────────────────────────
export function requireUser(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const user  = getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  req.user = user;
  next();
}

// ── Internal helpers ──────────────────────────────────────────────────────────
function _createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  USER_SESSIONS.set(token, { userId, expiresAt: Date.now() + SESSION_TTL });
  return token;
}

function _publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}
