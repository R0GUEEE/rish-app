import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import FolderDown from 'lucide-react-native/icons/folder-down';
import FolderGit2 from 'lucide-react-native/icons/folder-git-2';
import FolderOpen from 'lucide-react-native/icons/folder-open';
import FolderPlus from 'lucide-react-native/icons/folder-plus';
import GitBranch from 'lucide-react-native/icons/git-branch';
import GitCompare from 'lucide-react-native/icons/git-compare';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import X from 'lucide-react-native/icons/x';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  LocalProjects,
  type LocalProject,
  type ProjectCredentialStatus,
  type ProjectDiff,
  type ProjectFileStatus,
  type ProjectGitStatus,
  type ProjectPushReceipt,
  type ProjectStatusEntry,
} from '../native/LocalProjects';
import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, hitSlop, type ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';
import { SlidingSurface } from './SlidingSurface';

type CreateMode = 'create' | 'clone' | null;
type ProjectTab = 'files' | 'changes';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasStatus(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase();
  return !['', '.', 'unmodified', 'current', 'none'].includes(normalized);
}

function hasStagedChanges(status: ProjectGitStatus | null): boolean {
  return status?.entries.some(entry => hasStatus(entry.index_status)) ?? false;
}

function statusSummary(
  status: ProjectGitStatus | null,
  t: ReturnType<typeof useAppPresentation>['t'],
): string {
  if (status === null) return t('projects.loading');
  if (status.clean) return t('projects.clean');
  return t('projects.dirty', { count: status.entries.length });
}

function fileStatusLabel(
  status: ProjectFileStatus,
  t: ReturnType<typeof useAppPresentation>['t'],
): string {
  switch (status) {
    case 'added':
      return t('projects.fileStatus.added');
    case 'modified':
      return t('projects.fileStatus.modified');
    case 'deleted':
      return t('projects.fileStatus.deleted');
    case 'renamed':
      return t('projects.fileStatus.renamed');
    case 'typechange':
      return t('projects.fileStatus.typechange');
    case 'unreadable':
      return t('projects.fileStatus.unreadable');
    case 'unmodified':
      return t('projects.fileStatus.unmodified');
  }
}

function changeLabels(
  entry: ProjectStatusEntry,
  t: ReturnType<typeof useAppPresentation>['t'],
): string[] {
  const labels: string[] = [];
  if (entry.index_status !== 'unmodified') {
    labels.push(
      t('projects.change.staged', {
        status: fileStatusLabel(entry.index_status, t),
      }),
    );
  }
  if (entry.worktree_status !== 'unmodified') {
    labels.push(
      t('projects.change.worktree', {
        status: fileStatusLabel(entry.worktree_status, t),
      }),
    );
  }
  if (entry.conflicted) labels.push(t('projects.change.conflict'));
  if (labels.length === 0) labels.push(t('projects.fileStatus.unmodified'));
  return labels;
}

type Props = {
  boundProjectId?: string | null;
  covered?: boolean;
  refreshToken?: number;
  visible: boolean;
  onChatInProject?: (project: LocalProject) => void;
  onClose: () => void;
  onDismiss?: () => void;
  onOpenFiles: (project: LocalProject) => void;
  onUnbindFromChat?: () => void;
};

export function ProjectsSurface({
  boundProjectId = null,
  covered = false,
  refreshToken = 0,
  visible,
  onChatInProject,
  onClose,
  onDismiss,
  onOpenFiles,
  onUnbindFromChat,
}: Props) {
  const insets = useSafeAreaInsets();
  const { colors, locale, preferences, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [selected, setSelected] = useState<LocalProject | null>(null);
  const [status, setStatus] = useState<ProjectGitStatus | null>(null);
  const [diff, setDiff] = useState<ProjectDiff | null>(null);
  const [credential, setCredential] = useState<ProjectCredentialStatus | null>(
    null,
  );
  const [tab, setTab] = useState<ProjectTab>('files');
  const [createMode, setCreateMode] = useState<CreateMode>(null);
  const [name, setName] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [receipt, setReceipt] = useState<ProjectPushReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    if (!LocalProjects.isAvailable()) {
      setError(t('projects.unavailable'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const listing = await LocalProjects.list();
      setProjects(listing.projects);
      setSelected(previous => {
        if (previous === null) return null;
        return (
          listing.projects.find(project => project.id === previous.id) ?? null
        );
      });
    } catch (caught) {
      setError(t('projects.operationFailed', { error: errorText(caught) }));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const loadDetail = useCallback(
    async (project: LocalProject) => {
      setBusy(true);
      setError(null);
      try {
        const [nextStatus, nextDiff, nextCredential, nextReceipts] =
          await Promise.all([
            LocalProjects.status(project.id),
            LocalProjects.diff(project.id),
            project.origin_url === null
              ? Promise.resolve(null)
              : LocalProjects.credentialStatus(project.id),
            project.origin_url === null
              ? Promise.resolve(null)
              : LocalProjects.pushReceipts(project.id),
          ]);
        setStatus(nextStatus);
        setDiff(nextDiff);
        setCredential(nextCredential);
        setReceipt(
          nextReceipts === null || nextReceipts.receipts.length === 0
            ? null
            : nextReceipts.receipts[nextReceipts.receipts.length - 1],
        );
        setRemoteUrl(project.origin_url ?? '');
      } catch (caught) {
        setError(t('projects.operationFailed', { error: errorText(caught) }));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (visible) loadProjects().catch(() => undefined);
  }, [loadProjects, visible]);

  useEffect(() => {
    if (refreshToken > 0 && visible && selected !== null)
      loadDetail(selected).catch(() => undefined);
  }, [loadDetail, refreshToken, selected, visible]);

  const openProject = useCallback(
    (project: LocalProject) => {
      setSelected(project);
      setTab('files');
      setNotice(null);
      setStatus(null);
      setDiff(null);
      setCredential(null);
      setRemoteUrl(project.origin_url ?? '');
      loadDetail(project).catch(() => undefined);
    },
    [loadDetail],
  );

  const finishCreation = useCallback(
    async (kind: Exclude<CreateMode, null>) => {
      if (busy) return;
      const trimmedName = name.trim();
      const trimmedUrl = cloneUrl.trim();
      if (kind === 'create' && trimmedName.length === 0) return;
      if (kind === 'clone' && trimmedUrl.length === 0) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const project =
          kind === 'create'
            ? await LocalProjects.create(trimmedName)
            : await LocalProjects.clone(
                trimmedUrl,
                trimmedName.length === 0 ? undefined : trimmedName,
                { httpsProxyUrl: preferences.gitHttpsProxyUrl },
              );
        setProjects(previous => [
          project,
          ...previous.filter(item => item.id !== project.id),
        ]);
        setCreateMode(null);
        setName('');
        setCloneUrl('');
        setNotice(
          kind === 'create'
            ? t('projects.created')
            : t('projects.clonedSuccess'),
        );
        setSelected(project);
        setTab('files');
        setRemoteUrl(project.origin_url ?? '');
        await loadDetail(project);
      } catch (caught) {
        setError(t('projects.operationFailed', { error: errorText(caught) }));
      } finally {
        setBusy(false);
      }
    },
    [busy, cloneUrl, loadDetail, name, preferences.gitHttpsProxyUrl, t],
  );

  const refresh = useCallback(async () => {
    if (selected === null) return;
    await loadDetail(selected);
  }, [loadDetail, selected]);

  const stageAll = useCallback(async () => {
    if (selected === null || busy || status?.entries.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const nextStatus = await LocalProjects.stageAll(selected.id);
      const nextDiff = await LocalProjects.diff(selected.id, { staged: true });
      setStatus(nextStatus);
      setDiff(nextDiff);
      setNotice(t('projects.stagedSuccess'));
    } catch (caught) {
      setError(t('projects.operationFailed', { error: errorText(caught) }));
    } finally {
      setBusy(false);
    }
  }, [busy, selected, status?.entries.length, t]);

  const commit = useCallback(async () => {
    if (
      selected === null ||
      busy ||
      commitMessage.trim().length === 0 ||
      authorName.trim().length === 0 ||
      authorEmail.trim().length === 0 ||
      !hasStagedChanges(status)
    )
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await LocalProjects.commit(selected.id, {
        message: commitMessage.trim(),
        authorName: authorName.trim(),
        authorEmail: authorEmail.trim(),
      });
      setCommitMessage('');
      setNotice(t('projects.committedSuccess'));
      await loadDetail(selected);
    } catch (caught) {
      setError(t('projects.operationFailed', { error: errorText(caught) }));
    } finally {
      setBusy(false);
    }
  }, [
    authorEmail,
    authorName,
    busy,
    commitMessage,
    loadDetail,
    selected,
    status,
    t,
  ]);

  const saveRemote = useCallback(async () => {
    if (selected === null || busy || remoteUrl.trim().length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const remote = await LocalProjects.setRemote(
        selected.id,
        remoteUrl.trim(),
      );
      const updated = { ...selected, origin_url: remote.url };
      setSelected(updated);
      setProjects(previous =>
        previous.map(project =>
          project.id === updated.id ? updated : project,
        ),
      );
      setCredential(await LocalProjects.credentialStatus(selected.id));
      setNotice(t('projects.remoteSaved'));
    } catch (caught) {
      setError(t('projects.operationFailed', { error: errorText(caught) }));
    } finally {
      setBusy(false);
    }
  }, [busy, remoteUrl, selected, t]);

  const configureCredential = useCallback(async () => {
    if (selected === null || selected.origin_url === null || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setCredential(
        await LocalProjects.presentCredentialPrompt(
          selected.id,
          locale === 'zh-CN' ? 'zh-CN' : 'en',
        ),
      );
    } catch (caught) {
      setError(t('projects.operationFailed', { error: errorText(caught) }));
    } finally {
      setBusy(false);
    }
  }, [busy, locale, selected, t]);

  const clearCredential = useCallback(async () => {
    if (selected === null || !credential?.configured || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setCredential(await LocalProjects.clearCredential(selected.id));
      setNotice(t('projects.credentialCleared'));
    } catch (caught) {
      setError(t('projects.operationFailed', { error: errorText(caught) }));
    } finally {
      setBusy(false);
    }
  }, [busy, credential?.configured, selected, t]);

  const push = useCallback(() => {
    if (
      selected === null ||
      selected.origin_url === null ||
      status === null ||
      status.branch === null ||
      status.branch.length === 0 ||
      status.head_oid === null ||
      busy
    )
      return;
    Alert.alert(
      t('projects.pushTitle'),
      t('projects.pushBody', {
        branch: status.branch,
        remote: selected.origin_url,
      }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('projects.confirmPush'),
          onPress: () => {
            setBusy(true);
            setPushing(true);
            setError(null);
            setNotice(null);
            LocalProjects.push(selected.id, {
              httpsProxyUrl: preferences.gitHttpsProxyUrl,
            })
              .then(result => {
                setNotice(t('projects.pushSuccess'));
                if (result.receipt !== undefined) {
                  setReceipt(result.receipt);
                }
                return loadDetail(selected);
              })
              .catch(caught => {
                const code =
                  typeof caught === 'object' &&
                  caught !== null &&
                  'code' in caught
                    ? String((caught as { code?: unknown }).code)
                    : '';
                if (code === 'non-fast-forward') {
                  setError(t('projects.pushNonFastForward'));
                } else if (code === 'timeout') {
                  setError(t('projects.pushTimeout'));
                } else if (code === 'cancelled') {
                  setError(t('projects.pushCancelled'));
                } else {
                  setError(
                    t('projects.operationFailed', {
                      error: errorText(caught),
                    }),
                  );
                }
              })
              .finally(() => {
                setPushing(false);
                setBusy(false);
              });
          },
        },
      ],
    );
  }, [busy, loadDetail, preferences.gitHttpsProxyUrl, selected, status, t]);

  const cancelPush = useCallback(() => {
    if (selected === null || !pushing) return;
    LocalProjects.cancelPush(selected.id).catch(() => undefined);
  }, [pushing, selected]);

  const title = selected?.name ?? t('projects.title');

  return (
    <SlidingSurface
      accessibilityHidden={covered}
      accessibilityLabel={title}
      closeAccessibilityLabel={t('projects.close')}
      onClose={onClose}
      onDismiss={onDismiss}
      scrim={false}
      side="right"
      visible={visible}
      widthRatio={1}
    >
      <View
        style={[
          styles.root,
          { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 10 },
        ]}
      >
        <View style={styles.header}>
          {selected === null ? (
            <View style={styles.headerSpacer} />
          ) : (
            <Pressable
              accessibilityLabel={t('projects.back')}
              accessibilityRole="button"
              hitSlop={hitSlop}
              onPress={() => {
                setSelected(null);
                setError(null);
                setNotice(null);
                loadProjects().catch(() => undefined);
              }}
              style={({ pressed }) => [
                styles.headerButton,
                pressed && styles.pressed,
              ]}
              testID="projects-back"
            >
              <AppIcon color={colors.text} icon={ChevronLeft} size={21} />
            </Pressable>
          )}
          <View style={styles.headerTitleWrap} testID="projects-detail-title">
            <Text numberOfLines={1} style={styles.headerTitle}>
              {title}
            </Text>
            <View style={styles.headerCaptionRow}>
              {selected !== null && (
                <AppIcon color={colors.faint} icon={GitBranch} size={11} />
              )}
              <Text numberOfLines={1} style={styles.headerCaption}>
                {selected === null
                  ? t('projects.onDevice')
                  : status === null
                  ? t('projects.loading')
                  : status.branch ?? t('projects.unbornBranch')}
              </Text>
            </View>
          </View>
          <Pressable
            accessibilityLabel={t('projects.close')}
            accessibilityRole="button"
            hitSlop={hitSlop}
            onPress={onClose}
            style={({ pressed }) => [
              styles.headerButton,
              pressed && styles.pressed,
            ]}
          >
            <AppIcon color={colors.text} icon={X} size={21} />
          </Pressable>
        </View>

        {selected === null ? (
          <ProjectList
            busy={busy}
            cloneUrl={cloneUrl}
            createMode={createMode}
            name={name}
            projects={projects}
            styles={styles}
            onChangeCloneUrl={setCloneUrl}
            onChangeName={setName}
            onChooseMode={mode => {
              setCreateMode(mode);
              setError(null);
              setNotice(null);
              setName('');
              setCloneUrl('');
            }}
            onOpenProject={openProject}
            onSubmit={finishCreation}
          />
        ) : (
          <ScrollView
            contentContainerStyle={styles.detailContent}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.statusCard}>
              <View style={styles.statusMain}>
                <View
                  style={[
                    styles.statusDot,
                    status?.clean && styles.statusDotClean,
                    status?.has_conflicts && styles.statusDotConflict,
                  ]}
                />
                <View style={styles.flex}>
                  <Text style={styles.statusTitle}>
                    {statusSummary(status, t)}
                  </Text>
                  <Text numberOfLines={1} style={styles.statusMeta}>
                    {status === null
                      ? selected.workspace_path
                      : `${status.branch ?? t('projects.unbornBranch')} · ${t(
                          'projects.aheadBehind',
                          {
                            ahead: status.ahead,
                            behind: status.behind,
                          },
                        )}`}
                  </Text>
                </View>
              </View>
              <Pressable
                accessibilityLabel={t('projects.refresh')}
                accessibilityRole="button"
                disabled={busy}
                onPress={() => refresh().catch(() => undefined)}
                style={({ pressed }) => [
                  styles.iconButton,
                  pressed && styles.pressed,
                ]}
              >
                <AppIcon color={colors.textDim} icon={RefreshCw} size={18} />
              </Pressable>
            </View>

            <View style={styles.tabs}>
              {(['files', 'changes'] as const).map(value => {
                const TabIcon = value === 'files' ? FolderOpen : GitCompare;
                const selectedTab = tab === value;
                return (
                  <Pressable
                    accessibilityLabel={t(`projects.${value}`)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: selectedTab }}
                    key={value}
                    onPress={() => setTab(value)}
                    style={[styles.tab, selectedTab && styles.tabSelected]}
                  >
                    <AppIcon
                      color={selectedTab ? colors.background : colors.muted}
                      icon={TabIcon}
                      size={15}
                    />
                    <Text
                      style={[
                        styles.tabText,
                        selectedTab && styles.tabTextSelected,
                      ]}
                    >
                      {t(`projects.${value}`)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {tab === 'files' ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{t('projects.root')}</Text>
                <Text style={styles.mono}>{selected.workspace_path}</Text>
                <Text style={styles.cardBody}>{t('projects.scopedFiles')}</Text>
                <Pressable
                  accessibilityLabel={
                    boundProjectId === selected.id
                      ? t('projects.removeFromChat')
                      : t('projects.chatInProject')
                  }
                  accessibilityRole="button"
                  onPress={
                    boundProjectId === selected.id
                      ? onUnbindFromChat
                      : () => onChatInProject?.(selected)
                  }
                  style={({ pressed }) => [
                    styles.primaryButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.primaryButtonText}>
                    {boundProjectId === selected.id
                      ? t('projects.boundToChat')
                      : t('projects.chatInProject')}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityLabel={t('projects.openFiles')}
                  accessibilityRole="button"
                  onPress={() => onOpenFiles(selected)}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>
                    {t('projects.openFiles')}
                  </Text>
                </Pressable>
              </View>
            ) : (
              <ChangesPanel
                busy={busy}
                diff={diff}
                status={status}
                styles={styles}
                onStageAll={stageAll}
              />
            )}

            <SectionLabel label={t('projects.commitSection')} styles={styles} />
            <View style={styles.card}>
              <Field
                label={t('projects.commitMessage')}
                multiline
                placeholder={t('projects.commitMessagePlaceholder')}
                styles={styles}
                value={commitMessage}
                onChangeText={setCommitMessage}
              />
              <View style={styles.fieldGap} />
              <Field
                autoCapitalize="words"
                label={t('projects.authorName')}
                placeholder={t('projects.authorName')}
                styles={styles}
                value={authorName}
                onChangeText={setAuthorName}
              />
              <View style={styles.fieldGap} />
              <Field
                autoCapitalize="none"
                keyboardType="email-address"
                label={t('projects.authorEmail')}
                placeholder="name@example.com"
                styles={styles}
                value={authorEmail}
                onChangeText={setAuthorEmail}
              />
              <Pressable
                accessibilityLabel={t('projects.commit')}
                accessibilityRole="button"
                accessibilityState={{
                  disabled:
                    busy ||
                    commitMessage.trim().length === 0 ||
                    authorName.trim().length === 0 ||
                    authorEmail.trim().length === 0 ||
                    !hasStagedChanges(status),
                }}
                disabled={
                  busy ||
                  commitMessage.trim().length === 0 ||
                  authorName.trim().length === 0 ||
                  authorEmail.trim().length === 0 ||
                  !hasStagedChanges(status)
                }
                onPress={() => commit().catch(() => undefined)}
                style={({ pressed }) => [
                  styles.primaryButton,
                  (busy || !hasStagedChanges(status)) && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryButtonText}>
                  {t('projects.commit')}
                </Text>
              </Pressable>
            </View>

            <SectionLabel label={t('projects.remoteSection')} styles={styles} />
            <View style={styles.card}>
              <Field
                autoCapitalize="none"
                label={t('projects.originUrl')}
                placeholder={t('projects.remoteUrlPlaceholder')}
                styles={styles}
                value={remoteUrl}
                onChangeText={setRemoteUrl}
              />
              <Pressable
                accessibilityLabel={t('projects.saveRemote')}
                accessibilityRole="button"
                accessibilityState={{
                  disabled: busy || remoteUrl.trim().length === 0,
                }}
                disabled={busy || remoteUrl.trim().length === 0}
                onPress={() => saveRemote().catch(() => undefined)}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  (busy || remoteUrl.trim().length === 0) && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.secondaryButtonText}>
                  {t('projects.saveRemote')}
                </Text>
              </Pressable>
              {selected.origin_url !== null && (
                <>
                  <View style={styles.credentialRow}>
                    <View style={styles.flex}>
                      <Text style={styles.cardTitle}>
                        {credential?.configured
                          ? credential.expires_at !== undefined
                            ? t('projects.credentialExpires', {
                                time: new Date(
                                  credential.expires_at * 1000,
                                ).toLocaleString(),
                              })
                            : t('projects.credentialStored')
                          : t('projects.configureCredential')}
                      </Text>
                      <Text style={styles.cardBody}>
                        {t('projects.credentialBody')}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.credentialDot,
                        credential?.configured && styles.statusDotClean,
                      ]}
                    />
                  </View>
                  <Pressable
                    accessibilityLabel={t('projects.configureCredential')}
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => configureCredential().catch(() => undefined)}
                    style={({ pressed }) => [
                      styles.secondaryButton,
                      busy && styles.disabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {t('projects.configureCredential')}
                    </Text>
                  </Pressable>
                  {credential?.configured && (
                    <Pressable
                      accessibilityLabel={t('projects.clearCredential')}
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() => clearCredential().catch(() => undefined)}
                      style={({ pressed }) => [
                        styles.textButton,
                        busy && styles.disabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={styles.textButtonDanger}>
                        {t('projects.clearCredential')}
                      </Text>
                    </Pressable>
                  )}
                  <Pressable
                    accessibilityLabel={t('projects.push')}
                    accessibilityRole="button"
                    accessibilityState={{
                      disabled:
                        busy || status === null || status.head_oid === null,
                    }}
                    disabled={
                      busy || status === null || status.head_oid === null
                    }
                    onPress={push}
                    style={({ pressed }) => [
                      styles.primaryButton,
                      (busy || status === null || status.head_oid === null) &&
                        styles.disabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.primaryButtonText}>
                      {t('projects.push')}
                    </Text>
                  </Pressable>
                </>
              )}
            </View>

            {selected.origin_url !== null && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>
                  {t('projects.pushReceiptTitle')}
                </Text>
                {receipt === null ? (
                  <Text style={styles.cardBody}>
                    {t('projects.pushReceiptNone')}
                  </Text>
                ) : (
                  <Text
                    accessibilityLabel={t('projects.pushReceiptBody', {
                      branch: receipt.branch,
                      host: receipt.host,
                      local: receipt.local_oid.slice(0, 12),
                      remote: receipt.remote_oid.slice(0, 12),
                      time: new Date(
                        receipt.pushed_at,
                      ).toLocaleString(),
                    })}
                    style={styles.mono}
                  >
                    {t('projects.pushReceiptBody', {
                      branch: receipt.branch,
                      host: receipt.host,
                      local: receipt.local_oid.slice(0, 12),
                      remote: receipt.remote_oid.slice(0, 12),
                      time: new Date(
                        receipt.pushed_at,
                      ).toLocaleString(),
                    })}
                  </Text>
                )}
              </View>
            )}
          </ScrollView>
        )}

        {(busy || error !== null || notice !== null) && (
          <View
            accessibilityLiveRegion="polite"
            style={[styles.toast, error !== null && styles.toastError]}
          >
            {busy && <ActivityIndicator color={colors.accent} size="small" />}
            <Text
              accessibilityRole={error === null ? undefined : 'alert'}
              numberOfLines={3}
              style={[
                styles.toastText,
                error !== null && styles.toastErrorText,
              ]}
            >
              {error ?? notice ?? t('projects.loading')}
            </Text>
            {pushing && (
              <Pressable
                accessibilityLabel={t('projects.cancelPush')}
                accessibilityRole="button"
                onPress={cancelPush}
                style={({ pressed }) => [
                  styles.toastCancel,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.toastCancelText}>
                  {t('projects.cancelPush')}
                </Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
    </SlidingSurface>
  );
}

function ProjectList({
  busy,
  cloneUrl,
  createMode,
  name,
  projects,
  styles,
  onChangeCloneUrl,
  onChangeName,
  onChooseMode,
  onOpenProject,
  onSubmit,
}: {
  busy: boolean;
  cloneUrl: string;
  createMode: CreateMode;
  name: string;
  projects: LocalProject[];
  styles: ReturnType<typeof createStyles>;
  onChangeCloneUrl: (value: string) => void;
  onChangeName: (value: string) => void;
  onChooseMode: (mode: CreateMode) => void;
  onOpenProject: (project: LocalProject) => void;
  onSubmit: (mode: Exclude<CreateMode, null>) => Promise<void>;
}) {
  const { colors, t } = useAppPresentation();
  return (
    <ScrollView
      contentContainerStyle={styles.listContent}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.lead}>{t('projects.description')}</Text>
      <View style={styles.creationActions}>
        <Pressable
          accessibilityLabel={t('projects.newProject')}
          accessibilityRole="button"
          onPress={() => onChooseMode('create')}
          style={({ pressed }) => [
            styles.creationButton,
            pressed && styles.pressed,
          ]}
          testID="projects-new-project"
        >
          <AppIcon color={colors.accent} icon={FolderPlus} size={23} />
          <Text style={styles.creationTitle}>{t('projects.newProject')}</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={t('projects.cloneRepository')}
          accessibilityRole="button"
          onPress={() => onChooseMode('clone')}
          style={({ pressed }) => [
            styles.creationButton,
            pressed && styles.pressed,
          ]}
          testID="projects-clone-repository"
        >
          <AppIcon color={colors.accent} icon={FolderDown} size={23} />
          <Text style={styles.creationTitle}>
            {t('projects.cloneRepository')}
          </Text>
        </Pressable>
      </View>

      {createMode !== null && (
        <View style={styles.formCard}>
          <Field
            autoCapitalize="none"
            label={t('projects.name')}
            placeholder={t('projects.namePlaceholder')}
            styles={styles}
            testID="projects-name-input"
            value={name}
            onChangeText={onChangeName}
          />
          {createMode === 'clone' && (
            <>
              <View style={styles.fieldGap} />
              <Field
                autoCapitalize="none"
                label={t('projects.remoteUrl')}
                placeholder={t('projects.remoteUrlPlaceholder')}
                styles={styles}
                testID="projects-remote-url-input"
                value={cloneUrl}
                onChangeText={onChangeCloneUrl}
              />
              <Text style={styles.formHint}>
                {t('projects.publicHttpsOnly')}
              </Text>
            </>
          )}
          <View style={styles.formActions}>
            <Pressable
              accessibilityLabel={
                createMode === 'clone'
                  ? t('projects.cancelClone')
                  : t('projects.cancelCreate')
              }
              accessibilityRole="button"
              onPress={() => onChooseMode(null)}
              style={styles.formCancel}
              testID="projects-clone-cancel"
            >
              <Text style={styles.formCancelText}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={
                createMode === 'clone'
                  ? t('projects.clone')
                  : t('projects.create')
              }
              accessibilityRole="button"
              accessibilityState={{
                disabled:
                  busy ||
                  (createMode === 'create'
                    ? name.trim().length === 0
                    : cloneUrl.trim().length === 0),
              }}
              disabled={
                busy ||
                (createMode === 'create'
                  ? name.trim().length === 0
                  : cloneUrl.trim().length === 0)
              }
              onPress={() => onSubmit(createMode).catch(() => undefined)}
              style={({ pressed }) => [
                styles.formSubmit,
                busy && styles.disabled,
                pressed && styles.pressed,
              ]}
              testID="projects-clone-submit"
            >
              <Text style={styles.formSubmitText}>
                {createMode === 'clone'
                  ? t('projects.clone')
                  : t('projects.create')}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      {projects.length === 0 && !busy ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{t('projects.emptyTitle')}</Text>
          <Text style={styles.emptyBody}>{t('projects.emptyBody')}</Text>
        </View>
      ) : (
        <View style={styles.projectList}>
          {projects.map(project => (
            <Pressable
              accessibilityLabel={t('projects.open', { name: project.name })}
              accessibilityRole="button"
              key={project.id}
              onPress={() => onOpenProject(project)}
              style={({ pressed }) => [
                styles.projectRow,
                pressed && styles.pressed,
              ]}
              testID={`projects-row-${project.name}`}
            >
              <View style={styles.projectIcon}>
                <AppIcon color={colors.accent} icon={FolderGit2} size={18} />
              </View>
              <View style={styles.flex}>
                <Text numberOfLines={1} style={styles.projectName}>
                  {project.name}
                </Text>
                <Text numberOfLines={1} style={styles.projectMeta}>
                  {project.origin_url === null
                    ? t('projects.local')
                    : project.origin_url}
                </Text>
              </View>
              <AppIcon
                color={colors.faint}
                icon={ChevronRight}
                size={18}
                style={styles.rowChevron}
              />
            </Pressable>
          ))}
        </View>
      )}
      {busy && projects.length === 0 && (
        <View style={styles.loadingCenter}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.loadingText}>{t('projects.loading')}</Text>
        </View>
      )}
    </ScrollView>
  );
}

function ChangesPanel({
  busy,
  diff,
  status,
  styles,
  onStageAll,
}: {
  busy: boolean;
  diff: ProjectDiff | null;
  status: ProjectGitStatus | null;
  styles: ReturnType<typeof createStyles>;
  onStageAll: () => Promise<void>;
}) {
  const { t } = useAppPresentation();
  if (status?.clean) {
    return (
      <View style={styles.emptyInline}>
        <Text style={styles.emptyTitle}>{t('projects.noChanges')}</Text>
        <Text style={styles.emptyBody}>{t('projects.noChangesBody')}</Text>
      </View>
    );
  }
  return (
    <View style={styles.card}>
      {(status?.entries ?? []).map(entry => (
        <View key={entry.path} style={styles.changeRow}>
          <View style={styles.flex}>
            <Text numberOfLines={1} style={styles.changePath}>
              {entry.path}
            </Text>
            <View style={styles.changeLabels}>
              {changeLabels(entry, t).map(label => (
                <Text key={label} style={styles.changeKind}>
                  {label}
                </Text>
              ))}
            </View>
          </View>
        </View>
      ))}
      {diff !== null && diff.files.length > 0 && (
        <View style={styles.diffSummary}>
          {diff.files.map(file => (
            <View key={file.path} style={styles.diffFileRow}>
              <Text numberOfLines={1} style={styles.diffFilePath}>
                {file.path}
              </Text>
              <Text style={styles.additions}>+{file.additions}</Text>
              <Text style={styles.deletions}>−{file.deletions}</Text>
            </View>
          ))}
        </View>
      )}
      <ScrollView horizontal style={styles.patchScroller}>
        <Text selectable style={styles.patch}>
          {diff?.patch || t('projects.diffUnavailable')}
        </Text>
      </ScrollView>
      <Pressable
        accessibilityLabel={t('projects.stageAll')}
        accessibilityRole="button"
        accessibilityState={{
          disabled: busy || (status?.entries.length ?? 0) === 0,
        }}
        disabled={busy || (status?.entries.length ?? 0) === 0}
        onPress={() => onStageAll().catch(() => undefined)}
        style={({ pressed }) => [
          styles.secondaryButton,
          (busy || (status?.entries.length ?? 0) === 0) && styles.disabled,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.secondaryButtonText}>{t('projects.stageAll')}</Text>
      </Pressable>
    </View>
  );
}

function Field({
  label,
  styles,
  ...props
}: {
  label: string;
  styles: ReturnType<typeof createStyles>;
} & React.ComponentProps<typeof TextInput>) {
  const { colors } = useAppPresentation();
  return (
    <View>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.faint}
        style={[styles.input, props.multiline && styles.multilineInput]}
        textAlignVertical={props.multiline ? 'top' : 'center'}
        {...props}
      />
    </View>
  );
}

function SectionLabel({
  label,
  styles,
}: {
  label: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return <Text style={styles.sectionLabel}>{label.toLocaleUpperCase()}</Text>;
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background,
      paddingHorizontal: 18,
    },
    flex: { flex: 1, minWidth: 0 },
    header: {
      height: 58,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    headerSpacer: { width: 42, height: 42 },
    headerTitleWrap: {
      flex: 1,
      minWidth: 0,
      alignItems: 'center',
      paddingHorizontal: 8,
    },
    headerTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
    headerCaption: {
      flexShrink: 1,
      color: colors.faint,
      fontFamily: fonts.mono,
      fontSize: 8,
      letterSpacing: 1.2,
      textTransform: 'uppercase',
    },
    headerCaptionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginTop: 3,
      maxWidth: '100%',
    },
    headerButton: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    listContent: { paddingTop: 12, paddingBottom: 110 },
    lead: { color: colors.muted, fontSize: 12, lineHeight: 18 },
    creationActions: { flexDirection: 'row', gap: 10, marginTop: 16 },
    creationButton: {
      flex: 1,
      minHeight: 82,
      borderRadius: 18,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      padding: 14,
      justifyContent: 'space-between',
    },
    creationTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
    formCard: {
      borderRadius: 19,
      backgroundColor: colors.surface,
      padding: 14,
      marginTop: 12,
    },
    fieldLabel: {
      color: colors.textDim,
      fontSize: 10,
      fontWeight: '700',
      marginBottom: 7,
    },
    input: {
      minHeight: 44,
      borderRadius: 12,
      backgroundColor: colors.background,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      color: colors.text,
      fontSize: 13,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    multilineInput: { minHeight: 78 },
    fieldGap: { height: 11 },
    formHint: {
      color: colors.muted,
      fontSize: 10,
      lineHeight: 15,
      marginTop: 9,
    },
    formActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
      marginTop: 12,
    },
    formCancel: {
      minHeight: 44,
      borderRadius: 12,
      backgroundColor: colors.surfaceRaised,
      paddingHorizontal: 15,
      alignItems: 'center',
      justifyContent: 'center',
    },
    formCancelText: { color: colors.textDim, fontSize: 12, fontWeight: '700' },
    formSubmit: {
      minHeight: 44,
      borderRadius: 12,
      backgroundColor: colors.text,
      paddingHorizontal: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    formSubmitText: {
      color: colors.background,
      fontSize: 12,
      fontWeight: '800',
    },
    projectList: {
      borderRadius: 19,
      backgroundColor: colors.surface,
      marginTop: 16,
      overflow: 'hidden',
    },
    projectRow: {
      minHeight: 68,
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
      paddingHorizontal: 13,
    },
    projectIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: colors.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 11,
    },
    projectName: { color: colors.text, fontSize: 14, fontWeight: '700' },
    projectMeta: {
      color: colors.muted,
      fontFamily: fonts.mono,
      fontSize: 8,
      marginTop: 4,
    },
    rowChevron: { marginLeft: 10 },
    empty: { alignItems: 'center', paddingVertical: 56, paddingHorizontal: 28 },
    emptyInline: {
      alignItems: 'center',
      borderRadius: 18,
      backgroundColor: colors.surface,
      padding: 28,
    },
    emptyTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
    emptyBody: {
      color: colors.muted,
      fontSize: 11,
      lineHeight: 17,
      marginTop: 7,
      textAlign: 'center',
    },
    loadingCenter: { alignItems: 'center', paddingVertical: 42, gap: 10 },
    loadingText: { color: colors.muted, fontSize: 11 },
    detailContent: { paddingTop: 8, paddingBottom: 110 },
    statusCard: {
      minHeight: 68,
      borderRadius: 18,
      backgroundColor: colors.surface,
      flexDirection: 'row',
      alignItems: 'center',
      padding: 12,
    },
    statusMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
    statusDot: {
      width: 9,
      height: 9,
      borderRadius: 5,
      backgroundColor: colors.warning,
      marginRight: 10,
    },
    statusDotClean: { backgroundColor: colors.success },
    statusDotConflict: { backgroundColor: colors.danger },
    statusTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
    statusMeta: {
      color: colors.muted,
      fontFamily: fonts.mono,
      fontSize: 8,
      marginTop: 4,
    },
    iconButton: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: colors.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
      marginLeft: 9,
    },
    tabs: {
      height: 42,
      borderRadius: 13,
      backgroundColor: colors.surface,
      flexDirection: 'row',
      padding: 4,
      marginTop: 11,
      marginBottom: 11,
    },
    tab: {
      flex: 1,
      borderRadius: 10,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
    },
    tabSelected: { backgroundColor: colors.text },
    tabText: { color: colors.muted, fontSize: 11, fontWeight: '700' },
    tabTextSelected: { color: colors.background },
    card: { borderRadius: 18, backgroundColor: colors.surface, padding: 14 },
    cardTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
    cardBody: {
      color: colors.muted,
      fontSize: 10,
      lineHeight: 15,
      marginTop: 6,
    },
    mono: {
      color: colors.accent,
      fontFamily: fonts.mono,
      fontSize: 9,
      marginTop: 7,
    },
    primaryButton: {
      minHeight: 44,
      borderRadius: 12,
      backgroundColor: colors.text,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 14,
      marginTop: 13,
    },
    primaryButtonText: {
      color: colors.background,
      fontSize: 12,
      fontWeight: '800',
    },
    secondaryButton: {
      minHeight: 44,
      borderRadius: 12,
      backgroundColor: colors.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 14,
      marginTop: 11,
    },
    secondaryButtonText: {
      color: colors.textDim,
      fontSize: 12,
      fontWeight: '700',
    },
    textButton: {
      minHeight: 40,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 3,
    },
    textButtonDanger: { color: colors.danger, fontSize: 11, fontWeight: '700' },
    sectionLabel: {
      color: colors.faint,
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 1.6,
      marginTop: 22,
      marginBottom: 8,
      marginLeft: 4,
    },
    changeRow: {
      minHeight: 50,
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    changePath: { color: colors.text, fontFamily: fonts.mono, fontSize: 10 },
    changeLabels: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 7,
      marginTop: 4,
    },
    changeKind: { color: colors.muted, fontSize: 9 },
    diffSummary: { marginTop: 10 },
    diffFileRow: { flexDirection: 'row', alignItems: 'center', minHeight: 26 },
    diffFilePath: { flex: 1, color: colors.textDim, fontSize: 10 },
    additions: { color: colors.success, fontFamily: fonts.mono, fontSize: 9 },
    deletions: {
      color: colors.danger,
      fontFamily: fonts.mono,
      fontSize: 9,
      marginLeft: 8,
    },
    patchScroller: {
      maxHeight: 260,
      borderRadius: 12,
      backgroundColor: colors.background,
      marginTop: 10,
    },
    patch: {
      color: colors.textDim,
      fontFamily: fonts.mono,
      fontSize: 9,
      lineHeight: 14,
      padding: 12,
    },
    credentialRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
      marginTop: 14,
      paddingTop: 14,
    },
    credentialDot: {
      width: 9,
      height: 9,
      borderRadius: 5,
      backgroundColor: colors.faint,
      marginLeft: 12,
    },
    toast: {
      position: 'absolute',
      left: 18,
      right: 18,
      bottom: 14,
      minHeight: 44,
      borderRadius: 14,
      backgroundColor: colors.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    toastError: {
      backgroundColor: colors.surfaceWarm,
      borderColor: colors.danger,
    },
    toastText: { flex: 1, color: colors.textDim, fontSize: 10, lineHeight: 15 },
    toastErrorText: { color: colors.danger },
    toastCancel: {
      borderRadius: 10,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    toastCancelText: { color: colors.textDim, fontSize: 10, fontWeight: '700' },
    disabled: { opacity: 0.42 },
    pressed: { opacity: 0.62, transform: [{ scale: 0.99 }] },
  });
