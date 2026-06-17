import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { dumpDunning, restoreDunning } from "./dunning/store.js";
import { dumpBooking, restoreBooking } from "./booking/store.js";
import { dumpReviews, restoreReviews } from "./reviews/index.js";
import { dumpAuth, restoreAuth } from "./auth/index.js";
import { dumpQuotes, restoreQuotes } from "./quotes/index.js";

// Persistance simple par fichier JSON, écriture atomique (rename).
// Interface volontairement isolée : on peut remplacer le backend par Postgres
// sans toucher au reste du code (mêmes dump*/restore* par module).

const DB_PATH = process.env.DB_PATH ?? "data/db.json";

export interface DbSnapshot {
  version: number;
  savedAt: string;
  auth: ReturnType<typeof dumpAuth>;
  dunning: ReturnType<typeof dumpDunning>;
  booking: ReturnType<typeof dumpBooking>;
  reviews: ReturnType<typeof dumpReviews>;
  quotes: ReturnType<typeof dumpQuotes>;
}

function snapshot(): DbSnapshot {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    auth: dumpAuth(),
    dunning: dumpDunning(),
    booking: dumpBooking(),
    reviews: dumpReviews(),
    quotes: dumpQuotes(),
  };
}

let saveTimer: NodeJS.Timeout | null = null;

// Sauvegarde immédiate (atomique).
export function saveNow(): void {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const tmp = `${DB_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot(), null, 2));
  renameSync(tmp, DB_PATH);
}

// Sauvegarde différée (regroupe les écritures rapprochées).
export function save(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

// Charge l'état depuis le disque au démarrage.
export function load(): boolean {
  if (!existsSync(DB_PATH)) return false;
  try {
    const data = JSON.parse(readFileSync(DB_PATH, "utf8")) as DbSnapshot;
    restoreAuth(data.auth);
    restoreDunning(data.dunning);
    restoreBooking(data.booking);
    restoreReviews(data.reviews);
    restoreQuotes(data.quotes);
    return true;
  } catch (e) {
    console.error("Persistance : échec du chargement", e);
    return false;
  }
}
