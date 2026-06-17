// Couche d'envoi (email / SMS). En dev : ConsoleTransport qui journalise.
// En production : brancher un vrai fournisseur (SMTP/SendGrid pour l'email,
// Twilio/Vonage pour le SMS) en implémentant la même interface.

export interface SentMessage {
  channel: "email" | "sms";
  to: string;
  subject?: string;
  body: string;
  at: string;
}

export interface Transport {
  send(msg: Omit<SentMessage, "at">): Promise<SentMessage>;
}

export class ConsoleTransport implements Transport {
  sent: SentMessage[] = [];
  async send(msg: Omit<SentMessage, "at">): Promise<SentMessage> {
    const full: SentMessage = { ...msg, at: new Date().toISOString() };
    this.sent.push(full);
    const head =
      msg.channel === "email"
        ? `EMAIL → ${msg.to} | ${msg.subject}`
        : `SMS → ${msg.to}`;
    console.log(`\n[envoi] ${head}\n${msg.body}\n`);
    return full;
  }
}

// Transport email réel : envoie via le module email (Google OAuth ou SMTP du compte).
import { sendEmail, type SendConfig } from "../email/index.js";
export class EmailTransport implements Transport {
  sent: SentMessage[] = [];
  constructor(private cfg?: SendConfig) {}
  async send(msg: Omit<SentMessage, "at">): Promise<SentMessage> {
    const full: SentMessage = { ...msg, at: new Date().toISOString() };
    this.sent.push(full);
    if (msg.channel === "email" && msg.to) {
      await sendEmail({ to: msg.to, subject: msg.subject ?? "Relance", text: msg.body }, this.cfg);
    } else {
      console.log(`[SMS simulé] -> ${msg.to}\n${msg.body}`);
    }
    return full;
  }
}

// Exemple de stub d'intégration réelle (à compléter avec les clés du fournisseur).
export class TwilioSmsTransport implements Transport {
  constructor(private cfg: { accountSid: string; authToken: string; from: string }) {}
  async send(msg: Omit<SentMessage, "at">): Promise<SentMessage> {
    if (msg.channel !== "sms") throw new Error("TwilioSmsTransport: SMS uniquement");
    // TODO: appel API Twilio ici.
    return { ...msg, at: new Date().toISOString() };
  }
}
