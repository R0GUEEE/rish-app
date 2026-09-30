import React, {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import FileImage from 'lucide-react-native/icons/file-image';
import FileText from 'lucide-react-native/icons/file-text';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import Sparkles from 'lucide-react-native/icons/sparkles';
import Check from 'lucide-react-native/icons/check';
import Copy from 'lucide-react-native/icons/copy';
import ThumbsDown from 'lucide-react-native/icons/thumbs-down';
import ThumbsUp from 'lucide-react-native/icons/thumbs-up';
import {
  type NativeScrollEvent,
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useAppPresentation } from '../presentation/AppPresentation';
import {
  providerForModel,
  type HarnessModelId,
  type ProviderId,
} from '../harness/types';
import type { AttachmentDescriptor } from '../state';
import type { MessageFeedbackRating } from '../preferences/types';
import { fonts, type ThemePalette } from '../theme';
import { StructuredContent, type StructuredBlock } from './StructuredContent';
import { InlineMarkdown } from './InlineMarkdown';
import { tokenizePlainLinks } from '../markdown/inline';
import { MarkdownText } from './MarkdownText';
import { AppIcon } from './AppIcon';
import {
  createMessageFollowController,
  type MessageFollowIndicator,
} from './messageFollow';

export type DisplayMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  modelId?: HarnessModelId;
  providerLabel?: string;
  meta?: string;
  blocks?: readonly StructuredBlock[];
  attachments?: readonly AttachmentDescriptor[];
};

const assistantProviderLabels = {
  deepseek: 'DEEPSEEK',
  anthropic: 'ANTHROPIC',
  openai: 'OPENAI',
  bigmodel: 'ZHIPU GLM',
} satisfies Record<ProviderId, string>;

type MessageListProps = {
  messages: DisplayMessage[];
  autoExpandTools?: boolean;
  onPreviewAttachment?: (id: string) => void;
  previewingAttachmentId?: string | null;
  showReasoning?: boolean;
  /** Copies one message's text. Omit to hide the control entirely. */
  onCopyMessage?: (message: DisplayMessage) => void;
  /**
   * Leaves, changes or clears a rating on an assistant message. Null clears.
   * Omit to hide the rating controls.
   */
  onFeedbackMessage?: (
    messageId: string,
    rating: MessageFeedbackRating | null,
  ) => void;
  /** The rating already left on a message, or null. */
  feedbackFor?: (messageId: string) => MessageFeedbackRating | null;
};

/**
 * The controls under one message.
 *
 * Copy is offered on both roles, because copying your own prompt back out is
 * as ordinary as copying the answer. Rating is offered only on an assistant
 * message, because there is nothing to rate about a prompt the person wrote
 * themselves. Both controls are absent -- not disabled -- when the screen that
 * owns the transcript passes no handler, so a read-only surface stays clean.
 */
function MessageActions({
  message,
  onCopyMessage,
  onFeedbackMessage,
  rating,
  copied,
}: {
  message: DisplayMessage;
  onCopyMessage?: (message: DisplayMessage) => void;
  onFeedbackMessage?: (
    messageId: string,
    rating: MessageFeedbackRating | null,
  ) => void;
  rating: MessageFeedbackRating | null;
  copied: boolean;
}) {
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (onCopyMessage === undefined && onFeedbackMessage === undefined) {
    return null;
  }
  const rate = (next: MessageFeedbackRating) =>
    onFeedbackMessage?.(message.id, rating === next ? null : next);
  // The assistant's own wording is "Copy response"; the person's own prompt is
  // just "Copy". Both were already in the translation table.
  const copyLabel = message.role === 'assistant'
    ? t('messages.copy')
    : t('messages.copyMessage');
  return (
    <View style={styles.actions}>
      {onCopyMessage !== undefined && (
        <Pressable
          accessibilityLabel={copied ? t('messages.copied') : copyLabel}
          accessibilityRole="button"
          onPress={() => onCopyMessage(message)}
          style={({ pressed }) => [
            styles.action,
            pressed && styles.actionPressed,
          ]}
          testID={`message-copy-${message.id}`}
        >
          <AppIcon
            color={copied ? colors.accent : colors.muted}
            icon={copied ? Check : Copy}
            size={14}
          />
          <Text style={[styles.actionText, copied && styles.actionTextActive]}>
            {copied ? t('messages.copied') : copyLabel}
          </Text>
        </Pressable>
      )}
      {onFeedbackMessage !== undefined && message.role === 'assistant' && (
        <>
          <Pressable
            accessibilityLabel={t('messages.goodResponse')}
            accessibilityRole="button"
            accessibilityState={{ selected: rating === 'up' }}
            onPress={() => rate('up')}
            style={({ pressed }) => [
              styles.action,
              pressed && styles.actionPressed,
            ]}
            testID={`message-feedback-up-${message.id}`}
          >
            <AppIcon
              color={rating === 'up' ? colors.accent : colors.muted}
              icon={ThumbsUp}
              size={14}
            />
          </Pressable>
          <Pressable
            accessibilityLabel={t('messages.badResponse')}
            accessibilityRole="button"
            accessibilityState={{ selected: rating === 'down' }}
            onPress={() => rate('down')}
            style={({ pressed }) => [
              styles.action,
              pressed && styles.actionPressed,
            ]}
            testID={`message-feedback-down-${message.id}`}
          >
            <AppIcon
              color={rating === 'down' ? colors.danger : colors.muted}
              icon={ThumbsDown}
              size={14}
            />
          </Pressable>
        </>
      )}
    </View>
  );
}

export const MessageList = React.forwardRef<
  React.ComponentRef<typeof ScrollView>,
  MessageListProps
>(function MessageList(
  {
    messages,
    autoExpandTools = false,
    onPreviewAttachment,
    previewingAttachmentId = null,
    showReasoning = true,
    onCopyMessage,
    onFeedbackMessage,
    feedbackFor,
  },
  forwardedRef,
) {
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  /**
   * Which message was copied most recently.
   *
   * Copy has no visible result of its own, so the control says "Copied"
   * instead of leaving a person to guess. It is deliberately not reset on a
   * timer: a checkmark that vanishes while it is being read is worse than one
   * that stays until the next copy.
   */
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const copyMessage = useMemo(
    () =>
      onCopyMessage === undefined
        ? undefined
        : (message: DisplayMessage) => {
            onCopyMessage(message);
            setCopiedMessageId(message.id);
          },
    [onCopyMessage],
  );
  const structuredLabels = useMemo(
    () => ({
      thinking: t('messages.thinking'),
      thoughtFor: (durationMs: number) =>
        t('messages.thoughtFor', { seconds: (durationMs / 1000).toFixed(1) }),
      toolCall: t('messages.toolCall'),
      toolResult: t('messages.toolResult'),
      show: t('messages.show'),
      hide: t('messages.hide'),
    }),
    [t],
  );
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  useImperativeHandle(forwardedRef, () => scroll.current!, []);
  const [indicator, setIndicator] = useState<MessageFollowIndicator>({
    visible: false,
    hasNewContent: false,
  });
  const [follow] = useState(() =>
    createMessageFollowController(
      animated => scroll.current?.scrollToEnd({ animated }),
      setIndicator,
    ),
  );
  useEffect(() => {
    follow.messagesChanged();
  }, [follow, messages]);
  useEffect(() => () => follow.dispose(), [follow]);
  const viewport = (event: NativeScrollEvent) => ({
    offset: event.contentOffset.y,
    contentHeight: event.contentSize.height,
    viewportHeight: event.layoutMeasurement.height,
  });

  return (
    <View style={styles.root}>
      <ScrollView
        testID="message-scroll"
        style={styles.scroll}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onContentSizeChange={(_width, height) => follow.layoutChanged(height)}
        onLayout={event =>
          follow.layoutChanged(undefined, event.nativeEvent.layout.height)
        }
        onScroll={event => follow.scrolled(viewport(event.nativeEvent))}
        onTouchStart={follow.touchStarted}
        onTouchEnd={follow.touchEnded}
        onTouchCancel={follow.touchEnded}
        onScrollBeginDrag={follow.dragStarted}
        onScrollEndDrag={event => follow.dragEnded(viewport(event.nativeEvent))}
        onMomentumScrollBegin={follow.momentumStarted}
        onMomentumScrollEnd={event =>
          follow.dragEnded(viewport(event.nativeEvent))
        }
        scrollEventThrottle={16}
        accessibilityLabel={t('messages.conversationLabel')}
        contentContainerStyle={styles.list}
        keyboardDismissMode="interactive"
        ref={scroll}
      >
        {messages.map(message =>
          message.role === 'user' ? (
            <View key={message.id} style={styles.userWrap}>
              {message.attachments !== undefined &&
                message.attachments.length > 0 && (
                  <View style={styles.attachments}>
                    {message.attachments.map(attachment => (
                      <Pressable
                        accessibilityLabel={t('messages.attachment.preview', {
                          name: attachment.name,
                        })}
                        accessibilityRole="button"
                        accessibilityState={{
                          busy: previewingAttachmentId === attachment.id,
                          disabled:
                            onPreviewAttachment === undefined ||
                            previewingAttachmentId !== null,
                        }}
                        disabled={
                          onPreviewAttachment === undefined ||
                          previewingAttachmentId !== null
                        }
                        key={attachment.id}
                        onPress={() => onPreviewAttachment?.(attachment.id)}
                        style={({ pressed }) => [
                          styles.attachment,
                          attachment.kind === 'image' &&
                            attachment.thumbnail_data_url !== undefined &&
                            styles.imageAttachment,
                          pressed && styles.attachmentPressed,
                        ]}
                      >
                        {attachment.kind === 'image' &&
                        attachment.thumbnail_data_url !== undefined ? (
                          <Image
                            resizeMode="cover"
                            source={{ uri: attachment.thumbnail_data_url }}
                            style={styles.image}
                          />
                        ) : (
                          <>
                            <View style={styles.fileBadge}>
                              <AppIcon
                                color={colors.accent}
                                icon={
                                  attachment.kind === 'image'
                                    ? FileImage
                                    : FileText
                                }
                                size={18}
                              />
                            </View>
                            <View style={styles.fileText}>
                              <Text numberOfLines={1} style={styles.fileName}>
                                {attachment.name}
                              </Text>
                              <Text style={styles.fileMeta}>
                                {attachment.mime_type}
                              </Text>
                            </View>
                          </>
                        )}
                        {previewingAttachmentId === attachment.id && (
                          <View style={styles.attachmentPreviewBusy}>
                            <ActivityIndicator
                              color={colors.text}
                              size="small"
                            />
                          </View>
                        )}
                      </Pressable>
                    ))}
                  </View>
                )}
              {message.text.length > 0 && (
                <InlineMarkdown selectable textStyle={styles.userText} tokens={tokenizePlainLinks(message.text)} />
              )}
              <MessageActions
                copied={copiedMessageId === message.id}
                message={message}
                onCopyMessage={copyMessage}
                rating={null}
              />
            </View>
          ) : (
            <View
              accessibilityLiveRegion="polite"
              key={message.id}
              style={styles.assistantWrap}
            >
              <View style={styles.assistantHeader}>
                <View style={styles.assistantMark}>
                  <AppIcon color={colors.accent} icon={Sparkles} size={13} />
                </View>
                <Text
                  testID={`assistant-provider-${message.id}`}
                  style={styles.role}
                >
                  {message.providerLabel ?? (message.modelId === undefined
                    ? t('messages.role.assistant')
                    : assistantProviderLabels[
                        providerForModel(message.modelId)
                      ])}
                </Text>
              </View>
              {message.blocks === undefined ? (
                <MarkdownText
                  attachments={message.attachments}
                  markdown={message.text}
                />
              ) : (
                <StructuredContent
                  attachments={message.attachments}
                  autoExpandTools={autoExpandTools}
                  blocks={message.blocks}
                  labels={structuredLabels}
                  showReasoning={showReasoning}
                />
              )}
              {message.meta !== undefined && (
                <Text style={styles.meta}>{message.meta}</Text>
              )}
              <MessageActions
                copied={copiedMessageId === message.id}
                message={message}
                onCopyMessage={copyMessage}
                onFeedbackMessage={onFeedbackMessage}
                rating={feedbackFor?.(message.id) ?? null}
              />
            </View>
          ),
        )}
      </ScrollView>
      {indicator.visible && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(
            indicator.hasNewContent
              ? 'messages.newContent'
              : 'messages.backToLatest',
          )}
          onPress={follow.jumpToLatest}
          style={styles.jump}
          testID="message-jump-latest"
        >
          <AppIcon color={colors.text} icon={ChevronDown} size={16} />
          <Text style={styles.jumpText}>
            {t(
              indicator.hasNewContent
                ? 'messages.newContent'
                : 'messages.backToLatest',
            )}
          </Text>
        </Pressable>
      )}
    </View>
  );
});

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    root: { flex: 1, minHeight: 0 },
    scroll: { flex: 1 },
    jump: {
      position: 'absolute',
      right: 18,
      bottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.surfaceRaised,
      borderColor: colors.line,
      borderWidth: 1,
      borderRadius: 18,
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    jumpText: { color: colors.text, fontSize: 12, fontWeight: '600' },
    list: { paddingHorizontal: 18, paddingTop: 23, paddingBottom: 26, gap: 24 },
    userWrap: {
      alignSelf: 'flex-end',
      maxWidth: '88%',
      borderRadius: 21,
      borderTopRightRadius: 7,
      backgroundColor: colors.surfaceRaised,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    assistantWrap: { alignSelf: 'stretch', paddingHorizontal: 2 },
    assistantHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 9,
    },
    assistantMark: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: colors.surfaceWarm,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 8,
    },
    role: {
      color: colors.accent,
      fontSize: 8,
      fontWeight: '800',
      letterSpacing: 1.5,
      marginBottom: 6,
    },
    userText: {
      color: colors.text,
      fontSize: 16,
      lineHeight: 23,
      fontFamily: fonts.body,
    },
    attachments: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 7,
      marginBottom: 8,
    },
    attachment: {
      minWidth: 150,
      maxWidth: 240,
      minHeight: 54,
      borderRadius: 13,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      backgroundColor: colors.surface,
      padding: 8,
      flexDirection: 'row',
      alignItems: 'center',
    },
    imageAttachment: {
      width: 160,
      height: 108,
      padding: 0,
      overflow: 'hidden',
    },
    attachmentPressed: { opacity: 0.7 },
    attachmentPreviewBusy: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      borderRadius: 13,
      backgroundColor: colors.scrim,
      alignItems: 'center',
      justifyContent: 'center',
    },
    image: { width: '100%', height: '100%' },
    fileBadge: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: colors.surfaceWarm,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 9,
    },
    fileText: { flex: 1, minWidth: 0 },
    fileName: { color: colors.text, fontSize: 11, fontWeight: '700' },
    fileMeta: { color: colors.muted, fontSize: 8, marginTop: 3 },
    meta: {
      color: colors.muted,
      fontFamily: fonts.mono,
      fontSize: 9,
      marginTop: 11,
    },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 9,
    },
    action: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      minHeight: 30,
      paddingHorizontal: 9,
      borderRadius: 11,
      backgroundColor: colors.surfaceWarm,
    },
    actionPressed: { opacity: 0.6 },
    actionText: { color: colors.muted, fontSize: 10, fontWeight: '700' },
    actionTextActive: { color: colors.accent },
  });
