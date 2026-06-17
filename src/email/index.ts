// Envoi d'emails (factures, devis, relances).
// Priorité : « Se connecter avec Google » (OAuth) du compte > SMTP du compte
// (ex. mot de passe d'application) > variables d'env SMTP_* > mode simulé (log).

import { googleConfigured, clientId, clientSecret, type GmailOAuth } from "../oauth/google.js";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}
export interface SendConfig {
  smtp?: SmtpConfig | null;
  gmailOAuth?: GmailOAuth | null;
}
export interface EmailAttachment {
  filename: string;
  content: Uint8Array | Buffer;
  contentType?: string;
}
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  attachments?: EmailAttachment[];
}

const cache = new Map<string, any>(); // clé config -> transporter

function envConfig(): SmtpConfig | null {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (SMTP_HOST && SMTP_USER) {
    return { host: SMTP_HOST, port: Number(SMTP_PORT ?? 587), user: SMTP_USER, pass: SMTP_PASS ?? "", from: SMTP_FROM ?? SMTP_USER };
  }
  return null;
}

// Réglages SMTP effectifs : compte > environnement > aucun.
function resolveSmtp(smtp?: SmtpConfig | null): SmtpConfig | null {
  if (smtp && smtp.host && smtp.user) return smtp;
  return envConfig();
}

function hasOAuth(cfg?: SendConfig): boolean {
  return !!(cfg?.gmailOAuth?.refreshToken && googleConfigured());
}
export function emailConfigured(cfg?: SendConfig): boolean {
  return hasOAuth(cfg) || !!resolveSmtp(cfg?.smtp ?? null);
}

async function nm(): Promise<any> {
  // @ts-ignore - nodemailer n'a pas de types embarqués
  const nodemailer: any = await import("nodemailer");
  return nodemailer.default ?? nodemailer;
}

async function transporterFor(cfg: SmtpConfig): Promise<any> {
  const key = `${cfg.host}|${cfg.port}|${cfg.user}`;
  if (cache.has(key)) return cache.get(key);
  const t = (await nm()).createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  cache.set(key, t);
  return t;
}

async function oauthTransporter(o: GmailOAuth): Promise<any> {
  const key = `oauth|${o.email}`;
  if (cache.has(key)) return cache.get(key);
  const t = (await nm()).createTransport({
    service: "gmail",
    auth: { type: "OAuth2", user: o.email, clientId: clientId(), clientSecret: clientSecret(), refreshToken: o.refreshToken },
  });
  cache.set(key, t);
  return t;
}

const attach = (msg: EmailMessage) =>
  msg.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType }));

export async function sendEmail(msg: EmailMessage, cfg?: SendConfig): Promise<{ sent: boolean; simulated?: boolean }> {
  // 1) « Se connecter avec Google » (OAuth)
  if (hasOAuth(cfg)) {
    const o = cfg!.gmailOAuth!;
    const t = await oauthTransporter(o);
    await t.sendMail({ from: o.email, to: msg.to, subject: msg.subject, text: msg.text, attachments: attach(msg) });
    return { sent: true };
  }
  // 2) SMTP (mot de passe d'application / env), sinon simulé
  const smtp = resolveSmtp(cfg?.smtp ?? null);
  if (!smtp) {
    console.log(`\n[email simulé] -> ${msg.to}\n  Objet : ${msg.subject}\n`);
    return { sent: true, simulated: true };
  }
  const t = await transporterFor(smtp);
  await t.sendMail({ from: smtp.from || smtp.user, to: msg.to, subject: msg.subject, text: msg.text, attachments: attach(msg) });
  return { sent: true };
}

// Test de connexion SMTP (utilisé par la page Réglages).
export async function verifySmtp(cfg: SmtpConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const t = await transporterFor(cfg);
    await t.verify();
    return { ok: true };
  } catch (e) {
    cache.delete(`${cfg.host}|${cfg.port}|${cfg.user}`);
    return { ok: false, error: (e as Error).message };
  }
}
