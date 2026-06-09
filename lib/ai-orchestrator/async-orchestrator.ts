import { AnthropicAdapter } from "./adapters/anthropic.adapter";
import { OpenAIAdapter } from "./adapters/openai.adapter";
import { AIAdapter } from "./adapters/types";
import { recordAudit } from "./audit";
import type { AiOrchestratorRepository } from "./db/repository.interface";
import { MAX_ROUNDS } from "./orchestrator";
import { buildSystemPrompt, STEP_PROMPTS } from "./prompts";
import {
  hasBlockingViolation,
  scanContent,
  SafetyViolation,
} from "./safety";
import { formatTestReport } from "./test-runner";
import {
  buildReportFromJob,
  enqueueOrchestratorTestJob,
} from "./test-runner-worker";
import {
  AgentOutput,
  ArtifactType,
  AuditEventType,
  OrchestrationRunStatus,
  StepName,
} from "./types";
import { JobQueue } from "./worker/types";
import {
  emptyState,
  OrchestrationState,
  readState,
  redactState,
} from "./orchestration-state";

const TERMINAL_JOB = new Set(["passed", "failed", "timed_out", "cancelled"]);
const TERMINAL_ORCH = new Set<OrchestrationRunStatus>([
  "passed",
  "failed",
  "needs_revision",
  "cancelled",
]);

export interface AsyncResult {
  orchestrationRunId: string;
  sessionId: string;
  status: OrchestrationRunStatus;
  round: number;
  workerJobId?: string | null;
  /** True when this resume left the run waiting on a (still-running) worker job. */
  stillWaiting?: boolean;
}

export interface AsyncOrchestratorDeps {
  repo: AiOrchestratorRepository;
  queue: JobQueue;
  repoCloneUrl: string;
  branch: string;
  openai?: AIAdapter;
  anthropic?: AIAdapter;
  commands?: readonly string[];
  humanApproved?: boolean;
  maxRounds?: number;
  userId?: string | null;
  adminKeyFingerprint?: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Resumable orchestration (Phase 7.3). Runs the model steps inline (no command
 * spawns), but the TEST_RUNNER step is a SANDBOX WORKER JOB: start() returns at
 * the first worker wait, and resume() continues after the job is terminal. State
 * lives in ai_orchestration_runs so /run never holds a long request.
 */
export class AsyncOrchestrator {
  private readonly openai: AIAdapter;
  private readonly anthropic: AIAdapter;
  private readonly maxRounds: number;

  constructor(private readonly deps: AsyncOrchestratorDeps) {
    this.openai = deps.openai ?? new OpenAIAdapter();
    this.anthropic = deps.anthropic ?? new AnthropicAdapter();
    this.maxRounds = Math.min(deps.maxRounds ?? MAX_ROUNDS, MAX_ROUNDS);
  }

  // --- public API ---

  async start(userRequest: string): Promise<AsyncResult> {
    const session = await this.deps.repo.createSession(userRequest, {
      userId: this.deps.userId ?? null,
      adminKeyFingerprint: this.deps.adminKeyFingerprint ?? null,
    });
    const run = await this.deps.repo.createOrchestrationRun({
      sessionId: session.id,
      userId: this.deps.userId ?? null,
      status: "running",
      currentRound: 1,
      maxRounds: this.maxRounds,
      currentStep: "GPT_PRODUCT_SPEC",
      state: redactState(emptyState(userRequest, this.deps.humanApproved ?? false)),
    });
    await this.event("orchestration_async_started", run.id, session.id, {
      requestChars: userRequest.length,
    });

    const state = emptyState(userRequest, this.deps.humanApproved ?? false);

    // Steps that run ONCE (not re-run on revision rounds).
    const spec = await this.runStep(
      session.id,
      "GPT_PRODUCT_SPEC",
      0,
      `User request:\n${userRequest}`,
      mock("pass", "Drafted technical spec from the user request.", "spec",
        "MOCK SPEC\nGoals, scope, data model, API surface, UI, acceptance criteria."),
    );
    state.specText = artifactText(spec, "spec");

    const critique = await this.runStep(
      session.id,
      "CLAUDE_CRITICAL_REVIEW",
      0,
      `User request:\n${userRequest}\n\nSpec to review:\n${state.specText}`,
      mock("pass", "Reviewed spec; no blocking gaps in mock mode.", "review",
        "MOCK CRITIQUE\nEdge cases and assumptions to confirm."),
    );
    state.critiqueText = artifactText(critique, "review");

    const plan = await this.runStep(
      session.id,
      "GPT_IMPLEMENTATION_PLAN",
      0,
      `Spec:\n${state.specText}\n\nCritique:\n${state.critiqueText}`,
      mock("pass", "Produced implementation plan.", "plan",
        "MOCK PLAN\nFiles to add/change, migrations, test strategy."),
    );
    state.planText = artifactText(plan, "plan");

    return this.implementAndEnqueue(session.id, run.id, 1, state);
  }

  async resume(runId: string): Promise<AsyncResult> {
    const run = await this.deps.repo.getOrchestrationRun(runId);
    if (!run) throw new Error(`Orchestration run ${runId} not found`);
    if (TERMINAL_ORCH.has(run.status)) {
      return { orchestrationRunId: run.id, sessionId: run.session_id, status: run.status, round: run.current_round };
    }
    if (run.status !== "waiting_for_worker" || !run.pending_worker_job_id) {
      // Nothing to resume yet.
      return {
        orchestrationRunId: run.id,
        sessionId: run.session_id,
        status: run.status,
        round: run.current_round,
        stillWaiting: true,
      };
    }

    const job = await this.deps.repo.getWorkerJob(run.pending_worker_job_id);
    if (!job || !TERMINAL_JOB.has(job.status)) {
      return {
        orchestrationRunId: run.id,
        sessionId: run.session_id,
        status: "waiting_for_worker",
        round: run.current_round,
        workerJobId: run.pending_worker_job_id,
        stillWaiting: true,
      };
    }

    await this.event("orchestration_resumed", run.id, run.session_id, {
      jobId: job.id,
      jobStatus: job.status,
      round: run.current_round,
    });

    const state = readState(run.state);
    const round = run.current_round;
    const report = buildReportFromJob(job);
    const reportText = `[worker_job_id: ${job.id}]\n${formatTestReport(report)}`;

    // Record the (now-known) TEST_RUNNER result.
    for (const r of report.results) {
      await this.deps.repo.addRun({
        sessionId: run.session_id,
        command: r.command,
        allowed: r.allowed,
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        step: "TEST_RUNNER",
        adminKeyFingerprint: this.deps.adminKeyFingerprint ?? null,
        userId: this.deps.userId ?? null,
      });
    }
    await this.recordSystemMessage(
      run.session_id,
      "TEST_RUNNER",
      round,
      mock(
        report.passed ? "pass" : "needs_revision",
        `Test suite ${report.passed ? "passed" : "failed"} (worker, job ${job.id}).`,
        "test_report",
        reportText,
      ),
    );
    state.lastTestReport = reportText;

    // Code reviewer.
    await this.deps.repo.updateOrchestrationRun(run.id, {
      current_step: "GPT_CODE_REVIEWER",
    });
    const review = await this.runStep(
      run.session_id,
      "GPT_CODE_REVIEWER",
      round,
      `Patch:\n${state.patchText}\n\n${reportText}`,
      mock(report.passed ? "pass" : "needs_revision",
        "Reviewed diff against test report.", "review",
        "MOCK REVIEW\nNo blocking issues found in mock mode."),
    );
    state.lastReviewText = artifactText(review, "review");

    // QA judge — fail-safe: cannot pass when tests are red.
    await this.deps.repo.updateOrchestrationRun(run.id, {
      current_step: "QA_JUDGE",
    });
    const judge = await this.runStep(
      run.session_id,
      "QA_JUDGE",
      round,
      `Code review:\n${state.lastReviewText}\n\n${reportText}`,
      mock(
        report.passed && review.status === "pass" ? "pass" : "needs_revision",
        "Final QA verdict.", "review", `MOCK VERDICT round ${round}.`,
      ),
    );
    let verdict = judge.status;
    if (!report.passed && verdict === "pass") verdict = "needs_revision"; // guard

    if (verdict === "pass") return this.finalize(run.session_id, run.id, "passed", round, state);
    if (verdict === "fail") return this.finalize(run.session_id, run.id, "failed", round, state);

    // needs_revision -> next round (bounded) or stop.
    if (round < run.max_rounds) {
      return this.implementAndEnqueue(run.session_id, run.id, round + 1, state);
    }
    return this.finalize(run.session_id, run.id, "needs_revision", round, state);
  }

  // --- internal ---

  private async implementAndEnqueue(
    sessionId: string,
    runId: string,
    round: number,
    state: OrchestrationState,
  ): Promise<AsyncResult> {
    await this.deps.repo.updateSession(sessionId, { rounds: round });
    await this.deps.repo.updateOrchestrationRun(runId, {
      current_round: round,
      current_step: "CLAUDE_CODE_IMPLEMENTER",
      state: redactState(state),
    });
    await this.event("orchestration_round_started", runId, sessionId, { round });

    const patch = await this.runStep(
      sessionId,
      "CLAUDE_CODE_IMPLEMENTER",
      round,
      `Plan:\n${state.planText}\n\nCritique:\n${state.critiqueText}` +
        (state.lastReviewText ? `\n\nPrevious review to address:\n${state.lastReviewText}` : ""),
      mock("pass", "Generated patch for the plan (mock no-op).", "patch",
        "MOCK PATCH\n--- no-op diff ---"),
    );
    state.patchText = artifactText(patch, "patch");

    // Safety scan of proposed changes.
    const violations = scanContent(state.patchText, {
      humanApproved: this.deps.humanApproved ?? false,
    });
    if (hasBlockingViolation(violations)) {
      const fatal = violations.some((v) => !v.overridableByApproval);
      const out = violationOutput(violations, fatal);
      await this.recordSystemMessage(sessionId, "CLAUDE_CODE_IMPLEMENTER", round, out);
      return this.finalize(
        sessionId,
        runId,
        fatal ? "failed" : "needs_revision",
        round,
        state,
      );
    }

    // Enqueue the sandbox TEST_RUNNER job and STOP (no command in this request).
    const job = await enqueueOrchestratorTestJob(this.deps.queue, {
      sessionId,
      round,
      repoCloneUrl: this.deps.repoCloneUrl,
      branch: this.deps.branch,
      commands: this.deps.commands,
      userId: this.deps.userId ?? null,
    });
    // Record a queued TEST_RUNNER run (exitCode null -> "skipped").
    await this.deps.repo.addRun({
      sessionId,
      command: "(sandbox worker test)",
      allowed: true,
      exitCode: null,
      stdout: "",
      stderr: `[queued] worker job ${job.id}`,
      step: "TEST_RUNNER",
      adminKeyFingerprint: this.deps.adminKeyFingerprint ?? null,
      userId: this.deps.userId ?? null,
    });
    await this.deps.repo.updateOrchestrationRun(runId, {
      status: "waiting_for_worker",
      current_round: round,
      current_step: "TEST_RUNNER",
      pending_worker_job_id: job.id,
      state: redactState(state),
    });
    await this.event("orchestration_worker_job_linked", runId, sessionId, {
      jobId: job.id,
      round,
    });
    await this.event("orchestration_waiting_for_worker", runId, sessionId, {
      jobId: job.id,
      round,
    });
    return {
      orchestrationRunId: runId,
      sessionId,
      status: "waiting_for_worker",
      round,
      workerJobId: job.id,
      stillWaiting: false,
    };
  }

  private async finalize(
    sessionId: string,
    runId: string,
    status: OrchestrationRunStatus,
    round: number,
    state: OrchestrationState,
  ): Promise<AsyncResult> {
    const sessionStatus =
      status === "passed" ? "passed" : status === "failed" ? "failed" : "needs_revision";
    await this.deps.repo.updateSession(sessionId, {
      status: sessionStatus,
      rounds: round,
    });
    await this.deps.repo.updateOrchestrationRun(runId, {
      status,
      current_step: null,
      pending_worker_job_id: null,
      finished_at: nowIso(),
      state: redactState(state),
    });
    await this.event(
      status === "failed" ? "orchestration_failed" : "orchestration_completed",
      runId,
      sessionId,
      { status, round },
    );
    return { orchestrationRunId: runId, sessionId, status, round };
  }

  private adapterFor(step: StepName): AIAdapter {
    return STEP_PROMPTS[step].provider === "openai" ? this.openai : this.anthropic;
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
    await this.deps.repo.addMessage({
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
    await this.deps.repo.addMessage({
      sessionId,
      step,
      provider: "system",
      round,
      output,
    });
  }

  /** Audit + timeline event (both redacted; no secrets). */
  private async event(
    eventType: AuditEventType,
    runId: string,
    sessionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await recordAudit({
      eventType,
      status: eventType.includes("failed") ? "fail" : "ok",
      sessionId,
      userId: this.deps.userId ?? null,
      adminKeyFingerprint: this.deps.adminKeyFingerprint ?? null,
      metadata: { ...metadata, orchestrationRunId: runId },
    });
    await this.deps.repo
      .appendOrchestrationEvent({
        orchestrationRunId: runId,
        sessionId,
        eventType,
        metadata,
      })
      .catch(() => {});
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

function artifactText(output: AgentOutput, type: ArtifactType): string {
  const a = output.artifacts.find((x) => x.type === type);
  return a?.content ?? output.summary;
}
