import React, { useMemo } from 'react';
import ArrowUpRight from 'lucide-react-native/icons/arrow-up-right';
import Sparkles from 'lucide-react-native/icons/sparkles';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, type ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';

export function EmptyChat({
  onSuggestion,
}: {
  onSuggestion: (prompt: string) => void;
}) {
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const suggestions = useMemo(
    () => [
      {
        label: t('home.suggestion.plan.label'),
        prompt: t('home.suggestion.plan.prompt'),
      },
      {
        label: t('home.suggestion.explain.label'),
        prompt: t('home.suggestion.explain.prompt'),
      },
      {
        label: t('home.suggestion.review.label'),
        prompt: t('home.suggestion.review.prompt'),
      },
    ],
    [t],
  );
  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 6) return t('home.greeting.lateNight');
    if (hour < 12) return t('home.greeting.morning');
    if (hour < 18) return t('home.greeting.afternoon');
    return t('home.greeting.evening');
  }, [t]);
  return (
    <View style={styles.root}>
      <View style={styles.mark}>
        <AppIcon color={colors.accent} icon={Sparkles} size={23} />
      </View>
      <Text style={styles.eyebrow}>{t('home.onDevice')}</Text>
      <Text style={styles.title}>{greeting}</Text>
      <Text style={styles.body}>{t('home.description')}</Text>
      <View style={styles.suggestions}>
        {suggestions.map(item => (
          <Pressable
            accessibilityLabel={t('home.suggestion.accessibility', {
              label: item.label,
            })}
            accessibilityRole="button"
            key={item.label}
            onPress={() => onSuggestion(item.prompt)}
            style={({ pressed }) => [
              styles.suggestion,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.suggestionLabel}>{item.label}</Text>
            <Text numberOfLines={2} style={styles.suggestionBody}>
              {item.prompt}
            </Text>
            <View style={styles.suggestionArrow}>
              <AppIcon color={colors.faint} icon={ArrowUpRight} size={15} />
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    root: {
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: 23,
      paddingBottom: 8,
    },
    mark: {
      width: 45,
      height: 45,
      borderRadius: 23,
      backgroundColor: colors.surfaceWarm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    eyebrow: {
      color: colors.accent,
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 2,
      marginTop: 21,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 32,
      lineHeight: 38,
      letterSpacing: -0.5,
      marginTop: 10,
      maxWidth: 340,
    },
    body: {
      color: colors.muted,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 11,
      maxWidth: 340,
    },
    suggestions: { flexDirection: 'row', gap: 8, marginTop: 25 },
    suggestion: {
      flex: 1,
      minHeight: 104,
      borderRadius: 17,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      padding: 12,
    },
    suggestionLabel: {
      color: colors.accent,
      fontSize: 8,
      fontWeight: '800',
      letterSpacing: 1.2,
    },
    suggestionBody: {
      color: colors.textDim,
      fontSize: 11,
      lineHeight: 15,
      marginTop: 8,
    },
    suggestionArrow: {
      marginTop: 'auto',
      alignSelf: 'flex-end',
    },
    pressed: { opacity: 0.6, transform: [{ scale: 0.98 }] },
  });
