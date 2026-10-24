/**
 * @fileoverview Resolve accepted taxon and retrieve one complete synonym page.
 * @module mcp-server/tools/definitions/get-synonyms.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  aphiaIdInputSchema,
  aphiaIdSchema,
  attribution,
  attributionSchema,
  codecTrailer,
  formatData,
  getWormsService,
  localOffsetSchema,
  localPageFields,
  localSlice,
  normalizeAphiaId,
  offsetSchema,
  page,
  pageSchema,
  segmentPage,
  synonymSchema,
  WormsScope,
} from '../../../services/worms/index.js';
export const getSynonymsTool = tool('worms_get_synonyms', {
  description:
    'Retrieve synonyms for the accepted taxon linked from an AphiaID obtained with worms_resolve_taxon. Consume nextResultOffset within the same upstream offset before advancing page.nextOffset and resetting resultOffset to zero. A present name without an accepted ID has no synonym lookup; inspect it with worms_get_taxon. A full fetched 50-row page has uncertain continuation and may lead to an empty page.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    aphiaId: aphiaIdInputSchema,
    offset: offsetSchema,
    resultOffset: localOffsetSchema,
  }),
  output: z.object({
    ...localPageFields,
    aphiaId: aphiaIdSchema,
    found: z.boolean().describe('Whether the supplied taxon exists.'),
    validAphiaId: aphiaIdSchema.nullable().describe('Accepted taxon ID when known.'),
    synonyms: z.array(synonymSchema).describe('Whole synonym rows in this byte-budgeted segment.'),
    page: pageSchema.optional().describe('Pagination only when synonym retrieval occurred.'),
    guidance: z.string().nullable().describe('Next step when no accepted taxon is known.'),
    attribution: attributionSchema,
  }),
  enrichment: {
    echo: z
      .object({ offset: z.number().describe('Requested one-based offset.') })
      .describe('Effective pagination.'),
    notice: z.string().optional().describe('Guidance for an empty synonym page past the first.'),
  },
  enrichmentTrailer: codecTrailer('echo', 'notice'),
  errors: [
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'HTTP 400/422 rejected the inputs.',
      recovery:
        'Resolve the scientific name with worms_resolve_taxon for a valid AphiaID, then retry the same tool.',
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
      recovery: 'Retry the same tool later; use worms_get_taxon to verify a known AphiaID.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'response_too_large',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Upstream response exceeds 8 MiB.',
      recovery:
        'Call worms_get_taxon for the taxon record; this tool cannot return the oversized WoRMS response.',
      retryable: false,
      thrownBy: 'service',
    },
  ],
  async handler(raw, ctx) {
    const input = { ...raw, aphiaId: normalizeAphiaId(raw.aphiaId) };
    using scope = new WormsScope(ctx);
    const service = getWormsService();
    const record = await service.record(input.aphiaId, scope);
    const validAphiaId =
      record?.validAphiaId ?? (record?.status === 'accepted' ? record.aphiaId : null);
    const synonyms =
      validAphiaId === null ? [] : await service.synonyms(validAphiaId, input.offset, scope);
    const enrichment = {
      echo: { offset: input.offset },
      ...(validAphiaId !== null && synonyms.length === 0 && input.offset > 1
        ? {
            notice:
              'No synonyms were returned for this page; call worms_get_synonyms with offset: 1 to inspect the first page.',
          }
        : {}),
    };
    ctx.enrich(enrichment);
    scope.check();
    return localSlice(
      synonyms,
      input.resultOffset,
      (segment, pagination) => ({
        aphiaId: input.aphiaId,
        found: record !== null,
        validAphiaId,
        synonyms: segment,
        ...pagination,
        ...(validAphiaId !== null
          ? {
              page: segmentPage(
                page(input.offset, synonyms.length),
                segment.length,
                pagination.nextResultOffset === null,
              ),
            }
          : {}),
        guidance:
          record === null
            ? 'Call worms_resolve_taxon with a scientific name to find an AphiaID.'
            : validAphiaId === null
              ? 'Call worms_get_taxon with the original AphiaID to inspect its taxonomic status; use worms_list_reference with topic: statuses.'
              : null,
        attribution: attribution(),
      }),
      enrichment,
      () => scope.check(),
    );
  },
  format: formatData,
});
