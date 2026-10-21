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
  formatData,
  getWormsService,
  itemErrorSchema,
  renderData,
  taxonRecordSchema,
  vernacularSchema,
  WormsScope,
} from '@/services/worms/index.js';

const resultSchema = z
  .object({
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
    'Retrieve full Aphia records by IDs from worms_resolve_taxon. Process the first 50 of up to 500 IDs and return deferredInputs, preserving order, duplicates, and missing positions. Optionally include vernacular names for exactly one submitted ID; enrichment failure retains the primary record. Unknown scientific facts remain omitted or null.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    aphiaIds: z
      .array(aphiaIdSchema)
      .min(1)
      .max(500)
      .describe('AphiaIDs; first 50 processed, remaining entries returned in deferredInputs.'),
    includeVernaculars: z
      .boolean()
      .default(false)
      .describe('Retrieve common names; requires exactly one submitted ID.'),
  }),
  output: z.object({
    results: z.array(resultSchema).describe('One positional result per processed ID.'),
    deferredInputs: z.array(aphiaIdSchema).describe('Unprocessed IDs in original order.'),
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
    const ids = input.aphiaIds.slice(0, 50);
    const deferredInputs = input.aphiaIds.slice(50);
    const records = await service.records(ids, scope);
    const results: z.infer<typeof resultSchema>[] = ids.map((id, index) => ({
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
    ctx.enrich({
      echo: { includeVernaculars: input.includeVernaculars },
      ...(deferredInputs.length
        ? { notice: 'Submit deferredInputs to worms_get_taxon to process the remaining IDs.' }
        : {}),
    });
    scope.check();
    return { results, deferredInputs, attribution: attribution() };
  },
  format: formatData,
});
