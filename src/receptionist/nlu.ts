// Compréhension du langage (NLU) pour le réceptionniste : heuristiques hors-ligne
// + hook LLM optionnel. Détecte le service, l'urgence, le nom et le téléphone.

import { listServices } from "../booking/store.js";
import { llmJson } from "../llm/index.js";

const SERVICE_KEYWORDS: Record<string, string[]> = {
  depannage: ["fuite", "panne", "urgent", "urgence", "inondation", "bouché", "bouche", "ne marche plus", "casse", "cassé", "déborde"],
  devis: ["devis", "estimation", "prix", "chiffrage", "combien", "tarif"],
  installation: ["installer", "installation", "pose", "poser", "chauffe-eau", "chauffe eau", "ballon", "robinet", "douche", "wc", "sanitaire", "remplacer"],
  entretien: ["entretien", "maintenance", "révision", "revision", "annuel", "chaudière", "chaudiere"],
};

export function classifyService(accountId: string, text: string): string | null {
  const t = text.toLowerCase();
  let best: { id: string; score: number } | null = null;
  for (const svc of listServices(accountId)) {
    const kws = SERVICE_KEYWORDS[svc.id] ?? [];
    const score = kws.reduce((s, k) => s + (t.includes(k) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { id: svc.id, score };
  }
  return best?.id ?? null;
}

export function detectUrgency(text: string): boolean {
  const t = text.toLowerCase();
  return ["urgent", "urgence", "tout de suite", "vite", "immédiat", "immediat", "inondation", "déborde", "fuite"].some((k) =>
    t.includes(k)
  );
}

export function extractPhone(text: string): string | null {
  const m = text.replace(/[^\d+]/g, " ").match(/(\+?\d[\d ]{8,13}\d)/);
  if (!m) return null;
  const digits = m[1].replace(/\s/g, "");
  return digits.length >= 9 ? digits : null;
}

export function extractName(text: string): string | null {
  const t = text.trim();
  const m = t.match(/(?:je m'appelle|je suis|c'est|moi c'est|monsieur|madame|m\.|mme)\s+([A-Za-zÀ-ÿ'’\- ]{2,40})/i);
  if (m) return clean(m[1]);
  // sinon, si la phrase est courte et alphabétique, on suppose que c'est le nom
  if (/^[A-Za-zÀ-ÿ'’\- ]{2,40}$/.test(t) && t.split(/\s+/).length <= 4) return clean(t);
  return null;
}

function clean(s: string): string {
  return s.trim().replace(/\s+/g, " ").replace(/[.,;]+$/, "");
}

export interface Extracted {
  serviceId: string | null;
  urgent: boolean;
  phone: string | null;
  name: string | null;
}

// Extraction structurée via le client LLM (null si désactivé). Les heuristiques
// restent appliquées par l'appelant ; le LLM vient affiner/compléter.
export async function llmExtract(accountId: string, history: string, utterance: string): Promise<Partial<Extracted> | null> {
  const services = listServices(accountId).map((s) => `${s.id}: ${s.name}`).join(", ");
  const prompt =
    `Extrais en JSON {serviceId, urgent, phone, name} depuis l'échange téléphonique. ` +
    `serviceId parmi [${services}] ou null. urgent=bool. ` +
    `Historique:\n${history}\nDernier message client: "${utterance}"\nRéponds uniquement le JSON.`;
  return llmJson<Partial<Extracted>>(prompt);
}
