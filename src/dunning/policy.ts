import type { DunningPolicyStep, DunningStage } from "./types.js";

// Séquence de relance par défaut — escalade progressive du ton.
// Inspirée des meilleures pratiques (ServiceTitan, Jobber) adaptées au droit FR.
// Séquence par défaut : relances automatiques par email à J+7, J+15, J+30.
export const DEFAULT_POLICY: DunningPolicyStep[] = [
  {
    stage: "reminder_1",
    offsetDays: 7,
    channel: "email",
    tone: "courtois mais clair, on suppose un simple oubli",
    includePenalties: false,
  },
  {
    stage: "reminder_2",
    offsetDays: 15,
    channel: "email",
    tone: "ferme et professionnel, on insiste sur l'urgence et on rappelle les pénalités applicables",
    includePenalties: true,
  },
  {
    stage: "formal_notice",
    offsetDays: 30,
    channel: "email",
    tone: "formel et juridique : mise en demeure avant recouvrement, mentionne pénalités et indemnité forfaitaire",
    includePenalties: true,
  },
];

const ORDER: DunningStage[] = [
  "none",
  "pre_reminder",
  "reminder_1",
  "reminder_2",
  "reminder_3",
  "formal_notice",
  "escalated",
];

export function stageRank(stage: DunningStage): number {
  return ORDER.indexOf(stage);
}

// Détermine l'étape applicable selon le nombre de jours depuis l'échéance,
// en tenant compte de l'étape déjà atteinte (on n'envoie jamais deux fois la même).
export function dueStep(
  daysFromDue: number,
  currentStage: DunningStage,
  policy: DunningPolicyStep[] = DEFAULT_POLICY
): DunningPolicyStep | null {
  // Étapes déclenchables = celles dont l'offset est atteint
  const eligible = policy
    .filter((s) => daysFromDue >= s.offsetDays)
    .sort((a, b) => a.offsetDays - b.offsetDays);
  if (eligible.length === 0) return null;
  // La dernière étape éligible
  const target = eligible[eligible.length - 1];
  // On ne renvoie que si elle est plus avancée que l'étape déjà atteinte
  return stageRank(target.stage) > stageRank(currentStage) ? target : null;
}
