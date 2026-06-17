import { writeFile } from "node:fs/promises";
import type { Invoice } from "./types.js";
import { generateFacturX } from "./facturx/index.js";

// Facture de démonstration (artisan plombier) pour tester la génération Factur-X.
const invoice: Invoice = {
  invoiceNumber: "2026-0001",
  issueDate: "2026-09-15",
  dueDate: "2026-10-15",
  currency: "EUR",
  seller: {
    name: "Plomberie Martin SARL",
    siret: "81234567800019",
    vatId: "FR40812345678",
    address: { line1: "12 rue des Lilas", postalCode: "69003", city: "Lyon", countryCode: "FR" },
    email: "contact@plomberie-martin.fr",
  },
  buyer: {
    name: "Cabinet Dupont SCI",
    siret: "52345678900025",
    vatId: "FR55523456789",
    address: { line1: "8 avenue de la République", postalCode: "69002", city: "Lyon", countryCode: "FR" },
    email: "compta@cabinet-dupont.fr",
  },
  lines: [
    { description: "Remplacement chauffe-eau 200L", quantity: 1, unitPrice: 850, vatRate: 10 },
    { description: "Main d'œuvre installation (h)", quantity: 4, unitPrice: 55, vatRate: 10 },
    { description: "Fournitures raccordement", quantity: 1, unitPrice: 120, vatRate: 20 },
  ],
  paymentTerms: "Paiement à 30 jours. Virement bancaire. Pénalités de retard : 3x taux légal.",
  note: "Garantie pièces et main d'œuvre 1 an. Assurance décennale n° XXX.",
};

const { pdf, xml } = await generateFacturX(invoice);
await writeFile("out/facture-2026-0001.pdf", pdf);
await writeFile("out/factur-x.xml", xml);
console.log("OK — généré : out/facture-2026-0001.pdf (+ XML embarqué) et out/factur-x.xml");
