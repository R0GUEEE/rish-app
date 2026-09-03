import React, { useMemo } from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from 'react-native';

import { type InlineToken } from '../markdown/inline';
import { useAppPresentation } from '../presentation/AppPresentation';
import type { AttachmentDescriptor } from '../state';
import { fonts, type ThemePalette } from '../theme';
import { MarkdownImageToken } from './MarkdownImage';
import { InlineMath } from './MarkdownMath';

/**
 * Renders inline tokens (text, strong, code, math, images, links). Lines
 * without block content (images) render as one selectable Text; lines with
 * images render as a wrapping row of nodes because React Native cannot nest
 * Image inside Text.
 */
export function InlineMarkdown({
  tokens,
  textStyle,
  selectable = false,
  attachments,
}: {
  tokens: InlineToken[];
  textStyle: StyleProp<TextStyle>;
  selectable?: boolean;
  attachments?: readonly AttachmentDescriptor[];
}) {
  const { colors } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const hasImage = tokens.some(token => token.type === 'image');
  const nodes = tokens.map((token, index) =>
    renderToken(token, index, hasImage, textStyle, styles, attachments),
  );
  if (hasImage) {
    return <View style={styles.row}>{nodes}</View>;
  }
  return (
    <Text selectable={selectable} style={textStyle}>
      {nodes}
    </Text>
  );
}

function renderToken(
  token: InlineToken,
  index: number,
  inRow: boolean,
  textStyle: StyleProp<TextStyle>,
  styles: ReturnType<typeof createStyles>,
  attachments: readonly AttachmentDescriptor[] | undefined,
): React.ReactNode {
  const key = 't-' + index;
  switch (token.type) {
    case 'text':
      return (
        <Text key={key} style={inRow ? textStyle : undefined}>
          {token.value}
        </Text>
      );
    case 'strong':
      return (
        <Text key={key} style={styles.bold}>
          {token.children.map((child, childIndex) =>
            renderToken(child, childIndex, inRow, textStyle, styles, attachments),
          )}
        </Text>
      );
    case 'code':
      return (
        <Text key={key} style={styles.inlineCode}>
          {token.value}
        </Text>
      );
    case 'math':
      return <InlineMath key={key} source={token.source} />;
    case 'link':
      return (
        <Text
          accessibilityLabel={token.label + ' (' + token.target + ')'}
          key={key}
          style={[inRow && textStyle, styles.link]}
        >
          {token.label}
        </Text>
      );
    case 'image':
      return (
        <MarkdownImageToken
          alt={token.alt}
          attachments={attachments}
          key={key}
          target={token.target}
        />
      );
  }
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'flex-start',
    },
    bold: { fontWeight: '700' },
    inlineCode: {
      color: colors.accent,
      fontFamily: fonts.mono,
      fontSize: 14,
      backgroundColor: colors.surfaceRaised,
    },
    link: {
      color: colors.accent,
      textDecorationLine: 'underline',
    },
  });
