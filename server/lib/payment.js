/**
 * Payment provider abstraction.
 * Phase 1: Razorpay (India)
 * Phase 2: Add Stripe for international (currency !== INR)
 *
 * To add Stripe later:
 *   if (currency !== "INR") { use Stripe }
 *   else { use Razorpay }
 */

import { convertPrice } from "./currency.js";

/**
 * Create a payment order.
 * Returns provider-specific order data for the frontend.
 */
export async function createOrder({ planName, planPrice, currency, userEmail }) {
  // Always charge in INR via Razorpay for now
  // Convert to INR if needed (prices are already in INR, but keep for future)
  const amountInr = planPrice; // planPrice is always INR base

  const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
  const razorpaySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!razorpayKeyId || razorpayKeyId === "rzp_test_REPLACE_ME") {
    // Dev mode — return mock order
    return {
      provider: "razorpay",
      orderId: `mock_order_${Date.now()}`,
      amount: amountInr * 100, // paise
      currency: "INR",
      keyId: "rzp_test_mock",
      planName,
      userEmail,
      mock: true,
    };
  }

  try {
    const auth = Buffer.from(`${razorpayKeyId}:${razorpaySecret}`).toString("base64");
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: Math.round(amountInr * 100), // paise
        currency: "INR",
        receipt: `nn_${planName.toLowerCase()}_${Date.now()}`,
        notes: { plan: planName, email: userEmail, displayCurrency: currency },
      }),
    });

    if (!res.ok) throw new Error(`Razorpay error: ${res.status}`);
    const order = await res.json();

    return {
      provider: "razorpay",
      orderId: order.id,
      amount: order.amount,
      currency: "INR",
      keyId: razorpayKeyId,
      planName,
      userEmail,
      mock: false,
    };
  } catch (err) {
    throw new Error("Payment order creation failed: " + err.message);
  }
}
