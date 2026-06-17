// Modèle de données facture — conforme aux champs requis par EN 16931 / Factur-X.
// Profil cible : EN 16931 (le profil "complet" exigé par la réforme française).

export interface Party {
  name: string;
  siret?: string;          // identifiant SIRET (14 chiffres)
  vatId?: string;          // n° TVA intracommunautaire (ex. FR40123456789)
  address: {
    line1: string;
    postalCode: string;
    city: string;
    countryCode: string;   // code pays ISO 3166-1 alpha-2, ex. "FR"
  };
  email?: string;
  phone?: string;          // téléphone (affiché sur la facture)
  website?: string;        // site web
  rcs?: string;            // RCS + ville d'immatriculation
  iban?: string;           // coordonnées bancaires (émetteur)
  bic?: string;
  insurance?: string;      // assurance pro / décennale
  rge?: string;            // qualification RGE / Qualibat (bâtiment)
}

export interface InvoiceLine {
  id?: string;             // identifiant de ligne (auto si absent)
  description: string;
  quantity: number;
  unitPrice: number;       // prix unitaire HT
  unit?: string;           // code unité UN/ECE Rec 20, défaut "C62" (unité)
  vatRate: number;         // taux de TVA en %, ex. 20, 10, 5.5, 0
}

export type VatCategory = "S" | "Z" | "E" | "AE"; // Standard / taux zéro / exonéré / autoliquidation

export interface Invoice {
  invoiceNumber: string;             // numéro de facture (obligatoire, séquentiel)
  issueDate: string;                 // date d'émission "YYYY-MM-DD"
  dueDate?: string;                  // date d'échéance "YYYY-MM-DD"
  currency?: string;                 // défaut "EUR"
  typeCode?: string;                 // 380 = facture, 381 = avoir. Défaut "380"
  seller: Party;                     // vendeur / émetteur
  buyer: Party;                      // acheteur / client
  lines: InvoiceLine[];
  paymentTerms?: string;             // mentions de paiement
  note?: string;                     // note libre
  logo?: string;                     // logo de l'émetteur (data URL image, optionnel)
  docType?: "facture" | "devis";     // type de document (défaut facture)
  profession?: string;               // métier (batiment, micro, liberal, immobilier, commerce)
  vatActive?: boolean;               // micro : assujetti TVA si seuil de franchise dépassé
  discount?: { type: "percent" | "amount"; value: number }; // remise globale
  schedule?: { label: string; pct: number }[];              // échéancier d'acomptes
  validity?: string;                 // (devis) date de validité "YYYY-MM-DD"
}

// Totaux calculés
export interface InvoiceTotals {
  lineTotals: { id: string; net: number }[];
  vatBreakdown: { rate: number; category: VatCategory; base: number; tax: number }[];
  lineNet: number;         // total HT brut (avant remise)
  discountAmount: number;  // montant de la remise
  totalNet: number;        // total HT net (base imposable, après remise)
  totalVat: number;        // total TVA
  totalGross: number;      // total TTC
  amountDue: number;       // net à payer
}
