import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// Comptes + sessions. Stockés en mémoire et persistés via le module de persistance.

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}
export interface Account {
  id: string;
  email: string;
  passwordHash: string;
  businessName: string;
  createdAt: string;
  smtp?: SmtpConfig;                              // mot de passe d'application (SMTP)
  gmailOAuth?: { email: string; refreshToken: string }; // « Se connecter avec Google »
}
interface Session {
  token: string;
  accountId: string;
  createdAt: string;
}

const accounts = new Map<string, Account>();   // clé = email (minuscule)
const sessions = new Map<string, Session>();    // clé = token

const id = () => randomBytes(8).toString("hex");
const token = () => randomBytes(24).toString("hex");

export function signup(email: string, password: string, businessName: string): Account {
  const key = email.trim().toLowerCase();
  if (!key || !password) throw new Error("Email et mot de passe requis.");
  if (accounts.has(key)) throw new Error("Un compte existe déjà avec cet email.");
  if (password.length < 6) throw new Error("Mot de passe trop court (6 caractères min).");
  const account: Account = {
    id: id(),
    email: key,
    passwordHash: bcrypt.hashSync(password, 10),
    businessName: businessName?.trim() || "Mon entreprise",
    createdAt: new Date().toISOString(),
  };
  accounts.set(key, account);
  return account;
}

export function login(email: string, password: string): string {
  const account = accounts.get(email.trim().toLowerCase());
  if (!account || !bcrypt.compareSync(password, account.passwordHash)) {
    throw new Error("Email ou mot de passe incorrect.");
  }
  const t = token();
  sessions.set(t, { token: t, accountId: account.id, createdAt: new Date().toISOString() });
  return t;
}

export function logout(t: string): void {
  sessions.delete(t);
}

export function accountFromToken(t?: string): Account | null {
  if (!t) return null;
  const s = sessions.get(t);
  if (!s) return null;
  return [...accounts.values()].find((a) => a.id === s.accountId) ?? null;
}

export function countAccounts(): number {
  return accounts.size;
}
// Premier compte enregistré (repli pour les routes publiques mono-artisan).
export function firstAccountId(): string | null {
  return [...accounts.values()][0]?.id ?? null;
}
// Tous les identifiants de compte (pour le planificateur de relances).
export function listAccountIds(): string[] {
  return [...accounts.values()].map((a) => a.id);
}
export function getAccount(accountId: string): Account | null {
  return [...accounts.values()].find((a) => a.id === accountId) ?? null;
}
export function setSmtp(accountId: string, smtp: SmtpConfig | undefined): void {
  const a = getAccount(accountId);
  if (a) a.smtp = smtp;
}
export function getSmtp(accountId: string): SmtpConfig | undefined {
  return getAccount(accountId)?.smtp;
}
export function setGmailOAuth(accountId: string, oauth: { email: string; refreshToken: string } | undefined): void {
  const a = getAccount(accountId);
  if (a) a.gmailOAuth = oauth;
}
export function getGmailOAuth(accountId: string): { email: string; refreshToken: string } | undefined {
  return getAccount(accountId)?.gmailOAuth;
}

// Middleware : exige une session valide (cookie "sid"), sinon 401 / redirection.
export function requireAuth(redirect = false) {
  return (req: Request, res: Response, next: NextFunction) => {
    const account = accountFromToken(req.cookies?.sid);
    if (!account) {
      if (redirect) return res.redirect("/login");
      return res.status(401).json({ error: "Non authentifié" });
    }
    (req as any).account = account;
    next();
  };
}

// --- Persistance ---
export function dumpAuth() {
  return { accounts: [...accounts.values()], sessions: [...sessions.values()] };
}
export function restoreAuth(d: any): void {
  if (!d) return;
  accounts.clear();
  for (const a of d.accounts ?? []) accounts.set(a.email, a);
  sessions.clear();
  for (const s of d.sessions ?? []) sessions.set(s.token, s);
}
