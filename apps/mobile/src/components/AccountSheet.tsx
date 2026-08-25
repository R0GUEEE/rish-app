import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Cloud from 'lucide-react-native/icons/cloud';
import HardDrive from 'lucide-react-native/icons/hard-drive';
import LogIn from 'lucide-react-native/icons/log-in';
import X from 'lucide-react-native/icons/x';

import type { LucideIcon } from 'lucide-react-native';

import { useAppPresentation } from '../presentation/AppPresentation';
import { hitSlop, type ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';
import { BrandMark } from './BrandMark';
import { SlidingSurface } from './SlidingSurface';

export function AccountSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <SlidingSurface
      closeAccessibilityLabel={t('account.close')}
      onClose={onClose}
      side="bottom"
      visible={visible}
      widthRatio={1}
      scrim={false}
    >
      <View
        style={[
          styles.root,
          { marginTop: insets.top + 8, paddingBottom: insets.bottom + 14 },
        ]}
      >
        <View style={styles.header}>
          <View style={styles.headerSide} />
          <Text accessibilityRole="header" style={styles.headerTitle}>
            {t('account.title')}
          </Text>
          <Pressable
            accessibilityLabel={t('account.close')}
            accessibilityRole="button"
            hitSlop={hitSlop}
            onPress={onClose}
            style={styles.close}
          >
            <AppIcon color={colors.text} icon={X} size={21} />
          </Pressable>
        </View>

        <View style={styles.content}>
          <View style={styles.identity}>
            <View style={styles.avatar}>
              <BrandMark compact size={46} />
            </View>
            <Text style={styles.name}>{t('account.localUser')}</Text>
            <Text style={styles.summary}>{t('account.localSummary')}</Text>
          </View>

          <Text style={styles.sectionLabel}>{t('account.section.local')}</Text>
          <View style={styles.card}>
            <AccountRow
              icon={HardDrive}
              label={t('account.storage')}
              value={t('account.onDevice')}
            />
            <View style={styles.divider} />
            <AccountRow
              icon={Cloud}
              label={t('account.sync')}
              value={t('account.notEnabled')}
            />
          </View>

          <Text style={styles.sectionLabel}>{t('account.section.cloud')}</Text>
          <View style={styles.card}>
            <View style={styles.cloudHeading}>
              <View style={styles.rowIcon}>
                <AppIcon color={colors.textDim} icon={Cloud} size={17} />
              </View>
              <Text style={styles.cloudTitle}>{t('account.cloudTitle')}</Text>
            </View>
            <Text style={styles.cloudBody}>{t('account.cloudBody')}</Text>
            <View
              accessibilityLabel={t('account.signInComingSoon')}
              accessibilityRole="button"
              accessibilityState={{ disabled: true }}
              style={styles.disabledButton}
            >
              <AppIcon color={colors.textDim} icon={LogIn} size={17} />
              <Text style={styles.disabledButtonText}>
                {t('account.signInComingSoon')}
              </Text>
            </View>
          </View>
        </View>
      </View>
    </SlidingSurface>
  );
}

function AccountRow({
  icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  const { colors } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <AppIcon color={colors.textDim} icon={icon} size={17} />
      </View>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    root: {
      flex: 1,
      overflow: 'hidden',
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      backgroundColor: colors.background,
    },
    header: {
      height: 64,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.lineSoft,
    },
    headerSide: { width: 42, height: 42 },
    headerTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
    close: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: colors.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    content: { flex: 1, paddingHorizontal: 16, paddingTop: 22 },
    identity: { alignItems: 'center', paddingVertical: 8 },
    avatar: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    name: {
      color: colors.text,
      fontSize: 20,
      fontWeight: '700',
      marginTop: 12,
    },
    summary: {
      color: colors.muted,
      fontSize: 12,
      lineHeight: 17,
      textAlign: 'center',
      marginTop: 5,
    },
    sectionLabel: {
      color: colors.muted,
      fontSize: 12,
      fontWeight: '600',
      marginTop: 22,
      marginLeft: 8,
      marginBottom: 7,
    },
    card: {
      borderRadius: 20,
      backgroundColor: colors.surface,
      paddingHorizontal: 15,
      paddingVertical: 12,
    },
    row: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
    },
    rowIcon: {
      width: 30,
      height: 30,
      borderRadius: 10,
      backgroundColor: colors.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 10,
    },
    rowLabel: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '600' },
    rowValue: { color: colors.muted, fontSize: 12, marginLeft: 10 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
    cloudHeading: { flexDirection: 'row', alignItems: 'center' },
    cloudTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
    cloudBody: {
      color: colors.muted,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 6,
    },
    disabledButton: {
      height: 42,
      borderRadius: 12,
      backgroundColor: colors.surfaceRaised,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 14,
      opacity: 0.58,
    },
    disabledButtonText: {
      color: colors.textDim,
      fontSize: 12,
      fontWeight: '700',
    },
  });
