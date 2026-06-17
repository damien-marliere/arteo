// Module de prise de RDV en ligne (portail self-service client).

export interface Service {
  id: string;
  name: string;          // ex. "Dépannage fuite", "Devis sur place"
  durationMin: number;   // durée en minutes
  description?: string;
}

// Horaires d'ouverture par jour de semaine (0 = dimanche ... 6 = samedi).
export interface BusinessHours {
  // chaque entrée : créneaux d'ouverture "HH:MM"-"HH:MM"
  [weekday: number]: { start: string; end: string }[];
}

export type AppointmentStatus = "booked" | "completed" | "cancelled" | "no_show";

export interface Appointment {
  id: string;
  serviceId: string;
  start: string;         // ISO datetime
  end: string;           // ISO datetime
  customer: {
    name: string;
    phone?: string;
    email?: string;
    address?: string;
    note?: string;
  };
  status: AppointmentStatus;
  source: "portal" | "receptionist" | "manual";
  createdAt: string;
}

export interface Slot {
  start: string;         // ISO datetime
  end: string;           // ISO datetime
}
