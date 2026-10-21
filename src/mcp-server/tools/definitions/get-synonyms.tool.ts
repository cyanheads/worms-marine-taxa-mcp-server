/**
 * @fileoverview Resolve accepted taxon and retrieve one complete synonym page.
 * @module mcp-server/tools/definitions/get-synonyms.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  aphiaIdSchema,
  attribution,
  attributionSchema,
  formatData,
  getWormsService,
  offsetSchema,
  page,
  pageSchema,
  renderData,
  taxonRecordSchema,
  WormsScope,
} from '@/services/worms/index.js';
export const getSynonymsTool = tool('worms_get_synonyms', {
  description:
    'Retrieve one synonym page for the accepted taxon linked from an AphiaID obtained with worms_resolve_taxon. A present name without an accepted ID has no synonym lookup; inspect its status with worms_get_taxon. A full 50-row page has uncertain continuation; nextOffset may return an empty page.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({ aphiaId: aphiaIdSchema, offset: offsetSchema }),
  output: z.object({
    aphiaId: aphiaIdSchema,
    found: z.boolean().describe('Whether the supplied taxon exists.'),
    validAphiaId: aphiaIdSchema.nullable().describe('Accepted taxon ID when known.'),
    synonyms: z
      .array(
        taxonRecordSchema
          .pick({
            aphiaId: true,
            scientificname: true,
            authority: true,
            status: true,
            unacceptreason: true,
          })
          .describe('Synonym name usage.'),
      )
      .describe('One complete synonym page.'),
    page: pageSchema.optional().describe('Pagination only when synonym retrieval occurred.'),
    guidance: z.string().nullable().describe('Next step when no accepted taxon is known.'),
    attribution: attributionSchema,
  }),
  enrichment: {
    echo: z
      .object({ offset: z.number().describe('Requested one-based offset.') })
      .describe('Effective pagination.'),
    notice: z.string().optional().describe('Empty synonym page guidance.'),
  },
  enrichmentTrailer: {
    echo: { render: (value) => renderData(value, '$["echo"]') },
    notice: { render: (value) => renderData(value, '$["notice"]') },
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
  ],
  async handler(input, ctx) {
    using scope = new WormsScope(ctx);
    const service = getWormsService();
    const record = await service.record(input.aphiaId, scope);
    const validAphiaId =
      record?.validAphiaId ?? (record?.status === 'accepted' ? record.aphiaId : null);
    const synonyms =
      validAphiaId === null ? [] : await service.synonyms(validAphiaId, input.offset, scope);
    ctx.enrich({
      echo: { offset: input.offset },
      ...(validAphiaId !== null && synonyms.length === 0
        ? {
            notice:
              'No synonyms were returned for this page; call worms_get_synonyms with offset: 1 to inspect the first page.',
          }
        : {}),
    });
    scope.check();
    return {
      aphiaId: input.aphiaId,
      found: record !== null,
      validAphiaId,
      synonyms,
      ...(validAphiaId !== null ? { page: page(input.offset, synonyms.length) } : {}),
      guidance:
        record === null
          ? 'Call worms_resolve_taxon with a scientific name to find an AphiaID.'
          : validAphiaId === null
            ? 'Call worms_get_taxon with the original AphiaID to inspect its taxonomic status; use worms_list_reference with topic: statuses.'
            : null,
      attribution: attribution(),
    };
  },
  format: formatData,
});
