import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const USERS_PATH = resolve(__dirname, "../../data/users.json");
const SESSIONS = new Map(); // token → { userId, expiresAt }
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours

function hash(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function loadUsers() {
  if (!existsSync(USERS_PATH)) return { users: [] };
  try { return JSON.parse(readFileSync(USERS_PATH, "utf-8")); }
  catch { return { users: [] }; }
}

function saveUsers(data) {
  writeFileSync(USERS_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function login(username, password) {
  const { users } = loadUsers();
  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return null;
  if (user.passwordHash !== hash(password)) return null;

  const token = crypto.randomBytes(32).toString("hex");
  SESSIONS.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL });

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

export function requireAuth(req, res, next) {
  const token = req.headers["x-admin-token"] || req.cookies?.adminToken;
  const user = getSession(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  req.adminUser = user;
  next();
}

export function requireOwner(req, res, next) {
  if (req.adminUser?.role !== "owner") return res.status(403).json({ error: "Owner access required" });
  next();
}

// Staff management
export function getAllStaff() {
  const { users } = loadUsers();
  return users.filter(u => u.role !== "owner").map(u => ({
    id: u.id, username: u.username, role: u.role,
    permissions: u.permissions, createdAt: u.createdAt,
  }));
}

export function createStaff({ username, password, permissions }) {
  const data = loadUsers();
  if (data.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error("Username already exists");
  }
  const staff = {
    id: `staff_${Date.now()}`,
    username,
    passwordHash: hash(password),
    role: "staff",
    permissions: permissions || [],
    createdAt: new Date().toISOString(),
  };
  data.users.push(staff);
  saveUsers(data);
  return { id: staff.id, username: staff.username, role: staff.role, permissions: staff.permissions };
}

export function updateStaff(id, { permissions, password }) {
  const data = loadUsers();
  const user = data.users.find(u => u.id === id);
  if (!user || user.role === "owner") throw new Error("Staff not found");
  if (permissions) user.permissions = permissions;
  if (password) user.passwordHash = hash(password);
  saveUsers(data);
  return { id: user.id, username: user.username, permissions: user.permissions };
}

export function deleteStaff(id) {
  const data = loadUsers();
  const idx = data.users.findIndex(u => u.id === id && u.role !== "owner");
  if (idx === -1) throw new Error("Staff not found");
  data.users.splice(idx, 1);
  saveUsers(data);
}

export const ALL_PERMISSIONS = [
  { key: "tickets",          label: "Support Tickets" },
  { key: "banner_sale",      label: "Banner Sale" },
  { key: "promo_codes",      label: "Promo Codes" },
  { key: "staff_management", label: "Staff Management (Owner only)" },
];
