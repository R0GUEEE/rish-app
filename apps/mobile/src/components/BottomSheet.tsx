import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';

type Props = React.PropsWithChildren<{
  closeAccessibilityLabel: string;
  visible: boolean;
  onClose: () => void;
  onDismiss?: () => void;
}>;

const openDuration = 190;
const closeDuration = 150;
const disableAnimations = process.env.NODE_ENV === 'test';

export function BottomSheet({
  children,
  closeAccessibilityLabel,
  visible,
  onClose,
  onDismiss,
}: Props) {
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [mounted, setMounted] = useState(visible);
  const presented = useRef(visible);
  const dismissPending = useRef(false);

  const reportDismissed = useCallback(() => {
    if (!dismissPending.current) return;
    dismissPending.current = false;
    onDismiss?.();
  }, [onDismiss]);

  const animateTo = useCallback(
    (value: 0 | 1, after?: () => void) => {
      progress.stopAnimation();
      if (disableAnimations) {
        progress.setValue(value);
        after?.();
        return;
      }
      Animated.timing(progress, {
        duration: value === 1 ? openDuration : closeDuration,
        easing:
          value === 1 ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
        toValue: value,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) after?.();
      });
    },
    [progress],
  );

  useEffect(() => {
    if (visible) {
      if (presented.current) return;
      presented.current = true;
      dismissPending.current = false;
      setMounted(true);
      progress.setValue(0);
      const frame = requestAnimationFrame(() => animateTo(1));
      return () => cancelAnimationFrame(frame);
    }
    if (!presented.current) return;
    presented.current = false;
    dismissPending.current = true;
    animateTo(0, () => {
      setMounted(false);
      if (Platform.OS !== 'ios' || disableAnimations) reportDismissed();
    });
  }, [animateTo, progress, reportDismissed, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [height, 0],
  });

  return (
    <Modal
      animationType="none"
      hardwareAccelerated
      onDismiss={reportDismissed}
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={mounted}
    >
      <View accessibilityViewIsModal style={styles.container}>
        <Animated.View style={[styles.backdrop, { opacity: progress }]}>
          <Pressable
            accessibilityLabel={closeAccessibilityLabel}
            accessibilityRole="button"
            onPress={onClose}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <Animated.View style={[styles.sheet, { transform: [{ translateY }] }]}>
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.54)',
  },
  sheet: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
  },
});
