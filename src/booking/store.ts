import type { Appointment, BusinessHours, Service } from "./types.js";

// Store des RDV — ISOLÉ PAR COMPTE (multi-tenant).
// Chaque compte a ses propres services, horaires et rendez-vous.

interface AccountBooking {
  services: Service[];
  hours: BusinessHours;
  appointments: Map<string, Appointment>;
}

function defaultServices(): Service[] {
  return [
    { id: "depannage", name: "Dépannage urgent", durationMin: 60, description: "Fuite, panne, intervention rapide" },
    { id: "devis", name: "Devis sur place", durationMin: 30, description: "Visite et chiffrage gratuit" },
    { id: "installation", name: "Installation / pose", durationMin: 120, description: "Chauffe-eau, sanitaire, robinetterie" },
    { id: "entretien", name: "Entretien annuel", durationMin: 45, description: "Maintenance chaudière / plomberie" },
  ];
}
function defaultHours(): BusinessHours {
  const wd = [{ start: "08:00", end: "12:00" }, { start: "13:00", end: "18:00" }];
  return { 1: wd, 2: wd, 3: wd, 4: wd, 5: wd, 6: [{ start: "09:00", end: "12:00" }] };
}

const data = new Map<string, AccountBooking>();
function ws(accountId: string): AccountBooking {
  let a = data.get(accountId);
  if (!a) data.set(accountId, (a = { services: defaultServices(), hours: defaultHours(), appointments: new Map() }));
  return a;
}

export function listServices(accountId: string): Service[] {
  return ws(accountId).services;
}
export function getService(accountId: string, id: string): Service | undefined {
  return ws(accountId).services.find((s) => s.id === id);
}
export function getBusinessHours(accountId: string): BusinessHours {
  return ws(accountId).hours;
}
export function setBusinessHours(accountId: string, h: BusinessHours): void {
  ws(accountId).hours = h;
}

export function listAppointments(accountId: string): Appointment[] {
  return [...ws(accountId).appointments.values()].sort((a, b) => a.start.localeCompare(b.start));
}
export function getAppointment(accountId: string, id: string): Appointment | undefined {
  return ws(accountId).appointments.get(id);
}
export function addAppointment(accountId: string, a: Appointment): Appointment {
  ws(accountId).appointments.set(a.id, a);
  return a;
}
export function updateAppointmentStatus(accountId: string, id: string, status: Appointment["status"]): Appointment {
  const a = ws(accountId).appointments.get(id);
  if (!a) throw new Error(`RDV inconnu : ${id}`);
  a.status = status;
  return a;
}
export function activeAppointments(accountId: string): Appointment[] {
  return listAppointments(accountId).filter((a) => a.status === "booked" || a.status === "completed");
}
export function clearAppointments(accountId: string): void {
  ws(accountId).appointments.clear();
}

// --- Persistance (par compte) ---
export function dumpBooking() {
  const out: Record<string, any> = {};
  for (const [acc, a] of data) out[acc] = { services: a.services, hours: a.hours, appointments: [...a.appointments.values()] };
  return out;
}
export function restoreBooking(obj: any): void {
  if (!obj) return;
  data.clear();
  for (const [acc, a] of Object.entries<any>(obj)) {
    const m = new Map<string, Appointment>();
    for (const ap of a.appointments ?? []) m.set(ap.id, ap);
    data.set(acc, { services: a.services ?? defaultServices(), hours: a.hours ?? defaultHours(), appointments: m });
  }
}
