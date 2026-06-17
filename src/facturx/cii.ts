import { create } from "xmlbuilder2";
import type { Invoice, Party } from "../types.js";
import { computeTotals, isVatFranchise } from "../compute.js";

// Génère le XML Factur-X au format UN/CEFACT Cross Industry Invoice (CII),
// profil EN 16931 — celui exigé par la réforme française de la facture électronique.

const NS = {
  rsm: "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
  ram: "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100",
  qdt: "urn:un:unece:uncefact:data:standard:QualifiedDataType:100",
  udt: "urn:un:unece:uncefact:data:standard:UnQualifiedDataType:100",
};

const d = (iso: string) => iso.replace(/-/g, ""); // "2026-09-15" -> "20260915"
const amt = (n: number) => n.toFixed(2);

function tradeParty(p: Party) {
  const node: any = { "ram:Name": p.name };
  if (p.siret) {
    node["ram:SpecifiedLegalOrganization"] = {
      "ram:ID": { "@schemeID": "0002", "#": p.siret },
    };
  }
  node["ram:PostalTradeAddress"] = {
    "ram:PostcodeCode": p.address.postalCode,
    "ram:LineOne": p.address.line1,
    "ram:CityName": p.address.city,
    "ram:CountryID": p.address.countryCode,
  };
  if (p.email) {
    node["ram:URIUniversalCommunication"] = {
      "ram:URIID": { "@schemeID": "EM", "#": p.email },
    };
  }
  if (p.vatId) {
    node["ram:SpecifiedTaxRegistration"] = {
      "ram:ID": { "@schemeID": "VA", "#": p.vatId },
    };
  }
  return node;
}

export function buildFacturXXml(invoice: Invoice): string {
  const currency = invoice.currency ?? "EUR";
  const typeCode = invoice.typeCode ?? "380";
  const t = computeTotals(invoice);
  const franchise = isVatFranchise(invoice);

  const lines = invoice.lines.map((l, i) => {
    const id = l.id ?? String(i + 1);
    const net = t.lineTotals[i].net;
    return {
      "ram:AssociatedDocumentLineDocument": { "ram:LineID": id },
      "ram:SpecifiedTradeProduct": { "ram:Name": l.description },
      "ram:SpecifiedLineTradeAgreement": {
        "ram:NetPriceProductTradePrice": {
          "ram:ChargeAmount": amt(l.unitPrice),
        },
      },
      "ram:SpecifiedLineTradeDelivery": {
        "ram:BilledQuantity": {
          "@unitCode": l.unit ?? "C62",
          "#": String(l.quantity),
        },
      },
      "ram:SpecifiedLineTradeSettlement": {
        "ram:ApplicableTradeTax": {
          "ram:TypeCode": "VAT",
          "ram:CategoryCode": franchise ? "E" : l.vatRate > 0 ? "S" : "Z",
          "ram:RateApplicablePercent": franchise ? "0" : String(l.vatRate),
        },
        "ram:SpecifiedTradeSettlementLineMonetarySummation": {
          "ram:LineTotalAmount": amt(net),
        },
      },
    };
  });

  const headerTax = t.vatBreakdown.map((v) => ({
    "ram:CalculatedAmount": amt(v.tax),
    "ram:TypeCode": "VAT",
    ...(v.category === "E"
      ? { "ram:ExemptionReason": "Franchise en base de TVA, art. 293 B du CGI" }
      : {}),
    "ram:BasisAmount": amt(v.base),
    "ram:CategoryCode": v.category,
    "ram:RateApplicablePercent": String(v.rate),
  }));

  // Remise globale au niveau document (allowance)
  const allowance =
    t.discountAmount > 0
      ? {
          "ram:SpecifiedTradeAllowanceCharge": {
            "ram:ChargeIndicator": { "ram:Indicator": "false" },
            "ram:ActualAmount": amt(t.discountAmount),
            "ram:Reason": "Remise commerciale",
            "ram:CategoryTradeTax": {
              "ram:TypeCode": "VAT",
              "ram:CategoryCode": t.vatBreakdown[0]?.category ?? "S",
              "ram:RateApplicablePercent": String(t.vatBreakdown[0]?.rate ?? 0),
            },
          },
        }
      : {};

  const doc: any = {
    "rsm:CrossIndustryInvoice": {
      "@xmlns:rsm": NS.rsm,
      "@xmlns:ram": NS.ram,
      "@xmlns:qdt": NS.qdt,
      "@xmlns:udt": NS.udt,
      "rsm:ExchangedDocumentContext": {
        "ram:GuidelineSpecifiedDocumentContextParameter": {
          "ram:ID": "urn:cen.eu:en16931:2017",
        },
      },
      "rsm:ExchangedDocument": {
        "ram:ID": invoice.invoiceNumber,
        "ram:TypeCode": typeCode,
        "ram:IssueDateTime": {
          "udt:DateTimeString": { "@format": "102", "#": d(invoice.issueDate) },
        },
        ...(invoice.note
          ? { "ram:IncludedNote": { "ram:Content": invoice.note } }
          : {}),
      },
      "rsm:SupplyChainTradeTransaction": {
        "ram:IncludedSupplyChainTradeLineItem": lines,
        "ram:ApplicableHeaderTradeAgreement": {
          "ram:SellerTradeParty": tradeParty(invoice.seller),
          "ram:BuyerTradeParty": tradeParty(invoice.buyer),
        },
        "ram:ApplicableHeaderTradeDelivery": {},
        "ram:ApplicableHeaderTradeSettlement": {
          "ram:InvoiceCurrencyCode": currency,
          "ram:ApplicableTradeTax": headerTax,
          ...allowance,
          ...(invoice.dueDate || invoice.paymentTerms
            ? {
                "ram:SpecifiedTradePaymentTerms": {
                  ...(invoice.paymentTerms
                    ? { "ram:Description": invoice.paymentTerms }
                    : {}),
                  ...(invoice.dueDate
                    ? {
                        "ram:DueDateDateTime": {
                          "udt:DateTimeString": {
                            "@format": "102",
                            "#": d(invoice.dueDate),
                          },
                        },
                      }
                    : {}),
                },
              }
            : {}),
          "ram:SpecifiedTradeSettlementHeaderMonetarySummation": {
            "ram:LineTotalAmount": amt(t.lineNet),
            ...(t.discountAmount > 0
              ? { "ram:AllowanceTotalAmount": amt(t.discountAmount) }
              : {}),
            "ram:TaxBasisTotalAmount": amt(t.totalNet),
            "ram:TaxTotalAmount": { "@currencyID": currency, "#": amt(t.totalVat) },
            "ram:GrandTotalAmount": amt(t.totalGross),
            "ram:DuePayableAmount": amt(t.amountDue),
          },
        },
      },
    },
  };

  return create({ version: "1.0", encoding: "UTF-8" }, doc).end({ prettyPrint: true });
}
