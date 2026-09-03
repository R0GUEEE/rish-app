/** Deterministic bounds applied to hostile or pathological model output. */

export const TABLE_LIMITS = {
  /** Maximum number of columns a rendered table may have. */
  maxColumns: 12,
  /** Maximum number of rows (header included) a rendered table may have. */
  maxRows: 80,
  /** Maximum characters in a single rendered cell. */
  maxCellChars: 256,
  /** Maximum total cells (rows x columns) a rendered table may contain. */
  maxTotalCells: 960,
} as const;

export const MATH_LIMITS = {
  /** Maximum LaTeX source characters accepted for block math. */
  maxSourceChars: 8192,
  /** Maximum LaTeX source characters accepted for inline math. */
  maxInlineSourceChars: 2048,
  /** Maximum tokens produced by the math tokenizer. */
  maxTokens: 4096,
  /** Maximum nesting depth of the math parser. */
  maxDepth: 24,
  /** Maximum nodes in a parsed math expression. */
  maxNodes: 2048,
  /** Maximum layout items emitted by the math layout engine. */
  maxLayoutItems: 4096,
  /** Maximum characters of an inline unicode-rendered formula. */
  maxInlineUnicodeChars: 400,
} as const;

export const INLINE_LIMITS = {
  /** Lines longer than this skip inline scanning entirely. */
  maxLineChars: 8192,
  /** Longest code span scanned for a closing backtick. */
  maxCodeSpanChars: 2000,
  /** Longest strong span scanned for a closing delimiter. */
  maxStrongSpanChars: 4096,
} as const;

export const IMAGE_LIMITS = {
  /** Maximum characters of a data: URI accepted for immediate display. */
  maxDataUriChars: 256 * 1024,
  /** Maximum characters of any image URL. */
  maxUrlChars: 2048,
  /** Maximum characters of image alt text. */
  maxAltChars: 200,
} as const;

/** Displayed characters of a verbatim (code-style) fallback block. */
export const VERBATIM_FALLBACK_CHARS = 4000;
