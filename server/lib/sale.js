import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../data/sale.json");

const DEFAULT = {
  enabled: false,
  label: "Limited Time Offer",
  discount: 20,
  discountType: "percent", // "percent" | "fixed"
  mode: "public",          // "public" | "secret" | "multi"
  code: "",                // single secret code (legacy)
  codes: [],               // multi-code: [{ name, code, discount, discountType, note }]
  plans: "all",
  startDate: null,
  endDate: null,
  showCountdown: true,
};

export function getSale() {
  if (!existsSync(DB_PATH)) return { ...DEFAULT };
  try { return { ...DEFAULT, ...JSON.parse(readFileSync(DB_PATH, "utf-8")) }; }
  catch { return { ...DEFAULT }; }
}

export function saveSale(data) {
  const dir = resolve(__dirname, "../../data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf-8");
  return data;
}

export function getActiveSale() {
  const sale = getSale();
  const now = new Date();
  if (sale.startDate && new Date(sale.startDate) > now) return null;
  if (sale.endDate && new Date(sale.endDate) < now) return null;

  // Public banner requires enabled flag
  if (sale.mode === "public" && !sale.enabled) return null;

  // Secret/multi codes are always active if within date range
  return sale;
}

/** Validate a promo code against single or multi-code config. */
export function validateCode(code) {
  const sale = getSale(); // use getSale not getActiveSale — codes work independently of banner
  if (!sale) return null;

  const input = code.trim().toLowerCase();

  // Always check multi-codes array first (regardless of mode)
  if (Array.isArray(sale.codes) && sale.codes.length > 0) {
    const match = sale.codes.find(c => c.code?.trim().toLowerCase() === input);
    if (match) {
      return {
        discount: match.discount ?? sale.discount,
        discountType: match.discountType ?? sale.discountType,
        label: match.name ? `${match.name} Discount` : sale.label,
        codeName: match.name,
      };
    }
  }

  // Single secret code fallback
  if (sale.code && sale.code.trim().toLowerCase() === input) {
    return { discount: sale.discount, discountType: sale.discountType, label: sale.label };
  }

  return null;
}
