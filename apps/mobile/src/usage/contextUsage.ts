/**
 * What the app can actually say about token usage.
 *
 * It is less than a usage screen usually means, and the difference matters.
 * There is no per-round token accounting anywhere in this app: the native
 * transports discard the provider's `usage` object, and the shared core never
 * parses it. There is also no price table, and no cost data of any kind.
 *
 * What does exist is the project-context snapshot. When a conversation
 * attaches a project, the snapshot records how many bytes of context it
 * selected and an estimate of the tokens those bytes are worth. That estimate
 * is derived -- `ceil(context_bytes / 4)` -- and the schema validates it to be
 * exactly that, so it is reported here as an estimate and never as billed
 * usage. Model tokens and cost are absent because they are not recorded, and
 * inventing them would be worse than showing nothing.
 */
export type ContextUsageEntry = {
  readonly conversationId: string;
  readonly conversationTitle: string;
  readonly projectName: string;
  readonly model: string;
  readonly capturedAt: string;
  readonly contextBytes: number;
  readonly estimatedTokens: number;
  readonly includedFiles: number;
  readonly omittedFiles: number;
};

/** One model's share of the estimates, so a per-model view is possible. */
export type ContextUsageModelTotal = {
  /** The model the snapshot recorded; empty when it recorded none. */
  readonly model: string;
  readonly conversations: number;
  readonly estimatedTokens: number;
  readonly contextBytes: number;
};

export type ContextUsageSummary = {
  readonly entries: readonly ContextUsageEntry[];
  /** Conversations carrying a context snapshot; the rest contribute nothing. */
  readonly conversations: number;
  readonly totalContextBytes: number;
  readonly totalEstimatedTokens: number;
  readonly includedFiles: number;
  readonly omittedFiles: number;
  /** The same totals grouped by the model each snapshot was captured for. */
  readonly byModel: readonly ContextUsageModelTotal[];
};

/** The manifest fields this reads, structurally, so no union shape can break it. */
type Manifest = {
  readonly project_name?: unknown;
  readonly model?: unknown;
  readonly captured_at?: unknown;
  readonly context_bytes?: unknown;
  readonly estimated_tokens?: unknown;
  readonly included?: unknown;
  readonly omitted?: unknown;
};

export type UsageConversation = {
  readonly id: string;
  readonly title: string;
  readonly projectContext?: {
    readonly status?: unknown;
    readonly manifest?: Manifest | null;
  } | null;
};

const EMPTY: ContextUsageSummary = Object.freeze({
  entries: Object.freeze([]),
  conversations: 0,
  totalContextBytes: 0,
  totalEstimatedTokens: 0,
  includedFiles: 0,
  omittedFiles: 0,
  byModel: Object.freeze([]),
});

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * A byte count that could have come from a manifest.
 *
 * Only non-negative safe integers count. A value that is not one is treated as
 * absent rather than coerced to zero, so a malformed snapshot understates the
 * totals instead of silently claiming the context was empty.
 */
function bytes(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * One conversation's contribution, or null when it has no readable snapshot.
 *
 * A conversation whose context is not `ready` is not counted: a snapshot that
 * was never confirmed, or has since gone stale, is not context that was sent.
 */
export function contextUsageEntry(
  conversation: UsageConversation,
): ContextUsageEntry | null {
  const context = conversation.projectContext;
  if (context === null || context === undefined) return null;
  if (context.status !== 'ready') return null;
  const manifest = context.manifest;
  if (manifest === null || manifest === undefined) return null;
  const contextBytes = bytes(manifest.context_bytes);
  const estimatedTokens = bytes(manifest.estimated_tokens);
  if (contextBytes === null && estimatedTokens === null) return null;
  return {
    conversationId: conversation.id,
    conversationTitle: text(conversation.title, conversation.id),
    projectName: text(manifest.project_name, conversation.title),
    model: text(manifest.model, ''),
    capturedAt: text(manifest.captured_at, ''),
    contextBytes: contextBytes ?? 0,
    estimatedTokens: estimatedTokens ?? 0,
    includedFiles: count(manifest.included),
    omittedFiles: count(manifest.omitted),
  };
}

/**
 * Every conversation that carries context, most recently captured first.
 *
 * Ties fall back to the conversation id so the order is stable rather than
 * dependent on the order conversations happened to be stored in.
 */
export function summarizeContextUsage(
  conversations: readonly UsageConversation[],
): ContextUsageSummary {
  const entries = conversations
    .map(contextUsageEntry)
    .filter((entry): entry is ContextUsageEntry => entry !== null)
    .sort(
      (left, right) =>
        right.capturedAt.localeCompare(left.capturedAt) ||
        left.conversationId.localeCompare(right.conversationId),
    );
  if (entries.length === 0) return EMPTY;
  return {
    entries,
    conversations: entries.length,
    totalContextBytes: entries.reduce(
      (total, entry) => total + entry.contextBytes,
      0,
    ),
    totalEstimatedTokens: entries.reduce(
      (total, entry) => total + entry.estimatedTokens,
      0,
    ),
    includedFiles: entries.reduce((total, entry) => total + entry.includedFiles, 0),
    omittedFiles: entries.reduce((total, entry) => total + entry.omittedFiles, 0),
    byModel: perModelTotals(entries),
  };
}

/**
 * The same entries grouped by model, heaviest first.
 *
 * Ties break on the model name so the order is stable rather than following
 * whichever conversation happened to be read first. A snapshot that recorded
 * no model is grouped under the empty string rather than dropped: its tokens
 * were still spent, and hiding them would make the parts disagree with the
 * total above them.
 */
function perModelTotals(
  entries: readonly ContextUsageEntry[],
): readonly ContextUsageModelTotal[] {
  const totals = new Map<string, ContextUsageModelTotal>();
  for (const entry of entries) {
    const existing = totals.get(entry.model);
    totals.set(entry.model, {
      model: entry.model,
      conversations: (existing?.conversations ?? 0) + 1,
      estimatedTokens: (existing?.estimatedTokens ?? 0) + entry.estimatedTokens,
      contextBytes: (existing?.contextBytes ?? 0) + entry.contextBytes,
    });
  }
  return [...totals.values()].sort(
    (left, right) =>
      right.estimatedTokens - left.estimatedTokens ||
      left.model.localeCompare(right.model),
  );
}
