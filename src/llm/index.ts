// Couche client LLM unifiée, multi-fournisseur.
// Sélection via variables d'environnement, repli propre si non configuré.
//
//   LLM_PROVIDER = openai | anthropic | mock | (vide = auto/désactivé)
//   OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
//   ANTHROPIC_API_KEY / ANTHROPIC_MODEL
//
// Les appelants (relances, réceptionniste) tentent le LLM puis retombent sur
// leur logique déterministe si le client renvoie null.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface CompleteOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LlmProvider {
  name: string;
  model: string;
  complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<string>;
}

const DEFAULT_TIMEOUT = 12_000;

function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

// ---------- OpenAI (et compatibles : Azure, Mistral, Groq, OpenRouter…) ----------
class OpenAiProvider implements LlmProvider {
  name = "openai";
  model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  private base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  private key = process.env.OPENAI_API_KEY ?? "";
  async complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<string> {
    const { signal, cancel } = withTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT);
    try {
      const res = await fetch(`${this.base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ model: this.model, temperature: opts.temperature ?? 0.4, max_tokens: opts.maxTokens, messages }),
        signal,
      });
      if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
      const data: any = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    } finally { cancel(); }
  }
}

// ---------- Anthropic (Claude) ----------
class AnthropicProvider implements LlmProvider {
  name = "anthropic";
  model = process.env.ANTHROPIC_MODEL ?? "claude-3-5-haiku-20241022";
  private key = process.env.ANTHROPIC_API_KEY ?? "";
  async complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<string> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const rest = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
    const { signal, cancel } = withTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": this.key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: this.model, max_tokens: opts.maxTokens ?? 1024, temperature: opts.temperature ?? 0.4, system, messages: rest }),
        signal,
      });
      if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
      const data: any = await res.json();
      return data.content?.[0]?.text ?? "";
    } finally { cancel(); }
  }
}

// ---------- Mock (dev/tests, sans clé) ----------
class MockProvider implements LlmProvider {
  name = "mock";
  model = "mock-1";
  async complete(messages: ChatMessage[]): Promise<string> {
    const prompt = messages.map((m) => m.content).join("\n");
    // Extraction réceptionniste -> JSON
    if (/serviceId/.test(prompt)) {
      const urgent = /urgent|urgence|fuite|inondation/i.test(prompt);
      return JSON.stringify({ urgent });
    }
    // Relance SMS -> texte court
    if (/SMS \(max/i.test(prompt)) {
      return "Bonjour, votre facture reste en attente de règlement. Merci de régulariser rapidement. [généré par IA]";
    }
    // Relance email -> JSON {subject, body}
    if (/relance|recouvrement|créancier|impay/i.test(prompt)) {
      return JSON.stringify({
        subject: "Au sujet de votre facture en attente",
        body: "Bonjour,\n\nNous revenons vers vous concernant votre facture qui demeure impayée à ce jour. Nous comprenons que des imprévus arrivent ; pourriez-vous nous indiquer une date de règlement ? Nous restons à votre disposition pour toute question.\n\nBien cordialement, [généré par IA]",
      });
    }
    return "[réponse IA simulée]";
  }
}

let cached: LlmProvider | null | undefined;

export function getLlm(): LlmProvider | null {
  if (cached !== undefined) return cached;
  const p = (process.env.LLM_PROVIDER ?? "").toLowerCase();
  if (p === "mock") return (cached = new MockProvider());
  if (p === "openai" || (!p && process.env.OPENAI_API_KEY)) return (cached = new OpenAiProvider());
  if (p === "anthropic" || (!p && process.env.ANTHROPIC_API_KEY)) return (cached = new AnthropicProvider());
  return (cached = null);
}
export function resetLlm(): void { cached = undefined; }

export function llmStatus(): { enabled: boolean; provider?: string; model?: string } {
  const l = getLlm();
  return l ? { enabled: true, provider: l.name, model: l.model } : { enabled: false };
}

// Complétion texte (null si désactivé ou erreur).
export async function llmComplete(messages: ChatMessage[], opts?: CompleteOptions): Promise<string | null> {
  const l = getLlm();
  if (!l) return null;
  try {
    const out = await l.complete(messages, opts);
    return out?.trim() || null;
  } catch (e) {
    console.error("LLM erreur:", (e as Error).message);
    return null;
  }
}

// Extraction JSON robuste (null si désactivé/erreur/parse impossible).
export async function llmJson<T = any>(prompt: string, opts?: CompleteOptions): Promise<T | null> {
  const txt = await llmComplete([{ role: "user", content: prompt }], { temperature: 0, ...opts });
  if (!txt) return null;
  try {
    const m = txt.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : txt) as T;
  } catch { return null; }
}
