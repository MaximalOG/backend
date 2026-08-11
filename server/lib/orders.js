import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../data/payment_orders.json");

function load() {
  if (!existsSync(DB_PATH)) return [];
  try { return JSON.parse(readFileSync(DB_PATH, "utf-8")); } catch { return []; }
}
function save(orders) {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(orders, null, 2), "utf-8");
}

export function savePaymentOrder(order) {
  const orders = load();
  const existing = orders.findIndex(item => item.providerOrderId === order.providerOrderId);
  if (existing >= 0) orders[existing] = { ...orders[existing], ...order };
  else orders.push(order);
  save(orders);
}

export function getPaymentOrder(providerOrderId) {
  return load().find(order => order.providerOrderId === providerOrderId) ?? null;
}

export function markPaymentOrderPaid(providerOrderId, paymentId) {
  const orders = load();
  const order = orders.find(item => item.providerOrderId === providerOrderId);
  if (!order || order.status === "paid") return null;
  order.status = "paid";
  order.paymentId = paymentId;
  order.paidAt = new Date().toISOString();
  save(orders);
  return order;
}
