import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { fonts } from '../theme';
import { useAppPresentation } from '../presentation/AppPresentation';

const source = require('../assets/dsh-mark.png') as number;

export function BrandMark({
  compact = false,
  size = 34,
}: {
  compact?: boolean;
  size?: number;
}) {
  const { colors } = useAppPresentation();
  return (
    <View accessibilityLabel="Rish" style={styles.row}>
      <Image
        source={source}
        style={{
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.22),
        }}
      />
      {!compact && (
        <Text style={[styles.wordmark, { color: colors.text }]}>Rish</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  wordmark: {
    fontFamily: fonts.body,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 2.4,
    marginLeft: 9,
  },
});
