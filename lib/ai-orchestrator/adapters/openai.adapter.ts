import { parseAgentOutput } from "../schema";
import { AdapterRequest, AdapterResult, AIAdapter } from "./types";
import { mockOutputFor } from "./mock";

/**
 * OpenAI Chat Completions adapter for the GPT-driven steps.
 * Uses native fetch; no SDK dependency. Falls back to deterministic mock
 * output when OPENAI_API_KEY is absent so the pipeline runs offline.
 */
export class OpenAIAdapter implements AIAdapter {
  readonly provider = "openai" as const;
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(opts?: { apiKey?: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY;
    this.model = opts?.model ?? process.env.OPENAI_MODEL ?? "gpt-4o";
    this.baseUrl = (
      opts?.baseUrl ??
      process.env.OPENAI_BASE_URL ??
      "https://api.openai.com/v1"
    ).replace(/\/$/, "");
  }

  isLive(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(req: AdapterRequest): Promise<AdapterResult> {
    if (!this.isLive()) {
      return {
        output: mockOutputFor("openai", req),
        raw: "[mock] OPENAI_API_KEY not set",
        mode: "mock",
        model: this.model,
      };
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        max_tokens: req.maxTokens ?? 4096,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
    });

    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`OpenAI API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data.choices?.[0]?.message?.content ?? "";
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
