// Compréhension du langage (NLU) pour le réceptionniste : heuristiques hors-ligne
// + hook LLM optionnel. Détecte le service, l'urgence, le nom et le téléphone.

import { listServices } from "../booking/store.js";
import { llmJson } from "../llm/index.js";

const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const STOP = new Set(["pour","avec","sur","les","des","une","unu","rdv","rendez","vous","sans","dans","mon","mes","par","ou","et","de","du","la","le","au","aux","un","ma","votre","vos"]);

// Classe la demande sur l'une des prestations DU COMPTE, en dérivant les mots-clés
// du nom et de la description de chaque prestation (donc valable pour tout métier),
// plus quelques synonymes génériques (estimation/devis, visite/sur place…).
export function classifyService(accountId: string, text: string): string | null {
  const t = norm(text);
  let best: { id: string; score: number } | null = null;
  for (const svc of listServices(accountId)) {
    const blob = norm(`${svc.name} ${svc.description ?? ""}`);
    const words = blob.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));
    let score = words.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0);
    if (/estim|devis|prix|tarif|chiffr|combien/.test(t) && /estim|devis/.test(blob)) score += 2;
    if (/(visite|sur place|interven|domicile|deplac|passer)/.test(t) && /(sur place|visite|interven|domicile)/.test(blob)) score += 2;
    if (/(premier|decouverte|contact|renseign|information|premiere)/.test(t) && /(premier|decouverte|contact)/.test(blob)) score += 2;
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
