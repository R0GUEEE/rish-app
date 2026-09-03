import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import {
  flattenInlineTokens,
  tokenizeInline,
} from '../markdown/inline';
import type { ParsedTable, TableAlignment } from '../markdown/table';
import { useAppPresentation } from '../presentation/AppPresentation';
import type { AttachmentDescriptor } from '../state';
import { fonts, type ThemePalette } from '../theme';
import { InlineMarkdown } from './InlineMarkdown';

const MIN_COLUMN_WIDTH = 56;
const MAX_COLUMN_WIDTH = 260;

/**
 * Renders a parsed GFM table inside a horizontally scrollable card so wide
 * tables stay inside the message bubble on narrow screens. Cells support
 * inline formatting; the container exposes a flattened accessibility label.
 */
export function MarkdownTable({
  table,
  attachments,
}: {
  table: ParsedTable;
  attachments?: readonly AttachmentDescriptor[];
}) {
  const { colors } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const columnWidths = useMemo(() => {
    const counts = table.headers.map((header, column) =>
      Math.max(
        header.length,
        ...table.rows.map(row => (row[column] ?? '').length),
      ),
    );
    return counts.map(length =>
      Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, length * 8.2 + 28)),
    );
  }, [table]);
  const accessibilityLabel = useMemo(
    () => tableAccessibilityLabel(table),
    [table],
  );
  return (
    <View accessibilityLabel={accessibilityLabel} style={styles.card}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        <View>
          <View style={styles.headerRow}>
            {table.headers.map((header, column) => (
              <View
                key={'h-' + column}
                style={[
                  styles.cell,
                  styles.headerCell,
                  alignCell(table.alignments[column], styles),
                  { width: columnWidths[column] },
                ]}
              >
                <InlineMarkdown
                  attachments={attachments}
                  textStyle={styles.headerText}
                  tokens={tokenizeInline(header)}
                />
              </View>
            ))}
          </View>
          {table.rows.map((row, rowIndex) => (
            <View
              key={'r-' + rowIndex}
              style={[
                styles.row,
                rowIndex === table.rows.length - 1 && styles.lastRow,
              ]}
            >
              {row.map((cell, column) => (
                <View
                  key={'c-' + column}
                  style={[
                    styles.cell,
                    alignCell(table.alignments[column], styles),
                    { width: columnWidths[column] },
                  ]}
                >
                  <InlineMarkdown
                    attachments={attachments}
                    textStyle={styles.cellText}
                    tokens={tokenizeInline(cell)}
                  />
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function alignCell(
  alignment: TableAlignment,
  styles: ReturnType<typeof createStyles>,
) {
  switch (alignment) {
    case 'center':
      return styles.cellCenter;
    case 'right':
      return styles.cellRight;
    default:
      return styles.cellLeft;
  }
}

function tableAccessibilityLabel(table: ParsedTable): string {
  const header = table.headers
    .map(cell => flattenInlineTokens(tokenizeInline(cell)))
    .join(', ');
  const rows = table.rows
    .slice(0, 5)
    .map(
      (row, index) =>
        'Row ' +
        (index + 1) +
        ': ' +
        row.map(cell => flattenInlineTokens(tokenizeInline(cell))).join(', '),
    );
  return [
    'Table, ' + (table.rows.length + 1) + ' rows, ' + table.headers.length + ' columns',
    'Header: ' + header,
    ...rows,
  ]
    .join('. ')
    .slice(0, 600);
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
    scrollContent: { paddingVertical: 6, paddingHorizontal: 4 },
    headerRow: {
      flexDirection: 'row',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
      backgroundColor: colors.surfaceRaised,
    },
    row: {
      flexDirection: 'row',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.lineSoft,
    },
    lastRow: { borderBottomWidth: 0 },
    cell: {
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: colors.lineSoft,
    },
    headerCell: { paddingVertical: 9 },
    cellLeft: { alignItems: 'flex-start' },
    cellCenter: { alignItems: 'center' },
    cellRight: { alignItems: 'flex-end' },
    headerText: {
      color: colors.textDim,
      fontFamily: fonts.body,
      fontSize: 13,
      fontWeight: '700',
      lineHeight: 19,
    },
    cellText: {
      color: colors.text,
      fontFamily: fonts.body,
      fontSize: 14,
      lineHeight: 20,
    },
  });
