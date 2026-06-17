import type { Invoice } from "../types.js";
import type { InvoiceRecord } from "./types.js";
import { upsert, clear } from "./store.js";

function inv(
  number: string,
  issueDate: string,
  dueDate: string,
  buyerName: string,
  buyerEmail: string,
  lines: Invoice["lines"]
): Invoice {
  return {
    invoiceNumber: number,
    issueDate,
    dueDate,
    currency: "EUR",
    seller: {
      name: "Plomberie Martin SARL",
      siret: "81234567800019",
      vatId: "FR40812345678",
      address: { line1: "12 rue des Lilas", postalCode: "69003", city: "Lyon", countryCode: "FR" },
      email: "contact@plomberie-martin.fr",
    },
    buyer: {
      name: buyerName,
      address: { line1: "1 rue du Client", postalCode: "69002", city: "Lyon", countryCode: "FR" },
      email: buyerEmail,
    },
    lines,
  };
}

// Jeu de données de démonstration couvrant plusieurs niveaux de retard.
export function seedDemoInvoices(accountId: string): void {
  clear(accountId);
  const records: InvoiceRecord[] = [
    {
      invoice: inv("F-2026-0007", "2026-04-01", "2026-05-01", "Cabinet Dupont SCI", "compta@cabinet-dupont.fr", [
        { description: "Rénovation salle de bain", quantity: 1, unitPrice: 3200, vatRate: 10 },
      ]),
      status: "sent",
      sentDate: "2026-04-01",
      payments: [],
      dunning: { stage: "none", events: [] },
    },
    {
      invoice: inv("F-2026-0012", "2026-05-20", "2026-06-09", "SCI Les Tilleuls", "gestion@tilleuls.fr", [
        { description: "Dépannage fuite + main d'œuvre", quantity: 1, unitPrice: 480, vatRate: 10 },
      ]),
      status: "sent",
      sentDate: "2026-05-20",
      payments: [],
      dunning: { stage: "none", events: [] },
    },
    {
      invoice: inv("F-2026-0015", "2026-06-10", "2026-06-19", "Boulangerie Lemoine", "contact@lemoine.fr", [
        { description: "Installation chauffe-eau", quantity: 1, unitPrice: 900, vatRate: 20 },
      ]),
      status: "sent",
      sentDate: "2026-06-10",
      payments: [],
      dunning: { stage: "none", events: [] },
    },
    {
      invoice: inv("F-2026-0003", "2026-03-01", "2026-03-31", "Restaurant Le Gourmet", "compta@legourmet.fr", [
        { description: "Entretien plomberie annuel", quantity: 1, unitPrice: 600, vatRate: 20 },
      ]),
      status: "paid",
      sentDate: "2026-03-01",
      payments: [{ date: "2026-03-20", amount: 720 }],
      dunning: { stage: "none", events: [] },
    },
  ];
  records.forEach((r) => upsert(accountId, r));
}
