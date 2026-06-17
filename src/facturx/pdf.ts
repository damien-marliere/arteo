import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Invoice } from "../types.js";
import { computeTotals, isVatFranchise } from "../compute.js";

// Mentions légales adaptées au métier (sans accents pour Helvetica/WinAnsi).
function professionMentions(inv: Invoice): string[] {
  const s = inv.seller;
  const out: string[] = [];
  switch (inv.profession) {
    case "batiment":
      out.push(s.insurance ? `Assurance decennale : ${s.insurance}.` : "Assurance decennale obligatoire (a renseigner).");
      if (s.rge) out.push(`Qualification RGE / Qualibat : ${s.rge}.`);
      out.push("TVA a taux reduit selon la nature des travaux (10% renovation, 5,5% renovation energetique).");
      break;
    case "micro":
      out.push(isVatFranchise(inv)
        ? "TVA non applicable, art. 293 B du CGI."
        : "Assujetti a la TVA suite au depassement des seuils de la franchise en base (art. 293 B du CGI).");
      break;
    case "liberal":
      out.push("Membre d'une association de gestion agreee ; reglement par cheque ou virement accepte.");
      break;
    case "immobilier":
      out.push("Carte professionnelle (loi Hoguet) delivree par la CCI. Garantie financiere et RC pro souscrites.");
      break;
    default:
      if (s.insurance) out.push(`Assurance professionnelle : ${s.insurance}.`);
  }
  return out;
}

// Valeur de l'enum AFRelationship de Factur-X (le PDF référence le fichier joint
// comme "Alternative" = représentation alternative du même document).
const AF_ALTERNATIVE = "Alternative" as any;

// Helvetica (WinAnsi) ne sait pas encoder les espaces insécables fins (U+202F/U+00A0)
// que produit Intl pour le format monétaire : \s les normalise en espace simple.
const EUR = (n: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" })
    .format(n)
    .replace(/\s/g, " ");

// Génère le PDF lisible de la facture ET y embarque le XML Factur-X.
// Le fichier joint est nommé "factur-x.xml" avec AFRelationship "Alternative",
// conformément au standard Factur-X (PDF hybride lisible + données structurées).
export async function buildFacturXPdf(
  invoice: Invoice,
  xml: string,
  embedXml = true
): Promise<Uint8Array> {
  const t = computeTotals(invoice);
  const franchise = isVatFranchise(invoice);
  const isDevis = invoice.docType === "devis";
  const title = isDevis ? "DEVIS" : "FACTURE";
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${title} ${invoice.invoiceNumber}`);
  pdf.setProducer("efacture — generateur Factur-X");
  pdf.setCreator("efacture");

  const page = pdf.addPage([595.28, 841.89]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const { width } = page.getSize();
  const M = 50;
  let y = 800;
  const ink = rgb(0.1, 0.1, 0.12);
  const grey = rgb(0.45, 0.45, 0.5);

  const text = (s: string, x: number, yy: number, f = font, size = 10, c = ink) =>
    page.drawText(s, { x, y: yy, size, font: f, color: c });

  // Logo de l'émetteur (optionnel) : on l'embarque en haut à gauche et on
  // décale l'en-tête vers le bas si présent.
  if (invoice.logo) {
    try {
      const m = invoice.logo.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
      if (m) {
        const bytes = Uint8Array.from(Buffer.from(m[2], "base64"));
        const img = /png/i.test(m[1]) ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
        const h = 48;
        const scale = h / img.height;
        const w = Math.min(img.width * scale, 200);
        page.drawImage(img, { x: M, y: y - h + 12, width: w, height: h });
        y -= h + 8;
      }
    } catch { /* logo invalide : on ignore et on continue */ }
  }

  // En-tête
  text(title, M, y, bold, 22);
  text(`N° ${invoice.invoiceNumber}`, width - M - 160, y + 6, bold, 12);
  text(`Date : ${invoice.issueDate}`, width - M - 160, y - 8, font, 9, grey);
  if (isDevis && invoice.validity)
    text(`Valable jusqu'au : ${invoice.validity}`, width - M - 160, y - 20, font, 9, grey);
  else if (invoice.dueDate)
    text(`Echeance : ${invoice.dueDate}`, width - M - 160, y - 20, font, 9, grey);
  y -= 50;

  // Vendeur / Acheteur
  const block = (title: string, p: Invoice["seller"], x: number) => {
    let yy = y;
    const line = (s: string, f = font, size = 8, c = grey) => { text(s, x, yy, f, size, c); yy -= size + 3; };
    text(title, x, yy, bold, 9, grey); yy -= 14;
    line(p.name, bold, 10, ink);
    line(p.address.line1, font, 9, ink);
    line(`${p.address.postalCode} ${p.address.city}`, font, 9, ink);
    if (p.siret) line(`SIRET : ${p.siret}${p.rcs ? " - " + p.rcs : ""}`);
    if (p.vatId) line(`TVA : ${p.vatId}`);
    const contact = [p.phone ? "Tel : " + p.phone : "", p.email ?? "", p.website ?? ""].filter(Boolean).join("  -  ");
    if (contact) line(contact);
  };
  block("EMETTEUR", invoice.seller, M);
  block("CLIENT", invoice.buyer, width / 2 + 10);
  y -= 130;

  // Tableau lignes
  const cols = { desc: M, qty: 320, pu: 380, tva: 450, total: 500 };
  text("Designation", cols.desc, y, bold, 9);
  text("Qte", cols.qty, y, bold, 9);
  text("PU HT", cols.pu, y, bold, 9);
  text("TVA", cols.tva, y, bold, 9);
  text("Total HT", cols.total, y, bold, 9);
  y -= 6;
  page.drawLine({
    start: { x: M, y },
    end: { x: width - M, y },
    color: grey,
    thickness: 0.5,
  });
  y -= 16;

  invoice.lines.forEach((l, i) => {
    text(l.description.slice(0, 48), cols.desc, y, font, 9);
    text(String(l.quantity), cols.qty, y, font, 9);
    text(EUR(l.unitPrice), cols.pu, y, font, 9);
    text(franchise ? "-" : `${l.vatRate}%`, cols.tva, y, font, 9);
    text(EUR(t.lineTotals[i].net), cols.total, y, font, 9);
    y -= 16;
  });

  y -= 10;
  page.drawLine({
    start: { x: 320, y },
    end: { x: width - M, y },
    color: grey,
    thickness: 0.5,
  });
  y -= 18;

  // Totaux
  const totalLine = (label: string, value: string, b = false) => {
    text(label, 380, y, b ? bold : font, 10);
    text(value, cols.total, y, b ? bold : font, 10);
    y -= 16;
  };
  if (t.discountAmount > 0) {
    totalLine("Total HT brut", EUR(t.lineNet));
    totalLine("Remise", "- " + EUR(t.discountAmount));
    totalLine("Total HT net", EUR(t.totalNet));
  } else {
    totalLine("Total HT", EUR(t.totalNet));
  }
  if (franchise) totalLine("TVA", "non applicable");
  else t.vatBreakdown.forEach((v) => totalLine(`TVA ${v.rate}%`, EUR(v.tax)));
  totalLine("Total TTC", EUR(t.totalGross), true);
  y -= 4;
  totalLine(isDevis ? "Total a regler" : "Net a payer", EUR(t.amountDue), true);

  // Échéancier d'acomptes
  if (invoice.schedule && invoice.schedule.length > 1) {
    y -= 16;
    text(isDevis ? "Echeancier previsionnel" : "Echeancier de paiement", M, y, bold, 9, ink);
    y -= 14;
    for (const s of invoice.schedule) {
      const montant = Math.round((t.totalGross * s.pct) / 100 * 100) / 100;
      text(`${s.label}`, M, y, font, 9);
      text(`${s.pct}%`, 380, y, font, 9);
      text(EUR(montant), cols.total, y, font, 9);
      y -= 14;
    }
  }

  // Coordonnées bancaires (règlement par virement)
  if (invoice.seller.iban || invoice.seller.bic) {
    y -= 22;
    const pay = [
      invoice.seller.iban ? "IBAN : " + invoice.seller.iban : "",
      invoice.seller.bic ? "BIC : " + invoice.seller.bic : "",
    ].filter(Boolean).join("   -   ");
    text("Reglement par virement bancaire", M, y, bold, 8, ink);
    y -= 11;
    text(pay.replace(/\s+/g, " "), M, y, font, 8, grey);
  }

  // Pied de page : conditions, pénalités (factures), mentions métier, devis
  y -= 16;
  if (invoice.paymentTerms) {
    text(invoice.paymentTerms.replace(/\s/g, " "), M, y, font, 8, grey);
    y -= 11;
  }
  if (!isDevis) {
    text("En cas de retard de paiement : penalites au taux de 3x le taux d'interet legal et", M, y, font, 7, grey);
    y -= 9;
    text("indemnite forfaitaire de 40 EUR pour frais de recouvrement (art. L441-10 et D441-5 C. com.).", M, y, font, 7, grey);
    y -= 11;
  }
  for (const m of professionMentions(invoice)) {
    text(m.slice(0, 112), M, y, font, 7, grey);
    y -= 9;
  }
  if (isDevis) {
    y -= 10;
    text(`Devis gratuit, valable jusqu'au ${invoice.validity ?? ""}.`, M, y, font, 8, ink);
    y -= 12;
    text("Bon pour accord (date et signature du client) :", M, y, font, 8, ink);
  }
  text(
    isDevis
      ? "Document genere par Arteo (efacture)."
      : "Facture electronique conforme - Factur-X (EN 16931) - XML structure embarque.",
    M, 40, font, 7, grey
  );

  // --- Embarquement du XML Factur-X (factures uniquement) ---
  if (embedXml && !isDevis) {
    await pdf.attach(new TextEncoder().encode(xml), "factur-x.xml", {
      mimeType: "application/xml",
      description: "Facture electronique Factur-X (CII EN16931)",
      creationDate: new Date(),
      modificationDate: new Date(),
      afRelationship: AF_ALTERNATIVE,
    });
  }

  return pdf.save();
}
