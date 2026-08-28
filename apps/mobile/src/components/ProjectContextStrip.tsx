import React, { useMemo, useRef } from 'react';
import type { LucideIcon } from 'lucide-react-native';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CircleOff from 'lucide-react-native/icons/circle-off';
import FileCheck2 from 'lucide-react-native/icons/file-check-2';
import FileClock from 'lucide-react-native/icons/file-clock';
import FolderCog from 'lucide-react-native/icons/folder-cog';
import LoaderCircle from 'lucide-react-native/icons/loader-circle';
import ShieldCheck from 'lucide-react-native/icons/shield-check';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  isProjectContextSendable,
  type ProjectContextState,
  type ProjectContextStatus,
} from '../project-context';
import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, hitSlop, type ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';

export const PROJECT_CONTEXT_MAX_BYTES = 256 * 1024;

type EffectiveStatus =
  | ProjectContextStatus
  | 'review_required'
  | 'review_partial'
  | 'ready_partial';

export type ProjectContextStripProps = {
  readonly checking?: boolean;
  readonly disabled?: boolean;
  readonly projectName: string;
  readonly state: ProjectContextState;
  readonly onPress: () => void;
};

function effectiveStatus(
  state: ProjectContextState,
  checking: boolean,
): EffectiveStatus {
  if (checking) return 'checking';
  if (state.errorCode !== null) return 'error';
  if (state.staleReason !== null) return 'stale';
  if (state.status === 'setup_required' && state.snapshot !== null) {
    return 'review_required';
  }
  if (state.status === 'ready') {
    return isProjectContextSendable(state) ? 'ready' : 'review_required';
  }
  if (state.status === 'partial') {
    return isProjectContextSendable(state)
      ? 'ready_partial'
      : 'review_partial';
  }
  return state.status;
}

function statusKey(status: EffectiveStatus) {
  switch (status) {
    case 'setup_required':
      return 'context.strip.status.setupRequired' as const;
    case 'review_required':
      return 'context.strip.status.reviewRequired' as const;
    case 'checking':
      return 'context.strip.status.checking' as const;
    case 'ready':
      return 'context.strip.status.ready' as const;
    case 'stale':
      return 'context.strip.status.stale' as const;
    case 'partial':
      return 'context.strip.status.partial' as const;
    case 'review_partial':
      return 'context.strip.status.reviewPartial' as const;
    case 'ready_partial':
      return 'context.strip.status.readyPartial' as const;
    case 'error':
      return 'context.strip.status.error' as const;
    case 'unavailable':
      return 'context.strip.status.unavailable' as const;
  }
}

function statusIcon(status: EffectiveStatus): LucideIcon {
  switch (status) {
    case 'setup_required':
      return FolderCog;
    case 'review_required':
    case 'review_partial':
      return FileClock;
    case 'checking':
      return LoaderCircle;
    case 'ready':
    case 'ready_partial':
      return ShieldCheck;
    case 'partial':
      return FileCheck2;
    case 'stale':
      return TriangleAlert;
    case 'error':
      return CircleAlert;
    case 'unavailable':
      return CircleOff;
  }
}

function statusColor(status: EffectiveStatus, colors: ThemePalette): string {
  switch (status) {
    case 'ready':
    case 'ready_partial':
      return colors.success;
    case 'checking':
    case 'setup_required':
    case 'review_required':
    case 'review_partial':
    case 'partial':
      return colors.warning;
    case 'stale':
    case 'error':
    case 'unavailable':
      return colors.danger;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kibibytes = bytes / 1024;
  if (kibibytes < 1024) {
    const value = Number.isInteger(kibibytes)
      ? String(kibibytes)
      : kibibytes.toFixed(1);
    return `${value} KB`;
  }
  const mebibytes = kibibytes / 1024;
  const value = Number.isInteger(mebibytes)
    ? String(mebibytes)
    : mebibytes.toFixed(1);
  return `${value} MB`;
}

function uniqueIncludedPathCount(state: ProjectContextState): number {
  if (state.snapshot === null) return new Set(state.selectedPaths).size;
  return new Set(state.snapshot.included.map(item => item.path)).size;
}

function changedPathCount(state: ProjectContextState): number {
  if (
    state.snapshot === null ||
    state.snapshot.clean ||
    state.snapshot.conflicted
  ) {
    return 0;
  }
  return new Set(
    state.snapshot.included
      .filter(item => item.source !== 'tracked_file')
      .map(item => item.path),
  ).size;
}

export function ProjectContextStrip({
  checking = false,
  disabled = false,
  projectName,
  state,
  onPress,
}: ProjectContextStripProps) {
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const disabledRef = useRef(disabled);
  const onPressRef = useRef(onPress);
  disabledRef.current = disabled;
  onPressRef.current = onPress;
  const effective = effectiveStatus(state, checking);
  const snapshot = state.snapshot;
  const branch = snapshot?.branch ?? null;
  const displayProject =
    projectName.trim() || snapshot?.project_name || state.projectId;
  const fileCount = uniqueIncludedPathCount(state);
  const changedCount = changedPathCount(state);
  const usedBytes = snapshot?.context_bytes ?? 0;
  const status = t(statusKey(effective));
  const repository =
    snapshot === null
      ? null
      : snapshot.conflicted
        ? t('context.strip.repository.conflicted')
        : snapshot.clean
          ? t('context.strip.repository.clean')
          : t('context.strip.repository.changed');
  const changed =
    changedCount === 0
      ? null
      : t('context.strip.changedCount', { count: changedCount });
  const files = t('context.strip.fileCount', { count: fileCount });
  const budget = t('context.strip.byteBudget', {
    used: formatBytes(usedBytes),
    maximum: formatBytes(PROJECT_CONTEXT_MAX_BYTES),
  });
  const readOnly = t('context.strip.readOnly');
  const branchLabel =
    snapshot === null
      ? t('context.strip.branch.unchecked')
      : branch ?? t('context.strip.branch.detached');
  const repositorySummary = [repository, changed].filter(Boolean).join(', ');
  const accessibilityLabel = t('context.strip.accessibility', {
    project: displayProject,
    branch: branchLabel,
    repository: repositorySummary || status,
    files,
    budget,
    status,
    readOnly,
  });
  const Icon = statusIcon(effective);
  const handlePress = () => {
    if (!disabledRef.current) onPressRef.current();
  };

  return (
    <Pressable
      accessibilityHint={t('context.strip.openDetails')}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.root,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
      testID="project-context-strip"
    >
      <View
        style={[
          styles.icon,
          { backgroundColor: `${statusColor(effective, colors)}1F` },
        ]}
      >
        <AppIcon color={statusColor(effective, colors)} icon={Icon} size={17} />
      </View>
      <View style={styles.content}>
        <Text
          style={styles.primary}
          testID="project-context-strip-primary"
        >
          {branch === null ? displayProject : `${displayProject} · ${branch}`}
        </Text>
        <View style={styles.metadata}>
          <Text style={[styles.status, { color: statusColor(effective, colors) }]}>
            {status}
          </Text>
          {repository !== null && (
            <Text style={styles.detail}>{repository}</Text>
          )}
          {changed !== null && <Text style={styles.detail}>{changed}</Text>}
          <Text style={styles.detail}>{files}</Text>
          <Text style={styles.detail}>{budget}</Text>
          <Text style={styles.boundary}>{readOnly}</Text>
        </View>
      </View>
      <AppIcon color={colors.muted} icon={ChevronRight} size={16} />
    </Pressable>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    root: {
      minHeight: 44,
      borderRadius: 15,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      backgroundColor: colors.surfaceRaised,
      paddingHorizontal: 11,
      paddingVertical: 9,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
    },
    pressed: { opacity: 0.72 },
    disabled: { opacity: 0.52 },
    icon: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    content: { flex: 1, minWidth: 0, gap: 4 },
    primary: {
      color: colors.text,
      fontFamily: fonts.body,
      fontSize: 13,
      lineHeight: 18,
      fontWeight: '700',
      flexShrink: 1,
    },
    metadata: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      columnGap: 8,
      rowGap: 3,
    },
    status: {
      fontFamily: fonts.body,
      fontSize: 11,
      lineHeight: 16,
      fontWeight: '700',
    },
    detail: {
      color: colors.textDim,
      fontFamily: fonts.body,
      fontSize: 11,
      lineHeight: 16,
    },
    boundary: {
      color: colors.muted,
      fontFamily: fonts.body,
      fontSize: 11,
      lineHeight: 16,
      fontWeight: '600',
    },
  });
