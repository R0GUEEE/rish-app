import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, type ThemePalette } from '../theme';

type Segment =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string; language: string };

function segments(markdown: string): Segment[] {
  const result: Segment[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)```/gu;
  let cursor = 0;
  for (const match of markdown.matchAll(fence)) {
    const index = match.index ?? 0;
    if (index > cursor)
      result.push({ type: 'text', value: markdown.slice(cursor, index) });
    result.push({
      type: 'code',
      language: (match[1] ?? '').trim(),
      value: (match[2] ?? '').replace(/\n$/u, ''),
    });
    cursor = index + match[0].length;
  }
  if (cursor < markdown.length)
    result.push({ type: 'text', value: markdown.slice(cursor) });
  return result;
}

function renderInline(
  value: string,
  styles: ReturnType<typeof createStyles>,
  bold: boolean,
  keyPrefix: string,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let buffer = '';
  let nodeCount = 0;
  const flush = () => {
    if (buffer.length > 0) {
      const text = buffer;
      nodeCount += 1;
      nodes.push(
        bold ? (
          <Text key={`${keyPrefix}-t-${nodeCount}`} style={styles.bold}>
            {text}
          </Text>
        ) : (
          <Text key={`${keyPrefix}-t-${nodeCount}`}>{text}</Text>
        ),
      );
      buffer = '';
    }
  };

  let i = 0;
  while (i < value.length) {
    if (value[i] === '`') {
      const end = value.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        nodeCount += 1;
        nodes.push(
          <Text
            key={`${keyPrefix}-c-${nodeCount}`}
            style={styles.inlineCode}
          >
            {value.slice(i + 1, end)}
          </Text>,
        );
        i = end + 1;
        continue;
      }
    }
    if (!bold && value.startsWith('**', i)) {
      // CommonMark spacing rule: the delimiter run may not be followed or
      // preceded by a space, otherwise it stays literal.
      const opensCleanly = value[i + 2] !== undefined && value[i + 2] !== ' ';
      let end = opensCleanly ? value.indexOf('**', i + 2) : -1;
      if (end !== -1 && (end === i + 2 || value[end - 1] === ' ')) end = -1;
      if (end !== -1) {
        flush();
        nodeCount += 1;
        const inner = value.slice(i + 2, end);
        nodes.push(
          <Text key={`${keyPrefix}-b-${nodeCount}`} style={styles.bold}>
            {renderInline(inner, styles, true, `${keyPrefix}-b-${nodeCount}`)}
          </Text>,
        );
        i = end + 2;
        continue;
      }
    }
    buffer += value[i];
    i += 1;
  }
  flush();
  return nodes;
}

function inlineRich(
  value: string,
  styles: ReturnType<typeof createStyles>,
) {
  return renderInline(value, styles, false, 'r');
}

export function MarkdownText({ markdown }: { markdown: string }) {
  const { colors } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.root}>
      {segments(markdown).map((segment, segmentIndex) => {
        if (segment.type === 'code') {
          return (
            <View key={`code-${segmentIndex}`} style={styles.codeCard}>
              {segment.language.length > 0 && (
                <Text style={styles.language}>
                  {segment.language.toLocaleUpperCase()}
                </Text>
              )}
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text selectable style={styles.code}>
                  {segment.value}
                </Text>
              </ScrollView>
            </View>
          );
        }
        return (
          <View key={`text-${segmentIndex}`} style={styles.textGroup}>
            {segment.value.split('\n').map((line, lineIndex) => {
              const trimmed = line.trim();
              if (trimmed.length === 0)
                return <View key={`space-${lineIndex}`} style={styles.space} />;
              if (/^#{1,3}\s/u.test(trimmed)) {
                const level = trimmed.match(/^#+/u)?.[0].length ?? 1;
                return (
                  <Text
                    key={`heading-${lineIndex}`}
                    selectable
                    style={[styles.heading, level > 1 && styles.headingSmall]}
                  >
                    {inlineRich(trimmed.replace(/^#{1,3}\s+/u, ''), styles)}
                  </Text>
                );
              }
              if (/^[-*]\s/u.test(trimmed)) {
                return (
                  <View key={`bullet-${lineIndex}`} style={styles.bulletRow}>
                    <Text style={styles.bullet}>•</Text>
                    <Text selectable style={styles.paragraph}>
                      {inlineRich(trimmed.slice(2), styles)}
                    </Text>
                  </View>
                );
              }
              if (/^>\s?/u.test(trimmed)) {
                return (
                  <View key={`quote-${lineIndex}`} style={styles.quote}>
                    <Text selectable style={styles.quoteText}>
                      {inlineRich(trimmed.replace(/^>\s?/u, ''), styles)}
                    </Text>
                  </View>
                );
              }
              return (
                <Text
                  key={`line-${lineIndex}`}
                  selectable
                  style={styles.paragraph}
                >
                  {inlineRich(line, styles)}
                </Text>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    root: { gap: 10 },
    textGroup: { gap: 5 },
    paragraph: {
      flexShrink: 1,
      color: colors.text,
      fontFamily: fonts.body,
      fontSize: 16,
      lineHeight: 24,
    },
    heading: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 22,
      lineHeight: 28,
      marginTop: 5,
    },
    headingSmall: { fontSize: 18, lineHeight: 24 },
    space: { height: 5 },
    bulletRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingLeft: 4,
    },
    bullet: { color: colors.accent, fontSize: 16, lineHeight: 24, width: 18 },
    quote: {
      borderLeftWidth: 2,
      borderLeftColor: colors.accentSoft,
      paddingLeft: 11,
      paddingVertical: 3,
    },
    quoteText: {
      color: colors.muted,
      fontFamily: fonts.body,
      fontSize: 15,
      lineHeight: 22,
    },
    bold: { fontWeight: '700' },
    inlineCode: {
      color: colors.accent,
      fontFamily: fonts.mono,
      fontSize: 14,
      backgroundColor: colors.surfaceRaised,
    },
    codeCard: {
      borderRadius: 14,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      overflow: 'hidden',
    },
    language: {
      color: colors.faint,
      fontFamily: fonts.mono,
      fontSize: 8,
      fontWeight: '800',
      letterSpacing: 1.2,
      paddingHorizontal: 12,
      paddingTop: 9,
    },
    code: {
      color: colors.textDim,
      fontFamily: fonts.mono,
      fontSize: 12,
      lineHeight: 19,
      padding: 12,
    },
  });
