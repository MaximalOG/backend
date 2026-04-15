/**
 * User authentication — production-ready.
 * JWT tokens, bcrypt (10 rounds), email verification, password reset.
 * File-based persistence (data/users_app.json).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const __dirname     = dirname(fileURLToPath(import.meta.url));
const DB_PATH       = resolve(__dirname, "../../data/users_app.json");
const BCRYPT_ROUNDS = 10;
const JWT_SECRET    = process.env.JWT_SECRET || "nn_dev_secret_change_in_production";
const JWT_EXPIRES   = "7d";
const VERIFY_TTL    = 24 * 60 * 60 * 1000;   // 24 hours
const RESET_TTL     = 30 * 60 * 1000;         // 30 minutes

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

// ── Validation ────────────────────────────────────────────────────────────────
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim());
}

function isValidUsername(username) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(String(username));
}

function validatePassword(password) {
  if (!password || password.length < 8)       return "Password must be at least 8 characters.";
  if (!/[A-Z]/.test(password))                return "Password must contain at least one uppercase letter.";
  if (!/[a-z]/.test(password))                return "Password must contain at least one lowercase letter.";
  if (!/[0-9]/.test(password))                return "Password must contain at least one number.";
  return null; // valid
}

function sanitize(str, maxLen = 80) {
  return String(str).trim().replace(/[<>"'`]/g, "").slice(0, maxLen);
}

// ── JWT helpers ───────────────────────────────────────────────────────────────
function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// ── Public user shape (never expose passwordHash) ─────────────────────────────
function publicUser(user) {
  return {
    id:            user.id,
    name:          user.name,
    username:      user.username,
    email:         user.email,
    emailVerified: user.emailVerified,
  };
}

// ── Signup ────────────────────────────────────────────────────────────────────
export async function userSignup(name, username, email, password) {
  if (!name || !username || !email || !password)
    throw new Error("Name, username, email and password are required.");

  if (!isValidEmail(email))
    throw new Error("Please enter a valid email address.");

  if (!isValidUsername(username))
    throw new Error("Username must be 3–20 characters and only contain letters, numbers, or underscores.");

  const pwError = validatePassword(password);
  if (pwError) throw new Error(pwError);

  const cleanEmail    = email.trim().toLowerCase();
  const cleanUsername = username.trim().toLowerCase();
  const cleanName     = sanitize(name);

  const users = loadUsers();

  if (users.find(u => u.email === cleanEmail))
    throw new Error("Email already registered.");

  if (users.find(u => u.username === cleanUsername))
    throw new Error("Username already taken.");

  const passwordHash        = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const verificationToken   = crypto.randomBytes(32).toString("hex");
  const verificationExpires = new Date(Date.now() + VERIFY_TTL).toISOString();

  const user = {
    id:                 `user_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    name:               cleanName,
    username:           cleanUsername,
    email:              cleanEmail,
    passwordHash,
    emailVerified:      false,
    verificationToken,
    verificationExpires,
    resetToken:         null,
    resetExpires:       null,
    provider:           "local",
    createdAt:          new Date().toISOString(),
  };

  users.push(user);
  saveUsers(users);

  console.log(`[Auth] Signup: ${cleanEmail} (@${cleanUsername})`);

  return {
    token: signToken(user.id),
    user:  publicUser(user),
    verificationToken, // returned so the route can send the email
  };
}

// ── Verify email ──────────────────────────────────────────────────────────────
export function verifyEmail(token) {
  const users = loadUsers();
  const user  = users.find(u => u.verificationToken === token);

  if (!user)                                          throw new Error("Invalid verification link.");
  if (new Date(user.verificationExpires) < new Date()) throw new Error("Verification link has expired. Please request a new one.");
  if (user.emailVerified)                             return publicUser(user); // already verified

  user.emailVerified      = true;
  user.verificationToken  = null;
  user.verificationExpires = null;
  saveUsers(users);

  console.log(`[Auth] Email verified: ${user.email}`);
  return publicUser(user);
}

// ── Resend verification ───────────────────────────────────────────────────────
export function resendVerification(email) {
  const users = loadUsers();
  const user  = users.find(u => u.email === email.trim().toLowerCase());

  if (!user)              throw new Error("No account found with that email.");
  if (user.emailVerified) throw new Error("Email is already verified.");

  user.verificationToken   = crypto.randomBytes(32).toString("hex");
  user.verificationExpires = new Date(Date.now() + VERIFY_TTL).toISOString();
  saveUsers(users);

  return { verificationToken: user.verificationToken, email: user.email, name: user.name };
}

// ── Login ─────────────────────────────────────────────────────────────────────
export async function userLogin(email, password) {
  if (!email || !password) throw new Error("Email and password are required.");
  if (!isValidEmail(email)) throw new Error("Please enter a valid email address.");

  const cleanEmail = email.trim().toLowerCase();
  const users      = loadUsers();
  const user       = users.find(u => u.email === cleanEmail);

  const valid = user && await bcrypt.compare(password, user.passwordHash).catch(() => false);
  if (!valid) {
    console.warn(`[Auth] Failed login: ${cleanEmail}`);
    throw new Error("Invalid email or password.");
  }

  if (!user.emailVerified) {
    console.warn(`[Auth] Unverified login attempt: ${cleanEmail}`);
    throw new Error("Please verify your email before logging in. Check your inbox.");
  }

  console.log(`[Auth] Login: ${cleanEmail}`);
  return { token: signToken(user.id), user: publicUser(user) };
}

// ── Logout (JWT is stateless — client just discards token) ────────────────────
export function userLogout() {
  // Nothing to do server-side with JWT.
  // For token blacklisting, add a Redis/DB store here in future.
}

// ── Get user from JWT ─────────────────────────────────────────────────────────
export function getUserFromToken(token) {
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;

  const users = loadUsers();
  const user  = users.find(u => u.id === payload.sub);
  if (!user) return null;
  return publicUser(user);
}

// ── Forgot password ───────────────────────────────────────────────────────────
export function forgotPassword(email) {
  const users = loadUsers();
  const user  = users.find(u => u.email === email.trim().toLowerCase());

  // Always return success to prevent email enumeration
  if (!user) return null;

  user.resetToken   = crypto.randomBytes(32).toString("hex");
  user.resetExpires = new Date(Date.now() + RESET_TTL).toISOString();
  saveUsers(users);

  console.log(`[Auth] Password reset requested: ${user.email}`);
  return { resetToken: user.resetToken, email: user.email, name: user.name };
}

// ── Reset password ────────────────────────────────────────────────────────────
export async function resetPassword(token, newPassword) {
  const pwError = validatePassword(newPassword);
  if (pwError) throw new Error(pwError);

  const users = loadUsers();
  const user  = users.find(u => u.resetToken === token);

  if (!user)                                    throw new Error("Invalid or expired reset link.");
  if (new Date(user.resetExpires) < new Date()) throw new Error("Reset link has expired. Please request a new one.");

  user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  user.resetToken   = null;
  user.resetExpires = null;
  saveUsers(users);

  console.log(`[Auth] Password reset: ${user.email}`);
  return publicUser(user);
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
