// « Se connecter avec Google » (OAuth 2.0) pour envoyer les emails depuis le Gmail
// de l'utilisateur, sans qu'il saisisse son mot de passe dans Artéo.
//
// Prérequis (une seule fois, par le propriétaire de l'app) :
//   - GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  (Google Cloud > Identifiants OAuth)
//   - GOOGLE_REDIRECT_URL  (ex. https://app.arteo.fr/api/oauth/google/callback)
// Ne fonctionne que si l'app est en ligne sur une vraie adresse (exigence Google).

export interface GmailOAuth {
  email: string;
  refreshToken: string;
}

const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events", // créer les RDV dans Google Agenda
].join(" ");

export function googleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URL);
}
export function clientId() { return process.env.GOOGLE_CLIENT_ID ?? ""; }
export function clientSecret() { return process.env.GOOGLE_CLIENT_SECRET ?? ""; }
export function redirectUrl() { return process.env.GOOGLE_REDIRECT_URL ?? ""; }

// URL de la page de consentement Google.
export function authUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUrl(),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

// Échange le code d'autorisation contre des jetons (dont le refresh_token).
export async function exchangeCode(code: string): Promise<{ refreshToken?: string; accessToken: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUrl(),
      grant_type: "authorization_code",
    }).toString(),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || "Échec OAuth Google");
  return { refreshToken: data.refresh_token, accessToken: data.access_token };
}

// Récupère l'adresse email du compte Google connecté.
export async function userEmail(accessToken: string): Promise<string> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data: any = await res.json();
  return data.email ?? "";
}

// Obtient un nouvel access_token à partir du refresh_token stocké.
export async function getAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || "Échec du rafraîchissement du jeton Google");
  return data.access_token as string;
}

export interface CalendarEvent {
  summary: string;
  description?: string;
  startIso: string;     // ISO datetime
  endIso: string;       // ISO datetime
  attendeeEmail?: string;
}

// Crée un événement dans l'agenda Google principal de l'utilisateur connecté.
export async function createCalendarEvent(refreshToken: string, ev: CalendarEvent): Promise<{ id: string; htmlLink: string }> {
  const accessToken = await getAccessToken(refreshToken);
  const body: any = {
    summary: ev.summary,
    description: ev.description ?? "",
    start: { dateTime: ev.startIso, timeZone: "Europe/Paris" },
    end: { dateTime: ev.endIso, timeZone: "Europe/Paris" },
    reminders: { useDefault: true },
  };
  if (ev.attendeeEmail) body.attendees = [{ email: ev.attendeeEmail }];
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Échec de la création de l'événement Google Agenda");
  return { id: data.id, htmlLink: data.htmlLink };
}
