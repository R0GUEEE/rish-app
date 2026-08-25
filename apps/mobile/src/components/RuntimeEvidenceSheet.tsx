import React, { useMemo } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Activity from 'lucide-react-native/icons/activity';
import Check from 'lucide-react-native/icons/check';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';

import type { RuntimeProof } from '../native/LocalRuntime';
import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, type ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';

type ShellEvidence = { engine: string; platform: string; renderer: string };
export type RuntimeVerificationStatus =
  | 'checking'
  | 'verified'
  | 'incomplete'
  | 'failed';

type Props = {
  failure: string | null;
  proof: RuntimeProof | null;
  runtimeLabel: string;
  runtimeStatus: RuntimeVerificationStatus;
  shell: ShellEvidence;
  visible: boolean;
  onClose: () => void;
  onDismiss?: () => void;
  onRetry: () => void;
};

function shortId(value: string | undefined): string {
  return value === undefined ? 'pending' : `${value.slice(0, 8)}…`;
}

export function RuntimeEvidenceSheet({
  failure,
  proof,
  runtimeLabel,
  runtimeStatus,
  shell,
  visible,
  onClose,
  onDismiss,
  onRetry,
}: Props) {
  const insets = useSafeAreaInsets();
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const verified = runtimeStatus === 'verified';
  const failed = runtimeStatus === 'failed';
  const StatusIcon = verified ? CircleCheck : failed ? CircleAlert : Activity;
  const rows = [
    [t('runtime.row.platform'), proof?.platform ?? shell.platform],
    [t('runtime.row.appRuntime'), `${shell.renderer} · ${shell.engine}`],
    [t('runtime.row.mode'), proof?.mode ?? t('runtime.unverified')],
    [
      t('runtime.row.credential'),
      proof === null
        ? t('runtime.pending')
        : proof.checks.credential_in_keychain
        ? 'iOS Keychain'
        : t('runtime.missing'),
    ],
    [
      t('runtime.row.model'),
      proof?.checks.model_response_received
        ? `${proof.model_response?.model ?? t('runtime.received')} · URLSession`
        : t('runtime.pending'),
    ],
    [
      t('runtime.row.rish'),
      proof?.checks.rish_applet_executed
        ? `${proof.rish_probe.path_kind ?? t('runtime.applet')} · protocol ${
            proof.rish_protocol_version
          }`
        : t('runtime.pending'),
    ],
    [
      t('runtime.row.macDsh'),
      proof === null
        ? t('runtime.pending')
        : proof.mac_dsh_port_3180_reachable
        ? t('runtime.reachableFail')
        : t('runtime.offline'),
    ],
    [
      t('runtime.row.restartRestore'),
      proof?.checks.session_restored_after_restart
        ? t('runtime.verified')
        : t('runtime.pending'),
    ],
    [
      t('runtime.row.process'),
      proof?.process_id === undefined
        ? t('runtime.pending')
        : `pid ${proof.process_id}`,
    ],
    [t('runtime.row.proofRun'), shortId(proof?.proof_run_id)],
    [t('runtime.row.dshCore'), t('runtime.builtinDsh')],
  ];

  return (
    <Modal
      animationType="slide"
      onDismiss={onDismiss}
      onRequestClose={onClose}
      transparent
      visible={visible}
    >
      <Pressable
        accessibilityLabel={t('runtime.close')}
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
      />
      <View
        accessibilityViewIsModal
        style={[styles.sheet, { paddingBottom: insets.bottom + 18 }]}
      >
        <View style={styles.handle} />
        <View
          accessible
          accessibilityLabel={runtimeLabel}
          accessibilityLiveRegion="polite"
          style={styles.badge}
        >
          <AppIcon
            color={
              verified
                ? colors.success
                : failed
                ? colors.danger
                : colors.warning
            }
            icon={StatusIcon}
            size={14}
          />
          <Text
            style={[
              styles.badgeText,
              verified && styles.badgeTextReady,
              failed && styles.badgeTextFailed,
            ]}
          >
            {verified ? t('runtime.badge') : runtimeLabel}
          </Text>
        </View>
        <Text style={styles.title}>{t('runtime.title')}</Text>
        <Text style={styles.copy}>{t('runtime.description')}</Text>
        <ScrollView contentContainerStyle={styles.table}>
          {rows.map(([label, value]) => (
            <View key={label} style={styles.row}>
              <Text style={styles.label}>{label}</Text>
              <Text numberOfLines={1} style={styles.value}>
                {value}
              </Text>
            </View>
          ))}
          {failure !== null && (
            <View style={styles.failureCard}>
              <View style={styles.failureHeading}>
                <AppIcon color={colors.danger} icon={CircleAlert} size={16} />
                <Text style={styles.failureLabel}>
                  {t('runtime.lastError')}
                </Text>
              </View>
              <Text style={styles.failureText}>{failure}</Text>
            </View>
          )}
        </ScrollView>
        <Pressable
          accessibilityLabel={
            failure === null ? t('common.done') : t('runtime.retryCheck')
          }
          accessibilityRole="button"
          onPress={failure === null ? onClose : onRetry}
          style={({ pressed }) => [styles.done, pressed && styles.pressed]}
        >
          <AppIcon
            color={colors.background}
            icon={failure === null ? Check : RefreshCw}
            size={18}
          />
          <Text style={styles.doneText}>
            {failure === null ? t('common.done') : t('runtime.retryCheck')}
          </Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: colors.scrim },
    sheet: {
      height: '88%',
      backgroundColor: colors.surface,
      borderTopLeftRadius: 29,
      borderTopRightRadius: 29,
      paddingTop: 10,
      paddingHorizontal: 20,
    },
    handle: {
      alignSelf: 'center',
      width: 42,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.line,
      marginBottom: 20,
    },
    badge: {
      alignSelf: 'flex-start',
      height: 25,
      borderRadius: 13,
      paddingHorizontal: 9,
      backgroundColor: colors.surfaceRaised,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    badgeText: {
      color: colors.warning,
      fontSize: 8,
      fontWeight: '800',
      letterSpacing: 1.1,
    },
    badgeTextReady: { color: colors.success },
    badgeTextFailed: { color: colors.danger },
    title: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 29,
      marginTop: 12,
    },
    copy: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 9 },
    table: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
      marginTop: 20,
      paddingBottom: 8,
    },
    row: {
      minHeight: 38,
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    label: { color: colors.muted, fontSize: 12 },
    value: {
      color: colors.text,
      fontFamily: fonts.mono,
      fontSize: 10,
      marginLeft: 'auto',
      maxWidth: '58%',
      textAlign: 'right',
    },
    failureCard: {
      borderRadius: 14,
      backgroundColor: colors.surfaceWarm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.danger,
      padding: 13,
      marginTop: 14,
    },
    failureLabel: {
      color: colors.danger,
      fontSize: 8,
      fontWeight: '800',
      letterSpacing: 1.4,
    },
    failureHeading: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    failureText: {
      color: colors.danger,
      fontSize: 11,
      lineHeight: 16,
      marginTop: 6,
    },
    done: {
      height: 50,
      borderRadius: 16,
      backgroundColor: colors.text,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 13,
    },
    doneText: { color: colors.background, fontSize: 15, fontWeight: '700' },
    pressed: { opacity: 0.6, transform: [{ scale: 0.985 }] },
  });
