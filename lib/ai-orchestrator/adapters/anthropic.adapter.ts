import { parseAgentOutput } from "../schema";
import { AdapterRequest, AdapterResult, AIAdapter } from "./types";
import { mockOutputFor } from "./mock";

/**
 * Native Anthropic Messages API adapter (POST /v1/messages).
 *
 * IMPORTANT: per project policy this deliberately does NOT use the OpenAI
 * compatibility layer for the production path. It talks to the native Messages
 * endpoint with the x-api-key + anthropic-version headers.
 *
 * Falls back to deterministic mock output when ANTHROPIC_API_KEY is absent.
 */
export class AnthropicAdapter implements AIAdapter {
  readonly provider = "anthropic" as const;
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly version: string;

  constructor(opts?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    version?: string;
  }) {
    this.apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model = opts?.model ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
    this.baseUrl = (
      opts?.baseUrl ??
      process.env.ANTHROPIC_BASE_URL ??
      "https://api.anthropic.com"
    ).replace(/\/$/, "");
    this.version =
      opts?.version ?? process.env.ANTHROPIC_VERSION ?? "2023-06-01";
  }

  isLive(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(req: AdapterRequest): Promise<AdapterResult> {
    if (!this.isLive()) {
      return {
        output: mockOutputFor("anthropic", req),
        raw: "[mock] ANTHROPIC_API_KEY not set",
        mode: "mock",
        model: this.model,
      };
    }

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey as string,
        "anthropic-version": this.version,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 4096,
        temperature: 0.2,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      }),
    });

    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`Anthropic API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
    };
    const raw =
      data.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n") ?? "";
    return {
      output: parseAgentOutput(raw),
      raw,
      mode: "live",
      model: this.model,
    };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}
