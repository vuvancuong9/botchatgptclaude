import { AgentOutput, AgentOutputSchema } from "./types";

export class AgentOutputError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = "AgentOutputError";
  }
}

/**
 * Models occasionally wrap JSON in prose or ```json fences. Pull out the first
 * balanced JSON object so we can validate it against the strict contract.
 */
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;

  const start = candidate.indexOf("{");
  if (start === -1) {
    throw new AgentOutputError("No JSON object found in model output", text);
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return candidate.slice(start, i + 1);
      }
    }
  }
  throw new AgentOutputError("Unbalanced JSON object in model output", text);
}

export function parseAgentOutput(text: string): AgentOutput {
  const json = extractJsonObject(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new AgentOutputError(
      `Invalid JSON: ${(err as Error).message}`,
      text,
    );
  }
  const result = AgentOutputSchema.safeParse(parsed);
  if (!result.success) {
    throw new AgentOutputError(
      `Output does not match AgentOutput schema: ${result.error.message}`,
      text,
    );
  }
  return result.data;
}
