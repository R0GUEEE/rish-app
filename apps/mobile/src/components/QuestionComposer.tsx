import React, { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Check from 'lucide-react-native/icons/check';

import type { QuestionOption, QuestionSpec } from '../agent/AgentQuestions';
import { MAX_FREE_TEXT_ANSWER_LENGTH } from '../agent/AgentQuestions';
import { useAppPresentation } from '../presentation/AppPresentation';
import type { ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';

type Props = {
  question: QuestionSpec;
  onAnswer: (questionId: string, answer: string) => void;
  onCancel: (questionId: string) => void;
};

/**
 * DSH-style structured question composer: option buttons or a free-text
 * field, client-side validation before submit, and explicit cancel for
 * optional questions. The driver re-validates the submitted answer
 * fail-closed, so this UI can only make errors visible earlier.
 */
export function QuestionComposer({ question, onAnswer, onCancel }: Props) {
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [freeText, setFreeText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const optionsMode = question.inputMode === 'options';

  const submit = () => {
    if (optionsMode) {
      if (selectedOptionId === null) {
        setError(t('agent.questionErrorOption'));
        return;
      }
      onAnswer(question.questionId, selectedOptionId);
      return;
    }
    const trimmed = freeText.trim();
    if (trimmed.length === 0) {
      setError(t('agent.questionErrorRequired'));
      return;
    }
    if (trimmed.length > MAX_FREE_TEXT_ANSWER_LENGTH) {
      setError(t('agent.questionErrorRequired'));
      return;
    }
    onAnswer(question.questionId, trimmed);
  };

  const options: readonly QuestionOption[] = question.options;

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {
        if (!question.required) onCancel(question.questionId);
      }}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      testID="question-composer-modal"
      transparent
      visible
    >
      <View accessibilityViewIsModal style={styles.overlay}>
        <View pointerEvents="box-none" style={styles.anchor}>
          <View
            accessibilityLabel={t('agent.questionTitle')}
            accessibilityRole="dialog"
            style={styles.card}
            testID="question-composer-card"
          >
            <Text style={styles.eyebrow}>{t('agent.questionEyebrow')}</Text>
            <Text style={styles.title}>{t('agent.questionTitle')}</Text>
            <Text style={styles.questionText}>{question.text}</Text>
            {optionsMode ? (
              <View
                accessibilityLabel={t('agent.questionTitle')}
                accessibilityRole="radiogroup"
                testID="question-options-group"
              >
                {options.map((option, index) => {
                  const isSelected = option.id === selectedOptionId;
                  return (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: isSelected }}
                      key={option.id}
                      onPress={() => {
                        setSelectedOptionId(option.id);
                        setError(null);
                      }}
                      style={({ pressed }) => [
                        styles.option,
                        index > 0 && styles.optionDivider,
                        isSelected && styles.optionSelected,
                        pressed && styles.pressed,
                      ]}
                      testID={'question-option-' + option.id}
                    >
                      <View style={styles.check}>
                        {isSelected && (
                          <AppIcon color={colors.accent} icon={Check} size={16} />
                        )}
                      </View>
                      <Text style={styles.optionLabel}>{option.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <TextInput
                accessibilityLabel={t('agent.questionFreeTextPlaceholder')}
                autoFocus
                multiline
                onChangeText={text => {
                  setFreeText(text);
                  setError(null);
                }}
                placeholder={t('agent.questionFreeTextPlaceholder')}
                placeholderTextColor={colors.muted}
                style={styles.input}
                testID="question-free-text-input"
                value={freeText}
              />
            )}
            {error !== null && (
              <Text style={styles.error} testID="question-error">
                {error}
              </Text>
            )}
            <View style={styles.buttonRow}>
              {!question.required && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onCancel(question.questionId)}
                  style={({ pressed }) => [
                    styles.cancelButton,
                    pressed && styles.pressed,
                  ]}
                  testID="question-cancel"
                >
                  <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                onPress={submit}
                style={({ pressed }) => [
                  styles.submitButton,
                  pressed && styles.pressed,
                ]}
                testID="question-submit"
              >
                <Text style={styles.submitText}>{t('agent.questionSubmit')}</Text>
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
    questionText: {
      color: colors.text,
      fontSize: 14,
      lineHeight: 20,
      marginTop: 8,
    },
    option: {
      minHeight: 48,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 12,
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 6,
    },
    optionDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    optionSelected: { backgroundColor: colors.surfaceRaised },
    check: { width: 20, alignItems: 'flex-start', marginRight: 8 },
    optionLabel: { color: colors.text, fontSize: 13, fontWeight: '600', flex: 1 },
    input: {
      minHeight: 88,
      marginTop: 10,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      backgroundColor: colors.surfaceRaised,
      color: colors.text,
      fontSize: 14,
      lineHeight: 19,
      paddingHorizontal: 12,
      paddingVertical: 10,
      textAlignVertical: 'top',
    },
    error: { color: colors.danger, fontSize: 12, marginTop: 6 },
    buttonRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
    cancelButton: {
      flex: 1,
      minHeight: 46,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceRaised,
    },
    cancelText: { color: colors.muted, fontSize: 14, fontWeight: '700' },
    submitButton: {
      flex: 1.6,
      minHeight: 46,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
    },
    submitText: { color: colors.background, fontSize:14, fontWeight: '700' },
    pressed: { opacity: 0.58 },
  });
