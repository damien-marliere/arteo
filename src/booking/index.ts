import type { Appointment, Slot } from "./types.js";
import { addAppointment, getService, listAppointments } from "./store.js";
import { generateSlots } from "./slots.js";

export * from "./types.js";
export { generateSlots } from "./slots.js";
export {
  listServices,
  getService,
  listAppointments,
  updateAppointmentStatus,
  getAppointment,
} from "./store.js";

// ID dérivé du store du compte (robuste après restauration).
function newId(accountId: string): string {
  const max = Math.max(0, ...listAppointments(accountId).map((a) => Number(a.id.replace("RDV-", "")) || 0));
  return `RDV-${String(max + 1).padStart(4, "0")}`;
}

export interface BookingRequest {
  serviceId: string;
  start: string; // ISO datetime du créneau choisi
  customer: Appointment["customer"];
  source?: Appointment["source"];
}

// Réserve un créneau pour un compte si toujours disponible (anti double-réservation).
export function book(accountId: string, req: BookingRequest, now: Date = new Date()): Appointment {
  const service = getService(accountId, req.serviceId);
  if (!service) throw new Error(`Service inconnu : ${req.serviceId}`);

  const startDate = new Date(req.start);
  const isFree = generateSlots(accountId, req.serviceId, startDate, 1, now).some(
    (s) => s.start === startDate.toISOString()
  );
  if (!isFree) throw new Error("Créneau indisponible ou déjà réservé.");

  const end = new Date(startDate.getTime() + service.durationMin * 60_000);
  return addAppointment(accountId, {
    id: newId(accountId),
    serviceId: req.serviceId,
    start: startDate.toISOString(),
    end: end.toISOString(),
    customer: req.customer,
    status: "booked",
    source: req.source ?? "portal",
    createdAt: new Date().toISOString(),
  });
}

// Premier créneau disponible (utile pour le réceptionniste IA).
export function firstAvailable(accountId: string, serviceId: string, from: Date, now: Date = new Date()): Slot | null {
  return generateSlots(accountId, serviceId, from, 14, now)[0] ?? null;
}
