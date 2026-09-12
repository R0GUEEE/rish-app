import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing } from 'react-native';

import type { LucideIcon } from 'lucide-react-native';

import { AppIcon } from './AppIcon';

/**
 * A continuously rotating icon for "in progress" states. The rotation runs
 * on the native driver, so it keeps spinning while the JS thread is busy
 * serialising or hashing a checkpoint, which is exactly when it is shown.
 */
export function SpinningIcon({
  color,
  icon,
  size = 18,
  testID,
}: {
  color: string;
  icon: LucideIcon;
  size?: number;
  testID?: string;
}) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(turn, {
        duration: 900,
        easing: Easing.linear,
        toValue: 1,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const style = useMemo(
    () => ({
      transform: [
        {
          rotate: turn.interpolate({
            inputRange: [0, 1],
            outputRange: ['0deg', '360deg'],
          }),
        },
      ],
    }),
    [turn],
  );
  return (
    <Animated.View style={style} testID={testID}>
      <AppIcon color={color} icon={icon} size={size} />
    </Animated.View>
  );
}
