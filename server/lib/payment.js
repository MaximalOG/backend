/**
 * Payment provider abstraction.
 * Phase 1: Razorpay (India)
 * Phase 2: Add Stripe for international (currency !== INR)
 */

import { convertPrice } from "./currency.js";
import { getRazorpayPlanId, saveRazorpayPlanId } from "./subscriptions.js";

// ── Shared Razorpay auth helper ───────────────────────────────────────────────
function razorpayAuth() {
  const id  = process.env.RAZORPAY_KEY_ID;
  const sec = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !sec || id === "rzp_test_REPLACE_ME") return null;
  return { id, secret: sec, header: `Basic ${Buffer.from(`${id}:${sec}`).toString("base64")}` };
}

async function razorpayPost(path, body) {
  const auth = razorpayAuth();
  if (!auth) throw new Error("Razorpay not configured.");
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth.header },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Razorpay error ${res.status}: ${err?.error?.description ?? res.statusText}`);
  }
  return res.json();
}

async function razorpayGet(path) {
  const auth = razorpayAuth();
  if (!auth) throw new Error("Razorpay not configured.");
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    headers: { Authorization: auth.header },
  });
  if (!res.ok) throw new Error(`Razorpay error ${res.status}`);
  return res.json();
}

/**
 * Get or create a Razorpay Plan for a given NetherNodes plan + price.
 * Plans are reusable — cached by plan name so we don't create duplicates.
 */
export async function ensureRazorpayPlan(planName, amountInr) {
  const cached = getRazorpayPlanId(planName);
  if (cached) return cached;

  const plan = await razorpayPost("/plans", {
    period:   "monthly",
    interval: 1,
    item: {
      name:     `NetherNodes ${planName} Plan`,
      amount:   Math.round(amountInr * 100), // paise
      currency: "INR",
      description: `Monthly ${planName} Minecraft server — NetherNodes`,
    },
    notes: { nethernodes_plan: planName },
  });

  saveRazorpayPlanId(planName, plan.id);
  console.log(`[Payment] Created Razorpay plan for ${planName}: ${plan.id}`);
  return plan.id;
}

/**
 * Create a Razorpay Subscription for a customer.
 * Returns the subscription object from Razorpay.
 */
export async function createRazorpaySubscription({ planId, totalCount = 120, userEmail, userName, userPhone }) {
  const sub = await razorpayPost("/subscriptions", {
    plan_id:           planId,
    total_count:       totalCount,  // 120 months = 10 years; effectively unlimited
    quantity:          1,
    customer_notify:   1,
    addons:            [],
    notes: { email: userEmail },
    notify_info: {
      notify_phone: userPhone ?? null,
      notify_email: userEmail,
    },
  });
  return sub;
}

/**
 * Cancel a Razorpay subscription.
 * cancel_at_cycle_end=1 cancels at end of billing period; 0 = immediate.
 */
export async function cancelRazorpaySubscription(razorpaySubscriptionId, immediate = false) {
  return razorpayPost(`/subscriptions/${razorpaySubscriptionId}/cancel`, {
    cancel_at_cycle_end: immediate ? 0 : 1,
  });
}

/**
 * Fetch a Razorpay subscription by ID.
 */
export async function getRazorpaySubscription(razorpaySubscriptionId) {
  return razorpayGet(`/subscriptions/${razorpaySubscriptionId}`);
}

/**
 * Create a one-time payment order (used for first payment / coupon / free flow).
 * Returns provider-specific order data for the frontend.
 */
export async function createOrder({ planName, planPrice, currency, userEmail }) {
  const amountInr = planPrice;
  const auth = razorpayAuth();

  if (!auth) {
    // Dev mode — return mock order
    return {
      provider: "razorpay",
      orderId: `mock_order_${Date.now()}`,
      amount: amountInr * 100,
      currency: "INR",
      keyId: "rzp_test_mock",
      planName,
      userEmail,
      mock: true,
    };
  }

  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth.header },
    body: JSON.stringify({
      amount:   Math.round(amountInr * 100),
      currency: "INR",
      receipt:  `nn_${planName.toLowerCase()}_${Date.now()}`,
      notes:    { plan: planName, email: userEmail, displayCurrency: currency },
    }),
  });

  if (!res.ok) throw new Error(`Razorpay error: ${res.status}`);
  const order = await res.json();

  return {
    provider: "razorpay",
    orderId:  order.id,
    amount:   order.amount,
    currency: "INR",
    keyId:    auth.id,
    planName,
    userEmail,
    mock:     false,
  };
}
