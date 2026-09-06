import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useAppPresentation } from '../presentation/AppPresentation';
import { recoveryCode, recoveryMessage } from './recoveryMessage';

export function RecoveryNotice({
  error,
  message,
}: {
  error: string;
  message?: string;
}) {
  const { colors, t } = useAppPresentation();
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const expanded = expandedError === error;
  const code = recoveryCode(error);
  return (
    <View style={{ flexShrink: 1, gap: 5 }}>
      <Text
        accessibilityRole="alert"
        style={{ color: colors.danger, fontSize: 12, lineHeight: 18 }}
      >
        {message ?? recoveryMessage(error, t)}
      </Text>
      {code !== null && (
        <Text selectable style={{ color: colors.muted, fontSize: 10 }}>
          {code}
        </Text>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={t(
          expanded ? 'recovery.hideDetails' : 'recovery.details',
        )}
        onPress={() => setExpandedError(expanded ? null : error)}
        testID="recovery-details-toggle"
      >
        <Text
          style={{ color: colors.accent, fontSize: 12, paddingVertical: 5 }}
        >
          {t(expanded ? 'recovery.hideDetails' : 'recovery.details')}
        </Text>
      </Pressable>
      {expanded && (
        <ScrollView
          style={{ maxHeight: 160 }}
          nestedScrollEnabled
          accessibilityLabel={t('recovery.details')}
          testID="recovery-details-scroll"
        >
          <Text
            selectable
            style={{ color: colors.text, fontSize: 12, lineHeight: 18 }}
          >
            {error}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}
