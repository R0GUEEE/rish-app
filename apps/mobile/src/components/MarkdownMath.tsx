import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, type ThemePalette } from '../theme';
import { VERBATIM_FALLBACK_CHARS } from '../markdown/limits';
import { parseMath } from '../markdown/math';
import { mathToInlineUnicode } from '../markdown/mathInline';
import { layoutMath } from '../markdown/mathLayout';

/**
 * Block math: parses the bounded LaTeX subset and lays out glyphs and rules
 * as absolute-positioned Views (no SVG needed). Unsupported or over-limit
 * source fails closed to a verbatim monospace block.
 */
export function MarkdownMathBlock({ source }: { source: string }) {
  const { colors } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const result = useMemo(() => parseMath(source), [source]);
  const layout = useMemo(
    () => (result.ok ? layoutMath(result.ast, 18) : null),
    [result],
  );
  if (!result.ok || layout === null) {
    return <VerbatimSourceBlock source={source} />;
  }
  return (
    <View
      accessibilityLabel={'Math: ' + source.slice(0, 300)}
      style={styles.card}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        <View
          style={[styles.canvas, { width: layout.width, height: layout.height }]}
        >
          {layout.items.map((item, index) =>
            item.k === 'glyph' ? (
              <Text
                key={'g-' + index}
                style={[
                  styles.glyph,
                  item.italic && styles.glyphItalic,
                  { left: item.x, top: item.y, fontSize: item.size },
                ]}
              >
                {item.text}
              </Text>
            ) : (
              <View
                key={'r-' + index}
                style={[
                  styles.rule,
                  { left: item.x, top: item.y, width: item.w, height: item.h },
                ]}
              />
            ),
          )}
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * Inline math: renders the Unicode inline projection when the subset has
 * one, otherwise the verbatim monospace source.
 */
export function InlineMath({ source }: { source: string }) {
  const { colors } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const unicode = useMemo(() => {
    const parsed = parseMath(source);
    if (!parsed.ok) return null;
    return mathToInlineUnicode(parsed.ast);
  }, [source]);
  if (unicode !== null) {
    return <Text style={styles.inlineMath}>{unicode}</Text>;
  }
  return <Text style={styles.inlineMathFallback}>{source}</Text>;
}

/** Bounded monospace fallback for tables/math that exceed a limit. */
export function VerbatimSourceBlock({ source }: { source: string }) {
  const { colors } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const shown =
    source.length <= VERBATIM_FALLBACK_CHARS
      ? source
      : source.slice(0, VERBATIM_FALLBACK_CHARS);
  return (
    <View accessibilityLabel="Markdown source block" style={styles.card}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={styles.verbatimText}>
          {shown}
        </Text>
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    card: {
      borderRadius: 14,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      overflow: 'hidden',
    },
    scrollContent: { paddingVertical: 14, paddingHorizontal: 12 },
    // marginHorizontal 'auto' centers when the formula is narrower than the
    // bubble and keeps it left-aligned (scrollable) when it is wider, so a
    // wide formula never loses its left edge inside the ScrollView.
    canvas: { position: 'relative', marginHorizontal: 'auto' },
    glyph: {
      position: 'absolute',
      color: colors.text,
      fontFamily: fonts.display,
    },
    glyphItalic: { fontStyle: 'italic' },
    rule: {
      position: 'absolute',
      backgroundColor: colors.textDim,
    },
    inlineMath: {
      color: colors.text,
      fontFamily: fonts.display,
      fontStyle: 'italic',
    },
    inlineMathFallback: {
      color: colors.muted,
      fontFamily: fonts.mono,
      fontSize: 13,
    },
    verbatimText: {
      color: colors.textDim,
      fontFamily: fonts.mono,
      fontSize: 12,
      lineHeight: 19,
      padding: 12,
    },
  });
