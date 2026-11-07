/**
 * NetherNodes Bot Data API
 * ─────────────────────────────────────────────────────────────────────────────
 * A completely separate router from the main API.
 * Authenticated with BOT_DATA_API_KEY header: x-bot-data-key
 *
 * Endpoints:
 *   GET  /bot-api/info              — plans, pricing, active sale banner, FAQs
 *   GET  /bot-api/plans             — live plan specs + prices
 *   GET  /bot-api/sale              — active public sale banner only (no private codes)
 *   GET  /bot-api/users/:identifier — lookup user by email or discordId → tier + servers
 *   GET  /bot-api/stats             — platform-wide counts (paid/free/total)
 *   GET  /bot-api/health            — heartbeat
 */

import { Router } from "express";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getAllTiers, getUserTierByEmail, getUserTier } from "./lib/userTiers.js";
import { getActiveSale } from "./lib/sale.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const router = Router();

// ── Auth middleware ───────────────────────────────────────────────────────────
router.use((req, res, next) => {
  const key = process.env.BOT_DATA_API_KEY;
  if (!key) return res.status(503).json({ error: "Bot Data API not configured. Set BOT_DATA_API_KEY in .env." });
  const provided = req.headers["x-bot-data-key"];
  if (!provided || provided !== key) {
    return res.status(401).json({ error: "Unauthorized. Invalid or missing x-bot-data-key header." });
  }
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJson(filename) {
  const p = resolve(__dirname, "../data", filename);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

function loadPlanPrices() {
  const DEFAULTS = {
    Nano:    { ram: "1GB",  cpu: "75%",  ssd: "5GB",   priceInr: 69,   tier: "Entry" },
    Basic:   { ram: "2GB",  cpu: "100%", ssd: "10GB",  priceInr: 149,  tier: "Entry" },
    Plus:    { ram: "3GB",  cpu: "150%", ssd: "15GB",  priceInr: 129,  tier: "Entry" },
    Starter: { ram: "4GB",  cpu: "200%", ssd: "25GB",  priceInr: 199,  tier: "Community", popular: true },
    Pro:     { ram: "6GB",  cpu: "250%", ssd: "40GB",  priceInr: 329,  tier: "Community" },
    Elite:   { ram: "8GB",  cpu: "300%", ssd: "60GB",  priceInr: 469,  tier: "Community" },
    Ultra:   { ram: "10GB", cpu: "350%", ssd: "80GB",  priceInr: 649,  tier: "Advanced" },
    Max:     { ram: "12GB", cpu: "350%", ssd: "100GB", priceInr: 829,  tier: "Advanced" },
    Titan:   { ram: "16GB", cpu: "400%", ssd: "140GB", priceInr: 1099, tier: "Advanced" },
  };
  const saved = loadJson("plan_prices.json") ?? {};
  const merged = { ...DEFAULTS };
  for (const [name, overrides] of Object.entries(saved)) {
    if (merged[name]) merged[name] = { ...merged[name], ...overrides };
  }
  return merged;
}

function safeServersForUser(userId, email) {
  const servers = loadJson("servers.json") ?? [];
  return servers
    .filter(s => s.userId === userId || s.email === email)
    .map(s => ({
      id:              s.id,
      name:            s.name,
      status:          s.status,
      plan:            s.planName,
      ram:             s.ram,
      serverType:      s.serverType ?? null,
      mcVersion:       s.mcVersion ?? null,
      host:            s.connectionAddress ?? null,
      customAddress:   s.hostname ? `${s.hostname}.nethernodes.online` : null,
      subscriptionStatus: s.subscriptionStatus ?? null,
      createdAt:       s.createdAt,
    }));
}

function findUser(identifier) {
  const users = loadJson("users_app.json") ?? [];
  const clean = identifier.trim().toLowerCase();
  // Match by email, username, discordId, or userId
  return users.find(u =>
    u.email === clean ||
    u.username?.toLowerCase() === clean ||
    u.discordId === identifier.trim() ||
    u.id === identifier.trim()
  ) ?? null;
}

// ── GET /bot-api/health ───────────────────────────────────────────────────────
router.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), service: "NetherNodes Bot Data API" });
});

// ── GET /bot-api/plans ────────────────────────────────────────────────────────
// Live plan specs + prices (reflects any admin price changes instantly)
router.get("/plans", (_req, res) => {
  const specs = loadPlanPrices();
  const plans = Object.entries(specs).map(([name, s]) => ({
    name,
    ram:      s.ram,
    cpu:      s.cpu,
    ssd:      s.ssd,
    priceInr: s.priceInr,
    tier:     s.tier,
    popular:  s.popular ?? false,
    priceFormatted: s.priceInr === 0 ? "Free" : `₹${s.priceInr.toLocaleString("en-IN")}/month`,
  }));
  res.json({ plans, updatedAt: new Date().toISOString() });
});

// ── GET /bot-api/sale ─────────────────────────────────────────────────────────
// Only exposes the PUBLIC sale banner — never private codes or multi-codes
router.get("/sale", (_req, res) => {
  const sale = getActiveSale();
  if (!sale || sale.mode !== "public") {
    return res.json({ active: false, message: "No public sale active right now." });
  }
  res.json({
    active:       true,
    label:        sale.label,
    discount:     sale.discount,
    discountType: sale.discountType,   // "percent" | "fixed"
    plans:        sale.plans,          // "all" or array of plan names
    endDate:      sale.endDate ?? null,
    showCountdown: sale.showCountdown ?? false,
    formatted:    sale.discountType === "percent"
      ? `${sale.discount}% off`
      : `₹${sale.discount} off`,
  });
});

// ── GET /bot-api/info ─────────────────────────────────────────────────────────
// All public info in one call: plans + sale + FAQs
router.get("/info", (_req, res) => {
  const specs = loadPlanPrices();
  const plans = Object.entries(specs).map(([name, s]) => ({
    name,
    ram: s.ram, cpu: s.cpu, ssd: s.ssd,
    priceInr: s.priceInr, tier: s.tier, popular: s.popular ?? false,
    priceFormatted: s.priceInr === 0 ? "Free" : `₹${s.priceInr.toLocaleString("en-IN")}/month`,
  }));

  const sale = getActiveSale();
  const activeSale = (sale && sale.mode === "public") ? {
    active: true, label: sale.label, discount: sale.discount,
    discountType: sale.discountType, plans: sale.plans, endDate: sale.endDate ?? null,
    formatted: sale.discountType === "percent" ? `${sale.discount}% off` : `₹${sale.discount} off`,
  } : { active: false };

  const faqs = [
    { q: "What is NetherNodes?",        a: "NetherNodes is an Indian Minecraft server hosting platform. Instant setup, DDoS protection, and competitive prices." },
    { q: "Where are the servers?",      a: "All servers are India-based for the lowest ping in India. More regions coming soon." },
    { q: "What payment methods?",       a: "Razorpay — UPI, credit/debit cards, net banking, wallets. INR only." },
    { q: "Is there a free plan?",       a: "The Basic 2GB plan is sometimes offered free during promotions. Check the website for current pricing." },
    { q: "How do I get support?",       a: "Submit a ticket at nethernodes.online/support or ask the NetherNodes AI chatbot." },
    { q: "What is the refund policy?",  a: "48-hour money-back guarantee on first purchase." },
    { q: "Can I upgrade my plan?",      a: "Not yet via the panel — contact support and we'll migrate your server." },
    { q: "What MC versions are supported?", a: "All Java Edition versions including 1.8 through the latest. Switch anytime from your server panel." },
    { q: "Is there DDoS protection?",   a: "Yes — all plans include DDoS protection. Higher tiers get Advanced Shield and Enterprise Anycast." },
    { q: "How do I link my Discord?",   a: "Go to Account Settings on the website and use the Link Discord button to get a code, then verify in Discord." },
  ];

  res.json({
    platform: "NetherNodes",
    website:  "https://nethernodes.online",
    support:  "supportnethernodes@gmail.com",
    plans,
    sale:     activeSale,
    faqs,
    updatedAt: new Date().toISOString(),
  });
});

// ── GET /bot-api/users/:identifier ────────────────────────────────────────────
// Look up a user by email, username, discordId, or userId
// Returns: tier (paid/free), reason, servers, subscription summary
router.get("/users/:identifier", (req, res) => {
  const user = findUser(req.params.identifier);
  if (!user) {
    return res.status(404).json({
      error: "User not found.",
      hint: "Pass email, username, discordId, or internal userId.",
    });
  }

  // Get tier record
  const tierRecord = getUserTier(user.id) ?? getUserTierByEmail(user.email);

  // Get servers
  const servers = safeServersForUser(user.id, user.email);

  // Get subscriptions summary
  const subs = loadJson("subscriptions.json") ?? [];
  const userSubs = subs
    .filter(s => s.userId === user.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(s => ({
      id:                    s.id,
      plan:                  s.planName,
      status:                s.status,
      amountInr:             s.amountInr,
      currentPeriodEnd:      s.currentPeriodEnd ?? null,
      gracePeriodEnd:        s.gracePeriodEnd ?? null,
      nextBillingDate:       s.nextBillingDate ?? null,
      cancelledAt:           s.cancelledAt ?? null,
      createdAt:             s.createdAt,
    }));

  res.json({
    userId:      user.id,
    name:        user.name,
    username:    user.username,
    email:       user.email,
    discordId:   user.discordId ?? null,
    emailVerified: user.emailVerified,
    createdAt:   user.createdAt,
    tier:        tierRecord?.tier ?? "free",
    tierReason:  tierRecord?.reason ?? "no_subscription",
    tierUpdatedAt: tierRecord?.updatedAt ?? null,
    gracePeriodEnd: tierRecord?.gracePeriodEnd ?? null,
    activeSubId: tierRecord?.activeSubId ?? null,
    servers,
    subscriptions: userSubs,
    summary: {
      serverCount:      servers.length,
      activeServers:    servers.filter(s => s.status === "running").length,
      subscriptionCount: userSubs.length,
      activeSubscriptions: userSubs.filter(s => s.status === "active").length,
    },
  });
});

// ── GET /bot-api/stats ────────────────────────────────────────────────────────
// Platform-wide counts — useful for bot status embeds
router.get("/stats", (_req, res) => {
  const tiers   = getAllTiers();
  const users   = loadJson("users_app.json") ?? [];
  const servers = loadJson("servers.json") ?? [];
  const subs    = loadJson("subscriptions.json") ?? [];

  const paid   = tiers.filter(t => t.tier === "paid").length;
  const free   = tiers.filter(t => t.tier === "free").length;
  const grace  = tiers.filter(t => t.tier === "paid" && t.reason === "grace_period").length;

  const activeServers = servers.filter(s => s.status === "running").length;
  const activeSubs    = subs.filter(s => s.status === "active").length;

  res.json({
    users: {
      total:     users.length,
      paid,
      free:      users.length - paid,   // anyone not explicitly classified as paid
      classified: tiers.length,
      inGracePeriod: grace,
    },
    servers: {
      total:   servers.length,
      running: activeServers,
    },
    subscriptions: {
      total:   subs.length,
      active:  activeSubs,
      cancelled: subs.filter(s => s.status === "cancelled").length,
      halted:    subs.filter(s => s.status === "halted").length,
    },
    updatedAt: new Date().toISOString(),
  });
});

// ── POST /bot-api/reviews ─────────────────────────────────────────────────────
// Called by the Discord bot when a user runs /review
// Body: { discordId, username, rating (1-5), text, avatarUrl? }
router.post("/reviews", (req, res) => {
  const { discordId, username, rating, text, avatarUrl } = req.body ?? {};

  if (!username || typeof username !== "string" || username.trim().length === 0)
    return res.status(400).json({ error: "username is required." });
  if (!text || typeof text !== "string" || text.trim().length < 5)
    return res.status(400).json({ error: "text must be at least 5 characters." });
  if (!rating || typeof rating !== "number" || rating < 1 || rating > 5)
    return res.status(400).json({ error: "rating must be a number between 1 and 5." });

  const reviewsPath = resolve(__dirname, "../data/reviews.json");

  // Load existing reviews
  let reviews = [];
  try {
    if (existsSync(reviewsPath)) reviews = JSON.parse(readFileSync(reviewsPath, "utf-8"));
  } catch { reviews = []; }

  // Prevent duplicate: one active review per discordId (update if re-reviewing)
  if (discordId) {
    reviews = reviews.filter(r => r.discordId !== discordId);
  }

  const review = {
    id:         `rev_${Date.now()}`,
    discordId:  discordId ?? null,
    username:   username.trim(),
    rating:     Math.round(rating),
    text:       text.trim(),
    avatarUrl:  avatarUrl ?? null,
    createdAt:  new Date().toISOString(),
    approved:   true,   // auto-approve — set to false if you want manual moderation
  };

  reviews.unshift(review);   // newest first

  // Keep max 100 reviews
  if (reviews.length > 100) reviews = reviews.slice(0, 100);

  try {
    mkdirSync(dirname(reviewsPath), { recursive: true });
    writeFileSync(reviewsPath, JSON.stringify(reviews, null, 2), "utf-8");
  } catch (err) {
    return res.status(500).json({ error: "Failed to save review." });
  }

  console.log(`[Reviews] New review from ${review.username} (${review.rating}★)`);
  res.status(201).json({ success: true, review });
});

export default router;
