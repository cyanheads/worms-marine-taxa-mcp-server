/**
 * @fileoverview Resolve exact, fuzzy, or common names with positional results.
 * @module mcp-server/tools/definitions/resolve-taxon.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  attribution,
  attributionSchema,
  formatData,
  getWormsService,
  matchSchema,
  offsetSchema,
  optionalTextSchema,
  page,
  pageSchema,
  renderData,
  textSchema,
  WormsScope,
} from '@/services/worms/index.js';

export const resolveTaxonTool = tool('worms_resolve_taxon', {
  description:
    'Resolve scientific names exactly by default or explicitly with fuzzy matching, or search one vernacular name. Names default to marine and extant taxa; vernacular searches cannot apply those filters. Process the first 50 names from up to 500, preserving duplicate positions and naming deferredInputs. A full page has uncertain continuation; accepted-name fields identify the accepted taxon without selecting an ambiguous match.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    names: z
      .array(textSchema)
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Scientific names; first 50 processed, remaining values returned in deferredInputs.',
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
    mode: z.enum(['exact', 'fuzzy', 'vernacular']).describe('Matching mode.'),
    results: z
      .array(
        z
          .object({
            input: z.string().describe('Submitted name.'),
            matches: z.array(matchSchema).describe('All returned matches in source order.'),
            guidance: z.string().nullable().describe('Recovery guidance for a miss.'),
          })
          .describe('Positional name result.'),
      )
      .describe('One result per processed input.'),
    deferredInputs: z
      .array(z.string())
      .describe('Unprocessed names, preserving order and duplicates.'),
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
      when: 'Both or neither selector was supplied.',
      recovery: 'Call worms_resolve_taxon with either names or vernacular, never both.',
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
    if (
      (input.names && input.offset !== 1) ||
      (input.vernacular && (input.fuzzy || !input.marineOnly || !input.extantOnly))
    )
      throw ctx.fail('unsupported_mode_options');
    using scope = new WormsScope(ctx);
    const service = getWormsService();
    if (input.vernacular) {
      const matches = await service.vernacularSearch(input.vernacular, input.offset, scope);
      ctx.enrich({
        echo: { marineOnly: null, extantOnly: null, fuzzy: false, offset: input.offset },
        ...(matches.length === 0
          ? { notice: 'Call worms_resolve_taxon with a broader vernacular or offset: 1.' }
          : {}),
      });
      scope.check();
      return {
        mode: 'vernacular' as const,
        results: [{ input: input.vernacular, matches, guidance: null }],
        deferredInputs: [],
        page: page(input.offset, matches.length),
        attribution: attribution(),
      };
    }
    const names = input.names ?? [];
    const processed = names.slice(0, 50);
    const deferredInputs = names.slice(50);
    const groups = await service.names(
      processed,
      input.fuzzy,
      input.marineOnly,
      input.extantOnly,
      scope,
    );
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
      return { input: name, matches, guidance };
    });
    const notices = [
      ...(deferredInputs.length
        ? ['Submit deferredInputs to worms_resolve_taxon to process the remaining names.']
        : []),
      ...(groups.some((group) => group.length === 50)
        ? [
            'A scientific-name group returned 50 matches; completeness is unknown. Narrow the scientific name with worms_resolve_taxon.',
          ]
        : []),
    ];
    ctx.enrich({
      echo: {
        marineOnly: input.marineOnly,
        extantOnly: input.extantOnly,
        fuzzy: input.fuzzy,
        ...(input.fuzzy ? { matchAuthority: false } : {}),
      },
      ...(notices.length ? { notice: notices.join(' ') } : {}),
    });
    scope.check();
    return {
      mode: input.fuzzy ? ('fuzzy' as const) : ('exact' as const),
      results,
      deferredInputs,
      attribution: attribution(),
    };
  },
  format: formatData,
});
