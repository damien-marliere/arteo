import type { InvoiceRecord, Payment } from "./types.js";
import { computeTotals } from "../compute.js";

// Store des factures suivies — ISOLÉ PAR COMPTE (multi-tenant).
// data: accountId -> (invoiceNumber -> InvoiceRecord)
const data = new Map<string, Map<string, InvoiceRecord>>();

function ws(accountId: string): Map<string, InvoiceRecord> {
  let m = data.get(accountId);
  if (!m) data.set(accountId, (m = new Map()));
  return m;
}

export function upsert(accountId: string, rec: InvoiceRecord): InvoiceRecord {
  ws(accountId).set(rec.invoice.invoiceNumber, rec);
  return rec;
}
export function get(accountId: string, invoiceNumber: string): InvoiceRecord | undefined {
  return ws(accountId).get(invoiceNumber);
}
export function list(accountId: string): InvoiceRecord[] {
  return [...ws(accountId).values()];
}
export function clear(accountId: string): void {
  ws(accountId).clear();
}

// --- Helpers purs (opèrent sur un enregistrement, pas besoin du compte) ---
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export function totalDue(rec: InvoiceRecord): number {
  return computeTotals(rec.invoice).amountDue;
}
export function totalPaid(rec: InvoiceRecord): number {
  return round2(rec.payments.reduce((s, p) => s + p.amount, 0));
}
export function outstanding(rec: InvoiceRecord): number {
  return round2(totalDue(rec) - totalPaid(rec));
}

export function recordPayment(accountId: string, invoiceNumber: string, payment: Payment): InvoiceRecord {
  const rec = ws(accountId).get(invoiceNumber);
  if (!rec) throw new Error(`Facture inconnue : ${invoiceNumber}`);
  rec.payments.push(payment);
  if (outstanding(rec) <= 0.005) {
    rec.status = "paid";
    rec.dunning.stage = "none";
    rec.dunning.nextActionDate = undefined;
  } else {
    rec.status = "partially_paid";
  }
  return rec;
}

// --- Persistance (toutes les données, par compte) ---
export function dumpDunning(): Record<string, InvoiceRecord[]> {
  const out: Record<string, InvoiceRecord[]> = {};
  for (const [acc, m] of data) out[acc] = [...m.values()];
  return out;
}
export function restoreDunning(obj: Record<string, InvoiceRecord[]> = {}): void {
  data.clear();
  for (const [acc, arr] of Object.entries(obj ?? {})) {
    const m = new Map<string, InvoiceRecord>();
    for (const r of arr) m.set(r.invoice.invoiceNumber, r);
    data.set(acc, m);
  }
}
