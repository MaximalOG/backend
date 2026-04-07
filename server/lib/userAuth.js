/**
 * User authentication (separate from admin auth).
 * Handles signup, login, token verification for regular users.
 * Tokens stored in-memory; user records persisted to data/users_app.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../data/users_app.json");
const USER_SESSIONS = new Map(); // token → { userId, expiresAt }
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

function hash(password) {
  return crypto.createHash("sha256").update(password + "nn_user_salt").digest("hex");
}

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

/** Create a new user account. Returns { token, user } or throws. */
export function userSignup(name, email, password) {
  if (!name || !email || !password) throw new Error("Name, email and password are required.");
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");

  const users = loadUsers();
  const exists = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (exists) throw new Error("An account with this email already exists.");

  const user = {
    id: `user_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    name: name.trim(),
    email: email.trim().toLowerCase(),
    passwordHash: hash(password),
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  saveUsers(users);

  const token = crypto.randomBytes(32).toString("hex");
  USER_SESSIONS.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL });

  return {
    token,
    user: { id: user.id, name: user.name, email: user.email },
  };
}

/** Authenticate an existing user. Returns { token, user } or throws. */
export function userLogin(email, password) {
  if (!email || !password) throw new Error("Email and password are required.");

  const users = loadUsers();
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user || user.passwordHash !== hash(password)) {
    throw new Error("Invalid email or password.");
  }

  const token = crypto.randomBytes(32).toString("hex");
  USER_SESSIONS.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL });

  return {
    token,
    user: { id: user.id, name: user.name, email: user.email },
  };
}

/** Verify a Bearer token. Returns user object or null. */
export function getUserFromToken(token) {
  if (!token) return null;
  const session = USER_SESSIONS.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) { USER_SESSIONS.delete(token); return null; }

  const users = loadUsers();
  const user = users.find(u => u.id === session.userId);
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email };
}

/** Express middleware — attaches req.user or returns 401. */
export function requireUser(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const user = getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  req.user = user;
  next();
}

/** Invalidate a user token. */
export function userLogout(token) {
  USER_SESSIONS.delete(token);
}
