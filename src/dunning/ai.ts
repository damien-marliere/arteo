import type { DunningPolicyStep, InvoiceRecord } from "./types.js";
import type { PenaltyBreakdown } from "./penalties.js";
import { llmComplete, llmJson } from "../llm/index.js";

// Contexte fourni à l'agent IA pour rédiger une relance.
export interface DunningContext {
  sellerName: string;
  buyerName: string;
  contactEmail: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate?: string;
  outstanding: number;
  penalties: PenaltyBreakdown;
  step: DunningPolicyStep;
}

export interface DunningMessage {
  subject?: string;
  body: string;
  generatedBy: "ai" | "template";
}

const EUR = (n: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" })
    .format(n)
    .replace(/\s/g, " ");

// --- Prompt pour un vrai LLM (qualité "Titan") ---
export function buildPrompt(ctx: DunningContext): string {
  const p = ctx.penalties;
  return [
    "Tu es l'assistant de recouvrement d'un artisan. Rédige une relance d'impayé en français,",
    `ton : ${ctx.step.tone}.`,
    `Canal : ${ctx.step.channel === "sms" ? "SMS (max 320 caractères, sans objet)" : "email (avec objet)"}.`,
    "Sois concis, courtois, professionnel et orienté solution (propose un moyen de régler vite).",
    "Ne mens pas, n'invente aucun montant. Utilise uniquement les données suivantes :",
    `- Émetteur (créancier) : ${ctx.sellerName}`,
    `- Client (débiteur) : ${ctx.buyerName}`,
    `- Facture n° ${ctx.invoiceNumber} émise le ${ctx.issueDate}, échéance ${ctx.dueDate ?? "n/c"}`,
    `- Reste à payer : ${EUR(ctx.outstanding)}`,
    `- Jours de retard : ${p.daysLate}`,
    ctx.step.includePenalties
      ? `- Pénalités de retard : ${EUR(p.latePenalty)} ; indemnité forfaitaire : ${EUR(p.fixedIndemnity)} ; total réclamable : ${EUR(p.totalClaim)}`
      : "- Ne pas mentionner de pénalités à ce stade.",
    ctx.step.channel === "sms"
      ? "Réponds UNIQUEMENT par le texte du SMS."
      : 'Réponds au format JSON {"subject": "...", "body": "..."}.',
  ].join("\n");
}

// --- Génération via le client LLM (actif selon la config, sinon null) ---
async function tryLLM(ctx: DunningContext): Promise<DunningMessage | null> {
  if (ctx.step.channel === "sms") {
    const txt = await llmComplete([{ role: "user", content: buildPrompt(ctx) }], { temperature: 0.4 });
    return txt ? { body: txt, generatedBy: "ai" } : null;
  }
  const j = await llmJson<{ subject?: string; body?: string }>(buildPrompt(ctx));
  if (!j?.body) return null;
  return { subject: j.subject ?? `Facture ${ctx.invoiceNumber}`, body: j.body, generatedBy: "ai" };
}

// --- Générateur déterministe (fallback hors-ligne, qualité professionnelle) ---
function templateMessage(ctx: DunningContext): DunningMessage {
  const { step } = ctx;
  const p = ctx.penalties;
  const ref = `facture n° ${ctx.invoiceNumber} (${EUR(ctx.outstanding)})`;
  const sign = `\n\nCordialement,\n${ctx.sellerName}`;

  if (step.channel === "sms") {
    const sms: Record<string, string> = {
      pre_reminder: `${ctx.sellerName} : petit rappel, votre ${ref} arrive à échéance le ${ctx.dueDate}. Merci !`,
      reminder_1: `${ctx.sellerName} : votre ${ref} est échue depuis le ${ctx.dueDate}. Un oubli ? Merci de régulariser.`,
      reminder_2: `${ctx.sellerName} : votre ${ref} reste impayée (${p.daysLate} j de retard). Merci de procéder au paiement rapidement.`,
      reminder_3: `${ctx.sellerName} : ${ref} impayée. Des pénalités de ${EUR(p.latePenalty)} s'appliquent. Merci de régler sous 48h.`,
      formal_notice: `${ctx.sellerName} : mise en demeure pour ${ref}. Total dû ${EUR(p.totalClaim)}. Sans règlement, dossier transmis au recouvrement.`,
    };
    return { body: sms[step.stage] ?? sms.reminder_1, generatedBy: "template" };
  }

  const intro: Record<string, string> = {
    pre_reminder: `Bonjour ${ctx.buyerName},\n\nNous nous permettons de vous rappeler que votre ${ref} arrivera à échéance le ${ctx.dueDate}. Si le règlement est déjà en cours, merci de ne pas tenir compte de ce message.`,
    reminder_1: `Bonjour ${ctx.buyerName},\n\nSauf erreur de notre part, votre ${ref}, échue le ${ctx.dueDate}, ne nous est pas encore parvenue. Il s'agit probablement d'un simple oubli : merci de bien vouloir procéder au règlement.`,
    reminder_2: `Bonjour ${ctx.buyerName},\n\nMalgré notre précédent rappel, votre ${ref} demeure impayée à ce jour (${p.daysLate} jours de retard). Nous vous remercions de régulariser cette situation dans les meilleurs délais.`,
    reminder_3: `Bonjour ${ctx.buyerName},\n\nVotre ${ref} reste impayée malgré nos relances (${p.daysLate} jours de retard). Conformément à nos conditions et à l'article L441-10 du Code de commerce, des pénalités de retard de ${EUR(p.latePenalty)} sont désormais dues, ainsi qu'une indemnité forfaitaire de ${EUR(p.fixedIndemnity)}.`,
    formal_notice: `Bonjour ${ctx.buyerName},\n\nLa présente vaut MISE EN DEMEURE de régler votre ${ref}, échue depuis ${p.daysLate} jours. Le montant total exigible s'élève à ${EUR(p.totalClaim)} (principal ${EUR(p.outstanding)} + pénalités ${EUR(p.latePenalty)} + indemnité forfaitaire ${EUR(p.fixedIndemnity)}).\n\nÀ défaut de règlement sous 8 jours, votre dossier sera transmis en recouvrement, le cas échéant par voie judiciaire, à vos frais.`,
  };

  const outro =
    step.stage === "formal_notice"
      ? "\n\nNous restons toutefois à votre disposition pour convenir d'un règlement amiable."
      : "\n\nPour tout règlement ou question, n'hésitez pas à nous répondre directement à cet email.";

  const subject: Record<string, string> = {
    pre_reminder: `Rappel — échéance de votre facture ${ctx.invoiceNumber}`,
    reminder_1: `Relance — facture ${ctx.invoiceNumber} en attente de règlement`,
    reminder_2: `2e relance — facture ${ctx.invoiceNumber} impayée`,
    reminder_3: `Relance importante — facture ${ctx.invoiceNumber} et pénalités de retard`,
    formal_notice: `MISE EN DEMEURE — facture ${ctx.invoiceNumber}`,
  };

  return {
    subject: subject[step.stage] ?? subject.reminder_1,
    body: (intro[step.stage] ?? intro.reminder_1) + outro + sign,
    generatedBy: "template",
  };
}

// Point d'entrée : tente le LLM, sinon génère un message professionnel déterministe.
export async function generateDunningMessage(ctx: DunningContext): Promise<DunningMessage> {
  return (await tryLLM(ctx)) ?? templateMessage(ctx);
}
