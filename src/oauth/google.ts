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
