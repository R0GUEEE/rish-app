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
  accessibilityLabel?: string;
  closeAccessibilityLabel?: string;
  side?: 'left' | 'right';
  visible: boolean;
  widthRatio?: number;
  onClose: () => void;
  onDismiss?: () => void;
}>;

const duration = 230;
const disableAnimations = process.env.NODE_ENV === 'test';

export function SlidingPanel({
  accessibilityLabel,
  children,
  closeAccessibilityLabel,
  side = 'right',
  visible,
  widthRatio = 0.92,
  onClose,
  onDismiss,
}: Props) {
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(width * widthRatio, 520);
  const hiddenOffset = side === 'right' ? panelWidth : -panelWidth;
  const translateX = useRef(new Animated.Value(hiddenOffset)).current;
  const [mounted, setMounted] = useState(visible);
  const awaitingDismiss = useRef(false);

  const reportDismissed = useCallback(() => {
    if (!awaitingDismiss.current) return;
    awaitingDismiss.current = false;
    onDismiss?.();
  }, [onDismiss]);

  const unmountPanel = useCallback(() => {
    awaitingDismiss.current = true;
    setMounted(false);

    // React Native only forwards Modal.onDismiss on iOS. Our own horizontal
    // animation has already finished here, so Android can safely advance a
    // queued surface without an arbitrary delay. Tests use the same path so
    // modal hand-off assertions stay deterministic.
    if (Platform.OS !== 'ios' || disableAnimations) reportDismissed();
  }, [reportDismissed]);

  const animateClosed = useCallback(
    (after?: () => void) => {
      if (disableAnimations) {
        translateX.setValue(hiddenOffset);
        unmountPanel();
        after?.();
        return;
      }
      Animated.timing(translateX, {
        duration,
        easing: Easing.in(Easing.cubic),
        toValue: hiddenOffset,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          unmountPanel();
          after?.();
        }
      });
    },
    [hiddenOffset, translateX, unmountPanel],
  );

  useEffect(() => {
    if (visible) {
      awaitingDismiss.current = false;
      setMounted(true);
      translateX.setValue(hiddenOffset);
      if (disableAnimations) {
        translateX.setValue(0);
      } else {
        Animated.timing(translateX, {
          duration,
          easing: Easing.out(Easing.cubic),
          toValue: 0,
          useNativeDriver: true,
        }).start();
      }
    } else if (mounted) {
      animateClosed();
    }
  }, [animateClosed, hiddenOffset, mounted, translateX, visible]);

  useEffect(() => () => translateX.stopAnimation(), [translateX]);

  const requestClose = useCallback(() => {
    animateClosed(onClose);
  }, [animateClosed, onClose]);

  const opacity = translateX.interpolate({
    inputRange: side === 'right' ? [0, panelWidth] : [-panelWidth, 0],
    outputRange: side === 'right' ? [1, 0] : [0, 1],
    extrapolate: 'clamp',
  });

  return (
    <Modal
      animationType="none"
      onDismiss={reportDismissed}
      onRequestClose={requestClose}
      transparent
      visible={mounted}
    >
      <View accessibilityViewIsModal style={styles.row}>
        {side === 'right' && (
          <Animated.View style={[styles.scrimWrap, { opacity }]}>
            <Pressable
              accessibilityLabel={closeAccessibilityLabel ?? accessibilityLabel}
              accessibilityRole="button"
              onPress={requestClose}
              style={styles.scrim}
            />
          </Animated.View>
        )}
        <Animated.View
          style={[
            styles.panel,
            { width: panelWidth, transform: [{ translateX }] },
          ]}
        >
          {children}
        </Animated.View>
        {side === 'left' && (
          <Animated.View style={[styles.scrimWrap, { opacity }]}>
            <Pressable
              accessibilityLabel={closeAccessibilityLabel ?? accessibilityLabel}
              accessibilityRole="button"
              onPress={requestClose}
              style={styles.scrim}
            />
          </Animated.View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  panel: { height: '100%' },
  scrimWrap: { flex: 1 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.68)' },
});
