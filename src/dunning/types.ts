import type { Invoice } from "../types.js";

export type InvoiceStatus = "draft" | "sent" | "partially_paid" | "paid" | "cancelled";

export interface Payment {
  date: string;   // "YYYY-MM-DD"
  amount: number;
}

// Niveau d'escalade de la relance.
export type DunningStage =
  | "none"            // pas encore échue / à jour
  | "pre_reminder"    // rappel courtois avant échéance (J-3)
  | "reminder_1"      // 1re relance (J+1 après échéance)
  | "reminder_2"      // 2e relance ferme (J+8)
  | "reminder_3"      // 3e relance avec pénalités (J+15)
  | "formal_notice"   // mise en demeure (J+30)
  | "escalated";      // au-delà : transmission recouvrement/contentieux

export interface DunningEvent {
  date: string;          // date d'exécution (ISO)
  stage: DunningStage;
  channel: "email" | "sms";
  subject?: string;
  body: string;
  to: string;
  generatedBy: "ai" | "template";
}

// Une facture suivie par le moteur de relance.
export interface InvoiceRecord {
  invoice: Invoice;          // la facture (réutilise le modèle du module facturation)
  status: InvoiceStatus;
  sentDate?: string;         // date d'envoi au client
  payments: Payment[];       // paiements reçus
  dunning: {
    stage: DunningStage;
    events: DunningEvent[];   // historique des relances envoyées
    paused?: boolean;         // pause manuelle (litige, accord...)
    nextActionDate?: string;  // prochaine relance prévue
  };
}

export interface DunningPolicyStep {
  stage: DunningStage;
  offsetDays: number;        // décalage vs échéance (négatif = avant)
  channel: "email" | "sms";
  tone: string;              // consigne de ton pour l'IA
  includePenalties: boolean; // inclure le décompte des pénalités
}
