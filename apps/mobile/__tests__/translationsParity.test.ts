import { TRANSLATIONS } from '../src/preferences/translations';

const LOCALES = ['en-US', 'zh-CN'] as const;

type TranslationTable = Readonly<Record<string, string>>;

const PLACEHOLDER_PATTERN = /\{[A-Za-z][A-Za-z0-9_]*\}/g;

function extractPlaceholders(value: string): string[] {
  return value.match(PLACEHOLDER_PATTERN) ?? [];
}

function sortedMissing(
  candidates: Iterable<string>,
  available: Set<string>,
): string[] {
  return [...candidates].filter((value) => !available.has(value)).sort();
}

describe('translations parity', () => {
  const enUSTable: TranslationTable = TRANSLATIONS['en-US'];
  const zhCNTable: TranslationTable = TRANSLATIONS['zh-CN'];

  test('en-US and zh-CN define exactly the same key set', () => {
    const enUSKeys = new Set(Object.keys(enUSTable));
    const zhCNKeys = new Set(Object.keys(zhCNTable));
    const missingInEnUS = sortedMissing(zhCNKeys, enUSKeys);
    const missingInZhCN = sortedMissing(enUSKeys, zhCNKeys);
    const problems: string[] = [];
    if (missingInEnUS.length > 0) {
      problems.push(
        `keys present in zh-CN but missing in en-US (${missingInEnUS.length}): ${missingInEnUS.join(', ')}`,
      );
    }
    if (missingInZhCN.length > 0) {
      problems.push(
        `keys present in en-US but missing in zh-CN (${missingInZhCN.length}): ${missingInZhCN.join(', ')}`,
      );
    }
    expect(problems).toEqual([]);
  });

  test('every translation value is a non-empty string', () => {
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const table: TranslationTable = TRANSLATIONS[locale];
      for (const [key, value] of Object.entries(table)) {
        if (typeof value !== 'string' || value.length === 0) {
          problems.push(`${locale}: '${key}' value is not a non-empty string`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('each key uses the same {placeholder} tokens in both locales', () => {
    const enUSKeys = new Set(Object.keys(enUSTable));
    const sharedKeys = Object.keys(zhCNTable).filter((key) =>
      enUSKeys.has(key),
    );
    const problems: string[] = [];
    for (const key of sharedKeys) {
      const enUSTokens = new Set(extractPlaceholders(enUSTable[key]));
      const zhCNTokens = new Set(extractPlaceholders(zhCNTable[key]));
      const onlyInEnUS = sortedMissing(enUSTokens, zhCNTokens);
      const onlyInZhCN = sortedMissing(zhCNTokens, enUSTokens);
      if (onlyInEnUS.length > 0 || onlyInZhCN.length > 0) {
        problems.push(
          `${key}: placeholders only in en-US [${onlyInEnUS.join(', ')}], only in zh-CN [${onlyInZhCN.join(', ')}]`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});
