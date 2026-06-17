import type { Invoice } from "../types.js";
import { buildFacturXXml } from "./cii.js";
import { buildFacturXPdf } from "./pdf.js";

export { buildFacturXXml } from "./cii.js";
export { buildFacturXPdf } from "./pdf.js";

// Génère une facture Factur-X complète : renvoie le PDF (avec XML embarqué) + le XML brut.
export async function generateFacturX(invoice: Invoice): Promise<{
  pdf: Uint8Array;
  xml: string;
}> {
  const xml = buildFacturXXml(invoice);
  const pdf = await buildFacturXPdf(invoice, xml);
  return { pdf, xml };
}

// --- Point d'accroche Plateforme Agréée (PA / ex-PDF) ---
// Au lancement, on ne devient PAS Plateforme Agréée soi-même : on transmet le
// Factur-X à une PA partenaire qui gère l'émission/réception réglementaire et
// l'e-reporting vers la DGFiP. Implémentation à brancher selon le partenaire choisi.
export interface PlateformeAgreee {
  name: string;
  submit(invoice: Invoice, facturx: Uint8Array): Promise<{ id: string; status: string }>;
}

export class MockPlateformeAgreee implements PlateformeAgreee {
  name = "Mock-PA (à remplacer par une vraie Plateforme Agréée DGFiP)";
  async submit(invoice: Invoice, _facturx: Uint8Array) {
    return { id: `PA-${invoice.invoiceNumber}-${Date.now()}`, status: "ACCEPTED_SIMULATED" };
  }
}
