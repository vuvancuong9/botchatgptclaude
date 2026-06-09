import { redactSecrets } from "./security/redact";

/**
 * Resumable orchestration state persisted in ai_orchestration_runs.state.
 * Every text field is REDACTED before storage (no secret ever lands in the DB).
 */
export interface OrchestrationState {
  userRequest: string;
  specText: string;
  critiqueText: string;
  planText: string;
  /** Current round's patch. */
  patchText: string;
  /** Latest code-review text (fed into the next implementer round). */
  lastReviewText: string;
  /** Latest worker test report (summary, redacted). */
  lastTestReport: string;
  /** Persisted so resume rounds apply the same destructive-migration gate. */
  humanApproved: boolean;
}

export function emptyState(
  userRequest: string,
  humanApproved = false,
): OrchestrationState {
  return {
    userRequest: redactSecrets(userRequest),
    specText: "",
    critiqueText: "",
    planText: "",
    patchText: "",
    lastReviewText: "",
    lastTestReport: "",
    humanApproved,
  };
}

/** Read a stored state object back into the typed shape (defensive defaults). */
export function readState(raw: Record<string, unknown>): OrchestrationState {
  const s = raw as Partial<OrchestrationState>;
  return {
    userRequest: s.userRequest ?? "",
    specText: s.specText ?? "",
    critiqueText: s.critiqueText ?? "",
    planText: s.planText ?? "",
    patchText: s.patchText ?? "",
    lastReviewText: s.lastReviewText ?? "",
    lastTestReport: s.lastTestReport ?? "",
    humanApproved: Boolean(s.humanApproved),
  };
}

/** Redact every string field before persisting. */
export function redactState(
  state: OrchestrationState,
): Record<string, unknown> {
  return {
    userRequest: redactSecrets(state.userRequest),
    specText: redactSecrets(state.specText),
    critiqueText: redactSecrets(state.critiqueText),
    planText: redactSecrets(state.planText),
    patchText: redactSecrets(state.patchText),
    lastReviewText: redactSecrets(state.lastReviewText),
    lastTestReport: redactSecrets(state.lastTestReport).slice(0, 8000),
    humanApproved: state.humanApproved,
  };
}
