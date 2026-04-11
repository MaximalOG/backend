import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env before any other imports
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envFile = readFileSync(resolve(__dirname, "../.env"), "utf-8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch {
  console.warn(".env not found, using system env");
}

import { generateAIResponse } from "./lib/ai.js";
import { shouldTriggerFlow, runFlow, startFlow } from "./lib/flow.js";
import { calculatePlan } from "./lib/calculator.js";
import { buildAIContext } from "./lib/config.js";
import { createTicket, getAllTickets, updateTicketStatus, addReply, clearClosedTickets } from "./lib/tickets.js";
import { sendTicketEmails, sendReplyEmail } from "./lib/mailer.js";import { validateEmail } from "./lib/emailValidator.js";
import { startGmailPoller } from "./lib/gmailPoller.js";
import { getSale, saveSale, getActiveSale, validateCode } from "./lib/sale.js";
import { getRates, convertPrice, SUPPORTED_CURRENCIES } from "./lib/currency.js";
import { createOrder } from "./lib/payment.js";
import { login, logout, getSession, requireAuth, requireOwner, getAllStaff, createStaff, updateStaff, deleteStaff } from "./lib/auth.js";
import { userSignup, userLogin, getUserFromToken, requireUser, userLogout } from "./lib/userAuth.js";
import { getServersByUser, getServer, setServerStatus } from "./lib/servers.js";
import { createFeedback, getAllFeedback, addFeedbackReply, clearAllFeedback } from "./lib/feedback.js";
import crypto from "crypto";

// INR base prices are defined in PLAN_SPECS below — single source of truth

// ── Rate limiter: max 3 tickets per email per 10 minutes ──────────────────────
const ticketRateMap = new Map(); // email → [timestamps]
function checkRateLimit(email) {
  const now = Date.now();
  const window = 10 * 60 * 1000; // 10 min
  const max = 3;
  const times = (ticketRateMap.get(email) || []).filter(t => now - t < window);
  if (times.length >= max) {
    const retryIn = Math.ceil((window - (now - times[0])) / 60000);
    return { allowed: false, retryIn };
  }
  times.push(now);
  ticketRateMap.set(email, times);
  return { allowed: true };
}

// ── Escalation detection + varied responses ───────────────────────────────────
const ESCALATION_TRIGGERS = [
  "connect me to a human", "connect me with a human", "talk to a human", "speak to a human",
  "real support", "human support", "talk to someone", "speak to someone",
  "escalate", "i want support", "need human", "live agent", "live support",
  "support agent", "support executive", "contact support", "human agent",
  "speak with someone", "talk with someone", "real person", "actual person",
];

const ESCALATION_FRUSTRATED = [
  "i give up", "this is useless", "not helping", "still not working",
  "nothing works", "fed up", "so frustrated", "terrible", "worst",
  "doesn't work", "still broken", "same issue", "same problem",
];

const ESCALATION_OFFERS = {
  neutral: [
    "I can connect you with a human support executive. Would you like me to do that?",
    "Want me to loop in a real support agent? They can take it from here.",
    "I can get a human support executive on this for you. Should I do that?",
    "Sure, I can connect you with our support team. Want me to do that?",
  ],
  frustrated: [
    "I understand this is frustrating. I can escalate this to a human support executive right away — want me to?",
    "I hear you — let me get a real support agent involved. Should I do that?",
    "You've been patient enough. I can connect you with a human support executive immediately. Want me to?",
    "I'm sorry this hasn't been resolved. Our support team can take over — want me to connect you now?",
  ],
  confused: [
    "Of course — I can connect you with a human support executive right now. Should I go ahead?",
    "Sure thing. Want me to connect you with a real support agent?",
    "I can get a human support executive on this for you. Want me to do that?",
    "I can connect you with our support team straight away. Should I?",
  ],
};

function pickEscalationOffer(message, history) {
  const lower = message.toLowerCase();
  const historyText = history.map(h => h.content).join(" ").toLowerCase();
  const combined = lower + " " + historyText;

  const isFrustrated = ESCALATION_FRUSTRATED.some(t => combined.includes(t));
  // Confused = repeated questions or long history without resolution
  const isConfused = history.length >= 4;

  const pool = isFrustrated
    ? ESCALATION_OFFERS.frustrated
    : isConfused
    ? ESCALATION_OFFERS.confused
    : ESCALATION_OFFERS.neutral;

  return pool[Math.floor(Math.random() * pool.length)];
}

function shouldEscalate(message) {
  const lower = message.toLowerCase();
  return ESCALATION_TRIGGERS.some(t => lower.includes(t));
}


const PORT = process.env.API_PORT || 3001;
const app = express();

// CORS — allow frontend origins (localhost dev + Netlify production)
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:8080",
  "https://nethernodes.online",
  "https://www.nethernodes.online",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json({ limit: "2mb" }));

// Rate limiter for auth routes — 10 attempts per minute per IP
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a minute and try again." },
});
app.use("/api/auth/login",    authLimiter);
app.use("/api/auth/signup",   authLimiter);
app.use("/api/admin/login",   authLimiter);

const MAX_MSG_LENGTH = 500;

// Simple 60s cache for AI context
let ctxCache = null;
let ctxCachedAt = 0;
function getContext() {
  const now = Date.now();
  if (!ctxCache || now - ctxCachedAt > 60_000) {
    ctxCache    = buildAIContext();
    ctxCachedAt = now;
  }
  return ctxCache;
}

// ── GET /api/ai-context ───────────────────────────────────────────────────────
app.get("/api/ai-context", (_req, res) => {
  res.json(getContext());
});

// ── POST /api/calculate-plan ──────────────────────────────────────────────────
app.post("/api/calculate-plan", (req, res) => {
  const { players, type, plugins = 0, activity, version } = req.body;
  if (!players || !type || !activity || !version) {
    return res.status(400).json({ error: "Missing required fields: players, type, activity, version" });
  }
  try {
    const result = calculatePlan({ players: Number(players), type, plugins: Number(plugins), activity, version });
    console.log("[/api/calculate-plan]", result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/check-subdomain ─────────────────────────────────────────────────
// Simulated — wire to DB later
const RESERVED = new Set([
  "minecraft", "survival", "smp", "hub", "play", "pvp",
  "creative", "lobby", "test", "demo", "admin", "api", "www",
]);

app.post("/api/check-subdomain", (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }
  const clean = name.trim().toLowerCase();
  if (!/^[a-z0-9-]{3,32}$/.test(clean)) {
    return res.status(400).json({ error: "Invalid subdomain format" });
  }
  const available = !RESERVED.has(clean);
  const suggestions = available ? [] : [
    `${clean}123`, `play${clean}`, `${clean}hub`,
  ];
  res.json({ available, name: clean, suggestions });
});

// ── POST /api/chat ────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, history = [], flowState = null } = req.body;

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required." });
  }
  if (message.length > MAX_MSG_LENGTH) {
    return res.status(400).json({ error: `Max ${MAX_MSG_LENGTH} characters.` });
  }

  try {
    const ctx = getContext();
    const lower = message.trim().toLowerCase();

    // ── If we're waiting for escalation confirmation ──────────────────────────
    if (flowState?.awaitingEscalation) {
      const confirmed = /^(yes|yeah|sure|ok|okay|please|yep|yup|do it|go ahead|connect|yes please)/.test(lower);
      if (confirmed) {
        return res.json({
          message: "ESCALATE_CONFIRMED",
          showButtons: false, recommendedPlan: null, ramRequired: null, flowState: null,
        });
      } else {
        // User declined — clear the flag and continue normally
        return res.json({
          message: "No problem! I'll keep trying to help. What else can I do for you?",
          showButtons: false, recommendedPlan: null, ramRequired: null, flowState: null,
        });
      }
    }

    // Continue guided flow if active
    if (flowState?.step && flowState.step !== "done") {
      const result = runFlow(flowState, message, ctx);
      if (result) {
        return res.json({
          message:         result.message,
          showButtons:     result.showButtons,
          recommendedPlan: result.recommendedPlan,
          ramRequired:     result.ramRequired ?? null,
          flowState:       result.nextState,
        });
      }
    }

    // Trigger guided flow — extract any info already in the message
    if (shouldTriggerFlow(message)) {
      const result = startFlow(message);
      return res.json({
        message:         result.message,
        showButtons:     false,
        recommendedPlan: null,
        ramRequired:     null,
        flowState:       result.nextState,
      });
    }

    // Escalation — intercept before AI, use varied backend responses
    if (shouldEscalate(message)) {
      const offer = pickEscalationOffer(message, history);
      return res.json({
        message:         offer,
        showButtons:     false,
        recommendedPlan: null,
        ramRequired:     null,
        flowState:       { awaitingEscalation: true },
      });
    }

    // Free-form AI with live context
    const { text, planResult } = await generateAIResponse(message.trim(), history, ctx, req.body.attachment ?? null);

    // Parse PLAN / SHOW_BUTTONS directives from AI response
    const planMatch   = text.match(/^PLAN:\s*(.+)$/m);
    const actionMatch = text.match(/^ACTION:\s*SHOW_BUTTONS/m);
    const cleanText   = text
      .replace(/CALCULATE_PLAN[\s\S]*?\}/g, "")
      .replace(/^PLAN:.*$/m, "")
      .replace(/^ACTION:.*$/m, "")
      .trim();

    const recommendedPlan = planResult?.recommended_plan
      ?? (planMatch ? planMatch[1].trim() : null);

    console.log("[/api/chat] plan=%s showButtons=%s", recommendedPlan, !!actionMatch);

    return res.json({
      message:         cleanText,
      showButtons:     !!actionMatch,
      recommendedPlan: recommendedPlan,
      ramRequired:     recommendedPlan
        ? ctx.PLAN_SPECS[recommendedPlan]?.ram ?? null
        : null,
      flowState:       null,
      planResult:      planResult ?? null,
    });

  } catch (err) {
    console.error("[NetherNodes AI Error]", err?.message || err);
    return res.status(500).json({ error: "Server is busy, please try again." });
  }
});

// ── POST /api/create-ticket ───────────────────────────────────────────────────
app.post("/api/create-ticket", async (req, res) => {
  const { email, issue, chat_history } = req.body;
  if (!email || !issue) {
    return res.status(400).json({ error: "email and issue are required" });
  }

  // Validate email — format, disposable domain, MX record
  const emailCheck = await validateEmail(email);
  if (!emailCheck.valid) {
    return res.status(400).json({ error: emailCheck.reason });
  }

  // Rate limit check
  const rate = checkRateLimit(email.toLowerCase());
  if (!rate.allowed) {
    return res.status(429).json({
      error: `Too many tickets. Please wait ${rate.retryIn} minute${rate.retryIn > 1 ? "s" : ""} before submitting again.`
    });
  }

  try {
    // Generate structured issue summary from conversation
    let cleanIssue = issue;
    try {
      const { text } = await generateAIResponse(
        `You are a support ticket classifier for a Minecraft hosting service. Based on the information below, generate a structured issue summary in EXACTLY this format (no extra text, no preamble):

Issue Type: <short category, e.g. "Server Lag", "Connection Timeout", "Plugin Issue", "Billing Question">
Likely Cause: <most probable technical or account reason>
User Situation: <one sentence describing what the user is experiencing>

User's issue: ${issue}

${chat_history ? `Conversation context:\n${chat_history}` : ""}`,
        [], null
      );
      const issueType     = text.match(/Issue Type:\s*(.+)/i)?.[1]?.trim();
      const likelyCause   = text.match(/Likely Cause:\s*(.+)/i)?.[1]?.trim();
      const userSituation = text.match(/User Situation:\s*(.+)/i)?.[1]?.trim();
      if (issueType && likelyCause && userSituation) {
        cleanIssue = `Issue Type: ${issueType}\nLikely Cause: ${likelyCause}\nUser Situation: ${userSituation}`;
      }
    } catch { /* fallback to raw issue */ }

    const ticket = createTicket({ email, issue: cleanIssue, chat_history: chat_history || "" });
    console.log("[Ticket Created]", ticket.id, email);

    // Send emails — non-fatal: ticket is saved regardless of email success
    try {
      await sendTicketEmails(ticket);
      console.log("[Emails Sent]", ticket.id);
    } catch (mailErr) {
      console.warn("[Email Failed — ticket still created]", ticket.id, mailErr?.message || mailErr);
    }

    return res.json({ ticket_id: ticket.id, email: ticket.email, status: "created" });
  } catch (err) {
    console.error("[Ticket Error]", err?.message || err);
    return res.status(500).json({ error: "Failed to create ticket: " + (err?.message || err) });
  }
});

// ── POST /api/admin/tickets/:id/reply ────────────────────────────────────────
app.post("/api/admin/tickets/:id/reply", async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }
  const tickets = getAllTickets();
  const ticket = tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  try {
    await sendReplyEmail(ticket, message.trim());
    // Store reply and set status to pending (awaiting customer response)
    addReply(req.params.id, { from: "support", message: message.trim() });
    updateTicketStatus(req.params.id, "pending");
    return res.json({ ok: true });
  } catch (err) {
    console.error("[Reply Error]", err?.message || err);
    return res.status(500).json({ error: "Failed to send reply: " + (err?.message || err) });
  }
});

// ── POST /api/webhook/inbound-email ───────────────────────────────────────────
// Wire this to SendGrid Inbound Parse / Mailgun / Postmark webhook
// They POST parsed email fields to this endpoint
app.post("/api/webhook/inbound-email", (req, res) => {
  // Support SendGrid (from, subject, text), Mailgun (sender, subject, body-plain), raw
  const from    = req.body.from || req.body.sender || "";
  const subject = req.body.subject || "";
  const text    = req.body.text || req.body["body-plain"] || req.body.plain || "";

  // Extract ticket ID from subject line: "Re: Your Support Ticket NN-XXXXXX"
  const idMatch = subject.match(/NN-\d{6}/);
  if (!idMatch) {
    console.log("[Inbound Email] No ticket ID found in subject:", subject);
    return res.status(200).json({ ok: true, note: "no ticket id" });
  }

  const ticketId = idMatch[0];
  const ticket = getAllTickets().find(t => t.id === ticketId);
  if (!ticket) {
    console.log("[Inbound Email] Ticket not found:", ticketId);
    return res.status(200).json({ ok: true, note: "ticket not found" });
  }

  // Store customer reply and reopen ticket
  addReply(ticketId, { from: "customer", message: text.trim() });
  updateTicketStatus(ticketId, "open");
  console.log("[Inbound Email] Reply added to", ticketId, "from", from);
  res.status(200).json({ ok: true });
});

// ── POST /api/admin/login ─────────────────────────────────────────────────────
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  try {
    const result = await login(username, password);
    if (!result) return res.status(401).json({ error: "Invalid username or password" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/admin/logout", (req, res) => {
  const token = req.headers["x-admin-token"];
  if (token) logout(token);
  res.json({ ok: true });
});

app.get("/api/admin/me", (req, res) => {
  const token = req.headers["x-admin-token"];
  const user = getSession(token);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  res.json(user);
});

app.get("/api/admin/staff", requireAuth, requireOwner, (_req, res) => res.json(getAllStaff()));

app.post("/api/admin/staff", requireAuth, requireOwner, async (req, res) => {
  const { username, password, permissions } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  try { res.json(await createStaff({ username, password, permissions })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.patch("/api/admin/staff/:id", requireAuth, requireOwner, async (req, res) => {
  try { res.json(await updateStaff(req.params.id, req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete("/api/admin/staff/:id", requireAuth, requireOwner, (req, res) => {
  try { deleteStaff(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── GET /api/location ─────────────────────────────────────────────────────────
// Used by frontend for currency auto-detection — no external API dependency.
// Cloudflare sets cf-ipcountry header automatically on production.
app.get("/api/location", (req, res) => {
  const country = req.headers["cf-ipcountry"] || "IN";
  res.json({ country });
});

// ── GET /api/plans ────────────────────────────────────────────────────────────
const PLAN_SPECS = {
  Nano:    { ram: "1GB",  cpu: "50%",  ssd: "5GB",   priceInr: 69,   tier: "Entry" },
  Basic:   { ram: "2GB",  cpu: "100%", ssd: "10GB",  priceInr: 0,    tier: "Entry" },
  Plus:    { ram: "3GB",  cpu: "150%", ssd: "15GB",  priceInr: 129,  tier: "Entry" },
  Starter: { ram: "4GB",  cpu: "200%", ssd: "25GB",  priceInr: 199,  tier: "Community", popular: true },
  Pro:     { ram: "6GB",  cpu: "250%", ssd: "40GB",  priceInr: 329,  tier: "Community" },
  Elite:   { ram: "8GB",  cpu: "300%", ssd: "60GB",  priceInr: 469,  tier: "Community" },
  Ultra:   { ram: "10GB", cpu: "350%", ssd: "80GB",  priceInr: 649,  tier: "Advanced" },
  Max:     { ram: "12GB", cpu: "400%", ssd: "100GB", priceInr: 829,  tier: "Advanced" },
  Titan:   { ram: "16GB", cpu: "450%", ssd: "140GB", priceInr: 1099, tier: "Advanced" },
};

app.get("/api/plans", (_req, res) => {
  const plans = Object.entries(PLAN_SPECS).map(([name, spec]) => ({ name, ...spec }));
  res.json(plans);
});

app.get("/api/plans/:name", (req, res) => {
  // Case-insensitive lookup — "starter" and "Starter" both work
  const key = Object.keys(PLAN_SPECS).find(
    k => k.toLowerCase() === req.params.name.toLowerCase()
  );
  if (!key) return res.status(404).json({ error: "Plan not found" });
  const spec = PLAN_SPECS[key];
  const country = req.headers["cf-ipcountry"] || "IN";
  const price = country === "IN"
    ? { currency: "INR", amount: spec.priceInr }
    : { currency: "USD", amount: Math.round((spec.priceInr / 83) * 100) / 100 };
  res.json({ name: key, ...spec, price });
});

// ── GET /api/rates ────────────────────────────────────────────────────────────
app.get("/api/rates", async (_req, res) => {
  try {
    const rates = await getRates();
    res.json({ rates, currencies: SUPPORTED_CURRENCIES });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/create-order ────────────────────────────────────────────────────
app.post("/api/create-order", async (req, res) => {
  const { planName, currency, userEmail, couponCode } = req.body;

  if (!planName || !currency) {
    return res.status(400).json({ error: "planName and currency required" });
  }

  // 1. Look up plan price server-side — never trust frontend price
  const planKey = Object.keys(PLAN_SPECS).find(
    k => k.toLowerCase() === String(planName).toLowerCase()
  );
  if (!planKey) return res.status(400).json({ error: "Invalid plan" });

  const originalPrice = PLAN_SPECS[planKey].priceInr;
  console.log(`[Order] Plan: ${planKey} | Original: ₹${originalPrice}`);

  if (originalPrice === 0) {
    return res.status(400).json({ error: "This plan is currently free — no payment needed." });
  }

  // 2. Validate and apply coupon server-side
  let discountAmount = 0;
  let couponLabel = null;

  if (couponCode && couponCode.trim()) {
    // Explicit coupon code provided — validate it
    const coupon = validateCode(couponCode.trim());
    if (coupon) {
      if (coupon.discountType === "percent") {
        discountAmount = Math.round(originalPrice * (coupon.discount / 100));
      } else {
        discountAmount = Math.min(coupon.discount, originalPrice);
      }
      couponLabel = coupon.label;
      console.log(`[Order] Coupon: ${couponCode} (${coupon.discountType}) | Discount: ₹${discountAmount}`);
    } else {
      console.log(`[Order] Coupon invalid or expired: ${couponCode}`);
    }
  } else {
    // No explicit code — check if a public banner sale is active and apply it automatically
    const activeSale = getActiveSale();
    if (activeSale && activeSale.mode === "public" && activeSale.enabled) {
      const plansApply = activeSale.plans === "all" ||
        (Array.isArray(activeSale.plans) && activeSale.plans.includes(planKey));
      if (plansApply) {
        if (activeSale.discountType === "percent") {
          discountAmount = Math.round(originalPrice * (activeSale.discount / 100));
        } else {
          discountAmount = Math.min(activeSale.discount, originalPrice);
        }
        couponLabel = activeSale.label;
        console.log(`[Order] Public sale applied: ${activeSale.label} | Discount: ₹${discountAmount}`);
      }
    }
  }

  // 3. Calculate final price
  const finalPrice = Math.max(0, originalPrice - discountAmount);
  console.log(`[Order] Original: ₹${originalPrice} | Discount: ₹${discountAmount} | Final: ₹${finalPrice}`);

  if (finalPrice === 0) {
    return res.status(400).json({ error: "Coupon makes this plan free — no payment needed." });
  }

  try {
    const order = await createOrder({
      planName: planKey,
      planPrice: finalPrice,   // discounted price goes to Razorpay
      currency: currency || "INR",
      userEmail: userEmail || "",
    });

    res.json({
      ...order,
      originalPrice,
      discountAmount,
      finalPrice,
      couponLabel,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/verify-payment ──────────────────────────────────────────────────
app.post("/api/verify-payment", (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planName, userEmail } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: "Missing payment verification fields" });
  }

  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || secret === "REPLACE_ME") {
    // Dev mode — mock verification
    console.log("[Payment] Mock verification for", planName, userEmail);
    return res.json({ verified: true, mock: true, planName, userEmail });
  }

  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSig = crypto.createHmac("sha256", secret).update(body).digest("hex");

  if (expectedSig !== razorpay_signature) {
    return res.status(400).json({ error: "Payment verification failed — signature mismatch" });
  }

  console.log("[Payment] Verified:", razorpay_payment_id, "for", planName, userEmail);
  // TODO: provision server, save to DB, send confirmation email
  res.json({ verified: true, mock: false, planName, userEmail, paymentId: razorpay_payment_id });
});

// ── GET /api/sale ─────────────────────────────────────────────────────────────
// Public — only returns banner data. Never exposes codes.
app.get("/api/sale", (_req, res) => {
  const sale = getActiveSale();
  if (!sale) return res.json(null);
  // Only return banner info for public mode — codes are validated separately
  if (sale.mode !== "public") {
    // Tell frontend a code mode is active (so it shows the promo input) but no codes exposed
    return res.json({ mode: sale.mode, enabled: true });
  }
  res.json(sale);
});

// ── POST /api/sale/validate-code ──────────────────────────────────────────────
app.post("/api/sale/validate-code", (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code is required" });
  const result = validateCode(code);
  if (!result) return res.status(404).json({ error: "Invalid or expired code" });
  res.json(result);
});

// ── GET /api/admin/sale ───────────────────────────────────────────────────────
app.get("/api/admin/sale", (_req, res) => {
  res.json(getSale());
});

// ── POST /api/admin/sale ──────────────────────────────────────────────────────
app.post("/api/admin/sale", (req, res) => {
  const current = getSale();
  const updated = { ...current, ...req.body };
  saveSale(updated);
  res.json(updated);
});

// ── GET /api/admin/tickets ────────────────────────────────────────────────────
app.get("/api/admin/tickets", (_req, res) => {
  res.json(getAllTickets());
});

// ── POST /api/admin/poll-inbox ────────────────────────────────────────────────
app.post("/api/admin/poll-inbox", async (_req, res) => {
  try {
    const { pollOnce } = await import("./lib/gmailPoller.js");
    await pollOnce();
    res.json({ ok: true, message: "Inbox checked" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/tickets/:id ──────────────────────────────────────────────
app.patch("/api/admin/tickets/:id", (req, res) => {
  const { status } = req.body;
  if (!["open", "pending", "closed"].includes(status)) {
    return res.status(400).json({ error: "status must be open, pending, or closed" });
  }
  const ticket = updateTicketStatus(req.params.id, status);
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });
  res.json(ticket);
});

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
app.post("/api/auth/signup", (req, res) => {
  const { name, email, password } = req.body;
  try {
    const result = userSignup(name, email, password);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  try {
    const result = userLogin(email, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
app.get("/api/auth/me", requireUser, (req, res) => {
  res.json(req.user);
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
app.post("/api/auth/logout", (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token) userLogout(token);
  res.json({ ok: true });
});

// ── GET /api/servers ──────────────────────────────────────────────────────────
app.get("/api/servers", requireUser, (req, res) => {
  const servers = getServersByUser(req.user.id);
  res.json(servers);
});

// ── POST /api/servers/:id/start ───────────────────────────────────────────────
app.post("/api/servers/:id/start", requireUser, (req, res) => {
  const srv = getServer(req.params.id, req.user.id);
  if (!srv) return res.status(404).json({ error: "Server not found" });
  if (srv.status === "running") return res.json(srv);

  // Simulate async start — set to "starting" then "running" after 2s
  const starting = setServerStatus(req.params.id, req.user.id, "starting");
  setTimeout(() => setServerStatus(req.params.id, req.user.id, "running"), 2000);
  res.json(starting);
});

// ── POST /api/servers/:id/stop ────────────────────────────────────────────────
app.post("/api/servers/:id/stop", requireUser, (req, res) => {
  const srv = getServer(req.params.id, req.user.id);
  if (!srv) return res.status(404).json({ error: "Server not found" });
  if (srv.status === "stopped") return res.json(srv);

  // Simulate async stop — set to "stopping" then "stopped" after 2s
  const stopping = setServerStatus(req.params.id, req.user.id, "stopping");
  setTimeout(() => setServerStatus(req.params.id, req.user.id, "stopped"), 2000);
  res.json(stopping);
});

// ── POST /api/feedback ────────────────────────────────────────────────────────
app.post("/api/feedback", (req, res) => {
  const { ticketId, email, rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "rating must be 1–5" });
  }
  const entry = createFeedback({ ticketId, email, rating, comment });
  res.status(201).json(entry);
});

// ── GET /api/admin/feedback ───────────────────────────────────────────────────
app.get("/api/admin/feedback", (_req, res) => {
  res.json(getAllFeedback());
});

// ── DELETE /api/admin/feedback ────────────────────────────────────────────────
app.delete("/api/admin/feedback", requireAuth, requireOwner, (_req, res) => {
  const result = clearAllFeedback();
  res.json(result);
});

// ── POST /api/admin/feedback/:id/reply ───────────────────────────────────────
app.post("/api/admin/feedback/:id/reply", async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "message is required" });

  const entry = addFeedbackReply(req.params.id, message.trim());
  if (!entry) return res.status(404).json({ error: "Feedback not found" });

  // Send email to user if they provided one
  if (entry.email) {
    try {
      const nodemailer = await import("nodemailer");
      const transport = nodemailer.default.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      const stars = "⭐".repeat(entry.rating);
      await transport.sendMail({
        from: `"NetherNodes Support" <${process.env.SMTP_USER}>`,
        to: entry.email,
        subject: `A follow-up on your feedback — NetherNodes`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <div style="background:#1a0a0a;padding:20px;border-radius:8px 8px 0 0">
              <h2 style="color:#e53935;margin:0">NetherNodes Support</h2>
            </div>
            <div style="background:#111;padding:20px;color:#ddd;border-radius:0 0 8px 8px">
              <p>Hi there,</p>
              <p>Our team has a follow-up question regarding your recent feedback (${stars}):</p>
              ${entry.comment ? `<p style="background:#1a1a1a;padding:12px;border-radius:4px;border-left:3px solid #555;color:#aaa;font-style:italic">"${entry.comment}"</p>` : ""}
              <div style="background:#1a1a1a;border-left:4px solid #e53935;padding:16px;border-radius:4px;margin:16px 0;white-space:pre-wrap;font-size:14px;line-height:1.6">${message.trim()}</div>
              <p>You can reply directly to this email and we'll get back to you.</p>
              <p style="color:#888;font-size:12px;margin-top:24px">— NetherNodes Support Team</p>
            </div>
          </div>
        `,
      });
      console.log("[Feedback Reply] Email sent to", entry.email);
    } catch (mailErr) {
      console.warn("[Feedback Reply] Email failed:", mailErr?.message || mailErr);
    }
  }

  res.json(entry);
});

// ── DELETE /api/admin/tickets/closed ─────────────────────────────────────────
app.delete("/api/admin/tickets/closed", (_req, res) => {
  const result = clearClosedTickets();
  res.json(result);
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`NetherNodes API running on port ${PORT}`);
  startGmailPoller(60_000);
});
