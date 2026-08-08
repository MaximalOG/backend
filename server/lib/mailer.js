import nodemailer from "nodemailer";

function getTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/**
 * Send ticket notification to support team + confirmation to user.
 */
export async function sendTicketEmails(ticket) {
  const transport = getTransport();
  const supportEmail = process.env.SUPPORT_EMAIL;
  const from = `"NetherNodes Support" <${process.env.SMTP_USER}>`;

  const historyText = ticket.chat_history
    ? ticket.chat_history.replace(/<[^>]+>/g, "")
    : "No history provided.";

  // ── Email to support team ──────────────────────────────────────────────────
  await transport.sendMail({
    from,
    to: supportEmail,
    subject: `${ticket.id}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1a0a0a;padding:20px;border-radius:8px 8px 0 0">
          <h2 style="color:#e53935;margin:0">🎟️ New Support Ticket</h2>
        </div>
        <div style="background:#111;padding:20px;color:#ddd;border-radius:0 0 8px 8px">
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#888;width:140px">Ticket ID</td><td style="color:#fff;font-weight:bold">${ticket.id}</td></tr>
            <tr><td style="padding:6px 0;color:#888">User Email</td><td style="color:#fff">${ticket.email}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Status</td><td style="color:#4caf50">Open</td></tr>
            <tr><td style="padding:6px 0;color:#888">Created</td><td style="color:#fff">${new Date(ticket.created_at).toLocaleString()}</td></tr>
          </table>
          <hr style="border-color:#333;margin:16px 0"/>
          <h3 style="color:#e53935;margin:0 0 8px">Issue Summary</h3>
          ${ticket.issue.includes("Issue Type:")
            ? `<table style="width:100%;border-collapse:collapse;background:#1a1a1a;border-radius:4px;overflow:hidden">
                ${ticket.issue.split("\n").map(line => {
                  const idx = line.indexOf(":");
                  if (idx === -1) return "";
                  const label = line.slice(0, idx).trim();
                  const value = line.slice(idx + 1).trim();
                  return `<tr>
                    <td style="padding:8px 12px;color:#888;width:140px;border-bottom:1px solid #222">${label}</td>
                    <td style="padding:8px 12px;color:#fff;border-bottom:1px solid #222">${value}</td>
                  </tr>`;
                }).join("")}
              </table>`
            : `<p style="background:#1a1a1a;padding:12px;border-radius:4px;border-left:3px solid #e53935">${ticket.issue}</p>`
          }
          <h3 style="color:#e53935;margin:16px 0 8px">Full Conversation</h3>
          <pre style="background:#1a1a1a;padding:12px;border-radius:4px;white-space:pre-wrap;font-size:12px;color:#bbb">${historyText}</pre>
        </div>
      </div>
    `,
  });

  // ── Confirmation email to user — capture Message-ID for threading ──────────
  const userMailInfo = await transport.sendMail({
    from,
    to: ticket.email,
    subject: `${ticket.id}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1a0a0a;padding:20px;border-radius:8px 8px 0 0">
          <h2 style="color:#e53935;margin:0">NetherNodes Support</h2>
        </div>
        <div style="background:#111;padding:20px;color:#ddd;border-radius:0 0 8px 8px">
          <p>Hi there,</p>
          <p>We've received your support request and created a ticket for you.</p>
          <div style="background:#1a1a1a;padding:16px;border-radius:6px;border-left:4px solid #e53935;margin:16px 0">
            <p style="margin:0;color:#888;font-size:12px">TICKET ID</p>
            <p style="margin:4px 0 0;color:#fff;font-size:20px;font-weight:bold">${ticket.id}</p>
          </div>
          <p><strong>Issue:</strong> ${ticket.issue}</p>
          <p>Our support team will get back to you at <strong>${ticket.email}</strong> as soon as possible.</p>
          <p style="color:#888;font-size:12px;margin-top:24px">— NetherNodes Support Team</p>
        </div>
      </div>
    `,
  });

  // Store the Message-ID so replies can thread correctly
  if (userMailInfo.messageId) {
    const { updateTicketMessageId } = await import("./tickets.js");
    updateTicketMessageId(ticket.id, userMailInfo.messageId);
  }
}

/**
 * Send a support reply from admin to the user.
 */
export async function sendReplyEmail(ticket, message) {
  const transport = getTransport();
  const from = `"NetherNodes Support" <${process.env.SMTP_USER}>`;

  // Threading headers — makes this appear as a reply in the customer's inbox
  const threadHeaders = ticket.messageId ? {
    "In-Reply-To": ticket.messageId,
    "References": ticket.messageId,
  } : {};

  await transport.sendMail({
    from,
    to: ticket.email,
    subject: `${ticket.id}`,
    headers: threadHeaders,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1a0a0a;padding:20px;border-radius:8px 8px 0 0">
          <h2 style="color:#e53935;margin:0">NetherNodes Support</h2>
        </div>
        <div style="background:#111;padding:20px;color:#ddd;border-radius:0 0 8px 8px">
          <p style="color:#888;font-size:12px;margin:0 0 12px">Reply to ticket <strong style="color:#fff">${ticket.id}</strong></p>
          <div style="background:#1a1a1a;border-left:4px solid #e53935;padding:16px;border-radius:4px;white-space:pre-wrap;font-size:14px;line-height:1.6">${message}</div>
          <hr style="border-color:#333;margin:20px 0"/>
          <p style="color:#888;font-size:12px;margin:0">— NetherNodes Support Team<br/>Reply to this email or contact us at ${process.env.SUPPORT_EMAIL}</p>
        </div>
      </div>
    `,
  });
}
