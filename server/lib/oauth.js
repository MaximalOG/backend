/**
 * OAuth handlers — Google and Discord.
 * Uses passport strategies. On success, creates or finds a user account
 * and returns a JWT token (same as regular login).
 */

import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as DiscordStrategy } from "passport-discord";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import jwt from "jsonwebtoken";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = resolve(__dirname, "../../data/users_app.json");
const JWT_SECRET  = process.env.JWT_SECRET || "nn_dev_secret_change_in_production";
const JWT_EXPIRES = "7d";
const FRONTEND    = process.env.FRONTEND_URL || "http://localhost:5173";

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

// ── Find or create user from OAuth profile ────────────────────────────────────
function findOrCreate({ provider, providerId, email, name, avatar }) {
  const users = loadUsers();

  // 1. Find by provider + providerId
  let user = users.find(u => u.provider === provider && u.providerId === providerId);
  if (user) return user;

  // 2. Find by email (link accounts)
  if (email) {
    user = users.find(u => u.email === email.toLowerCase());
    if (user) {
      // Link OAuth to existing account
      user.provider    = provider;
      user.providerId  = providerId;
      user.emailVerified = true;
      saveUsers(users);
      return user;
    }
  }

  // 3. Create new account
  // Generate a unique username from name
  const base = (name || "user").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "user";
  let username = base;
  let suffix = 1;
  while (users.find(u => u.username === username)) {
    username = `${base}${suffix++}`;
  }

  const newUser = {
    id:            `user_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    name:          name || username,
    username,
    email:         email ? email.toLowerCase() : null,
    passwordHash:  null,   // OAuth users have no password
    emailVerified: true,   // OAuth emails are pre-verified
    provider,
    providerId,
    avatar:        avatar || null,
    createdAt:     new Date().toISOString(),
  };

  users.push(newUser);
  saveUsers(newUser ? users : users);
  console.log(`[OAuth] New user via ${provider}: ${newUser.email || newUser.username}`);
  return newUser;
}

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function publicUser(user) {
  return { id: user.id, name: user.name, username: user.username, email: user.email, emailVerified: user.emailVerified };
}

// ── Google Strategy ───────────────────────────────────────────────────────────
passport.use(new GoogleStrategy(
  {
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  `${process.env.API_URL || "http://localhost:3001"}/api/auth/google/callback`,
  },
  (_accessToken, _refreshToken, profile, done) => {
    try {
      const email  = profile.emails?.[0]?.value || null;
      const avatar = profile.photos?.[0]?.value || null;
      const user   = findOrCreate({ provider: "google", providerId: profile.id, email, name: profile.displayName, avatar });
      done(null, user);
    } catch (err) {
      done(err);
    }
  }
));

// ── Discord Strategy ──────────────────────────────────────────────────────────
passport.use(new DiscordStrategy(
  {
    clientID:     process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL:  `${process.env.API_URL || "http://localhost:3001"}/api/auth/discord/callback`,
    scope:        ["identify", "email"],
  },
  (_accessToken, _refreshToken, profile, done) => {
    try {
      const email  = profile.email || null;
      const avatar = profile.avatar
        ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
        : null;
      const user = findOrCreate({ provider: "discord", providerId: profile.id, email, name: profile.username, avatar });
      done(null, user);
    } catch (err) {
      done(err);
    }
  }
));

// Passport requires these even if we don't use sessions
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const users = loadUsers();
  done(null, users.find(u => u.id === id) || null);
});

// ── Route handlers (called from index.js) ────────────────────────────────────

/** Redirect user to Google consent screen */
export const googleAuth = passport.authenticate("google", { scope: ["profile", "email"], session: false });

/** Handle Google callback — redirect to frontend with token */
export const googleCallback = [
  passport.authenticate("google", { session: false, failureRedirect: `${FRONTEND}/login?error=google_failed` }),
  (req, res) => {
    const token = signToken(req.user.id);
    const user  = encodeURIComponent(JSON.stringify(publicUser(req.user)));
    res.redirect(`${FRONTEND}/oauth-callback?token=${token}&user=${user}`);
  },
];

/** Redirect user to Discord consent screen */
export const discordAuth = passport.authenticate("discord", { session: false });

/** Handle Discord callback — redirect to frontend with token */
export const discordCallback = [
  passport.authenticate("discord", { session: false, failureRedirect: `${FRONTEND}/login?error=discord_failed` }),
  (req, res) => {
    const token = signToken(req.user.id);
    const user  = encodeURIComponent(JSON.stringify(publicUser(req.user)));
    res.redirect(`${FRONTEND}/oauth-callback?token=${token}&user=${user}`);
  },
];

export { passport };
