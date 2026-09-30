import type { BuildInfo } from '../native/Diagnostics';
import type { Conversation, PersistedSessionEventV3 } from '../state/types';
import { harnessForModel } from '../harness/types';
import { recoveryCode } from '../components/recoveryMessage';

/** The screen's own failure state, as far as a report needs it. */
export type ErrorReportController = {
  readonly phase: string;
  readonly failureCode?: string | null;
  readonly failureDiagnostic?: string;
  readonly attemptId?: string | null;
  readonly roundId?: string | null;
};

export type ErrorReportInput = {
  readonly now: string;
  readonly build: BuildInfo | null;
  /** What the notice shows: a code, or a sentence the report reduces to its code. */
  readonly notice: string;
  readonly controller: ErrorReportController;
  readonly providerFailure: { readonly code: string; readonly httpStatus: number | null } | null;
  readonly conversation: Conversation | null;
  readonly sessionEvents: readonly PersistedSessionEventV3[];
};

const short = (id: string | null | undefined): string =>
  typeof id === 'string' && id.length >= 8 ? id.slice(0, 8) : '-';

/** Only closed, value-free tokens pass: codes, phases, tool names, numbers. */
const token = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z0-9_.:\-/]{1,80}$/u.test(value)
    ? value
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : value === null || value === undefined
        ? '-'
        : '?';

const MAX_EVENTS = 24;

/**
 * A plain-text report of the failure on screen, for a tester to paste rather
 * than send a screenshot that shows one code and nothing else.
 *
 * It says what the app knows about the failure and nothing a person wrote:
 * no message text, no file name or path, no tool arguments, no key, no relay
 * address. Every value is a code, a phase, a tool name, a count or the first
 * eight characters of an identifier -- enough to find the attempt in a
 * device's session data, and nothing to read in it.
 */
export function buildErrorReport(input: ErrorReportInput): string {
  const lines: string[] = [];
  const { build, controller, conversation } = input;
  lines.push('Rish diagnostics v1');
  lines.push(`time: ${token(input.now)}`);
  lines.push(build === null
    ? 'build: -'
    : `build: ${token(build.build)} · ${token(build.platform)} ${token(build.os)}${build.api === undefined ? '' : ` (API ${build.api})`} · ${build.device.replace(/[^A-Za-z0-9 _.\-]/gu, '').slice(0, 60)}`);
  const noticeCode = recoveryCode(input.notice);
  lines.push(`notice: ${noticeCode ?? '(no code)'}`);
  if (controller.failureDiagnostic !== undefined) {
    lines.push(`detail: ${controller.failureDiagnostic}`);
  }
  if (input.providerFailure !== null) {
    lines.push(`provider: ${token(input.providerFailure.code)}${input.providerFailure.httpStatus === null ? '' : ` HTTP ${input.providerFailure.httpStatus}`}`);
  }
  lines.push(`controller: phase=${token(controller.phase)} failure=${token(controller.failureCode ?? null)} attempt=${short(controller.attemptId)} round=${short(controller.roundId)}`);
  if (conversation === null) {
    lines.push('chat: -');
    return lines.join('\n');
  }
  lines.push(`chat: ${short(conversation.id)} harness=${token(harnessForModel(conversation.modelId))} model=${token(conversation.modelId)} thinking=${token(conversation.thinkingMode)} workspace=${conversation.workspaceId === null ? 'no' : 'yes'} project=${conversation.projectId === null || conversation.projectId === undefined ? 'no' : 'yes'} messages=${conversation.messages.length} turns=${conversation.turns.length}`);
  const attempts = conversation.attempts.slice(-3);
  for (const attempt of attempts) {
    const index = conversation.attempts.indexOf(attempt) + 1;
    lines.push(`attempt ${index}/${conversation.attempts.length} ${short(attempt.attemptId)}: status=${token(attempt.status)} failure=${token(attempt.failureCode)} harness=${token(attempt.harnessId)} model=${token(attempt.modelId)} thinking=${token(attempt.thinkingMode)} rounds=${attempt.rounds.length} journalRev=${token(attempt.journalRevision ?? null)}`);
    const journal = attempt.agent;
    if (journal !== undefined && journal !== null) {
      const lineage = journal.round_lineage;
      const calls = journal.batch
        .map(call => `${token(call.name)}:${token(call.approval_decision)}:${token(call.receipt?.outcome ?? null)}${call.receipt?.failure_code ? `:${token(call.receipt.failure_code)}` : ''}`)
        .join(',');
      lines.push(`  agent: phase=${token(journal.phase)} generation=${journal.controller_generation} round=${journal.round_index} lineage=${lineage === null ? '-' : `${token(lineage.status)} launch=${lineage.launch_attempt} rev=${token(lineage.native_row_revision)}`} calls=[${calls}] reserved=${journal.reserved_write_bytes}`);
    }
    const events = input.sessionEvents.filter(event => event.attempt_id === attempt.attemptId);
    if (events.length > 0) {
      const shown = events.slice(-MAX_EVENTS).map(event => {
        const record = event as unknown as Record<string, unknown>;
        return [
          token(record.kind),
          token(record.status),
          record.round_index === null || record.round_index === undefined ? null : `r${token(record.round_index)}`,
          record.failure_code === null || record.failure_code === undefined ? null : token(record.failure_code),
        ].filter(part => part !== null).join('/');
      });
      lines.push(`  events(${events.length}): ${shown.join(' · ')}`);
    }
  }
  return lines.join('\n');
}
