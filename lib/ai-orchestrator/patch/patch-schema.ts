import { z } from "zod";
import { extractJsonObject } from "../schema";

/**
 * Strict JSON contract for a patch artifact produced by CLAUDE_CODE_IMPLEMENTER.
 *
 * {
 *   "files": [
 *     { "path": "relative/path.ts", "action": "create|modify|delete",
 *       "content": "full new file content for create/modify",
 *       "reason": "why this change is needed" }
 *   ],
 *   "commands_to_run": ["npm run typecheck", "npm test", "npm run build"],
 *   "risk_notes": []
 * }
 *
 * `content` is optional at the schema layer (delete needs none); the validator
 * enforces that create/modify carry content. Validation of paths/commands/
 * secrets lives in patch-validator.ts.
 */
export const PatchFileAction = z.enum(["create", "modify", "delete"]);
export type PatchFileAction = z.infer<typeof PatchFileAction>;

export const PatchFileSchema = z.object({
  path: z.string().min(1),
  action: PatchFileAction,
  content: z.string().optional(),
  reason: z.string().optional().default(""),
});
export type PatchFileSpec = z.infer<typeof PatchFileSchema>;

export const PatchArtifactSchema = z.object({
  files: z.array(PatchFileSchema).min(1, "patch must include at least one file"),
  commands_to_run: z.array(z.string()).default([]),
  risk_notes: z.array(z.string()).default([]),
});
export type PatchArtifact = z.infer<typeof PatchArtifactSchema>;

export class PatchParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = "PatchParseError";
  }
}

/**
 * Parse a patch artifact from raw model text (handles ```json fences / prose),
 * then validate the structural shape. Throws PatchParseError on any failure.
 * Semantic safety checks (paths, secrets, allowlist) are applied separately by
 * validatePatch().
 */
export function parsePatchArtifact(text: string): PatchArtifact {
  let json: string;
  try {
    json = extractJsonObject(text);
  } catch (err) {
    throw new PatchParseError(
      `No JSON patch object found: ${(err as Error).message}`,
      text,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new PatchParseError(`Invalid JSON: ${(err as Error).message}`, text);
  }

  const result = PatchArtifactSchema.safeParse(parsed);
  if (!result.success) {
    throw new PatchParseError(
      `Patch does not match schema: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      text,
    );
  }
  return result.data;
}
