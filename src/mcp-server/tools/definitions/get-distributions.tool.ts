/**
 * @fileoverview Retrieve complete distributions and apply conjunctive local filters.
 * @module mcp-server/tools/definitions/get-distributions.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  aphiaIdSchema,
  attribution,
  attributionSchema,
  distributionSchema,
  formatData,
  getWormsService,
  optionalEvidenceTextSchema,
  renderData,
  WormsScope,
} from '@/services/worms/index.js';

const filtersSchema = z.object({
  recordStatus: z
    .preprocess(
      (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
      z.enum(['valid', 'doubtful', 'inaccurate']).optional(),
    )
    .describe('Exact record status; blank means no filter.'),
  establishmentMeans: optionalEvidenceTextSchema.describe(
    'Case-insensitive whole-value establishment filter; blank omitted.',
  ),
  invasiveness: optionalEvidenceTextSchema.describe(
    'Case-insensitive whole-value invasiveness filter; blank omitted.',
  ),
  occurrence: optionalEvidenceTextSchema.describe(
    'Case-insensitive whole-value occurrence filter; blank omitted.',
  ),
});
export const getDistributionsTool = tool('worms_get_distributions', {
  description:
    'Retrieve all recorded distributions for an AphiaID from worms_resolve_taxon. Optional local filters combine by conjunction: recordStatus is exact, other filters use case-insensitive whole-value equality. Results retain duplicates and source order; no rows does not prove biological absence or taxon absence.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: filtersSchema.extend({ aphiaId: aphiaIdSchema }),
  output: z.object({
    aphiaId: aphiaIdSchema,
    unfilteredCount: z.number().int().describe('All recorded rows before filtering.'),
    filteredCount: z.number().int().describe('Rows passing every effective filter.'),
    distributions: z.array(distributionSchema).describe('Complete matching rows in source order.'),
    attribution: attributionSchema,
  }),
  enrichment: {
    echo: filtersSchema.describe('Only effective filters with original values.'),
    notice: z.string().optional().describe('Empty evidence guidance.'),
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
    const rows = await getWormsService().distributions(input.aphiaId, scope);
    const echo = {
      ...(input.recordStatus !== undefined ? { recordStatus: input.recordStatus } : {}),
      ...(input.establishmentMeans !== undefined
        ? { establishmentMeans: input.establishmentMeans }
        : {}),
      ...(input.invasiveness !== undefined ? { invasiveness: input.invasiveness } : {}),
      ...(input.occurrence !== undefined ? { occurrence: input.occurrence } : {}),
    };
    const distributions = rows.filter((row, index) => {
      if (!(index % 256)) scope.check();
      return (
        (input.recordStatus === undefined || row.recordStatus === input.recordStatus) &&
        (['establishmentMeans', 'invasiveness', 'occurrence'] as const).every(
          (key) =>
            input[key] === undefined ||
            (typeof row[key] === 'string' && row[key].toLowerCase() === input[key].toLowerCase()),
        )
      );
    });
    ctx.enrich({
      echo,
      ...(distributions.length === 0
        ? {
            notice:
              'Call worms_get_distributions without filters to inspect recorded distributions, or worms_get_taxon to check the AphiaID.',
          }
        : {}),
    });
    scope.check();
    return {
      aphiaId: input.aphiaId,
      unfilteredCount: rows.length,
      filteredCount: distributions.length,
      distributions,
      attribution: attribution(),
    };
  },
  format: formatData,
});
