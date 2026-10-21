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
  formatData,
  getWormsService,
  itemErrorSchema,
  localOffsetSchema,
  renderData,
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
    guidance: z.string().nullable().describe('Next step for absent records.'),
  })
  .describe('Positional taxon retrieval result.');
export const getTaxonTool = tool('worms_get_taxon', {
  description:
    'Retrieve full Aphia records by IDs from worms_resolve_taxon in byte-budgeted segments. Resume nextInputOffset as inputOffset using unchanged aphiaIds and options; inputIndex preserves duplicate and missing positions. includeVernaculars requires one submitted ID; resume nextVernacularOffset as vernacularOffset, repeating the full primary record. Optional failure retains that record; unknown facts remain omitted or null.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    inputOffset: localOffsetSchema,
    vernacularOffset: localOffsetSchema.describe(
      'Zero-based common-name position for the singleton ID; repeat unchanged options. Inactive without includeVernaculars.',
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
      .describe('Resume common names for the same singleton record; null when consumed.'),
    results: z.array(resultSchema).describe('One positional result per processed ID.'),
    attribution: attributionSchema,
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance for deferred work.'),
    echo: z
      .object({
        includeVernaculars: z.boolean().describe('Effective common-name enrichment option.'),
      })
      .describe('Effective options.'),
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
      reason: 'vernacular_batch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Common names requested for multiple submitted IDs.',
      recovery: 'Call worms_get_taxon with one aphiaIds entry and includeVernaculars: true.',
    },
  ],
  async handler(input, ctx) {
    if (input.includeVernaculars && input.aphiaIds.length !== 1) throw ctx.fail('vernacular_batch');
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
    const enrichment = {
      echo: { includeVernaculars: input.includeVernaculars },
    };
    ctx.enrich(enrichment);
    scope.check();
    const vernaculars = first?.vernaculars;
    const remaining = vernaculars?.slice(input.vernacularOffset);
    return budgetPrefix(
      remaining?.length ?? results.length,
      (take, budget) => {
        const nextVernacularOffset =
          remaining && take < remaining.length ? input.vernacularOffset + take : null;
        const emitted =
          remaining && first
            ? [{ ...first, vernaculars: remaining.slice(0, take) }]
            : results.slice(0, take);
        const next =
          nextVernacularOffset !== null ? input.inputOffset : input.inputOffset + emitted.length;
        return {
          results: emitted,
          attribution: attribution(),
          ...budget,
          nextInputOffset: next < input.aphiaIds.length ? next : null,
          deferredCount: Math.max(0, input.aphiaIds.length - next),
          nextVernacularOffset,
        };
      },
      enrichment,
      () => scope.check(),
    );
  },
  format: formatData,
});
