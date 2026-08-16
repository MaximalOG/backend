import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { readFileSync, existsSync } from "fs";
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
import { userSignup, userLogin, getUserFromToken, requireUser, userLogout, verifyEmail, resendVerification, forgotPassword, resetPassword } from "./lib/userAuth.js";
import { getServersByUser, getServer, setServerStatus, createPendingServer, beginServerProvisioning, markServerProvisioned, updateServer, deleteServerRecord } from "./lib/servers.js";
import { createFeedback, getAllFeedback, addFeedbackReply, clearAllFeedback } from "./lib/feedback.js";
import { createAndSendInvoice, getAllInvoices, getInvoiceById } from "./lib/invoice.js";
import { ensurePterodactylUser, provisionServer, getPterodactylServer, getServerTypes, getServerTypeConfig, suspendServer, unsuspendServer, deleteServer as deletePterodactylServer, getConsoleCredentials, sendPowerSignal } from "./lib/pterodactyl.js";
import { savePaymentOrder, getPaymentOrder, markPaymentOrderPaid } from "./lib/orders.js";
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
  "https://api.nethernodes.online",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    // Allow configured origins
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Allow Netlify preview deployments
    if (/^https:\/\/[a-z0-9-]+\.netlify\.app$/i.test(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Token"],
}));

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

// Disable ETags — API responses are dynamic (user-specific, auth-gated).
// ETags cause browsers to send If-None-Match and get 304 No Content back,
// which breaks JSON parsing on the frontend.
app.set("etag", false);

// Trust Cloudflare proxy — required for express-rate-limit behind Cloudflare
app.set("trust proxy", 1);

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

    // Plan list — intercept before AI so formatting is always perfect
    const PLAN_LIST_TRIGGERS = [
      "all plans", "show plans", "list plans", "what plans", "all the plans",
      "show me plans", "list all", "what are the plans", "what are your plans",
      "available plans", "pricing plans", "all pricing", "show pricing",
    ];
    if (PLAN_LIST_TRIGGERS.some(t => lower.includes(t))) {
      const lines = ctx.AVAILABLE_PLANS.map(name => {
        const price = ctx.PRICING[name];
        const spec = ctx.PLAN_SPECS[name];
        return `🟢 ${name} — ${spec.ram} RAM · ${price}`;
      }).join("\n");
      return res.json({
        message: `🎮 Minecraft Server Plans\n\n${lines}\n\n💡 Need help choosing? Tell me how many players you expect and I'll pick the right one.`,
        showButtons: false, recommendedPlan: null, ramRequired: null, flowState: null,
      });
    }

    // Escalation — intercept before AI, use varied backend responses
    if (shouldEscalate(message)) {      const offer = pickEscalationOffer(message, history);
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
    const msg = err?.message || String(err);
    const status = err?.status || err?.response?.status || 500;
    console.error("[NetherNodes AI Error]", status, msg);

    // Surface specific provider errors to help with debugging
    if (status === 401 || msg.includes("401") || msg.includes("Unauthorized") || msg.includes("API key")) {
      return res.status(500).json({ error: "AI provider authentication failed. Please check the API key." });
    }
    if (status === 429 || msg.includes("429") || msg.includes("rate limit") || msg.includes("quota")) {
      return res.status(500).json({ error: "AI provider rate limit reached. Please try again in a moment." });
    }
    if (status === 503 || msg.includes("503") || msg.includes("unavailable") || msg.includes("overloaded")) {
      return res.status(500).json({ error: "AI provider is temporarily unavailable. Please try again shortly." });
    }
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
app.post("/api/create-order", requireUser, async (req, res) => {
  const { planName, currency, couponCode } = req.body;

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
      userEmail: req.user.email,
    });

    savePaymentOrder({
      providerOrderId: order.orderId,
      userId: req.user.id,
      userEmail: req.user.email,
      planName: planKey,
      originalPrice, discountAmount, finalPrice, couponLabel,
      currency: "INR", mock: Boolean(order.mock), status: "created",
      createdAt: new Date().toISOString(),
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
app.post("/api/verify-payment", requireUser, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id) {
    return res.status(400).json({ error: "Missing payment verification fields" });
  }

  const order = getPaymentOrder(razorpay_order_id);
  if (!order || order.userId !== req.user.id) return res.status(404).json({ error: "Payment order not found." });
  if (order.status === "paid") return res.status(409).json({ error: "This payment was already processed." });

  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || secret === "REPLACE_ME") {
    if (!order.mock) return res.status(400).json({ error: "Mock payments are not enabled for this order." });
  } else {
    if (!razorpay_signature) return res.status(400).json({ error: "Missing payment signature." });
    const expectedSig = crypto.createHmac("sha256", secret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");
    const expectedBuffer = Buffer.from(expectedSig);
    const receivedBuffer = Buffer.from(razorpay_signature);
    if (expectedBuffer.length !== receivedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
      return res.status(400).json({ error: "Payment verification failed." });
    }
  }

  const paidOrder = markPaymentOrderPaid(razorpay_order_id, razorpay_payment_id);
  if (!paidOrder) return res.status(409).json({ error: "This payment was already processed." });
  const planSpec = PLAN_SPECS[paidOrder.planName];
  const invoice = await createAndSendInvoice({
    userEmail: req.user.email, planName: paidOrder.planName, planRam: planSpec.ram,
    originalPrice: paidOrder.originalPrice, discountAmount: paidOrder.discountAmount,
    finalPrice: paidOrder.finalPrice, currency: paidOrder.currency,
    razorpayPaymentId: razorpay_payment_id, razorpayOrderId: razorpay_order_id,
    couponLabel: paidOrder.couponLabel,
  });
  const pending = _createPendingServerForUser({ user: req.user, planName: paidOrder.planName, invoiceOrderId: invoice.orderId });
  return res.json({ verified: true, mock: Boolean(order.mock), orderId: invoice.orderId, serverId: pending.id });

  /* Legacy verification implementation intentionally removed. It is kept
     out of execution while this source tree is migrated. */
  /*
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || secret === "REPLACE_ME") {
    // Dev mode — mock verification + invoice
    console.log("[Payment] Mock verification for", planName, userEmail);
    const planSpec = PLAN_SPECS[planName] || {};
    const invoice = await createAndSendInvoice({
      userEmail, planName,
      planRam: planSpec.ram || "N/A",
      originalPrice: originalPrice || planSpec.priceInr || 0,
      discountAmount: discountAmount || 0,
      finalPrice: finalPrice || planSpec.priceInr || 0,
      currency: "INR",
      razorpayPaymentId: razorpay_payment_id,
      razorpayOrderId: razorpay_order_id,
      couponLabel,
    });
    return res.json({ verified: true, mock: true, planName, userEmail, orderId: invoice.orderId });
    // Note: mock mode also provisions so dev flow works end-to-end
  }

  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSig = crypto.createHmac("sha256", secret).update(body).digest("hex");

  if (expectedSig !== razorpay_signature) {
    return res.status(400).json({ error: "Payment verification failed — signature mismatch" });
  }

  console.log("[Payment] Verified:", razorpay_payment_id, "for", planName, userEmail);

  // Generate invoice and send email
  const planSpec = PLAN_SPECS[planName] || {};
  const invoice = await createAndSendInvoice({
    userEmail, planName,
    planRam: planSpec.ram || "N/A",
    originalPrice: originalPrice || planSpec.priceInr || 0,
    discountAmount: discountAmount || 0,
    finalPrice: finalPrice || planSpec.priceInr || 0,
    currency: "INR",
    razorpayPaymentId: razorpay_payment_id,
    razorpayOrderId: razorpay_order_id,
    couponLabel,
  });

  res.json({ verified: true, mock: false, planName, userEmail, paymentId: razorpay_payment_id, orderId: invoice.orderId });

  // ── Async: create Pterodactyl user + pending server record ──────────────────
  setImmediate(async () => {
    try {
      await _provisionAfterPayment({ userEmail, planName, userId: req.body.userId ?? null, invoiceOrderId: invoice.orderId });
    } catch (err) {
      console.error("[Pterodactyl] Post-payment provision failed:", err.message);
    }
  });
  }
  */
});

// ── POST /api/resend-invoice ──────────────────────────────────────────────────
app.post("/api/resend-invoice", async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: "orderId is required" });

  const invoice = getInvoiceById(orderId.trim());
  if (!invoice) return res.status(404).json({ error: "Invoice not found. Please check your Order ID." });

  try {
    await createAndSendInvoice({
      userEmail:        invoice.userEmail,
      planName:         invoice.planName,
      planRam:          invoice.planRam,
      originalPrice:    invoice.originalPrice,
      discountAmount:   invoice.discountAmount,
      finalPrice:       invoice.finalPrice,
      currency:         invoice.currency,
      razorpayPaymentId: invoice.razorpayPaymentId,
      razorpayOrderId:  invoice.razorpayOrderId,
      couponLabel:      invoice.couponLabel,
    });
    console.log(`[Invoice] Resent ${orderId} to ${invoice.userEmail}`);
    res.json({ ok: true, email: invoice.userEmail });
  } catch (err) {
    res.status(500).json({ error: "Failed to resend invoice." });
  }
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
app.post("/api/auth/signup", async (req, res) => {
  const { name, username, email, password } = req.body;
  try {
    const result = await userSignup(name, username, email, password);

    // Send verification email (non-fatal)
    const verifyUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/verify-email?token=${result.verificationToken}`;
    try {
      const nodemailer = await import("nodemailer");
      const transport = nodemailer.default.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transport.sendMail({
        from: `"NetherNodes" <${process.env.SMTP_USER}>`,
        to: result.user.email,
        subject: "Verify your NetherNodes account",
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <div style="background:#1a0a0a;padding:20px;border-radius:8px 8px 0 0">
              <h2 style="color:#e53935;margin:0">Welcome to NetherNodes 🔥</h2>
            </div>
            <div style="background:#111;padding:20px;color:#ddd;border-radius:0 0 8px 8px">
              <p>Hi ${result.user.name},</p>
              <p>Click the button below to verify your email address. This link expires in 24 hours.</p>
              <a href="${verifyUrl}" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#e53935;color:white;text-decoration:none;border-radius:4px;font-weight:bold">Verify Email</a>
              <p style="color:#888;font-size:12px">Or copy this link: ${verifyUrl}</p>
              <p style="color:#888;font-size:12px;margin-top:24px">— NetherNodes Team</p>
            </div>
          </div>
        `,
      });
    } catch (mailErr) {
      console.warn("[Auth] Verification email failed:", mailErr?.message);
    }

    res.status(201).json({ token: result.token, user: result.user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/auth/verify-email ────────────────────────────────────────────────
app.get("/api/auth/verify-email", (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: "Token is required." });
  try {
    const user = verifyEmail(token);
    res.json({ message: "Email verified successfully.", user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/auth/resend-verification ───────────────────────────────────────
app.post("/api/auth/resend-verification", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required." });
  try {
    const result = resendVerification(email);
    const verifyUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/verify-email?token=${result.verificationToken}`;
    try {
      const nodemailer = await import("nodemailer");
      const transport = nodemailer.default.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transport.sendMail({
        from: `"NetherNodes" <${process.env.SMTP_USER}>`,
        to: result.email,
        subject: "Verify your NetherNodes account",
        html: `<p>Hi ${result.name},</p><p><a href="${verifyUrl}">Click here to verify your email</a> (expires in 24 hours).</p>`,
      });
    } catch (mailErr) {
      console.warn("[Auth] Resend verification email failed:", mailErr?.message);
    }
    res.json({ message: "Verification email sent." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
app.post("/api/auth/login", async (req, res) => {
  const { email, identifier, password } = req.body;
  // Accept either "identifier" (new) or "email" (legacy) field
  try {
    const result = await userLogin(identifier || email, password);
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
  userLogout();
  res.json({ ok: true });
});

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required." });

  // Always return 200 to prevent email enumeration
  const result = forgotPassword(email);
  if (result) {
    const resetUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/reset-password?token=${result.resetToken}`;
    try {
      const nodemailer = await import("nodemailer");
      const transport = nodemailer.default.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transport.sendMail({
        from: `"NetherNodes" <${process.env.SMTP_USER}>`,
        to: result.email,
        subject: "Reset your NetherNodes password",
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <div style="background:#1a0a0a;padding:20px;border-radius:8px 8px 0 0">
              <h2 style="color:#e53935;margin:0">Password Reset</h2>
            </div>
            <div style="background:#111;padding:20px;color:#ddd;border-radius:0 0 8px 8px">
              <p>Hi ${result.name},</p>
              <p>Click the button below to reset your password. This link expires in 30 minutes.</p>
              <a href="${resetUrl}" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#e53935;color:white;text-decoration:none;border-radius:4px;font-weight:bold">Reset Password</a>
              <p style="color:#888;font-size:12px">If you didn't request this, ignore this email.</p>
            </div>
          </div>
        `,
      });
    } catch (mailErr) {
      console.warn("[Auth] Reset email failed:", mailErr?.message);
    }
  }

  res.json({ message: "If an account exists with that email, a reset link has been sent." });
});

// ── POST /api/auth/reset-password ────────────────────────────────────────────
app.post("/api/auth/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "Token and password are required." });
  try {
    const user = await resetPassword(token, password);
    res.json({ message: "Password reset successfully.", user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/claim-free ──────────────────────────────────────────────────────
// Handles the free plan (Basic) — no Razorpay needed, just provision directly
app.post("/api/claim-free", requireUser, async (req, res) => {
  const { planName } = req.body;
  if (!planName) return res.status(400).json({ error: "planName is required." });

  const planKey = Object.keys(PLAN_SPECS).find(k => k.toLowerCase() === String(planName).toLowerCase());
  if (!planKey) return res.status(400).json({ error: "Invalid plan." });

  const spec = PLAN_SPECS[planKey];
  if (spec.priceInr !== 0) return res.status(400).json({ error: "Only free plans can use this endpoint." });

  const existing = getServersByUser(req.user.id, req.user.email).filter(s => s.planName === planKey);

  // If there's already a pending_setup server for this plan, just redirect to it
  const pendingExisting = existing.find(s => s.status === "pending_setup");
  if (pendingExisting) {
    return res.json({ ok: true, planName: planKey, invoiceOrderId: pendingExisting.invoiceOrderId, serverId: pendingExisting.id });
  }

  // If a provisioned/active server already exists, block
  const activeExisting = existing.find(s => s.status !== "pending_setup");
  if (activeExisting) {
    return res.status(409).json({ error: "Your account has already claimed this free plan." });
  }

  const issuedInvoice = await createAndSendInvoice({
    userEmail: req.user.email, planName: planKey, planRam: spec.ram,
    originalPrice: 0, discountAmount: 0, finalPrice: 0, currency: "INR",
    razorpayPaymentId: "FREE", razorpayOrderId: `FREE_${Date.now()}`, couponLabel: "Free Plan",
  });
  const pendingServer = _createPendingServerForUser({ user: req.user, planName: planKey, invoiceOrderId: issuedInvoice.orderId });
  return res.json({ ok: true, planName: planKey, invoiceOrderId: issuedInvoice.orderId, serverId: pendingServer.id });

  // Generate a fake invoice ID for tracking
  const { createAndSendInvoice: legacyCreateAndSendInvoice } = await import("./lib/invoice.js");
  let invoiceOrderId = null;
  try {
    const invoice = await legacyCreateAndSendInvoice({
      userEmail, planName: planKey,
      planRam: spec.ram,
      originalPrice: 0, discountAmount: 0, finalPrice: 0,
      currency: "INR",
      razorpayPaymentId: "FREE", razorpayOrderId: "FREE",
      couponLabel: "Free Plan",
    });
    invoiceOrderId = invoice.orderId;
  } catch (err) {
    console.warn("[ClaimFree] Invoice creation failed:", err.message);
  }

  // Provision async — respond immediately
  res.json({ ok: true, planName: planKey, invoiceOrderId });

  setImmediate(async () => {
    try {
      await _provisionAfterPayment({ userEmail, planName: planKey, userId: userId ?? null, invoiceOrderId });
    } catch (err) {
      console.error("[ClaimFree] Provision failed:", err.message);
    }
  });
});
// Returns the available server types for the setup wizard
app.get("/api/server-types", (_req, res) => {
  res.json(getServerTypes());
});

// ── GET /api/servers/pending ──────────────────────────────────────────────────
// Find pending-setup servers by invoice orderId or by the logged-in user
app.get("/api/servers/pending", requireUser, (req, res) => {
  const { orderId } = req.query;
  const pending = getServersByUser(req.user.id, req.user.email).filter(s => s.status === "pending_setup");
  const matches = orderId ? pending.filter(s => s.invoiceOrderId === orderId) : pending;
  return res.json(matches.map(_serializeServer));
});

// ── POST /api/servers/:id/setup ───────────────────────────────────────────────
// Called from the setup wizard — provisions the actual Pterodactyl server
app.post("/api/servers/:id/setup", requireUser, async (req, res) => {
  const { serverName, serverType, mcVersion, javaVersion } = req.body;

  if (!serverName?.trim()) return res.status(400).json({ error: "Server name is required." });
  if (!serverType)         return res.status(400).json({ error: "Server type is required." });

  let srv = getServer(req.params.id, req.user.id, req.user.email);

  if (!srv) return res.status(404).json({ error: "Server not found." });
  if (srv.status !== "pending_setup") {
    return res.status(400).json({ error: "Server is already set up or being provisioned." });
  }

  try {
    // Get or create the Pterodactyl user for this customer
    const ptUser = await ensurePterodactylUser({
      email:    req.user.email,
      username: req.user.username,
      name:     req.user.name,
    });

    // Resolve egg ID from server type string
    const chosen = getServerTypeConfig(serverType);
    if (!chosen) return res.status(400).json({ error: "Invalid server type." });

    // Reserve the record before the external call so a double-click cannot create two servers.
    if (!beginServerProvisioning(srv.id, req.user.id)) {
      return res.status(409).json({ error: "Server setup is already in progress." });
    }

    // Provision on Pterodactyl
    const ptServer = await provisionServer({
      pterodactylUserId: ptUser.id,
      serverName:  serverName.trim().slice(0, 48),
      planName:    srv.planName,
      eggId:       chosen.eggId,
      mcVersion:   mcVersion || "latest",
      javaVersion: javaVersion || null,
    });

    // Build the subdomain/connection string
    // _resolvedAllocation is set by provisionServer from the relationships data
    const allocation = ptServer._resolvedAllocation || {};
    const connectionAddress = allocation.ip
      ? `${allocation.ip}${allocation.port ? `:${allocation.port}` : ""}`
      : null;

    // Update local record
    const updated = markServerProvisioned(srv.id, {
      pterodactylId:         ptServer.id,
      pterodactylIdentifier: ptServer._identifier ?? null,
      connectionAddress,
      serverType,
      mcVersion: mcVersion || "latest",
      name: serverName.trim(),
    });

    console.log(`[Pterodactyl] Server ${ptServer.id} provisioned for user ${req.user.email}`);
    res.json({ ok: true, server: _serializeServer(updated) });

  } catch (err) {
    console.error("[Pterodactyl] Setup error:", err.message);
    setServerStatus(srv.id, req.user.id, "pending_setup");
    res.status(502).json({ error: "Server provisioning is temporarily unavailable. Please try again." });
  }
});

// ── GET /api/servers ──────────────────────────────────────────────────────────
app.get("/api/servers", requireUser, async (req, res) => {
  const records = getServersByUser(req.user.id, req.user.email);

  const PTERODACTYL_TIMEOUT_MS = 5000;

  const enriched = await Promise.allSettled(
    records.map(async srv => {
      // Servers not yet provisioned on Pterodactyl — return as-is
      if (!srv.pterodactylId) return _serializeServer(srv);

      // Attempt live status fetch with a hard timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PTERODACTYL_TIMEOUT_MS);
      try {
        const ptSrv = await getPterodactylServer(srv.pterodactylId, controller.signal);
        clearTimeout(timer);
        if (ptSrv) {
          const liveStatus = _mapPterodactylStatus(ptSrv);
          updateServer(srv.id, { status: liveStatus });
          return _serializeServer({ ...srv, status: liveStatus });
        }
        // Panel returned nothing — status unknown
        return _serializeServer({ ...srv, status: "unknown" });
      } catch (err) {
        clearTimeout(timer);
        // Timeout or network error — do not claim "stopped", use "unknown"
        const isTimeout = err?.name === "AbortError" || err?.message?.includes("abort");
        console.warn(`[Pterodactyl] Status fetch ${isTimeout ? "timed out" : "failed"} for server ${srv.pterodactylId}`);
        return _serializeServer({ ...srv, status: "unknown" });
      }
    })
  );

  // allSettled: extract values; fulfilled = normal result, rejected = unexpected
  const results = enriched.map((outcome, i) => {
    if (outcome.status === "fulfilled") return outcome.value;
    console.error("[Pterodactyl] Unexpected rejection for server", records[i]?.id, outcome.reason);
    return _serializeServer({ ...records[i], status: "unknown" });
  });

  res.json(results);
});

// ── POST /api/servers/:id/start ───────────────────────────────────────────────
app.post("/api/servers/:id/start", requireUser, async (req, res) => {
  const srv = getServer(req.params.id, req.user.id, req.user.email);
  if (!srv) return res.status(404).json({ error: "Server not found" });
  if (srv.status === "pending_setup") return res.status(400).json({ error: "Complete server setup first." });
  return res.status(501).json({ error: "Power controls are not available yet." });

  if (srv.pterodactylId) {
    // Send power signal via Pterodactyl Client API (wings)
    try {
      await _pterodactylClientPower(srv.pterodactylId, "start");
    } catch (err) {
      console.warn("[Pterodactyl] Start signal failed:", err.message);
    }
  }

  const updated = setServerStatus(srv.id, req.user.id, "starting");
  res.json(_serializeServer(updated));
});

// ── POST /api/servers/:id/stop ────────────────────────────────────────────────
app.post("/api/servers/:id/stop", requireUser, async (req, res) => {
  const srv = getServer(req.params.id, req.user.id, req.user.email);
  if (!srv) return res.status(404).json({ error: "Server not found" });
  return res.status(501).json({ error: "Power controls are not available yet." });

  if (srv.pterodactylId) {
    try {
      await _pterodactylClientPower(srv.pterodactylId, "stop");
    } catch (err) {
      console.warn("[Pterodactyl] Stop signal failed:", err.message);
    }
  }

  const updated = setServerStatus(srv.id, req.user.id, "stopping");
  res.json(_serializeServer(updated));
});

// ── GET /api/servers/:id/status ───────────────────────────────────────────────
app.get("/api/servers/:id/status", requireUser, async (req, res) => {
  const srv = getServer(req.params.id, req.user.id, req.user.email);
  if (!srv) return res.status(404).json({ error: "Server not found" });

  if (!srv.pterodactylId) {
    return res.json({ status: srv.status });
  }

  try {
    const ptSrv = await getPterodactylServer(srv.pterodactylId);
    const status = ptSrv ? _mapPterodactylStatus(ptSrv) : srv.status;
    updateServer(srv.id, { status });
    res.json({ status });
  } catch {
    res.json({ status: srv.status });
  }
});

// ── Helper: provision Pterodactyl user+server after payment ───────────────────
function _createPendingServerForUser({ user, planName, invoiceOrderId }) {
  const spec = PLAN_SPECS[planName];
  if (!spec) throw new Error("Unknown plan.");
  return createPendingServer({
    userId: user.id, planName, email: user.email,
    ram: spec.ram, cpu: spec.cpu, ssd: spec.ssd, invoiceOrderId,
  });
}

async function _provisionAfterPayment({ userEmail, planName, userId, invoiceOrderId }) {
  if (!process.env.PTERODACTYL_URL || !process.env.PTERODACTYL_API_KEY) {
    console.warn("[Pterodactyl] Not configured — skipping post-payment provisioning.");
    return;
  }

  const spec = PLAN_SPECS[planName];
  if (!spec) { console.warn("[Pterodactyl] Unknown plan:", planName); return; }

  const ptUser = await ensurePterodactylUser({
    email:    userEmail,
    username: userEmail.split("@")[0],
    name:     "NetherNodes User",
  });

  // Find user in our DB to get their userId — use already-imported fs/path/url
  let resolvedUserId = userId;
  if (!resolvedUserId) {
    try {
      const usersPath = resolve(__dirname, "../data/users_app.json");
      if (existsSync(usersPath)) {
        const users = JSON.parse(readFileSync(usersPath, "utf-8"));
        const u = users.find(u => u.email === userEmail.toLowerCase());
        if (u) resolvedUserId = u.id;
      }
    } catch { /* non-fatal */ }
  }

  createPendingServer({
    userId:              resolvedUserId || `guest_${Date.now()}`,
    planName,
    email:               userEmail,
    ram:                 spec.ram,
    cpu:                 spec.cpu,
    ssd:                 spec.ssd,
    pterodactylUserId:   ptUser.id,
    invoiceOrderId,
  });

  console.log(`[Pterodactyl] Pending server record created for ${userEmail} (${planName}). User ID: ${ptUser.id}`);
}

// ── Helper: map Pterodactyl Application API response to our status strings ────
// NOTE: The Application API does NOT provide live runtime status the way the
// Client API does. We can reliably detect suspended and installing states.
// For actual running/stopped state we read ptSrv.container?.status.
// If that is absent or unrecognised, we return "unknown" — never falsely "stopped".
function _mapPterodactylStatus(ptSrv) {
  if (!ptSrv) return "unknown";
  if (ptSrv.suspended)  return "suspended";
  if (ptSrv.installing) return "installing";
  if (ptSrv.transferring) return "transferring";

  // Application API surfaces container state under container.status (not top-level)
  const containerStatus = ptSrv.container?.status;
  if (containerStatus === "running")  return "running";
  if (containerStatus === "stopping") return "stopping";
  if (containerStatus === "starting") return "starting";
  if (containerStatus === "stopped")  return "stopped";
  if (containerStatus === "offline")  return "stopped";

  // Status could not be determined from the Application API
  return "unknown";
}

// ── Helper: serialize server for frontend (never expose panel URL) ────────────
function _serializeServer(srv) {
  return {
    id:          srv.id,
    name:        srv.name,
    status:      srv.status,
    ram:         srv.ram,
    cpu:         srv.cpu,
    ssd:         srv.ssd,
    plan:        srv.planName,
    subdomain:   srv.connectionAddress,
    serverType:  srv.serverType,
    mcVersion:   srv.mcVersion,
    pendingSetup: srv.status === "pending_setup",
    createdAt:   srv.createdAt,
    // The allocation address is safe connection metadata; never expose the panel URL.
    host:        srv.connectionAddress || null,
  };
}

// ── Helper: look up a NetherNodes app user by email ──────────────────────────
function loadAppUserByEmail(email) {
  try {
    const usersPath = resolve(__dirname, "../data/users_app.json");
    if (!existsSync(usersPath)) return null;
    const users = JSON.parse(readFileSync(usersPath, "utf-8"));
    return users.find(u => u.email === email.trim().toLowerCase()) ?? null;
  } catch { return null; }
}

// ── Helper: Pterodactyl Client API fetch ─────────────────────────────────────
async function clientFetch(identifier, path, options = {}) {
  const panelUrl   = process.env.PTERODACTYL_URL?.replace(/\/$/, "");
  const clientKey  = process.env.PTERODACTYL_CLIENT_KEY;
  if (!panelUrl || !clientKey) throw new Error("Pterodactyl Client API is not configured.");

  const url = `${panelUrl}/api/client/servers/${identifier}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${clientKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok && res.status !== 204) {
    let body = "";
    try { body = JSON.stringify(await res.json()); } catch {}
    throw new Error(`Pterodactyl Client API error ${res.status} on ${path}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function clientFetchRaw(identifier, path) {
  const panelUrl   = process.env.PTERODACTYL_URL?.replace(/\/$/, "");
  const clientKey  = process.env.PTERODACTYL_CLIENT_KEY;
  if (!panelUrl || !clientKey) throw new Error("Pterodactyl Client API is not configured.");

  const url = `${panelUrl}/api/client/servers/${identifier}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${clientKey}`, Accept: "text/plain" },
  });
  if (!res.ok) {
    let body = "";
    try { body = JSON.stringify(await res.json()); } catch {}
    throw new Error(`Pterodactyl Client API error ${res.status} on ${path}: ${body}`);
  }
  return res.text();
}

async function clientFetchWrite(identifier, path, content) {
  const panelUrl   = process.env.PTERODACTYL_URL?.replace(/\/$/, "");
  const clientKey  = process.env.PTERODACTYL_CLIENT_KEY;
  if (!panelUrl || !clientKey) throw new Error("Pterodactyl Client API is not configured.");

  const url = `${panelUrl}/api/client/servers/${identifier}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clientKey}`,
      "Content-Type": "text/plain",
    },
    body: content,
  });
  if (!res.ok && res.status !== 204) {
    let body = "";
    try { body = JSON.stringify(await res.json()); } catch {}
    throw new Error(`Pterodactyl write error ${res.status} on ${path}: ${body}`);
  }
  return true;
}

// ── Helper: Pterodactyl Client API power signal ───────────────────────────────
async function _pterodactylClientPower(pterodactylServerId, signal) {
  const panelUrl = process.env.PTERODACTYL_URL?.replace(/\/$/, "");
  const apiKey   = process.env.PTERODACTYL_API_KEY;
  // Application API can't send power signals — use client API endpoint
  // This requires a client API key. For now, log a warning.
  // TODO: add PTERODACTYL_CLIENT_KEY to .env for a client API key with server power permissions
  console.log(`[Pterodactyl] Power signal "${signal}" for server ${pterodactylServerId} (configure PTERODACTYL_CLIENT_KEY for live power control)`);
}

// ── GET /api/servers/:id/users ────────────────────────────────────────────────
app.get("/api/servers/:id/users", requireUser, async (req, res) => {
  const srv = getServer(req.params.id, req.user.id, req.user.email);
  if (!srv) return res.status(404).json({ error: "Server not found." });
  if (!srv.pterodactylId) return res.status(400).json({ error: "Server is not yet provisioned." });

  const identifier = srv.pterodactylIdentifier || srv.pterodactylId;
  try {
    const data = await clientFetch(identifier, "/users");
    // Enrich each subuser with their NetherNodes account info
    const subusers = (data?.data ?? []).map(u => {
      const attr = u.attributes;
      // Look up whether this email has a NetherNodes account
      const nnUser = loadAppUserByEmail(attr.email);
      return {
        uuid:        attr.uuid,
        username:    attr.username,
        email:       attr.email,
        permissions: attr.permissions ?? [],
        twoFactor:   attr.two_factor_authentication,
        nnAccount:   nnUser ? { name: nnUser.name, username: nnUser.username } : null,
      };
    });
    res.json(subusers);
  } catch (err) {
    console.error("[Users] List failed:", err.message);
    res.status(502).json({ error: "Could not list server users." });
  }
});

// ── POST /api/servers/:id/users ───────────────────────────────────────────────
// Add a subuser — they must have a NetherNodes account
app.post("/api/servers/:id/users", requireUser, async (req, res) => {
  const srv = getServer(req.params.id, req.user.id, req.user.email);
  if (!srv) return res.status(404).json({ error: "Server not found." });
  if (!srv.pterodactylId) return res.status(400).json({ error: "Server is not yet provisioned." });

  const { email, permissions } = req.body;
  if (!email) return res.status(400).json({ error: "email is required." });
  if (email.toLowerCase() === req.user.email.toLowerCase()) {
    return res.status(400).json({ error: "You are already the server owner." });
  }

  // Require the invited user to have a NetherNodes account
  const nnUser = loadAppUserByEmail(email);
  if (!nnUser) {
    return res.status(404).json({ error: "No NetherNodes account found with that email. The user must sign up first." });
  }

  const identifier = srv.pterodactylIdentifier || srv.pterodactylId;
  const defaultPerms = permissions ?? [
    "control.console", "control.start", "control.stop", "control.restart",
    "file.read", "file.read-content", "file.create", "file.update",
  ];

  try {
    const data = await clientFetch(identifier, "/users", {
      method: "POST",
      body: JSON.stringify({ email: email.toLowerCase(), permissions: defaultPerms }),
    });
    const attr = data?.attributes ?? {};
    console.log(`[Users] Added ${email} to server ${srv.id} by ${req.user.email}`);
    res.json({
      uuid:        attr.uuid,
      username:    attr.username,
      email:       attr.email,
      permissions: attr.permissions ?? defaultPerms,
      nnAccount:   { name: nnUser.name, username: nnUser.username },
    });
  } catch (err) {
    console.error("[Users] Add failed:", err.message);
    if (err.message.includes("already")) {
      return res.status(409).json({ error: "This user already has access to the server." });
    }
    res.status(502).json({ error: "Could not add user. " + err.message });
  }
});

// ── PATCH /api/servers/:id/users/:uuid ────────────────────────────────────────
app.patch("/api/servers/:id/users/:uuid", requireUser, async (req, res) => {
  const srv = getServer(req.params.id, req.user.id, req.user.email);
  if (!srv) return res.status(404).json({ error: "Server not found." });
  if (!srv.pterodactylId) return res.status(400).json({ error: "Server is not yet provisioned." });

  const { permissions } = req.body;
  if (!Array.isArray(permissions)) return res.status(400).json({ error: "permissions array is required." });

  const identifier = srv.pterodactylIdentifier || srv.pterodactylId;
  try {
    const data = await clientFetch(identifier, `/users/${req.params.uuid}`, {
      method: "POST",
      body: JSON.stringify({ permissions }),
    });
    res.json({ ok: true, permissions: data?.attributes?.permissions ?? permissions });
  } catch (err) {
    console.error("[Users] Update failed:", err.message);
    res.status(502).json({ error: "Could not update permissions." });
  }
});

// ── DELETE /api/servers/:id/users/:uuid ───────────────────────────────────────
app.delete("/api/servers/:id/users/:uuid", requireUser, async (req, res) => {
  const srv = getServer(req.params.id, req.user.id, req.user.email);
  if (!srv) return res.status(404).json({ error: "Server not found." });
  if (!srv.pterodactylId) return res.status(400).json({ error: "Server is not yet provisioned." });

  const identifier = srv.pterodactylIdentifier || srv.pterodactylId;
  try {
    await clientFetch(identifier, `/users/${req.params.uuid}`, { method: "DELETE" });
    console.log(`[Users] Removed subuser ${req.params.uuid} from server ${srv.id} by ${req.user.email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[Users] Remove failed:", err.message);
    res.status(502).json({ error: "Could not remove user." });
  }
});
app.get("/api/servers/:id/files", requireUser, async (req, res) => {
  const srv = getServer(req.params.id, req.user.id, req.user.email);
  if (!srv) return res.status(404).json({ error: "Server not found." });
  if (!srv.pterodactylId) return res.status(400).json({ error: "Server is not yet provisioned." });

  const identifier = srv.pterodactylIdentifier || srv.pterodactylId;
  const dir = req.query.directory || "/";

  try {
    const data = await clientFetch(identifier, `/files/list?directory=${encodeURIComponent(dir)}`);
    res.json(data?.data ?? []);
  } catch (err) {
    console.error("[Files] List failed:", err.message);
    res.status(502).json({ error: "Could not list files." });
  }
});

// ── GET /api/servers/:id/files/contents ───────────────────────────────────────
app.get("/api/servers/:id/files/contents", requireUser, async (req, res) => {
  const srv = getServer(req.params.id, req.user.id, req.user.email);
  if (!srv) return res.status(404).json({ error: "Server not found." });
  if (!srv.pterodactylId) return res.status(400).json({ error: "Server is not yet provisioned." });

  const { file } = req.query;
  if (!file) return res.status(400).json({ error: "file path is required." });

  const identifier = srv.pterodactylIdentifier || srv.pterodactylId;

  try {
    const text = await clientFetchRaw(identifier, `/files/contents?file=${encodeURIComponent(file)}`);
    res.json({ content: text });
  } catch (err) {
    console.error("[Files] Read failed:", err.message);
    res.status(502).json({ error: "Could not read file." });
  }
});

// ── POST /api/servers/:id/files/write ─────────────────────────────────────────
app.post("/api/servers/:id/files/write", requireUser, async (req, res) => {
  const srv = getServer(req.params.id, req.user.id, req.user.email);
  if (!srv) return res.status(404).json({ error: "Server not found." });
  if (!srv.pterodactylId) return res.status(400).json({ error: "Server is not yet provisioned." });

  const { file } = req.query;
  const { content } = req.body;
  if (!file) return res.status(400).json({ error: "file path is required." });
  if (content === undefined) return res.status(400).json({ error: "content is required." });

  const identifier = srv.pterodactylIdentifier || srv.pterodactylId;

  try {
    await clientFetchWrite(identifier, `/files/write?file=${encodeURIComponent(file)}`, content);
    res.json({ ok: true });
  } catch (err) {
    console.error("[Files] Write failed:", err.message);
    res.status(502).json({ error: "Could not write file." });
  }
});

// ── DELETE /api/servers/:id/files ─────────────────────────────────────────────
app.delete("/api/servers/:id/files", requireUser, async (req, res) => {
  const srv = getServer(req.params.id, req.user.id, req.user.email);
  if (!srv) return res.status(404).json({ error: "Server not found." });
  if (!srv.pterodactylId) return res.status(400).json({ error: "Server is not yet provisioned." });

  const { files } = req.body; // array of { name, isFile } objects
  if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: "files array is required." });

  const identifier = srv.pterodactylIdentifier || srv.pterodactylId;

  try {
    await clientFetch(identifier, "/files/delete", {
      method: "POST",
      body: JSON.stringify({ root: "/", files }),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[Files] Delete failed:", err.message);
    res.status(502).json({ error: "Could not delete files." });
  }
});
// Returns a short-lived Pterodactyl WebSocket token — never exposes the client key.
app.get("/api/servers/:id/console-token", requireUser, async (req, res) => {
  const srv = getServer(req.params.id, req.user.id, req.user.email);
  if (!srv) return res.status(404).json({ error: "Server not found." });
  if (!srv.pterodactylId) return res.status(400).json({ error: "Server is not yet provisioned." });

  // Client API uses the short identifier (e.g. "23791ccb"), not the numeric ID
  const identifier = srv.pterodactylIdentifier || srv.pterodactylId;

  try {
    const creds = await getConsoleCredentials(identifier);
    res.json(creds);
  } catch (err) {
    console.error("[Console] Token fetch failed:", err.message);
    res.status(502).json({ error: "Could not connect to game panel. Please try again." });
  }
});

// ── POST /api/servers/:id/power ───────────────────────────────────────────────
// signal: start | stop | restart | kill
app.post("/api/servers/:id/power", requireUser, async (req, res) => {
  const { signal } = req.body;
  if (!["start", "stop", "restart", "kill"].includes(signal)) {
    return res.status(400).json({ error: "signal must be start, stop, restart, or kill" });
  }
  const srv = getServer(req.params.id, req.user.id, req.user.email);
  if (!srv) return res.status(404).json({ error: "Server not found." });
  if (!srv.pterodactylId) return res.status(400).json({ error: "Server is not yet provisioned." });

  // Client API uses the short identifier (e.g. "23791ccb"), not the numeric ID
  const identifier = srv.pterodactylIdentifier || srv.pterodactylId;

  try {
    await sendPowerSignal(identifier, signal);
    console.log(`[Power] ${signal} → server ${srv.id} (ptero ${identifier}) by ${req.user.email}`);
    res.json({ ok: true, signal });
  } catch (err) {
    console.error("[Power] Signal failed:", err.message);
    res.status(502).json({ error: "Could not send power signal. Please try again." });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});
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

app.listen(PORT, () => {
  console.log(`NetherNodes API running on port ${PORT}`);
  startGmailPoller(60_000);
});
