import { AgentOutput } from "../types";
import { AdapterRequest } from "./types";

/**
 * Deterministic placeholder used when an adapter has no API key. Keeps the
 * orchestrator fully runnable offline (CI, local dev, tests) without secrets.
 */
export function mockOutputFor(
  provider: "openai" | "anthropic",
  req: AdapterRequest,
): AgentOutput {
  if (req.mockOutput) return req.mockOutput;
  return {
    status: "pass",
    summary: `[mock:${provider}] No API key configured; returning placeholder output.`,
    issues: [],
    next_action: "continue",
    artifacts: [],
  };
}
