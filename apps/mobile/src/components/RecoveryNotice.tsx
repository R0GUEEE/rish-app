import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import Check from 'lucide-react-native/icons/check';
import Copy from 'lucide-react-native/icons/copy';
import { useAppPresentation } from '../presentation/AppPresentation';
import { AppIcon } from './AppIcon';
import { recoveryCode, recoveryMessage } from './recoveryMessage';

type CopyState = 'idle' | 'copied' | 'failed';

export function RecoveryNotice({
  error,
  message,
  onCopyReport,
}: {
  error: string;
  message?: string;
  /**
   * Copies a diagnostic report of this failure; answers whether it did. A
   * tester pastes that instead of a screenshot that shows one code.
   */
  onCopyReport?: () => Promise<boolean>;
}) {
  const { colors, t } = useAppPresentation();
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (reset.current !== null) clearTimeout(reset.current);
  }, []);
  const expanded = expandedError === error;
  const code = recoveryCode(error);
  const copy = () => {
    if (onCopyReport === undefined) return;
    onCopyReport().then(
      copied => {
        setCopyState(copied ? 'copied' : 'failed');
        if (reset.current !== null) clearTimeout(reset.current);
        reset.current = setTimeout(() => setCopyState('idle'), 2000);
      },
      () => setCopyState('failed'),
    );
  };
  return (
    <View style={{ flexShrink: 1, gap: 5 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <Text
          accessibilityRole="alert"
          style={{ color: colors.danger, fontSize: 12, lineHeight: 18, flex: 1 }}
        >
          {message ?? recoveryMessage(error, t)}
        </Text>
        {onCopyReport !== undefined && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(
              copyState === 'copied'
                ? 'recovery.reportCopied'
                : copyState === 'failed'
                  ? 'recovery.reportNotCopied'
                  : 'recovery.copyReport',
            )}
            hitSlop={10}
            onPress={copy}
            testID="recovery-copy-report"
          >
            <AppIcon
              color={copyState === 'failed' ? colors.danger : colors.muted}
              icon={copyState === 'copied' ? Check : Copy}
              size={16}
            />
          </Pressable>
        )}
      </View>
      {copyState !== 'idle' && (
        <Text style={{ color: colors.muted, fontSize: 11 }} testID="recovery-copy-state">
          {t(copyState === 'copied' ? 'recovery.reportCopied' : 'recovery.reportNotCopied')}
        </Text>
      )}
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
