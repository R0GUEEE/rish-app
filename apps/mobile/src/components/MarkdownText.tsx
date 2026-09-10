import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { parseMarkdownBlocks } from '../markdown/blocks';
import { tokenizeInline } from '../markdown/inline';
import { useAppPresentation } from '../presentation/AppPresentation';
import type { AttachmentDescriptor } from '../state';
import { fonts, type ThemePalette } from '../theme';
import { InlineMarkdown } from './InlineMarkdown';
import { MarkdownMathBlock } from './MarkdownMath';
import { MarkdownTable } from './MarkdownTable';
import { VerbatimSourceBlock } from './MarkdownMath';

export function MarkdownText({
  markdown,
  attachments,
}: {
  markdown: string;
  attachments?: readonly AttachmentDescriptor[];
}) {
  const { colors } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const blocks = useMemo(() => parseMarkdownBlocks(markdown), [markdown]);
  return (
    <View style={styles.root}>
      {blocks.map((block, blockIndex) => {
        switch (block.kind) {
          case 'code':
            return (
              <View key={'code-' + blockIndex} style={styles.codeCard}>
                {block.language.length > 0 && (
                  <Text style={styles.language}>
                    {block.language.toLocaleUpperCase()}
                  </Text>
                )}
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <Text selectable style={styles.code}>
                    {block.value}
                  </Text>
                </ScrollView>
              </View>
            );
          case 'math':
            return (
              <MarkdownMathBlock key={'math-' + blockIndex} source={block.source} />
            );
          case 'verbatim':
            return (
              <VerbatimSourceBlock
                key={'verbatim-' + blockIndex}
                source={block.source}
              />
            );
          case 'table':
            return (
              <MarkdownTable
                attachments={attachments}
                key={'table-' + blockIndex}
                table={block.table}
              />
            );
          case 'lines': {
            // The root owns spacing between blocks; surrounding Markdown
            // blank lines must not add a second layer of vertical padding.
            const lines = [...block.lines];
            while (lines.length && lines[0].trim() === '') lines.shift();
            while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
            if (lines.length === 0) return null;
            return (
              <View key={'text-' + blockIndex} style={styles.textGroup}>
                {lines.map((line, lineIndex) =>
                  line.trim() === '' && lineIndex > 0 && lines[lineIndex - 1].trim() === ''
                    ? null : renderLine(line, lineIndex, styles, attachments),
                )}
              </View>
            );
          }
        }
      })}
    </View>
  );
}

function renderLine(
  line: string,
  lineIndex: number,
  styles: ReturnType<typeof createStyles>,
  attachments: readonly AttachmentDescriptor[] | undefined,
): React.ReactNode {
  const trimmed = line.trim();
  if (trimmed.length === 0)
    return <View key={'space-' + lineIndex} style={styles.space} />;
  if (/^#{1,3}\s/u.test(trimmed)) {
    const level = trimmed.match(/^#+/u)?.[0].length ?? 1;
    return (
      <InlineMarkdown
        attachments={attachments}
        key={'heading-' + lineIndex}
        selectable
        textStyle={[styles.heading, level > 1 && styles.headingSmall]}
        tokens={tokenizeInline(trimmed.replace(/^#{1,3}\s+/u, ''))}
      />
    );
  }
  if (/^[-*]\s/u.test(trimmed)) {
    return (
      <View key={'bullet-' + lineIndex} style={styles.bulletRow}>
        <Text style={styles.bullet}>•</Text>
        <InlineMarkdown
          attachments={attachments}
          selectable
          textStyle={styles.paragraph}
          tokens={tokenizeInline(trimmed.slice(2))}
        />
      </View>
    );
  }
  if (/^>\s?/u.test(trimmed)) {
    return (
      <View key={'quote-' + lineIndex} style={styles.quote}>
        <InlineMarkdown
          attachments={attachments}
          selectable
          textStyle={styles.quoteText}
          tokens={tokenizeInline(trimmed.replace(/^>\s?/u, ''))}
        />
      </View>
    );
  }
  return (
    <InlineMarkdown
      attachments={attachments}
      key={'line-' + lineIndex}
      selectable
      textStyle={styles.paragraph}
      tokens={tokenizeInline(line)}
    />
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
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
  });
