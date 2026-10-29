/**
 * @fileoverview Retrieve full root-to-tip classification and optional children.
 * @module mcp-server/tools/definitions/get-classification.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  aphiaIdInputSchema,
  aphiaIdSchema,
  attribution,
  attributionSchema,
  childSchema,
  codecTrailer,
  formatData,
  getWormsService,
  itemErrorSchema,
  localOffsetSchema,
  localPageFields,
  localSlice,
  normalizeAphiaId,
  offsetSchema,
  page,
  pageSchema,
  rankNodeSchema,
  segmentPage,
  statusErrorSchema,
  statusNotice,
  WormsScope,
} from '../../../services/worms/index.js';

const outputSchema = z.object({
  ...localPageFields,
  aphiaId: aphiaIdSchema,
  found: z.boolean().describe('Whether classification exists.'),
  ranks: z.array(rankNodeSchema).describe('This segment of the root-to-tip lineage.'),
  children: z
    .array(childSchema)
    .optional()
    .describe('One page of direct children when requested and retrieved.'),
  page: pageSchema.optional().describe('Children pagination only.'),
  childrenError: itemErrorSchema.optional().describe('Optional children retrieval failure.'),
  statusError: statusErrorSchema,
  guidance: z.string().nullable().describe('Next step for absent classification.'),
  attribution: attributionSchema,
});
export const getClassificationTool = tool('worms_get_classification', {
  description:
    'Retrieve root-to-tip classification and optional direct children for an AphiaID or canonical WoRMS LSID. resultOffset indexes lineage followed by fetched children; consume nextResultOffset with unchanged options and upstream offset before advancing page.nextOffset and resetting resultOffset to zero. Missing ranks remain unknown; child offset and filters are inactive without includeChildren. A full fetched 50-row child page has uncertain continuation and can lead to an empty page. The submitted ID keeps its own recorded lineage; a notice names its linked accepted ID, distinguishing an accepted alternative representation from its preferred ID.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    resultOffset: localOffsetSchema.describe(
      'Zero-based position in lineage followed by fetched children; keep upstream offset unchanged until nextResultOffset is null.',
    ),
    aphiaId: aphiaIdInputSchema,
    includeChildren: z.boolean().default(false).describe('Also fetch one page of direct children.'),
    offset: offsetSchema,
    marineOnly: z
      .boolean()
      .default(true)
      .describe('Marine or brackish children only; inactive without includeChildren.'),
    extantOnly: z
      .boolean()
      .default(true)
      .describe('Extant children only; inactive without includeChildren.'),
  }),
  output: outputSchema,
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Linked accepted/preferred-AphiaID and empty-children-page guidance, in that order.',
      ),
    echo: z
      .object({
        includeChildren: z.boolean().describe('Whether children requested.'),
        marineOnly: z.boolean().describe('Child marine filter.'),
        extantOnly: z.boolean().describe('Child extant filter.'),
        offset: z.number().describe('Child starting offset.'),
      })
      .describe('Effective options; child-only options inactive when includeChildren is false.'),
  },
  enrichmentTrailer: codecTrailer('notice', 'echo'),
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
    const { record, statusError } = await service.status(input.aphiaId, scope);
    const ranks = await service.classification(input.aphiaId, scope);
    const result: Omit<z.infer<typeof outputSchema>, keyof typeof localPageFields> = {
      aphiaId: input.aphiaId,
      found: ranks !== null,
      ranks: ranks ?? [],
      ...(statusError ? { statusError } : {}),
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
    const notice = [
      statusNotice(
        input.aphiaId,
        record,
        (valid) =>
          `This is the lineage WoRMS records for AphiaID ${input.aphiaId}; call worms_get_classification with aphiaId: ${valid} for the accepted lineage.`,
      ),
      result.children?.length !== 0
        ? undefined
        : input.offset > 1
          ? 'Call worms_get_classification with offset: 1 to return to the first children page; use worms_list_reference with topic: ranks to inspect rank vocabulary.'
          : 'Use worms_list_reference with topic: ranks to inspect rank vocabulary.',
    ]
      .filter(Boolean)
      .join(' ');
    const enrichment = {
      echo: {
        includeChildren: input.includeChildren,
        marineOnly: input.marineOnly,
        extantOnly: input.extantOnly,
        offset: input.offset,
      },
      ...(notice ? { notice } : {}),
    };
    ctx.enrich(enrichment);
    scope.check();
    const sequence = [
      ...result.ranks.map((row) => ({ kind: 'rank' as const, row })),
      ...(result.children ?? []).map((row) => ({ kind: 'child' as const, row })),
    ];
    return localSlice(
      sequence,
      input.resultOffset,
      (segment, pagination) => {
        const children = segment
          .filter((entry) => entry.kind === 'child')
          .map((entry) => entry.row);
        return {
          ...result,
          ...pagination,
          ranks: segment.filter((entry) => entry.kind === 'rank').map((entry) => entry.row),
          ...(result.children !== undefined ? { children } : {}),
          ...(result.page
            ? {
                page: segmentPage(
                  result.page,
                  children.length,
                  pagination.nextResultOffset === null,
                ),
              }
            : {}),
        };
      },
      enrichment,
      () => scope.check(),
    );
  },
  format: formatData,
});
