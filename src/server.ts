import express from "express";
import cookieParser from "cookie-parser";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Invoice } from "./types.js";
import { computeTotals } from "./compute.js";
import { generateFacturX, MockPlateformeAgreee } from "./facturx/index.js";
import { seedDemoInvoices } from "./dunning/seed.js";
import { runDunning } from "./dunning/engine.js";
import { ConsoleTransport, EmailTransport } from "./dunning/transport.js";
import { sendEmail, emailConfigured, verifySmtp } from "./email/index.js";
import { list as listRecords, get as getRecord, recordPayment, outstanding, totalDue, upsert } from "./dunning/store.js";
import { computePenalties } from "./dunning/penalties.js";
import { book, generateSlots, listServices, getService, listAppointments, updateAppointmentStatus } from "./booking/index.js";
import { startCall, handleTurn } from "./receptionist/index.js";
import { runReviewRequests, listReviewRequests, setReviewConfig } from "./reviews/index.js";
import { saveQuote, listQuotes, getQuote, setStatus, quoteTotal, toInvoice, markConverted } from "./quotes/index.js";
import { signup, login, logout, requireAuth, accountFromToken, countAccounts, firstAccountId, listAccountIds, getSmtp, setSmtp, getGmailOAuth, setGmailOAuth, setPlan, getSubscription, getProfile, setProfile } from "./auth/index.js";
import { googleConfigured, authUrl, exchangeCode, userEmail, createCalendarEvent } from "./oauth/google.js";
import { load, save, saveNow } from "./persistence.js";
import { llmStatus } from "./llm/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "6mb" })); // marge pour les logos (data URL)
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use("/assets", express.static(join(__dirname, "..", "public", "assets")));

const loaded = load();
console.log(loaded ? "Persistance : état rechargé depuis le disque." : "Persistance : démarrage à vide.");

// Widget de chat (assistant Artéo) injecté en pop-up sur toutes les pages.
const CHAT_SNIPPET = `\n<script src="/assets/chat.js" defer></script>\n`;
const page = (file: string) => async (_req: express.Request, res: express.Response) => {
  let html = await readFile(join(__dirname, "..", "public", file), "utf8");
  if (html.includes("</body>")) html = html.replace("</body>", CHAT_SNIPPET + "</body>");
  res.type("html").send(html);
};

const auth = requireAuth();          // API : 401 si non connecté
const authPage = requireAuth(true);  // Pages : redirige vers /login

// Compte courant (routes admin protégées)
const acc = (req: express.Request) => (req as any).account.id as string;
// Compte ciblé par une route publique (client) : ?account=… ou repli mono-artisan
const publicAcc = (req: express.Request) =>
  String(req.query.account ?? req.body?.accountId ?? firstAccountId() ?? "demo");
// Config d'envoi email d'un compte : Google OAuth ou SMTP (mot de passe d'application).
const sendCfg = (accountId: string) => ({ smtp: getSmtp(accountId), gmailOAuth: getGmailOAuth(accountId) });
// Calcule le n° de TVA intracommunautaire FR à partir d'un SIRET/SIREN.
function frVatId(siretOrSiren: string): string {
  const siren = String(siretOrSiren || "").replace(/\D/g, "").slice(0, 9);
  if (siren.length !== 9) return "";
  const key = (12 + 3 * (Number(siren) % 97)) % 97;
  return `FR${String(key).padStart(2, "0")}${siren}`;
}

// ============ AUTHENTIFICATION (public) ============
app.get("/login", page("login.html"));
app.get("/signup", page("login.html"));

app.post("/api/auth/signup", (req, res) => {
  try {
    const { email, password, businessName, plan } = req.body;
    const account = signup(email, password, businessName, plan);
    setReviewConfig(account.id, { businessName: account.businessName }); // nom utilisé par l'IA et les avis
    const token = login(email, password);
    res.cookie("sid", token, { httpOnly: true, sameSite: "lax" });
    saveNow();
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.post("/api/auth/login", (req, res) => {
  try {
    const token = login(req.body.email, req.body.password);
    res.cookie("sid", token, { httpOnly: true, sameSite: "lax" });
    saveNow();
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.post("/api/auth/logout", (req, res) => {
  logout(req.cookies?.sid); res.clearCookie("sid"); saveNow(); res.json({ ok: true });
});
app.get("/api/me", (req, res) => {
  const account = accountFromToken(req.cookies?.sid);
  if (!account) return res.status(401).json({ error: "Non authentifié" });
  res.json({ id: account.id, email: account.email, businessName: account.businessName });
});

// ============ SITE VITRINE (public) ============
app.get("/", page("landing.html"));

// ============ PAGES ADMIN (protégées) ============
app.get("/app", authPage, page("dashboard.html"));
app.get("/app/invoices", authPage, page("index.html"));
app.get("/app/factures", authPage, page("factures.html"));
app.get("/app/quotes", authPage, page("quotes.html"));
app.get("/app/dunning", authPage, page("dunning.html"));
app.get("/app/abonnement", authPage, page("abonnement.html"));
app.get("/app/profil", authPage, page("profil.html"));

// ============ PAGES CLIENT (publiques) ============
app.get("/book", page("book.html"));
app.get("/receptionist", page("receptionist.html"));

// ============ ASSISTANT / CHATBOT (public — site vitrine + back-office) ============
// Base de connaissances Artéo : répond aux questions sur le site et le back-office.
// Fonctionne sans clé IA (correspondance par mots-clés). Réponses au format HTML léger.
interface KbEntry { keys: string[]; a: string; sug?: string[] }
const norm = (s: string) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const KB: KbEntry[] = [
  { keys: ["bonjour", "salut", "coucou", "hello", "bonsoir", "hey"],
    a: "Bonjour 👋 Je suis l'assistant Artéo. Posez-moi une question sur la facturation, les devis, les relances, les tarifs, la connexion Google, les RDV ou la réforme 2026.",
    sug: ["Quels sont les tarifs ?", "Comment créer une facture ?", "Comment connecter Google ?"] },
  { keys: ["c est quoi arteo", "arteo c est quoi", "que fait arteo", "a quoi sert", "presentation", "qu est ce que arteo", "ca sert a quoi"],
    a: "<b>Artéo</b> est le logiciel tout-en-un des artisans : facturation électronique (conforme à la réforme 2026), devis, relances automatiques des impayés, prise de rendez-vous en ligne avec synchronisation Google Agenda, réceptionniste IA et demandes d'avis Google — le tout au même endroit.",
    sug: ["Quels sont les tarifs ?", "Comment commencer ?"] },
  { keys: ["tarif", "prix", "formule", "combien", "cout", "coute", "abonnement", "starter", "pro", "payer", "plan"],
    a: "Trois formules : <b>Starter à 19€/mois</b> (facturation + devis), <b>Pro à 49€/mois</b> (+ relances automatiques et RDV) et <b>IA à 99€/mois</b> (+ réceptionniste IA et avis Google). Vous profitez d'un <b>essai gratuit de 7 jours</b> sur la facturation, sans carte bancaire. On change de formule dans <i>Abonnement</i>.",
    sug: ["Comment marche l'essai gratuit ?", "Comment changer de formule ?"] },
  { keys: ["essai", "gratuit", "trial", "essayer", "7 jours", "sept jours", "test gratuit"],
    a: "L'<b>essai gratuit dure 7 jours</b> et porte sur la facturation, <b>sans carte bancaire</b>. Le compteur de jours restants s'affiche sur votre tableau de bord. À la fin, vous choisissez une formule dans <i>Abonnement</i>.",
    sug: ["Quels sont les tarifs ?", "Comment changer de formule ?"] },
  { keys: ["changer de formule", "changer formule", "changer abonnement", "upgrade", "passer pro", "modifier formule"],
    a: "Allez dans <b>💳 Abonnement</b> (menu de gauche), puis cliquez sur la formule souhaitée — Starter, Pro ou IA. Le changement est immédiat.",
    sug: ["Quels sont les tarifs ?"] },
  { keys: ["creer une facture", "faire une facture", "nouvelle facture", "facturer", "emettre facture", "comment facturer"],
    a: "Cliquez sur <b>➕ Nouvelle facture</b> dans le menu. Renseignez le client (le SIRET remplit ses infos automatiquement), ajoutez vos lignes, et générez le PDF <b>Factur-X</b> conforme. Si vous avez rempli <i>Mon entreprise</i>, vos coordonnées d'émetteur sont déjà pré-remplies.",
    sug: ["C'est quoi Factur-X ?", "Comment envoyer la facture par email ?"] },
  { keys: ["facturx", "factur x", "factur-x", "conforme", "conformite", "norme", "electronique", "en 16931"],
    a: "<b>Factur-X</b> est le format français de facture électronique : un PDF lisible qui contient aussi les données structurées (norme EN 16931) exigées par la réforme 2026. Artéo génère ce format automatiquement à chaque facture.",
    sug: ["Artéo est-il agréé ?", "Comment créer une facture ?"] },
  { keys: ["agree", "agreee", "plateforme agreee", "pdp", "certifie", "habilite", "homologue", "agrement"],
    a: "Artéo génère des factures au <b>bon format (Factur-X / EN 16931)</b>, conformes aux exigences techniques. En revanche Artéo n'est pas (encore) immatriculé comme <b>Plateforme Agréée (PA)</b> par la DGFiP — c'est l'étape qui permet de transmettre officiellement les factures via l'annuaire. Pour la transmission, Artéo se connectera à une PA agréée. Le calendrier : réception obligatoire pour tous au 1ᵉʳ sept. 2026, émission pour les artisans au 1ᵉʳ sept. 2027.",
    sug: ["C'est quoi Factur-X ?", "Quels sont les tarifs ?"] },
  { keys: ["devis", "faire un devis", "creer devis", "convertir devis", "transformer devis"],
    a: "Menu <b>📝 Devis</b> : créez un devis, envoyez-le en PDF, et une fois accepté, <b>convertissez-le en facture</b> en un clic (les lignes et le client sont repris automatiquement).",
    sug: ["Comment créer une facture ?", "Comment envoyer un devis par email ?"] },
  { keys: ["relance", "relances", "impaye", "impayes", "retard", "penalite", "penalites", "dunning", "recouvrer", "rappel paiement"],
    a: "Menu <b>⏰ Relances</b> : Artéo suit vos factures impayées et envoie des relances automatiques à J+7, J+15 et J+30, en calculant les pénalités de retard. Vous gardez un <b>historique des emails de relance</b> envoyés à chaque client.",
    sug: ["Où voir l'historique des relances ?", "Comment connecter Google pour envoyer les emails ?"] },
  { keys: ["historique relance", "historique des mails", "historique mail", "suivi relance", "voir les relances envoyees", "mails envoyes"],
    a: "Dans <b>⏰ Relances</b>, chaque facture affiche l'historique des emails envoyés (date, objet, contenu, étape J+7/J+15/J+30). Vous suivez ainsi précisément ce qui a été relancé pour chaque client.",
    sug: ["Comment marchent les relances ?"] },
  { keys: ["google", "connecter google", "compte google", "se connecter avec google", "gmail", "agenda", "calendar", "calendrier"],
    a: "Dans <b>⚙️ Réglages email</b>, cliquez sur <b>« Se connecter avec Google »</b> : un seul clic connecte votre compte Google. Cela permet d'<b>envoyer vos factures et relances</b> depuis votre Gmail <i>et</i> de <b>synchroniser vos RDV avec Google Agenda</b> automatiquement. Pas de réglage technique à faire.",
    sug: ["Comment prendre des RDV en ligne ?", "Comment envoyer une facture par email ?"] },
  { keys: ["rdv", "rendez vous", "reservation", "prise de rendez vous", "portail", "booking", "creneaux", "agenda en ligne"],
    a: "Menu <b>📅 Portail RDV</b> : une page de réservation publique où vos clients choisissent un créneau. Si votre compte Google est connecté, chaque RDV s'ajoute automatiquement à votre <b>Google Agenda</b>.",
    sug: ["Comment connecter Google Agenda ?"] },
  { keys: ["mon entreprise", "profil", "siret", "rempli automatiquement", "mes coordonnees", "emetteur", "infos entreprise", "tva"],
    a: "Menu <b>🏢 Mon entreprise</b> : saisissez votre <b>SIRET</b> et Artéo récupère automatiquement votre raison sociale, votre adresse et votre n° de TVA depuis la base officielle. Complétez l'IBAN, le logo, etc. une seule fois — ces infos se <b>pré-remplissent ensuite dans tous vos devis et factures</b>.",
    sug: ["Comment créer une facture ?"] },
  { keys: ["envoyer par email", "envoyer facture", "envoyer devis", "email facture", "smtp", "mot de passe application", "envoyer mail"],
    a: "Configurez l'envoi dans <b>⚙️ Réglages email</b> : soit en <b>1 clic via « Se connecter avec Google »</b>, soit avec un mot de passe d'application SMTP. Ensuite, depuis une facture ou un devis, le bouton <b>Envoyer par email</b> l'expédie en PDF au client.",
    sug: ["Comment connecter Google ?"] },
  { keys: ["avis", "avis google", "review", "e reputation", "reputation", "demander avis", "note google"],
    a: "Artéo peut envoyer automatiquement une <b>demande d'avis Google</b> à vos clients après une prestation (formule IA), pour améliorer votre visibilité locale.",
    sug: ["Quels sont les tarifs ?"] },
  { keys: ["receptionniste", "standard", "appel", "telephone", "ia vocale", "repondre au telephone", "secretaire"],
    a: "Le <b>📞 Réceptionniste IA</b> simule la prise d'appels : il répond aux questions courantes et oriente vos clients (formule IA). Une démo est accessible depuis le menu.",
    sug: ["Quels sont les tarifs ?"] },
  { keys: ["commencer", "demarrer", "creer un compte", "inscription", "s inscrire", "comment debuter", "premiers pas", "creer mon compte"],
    a: "Cliquez sur <b>Créer un compte</b>, choisissez une formule (essai gratuit 7 jours), puis : 1) remplissez <b>🏢 Mon entreprise</b> avec votre SIRET, 2) connectez Google dans <b>⚙️ Réglages email</b>, 3) créez votre première <b>facture</b> ou <b>devis</b>. C'est parti !",
    sug: ["Comment remplir Mon entreprise ?", "Comment connecter Google ?"] },
  { keys: ["mes factures", "liste factures", "retrouver facture", "telecharger facture", "voir mes factures"],
    a: "Menu <b>🧾 Mes factures</b> : la liste de toutes vos factures émises, avec statut (payée / impayée), montant et la possibilité de <b>re-télécharger le PDF Factur-X</b>.",
    sug: ["Comment créer une facture ?"] },
  { keys: ["donnees", "perdu", "efface", "reset", "sauvegarde", "disparu", "redeploiement"],
    a: "Sur la version d'essai gratuite, les données peuvent être réinitialisées à chaque mise à jour du serveur. Pour une conservation durable de vos factures et comptes, une option de stockage permanent est prévue.",
    sug: ["Quels sont les tarifs ?"] },
  { keys: ["contact", "aide", "support", "probleme", "bug", "joindre"],
    a: "Pour une question précise, décrivez votre besoin ici et je vous oriente vers la bonne page. Pour un souci technique, votre interlocuteur Artéo reste joignable par email.",
    sug: ["Quels sont les tarifs ?", "Comment créer une facture ?"] },
];
const KB_FALLBACK_SUG = ["Quels sont les tarifs ?", "Comment créer une facture ?", "Comment connecter Google ?", "C'est quoi Artéo ?"];
function answerAssistant(question: string): { answer: string; suggestions: string[] } {
  const nq = norm(question);
  if (!nq) return { answer: "Posez-moi une question sur Artéo 🙂", suggestions: KB_FALLBACK_SUG };
  let best: KbEntry | null = null, bestScore = 0;
  for (const e of KB) {
    let score = 0;
    for (const k of e.keys) {
      const nk = norm(k);
      if (!nk) continue;
      if (nq.includes(nk)) score += nk.length >= 5 ? 3 : 2;          // expression entière trouvée
      else if (nk.split(" ").every((w) => w.length > 2 && nq.includes(w))) score += 1; // tous les mots présents
    }
    if (score > bestScore) { bestScore = score; best = e; }
  }
  if (best && bestScore >= 2) return { answer: best.a, suggestions: best.sug ?? KB_FALLBACK_SUG };
  return {
    answer: "Je n'ai pas de réponse exacte à cette question 🤔 Je peux vous aider sur : la <b>facturation</b>, les <b>devis</b>, les <b>relances</b>, les <b>tarifs</b>, la <b>connexion Google</b>, les <b>RDV</b>, <b>Mon entreprise</b> et la <b>réforme 2026</b>. Choisissez un sujet ci-dessous ou reformulez.",
    suggestions: KB_FALLBACK_SUG,
  };
}
app.post("/api/assistant", (req, res) => res.json(answerAssistant(String(req.body?.question ?? ""))));

// ============ ÉTAT IA (LLM) ============
app.get("/api/llm/status", (_req, res) => res.json(llmStatus()));

// ============ DASHBOARD ============
app.get("/api/dashboard", auth, (req, res) => {
  const a = acc(req);
  const now = new Date();
  const records = listRecords(a);
  const appts = listAppointments(a);
  const unpaid = records.filter((r) => r.status !== "paid" && r.status !== "cancelled");
  res.json({
    invoices: { total: records.length, unpaid: unpaid.length, outstanding: unpaid.reduce((s, r) => s + outstanding(r), 0) },
    appointments: { total: appts.length, upcoming: appts.filter((x) => x.status === "booked" && new Date(x.start) > now).length },
    reviews: { sent: listReviewRequests(a).length },
  });
});

// ============ MON ENTREPRISE (profil émetteur réutilisé dans devis/factures) ============
app.get("/api/profile", auth, (req, res) => res.json(getProfile(acc(req))));
app.post("/api/profile", auth, (req, res) => {
  try { setProfile(acc(req), req.body || {}); saveNow(); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ============ ABONNEMENT / FORMULES ============
app.get("/api/subscription", auth, (req, res) => res.json(getSubscription(acc(req))));
app.post("/api/subscription", auth, (req, res) => {
  try { const plan = setPlan(acc(req), req.body?.plan); saveNow(); res.json({ ok: true, plan }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ============ FACTURATION (protégé) ============
app.post("/api/preview", auth, (req, res) => {
  try { res.json(computeTotals(req.body as Invoice)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.post("/api/facturx.pdf", auth, async (req, res) => {
  try {
    const inv = req.body as Invoice;
    const { pdf } = await generateFacturX(inv);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="facture-${inv.invoiceNumber}.pdf"`);
    res.send(Buffer.from(pdf));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.post("/api/facturx.xml", auth, async (req, res) => {
  try { const { xml } = await generateFacturX(req.body as Invoice); res.type("application/xml").send(xml); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.post("/api/invoices", auth, async (req, res) => {
  try {
    const inv = req.body as Invoice;
    await generateFacturX(inv);
    upsert(acc(req), { invoice: inv, status: "sent", sentDate: new Date().toISOString().slice(0, 10), payments: [], dunning: { stage: "none", events: [] } });
    saveNow();
    res.json({ ok: true, invoiceNumber: inv.invoiceNumber });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
// Liste de toutes les factures émises (pour la page « Íés factures »)
app.get("/api/invoices/list", auth, (req, res) => {
  res.json(listRecords(acc(req)).map((r) => ({
    invoiceNumber: r.invoice.invoiceNumber,
    buyer: r.invoice.buyer.name,
    issueDate: r.invoice.issueDate,
    dueDate: r.invoice.dueDate ?? "",
    ttc: totalDue(r),
    outstanding: outstanding(r),
    status: r.status,
  })));
});
// Recherche d'entreprises (base publique recherche-entreprises.api.gouv.fr)
app.get("/api/company-search", auth, async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 3) return res.json([]);
    const url = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(q)}&per_page=6&page=1`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.json([]);
    const data: any = await r.json();
    const out = (data.results ?? []).map((c: any) => {
      const s = c.siege ?? {};
      const line1 = [s.numero_voie, s.type_voie, s.libelle_voie].filter(Boolean).join(" ").trim();
      return {
        name: c.nom_complet || c.nom_raison_sociale || "",
        siret: s.siret || "",
        vatId: frVatId(s.siret || ""),
        line1, postalCode: s.code_postal || "", city: s.libelle_commune || "",
      };
    }).filter((x: any) => x.name && x.city);
    res.json(out);
  } catch { res.json([]); }
});

// Répertoire des clients déjà utilisés (pour le remplissage automatique)
app.get("/api/clients", auth, (req, res) => {
  const a = acc(req);
  const map = new Map<string, any>();
  const add = (b: any) => {
    if (!b?.name) return;
    const key = b.name.trim().toLowerCase();
    if (key && !map.has(key)) {
      map.set(key, {
        name: b.name, line1: b.address?.line1 ?? "", postalCode: b.address?.postalCode ?? "",
        city: b.address?.city ?? "", siret: b.siret ?? "", vatId: b.vatId ?? "", email: b.email ?? "",
      });
    }
  };
  listRecords(a).forEach((r) => add(r.invoice.buyer));
  listQuotes(a).forEach((q) => add(q.invoice.buyer));
  res.json([...map.values()].sort((x, y) => x.name.localeCompare(y.name)));
});

// Re-télécharger le PDF Factur-X d'une facture enregistrée
app.get("/api/invoices/:num/pdf", auth, async (req, res) => {
  try {
    const r = getRecord(acc(req), req.params.num);
    if (!r) return res.status(404).json({ error: "Facture introuvable" });
    const { pdf } = await generateFacturX(r.invoice);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="facture-${r.invoice.invoiceNumber}.pdf"`);
    res.send(Buffer.from(pdf));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/api/transmit", auth, async (req, res) => {
  try {
    const inv = req.body as Invoice;
    const { pdf } = await generateFacturX(inv);
    const pa = new MockPlateformeAgreee();
    res.json({ platform: pa.name, ...(await pa.submit(inv, pdf)) });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ============ RELANCES (protégé) ============
const dunningTransport = new EmailTransport();
app.post("/api/dunning/seed", auth, (req, res) => { seedDemoInvoices(acc(req)); saveNow(); res.json({ ok: true, count: listRecords(acc(req)).length }); });
app.get("/api/dunning/list", auth, (req, res) => {
  const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : new Date();
  res.json(listRecords(acc(req)).map((r) => {
    const pen = computePenalties(r, asOf);
    return { invoiceNumber: r.invoice.invoiceNumber, buyer: r.invoice.buyer.name, status: r.status,
      dueDate: r.invoice.dueDate, totalDue: totalDue(r), outstanding: outstanding(r),
      daysLate: pen.daysLate, stage: r.dunning.stage, latePenalty: pen.latePenalty, totalClaim: pen.totalClaim, events: r.dunning.events.length };
  }));
});
app.post("/api/dunning/run", auth, async (req, res) => {
  const asOf = req.body?.asOf ? new Date(req.body.asOf) : new Date();
  const transport = new EmailTransport(sendCfg(acc(req)));
  const actions = await runDunning(acc(req), asOf, transport);
  saveNow();
  res.json({ actions, sent: transport.sent });
});
// Historique de toutes les relances envoyées (tous clients), suivi par l'artisan.
app.get("/api/dunning/history", auth, (req, res) => {
  const a = acc(req);
  const out: any[] = [];
  for (const r of listRecords(a)) {
    for (const e of r.dunning.events) {
      out.push({
        invoiceNumber: r.invoice.invoiceNumber,
        buyer: r.invoice.buyer.name,
        to: e.to,
        date: e.date,
        stage: e.stage,
        channel: e.channel,
        subject: e.subject ?? "",
        body: e.body,
        generatedBy: e.generatedBy,
      });
    }
  }
  out.sort((x, y) => String(y.date).localeCompare(String(x.date)));
  res.json(out);
});
app.post("/api/dunning/pay", auth, (req, res) => {
  try {
    const { invoiceNumber, amount, date } = req.body;
    const rec = recordPayment(acc(req), invoiceNumber, { amount: Number(amount), date: date ?? new Date().toISOString().slice(0, 10) });
    saveNow();
    res.json({ invoiceNumber, status: rec.status, outstanding: outstanding(rec) });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ============ PRISE DE RDV ============
app.get("/api/booking/services", (req, res) => res.json(listServices(publicAcc(req))));     // public
app.get("/api/booking/slots", (req, res) => {                                                // public
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date();
    res.json(generateSlots(publicAcc(req), String(req.query.serviceId), from, req.query.days ? Number(req.query.days) : 7));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.post("/api/booking/book", async (req, res) => {                                           // public (client)
  try {
    const accountId = publicAcc(req);
    const a = book(accountId, req.body);
    saveNow();
    // Synchronisation Google Agenda : si l'artisan a connecté son compte Google,
    // le RDV est ajouté automatiquement à son agenda (la connexion email couvre aussi l'agenda).
    const oauth = getGmailOAuth(accountId);
    if (oauth?.refreshToken && googleConfigured()) {
      try {
        const svc = getService(accountId, a.serviceId);
        const ev = await createCalendarEvent(oauth.refreshToken, {
          summary: `RDV ${svc?.name ?? ""} — ${a.customer.name}`.trim(),
          description: `Client : ${a.customer.name}`
            + (a.customer.phone ? `\nTél : ${a.customer.phone}` : "")
            + (a.customer.email ? `\nEmail : ${a.customer.email}` : "")
            + `\nPris via le portail Artéo.`,
          startIso: a.start, endIso: a.end,
          attendeeEmail: a.customer.email,
        });
        (a as any).calendarLink = ev.htmlLink;
      } catch (e) { console.error("Google Agenda :", (e as Error).message); }
    }
    res.json(a);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.get("/api/booking/appointments", auth, (req, res) => res.json(listAppointments(acc(req))));
app.post("/api/booking/complete", auth, (req, res) => {
  try { const a = updateAppointmentStatus(acc(req), req.body.id, "completed"); saveNow(); res.json(a); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ============ RÉCEPTIONNISTE IA (webhook public) ============
app.post("/api/receptionist/start", (req, res) => {
  const id = req.body?.callId ?? `CALL-${Date.now()}`;
  res.json({ callId: id, ...startCall(publicAcc(req), id) });
});
app.post("/api/receptionist/turn", async (req, res) => {
  try { const r = await handleTurn(publicAcc(req), req.body.callId, req.body.utterance); saveNow(); res.json(r); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ============ AVIS GOOGLE (protégé) ============
app.post("/api/reviews/run", auth, async (req, res) => {
  const actions = await runReviewRequests(acc(req), new Date(), dunningTransport);
  saveNow();
  res.json({ actions, requests: listReviewRequests(acc(req)) });
});
app.get("/api/reviews/list", auth, (req, res) => res.json(listReviewRequests(acc(req))));

// ============ DEVIS (workflow devis -> facture) ============
app.post("/api/quotes", auth, (req, res) => {
  try { const q = saveQuote(acc(req), req.body as Invoice); saveNow(); res.json({ id: q.id, status: q.status }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.get("/api/quotes", auth, (req, res) => {
  res.json(listQuotes(acc(req)).map((q) => ({
    id: q.id, client: q.invoice.buyer.name, date: q.invoice.issueDate,
    ttc: quoteTotal(q), status: q.status, convertedInvoiceNumber: q.convertedInvoiceNumber,
  })));
});
app.post("/api/quotes/pdf", auth, async (req, res) => {
  try {
    const inv = { ...(req.body as Invoice), docType: "devis" as const };
    const { pdf } = await generateFacturX(inv);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="devis-${inv.invoiceNumber || "brouillon"}.pdf"`);
    res.send(Buffer.from(pdf));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.get("/api/quotes/:id/pdf", auth, async (req, res) => {
  try {
    const q = getQuote(acc(req), req.params.id);
    if (!q) return res.status(404).json({ error: "Devis introuvable" });
    const { pdf } = await generateFacturX(q.invoice);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="devis-${q.id}.pdf"`);
    res.send(Buffer.from(pdf));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.post("/api/quotes/:id/accept", auth, (req, res) => {
  try { const q = setStatus(acc(req), req.params.id, "accepté"); saveNow(); res.json({ id: q.id, status: q.status }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.post("/api/quotes/:id/convert", auth, (req, res) => {
  try {
    const a = acc(req);
    const q = getQuote(a, req.params.id);
    if (!q) return res.status(404).json({ error: "Devis introuvable" });
    const invoiceNumber = `2026-${String(listRecords(a).length + 1).padStart(4, "0")}`;
    const inv = toInvoice(q, invoiceNumber);
    upsert(a, { invoice: inv, status: "sent", sentDate: new Date().toISOString().slice(0, 10), payments: [], dunning: { stage: "none", events: [] } });
    markConverted(a, q.id, invoiceNumber);
    saveNow();
    res.json({ invoiceNumber });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ============ RÉGLAGES EMAIL (SMTP par compte, ex. Gmail) ============
app.get("/app/settings", authPage, page("settings.html"));

app.get("/api/settings/email", auth, (req, res) => {
  const s = getSmtp(acc(req));
  const oauth = getGmailOAuth(acc(req));
  res.json({
    configured: emailConfigured(sendCfg(acc(req))),
    host: s?.host ?? "", port: s?.port ?? 587, user: s?.user ?? "", from: s?.from ?? "",
    google: { available: googleConfigured(), connected: !!oauth, email: oauth?.email ?? "" },
  });
});

// ---- « Se connecter avec Google » (OAuth) ----
app.get("/api/oauth/google/start", authPage, (req, res) => {
  if (!googleConfigured()) return res.status(400).send("Connexion Google non configurée par l'administrateur (variables GOOGLE_*).");
  res.redirect(authUrl(acc(req)));
});
app.get("/api/oauth/google/callback", async (req, res) => {
  try {
    const accountId = String(req.query.state ?? "");
    const code = String(req.query.code ?? "");
    if (!accountId || !code) return res.status(400).send("Paramètres OAuth manquants.");
    const { refreshToken, accessToken } = await exchangeCode(code);
    const email = await userEmail(accessToken);
    if (!refreshToken) return res.status(400).send("Google n'a pas renvoy�é de refresh_token. Réessayez en révoquant l'accès puis en réapprouvant.");
    setGmailOAuth(accountId, { email, refreshToken });
    saveNow();
    res.redirect("/app/settings");
  } catch (e: any) {
    res.status(400).send("Échec de la connexion Google : " + e.message);
  }
});
app.post("/api/oauth/google/disconnect", auth, (req, res) => { setGmailOAuth(acc(req), undefined); saveNow(); res.json({ ok: true }); });
app.post("/api/settings/email", auth, (req, res) => {
  try {
    const { host, port, user, pass, from } = req.body;
    if (!host || !user || !pass) return res.status(400).json({ error: "Serveur, identifiant et mot de passe requis." });
    setSmtp(acc(req), { host, port: Number(port) || 587, user, pass, from: from || user });
    saveNow();
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.post("/api/settings/email/test", auth, async (req, res) => {
  const s = getSmtp(acc(req));
  if (!s) return res.status(400).json({ error: "Aucun réglage email enregistré." });
  res.json(await verifySmtp(s));
});
app.post("/api/settings/email/clear", auth, (req, res) => { setSmtp(acc(req), undefined); saveNow(); res.json({ ok: true }); });

// ============ ENVOI PAR EMAIL ============
app.get("/api/email/status", auth, (req, res) => res.json({ configured: emailConfigured(sendCfg(acc(req))) }));

app.post("/api/invoices/send", auth, async (req, res) => {
  try {
    const inv = req.body as Invoice;
    if (!inv.buyer?.email) return res.status(400).json({ error: "Le client n'a pas d'adresse email." });
    const cfg = sendCfg(acc(req));
    const { pdf } = await generateFacturX(inv);
    await sendEmail({
      to: inv.buyer.email,
      subject: `Facture ${inv.invoiceNumber} — ${inv.seller.name}`,
      text: `Bonjour,\n\nVeuillez trouver ci-joint la facture ${inv.invoiceNumber}.\n\nCordialement,\n${inv.seller.name}`,
      attachments: [{ filename: `facture-${inv.invoiceNumber}.pdf`, content: pdf, contentType: "application/pdf" }],
    }, cfg);
    res.json({ ok: true, simulated: !emailConfigured(cfg) });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/api/quotes/:id/send", auth, async (req, res) => {
  try {
    const q = getQuote(acc(req), req.params.id);
    if (!q) return res.status(404).json({ error: "Devis introuvable" });
    if (!q.invoice.buyer?.email) return res.status(400).json({ error: "Le client n'a pas d'adresse email." });
    const cfg = sendCfg(acc(req));
    const { pdf } = await generateFacturX(q.invoice);
    await sendEmail({
      to: q.invoice.buyer.email,
      subject: `Devis ${q.id} — ${q.invoice.seller.name}`,
      text: `Bonjour,\n\nVeuillez trouver ci-joint notre devis ${q.id}, valable jusqu'au ${q.invoice.validity ?? ""}.\n\nCordialement,\n${q.invoice.seller.name}`,
      attachments: [{ filename: `devis-${q.id}.pdf`, content: pdf, contentType: "application/pdf" }],
    }, cfg);
    res.json({ ok: true, simulated: !emailConfigured(cfg) });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ============ RELANCES AUTOMATIQUES (planificateur) ============
// Parcourt tous les comptes et déclenche les relances dues (J+7 / J+15 / J+30) par email.
async function runAllDunning() {
  for (const a of listAccountIds()) {
    try { await runDunning(a, new Date(), new EmailTransport(sendCfg(a))); } catch (e) { console.error("Relance auto", a, (e as Error).message); }
  }
  saveNow();
}
app.post("/api/dunning/run-all", auth, async (_req, res) => {
  await runAllDunning();
  res.json({ ok: true, emails: emailConfigured() ? "envoyés" : "simulés (configurez SMTP_*)" });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const server = app.listen(PORT, () => {
  console.log(`efacture en ligne : http://localhost:${PORT}`);
  if (countAccounts() === 0) console.log("Aucun compte : créez-en un sur /signup");
  console.log(emailConfigured() ? "Email : SMTP configuré." : "Email : mode simulé (configurez SMTP_* pour envoyer réellement).");
  // Relances automatiques : une passe peu après le démarrage, puis toutes les 24 h.
  setTimeout(() => { runAllDunning().catch(() => {}); }, 10_000).unref();
  setInterval(() => { runAllDunning().catch(() => {}); }, 24 * 60 * 60 * 1000).unref();
});

function shutdown() {
  try { saveNow(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
