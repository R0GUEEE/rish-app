import type { AgentApprovalPreviewV1 } from '../native/AgentRuntime';
import {
  APPROVAL_SCOPE_VALUES,
  type ApprovalResolutionValue,
  type ApprovalScopeValue,
  type SessionEventDraft,
  type SessionEventV1,
} from './SessionEvents';

/**
 * DSH-style approval protocol for agent tool calls.
 *
 * A gated tool call is frozen until the user answers an approval request.
 * Every request and every settlement is recorded in the same SessionEvent
 * trajectory as the tool round, so the allow/deny history replays in order
 * across restarts. The resolver below is fail-closed: anything other than a
 * fully well-formed "approved" answer — including a missing, malformed,
 * mismatched, or expired answer — resolves to a denial. Approval is never
 * assumed.
 */

export const APPROVAL_SCOPES: readonly ApprovalScopeValue[] =
  APPROVAL_SCOPE_VALUES;

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000 as const;

export type ApprovalRequestSpec = {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  /** Bounded native-computed display preview: workspace-relative paths, byte
   * sizes, and the write_file diff preview. Never raw model text. */
  readonly preview: AgentApprovalPreviewV1 | null;
  /** Scopes offered to the user; validated before the request is emitted. */
  readonly scopes: readonly ApprovalScopeValue[];
  /** Fail-closed deadline: any settlement after this is a timeout denial. */
  readonly expiresAtMs: number;
};

export type ApprovalResolution = ApprovalResolutionValue;

export type ApprovalDecision =
  | { readonly status: 'approved'; readonly scope: ApprovalScopeValue }
  | { readonly status: 'denied'; readonly resolution: ApprovalResolution };

/**
 * Raw answer from the UI/dependency, typed as unknown so the resolver —
 * not the caller — decides what a well-formed answer looks like.
 */
export type RawApprovalAnswer = unknown;

export function approvalScopeValues(json: string): readonly ApprovalScopeValue[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const scopes: ApprovalScopeValue[] = [];
  const seen = new Set<string>();
  for (const value of parsed) {
    if (
      typeof value !== 'string' ||
      !APPROVAL_SCOPES.includes(value as ApprovalScopeValue) ||
      seen.has(value)
    ) {
      return null;
    }
    seen.add(value);
    scopes.push(value as ApprovalScopeValue);
  }
  return scopes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fail-closed settlement of one approval request.
 *
 * Order matters: expiry is checked first so a slow answer can never turn
 * into an approval; then missing/malformed/mismatched answers all collapse
 * to a denial with an honest resolution tag for the trajectory.
 */
export function resolveApprovalDecision(
  spec: ApprovalRequestSpec,
  raw: RawApprovalAnswer,
  nowMs: number,
): ApprovalDecision {
  if (nowMs >= spec.expiresAtMs) {
    return { status: 'denied', resolution: 'timeout' };
  }
  if (raw === undefined || raw === null) {
    return { status: 'denied', resolution: 'missing' };
  }
  if (!isRecord(raw)) {
    return { status: 'denied', resolution: 'invalid' };
  }
  if (raw.approval_id !== spec.approvalId) {
    return { status: 'denied', resolution: 'invalid' };
  }
  if (raw.status !== 'approved' && raw.status !== 'denied') {
    return { status: 'denied', resolution: 'invalid' };
  }
  if (raw.status === 'denied') {
    return { status: 'denied', resolution: 'user' };
  }
  if (
    typeof raw.scope !== 'string' ||
    !spec.scopes.includes(raw.scope as ApprovalScopeValue)
  ) {
    return { status: 'denied', resolution: 'invalid' };
  }
  return { status: 'approved', scope: raw.scope as ApprovalScopeValue };
}

/** The trajectory row emitted before the user is asked. */
export function approvalRequestDraft(spec: ApprovalRequestSpec): SessionEventDraft {
  return {
    kind: 'approval_request',
    approval_id: spec.approvalId,
    tool_call_id: spec.toolCallId,
    tool_name: spec.toolName,
    arguments_json: spec.argumentsJson,
    approval_scopes_json: JSON.stringify(spec.scopes),
  };
}

/** The trajectory row emitted after settlement — including fail-closed denials. */
export function approvalResponseDraft(
  spec: ApprovalRequestSpec,
  decision: ApprovalDecision,
): SessionEventDraft {
  if (decision.status === 'approved') {
    return {
      kind: 'approval_response',
      approval_id: spec.approvalId,
      approval_decision: 'approved',
      approval_scope: decision.scope,
      approval_resolution: 'user',
    };
  }
  return {
    kind: 'approval_response',
    approval_id: spec.approvalId,
    approval_decision: 'denied',
    approval_resolution: decision.resolution,
  };
}

/**
 * Restart-replay view: approval requests that were recorded for one attempt
 * but never got a response. Anything resuming this attempt must treat these
 * as denied — fail-closed, never assumed-approved.
 */
export function unansweredApprovalRequests(
  log: readonly SessionEventV1[],
  attemptId: string,
): readonly SessionEventV1[] {
  const answered = new Set<string>();
  for (const event of log) {
    if (
      event.attempt_id === attemptId &&
      event.kind === 'approval_response' &&
      event.approval_id !== undefined
    ) {
      answered.add(event.approval_id);
    }
  }
  return log.filter(
    event =>
      event.attempt_id === attemptId &&
      event.kind === 'approval_request' &&
      event.approval_id !== undefined &&
      !answered.has(event.approval_id),
  );
}

/**
 * Restart-replay view: unanswered questions for one attempt. A resuming
 * loop must never invent answers — these are re-denied (treated as no
 * answer) rather than re-asked, because the request already happened once.
 */
export function unansweredQuestions(
  log: readonly SessionEventV1[],
  attemptId: string,
): readonly SessionEventV1[] {
  const answered = new Set<string>();
  for (const event of log) {
    if (
      event.attempt_id === attemptId &&
      event.kind === 'question_response' &&
      event.question_id !== undefined
    ) {
      answered.add(event.question_id);
    }
  }
  return log.filter(
    event =>
      event.attempt_id === attemptId &&
      event.kind === 'question' &&
      event.question_id !== undefined &&
      !answered.has(event.question_id),
  );
}
