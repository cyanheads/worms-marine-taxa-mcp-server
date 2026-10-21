/**
 * @fileoverview Whole-item stateless response budgeting using the scientific codec.
 * @module services/worms/budget
 */
import { z } from '@cyanheads/mcp-ts-core';
import { formatData, renderEnrichmentField } from './format.js';

export const localOffsetSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .default(0)
  .describe('Zero-based local position; resubmit unchanged selectors and options.');
export const budgetFields = {
  byteBudget: z.literal(24000).describe('Complete serialized response byte target.'),
  budgetLimited: z.boolean().describe('Whether the byte budget ended this local page early.'),
  oversizedItem: z
    .boolean()
    .describe(
      'One indivisible scientific item exceeds the target; retained intact with forward progress.',
    ),
  requiredBytes: z
    .number()
    .int()
    .optional()
    .describe(
      'Serialized paired-surface result bytes for an oversized item, excluding transport-added metadata.',
    ),
};
export const localPageFields = {
  resultOffset: z
    .number()
    .int()
    .describe('Zero-based starting position in the complete local sequence.'),
  returnedCount: z.number().int().describe('Whole scientific items returned on this segment.'),
  totalCount: z.number().int().describe('Known local sequence length before pagination.'),
  nextResultOffset: z
    .number()
    .int()
    .nullable()
    .describe('Next local position; null when consumed.'),
  ...budgetFields,
};
type Budget = {
  byteBudget: 24000;
  budgetLimited: boolean;
  oversizedItem: boolean;
  requiredBytes?: number;
};
type LocalPage = Budget & {
  resultOffset: number;
  returnedCount: number;
  totalCount: number;
  nextResultOffset: number | null;
};

/** A last line the framework closes with a blank line: a block quote or a list item, ≤3 spaces in. */
const LAZY_CONTAINER_LINE = /^ {0,3}(?:>|(?:[-+*]|\d{1,9}[.)])(?: |$))/;

/** Join trailer fields exactly as the framework does, so the pager measures the bytes it ships. */
function joinTrailerFields(fields: string[]): string {
  let text = '';
  for (const field of fields) {
    if (text)
      text += LAZY_CONTAINER_LINE.test(text.slice(text.lastIndexOf('\n') + 1)) ? '\n\n' : '\n';
    text += field;
  }
  return text;
}

/** Reproduce the framework's domain block and custom scientific enrichment trailer. */
function resultBytes(domain: object, enrichment: Record<string, unknown>) {
  const fields = Object.entries(enrichment).map(([key, value]) =>
    renderEnrichmentField(key, value),
  );
  const content = [
    ...formatData(domain),
    ...(fields.length ? [{ type: 'text', text: `\n\n${joinTrailerFields(fields)}` }] : []),
  ];
  return Buffer.byteLength(
    JSON.stringify({ structuredContent: { ...domain, ...enrichment }, content }),
  );
}

/**
 * Largest whole-item prefix; reserve 1,000 bytes for protocol metadata added after formatting.
 * Enrichment that depends on the page is a function of each candidate, measured with that candidate.
 */
export function budgetPrefix<T extends object>(
  count: number,
  build: (take: number, budget: Budget) => T,
  enrichment: Record<string, unknown> | ((page: T) => Record<string, unknown>),
  check: () => void,
): T {
  const enrichmentOf = typeof enrichment === 'function' ? enrichment : () => enrichment;
  let best: T | undefined;
  let low = count ? 1 : 0;
  let high = count;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const value = build(mid, {
      byteBudget: 24000,
      budgetLimited: mid < count,
      oversizedItem: false,
    });
    const bytes = resultBytes(value, enrichmentOf(value));
    check();
    if (bytes <= 23000) {
      best = value;
      low = mid + 1;
    } else high = mid - 1;
  }
  if (best !== undefined) return best;
  let requiredBytes = 0;
  for (;;) {
    const oversized = build(count ? 1 : 0, {
      byteBudget: 24000,
      budgetLimited: count > 1,
      oversizedItem: true,
      requiredBytes,
    });
    const measured = resultBytes(oversized, enrichmentOf(oversized));
    check();
    if (measured === requiredBytes) return oversized;
    requiredBytes = measured;
  }
}

/** Page an already normalized complete sequence, preserving original tree indices. */
export function localSlice<T, R extends object>(
  items: T[],
  offset: number,
  build: (rows: T[], pagination: LocalPage) => R,
  enrichment: Record<string, unknown>,
  check: () => void,
): R {
  const remaining = items.slice(offset);
  return budgetPrefix(
    remaining.length,
    (take, budget) =>
      build(remaining.slice(0, take), {
        resultOffset: offset,
        returnedCount: take,
        totalCount: items.length,
        nextResultOffset: offset + take < items.length ? offset + take : null,
        ...budget,
      }),
    enrichment,
    check,
  );
}
