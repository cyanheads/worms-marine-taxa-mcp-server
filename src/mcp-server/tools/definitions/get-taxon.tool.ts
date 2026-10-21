/**
 * @fileoverview Retrieve complete taxon records and optional common names.
 * @module mcp-server/tools/definitions/get-taxon.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  aphiaIdSchema,
  attribution,
  attributionSchema,
  budgetFields,
  budgetPrefix,
  codecTrailer,
  formatData,
  getWormsService,
  itemErrorSchema,
  localOffsetSchema,
  sourceSchema,
  taxonRecordSchema,
  vernacularSchema,
  WormsScope,
} from '../../../services/worms/index.js';

const resultSchema = z
  .object({
    inputIndex: z.number().int().describe('Original zero-based submitted ID position.'),
    requestedAphiaId: aphiaIdSchema,
    found: z.boolean().describe('Whether a record exists.'),
    record: taxonRecordSchema.nullable().describe('Full documented taxon record, or null.'),
    vernaculars: z
      .array(vernacularSchema)
      .optional()
      .describe('Common names only when requested and successfully retrieved.'),
    vernacularError: itemErrorSchema.optional().describe('Optional common-name retrieval failure.'),
    sources: z
      .array(sourceSchema)
      .optional()
      .describe('Sources in upstream order, only when requested and successfully retrieved.'),
    sourcesError: itemErrorSchema.optional().describe('Optional source retrieval failure.'),
    guidance: z.string().nullable().describe('Next step for absent records.'),
  })
  .describe('Positional taxon retrieval result.');
export const getTaxonTool = tool('worms_get_taxon', {
  description:
    'Retrieve full Aphia records by IDs from worms_resolve_taxon in byte-budgeted segments. Resume nextInputOffset as inputOffset using unchanged aphiaIds and options; inputIndex preserves duplicate and missing positions. includeVernaculars (common names) or includeSources (original description, basis of record, and other sources) requires one submitted ID, one of the two per call; resume nextVernacularOffset as vernacularOffset or nextSourceOffset as sourceOffset, repeating the full primary record. Optional failure retains that record; unknown facts remain omitted or null.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    inputOffset: localOffsetSchema,
    vernacularOffset: localOffsetSchema.describe(
      'Zero-based common-name position for the singleton ID; repeat unchanged options. Inactive without includeVernaculars.',
    ),
    sourceOffset: localOffsetSchema.describe(
      'Zero-based source position for the singleton ID; repeat unchanged options. Inactive without includeSources.',
    ),
    aphiaIds: z
      .array(aphiaIdSchema)
      .min(1)
      .max(500)
      .describe(
        'Original AphiaIDs in order; resubmit unchanged with inputOffset, without deduplicating.',
      ),
    includeVernaculars: z
      .boolean()
      .default(false)
      .describe('Retrieve common names; requires exactly one submitted ID.'),
    includeSources: z
      .boolean()
      .default(false)
      .describe(
        'Retrieve the taxon sources, such as its original description and basis of record; requires exactly one submitted ID and cannot combine with includeVernaculars.',
      ),
  }),
  output: z.object({
    ...budgetFields,
    nextInputOffset: z
      .number()
      .int()
      .nullable()
      .describe('Resume position in the unchanged original aphiaIds; null when consumed.'),
    deferredCount: z.number().int().describe('Number of original ID positions still deferred.'),
    nextVernacularOffset: z
      .number()
      .int()
      .nullable()
      .describe(
        'Resume common names for the same singleton record; null when consumed or not requested.',
      ),
    nextSourceOffset: z
      .number()
      .int()
      .nullable()
      .describe(
        'Resume sources for the same singleton record; null when consumed or not requested.',
      ),
    results: z.array(resultSchema).describe('One positional result per processed ID.'),
    attribution: attributionSchema,
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance for deferred work.'),
    echo: z
      .object({
        includeVernaculars: z.boolean().describe('Effective common-name enrichment option.'),
        includeSources: z.boolean().describe('Effective source enrichment option.'),
      })
      .describe('Effective options.'),
  },
  enrichmentTrailer: codecTrailer('notice', 'echo'),
  errors: [
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'HTTP 400/422 rejected the inputs.',
      recovery:
        'Resolve the scientific names with worms_resolve_taxon for valid AphiaIDs, then retry the same tool.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Upstream rate limit or local queue overflow.',
      recovery:
        'Wait for the stated retry delay, then retry the same tool with fewer concurrent calls.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_access_denied',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Keyless upstream denies access.',
      recovery: 'Retry the same tool later; the keyless WoRMS service currently refuses access.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Network, server, or HTML failure.',
      recovery: 'Retry the same tool later; the WoRMS service is currently unreachable or failing.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Request or whole-tool deadline expired.',
      recovery: 'Retry the same tool later; WoRMS did not answer within the time limit.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'invalid_upstream_response',
      code: JsonRpcErrorCode.SerializationError,
      when: 'Malformed or incompatible upstream response.',
      recovery:
        'Retry the same tool later; use worms_resolve_taxon with the scientific names to confirm the AphiaIDs.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'response_too_large',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Upstream response exceeds 8 MiB.',
      recovery:
        'If several aphiaIds were submitted, submit fewer per call. For a single ID, use the record returned beside an oversized common-name or source list, or call worms_resolve_taxon with its scientific name.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'vernacular_batch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Common names requested for multiple submitted IDs.',
      recovery: 'Call worms_get_taxon with one aphiaIds entry and includeVernaculars: true.',
    },
    {
      reason: 'sources_batch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Sources requested for multiple submitted IDs.',
      recovery: 'Call worms_get_taxon with one aphiaIds entry and includeSources: true.',
    },
    {
      reason: 'enrichment_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Common names and sources requested in one call.',
      recovery:
        'Call worms_get_taxon once with includeVernaculars: true and once with includeSources: true.',
    },
  ],
  async handler(input, ctx) {
    if (input.includeVernaculars && input.includeSources) throw ctx.fail('enrichment_conflict');
    if (input.includeVernaculars && input.aphiaIds.length !== 1) throw ctx.fail('vernacular_batch');
    if (input.includeSources && input.aphiaIds.length !== 1) throw ctx.fail('sources_batch');
    using scope = new WormsScope(ctx);
    const service = getWormsService();
    const ids = input.aphiaIds.slice(input.inputOffset, input.inputOffset + 50);
    const records = ids.length ? await service.records(ids, scope) : [];
    const results: z.infer<typeof resultSchema>[] = ids.map((id, index) => ({
      inputIndex: input.inputOffset + index,
      requestedAphiaId: id,
      found: records[index] !== null,
      record: records[index] ?? null,
      guidance: records[index]
        ? null
        : 'Call worms_resolve_taxon with a scientific name to find an AphiaID.',
    }));
    const first = results[0];
    if (input.includeVernaculars && first?.found) {
      try {
        first.vernaculars = await service.vernaculars(first.requestedAphiaId, scope);
      } catch (error) {
        first.vernacularError = scope.optionalError(error);
      }
    }
    if (input.includeSources && first?.found) {
      try {
        first.sources = await service.sources(first.requestedAphiaId, scope);
      } catch (error) {
        first.sourcesError = scope.optionalError(error);
      }
    }
    const enrichment = {
      echo: { includeVernaculars: input.includeVernaculars, includeSources: input.includeSources },
    };
    ctx.enrich(enrichment);
    scope.check();
    const vernaculars = first?.vernaculars?.slice(input.vernacularOffset);
    const sources = first?.sources?.slice(input.sourceOffset);
    const nestedCount = vernaculars?.length ?? sources?.length;
    return budgetPrefix(
      nestedCount ?? results.length,
      (take, budget) => {
        const nestedMore = nestedCount !== undefined && take < nestedCount;
        const emitted =
          first && nestedCount !== undefined
            ? [
                {
                  ...first,
                  ...(vernaculars ? { vernaculars: vernaculars.slice(0, take) } : {}),
                  ...(sources ? { sources: sources.slice(0, take) } : {}),
                },
              ]
            : results.slice(0, take);
        const next = nestedMore ? input.inputOffset : input.inputOffset + emitted.length;
        return {
          results: emitted,
          attribution: attribution(),
          ...budget,
          nextInputOffset: next < input.aphiaIds.length ? next : null,
          deferredCount: Math.max(0, input.aphiaIds.length - next),
          nextVernacularOffset: vernaculars && nestedMore ? input.vernacularOffset + take : null,
          nextSourceOffset: sources && nestedMore ? input.sourceOffset + take : null,
        };
      },
      enrichment,
      () => scope.check(),
    );
  },
  format: formatData,
});
