import React, { useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react-native';
import ArrowUpRight from 'lucide-react-native/icons/arrow-up-right';
import BadgeCheck from 'lucide-react-native/icons/badge-check';
import Boxes from 'lucide-react-native/icons/boxes';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import Ellipsis from 'lucide-react-native/icons/ellipsis';
import FolderKanban from 'lucide-react-native/icons/folder-kanban';
import FolderOpen from 'lucide-react-native/icons/folder-open';
import Plus from 'lucide-react-native/icons/plus';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import Search from 'lucide-react-native/icons/search';
import Settings from 'lucide-react-native/icons/settings';
import X from 'lucide-react-native/icons/x';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Translator } from '../preferences';
import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, hitSlop, type ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';
import { BrandMark } from './BrandMark';
import type { RuntimeVerificationStatus } from './RuntimeEvidenceSheet';
import { SlidingSurface } from './SlidingSurface';

export type ConversationSummary = {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  /** Entries without at least one message are working drafts, not history. */
  messageCount?: number;
};

type Props = {
  activeId: string | null;
  conversations: ConversationSummary[];
  runtimeLabel: string;
  runtimeStatus: RuntimeVerificationStatus;
  covered: boolean;
  visible: boolean;
  pendingProjectCleanup: boolean;
  onClose: () => void;
  onDismiss: () => void;
  onNewChat: () => void;
  onOpenConversationMenu: (id: string) => void;
  onOpenAccount: () => void;
  onOpenFiles: () => void;
  onOpenProjects: () => void;
  onOpenPendingProjectCleanup: () => void;
  onOpenHarnesses: () => void;
  onOpenRuntime: () => void;
  onOpenSettings: () => void;
  onSelect: (id: string) => void;
};

function timeLabel(timestamp: number, locale: string, t: Translator): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return t('drawer.time.now');
  if (delta < 3_600_000)
    return t('drawer.time.minutes', { count: Math.floor(delta / 60_000) });
  if (delta < 86_400_000)
    return t('drawer.time.hours', { count: Math.floor(delta / 3_600_000) });
  if (delta < 604_800_000)
    return t('drawer.time.days', { count: Math.floor(delta / 86_400_000) });
  return new Date(timestamp).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
  });
}

export function ChatDrawer(props: Props) {
  const insets = useSafeAreaInsets();
  const { colors, locale, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [query, setQuery] = useState('');
  // Zero-message conversations are working drafts, never history.
  const history = useMemo(
    () => props.conversations.filter(c => (c.messageCount ?? 0) > 0),
    [props.conversations],
  );
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (normalized.length === 0) return history;
    return history.filter(item =>
      `${item.title}\n${item.preview}`.toLocaleLowerCase().includes(normalized),
    );
  }, [history, query]);

  return (
    <SlidingSurface
      closeAccessibilityLabel={t('drawer.closeNavigation')}
      accessibilityHidden={props.covered}
      onClose={props.onClose}
      onDismiss={props.onDismiss}
      side="left"
      visible={props.visible}
      widthRatio={0.88}
      maxWidth={520}
    >
      <View
        style={[
          styles.drawer,
          { paddingTop: insets.top + 10, paddingBottom: insets.bottom + 16 },
        ]}
      >
        <View style={styles.header}>
          <View>
            <BrandMark size={37} />
            <Text style={styles.brandCaption}>{t('home.localWorkspace')}</Text>
          </View>
          <Pressable
            accessibilityLabel={t('drawer.closeNavigation')}
            accessibilityRole="button"
            hitSlop={hitSlop}
            onPress={props.onClose}
            style={({ pressed }) => [
              styles.closeButton,
              pressed && styles.pressed,
            ]}
            testID="drawer-close"
          >
            <AppIcon color={colors.text} icon={X} size={20} />
          </Pressable>
        </View>

        <Pressable
          accessibilityLabel={t('drawer.createNewChat')}
          accessibilityRole="button"
          onPress={props.onNewChat}
          style={({ pressed }) => [styles.newChat, pressed && styles.pressed]}
          testID="drawer-new-chat"
        >
          <AppIcon
            color={colors.background}
            icon={Plus}
            size={20}
            style={styles.newChatLeadingIcon}
          />
          <Text style={styles.newChatText}>{t('drawer.newChat')}</Text>
          <AppIcon
            color={colors.background}
            icon={ArrowUpRight}
            size={18}
            style={styles.newChatTrailingIcon}
          />
        </Pressable>

        <View style={styles.searchWrap}>
          <AppIcon
            color={colors.muted}
            icon={Search}
            size={18}
            style={styles.searchIcon}
          />
          <TextInput
            accessibilityLabel={t('drawer.searchConversations')}
            autoCapitalize="none"
            onChangeText={setQuery}
            placeholder={t('drawer.searchPlaceholder')}
            placeholderTextColor={colors.faint}
            style={styles.searchInput}
            value={query}
          />
        </View>

        <View style={styles.utilityRows}>
          {props.pendingProjectCleanup && (
            <UtilityRow
              icon={RefreshCw}
              label={t('drawer.pendingProjectCleanup')}
              onPress={props.onOpenPendingProjectCleanup}
            />
          )}
          <UtilityRow
            icon={FolderKanban}
            label={t('drawer.projects')}
            onPress={props.onOpenProjects}
            testID="drawer-projects"
          />
          <UtilityRow
            icon={Boxes}
            label={t('drawer.harnesses')}
            onPress={props.onOpenHarnesses}
            testID="drawer-harnesses"
          />
          <UtilityRow
            icon={FolderOpen}
            label={t('drawer.files')}
            onPress={props.onOpenFiles}
            testID="drawer-files"
          />
          <UtilityRow
            icon={BadgeCheck}
            label={t('drawer.runtimeProof')}
            onPress={props.onOpenRuntime}
            testID="drawer-runtime-proof"
          />
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionLabel}>{t('drawer.recent')}</Text>
          <Text style={styles.sectionCount}>{filtered.length}</Text>
        </View>

        <ScrollView
          contentContainerStyle={styles.conversationList}
          keyboardShouldPersistTaps="handled"
        >
          {filtered.length === 0 ? (
            <View style={styles.noResults}>
              <Text style={styles.noResultsTitle}>
                {t('drawer.noMatchingChats')}
              </Text>
              <Text style={styles.noResultsBody}>
                {t('drawer.tryAnotherSearch')}
              </Text>
            </View>
          ) : (
            filtered.map(item => {
              const active = item.id === props.activeId;
              return (
                <View
                  key={item.id}
                  style={[
                    styles.conversationRow,
                    active && styles.conversationRowActive,
                  ]}
                >
                  {active && <View style={styles.activeRail} />}
                  <Pressable
                    accessibilityLabel={t('drawer.openChat', {
                      title: item.title,
                    })}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => props.onSelect(item.id)}
                    style={({ pressed }) => [
                      styles.conversationMain,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View style={styles.conversationTitleRow}>
                      <Text numberOfLines={1} style={styles.conversationTitle}>
                        {item.title}
                      </Text>
                      <Text style={styles.conversationTime}>
                        {timeLabel(item.updatedAt, locale, t)}
                      </Text>
                    </View>
                    <Text numberOfLines={1} style={styles.conversationPreview}>
                      {item.preview || t('drawer.emptyConversation')}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel={t('drawer.chatActions', {
                      title: item.title,
                    })}
                    accessibilityRole="button"
                    hitSlop={hitSlop}
                    onPress={() => props.onOpenConversationMenu(item.id)}
                    style={({ pressed }) => [
                      styles.moreButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    <AppIcon color={colors.muted} icon={Ellipsis} size={18} />
                  </Pressable>
                </View>
              );
            })
          )}
        </ScrollView>

        <View style={styles.footer}>
          <View
            accessible
            accessibilityLabel={`${t('drawer.execution')}: ${
              props.runtimeLabel
            }`}
            accessibilityLiveRegion="polite"
            style={styles.runtimeFooter}
          >
            <View
              style={[
                styles.runtimeDot,
                props.runtimeStatus === 'verified' && styles.runtimeDotReady,
                props.runtimeStatus === 'failed' && styles.runtimeDotFailed,
              ]}
            />
            <Text numberOfLines={1} style={styles.runtimeFooterValue}>
              {props.runtimeLabel}
            </Text>
          </View>
          <View style={styles.accountDock}>
            <Pressable
              accessibilityLabel={t('drawer.openAccount')}
              accessibilityRole="button"
              onPress={props.onOpenAccount}
              style={({ pressed }) => [
                styles.accountButton,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.avatar}>
                <BrandMark compact size={28} />
              </View>
              <View style={styles.accountCopy}>
                <Text style={styles.accountName}>{t('drawer.localUser')}</Text>
                <Text numberOfLines={1} style={styles.accountHint}>
                  {t('drawer.accountHint')}
                </Text>
              </View>
            </Pressable>
            <Pressable
              accessibilityLabel={t('drawer.settings')}
              accessibilityRole="button"
              onPress={props.onOpenSettings}
              style={({ pressed }) => [
                styles.settingsButton,
                pressed && styles.pressed,
              ]}
            >
              <AppIcon color={colors.textDim} icon={Settings} size={20} />
            </Pressable>
          </View>
        </View>
      </View>
    </SlidingSurface>
  );
}

function UtilityRow({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  const { colors } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.utilityRow, pressed && styles.pressed]}
      testID={testID}
    >
      <View style={styles.utilityIcon}>
        <AppIcon color={colors.accent} icon={icon} size={19} />
      </View>
      <Text style={styles.utilityLabel}>{label}</Text>
      <AppIcon
        color={colors.faint}
        icon={ChevronRight}
        size={15}
        style={styles.utilityArrow}
      />
    </Pressable>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    drawer: {
      flex: 1,
      backgroundColor: colors.background,
      paddingHorizontal: 18,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    brandCaption: {
      color: colors.faint,
      fontSize: 8,
      fontWeight: '800',
      letterSpacing: 1.8,
      marginTop: 3,
    },
    closeButton: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    newChat: {
      height: 52,
      borderRadius: 17,
      backgroundColor: colors.text,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      marginTop: 24,
    },
    newChatLeadingIcon: { marginRight: 10 },
    newChatText: { color: colors.background, fontSize: 15, fontWeight: '700' },
    newChatTrailingIcon: { marginLeft: 'auto' },
    searchWrap: {
      height: 44,
      borderRadius: 14,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      marginTop: 13,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 13,
    },
    searchIcon: { marginRight: 8 },
    searchInput: {
      flex: 1,
      color: colors.text,
      fontSize: 14,
      paddingVertical: 0,
    },
    utilityRows: { marginTop: 18, gap: 5 },
    utilityRow: {
      minHeight: 46,
      borderRadius: 13,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    utilityIcon: { width: 26 },
    utilityLabel: {
      flex: 1,
      flexShrink: 1,
      minWidth: 0,
      color: colors.textDim,
      fontSize: 14,
      lineHeight: 20,
      fontWeight: '600',
    },
    utilityArrow: { marginLeft: 8, flexShrink: 0 },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 24,
      marginBottom: 8,
      paddingHorizontal: 4,
    },
    sectionLabel: {
      color: colors.faint,
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 1.8,
    },
    sectionCount: { color: colors.faint, fontSize: 10, marginLeft: 'auto' },
    conversationList: { paddingBottom: 18, gap: 5 },
    conversationRow: {
      minHeight: 64,
      borderRadius: 15,
      flexDirection: 'row',
      alignItems: 'center',
      overflow: 'hidden',
    },
    conversationRowActive: { backgroundColor: colors.surfaceRaised },
    activeRail: {
      position: 'absolute',
      left: 0,
      width: 3,
      height: 28,
      borderTopRightRadius: 3,
      borderBottomRightRadius: 3,
      backgroundColor: colors.accent,
    },
    conversationMain: {
      flex: 1,
      paddingLeft: 13,
      paddingRight: 4,
      paddingVertical: 10,
    },
    conversationTitleRow: { flexDirection: 'row', alignItems: 'center' },
    conversationTitle: {
      flex: 1,
      color: colors.text,
      fontSize: 14,
      fontWeight: '600',
    },
    conversationTime: {
      color: colors.faint,
      fontFamily: fonts.mono,
      fontSize: 9,
      marginLeft: 8,
    },
    conversationPreview: { color: colors.muted, fontSize: 11, marginTop: 5 },
    moreButton: {
      width: 42,
      height: 52,
      alignItems: 'center',
      justifyContent: 'center',
    },
    noResults: { paddingVertical: 30, paddingHorizontal: 12 },
    noResultsTitle: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
    noResultsBody: { color: colors.faint, fontSize: 12, marginTop: 5 },
    footer: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
      paddingTop: 8,
    },
    runtimeFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 28,
      paddingHorizontal: 5,
    },
    runtimeDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.warning,
      marginRight: 7,
    },
    runtimeDotReady: { backgroundColor: colors.success },
    runtimeDotFailed: { backgroundColor: colors.danger },
    runtimeFooterValue: {
      flex: 1,
      color: colors.textDim,
      fontFamily: fonts.mono,
      fontSize: 9,
    },
    accountDock: {
      height: 58,
      borderRadius: 18,
      backgroundColor: colors.surface,
      flexDirection: 'row',
      alignItems: 'center',
      padding: 7,
      marginTop: 5,
    },
    accountButton: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
    },
    avatar: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: colors.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    accountCopy: { flex: 1, minWidth: 0, marginLeft: 10 },
    accountName: { color: colors.text, fontSize: 13, fontWeight: '700' },
    accountHint: { color: colors.muted, fontSize: 9, marginTop: 2 },
    settingsButton: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: colors.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
      marginLeft: 7,
    },
    pressed: { opacity: 0.58, transform: [{ scale: 0.985 }] },
  });
