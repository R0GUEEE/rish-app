import type { ChatRole } from '../state';
import { formatBytes } from '../format/bytes';

/**
 * A conversation as the exporter reads it.
 *
 * This is deliberately structural rather than the full `Conversation`: a real
 * conversation is assignable to it, and a test can build one without the
 * turns, attempts and lifecycle records an export never reads. Exporting must
 * not require a conversation to be idle or otherwise well-formed.
 */
export type ExportableAttachment = {
  readonly name: string;
  readonly kind: string;
  readonly size: number;
};

export type ExportableMessage = {
  readonly role: ChatRole;
  readonly text: string;
  readonly attachments?: readonly ExportableAttachment[];
  readonly metadata?: {
    readonly modelId?: string;
    readonly reasoning?: string;
  };
};

export type ExportableConversation = {
  readonly title: string;
  readonly modelId: string;
  readonly createdAt: string;
  readonly messages: readonly ExportableMessage[];
};

/** How a role is named in an exported transcript. */
const ROLE_LABELS: Record<ChatRole, string> = {
  user: 'User',
  assistant: 'Assistant',
};

/**
 * The attachment line's size. The rule itself is shared with the usage sheet,
 * so a context and an attachment of the same size cannot round differently.
 */
export const formatAttachmentSize = formatBytes;

/**
 * One message as Markdown.
 *
 * Reasoning is model-internal and the app keeps it behind a toggle, so it is
 * exported folded shut: a reader who wants it can open it, and a reader who
 * does not is not made to scroll past it. Empty text is kept as an explicit
 * placeholder rather than dropped, because a message that existed and said
 * nothing is different from a message that is missing.
 */
function messageMarkdown(message: ExportableMessage): string {
  const lines: string[] = [`## ${ROLE_LABELS[message.role]}`, ''];

  const text = message.text.trim();
  lines.push(text.length > 0 ? message.text : '_No text._', '');

  const attachments = message.attachments ?? [];
  if (attachments.length > 0) {
    lines.push('**Attachments**', '');
    for (const attachment of attachments) {
      lines.push(
        `- \`${attachment.name}\` (${attachment.kind}, ${formatAttachmentSize(attachment.size)})`,
      );
    }
    lines.push('');
  }

  const reasoning = message.metadata?.reasoning?.trim();
  if (reasoning !== undefined && reasoning.length > 0) {
    lines.push(
      '<details>',
      '<summary>Reasoning</summary>',
      '',
      reasoning,
      '',
      '</details>',
      '',
    );
  }

  return lines.join('\n');
}

/**
 * The active conversation as a Markdown transcript.
 *
 * The output is a text artifact, not a round-trip format: nothing here is
 * re-imported, so it favours being readable over being parseable. It always
 * ends with exactly one newline so a file written from it is well-formed.
 */
export function conversationToMarkdown(
  conversation: ExportableConversation,
): string {
  const title = conversation.title.trim();
  const heading = title.length > 0 ? title : 'Untitled chat';
  const header = [
    `# ${heading}`,
    '',
    `- Model: \`${conversation.modelId}\``,
    `- Created: ${conversation.createdAt}`,
    `- Messages: ${conversation.messages.length}`,
    '',
  ];

  const body =
    conversation.messages.length === 0
      ? ['_This conversation has no messages._', '']
      : conversation.messages.map(messageMarkdown);

  const markdown = [...header, ...body].join('\n');
  return `${markdown.replace(/\n+$/u, '')}\n`;
}
