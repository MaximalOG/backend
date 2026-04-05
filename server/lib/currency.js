/**
 * Live exchange rates with 1-hour cache.
 * Base currency: INR (all plans are priced in INR)
 * Fallback static rates if API key not set or request fails.
 */

const FALLBACK_RATES = {
  INR: 1,
  USD: 0.012,   // 1 INR = ~0.012 USD  (1 USD ≈ ₹83)
  EUR: 0.011,   // 1 INR = ~0.011 EUR  (1 EUR ≈ ₹90)
  GBP: 0.0095,  // 1 INR = ~0.0095 GBP (1 GBP ≈ ₹105)
};

// $1 markup in INR (added to all non-INR prices)
const MARKUP_USD = 1;

let ratesCache = null;
let ratesCachedAt = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export async function getRates() {
  const now = Date.now();
  if (ratesCache && now - ratesCachedAt < CACHE_TTL) return ratesCache;

  const apiKey = process.env.EXCHANGE_RATE_API_KEY;
  if (apiKey) {
    try {
      // openexchangerates.org — base USD, we convert to INR base
      const res = await fetch(`https://openexchangerates.org/api/latest.json?app_id=${apiKey}&base=USD&symbols=INR,EUR,GBP`);
      const data = await res.json();
      if (data.rates) {
        const inrPerUsd = data.rates.INR;
        ratesCache = {
          INR: 1,
          USD: 1 / inrPerUsd,
          EUR: (1 / inrPerUsd) * data.rates.EUR,
          GBP: (1 / inrPerUsd) * data.rates.GBP,
        };
        ratesCachedAt = now;
        return ratesCache;
      }
    } catch {
      // fall through to fallback
    }
  }

  ratesCache = FALLBACK_RATES;
  ratesCachedAt = now;
  return ratesCache;
}

/**
 * Convert INR price to target currency with +$1 markup for non-INR.
 * Returns a clean rounded number.
 */
export async function convertPrice(inrPrice, targetCurrency) {
  if (targetCurrency === "INR") return inrPrice;

  const rates = await getRates();
  const rate = rates[targetCurrency] ?? rates.USD;

  // Add $1 markup converted to INR first
  const markupInr = MARKUP_USD / rates.USD;
  const total = (inrPrice + markupInr) * rate;

  // Round to clean number
  if (total < 5)   return Math.round(total * 100) / 100; // 2 decimals for small amounts
  if (total < 20)  return Math.round(total * 10) / 10;   // 1 decimal
  return Math.round(total);                               // whole number
}

export const CURRENCY_SYMBOLS = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };
export const SUPPORTED_CURRENCIES = ["INR", "USD", "EUR", "GBP"];
