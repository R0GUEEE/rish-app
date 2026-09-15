import React, { useEffect, useMemo, useRef } from 'react';
import { Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppPresentation } from '../presentation/AppPresentation';
import type { ThemePalette } from '../theme';
import { runtimeCopy } from '../environments/runtime-copy';

type Props = React.PropsWithChildren<{ visible: boolean; title: string; onClose: () => void; onDismiss?: () => void; testID: string }>;
export function RuntimeEnvironmentModal({ visible, title, onClose, onDismiss, testID, children }: Props) {
  const { colors, locale } = useAppPresentation(), insets = useSafeAreaInsets();
  const { height } = useWindowDimensions(), styles = useMemo(() => runtimeStyles(colors), [colors]);
  useEffect(() => { if (visible) Keyboard.dismiss(); }, [visible]);
  const wasVisible = useRef(visible);
  useEffect(() => {
    const closed = wasVisible.current && !visible;
    wasVisible.current = visible;
    // Android dialogs do not share iOS's presenting-controller transition.
    if (closed && Platform.OS !== 'ios') onDismiss?.();
  }, [visible, onDismiss]);
  const safeHeight = Math.max(0, height - Math.max(12, insets.top) - Math.max(12, insets.bottom));
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} onDismiss={onDismiss} statusBarTranslucent>
    <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <Pressable testID={`${testID}-backdrop`} accessibilityRole="button" accessibilityLabel={runtimeCopy(locale).close} style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={[styles.card, { maxHeight: safeHeight * 0.9, marginTop: Math.max(12, insets.top), marginBottom: Math.max(12, insets.bottom) }]} accessibilityViewIsModal testID={testID}>
        <View style={styles.heading}><Text accessibilityRole="header" style={styles.title}>{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={runtimeCopy(locale).close} onPress={onClose} style={styles.close} testID={`${testID}-close`}><Text style={styles.closeText}>×</Text></Pressable>
        </View>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">{children}</ScrollView>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}
export function runtimeStyles(colors: ThemePalette) {
  return StyleSheet.create({
    overlay: { flex: 1, backgroundColor: colors.scrim, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
    card: { width: '100%', maxWidth: 640, flexShrink: 1, backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 24, overflow: 'hidden' },
    heading: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 12 },
    title: { color: colors.text, fontWeight: '700', fontSize: 22, flex: 1 },
    close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: colors.surfaceRaised },
    closeText: { color: colors.muted, fontSize: 30 }, scroll: { flexShrink: 1 }, content: { padding: 18, paddingTop: 6, gap: 14 },
    body: { color: colors.muted, fontSize: 14, lineHeight: 21 }, label: { color: colors.text, fontSize: 16, fontWeight: '600' },
    family: { gap: 10, borderTopColor: colors.lineSoft, borderTopWidth: 1, paddingTop: 12 },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
    item: { backgroundColor: colors.surfaceRaised, borderRadius: 16, padding: 12, gap: 8 },
    selectedItem: { borderColor: colors.accent, borderWidth: 1 },
    button: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 11, backgroundColor: colors.accent, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
    secondary: { backgroundColor: colors.surfaceRaised, borderColor: colors.line, borderWidth: 1 },
    buttonText: { color: colors.background, fontSize: 14, fontWeight: '600' }, secondaryText: { color: colors.text },
    disabled: { opacity: 0.4 }, error: { color: colors.danger, fontSize: 14, lineHeight: 21 },
    input: { minHeight: 48, color: colors.text, backgroundColor: colors.surfaceRaised, borderColor: colors.line, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 15 },
    progressTrack: { height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: colors.line },
    progress: { height: 4, backgroundColor: colors.accent },
    output: { color: colors.text, fontSize: 12, lineHeight: 18, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
    notice: { padding: 12, borderRadius: 12, backgroundColor: colors.surfaceWarm, gap: 6 },
  });
}
