import { AnthropicAdapter } from "./adapters/anthropic.adapter";
import { OpenAIAdapter } from "./adapters/openai.adapter";
import { AIAdapter } from "./adapters/types";
import type { AiOrchestratorRepository } from "./db/repository.interface";
import { buildSystemPrompt, STEP_PROMPTS } from "./prompts";
import {
  hasBlockingViolation,
  scanContent,
  SafetyViolation,
} from "./safety";
import {
  formatTestReport,
  runTestSuite,
  TestExecutor,
} from "./test-runner";
import {
  AgentOutput,
  ArtifactType,
  SessionRecord,
  StepName,
} from "./types";

export const MAX_ROUNDS = 3;

export interface OrchestratorOptions {
  maxRounds?: number;
  /** Human approval flag for the session (gates destructive migrations). */
  humanApproved?: boolean;
  executeTests?: boolean;
  openai?: AIAdapter;
  anthropic?: AIAdapter;
  /** Optional caller attribution (prepared for multi-user; nullable today). */
  userId?: string | null;
  adminKeyFingerprint?: string | null;
  /**
   * Phase 7.2: how the TEST_RUNNER step executes. Defaults to INLINE
   * (runTestSuite); production injects a worker-backed executor so no command
   * spawns inside the request.
   */
  testExecutor?: TestExecutor;
}

export interface OrchestratorResult {
  sessionId: string;
  status: SessionRecord["status"];
  rounds: number;
}

export class Orchestrator {
  private readonly openai: AIAdapter;
  private readonly anthropic: AIAdapter;
  private readonly maxRounds: number;
  private readonly humanApproved: boolean;
  private readonly executeTests: boolean;
  private readonly userId: string | null;
  private readonly adminKeyFingerprint: string | null;
  private readonly testExecutor: TestExecutor;

  constructor(
    private readonly repo: AiOrchestratorRepository,
    opts: OrchestratorOptions = {},
  ) {
    this.openai = opts.openai ?? new OpenAIAdapter();
    this.anthropic = opts.anthropic ?? new AnthropicAdapter();
    this.maxRounds = Math.min(opts.maxRounds ?? MAX_ROUNDS, MAX_ROUNDS);
    this.humanApproved = opts.humanApproved ?? false;
    this.executeTests = opts.executeTests ?? false;
    this.userId = opts.userId ?? null;
    this.adminKeyFingerprint = opts.adminKeyFingerprint ?? null;
    // Default: INLINE test execution (current behaviour). Worker mode injects
    // a worker-backed executor via the service layer.
    this.testExecutor =
      opts.testExecutor ?? {
        run: async () => ({
          report: runTestSuite({ execute: this.executeTests }),
          mode: "inline" as const,
        }),
      };
  }

  private adapterFor(step: StepName): AIAdapter {
    return STEP_PROMPTS[step].provider === "openai"
      ? this.openai
      : this.anthropic;
  }

  private async runStep(
    sessionId: string,
    step: StepName,
    round: number,
    userContent: string,
    mockOutput: AgentOutput,
  ): Promise<AgentOutput> {
    const adapter = this.adapterFor(step);
    const result = await adapter.complete({
      system: buildSystemPrompt(step),
      user: userContent,
      mockOutput,
    });
    await this.repo.addMessage({
      sessionId,
      step,
      provider: adapter.provider,
      round,
      output: result.output,
    });
    return result.output;
  }

  private async recordSystemMessage(
    sessionId: string,
    step: StepName,
    round: number,
    output: AgentOutput,
  ): Promise<void> {
    await this.repo.addMessage({
      sessionId,
      step,
      provider: "system",
      round,
      output,
    });
  }

  async run(userRequest: string): Promise<OrchestratorResult> {
    const session = await this.repo.createSession(userRequest, {
      userId: this.userId,
      adminKeyFingerprint: this.adminKeyFingerprint,
    });
    const sid = session.id;

    // --- Phase 1: spec ---
    const spec = await this.runStep(
      sid,
      "GPT_PRODUCT_SPEC",
      0,
      `User request:\n${userRequest}`,
      mock("pass", "Drafted technical spec from the user request.", "spec",
        "MOCK SPEC\nGoals, scope, data model, API surface, UI, acceptance criteria."),
    );
    const specText = artifactText(spec, "spec");

    // --- Phase 2: critical review ---
    const critique = await this.runStep(
      sid,
      "CLAUDE_CRITICAL_REVIEW",
      0,
      `User request:\n${userRequest}\n\nSpec to review:\n${specText}`,
      mock("pass", "Reviewed spec; no blocking gaps in mock mode.", "review",
        "MOCK CRITIQUE\nEdge cases and assumptions to confirm."),
    );
    const critiqueText = artifactText(critique, "review");

    // --- Phase 3: implementation plan ---
    const plan = await this.runStep(
      sid,
      "GPT_IMPLEMENTATION_PLAN",
      0,
      `Spec:\n${specText}\n\nCritique:\n${critiqueText}`,
      mock("pass", "Produced implementation plan.", "plan",
        "MOCK PLAN\nFiles to add/change, migrations, test strategy."),
    );
    const planText = artifactText(plan, "plan");

    // --- Phases 4-7: bounded revision loop ---
    let finalStatus: SessionRecord["status"] = "needs_revision";
    let lastReviewText = "";
    let round = 0;

    while (round < this.maxRounds) {
      round++;
      await this.repo.updateSession(sid, { rounds: round });

      // 4. Implementer
      const patch = await this.runStep(
        sid,
        "CLAUDE_CODE_IMPLEMENTER",
        round,
        `Plan:\n${planText}\n\nCritique:\n${critiqueText}` +
          (lastReviewText ? `\n\nPrevious review to address:\n${lastReviewText}` : ""),
        mock("pass", "Generated patch for the plan (mock no-op).", "patch",
          "MOCK PATCH\n--- no-op diff ---"),
      );
      const patchText = artifactText(patch, "patch");

      // Safety scan of proposed changes.
      const violations = scanContent(patchText, {
        humanApproved: this.humanApproved,
      });
      if (hasBlockingViolation(violations)) {
        const fatal = violations.some((v) => !v.overridableByApproval);
        const out = violationOutput(violations, fatal);
        await this.recordSystemMessage(sid, "CLAUDE_CODE_IMPLEMENTER", round, out);
        finalStatus = fatal ? "failed" : "needs_revision";
        break;
      }

      // 5. TEST_RUNNER — inline (dev) or sandbox worker (production).
      const testStep = await this.testExecutor.run({ sessionId: sid, round });
      const report = testStep.report;
      const baseReportText = formatTestReport(report);
      const reportText = testStep.workerJobId
        ? `[worker_job_id: ${testStep.workerJobId}]\n${baseReportText}`
        : baseReportText;
      for (const r of report.results) {
        await this.repo.addRun({
          sessionId: sid,
          command: r.command,
          allowed: r.allowed,
          exitCode: r.exitCode,
          stdout: r.stdout,
          stderr: r.stderr,
          step: "TEST_RUNNER",
          adminKeyFingerprint: this.adminKeyFingerprint,
          userId: this.userId,
        });
      }
      await this.recordSystemMessage(
        sid,
        "TEST_RUNNER",
        round,
        mock(
          report.passed ? "pass" : "needs_revision",
          `Test suite ${report.passed ? "passed" : "failed"} (${testStep.mode}` +
            `${testStep.workerJobId ? `, job ${testStep.workerJobId}` : ""}).`,
          "test_report",
          reportText,
        ),
      );

      // 6. Code reviewer
      const review = await this.runStep(
        sid,
        "GPT_CODE_REVIEWER",
        round,
        `Patch:\n${patchText}\n\n${reportText}`,
        mock(
          report.passed ? "pass" : "needs_revision",
          "Reviewed diff against test report.",
          "review",
          "MOCK REVIEW\nNo blocking issues found in mock mode.",
        ),
      );
      lastReviewText = artifactText(review, "review");

      // 7. QA judge — fail-safe: cannot pass if tests are red.
      const judge = await this.runStep(
        sid,
        "QA_JUDGE",
        round,
        `Code review:\n${lastReviewText}\n\n${reportText}`,
        mock(
          report.passed && review.status === "pass" ? "pass" : "needs_revision",
          "Final QA verdict.",
          "review",
          `MOCK VERDICT round ${round}.`,
        ),
      );

      let verdict = judge.status;
      if (!report.passed && verdict === "pass") verdict = "needs_revision"; // guard

      if (verdict === "pass") {
        finalStatus = "passed";
        break;
      }
      if (verdict === "fail") {
        finalStatus = "failed";
        break;
      }
      // needs_revision -> loop again (until maxRounds)
      finalStatus = "needs_revision";
    }

    await this.repo.updateSession(sid, { status: finalStatus, rounds: round });
    return { sessionId: sid, status: finalStatus, rounds: round };
  }
}

function mock(
  status: AgentOutput["status"],
  summary: string,
  artifactType: ArtifactType,
  content: string,
): AgentOutput {
  return {
    status,
    summary,
    issues: [],
    next_action: "continue",
    artifacts: [{ type: artifactType, content }],
  };
}

function violationOutput(
  violations: SafetyViolation[],
  fatal: boolean,
): AgentOutput {
  return {
    status: fatal ? "fail" : "needs_revision",
    summary: fatal
      ? "Blocked by safety guard: forbidden operation in proposed changes."
      : "Blocked pending human approval (destructive migration).",
    issues: violations.map((v) => `[${v.category}] ${v.message} (match: ${v.match})`),
    next_action: fatal
      ? "Remove the forbidden operation and resubmit."
      : "Obtain human approval before proceeding.",
    artifacts: [],
  };
}

/** Pull the first matching artifact's content, else fall back to the summary. */
function artifactText(output: AgentOutput, type: ArtifactType): string {
  const a = output.artifacts.find((x) => x.type === type);
  return a?.content ?? output.summary;
}
