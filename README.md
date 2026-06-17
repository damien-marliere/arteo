# Artéo — SaaS artisan (le "ServiceTitan français")

> Nom de marque : **Artéo**. Nom de code technique du projet : `efacture`.

Plateforme tout-en-un pour artisans, IA-native, prête pour la réforme de la facture
électronique 2026-2027. Comprend un **site vitrine marketing** public et une **application**
complète (multi-tenant, authentifiée). Cinq modules construits et testés :

1. **Facturation électronique** (Factur-X / EN 16931)
2. **Relance d'impayés** par agent IA
3. **Portail de prise de RDV** en ligne (self-service client)
4. **Réceptionniste IA téléphonique** (qualifie et prend les RDV 24/7)
5. **Avis Google automatiques** après chantier

## Premier lancement

```bash
npm install
npm run dev          # http://localhost:3000
```

Aller sur `/signup` pour créer un compte, puis on arrive sur le tableau de bord.

## Pages

| URL | Accès | Rôle |
|-----|-------|------|
| `/` | public | **Site vitrine** marketing (hero, modules, tarifs, FAQ) |
| `/signup` `/login` | public | Création de compte / connexion |
| `/app` | connecté | Tableau de bord (KPIs + navigation sidebar) |
| `/app/invoices` | connecté | Créer / émettre une facture Factur-X |
| `/app/dunning` | connecté | Relances impayés |
| `/book` | public | Portail de prise de RDV (côté client) |
| `/receptionist` | public | Simulation d'appel au réceptionniste IA |

Le design est unifié via une feuille de style partagée (`public/assets/app.css`,
servie sur `/assets`). Le site vitrine et l'app partagent la même identité visuelle (marque Artéo).

## Comptes, sessions & persistance

- **Authentification** (`src/auth/`) : comptes email + mot de passe (hash bcrypt),
  sessions par cookie `httpOnly`, middleware protégeant les routes admin. Les routes
  client (`/book`, réceptionniste) restent publiques.
- **Persistance** (`src/persistence.ts`) : tout l'état (comptes, factures, RDV, avis)
  est sauvegardé dans `data/db.json` (écriture atomique), rechargé au démarrage,
  et flush à l'arrêt (SIGTERM/SIGINT). Interface isolée par module (`dump*`/`restore*`)
  → remplaçable par Postgres sans toucher au reste du code.

## Intelligence artificielle (LLM)

Couche client unifiée (`src/llm/`) multi-fournisseur, branchée sur le réceptionniste
et les relances. Sélection par variable d'environnement, **repli déterministe** propre
si aucune IA n'est configurée (l'app marche toujours sans clé).

| `LLM_PROVIDER` | Effet |
|----------------|-------|
| _(vide)_ | IA désactivée → logique déterministe |
| `mock` | Réponses simulées, sans clé (démo / tests) |
| `openai` | OpenAI et compatibles (Azure, Mistral, Groq, OpenRouter…) |
| `anthropic` | Claude |

```bash
npm run llm                         # démo en repli déterministe
LLM_PROVIDER=mock npm run llm       # démo : chemin IA emprunté (sans clé)
LLM_PROVIDER=openai OPENAI_API_KEY=sk-... npm run dev   # IA réelle
```

État visible sur le tableau de bord (badge « IA ») et via `GET /api/llm/status`.

## Déploiement (Docker)

```bash
docker build -t efacture .
docker run -p 3000:3000 -v efacture-data:/data efacture
```

Le volume `/data` conserve la base entre les redémarrages. Variables dans `.env.example`
(port, clé LLM optionnelle, intégrations téléphonie / Plateforme Agréée / Google).

## Démos console

```bash
npm run sample     # facture Factur-X -> out/
npm run dunning    # moteur de relance d'impayés
npm run services   # portail RDV + réceptionniste IA + avis Google
```

---

## 1. Facturation électronique (Factur-X)

Génère des **factures conformes EN 16931 / Factur-X** (PDF lisible avec XML structuré
CII embarqué), comme l'exige la réforme française 2026-2027.

## Ce que ça fait

- Calcul des totaux (HT, TVA par taux, TTC, net à payer)
- Génération du **XML CII** au profil **EN 16931** (`urn:cen.eu:en16931:2017`)
- Génération d'un **PDF de facture** lisible avec le `factur-x.xml` **embarqué** (PDF hybride)
- API REST + petite **interface web** de saisie
- Point d'accroche **Plateforme Agréée** (à brancher sur une vraie PA DGFiP)

## Démarrer

```bash
npm install
npm run dev          # serveur : http://localhost:3000 (facture) + /dunning (relances)
# ou
npm run sample       # génère un exemple Factur-X dans out/ (PDF + XML)
npm run dunning      # démo du moteur de relance d'impayés (console)
```

## Module relance d'impayés (agent IA)

Branché sur le module facturation : détecte les retards, rédige des relances
graduées, calcule les pénalités légales françaises et s'arrête au paiement.

- **Séquence d'escalade** (`dunning/policy.ts`) : rappel pré-échéance (J-3),
  1re relance (J+1), 2e relance ferme (J+8), 3e avec pénalités (J+15),
  mise en demeure (J+30).
- **Pénalités légales** (`dunning/penalties.ts`) : pénalités de retard
  (taux annuel configurable, par défaut ~BCE+10 pts) + indemnité forfaitaire
  de recouvrement de 40 € (art. L441-10 du Code de commerce).
- **Agent IA** (`dunning/ai.ts`) : génère le message selon l'étape et le ton.
  Fonctionne hors-ligne avec un générateur déterministe professionnel ;
  bascule automatiquement sur un LLM si `OPENAI_API_KEY` est défini.
- **Moteur** (`dunning/engine.ts`) : parcourt le portefeuille, déclenche au plus
  une relance par facture et par passage, journalise, arrête tout au paiement.
- **Transport** (`dunning/transport.ts`) : `ConsoleTransport` en dev ; stubs
  email/SMS (Twilio…) à brancher en production.
- **Tableau de bord** : `http://localhost:3000/dunning`.

### API relances

| Méthode | Route | Rôle |
|---------|-------|------|
| POST | `/api/dunning/seed` | charge un jeu de démonstration |
| GET  | `/api/dunning/list` | état du portefeuille (retards, étapes, montants) |
| POST | `/api/dunning/run` | exécute le moteur, renvoie les relances |
| POST | `/api/dunning/pay` | enregistre un paiement (arrête la relance) |

### Pour rivaliser avec ServiceTitan

Brancher : un vrai LLM (clé API), un transport email + SMS réel, une exécution
planifiée quotidienne (cron), et la persistance Postgres. La logique métier
(séquence, pénalités, arrêt au paiement, ton escaladé) est déjà là.

## Structure

```
src/
  types.ts            modèle Invoice / Party / lignes
  compute.ts          calcul des totaux + ventilation TVA
  facturx/
    cii.ts            génère le XML CII EN 16931
    pdf.ts            génère le PDF + embarque le XML
    index.ts          generateFacturX() + interface PlateformeAgreee
  server.ts           API Express + UI
  sample.ts           génération d'une facture de démonstration
public/index.html     formulaire de saisie
```

## API

| Méthode | Route | Rôle |
|---------|-------|------|
| POST | `/api/preview` | renvoie les totaux (HT/TVA/TTC) |
| POST | `/api/facturx.pdf` | télécharge le PDF Factur-X (XML embarqué) |
| POST | `/api/facturx.xml` | renvoie le XML CII brut |
| POST | `/api/transmit` | simule la transmission à une Plateforme Agréée |

## Vérifications faites

- XML bien formé et conforme au profil EN 16931 (testé)
- Totaux exacts (ex. HT 1190 € / TVA 131 € / TTC 1321 €)
- `factur-x.xml` réellement embarqué dans le PDF (vérifié via pypdf)
- API et UI fonctionnelles

## 3. Portail de prise de RDV (`src/booking/`)

Réservation en ligne 24/7 côté client. Services configurables, horaires d'ouverture,
**génération de créneaux libres** (anti-chevauchement avec les RDV existants),
réservation avec contrôle de disponibilité. Page publique : `/book`.
API : `/api/booking/services`, `/api/booking/slots`, `/api/booking/book`,
`/api/booking/appointments`, `/api/booking/complete`.

## 4. Réceptionniste IA téléphonique (`src/receptionist/`)

Tient une conversation, **qualifie la demande** (type d'intervention, urgence),
collecte nom + téléphone, **propose un créneau et prend le RDV** automatiquement.
- `nlu.ts` : compréhension (classification service, urgence, extraction nom/téléphone)
  par heuristiques hors-ligne + hook LLM optionnel (`OPENAI_API_KEY`).
- `index.ts` : machine à états de la conversation, branchée sur le module RDV.
- Conçu pour la téléphonie : chaque tour = un énoncé transcrit, la réponse = texte à
  vocaliser. API webhook : `/api/receptionist/start`, `/api/receptionist/turn`.
- Démo interactive : `/receptionist`.

**Pour la prod** : brancher Twilio Voice + un moteur speech-to-text et text-to-speech ;
la logique de qualification et de prise de RDV est déjà là.

## 5. Avis Google automatiques (`src/reviews/`)

Après un chantier marqué *terminé* (+ délai configurable), envoie automatiquement une
demande d'avis (SMS ou email) avec le lien Google, **anti-doublon**, avec suivi du statut.
API : `/api/reviews/run`, `/api/reviews/list`.
**Pour la prod** : renseigner le `googlePlaceId` de la fiche, brancher le transport SMS réel.

## Limites connues / prochaines étapes

1. **PDF/A-3 strict** : le XML est embarqué avec la bonne relation (`Alternative`),
   mais la conformité PDF/A-3 complète (métadonnées XMP + OutputIntent ICC) reste à
   ajouter pour passer une validation veraPDF stricte. C'est la prochaine tâche technique.
2. **Plateforme Agréée** : `MockPlateformeAgreee` est un stub. Au lancement réel, brancher
   une PA agréée DGFiP (émission/réception + e-reporting). On ne devient pas PA soi-même.
3. **Validation métier** : ajouter contrôles SIRET/TVA, numérotation séquentielle,
   gestion des avoirs (type 381), acomptes/situations BTP.
4. **Persistance** : en place via `data/db.json`. Pour passer à l'échelle (plusieurs
   instances, gros volumes), remplacer le backend par Postgres derrière les mêmes
   fonctions `dump*`/`restore*`.
5. **Multi-tenant strict** : ✅ en place. Chaque compte est isolé — toutes les données
   métier (factures, RDV, relances, avis) sont scopées par `accountId`, vérifié par test
   (compte A ne voit jamais les données de compte B). Les routes client publiques
   (`/book`, réceptionniste) ciblent un compte via `?account=<id>` (repli mono-artisan
   sur le premier compte si non précisé).

## Calendrier réglementaire (rappel)

- **1er sept. 2026** : toutes les entreprises doivent pouvoir *recevoir* l'e-facture ;
  grandes entreprises + ETI doivent *émettre*.
- **1er sept. 2027** : TPE, PME, micro-entreprises doivent *émettre* via une Plateforme Agréée.
