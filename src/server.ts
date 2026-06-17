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
import { book, generateSlots, listServices, listAppointments, updateAppointmentStatus } from "./booking/index.js";
import { startCall, handleTurn } from "./receptionist/index.js";
import { runReviewRequests, listReviewRequests, setReviewConfig } from "./reviews/index.js";
import { saveQuote, listQuotes, getQuote, setStatus, quoteTotal, toInvoice, markConverted } from "./quotes/index.js";
import { signup, login, logout, requireAuth, accountFromToken, countAccounts, firstAccountId, listAccountIds, getSmtp, setSmtp, getGmailOAuth, setGmailOAuth } from "./auth/index.js";
import { googleConfigured, authUrl, exchangeCode, userEmail } from "./oauth/google.js";
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

const page = (file: string) => async (_req: express.Request, res: express.Response) =>
  res.type("html").send(await readFile(join(__dirname, "..", "public", file), "utf8"));

const auth = requireAuth();          // API : 401 si non connecté
const authPage = requireAuth(true);  // Pages : redirige vers /login

// Compte courant (routes admin protégées)
const acc = (req: express.Request) => (req as any).account.id as string;
// Compte ciblé par une route publique (client) : ?account=… ou repli mono-artisan
const publicAcc = (req: express.Request) =>
  String(req.query.account ?? req.body?.accountId ?? firstAccountId() ?? "demo");
// Config d'envoi email d'un compte : Google OAuth ou SMTP (mot de passe d'application).
const sendCfg = (accountId: string) => ({ smtp: getSmtp(accountId), gmailOAuth: getGmailOAuth(accountId) });

// ============ AUTHENTIFICATION (public) ============
app.get("/login", page("login.html"));
app.get("/signup", page("login.html"));

app.post("/api/auth/signup", (req, res) => {
  try {
    const { email, password, businessName } = req.body;
    const account = signup(email, password, businessName);
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

// ============ PAGES CLIENT (publiques) ============
app.get("/book", page("book.html"));
app.get("/receptionist", page("receptionist.html"));

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
// Liste de toutes les factures émises (pour la page « Mes factures »)
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
app.post("/api/booking/book", (req, res) => {                                                 // public (client)
  try { const a = book(publicAcc(req), req.body); saveNow(); res.json(a); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
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
    if (!refreshToken) return res.status(400).send("Google n'a pas renvoyé de refresh_token. Réessayez en révoquant l'accès puis en réapprouvant.");
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
