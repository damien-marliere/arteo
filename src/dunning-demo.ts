import { seedDemoInvoices } from "./dunning/seed.js";
import { runDunning } from "./dunning/engine.js";
import { ConsoleTransport } from "./dunning/transport.js";
import { recordPayment, outstanding, get } from "./dunning/store.js";

const ACC = "demo";
const asOf = new Date("2026-06-16T09:00:00Z");
const transport = new ConsoleTransport();

console.log("=".repeat(70));
console.log(`MOTEUR DE RELANCE — exécution au ${asOf.toISOString().slice(0, 10)}`);
console.log("=".repeat(70));

seedDemoInvoices(ACC);
const actions = await runDunning(ACC, asOf, transport);

console.log("\n--- RELANCES DÉCLENCHÉES ---");
for (const a of actions) {
  console.log(
    `• ${a.invoiceNumber} → ${a.buyer} | étape=${a.stage} | canal=${a.channel} | ` +
      `retard=${a.daysLate}j | réclamé=${a.amountClaimed.toFixed(2)}€ | par=${a.generatedBy}`
  );
}
console.log(`\n(${actions.length} relance(s) envoyée(s) — détail des messages ci-dessus)`);

// Le client SCI Les Tilleuls paie : la relance doit s'arrêter.
console.log("\n--- PAIEMENT REÇU : F-2026-0012 réglée intégralement ---");
const rec = get(ACC, "F-2026-0012")!;
recordPayment(ACC, "F-2026-0012", { date: "2026-06-16", amount: outstanding(rec) });
console.log(`Statut F-2026-0012 = ${get(ACC, "F-2026-0012")!.status} | reste dû = ${outstanding(get(ACC, "F-2026-0012")!).toFixed(2)}€`);

console.log("\n--- NOUVELLE EXÉCUTION DU MOTEUR ---");
const actions2 = await runDunning(ACC, asOf, transport);
const stillRelancing = actions2.find((a) => a.invoiceNumber === "F-2026-0012");
console.log(
  stillRelancing
    ? "ERREUR : la facture payée est encore relancée."
    : "OK : la facture payée n'est plus relancée (arrêt automatique au paiement)."
);
console.log(`Relances à cette 2e passe : ${actions2.length} (les factures déjà relancées ne le sont pas deux fois).`);
