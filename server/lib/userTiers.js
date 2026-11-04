/**
 * User Tier System
 * ─────────────────────────────────────────────────────────────────────────────
 * Classifies every NetherNodes account as "paid" or "free".
 *
 * PAID:  has at least one subscription with status "active" OR
 *        status "pending_payment" AND gracePeriodEnd is in the future
 *        (3-day grace period after a missed payment).
 *
 * FREE:  everyone else — no subscription, coupon/free-plan users,
 *        cancelled/halted, or grace period expired.
 *
 * Tier records are persisted to data/user_tiers.json so the bot API
 * can serve them instantly without re-computing on every request.
 * They are recomputed eagerly on every relevant webhook event.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const TIERS_PATH = resolve(__dirname, "../../data/user_tiers.json");

// ── Persistence ───────────────────────────────────────────────────────────────

function loadTiers() {
  if (!existsSync(TIERS_PATH)) return {};
  try { return JSON.parse(readFileSync(TIERS_PATH, "utf-8")); }
  catch { return {}; }
}

function saveTiers(tiers) {
  mkdirSync(dirname(TIERS_PATH), { recursive: true });
  writeFileSync(TIERS_PATH, JSON.stringify(tiers, null, 2), "utf-8");
}

// ── Core classification ───────────────────────────────────────────────────────

/**
 * Given a list of subscription records for a single user, determine their tier.
 * @param {Array} subs - All subscription records for this userId
 * @returns {{ tier: "paid"|"free", reason: string, activeSubId: string|null }}
 */
function classifyUser(subs) {
  if (!subs || subs.length === 0) {
    return { tier: "free", reason: "no_subscription", activeSubId: null };
  }

  // Sort newest first
  const sorted = [...subs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  for (const sub of sorted) {
    if (sub.status === "active") {
      return { tier: "paid", reason: "active_subscription", activeSubId: sub.razorpaySubscriptionId };
    }

    if (sub.status === "pending_payment") {
      // Still paid if within 3-day grace period
      if (sub.gracePeriodEnd && new Date(sub.gracePeriodEnd) > new Date()) {
        return {
          tier: "paid",
          reason: "grace_period",
          activeSubId: sub.razorpaySubscriptionId,
          gracePeriodEnd: sub.gracePeriodEnd,
        };
      }
      // Grace period expired → free
      return { tier: "free", reason: "grace_period_expired", activeSubId: null };
    }
  }

  return { tier: "free", reason: "no_active_subscription", activeSubId: null };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Recompute and persist the tier for a single user.
 * Called from webhook handlers whenever subscription state changes.
 *
 * @param {string} userId
 * @param {string} userEmail
 * @param {Array}  subs - All subscription records for this user
 * @returns {{ tier, reason, activeSubId, updatedAt }}
 */
export function updateUserTier(userId, userEmail, subs) {
  const result = classifyUser(subs);
  const tiers  = loadTiers();

  tiers[userId] = {
    userId,
    email:       userEmail,
    tier:        result.tier,
    reason:      result.reason,
    activeSubId: result.activeSubId ?? null,
    gracePeriodEnd: result.gracePeriodEnd ?? null,
    updatedAt:   new Date().toISOString(),
  };

  saveTiers(tiers);
  console.log(`[UserTier] ${userEmail} → ${result.tier} (${result.reason})`);
  return tiers[userId];
}

/**
 * Get the stored tier for a user.
 * Returns null if user hasn't been classified yet (defaults to free on read).
 */
export function getUserTier(userId) {
  const tiers = loadTiers();
  return tiers[userId] ?? null;
}

/**
 * Get tier by email (linear scan — used by bot API).
 */
export function getUserTierByEmail(email) {
  const tiers = loadTiers();
  return Object.values(tiers).find(t => t.email === email) ?? null;
}

/**
 * Get all tier records (for bot stats endpoint).
 */
export function getAllTiers() {
  return Object.values(loadTiers());
}

/**
 * Recompute tiers for ALL users from scratch.
 * Useful after a migration or data fix. Called once on server startup.
 * Reads subscriptions.json directly to avoid circular imports.
 */
export function recomputeAllTiers() {
  const subsPath  = resolve(__dirname, "../../data/subscriptions.json");
  const usersPath = resolve(__dirname, "../../data/users_app.json");

  if (!existsSync(subsPath) || !existsSync(usersPath)) return;

  let subs, users;
  try { subs  = JSON.parse(readFileSync(subsPath,  "utf-8")); } catch { return; }
  try { users = JSON.parse(readFileSync(usersPath, "utf-8")); } catch { return; }

  // Group subscriptions by userId
  const byUser = {};
  for (const sub of subs) {
    if (!sub.userId) continue;
    if (!byUser[sub.userId]) byUser[sub.userId] = [];
    byUser[sub.userId].push(sub);
  }

  // Classify every user that has at least one subscription
  for (const user of users) {
    const userSubs = byUser[user.id] ?? [];
    updateUserTier(user.id, user.email, userSubs);
  }

  console.log(`[UserTier] Recomputed tiers for ${users.length} users.`);
}
