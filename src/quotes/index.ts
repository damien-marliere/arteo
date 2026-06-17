import type { Invoice } from "../types.js";
import { computeTotals } from "../compute.js";

// Store des devis — ISOLÉ PAR COMPTE (multi-tenant), persistable.

export type QuoteStatus = "envoyé" | "accepté" | "facturé";
export interface Quote {
  id: string;
  invoice: Invoice;        // données du devis (docType = "devis")
  status: QuoteStatus;
  createdAt: string;
  convertedInvoiceNumber?: string;
}

const data = new Map<string, Map<string, Quote>>();
function ws(accountId: string): Map<string, Quote> {
  let m = data.get(accountId);
  if (!m) data.set(accountId, (m = new Map()));
  return m;
}

function newId(accountId: string): string {
  const max = Math.max(0, ...[...ws(accountId).values()].map((q) => Number(String(q.id).replace(/\D/g, "")) || 0));
  return `DEV-${String(max + 1).padStart(4, "0")}`;
}

export function listQuotes(accountId: string): Quote[] {
  return [...ws(accountId).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function getQuote(accountId: string, id: string): Quote | undefined {
  return ws(accountId).get(id);
}

// Enregistre (envoie) un devis.
export function saveQuote(accountId: string, invoice: Invoice): Quote {
  const id = invoice.invoiceNumber?.trim() || newId(accountId);
  const inv: Invoice = { ...invoice, invoiceNumber: id, docType: "devis" };
  const q: Quote = { id, invoice: inv, status: "envoyé", createdAt: new Date().toISOString() };
  ws(accountId).set(id, q);
  return q;
}

export function setStatus(accountId: string, id: string, status: QuoteStatus): Quote {
  const q = ws(accountId).get(id);
  if (!q) throw new Error(`Devis inconnu : ${id}`);
  q.status = status;
  return q;
}

export function quoteTotal(q: Quote): number {
  return computeTotals(q.invoice).totalGross;
}

// Prépare la facture issue d'un devis (sans l'enregistrer ici).
export function toInvoice(q: Quote, invoiceNumber: string): Invoice {
  return { ...q.invoice, invoiceNumber, docType: "facture", validity: undefined };
}

export function markConverted(accountId: string, id: string, invoiceNumber: string): void {
  const q = ws(accountId).get(id);
  if (q) { q.status = "facturé"; q.convertedInvoiceNumber = invoiceNumber; }
}

// --- Persistance ---
export function dumpQuotes(): Record<string, Quote[]> {
  const out: Record<string, Quote[]> = {};
  for (const [acc, m] of data) out[acc] = [...m.values()];
  return out;
}
export function restoreQuotes(obj: Record<string, Quote[]> = {}): void {
  data.clear();
  for (const [acc, arr] of Object.entries(obj ?? {})) {
    const m = new Map<string, Quote>();
    for (const q of arr) m.set(q.id, q);
    data.set(acc, m);
  }
}
