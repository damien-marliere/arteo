import type { DunningEvent, DunningPolicyStep, InvoiceRecord } from "./types.js";
import { DEFAULT_POLICY, dueStep } from "./policy.js";
import { computePenalties } from "./penalties.js";
import { outstanding, list } from "./store.js";
import { generateDunningMessage, type DunningContext } from "./ai.js";
import { ConsoleTransport, type Transport } from "./transport.js";

export interface DunningAction {
  invoiceNumber: string;
  buyer: string;
  stage: string;
  channel: "email" | "sms";
  daysLate: number;
  amountClaimed: number;
  subject?: string;
  body: string;
  generatedBy: "ai" | "template";
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function daysFromDue(rec: InvoiceRecord, asOf: Date): number {
  if (!rec.invoice.dueDate) return -9999;
  const ms = asOf.getTime() - new Date(rec.invoice.dueDate + "T00:00:00Z").getTime();
  return Math.floor(ms / 86_400_000);
}

// Évalue une facture et exécute au plus une relance si une étape est due.
export async function processRecord(
  rec: InvoiceRecord,
  asOf: Date,
  transport: Transport,
  policy: DunningPolicyStep[] = DEFAULT_POLICY
): Promise<DunningAction | null> {
  if (rec.status === "paid" || rec.status === "cancelled") return null;
  if (rec.dunning.paused) return null;
  if (outstanding(rec) <= 0.005) return null;

  const dfd = daysFromDue(rec, asOf);
  const step = dueStep(dfd, rec.dunning.stage, policy);
  if (!step) return null;

  const penalties = computePenalties(rec, asOf);
  const ctx: DunningContext = {
    sellerName: rec.invoice.seller.name,
    buyerName: rec.invoice.buyer.name,
    contactEmail: rec.invoice.buyer.email ?? "client@example.com",
    invoiceNumber: rec.invoice.invoiceNumber,
    issueDate: rec.invoice.issueDate,
    dueDate: rec.invoice.dueDate,
    outstanding: penalties.outstanding,
    penalties,
    step,
  };

  const msg = await generateDunningMessage(ctx);
  const to = step.channel === "email" ? ctx.contactEmail : rec.invoice.buyer.email ?? "+33600000000";
  await transport.send({ channel: step.channel, to, subject: msg.subject, body: msg.body });

  const event: DunningEvent = {
    date: new Date().toISOString(),
    stage: step.stage,
    channel: step.channel,
    subject: msg.subject,
    body: msg.body,
    to,
    generatedBy: msg.generatedBy,
  };
  rec.dunning.events.push(event);
  rec.dunning.stage = step.stage;
  rec.dunning.nextActionDate = nextActionDate(asOf, step, policy);

  return {
    invoiceNumber: rec.invoice.invoiceNumber,
    buyer: rec.invoice.buyer.name,
    stage: step.stage,
    channel: step.channel,
    daysLate: penalties.daysLate,
    amountClaimed: penalties.totalClaim,
    subject: msg.subject,
    body: msg.body,
    generatedBy: msg.generatedBy,
  };
}

function nextActionDate(
  asOf: Date,
  current: DunningPolicyStep,
  policy: DunningPolicyStep[]
): string | undefined {
  const next = policy
    .filter((s) => s.offsetDays > current.offsetDays)
    .sort((a, b) => a.offsetDays - b.offsetDays)[0];
  if (!next) return undefined;
  // estimation : échéance + offset de la prochaine étape
  const due = new Date(asOf);
  due.setUTCDate(due.getUTCDate() + (next.offsetDays - current.offsetDays));
  return isoDate(due);
}

// Passe sur le portefeuille d'un compte et déclenche les relances dues.
export async function runDunning(
  accountId: string,
  asOf: Date = new Date(),
  transport: Transport = new ConsoleTransport(),
  policy: DunningPolicyStep[] = DEFAULT_POLICY
): Promise<DunningAction[]> {
  const actions: DunningAction[] = [];
  for (const rec of list(accountId)) {
    const a = await processRecord(rec, asOf, transport, policy);
    if (a) actions.push(a);
  }
  return actions;
}
