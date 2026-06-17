import { book, generateSlots, getService, listServices } from "../booking/index.js";
import type { Appointment } from "../booking/types.js";
import { getReviewConfig } from "../reviews/index.js";
import { classifyService, detectUrgency, extractName, extractPhone, llmExtract } from "./nlu.js";

// Réceptionniste IA : tient une conversation, qualifie la demande, prend le RDV.
// Conçu pour être branché derrière la téléphonie (Twilio Voice + speech-to-text) :
// chaque tour = un énoncé transcrit du client, la réponse = le texte à vocaliser.
// ISOLÉ PAR COMPTE : chaque ligne téléphonique correspond à un compte artisan.

type Stage = "reason" | "name" | "phone" | "confirm" | "done" | "message";

interface CallState {
  id: string;
  accountId: string;
  stage: Stage;
  data: {
    serviceId?: string;
    urgent?: boolean;
    name?: string;
    phone?: string;
    proposedSlot?: string;       // ISO du créneau proposé
    offered: string[];           // créneaux déjà proposés
  };
  history: { role: "bot" | "caller"; text: string }[];
  appointment?: Appointment;
}

const calls = new Map<string, CallState>();
export function getCall(id: string): CallState | undefined {
  return calls.get(id);
}
export function listCalls(): CallState[] {
  return [...calls.values()];
}
export function clearCalls(): void {
  calls.clear();
}

export interface TurnResult {
  reply: string;
  stage: Stage;
  done: boolean;
  appointment?: Appointment;
}

const YES = ["oui", "ok", "okay", "d'accord", "daccord", "parfait", "ça marche", "ca marche", "c'est bon", "cest bon", "vas-y", "allez-y", "confirme", "je confirme", "bien"];
const NO = ["non", "autre", "pas possible", "plus tard", "ça va pas", "ca va pas", "un autre"];

function frSlot(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  });
}

function nextSlot(state: CallState, now: Date): string | null {
  const svc = state.data.serviceId!;
  const slots = generateSlots(state.accountId, svc, now, 14, now);
  const fresh = slots.find((s) => !state.data.offered.includes(s.start));
  return fresh?.start ?? null;
}

export function startCall(accountId: string, id: string): TurnResult {
  const business = getReviewConfig(accountId).businessName;
  const greeting = `Bonjour, ${business}, votre assistant. Comment puis-je vous aider ?`;
  calls.set(id, { id, accountId, stage: "reason", data: { offered: [] }, history: [{ role: "bot", text: greeting }] });
  return { reply: greeting, stage: "reason", done: false };
}

export async function handleTurn(accountId: string, id: string, utterance: string, now: Date = new Date()): Promise<TurnResult> {
  const call = calls.get(id) ?? startCallState(accountId, id);
  call.history.push({ role: "caller", text: utterance });
  const d = call.data;

  // 1) Capture spécifique à l'étape en cours
  if (call.stage === "name") d.name = extractName(utterance) ?? utterance.trim();
  if (call.stage === "phone") d.phone = extractPhone(utterance) ?? d.phone;

  // 2) Capture opportuniste depuis n'importe quel énoncé (heuristiques + LLM optionnel)
  const llm = await llmExtract(accountId, call.history.map((h) => `${h.role}: ${h.text}`).join("\n"), utterance);
  d.serviceId = d.serviceId ?? llm?.serviceId ?? classifyService(accountId, utterance) ?? undefined;
  d.urgent = d.urgent || !!llm?.urgent || detectUrgency(utterance);
  d.phone = d.phone ?? (llm?.phone as string) ?? extractPhone(utterance) ?? undefined;
  if (!d.name) {
    const n = (llm?.name as string) ?? (call.stage === "reason" ? null : extractName(utterance));
    if (n) d.name = n;
  }

  // 3) Gestion de la confirmation
  if (call.stage === "confirm") {
    const t = utterance.toLowerCase();
    if (YES.some((w) => t.includes(w))) {
      const appt = book(
        accountId,
        { serviceId: d.serviceId!, start: d.proposedSlot!, customer: { name: d.name!, phone: d.phone }, source: "receptionist" },
        now
      );
      call.appointment = appt;
      call.stage = "done";
      const reply = `C'est noté ${d.name} : ${getService(accountId, d.serviceId!)!.name} le ${frSlot(d.proposedSlot!)}. Vous recevrez une confirmation par SMS au ${d.phone}. Merci et à bientôt !`;
      call.history.push({ role: "bot", text: reply });
      return { reply, stage: "done", done: true, appointment: appt };
    }
    if (NO.some((w) => t.includes(w))) {
      const slot = nextSlot(call, now);
      if (!slot) return finish(call, "Je n'ai pas d'autre créneau proche. Je prends votre demande et un conseiller vous rappellera.", "message");
      d.proposedSlot = slot;
      d.offered.push(slot);
      return ask(call, "confirm", `Très bien. Sinon je peux vous proposer le ${frSlot(slot)}. Cela vous convient-il ?`);
    }
    // réponse ambiguë -> redemander
    return ask(call, "confirm", `Le ${frSlot(d.proposedSlot!)} vous convient-il ? Répondez par oui ou non.`);
  }

  // 4) Détermination de la prochaine information manquante
  if (!d.serviceId) {
    const svcList = listServices(accountId).map((s) => s.name.toLowerCase()).slice(0, 3).join(", ");
    return ask(call, "reason", `Pouvez-vous me préciser le motif ? Par exemple : ${svcList}…`);
  }
  if (!d.name) return ask(call, "name", `Très bien. C'est noté. À quel nom dois-je enregistrer le rendez-vous ?`);
  if (!d.phone) return ask(call, "phone", `Merci ${d.name}. Quel numéro pour vous joindre et confirmer ?`);

  // 5) Proposition de créneau
  const slot = d.proposedSlot ?? nextSlot(call, now);
  if (!slot) return finish(call, `Je n'ai pas de créneau disponible immédiatement. Je transmets votre demande${d.urgent ? " en urgence" : ""} et on vous rappelle très vite.`, "message");
  d.proposedSlot = slot;
  if (!d.offered.includes(slot)) d.offered.push(slot);
  const urg = d.urgent ? "Vu l'urgence, " : "";
  return ask(call, "confirm", `${urg}je peux vous proposer un ${getService(accountId, d.serviceId)!.name} le ${frSlot(slot)}. Cela vous convient-il ?`);
}

function startCallState(accountId: string, id: string): CallState {
  const c: CallState = { id, accountId, stage: "reason", data: { offered: [] }, history: [] };
  calls.set(id, c);
  return c;
}
function ask(call: CallState, stage: Stage, reply: string): TurnResult {
  call.stage = stage;
  call.history.push({ role: "bot", text: reply });
  return { reply, stage, done: false };
}
function finish(call: CallState, reply: string, stage: Stage): TurnResult {
  call.stage = stage;
  call.history.push({ role: "bot", text: reply });
  return { reply, stage, done: true };
}
