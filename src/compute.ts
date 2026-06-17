import type { Invoice, InvoiceTotals, VatCategory } from "./types.js";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function vatCategory(rate: number): VatCategory {
  return rate > 0 ? "S" : "Z"; // simplifié : >0 = standard, 0 = taux zéro
}

// Micro en franchise de TVA (art. 293 B) tant que les seuils ne sont pas dépassés.
export function isVatFranchise(invoice: Invoice): boolean {
  return invoice.profession === "micro" && !invoice.vatActive;
}

// Calcule les totaux : HT brut, remise, HT net (base TVA), TVA par taux, TTC.
// Gère la franchise de TVA (taux forcé à 0, catégorie E) et la remise globale.
export function computeTotals(invoice: Invoice): InvoiceTotals {
  const franchise = isVatFranchise(invoice);

  const lineTotals = invoice.lines.map((l, i) => ({
    id: l.id ?? String(i + 1),
    net: round2(l.quantity * l.unitPrice),
  }));
  const lineNet = round2(lineTotals.reduce((s, x) => s + x.net, 0));

  // Remise globale
  let discountAmount = 0;
  if (invoice.discount && invoice.discount.value > 0) {
    discountAmount =
      invoice.discount.type === "percent"
        ? round2((lineNet * invoice.discount.value) / 100)
        : round2(Math.min(invoice.discount.value, lineNet));
  }
  const ratio = lineNet > 0 ? (lineNet - discountAmount) / lineNet : 1;

  // Regroupement par taux (remise appliquée proportionnellement ; franchise -> 0)
  const byRate = new Map<number, number>();
  invoice.lines.forEach((l, i) => {
    const rate = franchise ? 0 : l.vatRate;
    const net = round2(lineTotals[i].net * ratio);
    byRate.set(rate, round2((byRate.get(rate) ?? 0) + net));
  });

  const vatBreakdown = [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, base]) => ({
      rate,
      category: (franchise ? "E" : vatCategory(rate)) as VatCategory,
      base: round2(base),
      tax: round2((base * rate) / 100),
    }));

  const totalNet = round2(lineNet - discountAmount);
  const totalVat = round2(vatBreakdown.reduce((s, x) => s + x.tax, 0));
  const totalGross = round2(totalNet + totalVat);

  return {
    lineTotals,
    vatBreakdown,
    lineNet,
    discountAmount,
    totalNet,
    totalVat,
    totalGross,
    amountDue: totalGross,
  };
}
