/**
 * @fileoverview Resolve exact, fuzzy, or common names with positional results.
 * @module mcp-server/tools/definitions/resolve-taxon.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  attribution,
  attributionSchema,
  budgetFields,
  budgetPrefix,
  formatData,
  getWormsService,
  localOffsetSchema,
  localPageFields,
  localSlice,
  matchSchema,
  offsetSchema,
  optionalTextSchema,
  page,
  pageSchema,
  renderData,
  textSchema,
  WormsScope,
} from '../../../services/worms/index.js';

export const resolveTaxonTool = tool('worms_resolve_taxon', {
  description:
    'Resolve exact or explicitly fuzzy scientific names, or search one vernacular name. Names default to marine and extant taxa; vernacular cannot filter. Resume scientific segments with nextInputOffset and nextMatchOffset against unchanged names and options; inputIndex preserves duplicates and partialGroup identifies split groups. For vernacular, consume nextResultOffset within the same upstream offset before advancing page.nextOffset and resetting resultOffset to zero. Full 50-match upstream groups remain completeness-unknown; accepted-name fields do not choose an ambiguous match.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    inputOffset: localOffsetSchema.describe(
      'Zero-based original scientific names position; inactive for vernacular.',
    ),
    matchOffset: localOffsetSchema.describe(
      'Zero-based match within the scientific-name group at inputOffset; inactive for vernacular.',
    ),
    resultOffset: localOffsetSchema.describe(
      'Zero-based match within the fetched vernacular page; keep upstream offset until consumed. Inactive for scientific names.',
    ),
    names: z
      .array(textSchema)
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Original scientific names; resubmit unchanged with continuation offsets, preserving duplicates.',
      ),
    vernacular: optionalTextSchema.describe(
      'Common name, mutually exclusive with names; blank means unset.',
    ),
    fuzzy: z
      .boolean()
      .default(false)
      .describe('Explicit fuzzy scientific-name matching; unavailable for vernacular.'),
    marineOnly: z
      .boolean()
      .default(true)
      .describe(
        'Filter scientific names to marine taxa; vernacular cannot filter and rejects false.',
      ),
    extantOnly: z
      .boolean()
      .default(true)
      .describe(
        'Filter scientific names to extant taxa; vernacular cannot filter and rejects false.',
      ),
    offset: offsetSchema,
  }),
  output: z.object({
    ...budgetFields,
    nextInputOffset: z
      .number()
      .int()
      .nullable()
      .describe('Next original names position; resubmit unchanged names and options.'),
    nextMatchOffset: z
      .number()
      .int()
      .nullable()
      .describe('Next match position at nextInputOffset; null when names consumed.'),
    deferredCount: z.number().int().describe('Original input positions not fully consumed.'),
    resultOffset: localPageFields.resultOffset.optional(),
    returnedCount: localPageFields.returnedCount.optional(),
    totalCount: localPageFields.totalCount.optional(),
    nextResultOffset: localPageFields.nextResultOffset.optional(),
    mode: z.enum(['exact', 'fuzzy', 'vernacular']).describe('Matching mode.'),
    results: z
      .array(
        z
          .object({
            inputIndex: z.number().int().describe('Original zero-based input position.'),
            matchOffset: z
              .number()
              .int()
              .describe('Starting match position in the original group.'),
            partialGroup: z
              .boolean()
              .describe('This segment does not contain the entire fetched group.'),
            input: z.string().describe('Submitted name.'),
            matches: z.array(matchSchema).describe('All returned matches in source order.'),
            guidance: z.string().nullable().describe('Recovery guidance for a miss.'),
          })
          .describe('Positional name result.'),
      )
      .describe('One result per processed input.'),
    page: pageSchema.optional().describe('Vernacular page only.'),
    attribution: attributionSchema,
  }),
  enrichment: {
    notice: z.string().optional().describe('Deferred-work or empty-page guidance.'),
    echo: z
      .object({
        marineOnly: z
          .boolean()
          .nullable()
          .describe('Effective marine filter, null when unsupported.'),
        extantOnly: z
          .boolean()
          .nullable()
          .describe('Effective extant filter, null when unsupported.'),
        fuzzy: z.boolean().describe('Effective fuzzy mode.'),
        offset: z.number().optional().describe('Vernacular offset.'),
        matchAuthority: z.boolean().optional().describe('Fuzzy authority matching, always false.'),
      })
      .describe('Effective matching options.'),
  },
  enrichmentTrailer: {
    notice: { render: (value) => renderData(value, '$["notice"]') },
    echo: { render: (value) => renderData(value, '$["echo"]') },
  },
  errors: [
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'HTTP 400/422 rejected the inputs.',
      recovery:
        'Call worms_list_reference for valid vocabulary, then retry the original tool with corrected inputs.',
      retryable: false,
      thrownBy: 'service' as const,
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Upstream rate limit or local queue overflow.',
      recovery:
        'Wait for the stated retry delay, then retry the same tool with fewer concurrent calls.',
      retryable: true,
      thrownBy: 'service' as const,
    },
    {
      reason: 'upstream_access_denied',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Keyless upstream denies access.',
      recovery: 'Retry the same tool later; the keyless WoRMS service currently refuses access.',
      retryable: false,
      thrownBy: 'service' as const,
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Network, server, or HTML failure.',
      recovery:
        'Retry the same tool later; use worms_list_reference with topic: external_id_types for offline vocabulary.',
      retryable: true,
      thrownBy: 'service' as const,
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Request or whole-tool deadline expired.',
      recovery:
        'Retry the same tool later; call worms_crosswalk_id with one type to reduce crosswalk work.',
      retryable: true,
      thrownBy: 'service' as const,
    },
    {
      reason: 'invalid_upstream_response',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Malformed or incompatible upstream response.',
      recovery: 'Retry the same tool later; use worms_get_taxon to verify a known AphiaID.',
      retryable: false,
      thrownBy: 'service' as const,
    },
    {
      reason: 'response_too_large',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Upstream response exceeds 8 MiB.',
      recovery:
        'Call worms_get_taxon for the taxon record; this tool cannot return the oversized WoRMS response.',
      retryable: false,
      thrownBy: 'service' as const,
    },
    {
      reason: 'invalid_selector',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both or neither selector was supplied, or vernacular is exactly "." or "..".',
      recovery:
        'Call worms_resolve_taxon with either names or vernacular, never both; vernacular cannot be . or .. (dot-only).',
    },
    {
      reason: 'unsupported_mode_options',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Options cannot apply to the selected matching mode.',
      recovery:
        'Call worms_resolve_taxon with fuzzy and filters for names, or only vernacular and offset for common names.',
    },
  ],
  async handler(input, ctx) {
    if (Boolean(input.names) === Boolean(input.vernacular)) throw ctx.fail('invalid_selector');
    if (input.vernacular === '.' || input.vernacular === '..')
      throw ctx.fail('invalid_selector', 'vernacular cannot be . or ..');
    if (
      (input.names && input.offset !== 1) ||
      (input.vernacular && (input.fuzzy || !input.marineOnly || !input.extantOnly))
    )
      throw ctx.fail('unsupported_mode_options');
    using scope = new WormsScope(ctx);
    const service = getWormsService();
    if (input.vernacular) {
      const vernacular = input.vernacular;
      const matches = await service.vernacularSearch(input.vernacular, input.offset, scope);
      const enrichment = {
        echo: { marineOnly: null, extantOnly: null, fuzzy: false, offset: input.offset },
        ...(matches.length === 0
          ? { notice: 'Call worms_resolve_taxon with a broader vernacular or offset: 1.' }
          : {}),
      };
      ctx.enrich(enrichment);
      scope.check();
      return localSlice(
        matches,
        input.resultOffset,
        (segment, pagination) => ({
          mode: 'vernacular' as const,
          results: [
            {
              input: vernacular,
              inputIndex: 0,
              matchOffset: input.resultOffset,
              partialGroup: segment.length !== matches.length,
              matches: segment,
              guidance: null,
            },
          ],
          ...pagination,
          nextInputOffset: null,
          nextMatchOffset: null,
          deferredCount: 0,
          page: {
            ...page(input.offset, matches.length),
            returnedCount: segment.length,
            nextOffset:
              pagination.nextResultOffset === null
                ? page(input.offset, matches.length).nextOffset
                : input.offset,
          },
          attribution: attribution(),
        }),
        enrichment,
        () => scope.check(),
      );
    }
    const names = input.names ?? [];
    const windowStart = Math.floor(input.inputOffset / 50) * 50;
    const processed = names.slice(windowStart, windowStart + 50);
    const groups = processed.length
      ? await service.names(processed, input.fuzzy, input.marineOnly, input.extantOnly, scope)
      : [];
    const results = processed.map((name, index) => {
      const matches = groups[index] ?? [];
      const guidance = matches.length
        ? null
        : [
            input.fuzzy
              ? 'Check spelling and call worms_resolve_taxon with corrected names.'
              : 'Call worms_resolve_taxon with the same names and fuzzy: true.',
            ...(input.marineOnly
              ? ['Call worms_resolve_taxon with marineOnly: false to include non-marine taxa.']
              : []),
          ].join(' ');
      return { input: name, inputIndex: windowStart + index, matches, guidance };
    });
    const notices = [
      ...(groups.some((group) => group.length === 50)
        ? [
            'A scientific-name group returned 50 matches; completeness is unknown. Narrow the scientific name with worms_resolve_taxon.',
          ]
        : []),
    ];
    const enrichment = {
      echo: {
        marineOnly: input.marineOnly,
        extantOnly: input.extantOnly,
        fuzzy: input.fuzzy,
        ...(input.fuzzy ? { matchAuthority: false } : {}),
      },
      ...(notices.length ? { notice: notices.join(' ') } : {}),
    };
    ctx.enrich(enrichment);
    scope.check();
    const units = results.flatMap<{
      group: (typeof results)[number];
      match: z.infer<typeof matchSchema> | null;
      matchIndex: number;
    }>((group) => {
      if (group.inputIndex < input.inputOffset) return [];
      const start = group.inputIndex === input.inputOffset ? input.matchOffset : 0;
      if (!group.matches.length) return [{ group, match: null, matchIndex: 0 }];
      return group.matches
        .slice(start)
        .map((match, index) => ({ group, match, matchIndex: start + index }));
    });
    return budgetPrefix(
      units.length,
      (take, budget) => {
        const selected = units.slice(0, take);
        const emitted: {
          input: string;
          inputIndex: number;
          matches: z.infer<typeof matchSchema>[];
          guidance: string | null;
          matchOffset: number;
          partialGroup: boolean;
        }[] = [];
        for (const unit of selected) {
          const previous = emitted.at(-1);
          const entry =
            previous?.inputIndex === unit.group.inputIndex
              ? previous
              : { ...unit.group, matches: [], matchOffset: unit.matchIndex, partialGroup: false };
          if (entry !== previous) emitted.push(entry);
          if (unit.match) entry.matches.push(unit.match);
          entry.partialGroup =
            entry.matchOffset > 0 || entry.matches.length < unit.group.matches.length;
        }
        const last = selected.at(-1);
        const moreMatches = last && last.matchIndex + 1 < last.group.matches.length;
        const next = last
          ? moreMatches
            ? last.group.inputIndex
            : last.group.inputIndex + 1
          : Math.min(names.length, input.inputOffset + (units.length ? 0 : 1));
        return {
          mode: input.fuzzy ? ('fuzzy' as const) : ('exact' as const),
          results: emitted,
          nextInputOffset: next < names.length ? next : null,
          nextMatchOffset:
            next < names.length ? (moreMatches && last ? last.matchIndex + 1 : 0) : null,
          deferredCount: Math.max(0, names.length - next),
          attribution: attribution(),
          ...budget,
        };
      },
      enrichment,
      () => scope.check(),
    );
  },
  format: formatData,
});
