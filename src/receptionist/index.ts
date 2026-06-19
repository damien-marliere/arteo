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
  startedAt?: string;
  callerNumber?: string;
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

// Compte-rendu d'appel conservé pour l'artisan (Journal des appels).
export interface CallRecord {
  id: string;
  accountId: string;
  startedAt: string;
  endedAt: string;
  callerNumber?: string;
  serviceName?: string;
  urgent: boolean;
  customerName?: string;
  phone?: string;
  outcome: string;             // ex. "RDV pris le …", "Rappel demandé"
  appointmentId?: string;
  summary: string;             // résumé court (1-2 phrases)
  transcript: { role: "bot" | "caller"; text: string }[];
}

const calls = new Map<string, CallState>();
const callLog = new Map<string, CallRecord[]>();   // historique par compte

export function getCall(id: string): CallState | undefined {
  return calls.get(id);
}
export function listCalls(): CallState[] {
  return [...calls.values()];
}
export function clearCalls(): void {
  calls.clear();
}
// Journal des appels d'un compte, du plus récent au plus ancien.
export function listCallRecords(accountId: string): CallRecord[] {
  return [...(callLog.get(accountId) ?? [])].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}
function buildSummary(call: CallState, svc: string | undefined, outcome: string): string {
  const who = call.data.name || "Appelant";
  const what = svc || "demande non précisée";
  const urg = call.data.urgent ? " (urgent)" : "";
  const tel = call.data.phone ? ` Tél : ${call.data.phone}.` : "";
  return `${who} — ${what}${urg}. ${outcome}.${tel}`;
}
function finalizeCall(call: CallState, outcome: string): CallRecord {
  const svc = call.data.serviceId ? getService(call.accountId, call.data.serviceId)?.name : undefined;
  const rec: CallRecord = {
    id: call.id,
    accountId: call.accountId,
    startedAt: call.startedAt ?? new Date().toISOString(),
    endedAt: new Date().toISOString(),
    callerNumber: call.callerNumber,
    serviceName: svc,
    urgent: !!call.data.urgent,
    customerName: call.data.name,
    phone: call.data.phone,
    outcome,
    appointmentId: call.appointment?.id,
    summary: buildSummary(call, svc, outcome),
    transcript: call.history.slice(),
  };
  const arr = callLog.get(call.accountId) ?? [];
  const i = arr.findIndex((r) => r.id === rec.id);
  if (i >= 0) arr[i] = rec; else arr.push(rec);
  callLog.set(call.accountId, arr);
  return rec;
}

export interface TurnResult {
  reply: string;
  stage: Stage;
  done: boolean;
  appointment?: Appointment;
  record?: CallRecord;
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

export function startCall(accountId: string, id: string, callerNumber?: string): TurnResult {
  const business = getReviewConfig(accountId).businessName;
  const greeting = `Bonjour, ${business}, votre assistant. Comment puis-je vous aider ?`;
  calls.set(id, { id, accountId, stage: "reason", startedAt: new Date().toISOString(), callerNumber, data: { offered: [] }, history: [{ role: "bot", text: greeting }] });
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
      const record = finalizeCall(call, `RDV pris : ${getService(accountId, d.serviceId!)!.name} le ${frSlot(d.proposedSlot!)}`);
      return { reply, stage: "done", done: true, appointment: appt, record };
    }
    if (NO.some((w) => t.includes(w))) {
      const slot = nextSlot(call, now);
      if (!slot) return finish(call, "Je n'ai pas d'autre créneau proche. Je prends votre demande et un conseiller vous rappellera.", "message");
      d.proposedSlot = slot;
      d.offered.push(slot);
      return ask(call, "confirm", `Très bien. Sinon je peux vous proposer le ${frSlot(slot)}. Cela vous convient-il ?`);
    }
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
  const record = finalizeCall(call, call.data.urgent ? "Rappel demandé (urgent)" : "Rappel demandé / message laissé");
  return { reply, stage, done: true, record };
}

// --- Persistance (journal des appels par compte) ---
export function dumpReceptionist() {
  const out: Record<string, CallRecord[]> = {};
  for (const [acc, arr] of callLog) out[acc] = arr;
  return out;
}
export function restoreReceptionist(obj: any): void {
  if (!obj) return;
  callLog.clear();
  for (const [acc, arr] of Object.entries<any>(obj)) callLog.set(acc, (arr as CallRecord[]) ?? []);
}
