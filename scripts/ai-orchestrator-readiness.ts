/**
 * Production go-live readiness gate (CLI).
 *
 *   npm run readiness                 # human-readable table
 *   npm run readiness -- --json       # machine-readable JSON
 *   npm run readiness -- --strict-warnings   # exit 1 on warnings too
 *
 * Pure inspection: reads env + bounded DB probes only. Never runs a command,
 * calls a model, applies a migration, or prints a secret VALUE. Exit 0 when
 * there are no failures (and, with --strict-warnings, no warnings); else exit 1.
 */
import { redactSecrets } from "../lib/ai-orchestrator/security/redact";
import {
  getProductionReadinessReport,
  ReadinessStatus,
} from "../lib/ai-orchestrator/production-readiness";

const ICON: Record<ReadinessStatus, string> = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
  skip: "SKIP",
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const strictWarnings = args.includes("--strict-warnings");

  const report = await getProductionReadinessReport();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `\nAI Orchestrator — production readiness (${report.environment})`,
    );
    console.log(
      "─".repeat(72) +
        `\n  PASS ${report.summary.pass}  WARN ${report.summary.warn}  ` +
        `FAIL ${report.summary.fail}  SKIP ${report.summary.skip}\n` +
        "─".repeat(72),
    );
    for (const c of report.checks) {
      console.log(
        `  [${ICON[c.status]}] ${c.severity.padEnd(8)} ${c.id.padEnd(22)} ${c.message}`,
      );
      if (c.remediation && (c.status === "fail" || c.status === "warn")) {
        console.log(`         ↳ ${c.remediation}`);
      }
    }
    console.log("─".repeat(72));
    console.log(
      report.summary.fail > 0
        ? `  RESULT: NOT READY — ${report.summary.fail} failing check(s).`
        : report.summary.warn > 0
          ? `  RESULT: READY WITH WARNINGS — ${report.summary.warn} warning(s).`
          : "  RESULT: READY.",
    );
    console.log("");
  }

  const failing =
    report.summary.fail > 0 || (strictWarnings && report.summary.warn > 0);
  process.exit(failing ? 1 : 0);
}

main().catch((err) => {
  console.error(
    "[readiness] FATAL:",
    redactSecrets(String((err as Error)?.message ?? err)),
  );
  process.exit(1);
});
