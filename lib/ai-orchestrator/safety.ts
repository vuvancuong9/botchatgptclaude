/**
 * Safety guard for the orchestrator.
 *
 * Two surfaces are protected:
 *   1. Shell commands the TEST_RUNNER may execute -> strict allowlist.
 *   2. Patch/artifact content produced by the implementer -> scanned for
 *      forbidden operations (secret exfiltration, rm -rf, auto-deploy,
 *      destructive migrations without human approval).
 */

/** The ONLY commands TEST_RUNNER is permitted to execute. */
export const COMMAND_ALLOWLIST: readonly string[] = [
  "npm run typecheck",
  "npm test",
  "npm run build",
  "git diff",
];

export interface CommandCheck {
  allowed: boolean;
  reason: string;
}

function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

export function isCommandAllowed(rawCommand: string): CommandCheck {
  const cmd = normalizeCommand(rawCommand);

  // No chaining / piping / substitution that could smuggle extra commands.
  if (/[;&|`$><]|\$\(|&&|\|\|/.test(cmd)) {
    return {
      allowed: false,
      reason: "Command contains shell control characters and is rejected.",
    };
  }

  // `git diff` may carry read-only path/flag arguments; everything else must
  // match the allowlist exactly.
  if (cmd === "git diff" || cmd.startsWith("git diff ")) {
    if (/--?(output|exec|ext-diff)/.test(cmd)) {
      return { allowed: false, reason: "git diff flag is not permitted." };
    }
    return { allowed: true, reason: "git diff (read-only)." };
  }

  if (COMMAND_ALLOWLIST.includes(cmd)) {
    return { allowed: true, reason: "Command is on the allowlist." };
  }

  return {
    allowed: false,
    reason: `Command "${cmd}" is not on the allowlist (${COMMAND_ALLOWLIST.join(", ")}).`,
  };
}

export type SafetyCategory =
  | "secret_access"
  | "destructive_fs"
  | "auto_deploy"
  | "destructive_migration";

export interface SafetyViolation {
  category: SafetyCategory;
  message: string;
  match: string;
  /** Migrations can proceed with explicit human approval; others never can. */
  overridableByApproval: boolean;
}

interface Rule {
  category: SafetyCategory;
  pattern: RegExp;
  message: string;
  overridableByApproval: boolean;
}

const RULES: Rule[] = [
  // --- Secret access / exfiltration ---
  {
    category: "secret_access",
    pattern: /\b(cat|type|less|more|head|tail|nano|vim|code)\b[^\n]*\.env\b/i,
    message: "Reading .env files is forbidden.",
    overridableByApproval: false,
  },
  {
    category: "secret_access",
    pattern: /\bprintenv\b|\benv\s*$|\bgci\s+env:/im,
    message: "Dumping environment variables is forbidden.",
    overridableByApproval: false,
  },
  {
    category: "secret_access",
    pattern:
      /(console\.(log|info|warn|error)|echo|print|printf|Write-(Host|Output))[^\n]*(process\.env|\$env:|API[_-]?KEY|SECRET|TOKEN|PASSWORD)/i,
    message: "Printing secrets / environment variables is forbidden.",
    overridableByApproval: false,
  },
  {
    category: "secret_access",
    pattern: /\b(echo|printf)\s+\$[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)/i,
    message: "Echoing secret environment variables is forbidden.",
    overridableByApproval: false,
  },
  // --- Destructive filesystem ---
  {
    category: "destructive_fs",
    pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-rf|-fr)\b/i,
    message: "rm -rf is forbidden.",
    overridableByApproval: false,
  },
  {
    category: "destructive_fs",
    pattern: /Remove-Item[^\n]*-Recurse[^\n]*-Force|rmdir\s+\/s/i,
    message: "Recursive force deletion is forbidden.",
    overridableByApproval: false,
  },
  // --- Automated production deploy ---
  {
    category: "auto_deploy",
    pattern:
      /\b(vercel\s+(deploy|--prod|--prod=true)|netlify\s+deploy|npm\s+run\s+deploy|git\s+push[^\n]*\b(prod|production|main)\b|kubectl\s+apply|terraform\s+apply|serverless\s+deploy|flyctl?\s+deploy)\b/i,
    message: "Automated production deployment is forbidden.",
    overridableByApproval: false,
  },
  // --- Destructive DB migration (overridable with human approval) ---
  {
    category: "destructive_migration",
    pattern:
      /\b(DROP\s+(TABLE|DATABASE|SCHEMA|COLUMN)|TRUNCATE\s+TABLE?|DELETE\s+FROM\s+\w+\s*(;|$)(?![^\n]*WHERE)|ALTER\s+TABLE[^\n]*DROP\s+COLUMN)\b/i,
    message:
      "Destructive migration detected; requires explicit human approval.",
    overridableByApproval: true,
  },
];

export interface ScanOptions {
  /** When true, migration-class violations are permitted (human approved). */
  humanApproved?: boolean;
}

export function scanContent(
  content: string,
  opts: ScanOptions = {},
): SafetyViolation[] {
  const violations: SafetyViolation[] = [];
  for (const rule of RULES) {
    const m = content.match(rule.pattern);
    if (!m) continue;
    if (rule.overridableByApproval && opts.humanApproved) continue;
    violations.push({
      category: rule.category,
      message: rule.message,
      match: m[0].slice(0, 120),
      overridableByApproval: rule.overridableByApproval,
    });
  }
  return violations;
}

/** True if any UNAPPROVED, non-overridable violation exists. */
export function hasBlockingViolation(violations: SafetyViolation[]): boolean {
  return violations.length > 0;
}
