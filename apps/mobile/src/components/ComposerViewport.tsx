import React, { useCallback, useEffect, useRef } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** One vertical scroll owner keeps the full dialog reachable above the keyboard. */
export function ComposerViewport({
  children,
  revealEndOnKeyboard = true,
}: React.PropsWithChildren<{ revealEndOnKeyboard?: boolean }>) {
  const insets = useSafeAreaInsets();
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const keyboardVisible = useRef(Keyboard.isVisible());
  const frame = useRef<number | null>(null);
  const revealActions = useCallback(() => {
    if (!keyboardVisible.current || !revealEndOnKeyboard) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (keyboardVisible.current)
        scroll.current?.scrollToEnd({ animated: false });
    });
  }, [revealEndOnKeyboard]);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      keyboardVisible.current = true;
      revealActions();
    });
    const willShow = Keyboard.addListener('keyboardWillShow', () => {
      keyboardVisible.current = true;
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardVisible.current = false;
    });
    return () => {
      show.remove();
      willShow.remove();
      hide.remove();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [revealActions]);
  return (
    <KeyboardAvoidingView
      accessibilityViewIsModal
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        ref={scroll}
        onLayout={revealActions}
        onContentSizeChange={revealActions}
        style={styles.root}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        testID="composer-dialog-scroll"
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: Math.max(insets.top, 12),
            paddingBottom: Math.max(insets.bottom, 12),
          },
        ]}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: 18 },
});
