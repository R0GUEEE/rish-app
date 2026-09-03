import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import BrainCircuit from 'lucide-react-native/icons/brain-circuit';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import CircleX from 'lucide-react-native/icons/circle-x';
import Clock from 'lucide-react-native/icons/clock';
import LoaderCircle from 'lucide-react-native/icons/loader-circle';

import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, type ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';
import { MarkdownText } from './MarkdownText';

export type StructuredBlock =
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'reasoning'; text: string; durationMs?: number }
  | {
      id: string;
      type: 'tool-call';
      name: string;
      arguments: string;
      status: 'pending' | 'running' | 'success' | 'error' | 'cancelled';
    }
  | {
      id: string;
      type: 'tool-result';
      name: string;
      output: string;
      isError?: boolean;
      durationMs?: number;
    };

type LabelOverrides = {
  thinking: string;
  thoughtFor: (durationMs: number) => string;
  toolCall: string;
  toolResult: string;
};

type Labels = LabelOverrides & {
  showReasoning: string;
  hideReasoning: string;
  expandTool: (tool: string, kind: string) => string;
  collapseTool: (tool: string, kind: string) => string;
  status: (
    status: Extract<StructuredBlock, { type: 'tool-call' }>['status'],
  ) => string;
  toolAnnouncement: (
    tool: string,
    status: Extract<StructuredBlock, { type: 'tool-call' }>['status'],
  ) => string;
  toolCompleted: (tool: string) => string;
  toolFailed: (tool: string) => string;
  complete: string;
  duration: (durationMs: number) => string;
  noOutput: string;
};

export function StructuredContent({
  blocks,
  autoExpandTools = false,
  showReasoning = true,
  labels: labelOverrides,
}: {
  blocks: readonly StructuredBlock[];
  autoExpandTools?: boolean;
  showReasoning?: boolean;
  labels?: LabelOverrides;
}) {
  const { t } = useAppPresentation();
  const labels = useMemo<Labels>(
    () => ({
      thinking: labelOverrides?.thinking ?? t('messages.thinking'),
      thoughtFor:
        labelOverrides?.thoughtFor ??
        (durationMs =>
          t('messages.thoughtFor', {
            seconds: (durationMs / 1000).toFixed(1),
          })),
      toolCall: labelOverrides?.toolCall ?? t('messages.toolCall'),
      toolResult: labelOverrides?.toolResult ?? t('messages.toolResult'),
      showReasoning: t('messages.showReasoning'),
      hideReasoning: t('messages.hideReasoning'),
      expandTool: (tool, kind) => t('messages.expandTool', { kind, tool }),
      collapseTool: (tool, kind) => t('messages.collapseTool', { kind, tool }),
      status: status => {
        switch (status) {
          case 'pending':
            return t('messages.status.pending');
          case 'running':
            return t('messages.status.running');
          case 'success':
            return t('messages.status.success');
          case 'error':
            return t('messages.status.error');
          case 'cancelled':
            return t('messages.status.cancelled');
        }
      },
      toolAnnouncement: (tool, status) => {
        switch (status) {
          case 'pending':
            return t('messages.toolPending', { tool });
          case 'running':
            return t('messages.toolRunning', { tool });
          case 'success':
            return t('messages.toolCompleted', { tool });
          case 'error':
            return t('messages.toolFailed', { tool });
          case 'cancelled':
            return t('messages.toolCancelled', { tool });
        }
      },
      toolCompleted: tool => t('messages.toolCompleted', { tool }),
      toolFailed: tool => t('messages.toolFailed', { tool }),
      complete: t('messages.status.complete'),
      duration: durationMs =>
        t('messages.durationMs', { milliseconds: durationMs }),
      noOutput: t('messages.noToolOutput'),
    }),
    [labelOverrides, t],
  );
  const styles = useStyles();
  return (
    <View style={styles.root}>
      {blocks.map(block => {
        if (block.type === 'text') {
          return <MarkdownText key={block.id} markdown={block.text} />;
        }
        if (block.type === 'reasoning') {
          return showReasoning ? (
            <ReasoningBlock block={block} key={block.id} labels={labels} />
          ) : null;
        }
        return (
          <ToolBlock
            autoExpand={autoExpandTools}
            block={block}
            key={block.id}
            labels={labels}
          />
        );
      })}
    </View>
  );
}

function ReasoningBlock({
  block,
  labels,
}: {
  block: Extract<StructuredBlock, { type: 'reasoning' }>;
  labels: Labels;
}) {
  const { colors } = useAppPresentation();
  const styles = useStyles();
  const [expanded, setExpanded] = useState(false);
  const caption =
    block.durationMs === undefined
      ? labels.thinking
      : labels.thoughtFor(block.durationMs);
  return (
    <View style={styles.reasoningWrap}>
      <Pressable
        accessibilityLabel={
          expanded ? labels.hideReasoning : labels.showReasoning
        }
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(value => !value)}
        style={({ pressed }) => [styles.blockHeader, pressed && styles.pressed]}
      >
        <View style={styles.reasoningGlyph}>
          <AppIcon
            color={colors.accent}
            icon={BrainCircuit}
            size={16}
            testID="reasoning-icon"
          />
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.blockEyebrow}>
            {labels.thinking.toLocaleUpperCase()}
          </Text>
          <Text
            accessibilityLabel={caption}
            accessibilityLiveRegion="polite"
            accessibilityRole={Platform.OS === 'android' ? 'text' : 'status'}
            style={styles.blockCaption}
          >
            {caption}
          </Text>
        </View>
        <AppIcon
          color={colors.faint}
          icon={expanded ? ChevronUp : ChevronDown}
          size={16}
          style={styles.chevron}
        />
      </Pressable>
      {expanded && (
        <Text selectable style={styles.reasoningText}>
          {block.text}
        </Text>
      )}
    </View>
  );
}

function ToolBlock({
  autoExpand,
  block,
  labels,
}: {
  autoExpand: boolean;
  block: Extract<StructuredBlock, { type: 'tool-call' | 'tool-result' }>;
  labels: Labels;
}) {
  const { colors } = useAppPresentation();
  const styles = useStyles();
  const [expanded, setExpanded] = useState(autoExpand);
  useEffect(() => {
    setExpanded(autoExpand);
  }, [autoExpand]);
  const isCall = block.type === 'tool-call';
  const failed = isCall ? block.status === 'error' : block.isError === true;
  const running = isCall && block.status === 'running';
  const pending = isCall && block.status === 'pending';
  const cancelled = isCall && block.status === 'cancelled';
  const succeeded = isCall ? block.status === 'success' : !failed;
  const detail = isCall ? block.arguments : block.output;
  const caption = isCall
    ? labels.status(block.status)
    : failed
    ? labels.status('error')
    : block.durationMs === undefined
    ? labels.complete
    : labels.duration(block.durationMs);
  const announcement = isCall
    ? labels.toolAnnouncement(block.name, block.status)
    : failed
    ? labels.toolFailed(block.name)
    : labels.toolCompleted(block.name);
  const kind = (
    isCall ? labels.toolCall : labels.toolResult
  ).toLocaleLowerCase();
  const StatusIcon = failed
    ? CircleAlert
    : cancelled
    ? CircleX
    : succeeded
    ? CircleCheck
    : running
    ? LoaderCircle
    : Clock;
  const statusIconColor = failed
    ? colors.danger
    : running
    ? colors.warning
    : pending || cancelled
    ? colors.muted
    : colors.success;
  const statusIconName = failed
    ? 'error'
    : cancelled
    ? 'cancelled'
    : succeeded
    ? 'success'
    : running
    ? 'running'
    : 'pending';
  return (
    <View style={[styles.toolWrap, failed && styles.toolWrapFailed]}>
      <Pressable
        accessibilityLabel={
          expanded
            ? labels.collapseTool(block.name, kind)
            : labels.expandTool(block.name, kind)
        }
        accessibilityRole="button"
        accessibilityState={{ busy: running, expanded }}
        onPress={() => setExpanded(value => !value)}
        style={({ pressed }) => [styles.blockHeader, pressed && styles.pressed]}
      >
        <View
          style={[
            styles.toolGlyph,
            running && styles.toolGlyphRunning,
            failed && styles.toolGlyphFailed,
          ]}
        >
          <AppIcon
            color={statusIconColor}
            icon={StatusIcon}
            size={15}
            testID={`tool-status-${statusIconName}`}
          />
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.blockEyebrow}>
            {(isCall ? labels.toolCall : labels.toolResult).toLocaleUpperCase()}
          </Text>
          <Text numberOfLines={1} style={styles.toolName}>
            {block.name}
          </Text>
        </View>
        <Text
          accessibilityLabel={announcement}
          accessibilityLiveRegion={failed ? 'assertive' : 'polite'}
          accessibilityRole={failed ? 'alert' : Platform.OS === 'android' ? 'text' : 'status'}
          style={[
            styles.status,
            succeeded && styles.statusSucceeded,
            running && styles.statusRunning,
            failed && styles.statusFailed,
          ]}
        >
          {caption}
        </Text>
        <AppIcon
          color={colors.faint}
          icon={expanded ? ChevronUp : ChevronDown}
          size={16}
          style={styles.chevron}
        />
      </Pressable>
      {expanded && (
        <Text
          selectable
          style={[styles.toolDetail, failed && styles.toolDetailFailed]}
        >
          {detail || labels.noOutput}
        </Text>
      )}
    </View>
  );
}

function useStyles() {
  const { colors } = useAppPresentation();
  return useMemo(() => createStyles(colors), [colors]);
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    root: { gap: 12 },
    reasoningWrap: {
      borderLeftWidth: 2,
      borderLeftColor: colors.accentSoft,
      paddingLeft: 11,
    },
    toolWrap: {
      borderRadius: 15,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      overflow: 'hidden',
    },
    toolWrapFailed: {
      borderColor: colors.danger,
      backgroundColor: colors.surfaceWarm,
    },
    blockHeader: {
      minHeight: 49,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 11,
      paddingVertical: 8,
    },
    reasoningGlyph: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: colors.surfaceWarm,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 9,
    },
    toolGlyph: {
      width: 30,
      height: 30,
      borderRadius: 9,
      backgroundColor: colors.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 9,
    },
    toolGlyphRunning: { backgroundColor: colors.surfaceWarm },
    toolGlyphFailed: { backgroundColor: colors.surfaceWarm },
    headerCopy: { flex: 1 },
    blockEyebrow: {
      color: colors.faint,
      fontSize: 7,
      fontWeight: '800',
      letterSpacing: 1.3,
    },
    blockCaption: { color: colors.muted, fontSize: 10, marginTop: 3 },
    toolName: {
      color: colors.textDim,
      fontFamily: fonts.mono,
      fontSize: 11,
      marginTop: 3,
    },
    status: {
      color: colors.muted,
      fontFamily: fonts.mono,
      fontSize: 8,
      marginLeft: 8,
    },
    statusSucceeded: { color: colors.success },
    statusRunning: { color: colors.warning },
    statusFailed: { color: colors.danger },
    chevron: { marginLeft: 8 },
    reasoningText: {
      color: colors.muted,
      fontFamily: fonts.body,
      fontSize: 13,
      lineHeight: 20,
      paddingBottom: 8,
    },
    toolDetail: {
      color: colors.textDim,
      fontFamily: fonts.mono,
      fontSize: 11,
      lineHeight: 17,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
      padding: 12,
    },
    toolDetailFailed: { color: colors.danger, borderTopColor: colors.danger },
    pressed: { opacity: 0.58 },
  });
