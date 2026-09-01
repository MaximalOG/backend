/**
 * Subscription store — file-backed persistence.
 * Tracks Razorpay subscriptions linked to NetherNodes servers.
 *
 * One subscription per server. When a server is deleted the subscription
 * record is retained for audit purposes (status = "cancelled").
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = resolve(__dirname, "../../data/subscriptions.json");
const HIST_PATH = resolve(__dirname, "../../data/payment_history.json");

// ── Helpers ───────────────────────────────────────────────────────────────────
function load()          { return exists(DB_PATH)   ? parse(DB_PATH)   : []; }
function loadHistory()   { return exists(HIST_PATH) ? parse(HIST_PATH) : []; }
function exists(p)       { return existsSync(p); }
function parse(p)        { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return []; } }

function persist(data, path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

// ── Subscription CRUD ─────────────────────────────────────────────────────────

/**
 * Create a new subscription record.
 * Called immediately after Razorpay subscription is created.
 */
export function createSubscription({
  razorpaySubscriptionId,
  razorpayPlanId,
  serverId,
  userId,
  userEmail,
  planName,
  amountInr,
}) {
  const subs = load();
  const sub = {
    id:                      `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    razorpaySubscriptionId,
    razorpayPlanId,
    serverId,
    userId,
    userEmail,
    planName,
    amountInr,
    status:                  "created",       // created → active → cancelled/halted
    gracePeriodEnd:          null,            // set when payment fails
    nextBillingDate:         null,            // updated on each payment.captured
    currentPeriodEnd:        null,            // when the current paid period ends
    createdAt:               new Date().toISOString(),
    activatedAt:             null,
    cancelledAt:             null,
  };
  subs.push(sub);
  persist(subs, DB_PATH);
  console.log(`[Subscription] Created ${sub.id} (Razorpay: ${razorpaySubscriptionId}) for server ${serverId}`);
  return sub;
}

/** Find subscription by Razorpay subscription ID. */
export function getSubscriptionByRazorpayId(razorpaySubscriptionId) {
  return load().find(s => s.razorpaySubscriptionId === razorpaySubscriptionId) ?? null;
}

/** Find active/current subscription for a server. */
export function getSubscriptionByServerId(serverId) {
  const subs = load();
  // Return the most recently created subscription for this server
  return subs
    .filter(s => s.serverId === serverId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] ?? null;
}

/** Get all subscriptions for a user. */
export function getSubscriptionsByUserId(userId) {
  return load().filter(s => s.userId === userId);
}

/** Update fields on a subscription record. */
export function updateSubscription(razorpaySubscriptionId, fields) {
  const subs = load();
  const sub  = subs.find(s => s.razorpaySubscriptionId === razorpaySubscriptionId);
  if (!sub) return null;
  Object.assign(sub, fields);
  persist(subs, DB_PATH);
  return sub;
}

// ── Payment history ───────────────────────────────────────────────────────────

/** Record a payment event against a subscription. */
export function recordPayment({
  razorpaySubscriptionId,
  razorpayPaymentId,
  amountInr,
  status,     // "captured" | "failed"
  event,
}) {
  const history = loadHistory();
  history.push({
    razorpaySubscriptionId,
    razorpayPaymentId:  razorpayPaymentId ?? null,
    amountInr:          amountInr ?? null,
    status,
    event,
    recordedAt:         new Date().toISOString(),
  });
  persist(history, HIST_PATH);
}

/** Get full payment history for a subscription. */
export function getPaymentHistory(razorpaySubscriptionId) {
  return loadHistory().filter(h => h.razorpaySubscriptionId === razorpaySubscriptionId);
}

// ── Razorpay plan ID cache — keyed by planName ────────────────────────────────
// Razorpay plans are reusable — we create one per NetherNodes plan and cache
// the ID so we don't create duplicates on every order.
const PLAN_ID_CACHE_PATH = resolve(__dirname, "../../data/razorpay_plan_ids.json");

export function getRazorpayPlanId(planName) {
  if (!existsSync(PLAN_ID_CACHE_PATH)) return null;
  try {
    const cache = JSON.parse(readFileSync(PLAN_ID_CACHE_PATH, "utf-8"));
    return cache[planName] ?? null;
  } catch { return null; }
}

export function saveRazorpayPlanId(planName, planId) {
  let cache = {};
  try { if (existsSync(PLAN_ID_CACHE_PATH)) cache = JSON.parse(readFileSync(PLAN_ID_CACHE_PATH, "utf-8")); } catch {}
  cache[planName] = planId;
  mkdirSync(dirname(PLAN_ID_CACHE_PATH), { recursive: true });
  writeFileSync(PLAN_ID_CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
}
