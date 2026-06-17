import type { Appointment } from "../booking/types.js";
import { listAppointments } from "../booking/store.js";
import { ConsoleTransport, type Transport } from "../dunning/transport.js";

// Module : demande d'avis Google automatique après chantier — ISOLÉ PAR COMPTE.

export type ReviewStatus = "pending" | "sent" | "clicked" | "reviewed";

export interface ReviewRequest {
  id: string;
  appointmentId: string;
  customerName: string;
  channel: "sms" | "email";
  to: string;
  link: string;
  status: ReviewStatus;
  createdAt: string;
  sentAt?: string;
}

export interface ReviewConfig {
  businessName: string;
  googlePlaceId: string; // https://search.google.com/local/writereview?placeid=PLACE_ID
  delayHours: number;
}

interface AccountReviews {
  config: ReviewConfig;
  requests: Map<string, ReviewRequest>; // clé = appointmentId
}

function defaultConfig(): ReviewConfig {
  return { businessName: "Mon entreprise", googlePlaceId: "ChIJxxxxxxxxxxxxxxxxxxxxxxx", delayHours: 2 };
}

const data = new Map<string, AccountReviews>();
function ws(accountId: string): AccountReviews {
  let a = data.get(accountId);
  if (!a) data.set(accountId, (a = { config: defaultConfig(), requests: new Map() }));
  return a;
}

export function setReviewConfig(accountId: string, c: Partial<ReviewConfig>): void {
  const a = ws(accountId);
  a.config = { ...a.config, ...c };
}
export function getReviewConfig(accountId: string): ReviewConfig {
  return ws(accountId).config;
}
export function listReviewRequests(accountId: string): ReviewRequest[] {
  return [...ws(accountId).requests.values()];
}
export function clearReviewRequests(accountId: string): void {
  ws(accountId).requests.clear();
}

function reviewLink(cfg: ReviewConfig): string {
  return `https://search.google.com/local/writereview?placeid=${cfg.googlePlaceId}`;
}
function newReviewId(reqs: Map<string, ReviewRequest>): string {
  const max = Math.max(0, ...[...reqs.values()].map((r) => Number(r.id.replace("AV-", "")) || 0));
  return `AV-${String(max + 1).padStart(4, "0")}`;
}

function buildMessage(cfg: ReviewConfig, customerName: string, link: string, channel: "sms" | "email") {
  if (channel === "sms") {
    return { body: `Bonjour ${customerName}, merci d'avoir fait confiance à ${cfg.businessName} ! Votre avis compte beaucoup pour nous : ${link}` };
  }
  return {
    subject: `Votre avis sur l'intervention de ${cfg.businessName}`,
    body:
      `Bonjour ${customerName},\n\nMerci d'avoir fait appel à ${cfg.businessName}. Nous espérons que tout s'est bien passé !\n\n` +
      `Quelques secondes suffisent pour laisser un avis Google, et cela nous aide énormément :\n${link}\n\nMerci d'avance,\nL'équipe ${cfg.businessName}`,
  };
}

function isDue(reqs: Map<string, ReviewRequest>, appt: Appointment, cfg: ReviewConfig, now: Date): boolean {
  if (appt.status !== "completed") return false;
  if (reqs.has(appt.id)) return false; // anti-doublon
  if (!appt.customer.phone && !appt.customer.email) return false;
  return now.getTime() >= new Date(appt.end).getTime() + cfg.delayHours * 3_600_000;
}

export interface ReviewAction {
  appointmentId: string;
  customerName: string;
  channel: "sms" | "email";
  to: string;
  link: string;
  subject?: string;
  body: string;
}

// Parcourt les RDV terminés d'un compte et envoie les demandes d'avis dues.
export async function runReviewRequests(
  accountId: string,
  now: Date = new Date(),
  transport: Transport = new ConsoleTransport()
): Promise<ReviewAction[]> {
  const { config, requests } = ws(accountId);
  const link = reviewLink(config);
  const actions: ReviewAction[] = [];

  for (const appt of listAppointments(accountId)) {
    if (!isDue(requests, appt, config, now)) continue;
    const channel: "sms" | "email" = appt.customer.phone ? "sms" : "email";
    const to = channel === "sms" ? appt.customer.phone! : appt.customer.email!;
    const msg = buildMessage(config, appt.customer.name, link, channel);
    await transport.send({ channel, to, subject: (msg as any).subject, body: msg.body });

    requests.set(appt.id, {
      id: newReviewId(requests),
      appointmentId: appt.id,
      customerName: appt.customer.name,
      channel, to, link, status: "sent",
      createdAt: new Date().toISOString(), sentAt: new Date().toISOString(),
    });
    actions.push({ appointmentId: appt.id, customerName: appt.customer.name, channel, to, link, subject: (msg as any).subject, body: msg.body });
  }
  return actions;
}

export function markReview(accountId: string, appointmentId: string, status: ReviewStatus): ReviewRequest {
  const r = ws(accountId).requests.get(appointmentId);
  if (!r) throw new Error(`Demande d'avis inconnue pour ${appointmentId}`);
  r.status = status;
  return r;
}

// --- Persistance (par compte) ---
export function dumpReviews() {
  const out: Record<string, any> = {};
  for (const [acc, a] of data) out[acc] = { config: a.config, requests: [...a.requests.values()] };
  return out;
}
export function restoreReviews(obj: any): void {
  if (!obj) return;
  data.clear();
  for (const [acc, a] of Object.entries<any>(obj)) {
    const m = new Map<string, ReviewRequest>();
    for (const r of a.requests ?? []) m.set(r.appointmentId, r);
    data.set(acc, { config: a.config ?? defaultConfig(), requests: m });
  }
}
