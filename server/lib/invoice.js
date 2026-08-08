/**
 * Invoice generation and email delivery.
 * Generates a unique NN-INV-XXXXXX order ID and sends a styled HTML invoice.
 */

import nodemailer from "nodemailer";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const DB_PATH    = resolve(__dirname, "../../data/invoices.json");

// ── Persistence ───────────────────────────────────────────────────────────────
function loadInvoices() {
  if (!existsSync(DB_PATH)) return [];
  try { return JSON.parse(readFileSync(DB_PATH, "utf-8")); }
  catch { return []; }
}

function saveInvoices(list) {
  const dir = resolve(__dirname, "../../data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(list, null, 2), "utf-8");
}

// ── Generate unique order ID ──────────────────────────────────────────────────
function generateOrderId() {
  const invoices = loadInvoices();
  // Sequential: NN-INV-000001, NN-INV-000002, …
  const next = String(invoices.length + 1).padStart(6, "0");
  return `NN-INV-${next}`;
}

// ── Main: create invoice record + send email ──────────────────────────────────
export async function createAndSendInvoice({
  userEmail,
  planName,
  planRam,
  originalPrice,
  discountAmount,
  finalPrice,
  currency,
  razorpayPaymentId,
  razorpayOrderId,
  couponLabel,
}) {
  const orderId   = generateOrderId();
  const issuedAt  = new Date();
  const dateStr   = issuedAt.toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });

  // Save invoice record
  const invoice = {
    orderId,
    userEmail,
    planName,
    planRam,
    originalPrice,
    discountAmount: discountAmount || 0,
    finalPrice,
    currency: currency || "INR",
    razorpayPaymentId,
    razorpayOrderId,
    couponLabel: couponLabel || null,
    issuedAt: issuedAt.toISOString(),
  };

  const invoices = loadInvoices();
  invoices.push(invoice);
  saveInvoices(invoices);

  console.log(`[Invoice] Created ${orderId} for ${userEmail} — ₹${finalPrice}`);

  // Send email
  try {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const discountRow = discountAmount > 0 ? `
      <tr>
        <td style="padding:8px 0;color:#888;border-bottom:1px solid #222">Discount${couponLabel ? ` (${couponLabel})` : ""}</td>
        <td style="padding:8px 0;color:#4caf50;text-align:right;border-bottom:1px solid #222">- ₹${discountAmount}</td>
      </tr>` : "";

    await transport.sendMail({
      from: `"NetherNodes" <${process.env.SMTP_USER}>`,
      to: userEmail,
      subject: `Invoice ${orderId} — NetherNodes`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;border-radius:8px;overflow:hidden">

          <!-- Header -->
          <div style="background:linear-gradient(135deg,#1a0505,#0d0d1a);padding:28px 32px;border-bottom:2px solid #e53935">
            <table style="width:100%">
              <tr>
                <td>
                  <div style="font-size:22px;font-weight:900;color:#e53935;letter-spacing:-0.5px">NetherNodes</div>
                  <div style="font-size:11px;color:#666;margin-top:2px">nethernodes.online</div>
                </td>
                <td style="text-align:right">
                  <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1px">Invoice</div>
                  <div style="font-size:18px;font-weight:700;color:#fff;margin-top:2px">${orderId}</div>
                  <div style="font-size:11px;color:#555;margin-top:2px">${dateStr}</div>
                </td>
              </tr>
            </table>
          </div>

          <!-- Body -->
          <div style="padding:28px 32px">

            <p style="color:#aaa;font-size:13px;margin:0 0 24px">Hi there, thank you for your purchase. Here's your invoice.</p>

            <!-- Order details -->
            <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
              <thead>
                <tr style="background:#161616">
                  <th style="padding:10px 12px;text-align:left;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #222">Description</th>
                  <th style="padding:10px 12px;text-align:right;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #222">Amount</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style="padding:14px 12px;color:#ddd;border-bottom:1px solid #1a1a1a">
                    <div style="font-weight:600;font-size:14px">${planName} Minecraft Server</div>
                    <div style="font-size:11px;color:#666;margin-top:3px">${planRam} RAM · Monthly subscription</div>
                  </td>
                  <td style="padding:14px 12px;color:#ddd;text-align:right;border-bottom:1px solid #1a1a1a;font-size:14px">₹${originalPrice}</td>
                </tr>
              </tbody>
            </table>

            <!-- Totals -->
            <table style="width:100%;border-collapse:collapse;margin-bottom:28px">
              <tr>
                <td style="padding:8px 0;color:#888;border-bottom:1px solid #222">Subtotal</td>
                <td style="padding:8px 0;color:#ddd;text-align:right;border-bottom:1px solid #222">₹${originalPrice}</td>
              </tr>
              ${discountRow}
              <tr>
                <td style="padding:8px 0;color:#888;border-bottom:1px solid #222">Setup Fee</td>
                <td style="padding:8px 0;color:#4caf50;text-align:right;border-bottom:1px solid #222">₹0</td>
              </tr>
              <tr>
                <td style="padding:12px 0 0;color:#fff;font-weight:700;font-size:15px">Total Paid</td>
                <td style="padding:12px 0 0;color:#e53935;font-weight:900;font-size:18px;text-align:right">₹${finalPrice}</td>
              </tr>
            </table>

            <!-- Payment info -->
            <div style="background:#111;border:1px solid #222;border-radius:6px;padding:16px;margin-bottom:24px">
              <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Payment Details</div>
              <table style="width:100%">
                <tr>
                  <td style="color:#666;font-size:12px;padding:3px 0">Payment ID</td>
                  <td style="color:#aaa;font-size:12px;text-align:right;font-family:monospace">${razorpayPaymentId}</td>
                </tr>
                <tr>
                  <td style="color:#666;font-size:12px;padding:3px 0">Order ID</td>
                  <td style="color:#aaa;font-size:12px;text-align:right;font-family:monospace">${razorpayOrderId}</td>
                </tr>
                <tr>
                  <td style="color:#666;font-size:12px;padding:3px 0">Status</td>
                  <td style="color:#4caf50;font-size:12px;text-align:right;font-weight:600">Paid ✓</td>
                </tr>
              </table>
            </div>

            <p style="color:#555;font-size:11px;margin:0">Your server will be ready within 60 seconds. Access details will be sent to <strong style="color:#888">${userEmail}</strong>.</p>
            <p style="color:#555;font-size:11px;margin:8px 0 0">Questions? Contact us at <a href="mailto:${process.env.SUPPORT_EMAIL}" style="color:#e53935">${process.env.SUPPORT_EMAIL}</a></p>
          </div>

          <!-- Footer -->
          <div style="background:#080808;padding:16px 32px;border-top:1px solid #1a1a1a;text-align:center">
            <p style="color:#333;font-size:10px;margin:0">NetherNodes · nethernodes.online · 48-hour money-back guarantee</p>
          </div>
        </div>
      `,
    });

    console.log(`[Invoice] Email sent to ${userEmail}`);
  } catch (mailErr) {
    console.warn(`[Invoice] Email failed for ${orderId}:`, mailErr?.message);
  }

  return invoice;
}

export function getAllInvoices() {
  return loadInvoices();
}

export function getInvoiceById(orderId) {
  return loadInvoices().find(inv => inv.orderId.toLowerCase() === orderId.toLowerCase()) || null;
}
