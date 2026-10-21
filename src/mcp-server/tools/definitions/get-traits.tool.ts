/**
 * @fileoverview Retrieve sparse trait evidence with complete tree topology, optionally narrowed to
 * one measurement type with its subtrees and ancestors.
 * @module mcp-server/tools/definitions/get-traits.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  aphiaIdSchema,
  attribution,
  attributionSchema,
  codecTrailer,
  formatData,
  getWormsService,
  localOffsetSchema,
  localPageFields,
  localSlice,
  optionalEvidenceTextSchema,
  statusErrorSchema,
  statusNotice,
  traitSchema,
  WormsScope,
} from '../../../services/worms/index.js';

type Trait = z.infer<typeof traitSchema>;
/**
 * Nodes whose measurementType equals `type` case-insensitively, each with its whole subtree and its
 * ancestor chain, once each in preorder. Preorder puts a parent before its children, so one forward
 * pass marks subtrees; an ancestor walk stops at the first node already kept.
 */
function selectType(tree: Trait[], type: string, scope: WormsScope): Trait[] {
  const wanted = type.toLowerCase();
  const inMatch = new Uint8Array(tree.length);
  const kept = new Uint8Array(tree.length);
  for (const [index, node] of tree.entries()) {
    if (!(index % 256)) scope.check();
    const matched = node.measurementType?.toLowerCase() === wanted;
    if (!matched && (node.parentIndex === null || !inMatch[node.parentIndex])) continue;
    inMatch[index] = 1;
    kept[index] = 1;
    if (matched)
      for (let at = node.parentIndex; at !== null && !kept[at]; at = tree[at]?.parentIndex ?? null)
        kept[at] = 1;
  }
  return tree.filter((_, index) => kept[index]);
}

export const getTraitsTool = tool('worms_get_traits', {
  description:
    'Retrieve recorded attributes for an AphiaID from worms_resolve_taxon, including inherited attributes by default. Resume nextResultOffset as resultOffset with unchanged selectors and options. Whole rows retain original preorder nodeIndex and parentIndex across pages; parents may be on earlier pages. measurementType keeps each matching node with its subtree and ancestors, indices unchanged; totalCount counts that set and unfilteredCount the whole tree. Values, references and inheritance markers remain unchanged; on an accepted taxon WoRMS also returns attributes recorded on its synonyms whatever includeInherited is set to, marked by inheritedFrom. A notice flags an AphiaID that is not the accepted name. Missing traits do not prove biological absence; IUCN list membership is not a threat category.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    resultOffset: localOffsetSchema,
    aphiaId: aphiaIdSchema,
    includeInherited: z
      .boolean()
      .default(true)
      .describe('Include attributes inherited from higher taxa; default true.'),
    measurementType: optionalEvidenceTextSchema.describe(
      'Case-insensitive whole-value measurement type, not trimmed, e.g. Body size; blank means no filter. Names come from worms_list_reference with topic: trait_types.',
    ),
  }),
  output: z.object({
    ...localPageFields,
    aphiaId: aphiaIdSchema,
    unfilteredCount: z
      .number()
      .int()
      .describe('Nodes in the complete tree before the measurementType filter.'),
    traits: z
      .array(traitSchema)
      .describe('This preorder segment; indices refer to the complete original tree.'),
    statusError: statusErrorSchema,
    attribution: attributionSchema,
  }),
  enrichment: {
    echo: z
      .object({
        includeInherited: z.boolean().describe('Effective inheritance option.'),
        measurementType: z
          .string()
          .optional()
          .describe('Effective measurementType filter with its original value.'),
      })
      .describe('Effective options.'),
    notice: z
      .string()
      .optional()
      .describe('Unaccepted-AphiaID and absent-attribute guidance, in that order.'),
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
  async handler(input, ctx) {
    using scope = new WormsScope(ctx);
    const service = getWormsService();
    const { record, statusError } = await service.status(input.aphiaId, scope);
    const tree = await service.traits(input.aphiaId, input.includeInherited, scope);
    const traits =
      input.measurementType === undefined ? tree : selectType(tree, input.measurementType, scope);
    const notice = [
      statusNotice(
        input.aphiaId,
        record,
        (valid) =>
          `Call worms_get_traits with aphiaId: ${valid} for the accepted taxon's attributes.`,
      ),
      tree.length === 0
        ? input.includeInherited
          ? 'No attributes were returned with inheritance enabled; call worms_list_reference with topic: trait_types to inspect definitions.'
          : 'Call worms_get_traits with includeInherited: true to include higher-rank attributes; call worms_list_reference with topic: trait_types to inspect definitions.'
        : traits.length === 0
          ? 'No attribute matched measurementType; call worms_get_traits without measurementType to list every recorded attribute, or worms_list_reference with topic: trait_types to inspect type names.'
          : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    const enrichment = {
      echo: {
        includeInherited: input.includeInherited,
        ...(input.measurementType !== undefined ? { measurementType: input.measurementType } : {}),
      },
      ...(notice ? { notice } : {}),
    };
    ctx.enrich(enrichment);
    scope.check();
    return localSlice(
      traits,
      input.resultOffset,
      (segment, pagination) => ({
        aphiaId: input.aphiaId,
        unfilteredCount: tree.length,
        traits: segment,
        ...(statusError ? { statusError } : {}),
        attribution: attribution(),
        ...pagination,
      }),
      enrichment,
      () => scope.check(),
    );
  },
  format: formatData,
});
