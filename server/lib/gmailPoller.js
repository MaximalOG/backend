import { ImapFlow } from "imapflow";
import { getAllTickets, addReply, updateTicketStatus } from "./tickets.js";

let pollerRunning = false;
const processedUids = new Set();

function stripQuotedText(text) {
  if (!text) return "";
  const separators = [
    /\r?\nOn .+wrote:/s,
    /\r?\n-{3,} ?Original Message ?-{3,}/i,
    /\r?\nFrom: .+\nSent:/s,
    /\r?\n_{3,}/,
    /\r?\n>{1,}.*/s,
  ];
  let result = text;
  for (const sep of separators) {
    const match = result.search(sep);
    if (match !== -1) result = result.slice(0, match);
  }
  return result.trim();
}

function extractPlainText(raw) {
  if (!raw) return "";
  const str = raw.toString("utf-8");
  const plainMatch = str.match(/Content-Type: text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\r?\nContent-Type:|$)/i);
  if (plainMatch) return plainMatch[1].trim();
  const bodyStart = str.indexOf("\r\n\r\n");
  if (bodyStart !== -1) return str.slice(bodyStart + 4).trim();
  return str.trim();
}

export async function pollOnce() {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    logger: false,
    // Prevent unhandled error events from crashing the process
    emitLogs: false,
  });

  // Catch socket-level errors so they don't crash the process
  client.on("error", () => {});

  let lock = null;
  try {
    await client.connect();
    lock = await client.getMailboxLock("INBOX");

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const allUids = await client.search({ since: thirtyDaysAgo }) || [];

    if (allUids.length > 0) {
      const tickets = getAllTickets();
      const supportEmail = (process.env.SMTP_USER || "").toLowerCase();

      for await (const msg of client.fetch(allUids, { envelope: true, source: true })) {
        if (processedUids.has(msg.uid)) continue;

        const subject = msg.envelope?.subject || "";
        const from    = msg.envelope?.from?.[0]?.address || "";

        const idMatch = subject.match(/NN-\d{6}/);
        if (!idMatch || from.toLowerCase() === supportEmail) {
          processedUids.add(msg.uid);
          continue;
        }

        const ticketId = idMatch[0];
        const ticket = tickets.find(t => t.id === ticketId);
        if (!ticket) {
          processedUids.add(msg.uid);
          continue;
        }

        const rawText = extractPlainText(msg.source);
        const cleanText = stripQuotedText(rawText);

        if (cleanText.length > 0) {
          const alreadyStored = ticket.replies?.some(
            r => r.from === "customer" && r.message === cleanText
          );
          if (!alreadyStored) {
            addReply(ticketId, { from: "customer", message: cleanText });
            updateTicketStatus(ticketId, "open");
          }
        }

        processedUids.add(msg.uid);
      }
    }
  } catch {
    // Silent — retry on next interval
  } finally {
    if (lock) { try { lock.release(); } catch {} }
    try { await client.logout(); } catch {}
    try { client.close(); } catch {}
  }
}

export function startGmailPoller(intervalMs = 60_000) {
  if (pollerRunning) return;
  pollerRunning = true;
  // Delay first poll by 5s to let server fully start
  setTimeout(() => {
    pollOnce();
    setInterval(pollOnce, intervalMs);
  }, 5000);
}
