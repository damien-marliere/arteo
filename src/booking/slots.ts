import type { Appointment, Slot } from "./types.js";
import { activeAppointments, getBusinessHours, getService } from "./store.js";

const STEP_MIN = 30; // granularité de proposition des créneaux

function hm(date: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(date);
  d.setUTCHours(h, m, 0, 0);
  return d;
}

function overlaps(aStart: Date, aEnd: Date, appts: Appointment[]): boolean {
  return appts.some((b) => {
    if (b.status === "cancelled" || b.status === "no_show") return false;
    const bs = new Date(b.start).getTime();
    const be = new Date(b.end).getTime();
    return aStart.getTime() < be && bs < aEnd.getTime();
  });
}

// Génère les créneaux libres pour un service d'un compte sur une plage de jours.
export function generateSlots(
  accountId: string,
  serviceId: string,
  fromDate: Date,
  days = 7,
  now: Date = new Date()
): Slot[] {
  const service = getService(accountId, serviceId);
  if (!service) throw new Error(`Service inconnu : ${serviceId}`);
  const hours = getBusinessHours(accountId);
  const booked = activeAppointments(accountId);
  const slots: Slot[] = [];

  for (let dayOffset = 0; dayOffset < days; dayOffset++) {
    const day = new Date(fromDate);
    day.setUTCDate(day.getUTCDate() + dayOffset);
    const windows = hours[day.getUTCDay()] ?? [];

    for (const w of windows) {
      let cursor = hm(day, w.start);
      const windowEnd = hm(day, w.end);

      while (cursor.getTime() + service.durationMin * 60_000 <= windowEnd.getTime()) {
        const slotEnd = new Date(cursor.getTime() + service.durationMin * 60_000);
        const inFuture = cursor.getTime() > now.getTime();
        if (inFuture && !overlaps(cursor, slotEnd, booked)) {
          slots.push({ start: cursor.toISOString(), end: slotEnd.toISOString() });
        }
        cursor = new Date(cursor.getTime() + STEP_MIN * 60_000);
      }
    }
  }
  return slots;
}
