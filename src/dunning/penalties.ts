import type { InvoiceRecord } from "./types.js";
import { outstanding } from "./store.js";

// Pénalités de retard B2B en France (Code de commerce art. L441-10) :
//  - taux de pénalité = taux contractuel, à défaut taux directeur BCE + 10 points.
//    On retient un taux annuel par défaut configurable.
//  - indemnité forfaitaire de recouvrement : 40 € par facture en retard.
export const DEFAULT_ANNUAL_PENALTY_RATE = 0.13; // ~13% (BCE + 10 pts, ordre de grandeur)
export const FIXED_RECOVERY_INDEMNITY = 40; // euros

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function daysLate(rec: InvoiceRecord, asOf: Date): number {
  const due = rec.invoice.dueDate;
  if (!due) return 0;
  const ms = asOf.getTime() - new Date(due + "T00:00:00Z").getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export interface PenaltyBreakdown {
  outstanding: number;       // reste à payer (principal)
  daysLate: number;
  annualRate: number;
  latePenalty: number;       // pénalités de retard cumulées
  fixedIndemnity: number;    // indemnité forfaitaire (si en retard)
  totalClaim: number;        // total réclamable
}

export function computePenalties(
  rec: InvoiceRecord,
  asOf: Date,
  annualRate = DEFAULT_ANNUAL_PENALTY_RATE
): PenaltyBreakdown {
  const principal = outstanding(rec);
  const d = daysLate(rec, asOf);
  const latePenalty = d > 0 ? round2((principal * annualRate * d) / 365) : 0;
  const fixedIndemnity = d > 0 ? FIXED_RECOVERY_INDEMNITY : 0;
  return {
    outstanding: principal,
    daysLate: d,
    annualRate,
    latePenalty,
    fixedIndemnity,
    totalClaim: round2(principal + latePenalty + fixedIndemnity),
  };
}
