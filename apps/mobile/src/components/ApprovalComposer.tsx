import React, { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Check from 'lucide-react-native/icons/check';

import type { ApprovalRequestSpec } from '../agent/AgentApprovals';
import type { ApprovalScopeValue } from '../agent/SessionEvents';
import { useAppPresentation } from '../presentation/AppPresentation';
import type { ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';

type Props = {
  request: ApprovalRequestSpec;
  onDecide: (
    approvalId: string,
    decision:
      | { status: 'approved'; scope: ApprovalScopeValue }
      | { status: 'denied' },
  ) => void;
};

/**
 * DSH-style approval composer: shows the gated tool call, offers the
 * scope choice, and settles with allow or deny. The deny path is the
 * fail-closed default; the driver re-validates whatever is submitted.
 */
export function ApprovalComposer({ request, onDecide }: Props) {
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [scope, setScope] = useState<ApprovalScopeValue>(
    request.scopes[0] ?? 'once',
  );

  return (
    <Modal
      animationType="fade"
      onRequestClose={() =>
        onDecide(request.approvalId, { status: 'denied' })
      }
      presentationStyle="overFullScreen"
      statusBarTranslucent
      testID="approval-composer-modal"
      transparent
      visible
    >
      <View accessibilityViewIsModal style={styles.overlay}>
        <View pointerEvents="box-none" style={styles.anchor}>
          <View
            accessibilityLabel={t('agent.approvalTitle')}
            accessibilityRole="dialog"
            style={styles.card}
            testID="approval-composer-card"
          >
            <Text style={styles.eyebrow}>{t('agent.approvalEyebrow')}</Text>
            <Text style={styles.title}>{t('agent.approvalTitle')}</Text>
            <Text style={styles.toolName}>{request.toolName}</Text>
            <Text numberOfLines={4} style={styles.arguments}>
              {request.argumentsJson}
            </Text>
            <Text style={styles.scopeLabel}>{t('agent.approvalScopeLabel')}</Text>
            <View
              accessibilityLabel={t('agent.approvalScopeLabel')}
              accessibilityRole="radiogroup"
              testID="approval-scope-group"
            >
              {request.scopes.map(scopeValue => {
                const isSelected = scopeValue === scope;
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ checked: isSelected }}
                    key={scopeValue}
                    onPress={() => setScope(scopeValue)}
                    style={({ pressed }) => [
                      styles.scopeOption,
                      isSelected && styles.scopeSelected,
                      pressed && styles.pressed,
                    ]}
                    testID={
                      scopeValue === 'once'
                        ? 'approval-scope-once'
                        : 'approval-scope-conversation'
                    }
                  >
                    <View style={styles.check}>
                      {isSelected && (
                        <AppIcon color={colors.accent} icon={Check} size={16} />
                      )}
                    </View>
                    <View style={styles.scopeCopy}>
                      <Text style={styles.scopeTitle}>
                        {scopeValue === 'once'
                          ? t('agent.approvalScope.once')
                          : t('agent.approvalScope.conversation')}
                      </Text>
                      <Text style={styles.scopeBody}>
                        {scopeValue === 'once'
                          ? t('agent.approvalScope.onceBody')
                          : t('agent.approvalScope.conversationBody')}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.buttonRow}>
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  onDecide(request.approvalId, { status: 'denied' })
                }
                style={({ pressed }) => [
                  styles.denyButton,
                  pressed && styles.pressed,
                ]}
                testID="approval-deny"
              >
                <Text style={styles.denyText}>{t('agent.approvalDeny')}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  onDecide(request.approvalId, {
                    status: 'approved',
                    scope,
                  })
                }
                style={({ pressed }) => [
                  styles.allowButton,
                  pressed && styles.pressed,
                ]}
                testID="approval-allow"
              >
                <Text style={styles.allowText}>{t('agent.approvalAllow')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    overlay: { flex: 1 },
    anchor: {
      flex: 1,
      justifyContent: 'flex-end',
      alignItems: 'stretch',
      paddingHorizontal: 18,
      paddingBottom: 96,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      padding: 16,
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.24,
      shadowRadius: 30,
      elevation: 16,
    },
    eyebrow: {
      color: colors.muted,
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 1.2,
      marginBottom: 4,
    },
    title: { color: colors.text, fontSize: 17, fontWeight: '800' },
    toolName: {
      color: colors.accent,
      fontSize: 13,
      fontWeight: '700',
      marginTop: 6,
    },
    arguments: {
      color: colors.muted,
      fontSize: 11,
      lineHeight: 15,
      marginTop: 4,
    },
    scopeLabel: {
      color: colors.muted,
      fontSize: 10,
      fontWeight: '700',
      marginTop: 12,
      marginBottom: 4,
    },
    scopeOption: {
      minHeight: 52,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 12,
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 6,
    },
    scopeSelected: { backgroundColor: colors.surfaceRaised },
    check: {
      width: 20,
      alignItems: 'flex-start',
      marginRight: 8,
    },
    scopeCopy: { flex: 1 },
    scopeTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
    scopeBody: {
      color: colors.muted,
      fontSize: 11,
      lineHeight: 15,
      marginTop: 1,
    },
    buttonRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
    denyButton: {
      flex: 1,
      minHeight: 46,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceRaised,
    },
    denyText: { color: colors.danger, fontSize: 14, fontWeight: '700' },
    allowButton: {
      flex: 1.6,
      minHeight: 46,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
    },
    allowText: { color: colors.background, fontSize: 14, fontWeight: '700' },
    pressed: { opacity: 0.58 },
  });
