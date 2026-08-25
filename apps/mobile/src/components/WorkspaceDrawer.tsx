import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ArchiveRestore from 'lucide-react-native/icons/archive-restore';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import FileInput from 'lucide-react-native/icons/file-input';
import FileOutput from 'lucide-react-native/icons/file-output';
import FilePlus from 'lucide-react-native/icons/file-plus';
import FileText from 'lucide-react-native/icons/file-text';
import Folder from 'lucide-react-native/icons/folder';
import FolderPlus from 'lucide-react-native/icons/folder-plus';
import Hash from 'lucide-react-native/icons/hash';
import ListChecks from 'lucide-react-native/icons/list-checks';
import Pencil from 'lucide-react-native/icons/pencil';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import Save from 'lucide-react-native/icons/save';
import Trash2 from 'lucide-react-native/icons/trash-2';
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
  LocalWorkspace,
  type WorkspaceEntry,
  type WorkspaceTrashReceipt,
} from '../native/LocalWorkspace';
import { LocalDocuments } from '../native/LocalDocuments';
import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, type ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';
import { SlidingPanel } from './SlidingPanel';
import { StructuredContent, type StructuredBlock } from './StructuredContent';

type CreateKind = 'file' | 'directory';

function joinPath(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}/${name}`;
}

function parentPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function displayPath(
  path: string,
  rootPath: string,
  rootLabel: string,
): string {
  if (rootPath.length === 0)
    return path.length === 0 ? rootLabel : `${rootLabel}/${path}`;
  const relative = path === rootPath ? '' : path.slice(rootPath.length + 1);
  return relative.length === 0 ? rootLabel : `${rootLabel}/${relative}`;
}

function isWithinRoot(path: string, rootPath: string): boolean {
  return (
    rootPath.length === 0 ||
    path === rootPath ||
    path.startsWith(`${rootPath}/`)
  );
}

function isGitMetadata(path: string, rootPath: string): boolean {
  if (!isWithinRoot(path, rootPath)) return true;
  const relative =
    rootPath.length === 0 ? path : path.slice(rootPath.length + 1);
  return relative.split('/').some(part => part === '.git');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function WorkspaceDrawer({
  confirmDestructive = true,
  projectScope,
  readOnly = false,
  visible,
  onClose,
}: {
  confirmDestructive?: boolean;
  projectScope?: { rootPath: string; label: string };
  readOnly?: boolean;
  visible: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const rootPath = projectScope?.rootPath ?? '';
  const rootLabel = projectScope?.label ?? 'workspace';
  const projectScoped = projectScope !== undefined;
  const [path, setPath] = useState(rootPath);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createKind, setCreateKind] = useState<CreateKind | null>(null);
  const [newName, setNewName] = useState('');
  const [renameEntry, setRenameEntry] = useState<WorkspaceEntry | null>(null);
  const [renameName, setRenameName] = useState('');
  const [openFile, setOpenFile] = useState<WorkspaceEntry | null>(null);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [toolBlocks, setToolBlocks] = useState<StructuredBlock[]>([]);
  const [recentTrash, setRecentTrash] = useState<WorkspaceTrashReceipt[]>([]);

  const load = useCallback(
    async (nextPath: string) => {
      if (!LocalWorkspace.isAvailable()) {
        setError(t('files.unavailable'));
        return;
      }
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        if (
          !isWithinRoot(nextPath, rootPath) ||
          isGitMetadata(nextPath, rootPath)
        )
          throw new Error(
            'The requested path is outside the selected project.',
          );
        const [directory, trash] = await Promise.all([
          LocalWorkspace.listDirectory(nextPath),
          LocalWorkspace.listTrash(),
        ]);
        if (!isWithinRoot(directory.path, rootPath))
          throw new Error(
            'The native workspace returned an invalid project path.',
          );
        setPath(directory.path);
        setEntries(
          directory.entries.filter(
            entry => !isGitMetadata(entry.path, rootPath),
          ),
        );
        setRecentTrash(
          !projectScoped
            ? trash.entries
            : trash.entries.filter(receipt =>
                isWithinRoot(receipt.original_path, rootPath),
              ),
        );
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [projectScoped, rootPath, t],
  );

  useEffect(() => {
    if (!visible) return;
    setPath(rootPath);
    setOpenFile(null);
    setContent('');
    setSavedContent('');
    setToolBlocks([]);
    load(rootPath).catch(() => undefined);
  }, [load, rootPath, visible]);

  const open = useCallback(
    async (entry: WorkspaceEntry) => {
      if (entry.kind === 'directory') {
        await load(entry.path);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const file = await LocalWorkspace.readText(entry.path);
        setOpenFile(file.file);
        setContent(file.content);
        setSavedContent(file.content);
        setToolBlocks([]);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const beginCreate = useCallback(
    (kind: CreateKind) => {
      if (readOnly) return;
      setRenameEntry(null);
      setRenameName('');
      setCreateKind(kind);
      setNewName('');
    },
    [readOnly],
  );

  const beginRename = useCallback(
    (entry: WorkspaceEntry) => {
      if (readOnly) return;
      setCreateKind(null);
      setNewName('');
      setRenameEntry(entry);
      setRenameName(entry.name);
    },
    [readOnly],
  );

  useEffect(() => {
    if (!readOnly) return;
    setCreateKind(null);
    setNewName('');
    setRenameEntry(null);
    setRenameName('');
  }, [readOnly]);

  const create = useCallback(async () => {
    if (readOnly) return;
    const name = newName.trim();
    if (createKind === null || name.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const target = joinPath(path, name);
      if (projectScoped && isGitMetadata(target, rootPath)) {
        setError(t('files.gitMetadataProtected'));
        return;
      }
      if (createKind === 'directory')
        await LocalWorkspace.createDirectory(target);
      else await LocalWorkspace.writeText(target, '', { createOnly: true });
      setCreateKind(null);
      setNewName('');
      await load(path);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [createKind, load, newName, path, projectScoped, readOnly, rootPath, t]);

  const save = useCallback(async (): Promise<boolean> => {
    if (openFile === null || readOnly) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await LocalWorkspace.writeText(openFile.path, content, {
        createOnly: false,
        ...(openFile.revision === undefined
          ? {}
          : { expectedRevision: openFile.revision }),
      });
      setOpenFile(result.file);
      setSavedContent(content);
      setEntries(previous =>
        previous.map(entry =>
          entry.path === result.file.path ? result.file : entry,
        ),
      );
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }, [content, openFile, readOnly]);

  const closeEditor = useCallback(() => {
    setOpenFile(null);
    setContent('');
    setSavedContent('');
    setToolBlocks([]);
  }, []);

  const confirmEditorExit = useCallback(
    (afterClose: () => void) => {
      if (
        openFile === null ||
        content === savedContent ||
        !confirmDestructive
      ) {
        afterClose();
        return;
      }

      Alert.alert(`${t('files.saveChanges')}?`, openFile.path, [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.close'), style: 'destructive', onPress: afterClose },
        {
          text: t('common.save'),
          onPress: () => {
            save()
              .then(saved => {
                if (saved) afterClose();
              })
              .catch(() => undefined);
          },
        },
      ]);
    },
    [confirmDestructive, content, openFile, save, savedContent, t],
  );

  const requestEditorClose = useCallback(() => {
    confirmEditorExit(closeEditor);
  }, [closeEditor, confirmEditorExit]);

  const requestDrawerClose = useCallback(() => {
    confirmEditorExit(() => {
      closeEditor();
      onClose();
    });
  }, [closeEditor, confirmEditorExit, onClose]);

  const applyRename = useCallback(async () => {
    if (readOnly || renameEntry === null || renameName.trim().length === 0)
      return;
    setBusy(true);
    try {
      const destination = joinPath(
        parentPath(renameEntry.path),
        renameName.trim(),
      );
      if (projectScoped && isGitMetadata(destination, rootPath)) {
        setError(t('files.gitMetadataProtected'));
        return;
      }
      await LocalWorkspace.renameEntry(renameEntry.path, destination);
      setRenameEntry(null);
      setRenameName('');
      await load(path);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [
    load,
    path,
    projectScoped,
    readOnly,
    renameEntry,
    renameName,
    rootPath,
    t,
  ]);

  const moveToTrash = useCallback(
    (entry: WorkspaceEntry) => {
      if (readOnly) return;
      const perform = async () => {
        setBusy(true);
        try {
          const receipt = await LocalWorkspace.trashEntry(entry.path);
          setRecentTrash(previous => [receipt, ...previous].slice(0, 8));
          if (openFile?.path === entry.path) setOpenFile(null);
          await load(path);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setBusy(false);
        }
      };
      if (!confirmDestructive) {
        perform().catch(() => undefined);
        return;
      }
      Alert.alert(
        t('files.destructiveTitle', { name: entry.name }),
        t('files.destructiveBody', {
          kind: t(
            entry.kind === 'file' ? 'files.kind.file' : 'files.kind.folder',
          ),
        }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('files.moveToTrash'),
            style: 'destructive',
            onPress: () => perform().catch(() => undefined),
          },
        ],
      );
    },
    [confirmDestructive, load, openFile?.path, path, readOnly, t],
  );

  const restore = useCallback(
    async (receipt: WorkspaceTrashReceipt) => {
      if (readOnly) return;
      setBusy(true);
      setError(null);
      try {
        await LocalWorkspace.restoreFromTrash(receipt.trash_id);
        setRecentTrash(previous =>
          previous.filter(item => item.trash_id !== receipt.trash_id),
        );
        await load(path);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [load, path, readOnly],
  );

  const runTool = useCallback(
    async (tool: 'sha256sum' | 'wc') => {
      if (openFile === null) return;
      const callId = `tool-${Date.now()}`;
      const argumentsText = JSON.stringify({
        path: openFile.path,
        ...(tool === 'wc' ? { metric: 'words' } : {}),
      });
      setToolBlocks([
        {
          id: `${callId}-call`,
          type: 'tool-call',
          name: tool,
          arguments: argumentsText,
          status: 'running',
        },
      ]);
      try {
        const result = await LocalWorkspace.executePortableTool(
          tool,
          openFile.path,
          tool === 'wc' ? { metric: 'words' } : {},
        );
        setToolBlocks([
          {
            id: `${callId}-call`,
            type: 'tool-call',
            name: tool,
            arguments: argumentsText,
            status: 'success',
          },
          {
            id: `${callId}-result`,
            type: 'tool-result',
            name: tool,
            output: result.stdout || result.stderr,
            isError: result.exit_code !== 0,
          },
        ]);
      } catch (caught) {
        setToolBlocks([
          {
            id: `${callId}-call`,
            type: 'tool-call',
            name: tool,
            arguments: argumentsText,
            status: 'error',
          },
          {
            id: `${callId}-result`,
            type: 'tool-result',
            name: tool,
            output: caught instanceof Error ? caught.message : String(caught),
            isError: true,
          },
        ]);
      }
    },
    [openFile],
  );

  const importFromFiles = useCallback(async () => {
    if (readOnly || busy) return;
    if (!LocalDocuments.isAvailable()) {
      setError(t('files.documentsUnavailable'));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await LocalDocuments.presentImportPicker(path);
      if (result.status === 'cancelled') return;
      await load(path);
      setNotice(t('files.importedCount', { count: result.entries.length }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [busy, load, path, readOnly, t]);

  const exportPathsToFiles = useCallback(
    async (sourcePaths: string[]) => {
      if (sourcePaths.length === 0 || busy) return;
      if (!LocalDocuments.isAvailable()) {
        setError(t('files.documentsUnavailable'));
        return;
      }
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const result = await LocalDocuments.presentExportPicker(sourcePaths);
        if (result.status === 'cancelled') return;
        setNotice(t('files.exportedCount', { count: result.item_count }));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [busy, t],
  );

  const exportToFiles = useCallback(async () => {
    if (openFile === null) return;
    await exportPathsToFiles([openFile.path]);
  }, [exportPathsToFiles, openFile]);

  return (
    <SlidingPanel
      accessibilityLabel={t('files.title')}
      onClose={onClose}
      visible={visible}
    >
      <View
        style={[
          styles.root,
          { paddingTop: insets.top + 10, paddingBottom: insets.bottom + 12 },
        ]}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>
              {t('files.onDevice').toLocaleUpperCase()}
            </Text>
            <Text accessibilityRole="header" style={styles.title}>
              {openFile === null
                ? projectScope?.label ?? t('files.title')
                : openFile.name}
            </Text>
          </View>
          <Pressable
            accessibilityLabel={t('files.close')}
            accessibilityRole="button"
            onPress={requestDrawerClose}
            style={styles.close}
          >
            <AppIcon color={colors.text} icon={X} size={21} />
          </Pressable>
        </View>

        {openFile === null ? (
          <>
            <View style={styles.pathBar}>
              {path !== rootPath && (
                <Pressable
                  accessibilityLabel={t('files.up')}
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => load(parentPath(path)).catch(() => undefined)}
                  style={styles.pathAction}
                >
                  <AppIcon
                    color={colors.textDim}
                    icon={ChevronLeft}
                    size={20}
                  />
                </Pressable>
              )}
              <Text numberOfLines={1} style={styles.pathText}>
                {displayPath(path, rootPath, rootLabel)}
              </Text>
              <Pressable
                accessibilityLabel={t('files.refresh')}
                accessibilityRole="button"
                disabled={busy}
                onPress={() => load(path).catch(() => undefined)}
                style={styles.pathAction}
              >
                <AppIcon color={colors.textDim} icon={RefreshCw} size={18} />
              </Pressable>
            </View>
            <View style={styles.createButtons}>
              <Pressable
                accessibilityLabel={t('files.newFile')}
                accessibilityRole="button"
                accessibilityState={{ disabled: readOnly || busy }}
                disabled={readOnly || busy}
                onPress={() => beginCreate('file')}
                style={[
                  styles.createButton,
                  (readOnly || busy) && styles.disabled,
                ]}
              >
                <AppIcon color={colors.accent} icon={FilePlus} size={17} />
                <Text style={styles.createButtonText}>
                  {t('files.newFile')}
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel={t('files.newFolder')}
                accessibilityRole="button"
                accessibilityState={{ disabled: readOnly || busy }}
                disabled={readOnly || busy}
                onPress={() => beginCreate('directory')}
                style={[
                  styles.createButton,
                  (readOnly || busy) && styles.disabled,
                ]}
              >
                <AppIcon color={colors.accent} icon={FolderPlus} size={17} />
                <Text style={styles.createButtonText}>
                  {t('files.newFolder')}
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel={t('files.importFromFiles')}
                accessibilityRole="button"
                accessibilityState={{
                  disabled: readOnly || busy || !LocalDocuments.isAvailable(),
                }}
                disabled={readOnly || busy || !LocalDocuments.isAvailable()}
                onPress={() => importFromFiles().catch(() => undefined)}
                style={[
                  styles.createButton,
                  (readOnly || busy || !LocalDocuments.isAvailable()) &&
                    styles.disabled,
                ]}
              >
                <AppIcon color={colors.accent} icon={FileInput} size={17} />
                <Text style={styles.createButtonText}>
                  {t('files.importFromFiles')}
                </Text>
              </Pressable>
            </View>
            {createKind !== null && (
              <View style={styles.inlineEditor}>
                <Text style={styles.inlineLabel}>
                  {createKind === 'file'
                    ? t('files.newFile')
                    : t('files.newFolder')}
                </Text>
                <TextInput
                  accessibilityLabel={t('files.namePlaceholder')}
                  autoFocus
                  onChangeText={setNewName}
                  placeholder={t('files.namePlaceholder')}
                  placeholderTextColor={colors.faint}
                  style={styles.nameInput}
                  value={newName}
                />
                <View style={styles.inlineActions}>
                  <Pressable
                    accessibilityLabel={t('common.cancel')}
                    accessibilityRole="button"
                    onPress={() => {
                      setCreateKind(null);
                      setNewName('');
                    }}
                    style={styles.inlineSecondary}
                  >
                    <Text style={styles.inlineSecondaryText}>
                      {t('common.cancel')}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel={t('files.create')}
                    accessibilityRole="button"
                    accessibilityState={{
                      disabled: busy || newName.trim().length === 0,
                    }}
                    disabled={busy || newName.trim().length === 0}
                    onPress={() => create().catch(() => undefined)}
                    style={[
                      styles.inlinePrimary,
                      (busy || newName.trim().length === 0) && styles.disabled,
                    ]}
                  >
                    <Text style={styles.inlinePrimaryText}>
                      {t('files.create')}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}
            {renameEntry !== null && (
              <View style={styles.inlineEditor}>
                <Text style={styles.inlineLabel}>
                  {t('files.rename', { name: renameEntry.name })}
                </Text>
                <TextInput
                  accessibilityLabel={t('common.rename')}
                  autoFocus
                  onChangeText={setRenameName}
                  placeholder={renameEntry.name}
                  placeholderTextColor={colors.faint}
                  style={styles.nameInput}
                  value={renameName}
                />
                <View style={styles.inlineActions}>
                  <Pressable
                    accessibilityLabel={t('common.cancel')}
                    accessibilityRole="button"
                    onPress={() => {
                      setRenameEntry(null);
                      setRenameName('');
                    }}
                    style={styles.inlineSecondary}
                  >
                    <Text style={styles.inlineSecondaryText}>
                      {t('common.cancel')}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel={t('common.rename')}
                    accessibilityRole="button"
                    accessibilityState={{
                      disabled: busy || renameName.trim().length === 0,
                    }}
                    disabled={busy || renameName.trim().length === 0}
                    onPress={() => applyRename().catch(() => undefined)}
                    style={[
                      styles.inlinePrimary,
                      (busy || renameName.trim().length === 0) &&
                        styles.disabled,
                    ]}
                  >
                    <Text style={styles.inlinePrimaryText}>
                      {t('common.rename')}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}
            <ScrollView contentContainerStyle={styles.list}>
              {busy && entries.length === 0 ? (
                <View style={styles.loading}>
                  <ActivityIndicator color={colors.accent} />
                  <Text style={styles.loadingText}>{t('files.loading')}</Text>
                </View>
              ) : entries.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyTitle}>{t('files.emptyTitle')}</Text>
                  <Text style={styles.emptyBody}>{t('files.emptyBody')}</Text>
                </View>
              ) : (
                entries.map(entry => (
                  <View key={entry.path} style={styles.entryRow}>
                    <Pressable
                      accessibilityLabel={t('files.open', { name: entry.name })}
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() => open(entry).catch(() => undefined)}
                      style={styles.entryMain}
                    >
                      <View style={styles.entryIcon}>
                        <AppIcon
                          color={colors.accent}
                          icon={entry.kind === 'directory' ? Folder : FileText}
                          size={17}
                        />
                      </View>
                      <View style={styles.entryCopy}>
                        <Text numberOfLines={1} style={styles.entryName}>
                          {entry.name}
                        </Text>
                        <Text style={styles.entryMeta}>
                          {entry.kind === 'directory'
                            ? t('files.kind.folder')
                            : formatSize(entry.size)}
                        </Text>
                      </View>
                    </Pressable>
                    <Pressable
                      accessibilityLabel={t('files.exportEntry', {
                        name: entry.name,
                      })}
                      accessibilityRole="button"
                      accessibilityState={{
                        disabled: busy || !LocalDocuments.isAvailable(),
                      }}
                      disabled={busy || !LocalDocuments.isAvailable()}
                      onPress={() =>
                        exportPathsToFiles([entry.path]).catch(() => undefined)
                      }
                      style={[
                        styles.smallAction,
                        (busy || !LocalDocuments.isAvailable()) &&
                          styles.disabled,
                      ]}
                    >
                      <AppIcon
                        color={colors.muted}
                        icon={FileOutput}
                        size={17}
                      />
                    </Pressable>
                    {!readOnly && (
                      <Pressable
                        accessibilityLabel={t('files.rename', {
                          name: entry.name,
                        })}
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() => beginRename(entry)}
                        style={styles.smallAction}
                      >
                        <AppIcon color={colors.muted} icon={Pencil} size={16} />
                      </Pressable>
                    )}
                    {!readOnly && (
                      <Pressable
                        accessibilityLabel={t('files.delete', {
                          name: entry.name,
                        })}
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() => moveToTrash(entry)}
                        style={styles.smallAction}
                      >
                        <AppIcon
                          color={colors.danger}
                          icon={Trash2}
                          size={17}
                        />
                      </Pressable>
                    )}
                  </View>
                ))
              )}
              {!readOnly && recentTrash.length > 0 && (
                <Text style={styles.sectionLabel}>
                  {t('files.recent').toLocaleUpperCase()}
                </Text>
              )}
              {!readOnly &&
                recentTrash.map(receipt => (
                  <View key={receipt.trash_id} style={styles.trashRow}>
                    <Text numberOfLines={1} style={styles.trashName}>
                      {receipt.original_path}
                    </Text>
                    <Pressable
                      accessibilityLabel={`${t('files.restore')} ${
                        receipt.original_path
                      }`}
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() => restore(receipt).catch(() => undefined)}
                      style={styles.restoreButton}
                    >
                      <AppIcon
                        color={colors.success}
                        icon={ArchiveRestore}
                        size={15}
                      />
                      <Text style={styles.restoreText}>
                        {t('files.restore')}
                      </Text>
                    </Pressable>
                  </View>
                ))}
            </ScrollView>
          </>
        ) : (
          <ScrollView
            contentContainerStyle={styles.editor}
            keyboardDismissMode="interactive"
          >
            <Text style={styles.editorPath}>
              {displayPath(openFile.path, rootPath, rootLabel)}
            </Text>
            <TextInput
              accessibilityLabel={t('files.content')}
              editable={!readOnly}
              multiline
              onChangeText={setContent}
              placeholder={t('files.content')}
              placeholderTextColor={colors.faint}
              style={styles.contentInput}
              textAlignVertical="top"
              value={content}
            />
            <View style={styles.editorActions}>
              <Pressable
                accessibilityLabel={t('common.close')}
                accessibilityRole="button"
                onPress={requestEditorClose}
                style={styles.inlineSecondary}
              >
                <AppIcon color={colors.textDim} icon={X} size={15} />
                <Text style={styles.inlineSecondaryText}>
                  {t('common.close')}
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel={t('files.exportToFiles')}
                accessibilityRole="button"
                accessibilityState={{
                  disabled: busy || !LocalDocuments.isAvailable(),
                }}
                disabled={busy || !LocalDocuments.isAvailable()}
                onPress={() => exportToFiles().catch(() => undefined)}
                style={[
                  styles.inlineSecondary,
                  (busy || !LocalDocuments.isAvailable()) && styles.disabled,
                ]}
              >
                <AppIcon color={colors.textDim} icon={FileOutput} size={15} />
                <Text style={styles.inlineSecondaryText}>
                  {t('files.exportToFiles')}
                </Text>
              </Pressable>
              {!readOnly && (
                <Pressable
                  accessibilityLabel={t('files.saveChanges')}
                  accessibilityRole="button"
                  accessibilityState={{
                    disabled: busy || content === savedContent,
                  }}
                  disabled={busy || content === savedContent}
                  onPress={() => save().catch(() => undefined)}
                  style={[
                    styles.inlinePrimary,
                    (busy || content === savedContent) && styles.disabled,
                  ]}
                >
                  <AppIcon color={colors.background} icon={Save} size={15} />
                  <Text style={styles.inlinePrimaryText}>
                    {t('files.saveChanges')}
                  </Text>
                </Pressable>
              )}
            </View>
            <Text style={styles.sectionLabel}>
              {t('files.toolOutput').toLocaleUpperCase()}
            </Text>
            <View style={styles.toolActions}>
              <Pressable
                accessibilityLabel={t('files.checksum')}
                accessibilityRole="button"
                disabled={busy}
                onPress={() => runTool('sha256sum').catch(() => undefined)}
                style={styles.toolButton}
              >
                <AppIcon color={colors.textDim} icon={Hash} size={15} />
                <Text style={styles.toolButtonText}>{t('files.checksum')}</Text>
              </Pressable>
              <Pressable
                accessibilityLabel={t('files.count')}
                accessibilityRole="button"
                disabled={busy}
                onPress={() => runTool('wc').catch(() => undefined)}
                style={styles.toolButton}
              >
                <AppIcon color={colors.textDim} icon={ListChecks} size={15} />
                <Text style={styles.toolButtonText}>{t('files.count')}</Text>
              </Pressable>
            </View>
            {toolBlocks.length > 0 && (
              <StructuredContent autoExpandTools blocks={toolBlocks} />
            )}
          </ScrollView>
        )}
        {error !== null && (
          <Text
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            style={styles.error}
          >
            {error}
          </Text>
        )}
        {error === null && notice !== null && (
          <Text accessibilityLiveRegion="polite" style={styles.notice}>
            {notice}
          </Text>
        )}
      </View>
    </SlidingPanel>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background,
      paddingHorizontal: 18,
    },
    header: {
      height: 62,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    eyebrow: {
      color: colors.accent,
      fontSize: 8,
      fontWeight: '800',
      letterSpacing: 1.7,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 27,
      marginTop: 4,
    },
    close: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pathBar: {
      height: 46,
      borderRadius: 13,
      backgroundColor: colors.surface,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 2,
      marginTop: 10,
    },
    pathAction: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pathText: {
      flex: 1,
      color: colors.muted,
      fontFamily: fonts.mono,
      fontSize: 10,
      paddingHorizontal: 6,
    },
    createButtons: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 10,
    },
    createButton: {
      minHeight: 44,
      borderRadius: 12,
      backgroundColor: colors.surfaceRaised,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      paddingHorizontal: 12,
    },
    createButtonText: {
      color: colors.textDim,
      fontSize: 11,
      fontWeight: '700',
    },
    inlineEditor: {
      borderRadius: 16,
      backgroundColor: colors.surfaceWarm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accentSoft,
      padding: 13,
      marginTop: 11,
    },
    inlineLabel: { color: colors.text, fontSize: 13, fontWeight: '700' },
    nameInput: {
      height: 44,
      borderRadius: 12,
      backgroundColor: colors.background,
      color: colors.text,
      fontSize: 14,
      paddingHorizontal: 12,
      marginTop: 9,
    },
    inlineActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
      marginTop: 9,
    },
    inlineSecondary: {
      minHeight: 44,
      borderRadius: 12,
      backgroundColor: colors.surfaceRaised,
      paddingHorizontal: 14,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
    },
    inlineSecondaryText: {
      color: colors.textDim,
      fontSize: 11,
      fontWeight: '700',
    },
    inlinePrimary: {
      minHeight: 44,
      borderRadius: 12,
      backgroundColor: colors.text,
      paddingHorizontal: 14,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
    },
    inlinePrimaryText: {
      color: colors.background,
      fontSize: 11,
      fontWeight: '800',
    },
    list: { paddingVertical: 12, paddingBottom: 32 },
    entryRow: {
      minHeight: 62,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.lineSoft,
      flexDirection: 'row',
      alignItems: 'center',
    },
    entryMain: {
      flex: 1,
      minHeight: 62,
      flexDirection: 'row',
      alignItems: 'center',
    },
    entryIcon: {
      width: 34,
      height: 34,
      borderRadius: 10,
      backgroundColor: colors.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 10,
    },
    entryCopy: { flex: 1 },
    entryName: { color: colors.text, fontSize: 14, fontWeight: '600' },
    entryMeta: {
      color: colors.muted,
      fontFamily: fonts.mono,
      fontSize: 9,
      marginTop: 4,
    },
    smallAction: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    loading: { paddingVertical: 44, alignItems: 'center', gap: 10 },
    loadingText: { color: colors.muted, fontSize: 12 },
    empty: { paddingVertical: 44, alignItems: 'center' },
    emptyTitle: { color: colors.text, fontFamily: fonts.display, fontSize: 20 },
    emptyBody: {
      color: colors.muted,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 6,
      textAlign: 'center',
    },
    sectionLabel: {
      color: colors.faint,
      fontSize: 8,
      fontWeight: '800',
      letterSpacing: 1.6,
      marginTop: 23,
      marginBottom: 8,
    },
    trashRow: {
      minHeight: 52,
      borderRadius: 13,
      backgroundColor: colors.surface,
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: 12,
      paddingRight: 4,
      marginBottom: 6,
    },
    trashName: {
      flex: 1,
      color: colors.muted,
      fontFamily: fonts.mono,
      fontSize: 10,
    },
    restoreButton: {
      minHeight: 44,
      borderRadius: 10,
      backgroundColor: colors.surfaceRaised,
      paddingHorizontal: 12,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
    },
    restoreText: { color: colors.success, fontSize: 10, fontWeight: '700' },
    editor: { paddingTop: 12, paddingBottom: 35 },
    editorPath: {
      color: colors.muted,
      fontFamily: fonts.mono,
      fontSize: 10,
      marginBottom: 10,
    },
    contentInput: {
      minHeight: 330,
      borderRadius: 17,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      color: colors.text,
      fontFamily: fonts.mono,
      fontSize: 13,
      lineHeight: 20,
      padding: 14,
    },
    editorActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
      marginTop: 10,
    },
    toolActions: { flexDirection: 'row', gap: 8, marginBottom: 10 },
    toolButton: {
      minHeight: 44,
      borderRadius: 12,
      backgroundColor: colors.surfaceRaised,
      paddingHorizontal: 12,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
    },
    toolButtonText: {
      color: colors.textDim,
      fontFamily: fonts.mono,
      fontSize: 10,
      fontWeight: '700',
    },
    error: {
      color: colors.danger,
      fontSize: 11,
      lineHeight: 16,
      paddingVertical: 8,
    },
    notice: {
      color: colors.success,
      fontSize: 11,
      lineHeight: 16,
      paddingVertical: 8,
    },
    disabled: { opacity: 0.35 },
  });
