/**
 * Builds the only visible-history projection an Agent attempt may use.
 *
 * The attempt's frozen message-id order is authoritative. This module does
 * not read native state, mutate the Store, or hash an alternate JSON shape;
 * the digest is delegated to SessionPersistence.visibleHistorySHA256().
 */
import type { CompletionVisibleMessageV2 } from '../completion/types';
import { visibleHistorySHA256 } from '../completion/SessionPersistence';

type SourceRecord = Record<string, unknown>;

export type AgentVisibleHistoryConversation = {
  readonly messages: readonly unknown[];
};

export type AgentVisibleHistoryAttempt = {
  readonly visibleMessageIds: readonly string[];
};

export type AgentVisibleHistory = {
  readonly history: readonly CompletionVisibleMessageV2[];
  readonly digest: string;
  readonly count: number;
};

const MAX_VISIBLE_MESSAGES = 96;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 6;
const MAX_ATTACHMENTS_PER_HISTORY = 24;
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function plainRecord(value: unknown): SourceRecord | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    const output = Object.create(null) as SourceRecord;
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        descriptor.enumerable !== true
      ) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): SourceRecord | null {
  const record = plainRecord(value);
  if (record === null) return null;
  const allowed = new Set([...required, ...optional]);
  const names = Object.keys(record);
  if (
    names.some(name => !allowed.has(name)) ||
    required.some(name => !Object.prototype.hasOwnProperty.call(record, name))
  ) return null;
  return record;
}

function denseArray(value: unknown, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    if (Object.getOwnPropertySymbols(value).length > 0 || value.length > maximum) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      length === undefined ||
      !Object.prototype.hasOwnProperty.call(length, 'value') ||
      typeof length.value !== 'number' ||
      !Number.isSafeInteger(length.value) ||
      Object.is(length.value, -0) ||
      length.value !== value.length
    ) return null;
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        descriptor.enumerable !== true
      ) return null;
      output.push(descriptor.value);
    }
    if (
      Object.getOwnPropertyNames(value).some(
        name => name !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(name),
      )
    ) return null;
    return output;
  } catch {
    return null;
  }
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0);
}

function canonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function utf8ByteLength(value: string): number | null {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return null;
      bytes += 4;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return null;
    else bytes += 3;
  }
  return bytes;
}

function sourceAttachment(
  value: unknown,
  attachmentIds: Set<string>,
): CompletionVisibleMessageV2['attachments'][number] | null {
  const record = exactRecord(value, [
    'schema_version',
    'id',
    'kind',
    'name',
    'mime_type',
    'size',
  ], ['thumbnail_data_url']);
  if (
    record === null ||
    record.schema_version !== 1 ||
    typeof record.id !== 'string' ||
    !UUID.test(record.id) ||
    attachmentIds.has(record.id) ||
    (record.kind !== 'image' && record.kind !== 'text' && record.kind !== 'pdf') ||
    !boundedString(record.name, 512) ||
    !boundedString(record.mime_type, 128) ||
    typeof record.size !== 'number' ||
    !Number.isSafeInteger(record.size) ||
    Object.is(record.size, -0) ||
    record.size < 1 ||
    record.size > MAX_ATTACHMENT_BYTES
  ) return null;
  attachmentIds.add(record.id);
  return {
    schema_version: 1,
    id: record.id,
    kind: record.kind,
    name: record.name,
    mime_type: record.mime_type,
    size: record.size,
  };
}

function sourceMessage(
  value: unknown,
  messageIds: Set<string>,
  attachmentIds: Set<string>,
): { readonly id: string; readonly message: CompletionVisibleMessageV2 } | null {
  const record = exactRecord(value, [
    'id',
    'role',
    'text',
    'createdAt',
    'attachments',
  ], ['metadata']);
  if (
    record === null ||
    !boundedString(record.id, 256) ||
    messageIds.has(record.id) ||
    (record.role !== 'user' && record.role !== 'assistant') ||
    !boundedString(record.text, MAX_MESSAGE_BYTES, true) ||
    !canonicalTimestamp(record.createdAt)
  ) return null;
  const textBytes = utf8ByteLength(record.text);
  if (textBytes === null) return null;
  const attachmentsValue = denseArray(record.attachments, MAX_ATTACHMENTS_PER_MESSAGE);
  if (attachmentsValue === null) return null;
  const attachments: CompletionVisibleMessageV2['attachments'][number][] = [];
  for (const item of attachmentsValue) {
    const attachment = sourceAttachment(item, attachmentIds);
    if (attachment === null) return null;
    attachments.push(attachment);
  }
  if (
    (record.role === 'assistant' && attachments.length > 0) ||
    (record.role === 'assistant' && record.text.trim().length === 0) ||
    (record.role === 'user' && record.text.trim().length === 0 && attachments.length === 0)
  ) return null;
  messageIds.add(record.id);
  return {
    id: record.id,
    message: {
      role: record.role,
      content: record.text,
      attachments,
    },
  };
}

function freezeHistory(
  history: readonly CompletionVisibleMessageV2[],
): readonly CompletionVisibleMessageV2[] {
  return Object.freeze(
    history.map(message =>
      Object.freeze({
        role: message.role,
        content: message.content,
        attachments: Object.freeze(
          message.attachments.map(attachment => Object.freeze({ ...attachment })),
        ),
      }),
    ),
  );
}

/**
 * Projects the exact frozen attempt message-id sequence and computes its
 * purpose-specific `HJ(visible-history,{messages})` digest.
 */
export function projectAgentVisibleHistory(
  conversation: AgentVisibleHistoryConversation,
  attempt: AgentVisibleHistoryAttempt,
): AgentVisibleHistory | null {
  try {
    const messages = denseArray(conversation.messages, 100_000);
    const visibleIds = denseArray(attempt.visibleMessageIds, MAX_VISIBLE_MESSAGES);
    if (messages === null || visibleIds === null) return null;
    const byId = new Map<string, CompletionVisibleMessageV2>();
    const messageIds = new Set<string>();
    const attachmentIds = new Set<string>();
    let totalBytes = 0;
    let totalAttachments = 0;
    for (const source of messages) {
      const projected = sourceMessage(source, messageIds, attachmentIds);
      if (projected === null) return null;
      totalBytes += utf8ByteLength(projected.message.content) ?? Number.MAX_SAFE_INTEGER;
      totalAttachments += projected.message.attachments.length;
      if (totalBytes > MAX_HISTORY_BYTES || totalAttachments > MAX_ATTACHMENTS_PER_HISTORY) return null;
      byId.set(projected.id, projected.message);
    }
    const ids = visibleIds.map(value => value);
    const seenVisible = new Set<string>();
    const history: CompletionVisibleMessageV2[] = [];
    for (const idValue of ids) {
      if (!boundedString(idValue, 256) || seenVisible.has(idValue)) return null;
      const message = byId.get(idValue);
      if (message === undefined) return null;
      seenVisible.add(idValue);
      history.push(message);
    }
    const frozen = freezeHistory(history);
    const digest = visibleHistorySHA256(frozen);
    if (digest === null) return null;
    return Object.freeze({ history: frozen, digest, count: frozen.length });
  } catch {
    return null;
  }
}

export const buildAgentVisibleHistory = projectAgentVisibleHistory;
export const projectFrozenAttemptVisibleHistory = projectAgentVisibleHistory;
export const getAgentVisibleHistory = projectAgentVisibleHistory;

export function assertAgentVisibleHistory(
  conversation: AgentVisibleHistoryConversation,
  attempt: AgentVisibleHistoryAttempt,
): AgentVisibleHistory {
  const result = projectAgentVisibleHistory(conversation, attempt);
  if (result === null) throw new Error('E_COMPLETION_HISTORY');
  return result;
}
