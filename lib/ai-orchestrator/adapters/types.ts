import { AgentOutput } from "../types";

import { AgentOutput as _AgentOutput } from "../types";

export interface AdapterRequest {
  /** System prompt establishing the agent role + JSON contract. */
  system: string;
  /** User-facing content (the task plus upstream artifacts). */
  user: string;
  /** Optional cap on output tokens. */
  maxTokens?: number;
  /**
   * Deterministic fallback used when no API key is configured. Lets the whole
   * pipeline run (and tests/build pass) offline without any secret.
   */
  mockOutput?: _AgentOutput;
}

export interface AdapterResult {
  /** Validated, schema-conformant agent output. */
  output: AgentOutput;
  /** Raw model text, kept for debugging/audit. */
  raw: string;
  /** "live" when a real API was called, "mock" when no key was configured. */
  mode: "live" | "mock";
  model: string;
}

export interface AIAdapter {
  readonly provider: "openai" | "anthropic";
  readonly model: string;
  /** True when a real API key is configured. */
  isLive(): boolean;
  complete(req: AdapterRequest): Promise<AdapterResult>;
}
