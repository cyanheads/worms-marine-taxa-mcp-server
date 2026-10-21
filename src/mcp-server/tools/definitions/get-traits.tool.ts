/**
 * @fileoverview Retrieve sparse trait evidence with complete tree topology.
 * @module mcp-server/tools/definitions/get-traits.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  aphiaIdSchema,
  attribution,
  attributionSchema,
  formatData,
  getWormsService,
  localOffsetSchema,
  localPageFields,
  localSlice,
  renderData,
  traitSchema,
  WormsScope,
} from '../../../services/worms/index.js';
export const getTraitsTool = tool('worms_get_traits', {
  description:
    'Retrieve recorded attributes for an AphiaID from worms_resolve_taxon, including inherited attributes by default. Resume nextResultOffset as resultOffset with unchanged selectors and options. Whole rows retain original preorder nodeIndex and parentIndex across pages; parents may be on earlier pages. Values, references and inheritance markers remain unchanged. Missing traits do not prove biological absence; IUCN list membership is not a threat category.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    resultOffset: localOffsetSchema,
    aphiaId: aphiaIdSchema,
    includeInherited: z
      .boolean()
      .default(true)
      .describe('Include attributes inherited from higher taxa; default true.'),
  }),
  output: z.object({
    ...localPageFields,
    aphiaId: aphiaIdSchema,
    traits: z
      .array(traitSchema)
      .describe('This preorder segment; indices refer to the complete original tree.'),
    attribution: attributionSchema,
  }),
  enrichment: {
    echo: z
      .object({ includeInherited: z.boolean().describe('Effective inheritance option.') })
      .describe('Effective options.'),
    notice: z.string().optional().describe('Guidance for absent recorded attributes.'),
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
    const traits = await getWormsService().traits(input.aphiaId, input.includeInherited, scope);
    const enrichment = {
      echo: { includeInherited: input.includeInherited },
      ...(traits.length === 0
        ? {
            notice: input.includeInherited
              ? 'No attributes were returned with inheritance enabled; call worms_list_reference with topic: trait_types to inspect definitions.'
              : 'Call worms_get_traits with includeInherited: true to include higher-rank attributes; call worms_list_reference with topic: trait_types to inspect definitions.',
          }
        : {}),
    };
    ctx.enrich(enrichment);
    scope.check();
    return localSlice(
      traits,
      input.resultOffset,
      (segment, pagination) => ({
        aphiaId: input.aphiaId,
        traits: segment,
        attribution: attribution(),
        ...pagination,
      }),
      enrichment,
      () => scope.check(),
    );
  },
  format: formatData,
});
