// Démo de l'intégration LLM. Lancer en mode mock (sans clé) :
//   LLM_PROVIDER=mock npm run llm
// Ou avec un vrai fournisseur :
//   LLM_PROVIDER=openai OPENAI_API_KEY=sk-... npm run llm

import { llmStatus } from "./llm/index.js";
import { generateDunningMessage, type DunningContext } from "./dunning/ai.js";
import { DEFAULT_POLICY } from "./dunning/policy.js";

console.log("État IA :", llmStatus());

const step = DEFAULT_POLICY.find((s) => s.stage === "reminder_3")!; // email avec pénalités
const ctx: DunningContext = {
  sellerName: "Plomberie Martin",
  buyerName: "Cabinet Dupont SCI",
  contactEmail: "compta@cabinet-dupont.fr",
  invoiceNumber: "F-2026-0007",
  issueDate: "2026-04-01",
  dueDate: "2026-05-01",
  outstanding: 3520,
  penalties: { outstanding: 3520, daysLate: 46, annualRate: 0.13, latePenalty: 57.67, fixedIndemnity: 40, totalClaim: 3617.67 },
  step,
};

const msg = await generateDunningMessage(ctx);
console.log("\n--- Relance générée ---");
console.log("Source :", msg.generatedBy === "ai" ? "🧠 LLM (chemin IA emprunté)" : "📋 modèle déterministe (fallback)");
console.log("Objet :", msg.subject);
console.log(msg.body);
