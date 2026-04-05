// ── Single source of truth for all NetherNodes business data ──────────────────
// Edit this file to update plans, pricing, features — AI picks it up instantly.

export const PLANS = [
  { name: "Nano",    ram: "1GB",  ramGB: 1,  price: "₹69/month",    cpu: "50%",  ssd: "5GB"   },
  { name: "Basic",   ram: "2GB",  ramGB: 2,  price: "Free",         cpu: "100%", ssd: "10GB"  },
  { name: "Plus",    ram: "3GB",  ramGB: 3,  price: "₹129/month",   cpu: "150%", ssd: "15GB"  },
  { name: "Starter", ram: "4GB",  ramGB: 4,  price: "₹199/month",   cpu: "200%", ssd: "25GB"  },
  { name: "Pro",     ram: "6GB",  ramGB: 6,  price: "₹329/month",   cpu: "250%", ssd: "40GB"  },
  { name: "Elite",   ram: "8GB",  ramGB: 8,  price: "₹469/month",   cpu: "300%", ssd: "60GB"  },
  { name: "Ultra",   ram: "10GB", ramGB: 10, price: "₹649/month",   cpu: "350%", ssd: "80GB"  },
  { name: "Max",     ram: "12GB", ramGB: 12, price: "₹829/month",   cpu: "400%", ssd: "100GB" },
  { name: "Titan",   ram: "16GB", ramGB: 16, price: "₹1,099/month", cpu: "450%", ssd: "140GB" },
];

export const MAX_PLAN = PLANS[PLANS.length - 1].name;

export const SUBDOMAIN = {
  enabled: true,
  format: ".nethernodes.in",
  example: "yourserver.nethernodes.in",
};

export const FEATURES = {
  core: [
    "Full Panel Access",
    "DDoS Protection",
    "Instant Setup",
    "Reliable Uptime",
    "Subdomain Included",  ],
  tier1: {
    plans: ["Nano", "Basic", "Plus"],
    label: "Entry / Testing",
    ddos: "Standard (L4/L7)",
    backups: "Manual only",
    databases: "1 MySQL",
    panel: "Standard Pterodactyl",
    modInstaller: "Manual setup",
    support: "Ticket (24h)",
    migration: "Self-service",
    subdomain: "yourserver.nethernodes.in (shared IP)",
  },
  tier2: {
    plans: ["Starter", "Pro", "Elite"],
    label: "Community / SMP / Modded",
    ddos: "Advanced Shield",
    backups: "3 daily slots",
    databases: "3 MySQL",
    panel: "Custom NetherNodes Panel",
    modInstaller: "1-click (6000+ packs)",
    support: "Priority (4h)",
    migration: "Assisted",
    subdomain: "yourserver.nethernodes.in (optimized routing)",
  },
  tier3: {
    plans: ["Ultra", "Max", "Titan"],
    label: "Advanced / Networks / Heavy",
    ddos: "Enterprise (Anycast)",
    backups: "Unlimited + off-site",
    databases: "Unlimited MySQL",
    panel: "Custom + priority access",
    modInstaller: "1-click + expert assist",
    support: "Instant Discord / live chat",
    migration: "Full white-glove transfer",
    subdomain: "yourserver.nethernodes.in + dedicated IP (no port required)",
  },
};

// Build the context object sent to AI on every request
export function buildAIContext() {
  return {
    AVAILABLE_PLANS: PLANS.map(p => p.name),
    PLAN_SPECS: Object.fromEntries(PLANS.map(p => [p.name, { ram: p.ram, cpu: p.cpu, ssd: p.ssd }])),
    PRICING: Object.fromEntries(PLANS.map(p => [p.name, p.price])),
    MAX_PLAN,
    SUBDOMAIN,
    FEATURES: {
      core: FEATURES.core,
      tier1: FEATURES.tier1,
      tier2: FEATURES.tier2,
      tier3: FEATURES.tier3,
    },
  };
}
