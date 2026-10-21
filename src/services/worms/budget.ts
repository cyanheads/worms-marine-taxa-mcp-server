/**
 * @fileoverview Whole-item stateless response budgeting using the scientific codec.
 * @module services/worms/budget
 */
import { z } from '@cyanheads/mcp-ts-core';
import { formatData, renderData } from './format.js';

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

/** Reproduce the framework's domain block and custom scientific enrichment trailer. */
export function resultBytes(domain: unknown, enrichment: Record<string, unknown>) {
  const fields = Object.entries(enrichment).map(([key, value]) =>
    renderData(value, `$[${JSON.stringify(key)}]`),
  );
  const content = [
    ...formatData(domain),
    ...(fields.length ? [{ type: 'text', text: `\n\n${fields.join('\n')}` }] : []),
  ];
  return Buffer.byteLength(
    JSON.stringify({ structuredContent: { ...(domain as object), ...enrichment }, content }),
  );
}

/** Largest whole-item prefix; reserve 1,000 bytes for protocol metadata added after formatting. */
export function budgetPrefix<T>(
  count: number,
  build: (take: number, budget: Budget) => T,
  enrichment: Record<string, unknown>,
  check: () => void,
): T {
  const candidate = (take: number) =>
    build(take, { byteBudget: 24000, budgetLimited: take < count, oversizedItem: false });
  let low = count ? 1 : 0;
  let high = count;
  let best = candidate(low);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const value = candidate(mid);
    const bytes = resultBytes(value, enrichment);
    check();
    if (bytes <= 23000) {
      best = value;
      low = mid + 1;
    } else high = mid - 1;
  }
  const bytes = resultBytes(best, enrichment);
  check();
  if (bytes <= 23000) return best;
  let requiredBytes = 0;
  let oversized = build(count ? 1 : 0, {
    byteBudget: 24000,
    budgetLimited: count > 1,
    oversizedItem: true,
    requiredBytes,
  });
  for (;;) {
    const measured = resultBytes(oversized, enrichment);
    check();
    if (measured === requiredBytes) return oversized;
    requiredBytes = measured;
    oversized = build(count ? 1 : 0, {
      byteBudget: 24000,
      budgetLimited: count > 1,
      oversizedItem: true,
      requiredBytes,
    });
  }
}

/** Page an already normalized complete sequence, preserving original tree indices. */
export function localSlice<T, R>(
  items: T[],
  offset: number,
  build: (rows: T[], pagination: z.infer<ReturnType<typeof pageSchema>>) => R,
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
function pageSchema() {
  return z.object(localPageFields);
}
