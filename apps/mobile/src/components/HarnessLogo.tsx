import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import { getHarnessLogoXml } from '../assets/harness/logos';

const foreground = '#242424';

/** Decorative brand mark for a harness, with a monogram for custom manifests. */
export function HarnessLogo({
  harnessId,
  name,
  size = 30,
}: {
  harnessId: string;
  name: string;
  size?: number;
}) {
  const xml = getHarnessLogoXml(harnessId);

  return (
    <View
      accessibilityElementsHidden
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.root, { width: size, height: size }]}
    >
      {xml ? (
        <SvgXml
          accessible={false}
          color={foreground}
          fill={harnessId === 'glm' ? foreground : undefined}
          focusable={false}
          height={size}
          style={styles.svg}
          width={size}
          xml={xml}
        />
      ) : (
        <Text style={styles.monogram}>{name.slice(0, 2).toUpperCase()}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center' },
  // Override the source SVGs' browser-only inline flex and line-height styles.
  svg: { flexShrink: 0 },
  monogram: { color: foreground, fontSize: 12, fontWeight: '900' },
});
