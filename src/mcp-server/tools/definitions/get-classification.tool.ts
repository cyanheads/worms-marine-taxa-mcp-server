/**
 * @fileoverview Retrieve full root-to-tip classification and optional children.
 * @module mcp-server/tools/definitions/get-classification.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  aphiaIdSchema,
  attribution,
  attributionSchema,
  childSchema,
  formatData,
  getWormsService,
  itemErrorSchema,
  offsetSchema,
  page,
  pageSchema,
  rankNodeSchema,
  renderData,
  WormsScope,
} from '@/services/worms/index.js';

const outputSchema = z.object({
  aphiaId: aphiaIdSchema,
  found: z.boolean().describe('Whether classification exists.'),
  ranks: z.array(rankNodeSchema).describe('Complete root-to-tip lineage.'),
  children: z
    .array(childSchema)
    .optional()
    .describe('One page of direct children when requested and retrieved.'),
  page: pageSchema.optional().describe('Children pagination only.'),
  childrenError: itemErrorSchema.optional().describe('Optional children retrieval failure.'),
  guidance: z.string().nullable().describe('Next step for absent classification.'),
  attribution: attributionSchema,
});
export const getClassificationTool = tool('worms_get_classification', {
  description:
    'Retrieve the complete root-to-tip classification for an AphiaID from worms_resolve_taxon, retaining missing ranks as unknown. Optionally retrieve one page of direct children; offset and marine/extant filters are inactive unless includeChildren is true. A full 50-row page has uncertain continuation, and nextOffset can return an empty page.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    aphiaId: aphiaIdSchema,
    includeChildren: z.boolean().default(false).describe('Also fetch one page of direct children.'),
    offset: offsetSchema,
    marineOnly: z
      .boolean()
      .default(true)
      .describe('Marine children only; inactive without includeChildren.'),
    extantOnly: z
      .boolean()
      .default(true)
      .describe('Extant children only; inactive without includeChildren.'),
  }),
  output: outputSchema,
  enrichment: {
    notice: z.string().optional().describe('Guidance for an empty children page.'),
    echo: z
      .object({
        includeChildren: z.boolean().describe('Whether children requested.'),
        marineOnly: z.boolean().describe('Child marine filter.'),
        extantOnly: z.boolean().describe('Child extant filter.'),
        offset: z.number().describe('Child starting offset.'),
      })
      .describe('Effective options; child-only options inactive when includeChildren is false.'),
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
  ],
  async handler(input, ctx) {
    using scope = new WormsScope(ctx);
    const service = getWormsService();
    const ranks = await service.classification(input.aphiaId, scope);
    const result: z.infer<typeof outputSchema> = {
      aphiaId: input.aphiaId,
      found: ranks !== null,
      ranks: ranks ?? [],
      guidance:
        ranks === null
          ? 'Call worms_resolve_taxon with a scientific name to find an AphiaID.'
          : null,
      attribution: attribution(),
    };
    if (ranks !== null && input.includeChildren) {
      try {
        result.children = await service.children(
          input.aphiaId,
          input.offset,
          input.marineOnly,
          input.extantOnly,
          scope,
        );
        result.page = page(input.offset, result.children.length);
      } catch (error) {
        result.childrenError = scope.optionalError(error);
      }
    }
    ctx.enrich({
      echo: {
        includeChildren: input.includeChildren,
        marineOnly: input.marineOnly,
        extantOnly: input.extantOnly,
        offset: input.offset,
      },
      ...(result.children?.length === 0
        ? {
            notice:
              'Call worms_get_classification with offset: 1 to return to the first children page; use worms_list_reference with topic: ranks to inspect rank vocabulary.',
          }
        : {}),
    });
    scope.check();
    return result;
  },
  format: formatData,
});
