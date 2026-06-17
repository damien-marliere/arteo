import { book, generateSlots, listServices, listAppointments, updateAppointmentStatus } from "./booking/index.js";
import { startCall, handleTurn } from "./receptionist/index.js";
import { runReviewRequests } from "./reviews/index.js";
import { ConsoleTransport } from "./dunning/transport.js";

const ACC = "demo"; // compte de démonstration (multi-tenant)
const now = new Date("2026-06-16T07:00:00Z");
const line = (s: string) => console.log("\n" + "=".repeat(68) + "\n" + s + "\n" + "=".repeat(68));

// ---------- 1. PORTAIL DE PRISE DE RDV ----------
line("1) PORTAIL DE PRISE DE RDV (réservation client en ligne)");
console.log("Services proposés :", listServices(ACC).map((s) => `${s.name} (${s.durationMin}min)`).join(" · "));
const slots = generateSlots(ACC, "devis", now, 2, now);
console.log(`Créneaux libres pour un « Devis sur place » (2 jours) : ${slots.length} trouvés`);
console.log("3 premiers :", slots.slice(0, 3).map((s) => s.start).join(" | "));
const appt = book(ACC, { serviceId: "devis", start: slots[0].start, customer: { name: "Marie Leroy", phone: "0611223344", email: "marie@ex.fr" } }, now);
console.log(`✓ RDV réservé : ${appt.id} — ${appt.customer.name} le ${appt.start}`);

// ---------- 2. RÉCEPTIONNISTE IA TÉLÉPHONIQUE ----------
line("2) RÉCEPTIONNISTE IA TÉLÉPHONIQUE (appel simulé)");
const callId = "CALL-001";
const conversation = [
  "Bonjour, j'ai une grosse fuite d'eau sous l'évier, c'est urgent !",
  "Jean Dupont",
  "06 12 34 56 78",
  "oui c'est parfait",
];
console.log("🤖", startCall(ACC, callId).reply);
for (const utt of conversation) {
  console.log("📞", utt);
  const r = await handleTurn(ACC, callId, utt, now);
  console.log("🤖", r.reply);
  if (r.done && r.appointment) console.log(`   → RDV créé par l'IA : ${r.appointment.id}`);
}

// ---------- 3. AVIS GOOGLE AUTOMATIQUES ----------
line("3) AVIS GOOGLE AUTOMATIQUES (après chantier terminé)");
const ended = listAppointments(ACC)[0];
updateAppointmentStatus(ACC, ended.id, "completed");
ended.end = new Date(now.getTime() - 3 * 3600_000).toISOString(); // dépasse le délai de 2h
const transport = new ConsoleTransport();
const actions = await runReviewRequests(ACC, now, transport);
console.log(`Demandes d'avis envoyées : ${actions.length}`);
for (const a of actions) console.log(`• ${a.customerName} via ${a.channel} → ${a.link}`);

line("RÉCAP");
console.log(`RDV au total : ${listAppointments(ACC).length}`);
listAppointments(ACC).forEach((a) => console.log(`  ${a.id} | ${a.customer.name} | ${a.status} | source=${a.source}`));
