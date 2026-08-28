import React, { useEffect, useMemo, useRef } from 'react';
import Check from 'lucide-react-native/icons/check';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import FileText from 'lucide-react-native/icons/file-text';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import ShieldOff from 'lucide-react-native/icons/shield-off';
import X from 'lucide-react-native/icons/x';
import {
  AccessibilityInfo,
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type {
  ProjectContextBridgeErrorCode,
  ProjectContextCandidatePageV1,
  ProjectContextManifestV1,
  ProjectContextOmissionReason,
} from '../project-context';
import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, hitSlop, type ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';
import { PROJECT_CONTEXT_MAX_BYTES } from './ProjectContextStrip';
import { SlidingSurface } from './SlidingSurface';

export type ProjectContextSheetFilter = 'all' | 'selected' | 'changed';
export type ProjectContextSheetMode = 'candidates' | 'disclosure';
export type ProjectContextSheetBusyAction =
  | 'prepare'
  | 'confirm'
  | 'refresh'
  | 'disable'
  | null;

type Candidate = ProjectContextCandidatePageV1['candidates'][number];

export type ProjectContextSheetProps = {
  readonly visible: boolean;
  readonly mode: ProjectContextSheetMode;
  readonly projectName: string;
  readonly query: string;
  readonly filter: ProjectContextSheetFilter;
  readonly candidates: readonly Candidate[];
  readonly selectedPaths: readonly string[];
  readonly selectedCandidates: readonly Candidate[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly unavailable: boolean;
  readonly errorCode: ProjectContextBridgeErrorCode | null;
  readonly manifest: ProjectContextManifestV1 | null;
  readonly hasActiveContext: boolean;
  readonly confirmationRequired: boolean;
  readonly disabled: boolean;
  readonly busyAction: ProjectContextSheetBusyAction;
  readonly onQueryChange: (query: string) => void;
  readonly onFilterChange: (filter: ProjectContextSheetFilter) => void;
  readonly onTogglePath: (path: string) => void;
  readonly onLoadMore: () => void;
  readonly onPrepare: () => void;
  readonly onConfirm: () => void;
  readonly onRefreshCandidates: () => void;
  readonly onRefreshContext: () => void;
  readonly onDisable: () => void;
  readonly onCancel: () => void;
  readonly onDismiss: () => void;
};

type DisclosureRow =
  | {
      readonly kind: 'included';
      readonly key: string;
      readonly path: string;
      readonly source: ProjectContextManifestV1['included'][number]['source'];
      readonly bytes: number;
    }
  | {
      readonly kind: 'omitted';
      readonly key: string;
      readonly path: string;
      readonly reason: ProjectContextOmissionReason;
    };

function formatItemBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  const value = bytes / (1024 * 1024);
  return `${Number.isInteger(value) ? String(value) : value.toFixed(1)} MB`;
}

function formatBudgetBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const value = bytes / 1024;
  return `${Number.isInteger(value) ? String(value) : value.toFixed(1)} KB`;
}

function gitKey(state: Candidate['git_state']) {
  switch (state) {
    case 'unchanged':
      return 'context.sheet.git.unchanged' as const;
    case 'staged':
      return 'context.sheet.git.staged' as const;
    case 'unstaged':
      return 'context.sheet.git.unstaged' as const;
    case 'conflicted':
      return 'context.sheet.git.conflicted' as const;
  }
}

function omissionKey(reason: ProjectContextOmissionReason) {
  switch (reason) {
    case 'secret_path':
      return 'context.sheet.omission.secretPath' as const;
    case 'generated':
      return 'context.sheet.omission.generated' as const;
    case 'lockfile':
      return 'context.sheet.omission.lockfile' as const;
    case 'suspected_secret':
      return 'context.sheet.omission.suspectedSecret' as const;
    case 'binary':
      return 'context.sheet.omission.binary' as const;
    case 'invalid_encoding':
      return 'context.sheet.omission.invalidEncoding' as const;
    case 'not_tracked':
      return 'context.sheet.omission.notTracked' as const;
    case 'budget_exceeded':
      return 'context.sheet.omission.budgetExceeded' as const;
    case 'policy':
      return 'context.sheet.omission.policy' as const;
  }
}

function sourceKey(source: DisclosureRow & { kind: 'included' }) {
  switch (source.source) {
    case 'tracked_file':
      return 'context.sheet.source.trackedFile' as const;
    case 'staged_diff':
      return 'context.sheet.source.stagedDiff' as const;
    case 'worktree_diff':
      return 'context.sheet.source.worktreeDiff' as const;
  }
}

function actionLocked(props: ProjectContextSheetProps): boolean {
  return props.disabled || props.busyAction !== null;
}

function selectedCandidateSummary(props: ProjectContextSheetProps) {
  const selected = new Set(props.selectedPaths);
  const seen = new Set<string>();
  let bytes = 0;
  let ineligible = false;
  for (const row of props.selectedCandidates) {
    if (!selected.has(row.path) || seen.has(row.path)) continue;
    seen.add(row.path);
    bytes += row.size;
    if (!row.eligible) ineligible = true;
  }
  if (seen.size !== selected.size) ineligible = true;
  return { bytes, count: selected.size, ineligible };
}

function canPrepare(props: ProjectContextSheetProps): boolean {
  const selected = selectedCandidateSummary(props);
  return (
    props.mode === 'candidates' &&
    !actionLocked(props) &&
    !props.loading &&
    !props.loadingMore &&
    !props.unavailable &&
    props.errorCode === null &&
    selected.count > 0 &&
    !selected.ineligible &&
    selected.bytes <= PROJECT_CONTEXT_MAX_BYTES
  );
}

function canConfirm(props: ProjectContextSheetProps): boolean {
  return (
    props.mode === 'disclosure' &&
    props.confirmationRequired &&
    !actionLocked(props) &&
    !props.unavailable &&
    props.errorCode === null &&
    props.manifest !== null &&
    props.manifest.context_bytes > 0 &&
    props.manifest.context_bytes <= PROJECT_CONTEXT_MAX_BYTES
  );
}

export function ProjectContextSheet(props: ProjectContextSheetProps) {
  const insets = useSafeAreaInsets();
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const latest = useRef(props);
  const titleFocused = useRef(false);
  latest.current = props;

  useEffect(() => {
    if (!props.visible) titleFocused.current = false;
  }, [props.visible]);

  const handleTitleLayout = (event: LayoutChangeEvent) => {
    if (
      titleFocused.current ||
      !latest.current.visible ||
      typeof event.target !== 'number'
    ) {
      return;
    }
    titleFocused.current = true;
    AccessibilityInfo.setAccessibilityFocus(event.target);
  };

  const selectedSet = useMemo(
    () => new Set(props.selectedPaths),
    [props.selectedPaths],
  );
  const filteredCandidates = useMemo(() => {
    if (props.filter === 'selected') {
      return props.selectedCandidates.filter(row => selectedSet.has(row.path));
    }
    if (props.filter === 'changed') {
      return props.candidates.filter(row => row.git_state !== 'unchanged');
    }
    return props.candidates;
  }, [props.candidates, props.filter, props.selectedCandidates, selectedSet]);

  const disclosureRows = useMemo<readonly DisclosureRow[]>(() => {
    if (props.manifest === null) return [];
    return [
      ...props.manifest.included.map((row, index) => ({
        kind: 'included' as const,
        key: `included:${index}:${row.path}:${row.source}`,
        path: row.path,
        source: row.source,
        bytes: row.bytes,
      })),
      ...props.manifest.omitted.map((row, index) => ({
        kind: 'omitted' as const,
        key: `omitted:${index}:${row.path}:${row.reason}`,
        path: row.path,
        reason: row.reason,
      })),
    ];
  }, [props.manifest]);
  const visibleCandidates =
    props.loading || props.unavailable || props.errorCode !== null
      ? []
      : filteredCandidates;

  const handleQueryChange = (query: string) => {
    const current = latest.current;
    if (!actionLocked(current)) current.onQueryChange(query);
  };
  const handleFilterChange = (filter: ProjectContextSheetFilter) => {
    const current = latest.current;
    if (!actionLocked(current) && current.mode === 'candidates') {
      current.onFilterChange(filter);
    }
  };
  const handleTogglePath = (path: string) => {
    const current = latest.current;
    const candidate =
      current.candidates.find(row => row.path === path) ??
      current.selectedCandidates.find(row => row.path === path);
    if (
      !actionLocked(current) &&
      current.mode === 'candidates' &&
      !current.loading &&
      !current.unavailable &&
      current.errorCode === null &&
      candidate?.eligible === true
    ) {
      current.onTogglePath(path);
    }
  };
  const handleLoadMore = () => {
    const current = latest.current;
    if (
      !actionLocked(current) &&
      current.mode === 'candidates' &&
      !current.loading &&
      !current.loadingMore &&
      !current.unavailable &&
      current.errorCode === null &&
      current.nextCursor !== null
    ) {
      current.onLoadMore();
    }
  };
  const handlePrepare = () => {
    const current = latest.current;
    if (canPrepare(current)) current.onPrepare();
  };
  const handleConfirm = () => {
    const current = latest.current;
    if (canConfirm(current)) current.onConfirm();
  };
  const handleRefreshCandidates = () => {
    const current = latest.current;
    if (!actionLocked(current) && current.mode === 'candidates') {
      current.onRefreshCandidates();
    }
  };
  const handleRefreshContext = () => {
    const current = latest.current;
    if (!actionLocked(current) && current.hasActiveContext) {
      current.onRefreshContext();
    }
  };
  const handleDisable = () => {
    const current = latest.current;
    if (!actionLocked(current) && current.hasActiveContext) {
      current.onDisable();
    }
  };
  const handleCancel = () => {
    latest.current.onCancel();
  };
  const handleDismiss = () => latest.current.onDismiss();

  const selected = selectedCandidateSummary(props);
  const selectionOverBudget = selected.bytes > PROJECT_CONTEXT_MAX_BYTES;
  const candidateNotice = props.unavailable
    ? t('context.sheet.unavailable')
    : props.errorCode !== null
      ? t('context.sheet.loadError')
      : props.loading
        ? t('context.sheet.loading')
        : filteredCandidates.length === 0
          ? t('context.sheet.empty')
          : props.loadingMore
            ? t('context.sheet.loadingMore')
            : null;

  const actionButton = (
    label: string,
    onPress: () => void,
    options: {
      disabled: boolean;
      busy?: boolean;
      danger?: boolean;
      icon?: typeof RefreshCw;
    },
  ) => (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{
        busy: options.busy === true,
        disabled: options.disabled,
      }}
      disabled={options.disabled}
      hitSlop={hitSlop}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        options.danger && styles.actionDanger,
        options.disabled && styles.disabled,
        pressed && !options.disabled && styles.pressed,
      ]}
    >
      {options.busy ? (
        <ActivityIndicator color={colors.text} size="small" />
      ) : options.icon !== undefined ? (
        <AppIcon color={colors.text} icon={options.icon} size={17} />
      ) : null}
      <Text style={options.danger ? styles.actionDangerText : styles.actionText}>
        {label}
      </Text>
    </Pressable>
  );

  const filterButton = (filter: ProjectContextSheetFilter, label: string) => {
    const selectedFilter = props.filter === filter;
    const disabled = actionLocked(props);
    return (
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={{ disabled, selected: selectedFilter }}
        disabled={disabled}
        onPress={() => handleFilterChange(filter)}
        style={({ pressed }) => [
          styles.filter,
          selectedFilter && styles.filterSelected,
          disabled && styles.disabled,
          pressed && !disabled && styles.pressed,
        ]}
      >
        <Text style={selectedFilter ? styles.filterTextSelected : styles.filterText}>
          {label}
        </Text>
      </Pressable>
    );
  };

  const candidateHeader = (
    <View style={styles.header}>
      <TextInput
        accessibilityLabel={t('context.sheet.search')}
        editable={!actionLocked(props)}
        maxLength={256}
        onChangeText={handleQueryChange}
        placeholder={t('context.sheet.search')}
        placeholderTextColor={colors.faint}
        style={styles.search}
        value={props.query}
      />
      <View style={styles.filters}>
        {filterButton('all', t('context.sheet.filter.all'))}
        {filterButton('selected', t('context.sheet.filter.selected'))}
        {filterButton('changed', t('context.sheet.filter.changed'))}
      </View>
      {candidateNotice !== null && (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole={props.errorCode === null ? 'status' : 'alert'}
          style={props.errorCode === null ? styles.notice : styles.error}
        >
          {candidateNotice}
        </Text>
      )}
      <Text
        accessibilityLiveRegion="polite"
        style={selectionOverBudget ? styles.error : styles.selectionBudget}
      >
        {selectionOverBudget
          ? t('context.sheet.selectionOverBudget', {
              maximum: formatBudgetBytes(PROJECT_CONTEXT_MAX_BYTES),
            })
          : t('context.sheet.selectionBudget', {
              count: selected.count,
              used: formatBudgetBytes(selected.bytes),
              maximum: formatBudgetBytes(PROJECT_CONTEXT_MAX_BYTES),
            })}
      </Text>
    </View>
  );

  const candidateFooter = (
    <View style={[styles.actions, { paddingBottom: insets.bottom + 14 }]}>
      {actionButton(t('context.sheet.prepare'), handlePrepare, {
        disabled: !canPrepare(props),
        busy: props.busyAction === 'prepare',
      })}
      {actionButton(t('context.sheet.refreshFiles'), handleRefreshCandidates, {
        disabled: actionLocked(props) || props.loading,
        busy: props.busyAction === 'refresh',
        icon: RefreshCw,
      })}
      {actionButton(t('context.sheet.refreshContext'), handleRefreshContext, {
        disabled: actionLocked(props) || !props.hasActiveContext,
        busy: props.busyAction === 'refresh',
        icon: RefreshCw,
      })}
      {actionButton(t('context.sheet.disable'), handleDisable, {
        disabled: actionLocked(props) || !props.hasActiveContext,
        busy: props.busyAction === 'disable',
        danger: true,
        icon: ShieldOff,
      })}
      {actionButton(t('context.sheet.cancel'), handleCancel, {
        disabled: false,
        icon: X,
      })}
    </View>
  );

  const renderCandidate = ({ item }: ListRenderItemInfo<Candidate>) => {
    const checked = selectedSet.has(item.path);
    const disabled =
      actionLocked(props) ||
      props.loading ||
      props.unavailable ||
      props.errorCode !== null ||
      !item.eligible;
    const git = t(gitKey(item.git_state));
    const reason =
      item.omission_reason === null ? null : t(omissionKey(item.omission_reason));
    return (
      <Pressable
        accessibilityLabel={t('context.sheet.candidate.accessibility', {
          path: item.path,
          size: formatItemBytes(item.size),
          git,
          eligibility: reason ?? t('context.sheet.eligible'),
        })}
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled }}
        disabled={disabled}
        onPress={() => handleTogglePath(item.path)}
        style={({ pressed }) => [
          styles.candidate,
          disabled && styles.disabled,
          pressed && !disabled && styles.pressed,
        ]}
        testID={`project-context-candidate-${item.path}`}
      >
        <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
          {checked && <AppIcon color={colors.background} icon={Check} size={14} />}
        </View>
        <View style={styles.candidateCopy}>
          <Text style={styles.path}>{item.path}</Text>
          <Text style={styles.meta}>
            {formatItemBytes(item.size)} · {git}
          </Text>
          {reason !== null && <Text style={styles.ineligible}>{reason}</Text>}
        </View>
        <AppIcon color={colors.muted} icon={ChevronRight} size={15} />
      </Pressable>
    );
  };

  const disclosureHeader = (() => {
    const current = props.manifest;
    if (current === null) {
      return <Text style={styles.error}>{t('context.sheet.loadError')}</Text>;
    }
    const branch = current.branch ?? t('context.strip.branch.detached');
    const head = current.head_oid?.slice(0, 7) ?? t('context.sheet.noHead');
    const tokens = Math.ceil(current.context_bytes / 4);
    const budget = `${formatBudgetBytes(current.context_bytes)} / ${formatBudgetBytes(
      PROJECT_CONTEXT_MAX_BYTES,
    )}`;
    const failure = props.unavailable
      ? t('context.sheet.unavailable')
      : props.errorCode !== null
        ? t('context.sheet.loadError')
        : null;
    return (
      <View style={styles.disclosureHeader}>
        {failure !== null && (
          <Text
            accessibilityLiveRegion="polite"
            accessibilityRole={props.errorCode === null ? 'status' : 'alert'}
            style={props.errorCode === null ? styles.notice : styles.error}
          >
            {failure}
          </Text>
        )}
        <Text style={styles.disclosure}>{t('context.sheet.disclosure')}</Text>
        <View style={styles.disclosureCard}>
          <Text style={styles.metaLabel}>{t('context.sheet.disclosure.provider')}</Text>
          <Text style={styles.metaValue}>{current.provider_host}</Text>
          <Text style={styles.metaLabel}>{t('context.sheet.disclosure.model')}</Text>
          <Text style={styles.metaValue}>{current.model}</Text>
          <Text style={styles.metaLabel}>{t('context.sheet.disclosure.branch')}</Text>
          <Text style={styles.metaValue}>{branch}</Text>
          <Text style={styles.metaLabel}>{t('context.sheet.disclosure.head')}</Text>
          <Text style={styles.metaValue}>{head}</Text>
          <Text style={styles.metaLabel}>{t('context.sheet.disclosure.capturedAt')}</Text>
          <Text style={styles.metaValue}>{current.captured_at}</Text>
          <Text style={styles.metaLabel}>{t('context.sheet.disclosure.digest')}</Text>
          <Text style={styles.metaValue}>{current.snapshot_sha256.slice(0, 12)}</Text>
          <Text style={styles.metaLabel}>{t('context.sheet.disclosure.budget')}</Text>
          <Text
            accessibilityLiveRegion="polite"
            style={
              current.context_bytes > PROJECT_CONTEXT_MAX_BYTES
                ? styles.error
                : styles.metaValue
            }
            testID="project-context-budget-announcement"
          >
            {budget}
          </Text>
          <Text style={styles.metaValue}>
            {t('context.sheet.approximateTokens', { count: tokens })}
          </Text>
        </View>
        {current.included.length > 0 && (
          <Text style={styles.sectionTitle}>
            {t('context.sheet.disclosure.included')}
          </Text>
        )}
      </View>
    );
  })();

  const renderDisclosure = ({
    item,
    index,
  }: ListRenderItemInfo<DisclosureRow>) => {
    if (item.kind === 'included') {
      return (
        <View style={styles.disclosureRow}>
          <AppIcon color={colors.success} icon={FileText} size={16} />
          <View style={styles.candidateCopy}>
            <Text style={styles.path}>{item.path}</Text>
            <Text style={styles.meta}>
              {t(sourceKey(item))} · {formatItemBytes(item.bytes)}
            </Text>
          </View>
        </View>
      );
    }
    const firstOmitted =
      index === 0 || disclosureRows[index - 1]?.kind !== 'omitted';
    return (
      <>
        {firstOmitted && (
          <Text style={[styles.sectionTitle, styles.omittedTitle]}>
            {t('context.sheet.disclosure.omitted')}
          </Text>
        )}
        <View style={styles.disclosureRow}>
          <AppIcon color={colors.warning} icon={CircleAlert} size={16} />
          <View style={styles.candidateCopy}>
            <Text style={styles.path}>{item.path}</Text>
            <Text style={styles.ineligible}>{t(omissionKey(item.reason))}</Text>
          </View>
        </View>
      </>
    );
  };

  const disclosureFooter = (() => {
    const current = props.manifest;
    const partial = (current?.omitted.length ?? 0) > 0;
    const confirmLabel = partial
      ? t('context.sheet.confirmPartial')
      : t('context.sheet.confirm');
    return (
      <View style={[styles.actions, { paddingBottom: insets.bottom + 14 }]}>
        {props.confirmationRequired &&
          actionButton(confirmLabel, handleConfirm, {
            disabled: !canConfirm(props),
            busy: props.busyAction === 'confirm',
          })}
        {actionButton(t('context.sheet.refreshContext'), handleRefreshContext, {
          disabled: actionLocked(props) || !props.hasActiveContext,
          busy: props.busyAction === 'refresh',
          icon: RefreshCw,
        })}
        {actionButton(t('context.sheet.disable'), handleDisable, {
          disabled: actionLocked(props) || !props.hasActiveContext,
          busy: props.busyAction === 'disable',
          danger: true,
          icon: ShieldOff,
        })}
        {actionButton(t('context.sheet.cancel'), handleCancel, {
          disabled: false,
          icon: X,
        })}
      </View>
    );
  })();

  return (
    <SlidingSurface
      accessibilityLabel={t('context.sheet.title')}
      closeAccessibilityLabel={t('context.sheet.close')}
      onClose={handleCancel}
      onDismiss={handleDismiss}
      scrim={false}
      side="bottom"
      visible={props.visible}
      widthRatio={1}
    >
      <View style={styles.sheet} testID="project-context-sheet-body">
        <View style={[styles.titleRow, { paddingTop: insets.top + 8 }]}>
          <View style={styles.titleCopy}>
            <View
              accessible
              accessibilityRole="header"
              collapsable={false}
              onLayout={handleTitleLayout}
              testID="project-context-sheet-title"
            >
              <Text style={styles.title}>{t('context.sheet.title')}</Text>
            </View>
            <Text style={styles.project}>{props.projectName}</Text>
          </View>
          <Pressable
            accessibilityLabel={t('context.sheet.close')}
            accessibilityRole="button"
            hitSlop={hitSlop}
            onPress={handleCancel}
            style={({ pressed }) => [
              styles.close,
              pressed && styles.pressed,
            ]}
          >
            <AppIcon color={colors.text} icon={X} size={20} />
          </Pressable>
        </View>
        {props.mode === 'candidates' ? (
          <FlatList<Candidate>
            contentContainerStyle={styles.listContent}
            data={visibleCandidates}
            keyExtractor={item => item.path}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              candidateNotice === null ? undefined : <View />
            }
            ListFooterComponent={candidateFooter}
            ListHeaderComponent={candidateHeader}
            onEndReached={handleLoadMore}
            onEndReachedThreshold={0.4}
            renderItem={renderCandidate}
          />
        ) : (
          <FlatList<DisclosureRow>
            contentContainerStyle={styles.listContent}
            data={disclosureRows}
            keyExtractor={item => item.key}
            ListFooterComponent={disclosureFooter}
            ListHeaderComponent={disclosureHeader}
            renderItem={renderDisclosure}
          />
        )}
      </View>
    </SlidingSurface>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    sheet: { flex: 1, backgroundColor: colors.background },
    titleRow: {
      paddingHorizontal: 20,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 12,
    },
    titleCopy: { flex: 1, minWidth: 0 },
    close: {
      minWidth: 44,
      minHeight: 44,
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 28,
      lineHeight: 34,
      fontWeight: '700',
    },
    project: {
      color: colors.muted,
      fontFamily: fonts.body,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 2,
    },
    listContent: { flexGrow: 1 },
    header: { paddingHorizontal: 18, paddingTop: 14, gap: 10 },
    search: {
      minHeight: 46,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      backgroundColor: colors.surface,
      color: colors.text,
      fontFamily: fonts.body,
      fontSize: 15,
      paddingHorizontal: 13,
    },
    filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
    filter: {
      minHeight: 44,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      paddingHorizontal: 13,
      alignItems: 'center',
      justifyContent: 'center',
    },
    filterSelected: { backgroundColor: colors.text },
    filterText: { color: colors.textDim, fontSize: 12, fontWeight: '700' },
    filterTextSelected: {
      color: colors.background,
      fontSize: 12,
      fontWeight: '700',
    },
    notice: { color: colors.muted, fontSize: 13, lineHeight: 19 },
    error: { color: colors.danger, fontSize: 13, lineHeight: 19 },
    selectionBudget: { color: colors.textDim, fontSize: 12, lineHeight: 18 },
    candidate: {
      minHeight: 44,
      marginHorizontal: 18,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.lineSoft,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.line,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    checkboxChecked: {
      borderColor: colors.accent,
      backgroundColor: colors.accent,
    },
    candidateCopy: { flex: 1, minWidth: 0, gap: 2 },
    path: {
      color: colors.text,
      fontFamily: fonts.mono,
      fontSize: 12,
      lineHeight: 18,
    },
    meta: { color: colors.muted, fontSize: 11, lineHeight: 16 },
    ineligible: { color: colors.warning, fontSize: 11, lineHeight: 16 },
    actions: {
      marginTop: 'auto',
      paddingHorizontal: 18,
      paddingTop: 16,
      gap: 8,
    },
    action: {
      minHeight: 44,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      backgroundColor: colors.surface,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    actionDanger: { backgroundColor: colors.surfaceWarm },
    actionText: { color: colors.text, fontSize: 13, fontWeight: '700' },
    actionDangerText: {
      color: colors.danger,
      fontSize: 13,
      fontWeight: '700',
    },
    disabled: { opacity: 0.45 },
    pressed: { opacity: 0.65 },
    disclosureHeader: { paddingHorizontal: 18, paddingTop: 14, gap: 12 },
    disclosure: {
      color: colors.textDim,
      fontFamily: fonts.body,
      fontSize: 13,
      lineHeight: 20,
    },
    disclosureCard: {
      borderRadius: 15,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      padding: 13,
      gap: 3,
    },
    metaLabel: {
      color: colors.muted,
      fontSize: 10,
      lineHeight: 15,
      fontWeight: '700',
      textTransform: 'uppercase',
      marginTop: 5,
    },
    metaValue: { color: colors.text, fontSize: 12, lineHeight: 18 },
    sectionTitle: {
      color: colors.text,
      fontSize: 13,
      lineHeight: 19,
      fontWeight: '700',
    },
    omittedTitle: { marginHorizontal: 18, marginTop: 12 },
    disclosureRow: {
      minHeight: 44,
      marginHorizontal: 18,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.lineSoft,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 9,
    },
  });
