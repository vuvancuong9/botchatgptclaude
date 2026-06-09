"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "pass" | "needs_revision" | "fail";
type SessionStatus =
  | "running"
  | "passed"
  | "needs_revision"
  | "failed"
  | "rejected";

interface Artifact {
  type: "spec" | "plan" | "patch" | "test_report" | "review";
  content: string;
}
interface AgentOutput {
  status: Status;
  summary: string;
  issues: string[];
  next_action: string;
  artifacts: Artifact[];
}
interface MessageRecord {
  id: string;
  step: string;
  provider: string;
  round: number;
  output: AgentOutput;
  created_at: string;
}
interface RunRecord {
  id: string;
  command: string;
  allowed: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}
interface SessionRecord {
  id: string;
  user_request: string;
  status: SessionStatus;
  approval: "pending" | "approved" | "rejected";
  rounds: number;
  created_at: string;
}
interface SessionDetail {
  session: SessionRecord;
  messages: MessageRecord[];
  runs: RunRecord[];
}

const STATUS_COLOR: Record<string, string> = {
  pass: "#2ecc71",
  passed: "#2ecc71",
  ok: "#2ecc71",
  needs_revision: "#f0ad4e",
  fail: "#e74c3c",
  failed: "#e74c3c",
  rejected: "#e74c3c",
  running: "#4f8cff",
};

function Badge({ value }: { value: string }) {
  return (
    <span
      style={{
        background: STATUS_COLOR[value] ?? "#39465c",
        color: "#0b0f17",
        borderRadius: 6,
        padding: "1px 8px",
        fontWeight: 600,
        fontSize: 12,
      }}
    >
      {value}
    </span>
  );
}

function panelStyle(): React.CSSProperties {
  return {
    background: "#131a26",
    border: "1px solid #263043",
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
  };
}

function Pre({ text }: { text: string }) {
  return (
    <pre
      style={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        background: "#0b0f17",
        border: "1px solid #263043",
        borderRadius: 8,
        padding: 12,
        margin: "8px 0 0",
        maxHeight: 320,
        overflow: "auto",
        fontSize: 12.5,
      }}
    >
      {text}
    </pre>
  );
}

const API_KEY_STORAGE = "ai_orchestrator_api_key";

interface MeInfo {
  userId: string | null;
  role: string;
  permissions: string[];
  legacyAdmin: boolean;
}

interface PullRequestLite {
  status: string;
  github_pr_url: string | null;
  github_pr_number: number | null;
  branch_name: string;
}
interface PrResult {
  ok: boolean;
  mode?: "dry_run" | "live";
  message?: string;
  blockedReason?: string;
  branchName?: string;
  prUrl?: string | null;
  patchSetId?: string | null;
  validationErrors?: string[];
  errors?: string[];
  pullRequest?: PullRequestLite;
  /** validate-route shape */
  patchSet?: { id: string; status: string } | null;
  error?: string;
}

/** Patch artifact JSON shape (section C). */
interface PatchFileSpec {
  path: string;
  action: "create" | "modify" | "delete";
  content?: string;
  reason?: string;
}
interface ParsedPatch {
  files: PatchFileSpec[];
  commands_to_run?: string[];
  risk_notes?: string[];
}

/** Worker job (Phase 7 + 7.1). */
interface WorkerJobLite {
  id: string;
  status: string;
  job_type: string;
  patch_set_id: string | null;
  result: {
    summary?: string;
    commands?: { command: string; exitCode: number | null }[];
    patch_applied?: boolean;
    changed_files?: string[];
    diff_summary?: string;
    base_hash_checked?: boolean;
    errors?: { code: string; file_path?: string }[];
  } | null;
  error_message: string | null;
  created_at: string;
}
interface WorkerJobLog {
  id: string;
  stream: string;
  content: string;
}
interface JobView {
  job: WorkerJobLite;
  logs: WorkerJobLog[];
}
const TERMINAL_JOB = new Set(["passed", "failed", "cancelled", "timed_out"]);

/** Async orchestration (Phase 7.3). */
interface AsyncEvent {
  event_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
}
interface AsyncRunView {
  id: string;
  session_id: string;
  status: string;
  current_round: number;
  max_rounds: number;
  current_step: string | null;
  pending_worker_job_id: string | null;
  pending_job?: { id: string; status: string } | null;
  events?: AsyncEvent[];
  worker_job_id?: string | null;
}
const TERMINAL_ORCH = new Set([
  "passed",
  "failed",
  "needs_revision",
  "cancelled",
]);

/** Production readiness (Phase 8). */
interface ReadinessCheckView {
  id: string;
  name: string;
  status: "pass" | "warn" | "fail" | "skip";
  severity: "critical" | "high" | "medium" | "low";
  message: string;
  remediation?: string;
}
interface ReadinessView {
  ok: boolean;
  environment: string;
  checks: ReadinessCheckView[];
  summary: { pass: number; warn: number; fail: number; skip: number };
  timestamp: string;
}
const READINESS_COLOR: Record<string, string> = {
  pass: "#5cb85c",
  warn: "#f0ad4e",
  fail: "#e74c3c",
  skip: "#9aa7ba",
};

/** Production dry-run go/no-go (Phase 9). */
interface DryRunView {
  dry_run_safe: boolean;
  environment: string;
  blockers: string[];
  warnings: string[];
  next_actions: string[];
  readiness: {
    ok: boolean;
    environment: string;
    summary: { pass: number; warn: number; fail: number; skip: number };
  };
  health: Record<string, unknown>;
  timestamp: string;
}

/** Map a block reason to a human-friendly Vietnamese explanation. */
const BLOCK_REASONS: Record<string, string> = {
  not_approved: "Session chưa được approved.",
  permission_denied: "Không đủ quyền (ai:pr:create).",
  patch_not_validated: "Patch chưa validate hoặc validate thất bại.",
  github_disabled: "GitHub PR đang tắt (AI_ORCHESTRATOR_ENABLE_GITHUB_PR != 1).",
  github_not_configured: "Thiếu GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO.",
  tests_disabled: "Real tests bị tắt (cần AI_ORCHESTRATOR_EXECUTE_TESTS=1).",
  tests_failed: "Test thất bại — không tạo PR.",
  health_failed: "Health check fail.",
  smoke_required: "Yêu cầu smoke Supabase pass nhưng chưa ghi nhận.",
  worker_required: "Cần chạy Patch Tests in Sandbox và đợi job passed.",
  worker_failed: "Sandbox job thất bại — không tạo PR.",
  worker_patch_mismatch:
    "Sandbox job test patch_set khác — cần chạy lại Patch Tests cho patch hiện tại.",
  worker_hash_not_checked:
    "Sandbox job chưa kiểm tra base hash (strict mode) — cần chạy lại Patch Tests.",
  base_hash_mismatch:
    "Base file đã thay đổi sau khi validate patch. Cần Validate Patch lại rồi chạy Patch Tests lại.",
  missing_old_content_hash:
    "Thiếu old_content_hash (strict mode) — cần Validate Patch lại.",
  github_error: "Lỗi GitHub khi tạo PR.",
};

export default function OrchestratorPage() {
  const [request, setRequest] = useState("");
  const [humanApproved, setHumanApproved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [adminKey, setAdminKey] = useState("");
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [me, setMe] = useState<MeInfo | null>(null);
  const [prState, setPrState] = useState<PrResult | null>(null);
  const [prLoading, setPrLoading] = useState(false);
  const [jobView, setJobView] = useState<JobView | null>(null);
  const [jobBusy, setJobBusy] = useState(false);
  const [latestValidatedPatchSetId, setLatestValidatedPatchSetId] = useState<
    string | null
  >(null);
  const [asyncRun, setAsyncRun] = useState<AsyncRunView | null>(null);
  const [readiness, setReadiness] = useState<ReadinessView | null>(null);
  const [dryRun, setDryRun] = useState<DryRunView | null>(null);
  const autoResumedRef = useRef(false);

  // Load the API key from sessionStorage (NOT localStorage) on mount.
  useEffect(() => {
    const saved = sessionStorage.getItem(API_KEY_STORAGE);
    if (saved) setAdminKey(saved);
  }, []);

  const onAdminKeyChange = useCallback((value: string) => {
    setAdminKey(value);
    setMe(null);
    if (value) sessionStorage.setItem(API_KEY_STORAGE, value);
    else sessionStorage.removeItem(API_KEY_STORAGE);
  }, []);

  /** Centralized fetch: injects the API key header and maps 401/429 clearly. */
  const apiFetch = useCallback(
    async (input: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set("x-ai-api-key", adminKey);
      if (init.body) headers.set("content-type", "application/json");
      const res = await fetch(input, { ...init, headers });
      if (res.status === 401) {
        throw new Error(
          "401 Unauthorized — Admin Key sai hoặc thiếu. Nhập đúng x-ai-admin-key.",
        );
      }
      if (res.status === 429) {
        let retry = "";
        try {
          const d = await res.clone().json();
          if (d?.retryAfter) retry = ` Thử lại sau ${d.retryAfter}s.`;
        } catch {
          /* ignore */
        }
        throw new Error(`429 Too Many Requests — vượt giới hạn rate-limit.${retry}`);
      }
      return res;
    },
    [adminKey],
  );

  const loadMe = useCallback(async () => {
    try {
      const res = await apiFetch("/api/ai-orchestrator/me");
      if (res.ok) setMe(await res.json());
      else setMe(null);
    } catch {
      setMe(null);
    }
  }, [apiFetch]);

  const can = useCallback(
    (perm: string) => Boolean(me?.permissions?.includes(perm)),
    [me],
  );

  const loadSessions = useCallback(async () => {
    try {
      const res = await apiFetch("/api/ai-orchestrator/sessions");
      const data = await res.json();
      setSessions(data.sessions ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [apiFetch]);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/ai-orchestrator/run", {
        method: "POST",
        body: JSON.stringify({ request, humanApproved }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Run failed");
      if (data.orchestration_run_id) {
        // worker_async: the request returned immediately (202).
        autoResumedRef.current = false;
        setDetail(null);
        setAsyncRun({
          id: data.orchestration_run_id,
          session_id: data.session_id,
          status: data.status,
          current_round: data.round ?? 1,
          max_rounds: 3,
          current_step: "TEST_RUNNER",
          pending_worker_job_id: data.worker_job_id ?? null,
          worker_job_id: data.worker_job_id ?? null,
        });
      } else {
        setAsyncRun(null);
        setDetail(data);
      }
      await loadSessions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [request, humanApproved, loadSessions, apiFetch]);

  const pollAsync = useCallback(
    async (runId: string) => {
      try {
        const res = await apiFetch(`/api/ai-orchestrator/orchestrations/${runId}`);
        if (res.ok) setAsyncRun((await res.json()) as AsyncRunView);
      } catch {
        /* transient */
      }
    },
    [apiFetch],
  );

  const resumeAsync = useCallback(async () => {
    if (!asyncRun) return;
    try {
      const res = await apiFetch(
        `/api/ai-orchestrator/orchestrations/${asyncRun.id}/resume`,
        { method: "POST", body: JSON.stringify({}) },
      );
      if (res.ok || res.status === 202) await pollAsync(asyncRun.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [asyncRun, apiFetch, pollAsync]);

  const cancelAsync = useCallback(async () => {
    if (!asyncRun) return;
    try {
      await apiFetch(
        `/api/ai-orchestrator/orchestrations/${asyncRun.id}/cancel`,
        { method: "POST", body: JSON.stringify({}) },
      );
      await pollAsync(asyncRun.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [asyncRun, apiFetch, pollAsync]);

  // Poll the orchestration; auto-resume once when its worker job is terminal.
  useEffect(() => {
    if (!asyncRun || TERMINAL_ORCH.has(asyncRun.status)) return;
    const jobTerminal =
      asyncRun.pending_job && TERMINAL_JOB.has(asyncRun.pending_job.status);
    if (
      asyncRun.status === "waiting_for_worker" &&
      jobTerminal &&
      !autoResumedRef.current
    ) {
      autoResumedRef.current = true;
      void resumeAsync();
      return;
    }
    const id = setTimeout(() => {
      autoResumedRef.current = false;
      void pollAsync(asyncRun.id);
    }, 3000);
    return () => clearTimeout(id);
  }, [asyncRun, pollAsync, resumeAsync]);

  const checkHealth = useCallback(async () => {
    setError(null);
    setHealth(null);
    try {
      // health returns 500 (with a body) when the DB is down; apiFetch only
      // throws on 401/429, so we read the body either way.
      const res = await apiFetch("/api/ai-orchestrator/health");
      const data = await res.json();
      setHealth(data);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [apiFetch]);

  const checkReadiness = useCallback(async () => {
    setError(null);
    setReadiness(null);
    try {
      // readiness returns 503 (with a body) when a critical/high check fails;
      // apiFetch only throws on 401/429, so we read the body either way.
      const res = await apiFetch("/api/ai-orchestrator/readiness");
      if (res.status === 403) {
        setError("403 Forbidden — cần owner/admin hoặc ai:config:manage.");
        return;
      }
      setReadiness(await res.json());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [apiFetch]);

  const checkDryRun = useCallback(async () => {
    setError(null);
    setDryRun(null);
    try {
      const res = await apiFetch("/api/ai-orchestrator/production-dry-run");
      if (res.status === 403) {
        setError("403 Forbidden — cần owner/admin hoặc ai:config:manage.");
        return;
      }
      setDryRun(await res.json());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [apiFetch]);

  const openSession = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const res = await apiFetch(`/api/ai-orchestrator/sessions/${id}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Not found");
        setDetail(data);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [apiFetch],
  );

  const decide = useCallback(
    async (action: "approve" | "reject") => {
      if (!detail) return;
      setError(null);
      try {
        const res = await apiFetch(
          `/api/ai-orchestrator/sessions/${detail.session.id}`,
          {
            method: "POST",
            body: JSON.stringify({ action }),
          },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed");
        setDetail(data);
        await loadSessions();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [detail, loadSessions, apiFetch],
  );

  const refreshGhState = useCallback(
    async (sessionId: string) => {
      try {
        const res = await apiFetch(
          `/api/ai-orchestrator/sessions/${sessionId}/pull-request`,
        );
        if (res.ok) {
          const data = await res.json();
          setLatestValidatedPatchSetId(data.latestValidatedPatchSetId ?? null);
        }
      } catch {
        /* ignore */
      }
    },
    [apiFetch],
  );

  const validatePatch = useCallback(async () => {
    if (!detail) return;
    setPrLoading(true);
    setPrState(null);
    try {
      const res = await apiFetch(
        `/api/ai-orchestrator/sessions/${detail.session.id}/patch/validate`,
        { method: "POST", body: JSON.stringify({}) },
      );
      const data = (await res.json()) as PrResult;
      setPrState(data);
      await refreshGhState(detail.session.id);
    } catch (e) {
      setPrState({ ok: false, error: (e as Error).message });
    } finally {
      setPrLoading(false);
    }
  }, [detail, apiFetch, refreshGhState]);

  const createPr = useCallback(async () => {
    if (!detail) return;
    setPrLoading(true);
    setPrState(null);
    try {
      const res = await apiFetch(
        `/api/ai-orchestrator/sessions/${detail.session.id}/pull-request`,
        { method: "POST", body: JSON.stringify({}) },
      );
      const data = (await res.json()) as PrResult;
      setPrState(data);
    } catch (e) {
      setPrState({ ok: false, error: (e as Error).message });
    } finally {
      setPrLoading(false);
    }
  }, [detail, apiFetch]);

  const refreshJob = useCallback(
    async (jobId: string) => {
      try {
        const res = await apiFetch(`/api/ai-orchestrator/jobs/${jobId}`);
        if (res.ok) setJobView((await res.json()) as JobView);
      } catch {
        /* ignore transient poll errors */
      }
    },
    [apiFetch],
  );

  const runSandboxTests = useCallback(async () => {
    if (!detail) return;
    setJobBusy(true);
    try {
      const res = await apiFetch(
        `/api/ai-orchestrator/sessions/${detail.session.id}/test-job`,
        { method: "POST", body: JSON.stringify({}) },
      );
      const data = await res.json();
      if (res.ok && data.job_id) await refreshJob(data.job_id);
      else setError(data.error ?? "Could not create test job");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setJobBusy(false);
    }
  }, [detail, apiFetch, refreshJob]);

  // Load patch/PR/worker state when a session opens (for gating the UI).
  useEffect(() => {
    if (detail) void refreshGhState(detail.session.id);
  }, [detail, refreshGhState]);

  const cancelJob = useCallback(async () => {
    if (!jobView) return;
    setJobBusy(true);
    try {
      await apiFetch(`/api/ai-orchestrator/jobs/${jobView.job.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await refreshJob(jobView.job.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setJobBusy(false);
    }
  }, [jobView, apiFetch, refreshJob]);

  // Poll a non-terminal job until it settles (a separate worker advances it).
  useEffect(() => {
    if (!jobView || TERMINAL_JOB.has(jobView.job.status)) return;
    const id = setTimeout(() => void refreshJob(jobView.job.id), 3000);
    return () => clearTimeout(id);
  }, [jobView, refreshJob]);

  // Reset PR/patch + job state when switching sessions.
  useEffect(() => {
    setPrState(null);
    setJobView(null);
    setLatestValidatedPatchSetId(null);
  }, [detail?.session.id]);

  // Auto-load identity + session list once an API key is present.
  useEffect(() => {
    if (adminKey) {
      void loadMe();
      void loadSessions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminKey]);

  return (
    <main
      style={{
        display: "grid",
        gridTemplateColumns: "260px 1fr",
        gap: 16,
        maxWidth: 1200,
        margin: "0 auto",
        padding: 24,
      }}
    >
      {/* Sidebar: session history */}
      <aside>
        <h3 style={{ marginTop: 0 }}>Sessions</h3>
        <button
          onClick={() => void loadSessions()}
          style={btn("ghost")}
        >
          Refresh
        </button>
        <div style={{ marginTop: 12 }}>
          {sessions.length === 0 && (
            <p style={{ color: "#9aa7ba" }}>No sessions yet.</p>
          )}
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => void openSession(s.id)}
              style={{
                ...panelStyle(),
                cursor: "pointer",
                padding: 10,
                marginBottom: 8,
              }}
            >
              <div style={{ fontSize: 12, color: "#9aa7ba" }}>
                {new Date(s.created_at).toLocaleString()}
              </div>
              <div
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {s.user_request}
              </div>
              <div style={{ marginTop: 4 }}>
                <Badge value={s.status} /> <Badge value={s.approval} />
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* Main column */}
      <section>
        <h1 style={{ marginTop: 0 }}>AI Orchestrator</h1>
        <p style={{ color: "#9aa7ba", marginTop: -8 }}>
          GPT ⇄ Claude, controlled. Max 3 revision rounds, safety guarded.
        </p>

        <div style={panelStyle()}>
          <label htmlFor="adminKey" style={{ fontWeight: 600 }}>
            API Key{" "}
            <span style={{ color: "#9aa7ba", fontWeight: 400 }}>
              (x-ai-api-key · lưu trong sessionStorage)
            </span>
            {me && (
              <span style={{ marginLeft: 8 }}>
                <Badge value={me.role} />
                {me.legacyAdmin && (
                  <span style={{ color: "#f0ad4e", marginLeft: 6, fontSize: 12 }}>
                    legacy-admin
                  </span>
                )}
              </span>
            )}
          </label>
          <input
            id="adminKey"
            type="password"
            value={adminKey}
            onChange={(e) => onAdminKeyChange(e.target.value)}
            placeholder="Nhập API key (aiorch_...)"
            autoComplete="off"
            style={{
              width: "100%",
              marginTop: 8,
              background: "#0b0f17",
              color: "#e6edf6",
              border: adminKey ? "1px solid #263043" : "1px solid #f0ad4e",
              borderRadius: 8,
              padding: 10,
            }}
          />
          {!adminKey && (
            <p style={{ color: "#f0ad4e", margin: "6px 0 0", fontSize: 12 }}>
              Cần API Key để gọi API. Mọi request thiếu key sẽ bị trả 401.
            </p>
          )}
          {me && !can("ai:run") && (
            <p style={{ color: "#f0ad4e", margin: "6px 0 0", fontSize: 12 }}>
              Role <strong>{me.role}</strong> không có quyền chạy orchestrator
              (ai:run).
            </p>
          )}
          <div style={{ marginTop: 10 }}>
            <button
              onClick={() => void checkHealth()}
              disabled={adminKey.length === 0}
              style={btn("ghost")}
            >
              Check Health
            </button>
          </div>
          {health && (
            <div
              style={{
                marginTop: 10,
                background: "#0b0f17",
                border: "1px solid #263043",
                borderRadius: 8,
                padding: 12,
                fontSize: 12.5,
              }}
            >
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span>
                  db: <strong>{String(health.db_provider)}</strong>
                </span>
                <Badge value={String(health.db_status)} />
                <span>
                  rate-limit:{" "}
                  <strong>{String(health.rate_limit_provider)}</strong>
                </span>
                <Badge value={String(health.rate_limit_status)} />
              </div>
              <div style={{ marginTop: 6, color: "#9aa7ba" }}>
                openai key: {health.has_openai_key ? "yes" : "no"} · anthropic
                key: {health.has_anthropic_key ? "yes" : "no"} · execute tests:{" "}
                {health.execute_tests_enabled ? "on" : "off"}
              </div>
              <div style={{ marginTop: 6, color: "#9aa7ba" }}>
                worker: <strong>{String(health.worker_provider)}</strong> · inline
                cmds: {health.inline_commands_enabled ? "on" : "off"} · repo clone:{" "}
                {health.repo_clone_configured ? "yes" : "no"} · hash strict:{" "}
                {health.patch_hash_strict ? "on" : "off"} · claim:{" "}
                {String(health.worker_claim_mode)}
              </div>
              {health.worker_mode_warning ? (
                <div style={{ marginTop: 6, color: "#e74c3c", fontSize: 12 }}>
                  ⚠ {String(health.worker_mode_warning)}
                </div>
              ) : null}
              {health.worker_claim_warning ? (
                <div style={{ marginTop: 6, color: "#f0ad4e", fontSize: 12 }}>
                  ⚠ {String(health.worker_claim_warning)}
                </div>
              ) : null}
              <div style={{ marginTop: 6, color: "#9aa7ba" }}>
                lease: {String(health.worker_lease_seconds)}s · heartbeat:{" "}
                {String(health.worker_heartbeat_interval_ms)}ms · test runner:{" "}
                <strong>{String(health.test_runner_mode)}</strong>
              </div>
              {health.worker_lease_warning ? (
                <div style={{ marginTop: 6, color: "#f0ad4e", fontSize: 12 }}>
                  ⚠ {String(health.worker_lease_warning)}
                </div>
              ) : null}
              {health.test_runner_warning ? (
                <div
                  style={{
                    marginTop: 6,
                    color:
                      health.test_runner_mode === "inline"
                        ? "#e74c3c"
                        : "#f0ad4e",
                    fontSize: 12,
                  }}
                >
                  ⚠ {String(health.test_runner_warning)}
                </div>
              ) : null}
              {health.worker_async_warning ? (
                <div style={{ marginTop: 6, color: "#f0ad4e", fontSize: 12 }}>
                  ⚠ {String(health.worker_async_warning)}
                </div>
              ) : null}
              <div style={{ marginTop: 6, color: "#9aa7ba" }}>
                cron resume:{" "}
                <strong>
                  {health.cron_key_configured ? "configured" : "off"}
                </strong>{" "}
                · batch: {String(health.resume_batch_size)} · lock TTL:{" "}
                {String(health.resume_lock_ttl_seconds)}s
              </div>
              {health.cron_resume_warning ? (
                <div style={{ marginTop: 6, color: "#f0ad4e", fontSize: 12 }}>
                  ⚠ {String(health.cron_resume_warning)}
                </div>
              ) : null}
            </div>
          )}
          {me &&
            (me.role === "owner" ||
              me.role === "admin" ||
              can("ai:config:manage")) && (
              <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => void checkReadiness()}
                  disabled={adminKey.length === 0}
                  style={btn("ghost")}
                >
                  Check Production Readiness
                </button>
                <button
                  onClick={() => void checkDryRun()}
                  disabled={adminKey.length === 0}
                  style={btn("ghost")}
                >
                  Production Dry-run Check
                </button>
              </div>
            )}
          {readiness && <ReadinessPanel report={readiness} />}
          {dryRun && <DryRunPanel status={dryRun} />}
        </div>

        <div style={panelStyle()}>
          <label htmlFor="req" style={{ fontWeight: 600 }}>
            Yêu cầu của bạn
          </label>
          <textarea
            id="req"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={4}
            placeholder="Describe the software change you want..."
            style={{
              width: "100%",
              marginTop: 8,
              background: "#0b0f17",
              color: "#e6edf6",
              border: "1px solid #263043",
              borderRadius: 8,
              padding: 10,
            }}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginTop: 10,
            }}
          >
            <button
              onClick={() => void run()}
              disabled={
                loading ||
                request.trim().length === 0 ||
                adminKey.length === 0 ||
                (!!me && !can("ai:run"))
              }
              style={btn("primary")}
            >
              {loading ? "Running..." : "Run orchestration"}
            </button>
            <label style={{ color: "#9aa7ba" }}>
              <input
                type="checkbox"
                checked={humanApproved}
                onChange={(e) => setHumanApproved(e.target.checked)}
              />{" "}
              Pre-approve destructive migrations
            </label>
          </div>
          {error && (
            <p style={{ color: "#e74c3c", marginBottom: 0 }}>⚠ {error}</p>
          )}
        </div>

        {asyncRun && (
          <AsyncOrchestrationPanel
            run={asyncRun}
            onResume={resumeAsync}
            onCancel={cancelAsync}
            onOpenSession={() => void openSession(asyncRun.session_id)}
          />
        )}

        {detail && (
          <SessionView
            detail={detail}
            onDecide={decide}
            canApprove={can("ai:session:approve")}
            canReject={can("ai:session:reject")}
            canValidatePatch={can("ai:patch:create")}
            canCreatePr={can("ai:pr:create")}
            canRunTests={can("ai:run_tests")}
            onValidatePatch={validatePatch}
            onCreatePr={createPr}
            onRunTests={runSandboxTests}
            onCancelJob={cancelJob}
            prState={prState}
            prLoading={prLoading}
            jobView={jobView}
            jobBusy={jobBusy}
            workerProvider={health ? String(health.worker_provider) : null}
            inlineWarning={
              health && health.worker_mode_warning
                ? String(health.worker_mode_warning)
                : null
            }
            liveMode={health ? health.github_pr_dry_run === false : false}
            latestValidatedPatchSetId={latestValidatedPatchSetId}
            patchHashStrict={health ? health.patch_hash_strict === true : false}
          />
        )}

        {me && can("ai:users:manage") && (
          <UsersPanel apiFetch={apiFetch} canManageKeys={can("ai:apikey:manage")} />
        )}
      </section>
    </main>
  );
}

function SessionView({
  detail,
  onDecide,
  canApprove,
  canReject,
  canValidatePatch,
  canCreatePr,
  canRunTests,
  onValidatePatch,
  onCreatePr,
  onRunTests,
  onCancelJob,
  prState,
  prLoading,
  jobView,
  jobBusy,
  workerProvider,
  inlineWarning,
  liveMode,
  latestValidatedPatchSetId,
  patchHashStrict,
}: {
  detail: SessionDetail;
  onDecide: (a: "approve" | "reject") => void;
  canApprove: boolean;
  canReject: boolean;
  canValidatePatch: boolean;
  canCreatePr: boolean;
  canRunTests: boolean;
  onValidatePatch: () => void;
  onCreatePr: () => void;
  onRunTests: () => void;
  onCancelJob: () => void;
  prState: PrResult | null;
  prLoading: boolean;
  jobView: JobView | null;
  jobBusy: boolean;
  workerProvider: string | null;
  inlineWarning: string | null;
  liveMode: boolean;
  latestValidatedPatchSetId: string | null;
  patchHashStrict: boolean;
}) {
  const { session, messages, runs } = detail;
  const hasValidatedPatch = Boolean(latestValidatedPatchSetId);
  const job = jobView?.job;
  const jobMatchesPatch =
    !!job && !!latestValidatedPatchSetId &&
    job.patch_set_id === latestValidatedPatchSetId;
  const jobBaseHashOk = !!job && job.result?.base_hash_checked === true;
  const jobPassedApplied =
    !!job &&
    job.status === "passed" &&
    job.result?.patch_applied === true &&
    jobMatchesPatch;
  // Job passed but for an older patch set → must re-run sandbox tests.
  const needsRerun =
    !!job && job.status === "passed" && !jobMatchesPatch;
  // In worker mode + live PRs, Create PR needs a passed+applied job for THIS
  // patch; in strict mode it must also have verified base hashes.
  const createPrBlockedByWorker =
    liveMode &&
    workerProvider === "database" &&
    (!jobPassedApplied || (patchHashStrict && !jobBaseHashOk));
  return (
    <div>
      <div style={panelStyle()}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <strong>Result:</strong> <Badge value={session.status} />
          <span style={{ color: "#9aa7ba" }}>
            rounds: {session.rounds} / 3
          </span>
          <span style={{ marginLeft: "auto" }}>
            approval: <Badge value={session.approval} />
          </span>
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
          {canApprove && (
            <button onClick={() => onDecide("approve")} style={btn("green")}>
              Approve
            </button>
          )}
          {canReject && (
            <button onClick={() => onDecide("reject")} style={btn("red")}>
              Reject
            </button>
          )}
          {!canApprove && !canReject && (
            <span style={{ color: "#9aa7ba", fontSize: 12 }}>
              Bạn không có quyền approve/reject session này.
            </span>
          )}
        </div>
      </div>

      <WorkerPanel
        canRunTests={canRunTests}
        onRunTests={onRunTests}
        onCancelJob={onCancelJob}
        jobView={jobView}
        jobBusy={jobBusy}
        workerProvider={workerProvider}
        inlineWarning={inlineWarning}
        hasValidatedPatch={hasValidatedPatch}
        needsRerun={needsRerun}
      />

      <GithubPanel
        canValidatePatch={canValidatePatch}
        canCreatePr={canCreatePr}
        onValidatePatch={onValidatePatch}
        onCreatePr={onCreatePr}
        prState={prState}
        prLoading={prLoading}
        createPrBlockedByWorker={createPrBlockedByWorker}
      />

      {messages.map((m) => (
        <div key={m.id} style={panelStyle()}>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <strong>{m.step}</strong>
            <Badge value={m.output.status} />
            <span style={{ color: "#9aa7ba", fontSize: 12 }}>
              {m.provider} · round {m.round}
            </span>
          </div>
          <p style={{ margin: "8px 0 0" }}>{m.output.summary}</p>
          {m.output.issues.length > 0 && (
            <ul style={{ margin: "8px 0 0", color: "#f0ad4e" }}>
              {m.output.issues.map((iss, i) => (
                <li key={i}>{iss}</li>
              ))}
            </ul>
          )}
          {m.output.artifacts.map((a, i) => (
            <div key={i} style={{ marginTop: 8 }}>
              <Badge value={a.type} />
              {a.type === "patch" ? (
                <PatchArtifactView content={a.content} />
              ) : (
                <Pre text={a.content} />
              )}
            </div>
          ))}
        </div>
      ))}

      {runs.length > 0 && (
        <div style={panelStyle()}>
          <strong>Command runs (allowlist enforced)</strong>
          {runs.map((r) => (
            <div key={r.id} style={{ marginTop: 8 }}>
              <code>$ {r.command}</code>{" "}
              <Badge value={r.allowed ? "pass" : "fail"} />
              {r.stderr && <Pre text={r.stderr} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ApiKeyLite {
  id: string;
  key_prefix: string;
  name: string | null;
  status: string;
}
interface UserLite {
  id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  status: string;
  api_keys: ApiKeyLite[];
}

function UsersPanel({
  apiFetch,
  canManageKeys,
}: {
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>;
  canManageKeys: boolean;
}) {
  const [users, setUsers] = useState<UserLite[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState("developer");
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await apiFetch("/api/ai-orchestrator/users");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setUsers(data.users ?? []);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [apiFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  const createUser = useCallback(async () => {
    setErr(null);
    try {
      const res = await apiFetch("/api/ai-orchestrator/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: newEmail, role: newRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setNewEmail("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [apiFetch, newEmail, newRole, load]);

  const act = useCallback(
    async (userId: string, action: string, keyId?: string) => {
      setErr(null);
      setCreatedKey(null);
      try {
        const res = await apiFetch(
          `/api/ai-orchestrator/users/${userId}/actions`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, keyId }),
          },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed");
        if (data.apiKey) setCreatedKey(data.apiKey);
        await load();
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [apiFetch, load],
  );

  return (
    <div style={panelStyle()}>
      <h3 style={{ marginTop: 0 }}>Users (RBAC)</h3>
      {err && <p style={{ color: "#e74c3c" }}>⚠ {err}</p>}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="email@example.com"
          style={{
            background: "#0b0f17",
            color: "#e6edf6",
            border: "1px solid #263043",
            borderRadius: 8,
            padding: 8,
            flex: 1,
          }}
        />
        <select
          value={newRole}
          onChange={(e) => setNewRole(e.target.value)}
          style={{
            background: "#0b0f17",
            color: "#e6edf6",
            border: "1px solid #263043",
            borderRadius: 8,
            padding: 8,
          }}
        >
          {["admin", "developer", "reviewer", "viewer"].map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button onClick={() => void createUser()} style={btn("primary")}>
          Create user
        </button>
      </div>

      {createdKey && (
        <div
          style={{
            background: "#0b0f17",
            border: "1px solid #f0ad4e",
            borderRadius: 8,
            padding: 10,
            marginBottom: 12,
          }}
        >
          <strong style={{ color: "#f0ad4e" }}>
            New API key (shown once — copy now):
          </strong>
          <Pre text={createdKey} />
        </div>
      )}

      {users.map((u) => (
        <div key={u.id} style={{ ...panelStyle(), padding: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Badge value={u.role} />
            <Badge value={u.status} />
            <span>{u.email ?? u.display_name ?? u.id.slice(0, 8)}</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              {u.status === "active" ? (
                <button onClick={() => void act(u.id, "disable")} style={btn("red")}>
                  Disable
                </button>
              ) : (
                <button onClick={() => void act(u.id, "enable")} style={btn("green")}>
                  Enable
                </button>
              )}
              {canManageKeys && (
                <button
                  onClick={() => void act(u.id, "create_key")}
                  style={btn("ghost")}
                >
                  + API key
                </button>
              )}
            </span>
          </div>
          {u.api_keys.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {u.api_keys.map((k) => (
                <div
                  key={k.id}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    fontSize: 12,
                    color: "#9aa7ba",
                  }}
                >
                  <code>aiorch_{k.key_prefix}…</code>
                  <Badge value={k.status} />
                  {canManageKeys && k.status === "active" && (
                    <button
                      onClick={() => void act(u.id, "revoke_key", k.id)}
                      style={{ ...btn("ghost"), padding: "2px 8px" }}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const ORCH_EVENT_LABELS: Record<string, string> = {
  orchestration_async_started: "Started (spec → critique → plan)",
  orchestration_round_started: "Implement (round)",
  orchestration_worker_job_linked: "Test job enqueued",
  orchestration_waiting_for_worker: "Waiting for worker",
  orchestration_resumed: "Resumed (review → QA)",
  orchestration_completed: "Completed",
  orchestration_failed: "Failed",
  orchestration_cancelled: "Cancelled",
  orchestration_resume_lock_acquired: "Cron resume: lock acquired",
  orchestration_resume_lock_skipped: "Cron resume: skipped (locked)",
  orchestration_resume_lock_released: "Cron resume: lock released",
};

function AsyncOrchestrationPanel({
  run,
  onResume,
  onCancel,
  onOpenSession,
}: {
  run: AsyncRunView;
  onResume: () => void;
  onCancel: () => void;
  onOpenSession: () => void;
}) {
  const terminal = TERMINAL_ORCH.has(run.status);
  const jobTerminal =
    !!run.pending_job && TERMINAL_JOB.has(run.pending_job.status);
  return (
    <div style={panelStyle()}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong>Async orchestration</strong>
        <Badge value={run.status} />
        <span style={{ color: "#9aa7ba", fontSize: 12 }}>
          round {run.current_round}/{run.max_rounds}
          {run.current_step ? ` · step ${run.current_step}` : ""}
        </span>
        <span style={{ color: "#9aa7ba", fontSize: 12 }}>
          run <code>{run.id.slice(0, 8)}</code>
        </span>
      </div>

      {run.pending_worker_job_id && (
        <div style={{ marginTop: 6, color: "#9aa7ba", fontSize: 12 }}>
          worker job <code>{run.pending_worker_job_id.slice(0, 8)}</code>
          {run.pending_job ? (
            <>
              {" "}
              <Badge value={run.pending_job.status} />
            </>
          ) : null}
          {run.status === "waiting_for_worker" && !jobTerminal ? (
            <span> · waiting… (start the worker: npm run ai:worker)</span>
          ) : null}
        </div>
      )}

      {run.status === "waiting_for_worker" && jobTerminal && (
        <div style={{ marginTop: 6, color: "#5cb85c", fontSize: 12 }}>
          Worker job đã xong — cron sẽ tự resume, hoặc bấm Resume để tiếp tục ngay.
        </div>
      )}

      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {run.status === "waiting_for_worker" && (
          <button onClick={onResume} style={btn("ghost")}>
            Resume
          </button>
        )}
        {!terminal && (
          <button onClick={onCancel} style={btn("red")}>
            Cancel Orchestration
          </button>
        )}
        {terminal && (
          <button onClick={onOpenSession} style={btn("primary")}>
            Open session
          </button>
        )}
      </div>

      {run.events && run.events.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <strong style={{ fontSize: 12, color: "#9aa7ba" }}>Timeline</strong>
          <ol style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {run.events.map((e, i) => (
              <li key={i} style={{ color: "#9aa7ba", marginBottom: 2 }}>
                {ORCH_EVENT_LABELS[e.event_type] ?? e.event_type}
                <span style={{ opacity: 0.6 }}>
                  {" "}
                  · {new Date(e.created_at).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function ReadinessPanel({ report }: { report: ReadinessView }) {
  const blocking = report.checks.some(
    (c) =>
      c.status === "fail" && (c.severity === "critical" || c.severity === "high"),
  );
  return (
    <div
      style={{
        marginTop: 10,
        background: "#0b0f17",
        border: `1px solid ${blocking ? "#5b2230" : "#263043"}`,
        borderRadius: 8,
        padding: 12,
        fontSize: 12.5,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong>Production readiness</strong>
        <Badge value={report.ok ? "ready" : blocking ? "not-ready" : "warnings"} />
        <span style={{ color: "#9aa7ba", fontSize: 12 }}>
          env {report.environment}
        </span>
        <span style={{ color: "#9aa7ba", fontSize: 12 }}>
          PASS {report.summary.pass} · WARN {report.summary.warn} · FAIL{" "}
          {report.summary.fail} · SKIP {report.summary.skip}
        </span>
      </div>
      <ul style={{ margin: "8px 0 0", paddingLeft: 0, listStyle: "none" }}>
        {report.checks.map((c) => (
          <li key={c.id} style={{ marginBottom: 6 }}>
            <span
              style={{
                color: READINESS_COLOR[c.status] ?? "#9aa7ba",
                fontWeight: 700,
              }}
            >
              {c.status.toUpperCase()}
            </span>{" "}
            <span style={{ color: "#9aa7ba" }}>[{c.severity}]</span>{" "}
            <strong>{c.name}</strong>
            <div style={{ color: "#c7d2e0", marginLeft: 2 }}>{c.message}</div>
            {c.remediation && (c.status === "fail" || c.status === "warn") ? (
              <div style={{ color: "#f0ad4e", marginLeft: 2, fontSize: 12 }}>
                ↳ {c.remediation}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DryRunPanel({ status }: { status: DryRunView }) {
  const safe = status.dry_run_safe;
  return (
    <div
      style={{
        marginTop: 10,
        background: "#0b0f17",
        border: `1px solid ${safe ? "#235b2f" : "#5b2230"}`,
        borderRadius: 8,
        padding: 12,
        fontSize: 12.5,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong>Production dry-run</strong>
        <Badge value={safe ? "safe" : "not-safe"} />
        <span style={{ color: "#9aa7ba", fontSize: 12 }}>env {status.environment}</span>
        <span style={{ color: "#9aa7ba", fontSize: 12 }}>
          readiness {status.readiness.ok ? "ok" : "not ok"} · FAIL{" "}
          {status.readiness.summary.fail} · WARN {status.readiness.summary.warn}
        </span>
      </div>
      {status.blockers.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <strong style={{ color: "#e74c3c", fontSize: 12 }}>Blockers</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {status.blockers.map((b, i) => (
              <li key={i} style={{ color: "#e9b7bf", marginBottom: 2 }}>
                {b}
              </li>
            ))}
          </ul>
        </div>
      )}
      {status.warnings.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <strong style={{ color: "#f0ad4e", fontSize: 12 }}>Warnings</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {status.warnings.map((w, i) => (
              <li key={i} style={{ color: "#e7d3a8", marginBottom: 2 }}>
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}
      {status.next_actions.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <strong style={{ color: "#9aa7ba", fontSize: 12 }}>Next actions</strong>
          <ol style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {status.next_actions.map((a, i) => (
              <li key={i} style={{ color: "#c7d2e0", marginBottom: 2 }}>
                {a}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function WorkerPanel({
  canRunTests,
  onRunTests,
  onCancelJob,
  jobView,
  jobBusy,
  workerProvider,
  inlineWarning,
  hasValidatedPatch,
  needsRerun,
}: {
  canRunTests: boolean;
  onRunTests: () => void;
  onCancelJob: () => void;
  jobView: JobView | null;
  jobBusy: boolean;
  workerProvider: string | null;
  inlineWarning: string | null;
  hasValidatedPatch: boolean;
  needsRerun: boolean;
}) {
  const job = jobView?.job;
  const active = job ? !TERMINAL_JOB.has(job.status) : false;
  const failedCmd =
    job?.result?.commands?.find((c) => (c.exitCode ?? 1) !== 0) ?? null;
  const changed = job?.result?.changed_files ?? [];
  const baseMismatch = (job?.result?.errors ?? []).some(
    (e) => e.code === "base_hash_mismatch",
  );
  const logText = (jobView?.logs ?? [])
    .map((l) => `[${l.stream}] ${l.content}`)
    .join("\n");

  return (
    <div style={panelStyle()}>
      <div
        style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
      >
        <strong>Patch tests (sandbox)</strong>
        {workerProvider && (
          <span style={{ color: "#9aa7ba", fontSize: 12 }}>
            worker: <Badge value={workerProvider} />
          </span>
        )}
        <span style={{ color: "#9aa7ba", fontSize: 12 }}>
          apply patch → test trong workspace cô lập
        </span>
      </div>
      {inlineWarning && (
        <p style={{ color: "#e74c3c", margin: "6px 0 0", fontSize: 12 }}>
          ⚠ {inlineWarning}
        </p>
      )}

      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {canRunTests && (
          <button
            onClick={onRunTests}
            disabled={jobBusy || !hasValidatedPatch}
            style={btn("ghost")}
            title={
              !hasValidatedPatch ? "Cần Validate Patch trước" : undefined
            }
          >
            {jobBusy ? "..." : "Run Patch Tests in Sandbox"}
          </button>
        )}
        {canRunTests && job && active && (
          <button onClick={onCancelJob} disabled={jobBusy} style={btn("red")}>
            Cancel Job
          </button>
        )}
        {!canRunTests && (
          <span style={{ color: "#9aa7ba", fontSize: 12 }}>
            Role của bạn không có quyền chạy sandbox tests (ai:run_tests).
          </span>
        )}
      </div>
      {canRunTests && !hasValidatedPatch && (
        <p style={{ color: "#f0ad4e", margin: "8px 0 0", fontSize: 12 }}>
          ⚠ Cần <strong>Validate Patch</strong> trước khi chạy patch tests.
        </p>
      )}
      {needsRerun && (
        <p style={{ color: "#f0ad4e", margin: "8px 0 0", fontSize: 12 }}>
          ⚠ Patch đã được validate lại — job sandbox cũ không còn khớp. Cần{" "}
          <strong>chạy lại Patch Tests</strong>.
        </p>
      )}

      {job && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Badge value={job.status} />
            <code style={{ color: "#9aa7ba", fontSize: 12 }}>
              {job.job_type} · {job.id.slice(0, 8)}
            </code>
            {job.patch_set_id && (
              <span style={{ color: "#9aa7ba", fontSize: 12 }}>
                patch_set: <code>{job.patch_set_id.slice(0, 8)}</code>
              </span>
            )}
            {job.result?.patch_applied !== undefined && (
              <span style={{ color: "#9aa7ba", fontSize: 12 }}>
                patch_applied:{" "}
                <Badge value={job.result.patch_applied ? "pass" : "fail"} />
              </span>
            )}
            {job.result?.base_hash_checked !== undefined && (
              <span style={{ color: "#9aa7ba", fontSize: 12 }}>
                base_hash_checked:{" "}
                <Badge value={job.result.base_hash_checked ? "pass" : "fail"} />
              </span>
            )}
            {active && (
              <span style={{ color: "#9aa7ba", fontSize: 12 }}>polling…</span>
            )}
          </div>
          {baseMismatch && (
            <p style={{ color: "#e74c3c", margin: "6px 0 0", fontSize: 12 }}>
              ⚠ Base file đã thay đổi sau khi validate patch. Cần{" "}
              <strong>Validate Patch</strong> lại rồi chạy{" "}
              <strong>Patch Tests</strong> lại.
            </p>
          )}
          {job.result?.summary && (
            <p style={{ margin: "6px 0 0", fontSize: 13 }}>{job.result.summary}</p>
          )}
          {changed.length > 0 && (
            <div style={{ color: "#9aa7ba", fontSize: 12, marginTop: 4 }}>
              changed files ({changed.length}): {changed.slice(0, 8).join(", ")}
              {changed.length > 8 ? " …" : ""}
            </div>
          )}
          {job.result?.diff_summary && <Pre text={job.result.diff_summary} />}
          {(job.status === "failed" || job.status === "timed_out") && (
            <p style={{ color: "#e74c3c", margin: "6px 0 0", fontSize: 12 }}>
              {job.error_message
                ? job.error_message
                : failedCmd
                  ? `Failed on: ${failedCmd.command} (exit ${failedCmd.exitCode})`
                  : "Job did not pass."}
            </p>
          )}
          {logText && <Pre text={logText} />}
        </div>
      )}
    </div>
  );
}

function GithubPanel({
  canValidatePatch,
  canCreatePr,
  onValidatePatch,
  onCreatePr,
  prState,
  prLoading,
  createPrBlockedByWorker,
}: {
  canValidatePatch: boolean;
  canCreatePr: boolean;
  onValidatePatch: () => void;
  onCreatePr: () => void;
  prState: PrResult | null;
  prLoading: boolean;
  createPrBlockedByWorker: boolean;
}) {
  const isPr = prState?.mode !== undefined;
  return (
    <div style={panelStyle()}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <strong>GitHub PR</strong>
        <span style={{ color: "#9aa7ba", fontSize: 12 }}>
          validate → tạo PR (mặc định dry-run, không bao giờ auto-merge)
        </span>
      </div>
      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {canValidatePatch && (
          <button
            onClick={onValidatePatch}
            disabled={prLoading}
            style={btn("ghost")}
          >
            {prLoading ? "..." : "Validate Patch"}
          </button>
        )}
        {canCreatePr && (
          <button
            onClick={onCreatePr}
            disabled={prLoading || createPrBlockedByWorker}
            style={btn("primary")}
            title={
              createPrBlockedByWorker
                ? "Live mode: chạy sandbox tests và đợi job passed trước khi tạo PR."
                : undefined
            }
          >
            {prLoading ? "..." : "Create PR"}
          </button>
        )}
        {!canValidatePatch && !canCreatePr && (
          <span style={{ color: "#9aa7ba", fontSize: 12 }}>
            Role của bạn không có quyền validate patch / tạo PR.
          </span>
        )}
      </div>
      {createPrBlockedByWorker && (
        <p style={{ color: "#f0ad4e", margin: "8px 0 0", fontSize: 12 }}>
          ⚠ Live mode: cần chạy <strong>sandbox tests</strong> và đợi job{" "}
          <strong>passed</strong> trước khi tạo PR.
        </p>
      )}

      {prState && (
        <div
          style={{
            marginTop: 10,
            background: "#0b0f17",
            border: `1px solid ${prState.ok ? "#2ecc71" : "#e74c3c"}`,
            borderRadius: 8,
            padding: 12,
            fontSize: 13,
          }}
        >
          {prState.error && (
            <p style={{ color: "#e74c3c", margin: 0 }}>⚠ {prState.error}</p>
          )}

          {/* Pull-request result */}
          {isPr && prState.ok && prState.mode === "dry_run" && (
            <div>
              <Badge value="DRY RUN" /> <strong>no GitHub write.</strong>
              <div style={{ color: "#9aa7ba", marginTop: 4 }}>
                branch (dự kiến): <code>{prState.branchName}</code>
              </div>
            </div>
          )}
          {isPr && prState.ok && prState.mode === "live" && (
            <div>
              <Badge value="pass" /> PR đã tạo:{" "}
              {prState.prUrl ? (
                <a
                  href={prState.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#4f8cff" }}
                >
                  {prState.prUrl}
                </a>
              ) : (
                <code>{prState.branchName}</code>
              )}
            </div>
          )}
          {isPr && !prState.ok && (
            <div>
              <Badge value="fail" />{" "}
              <strong>
                {prState.blockedReason
                  ? (BLOCK_REASONS[prState.blockedReason] ?? prState.blockedReason)
                  : (prState.message ?? "PR bị chặn")}
              </strong>
            </div>
          )}

          {/* Validate result */}
          {!isPr && prState.patchSet && (
            <div>
              <Badge value={prState.ok ? "pass" : "fail"} />{" "}
              {prState.ok
                ? "Patch hợp lệ — sẵn sàng tạo PR."
                : "Patch không hợp lệ."}
            </div>
          )}

          {(prState.validationErrors?.length || prState.errors?.length) && (
            <ul style={{ margin: "8px 0 0", color: "#f0ad4e" }}>
              {(prState.validationErrors ?? prState.errors ?? []).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Render a patch artifact as a file list (path / action / reason / risk). */
function PatchArtifactView({ content }: { content: string }) {
  let parsed: ParsedPatch | null = null;
  try {
    const obj = JSON.parse(content);
    if (obj && Array.isArray(obj.files)) parsed = obj as ParsedPatch;
  } catch {
    parsed = null;
  }
  if (!parsed) return <Pre text={content} />;

  return (
    <div style={{ marginTop: 8 }}>
      {parsed.files.map((f, i) => (
        <div
          key={i}
          style={{
            background: "#0b0f17",
            border: "1px solid #263043",
            borderRadius: 8,
            padding: 10,
            marginBottom: 6,
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Badge value={f.action} />
            <code style={{ color: "#e6edf6" }}>{f.path}</code>
          </div>
          {f.reason && (
            <div style={{ color: "#9aa7ba", fontSize: 12, marginTop: 4 }}>
              {f.reason}
            </div>
          )}
        </div>
      ))}
      {parsed.risk_notes && parsed.risk_notes.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <strong style={{ color: "#f0ad4e", fontSize: 12 }}>Risk notes:</strong>
          <ul style={{ margin: "4px 0 0", color: "#f0ad4e", fontSize: 12 }}>
            {parsed.risk_notes.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function btn(kind: "primary" | "ghost" | "green" | "red"): React.CSSProperties {
  const base: React.CSSProperties = {
    border: "1px solid #263043",
    borderRadius: 8,
    padding: "8px 14px",
    cursor: "pointer",
    color: "#e6edf6",
    background: "#1b2433",
  };
  if (kind === "primary") return { ...base, background: "#4f8cff", color: "#0b0f17", fontWeight: 600 };
  if (kind === "green") return { ...base, background: "#2ecc71", color: "#0b0f17", fontWeight: 600 };
  if (kind === "red") return { ...base, background: "#e74c3c", color: "#0b0f17", fontWeight: 600 };
  return base;
}
