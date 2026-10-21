/**
 * @fileoverview Forward and reverse opaque external identifier crosswalks.
 * @module mcp-server/tools/definitions/crosswalk-id.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  aphiaIdSchema,
  attribution,
  attributionSchema,
  budgetPrefix,
  crosswalkFailure,
  externalTypeSchema,
  externalTypes,
  formatData,
  getWormsService,
  itemErrorSchema,
  localOffsetSchema,
  localPageFields,
  localSlice,
  optionalEvidenceTextSchema,
  renderData,
  taxonRecordSchema,
  WormsScope,
} from '../../../services/worms/index.js';

const failedTypeSchema = z
  .object({
    type: externalTypeSchema,
    error: itemErrorSchema.describe('Classified lookup failure.'),
  })
  .describe('Failed identifier system.');
const outputSchema = z.object({
  ...localPageFields,
  direction: z.enum(['forward', 'reverse']).describe('Selected crosswalk direction.'),
  aphiaId: aphiaIdSchema
    .nullable()
    .describe('Supplied or matched taxon ID; null for reverse misses.'),
  externalId: z.string().optional().describe('Opaque reverse identifier, preserved as text.'),
  type: externalTypeSchema.optional().describe('Explicitly selected identifier system.'),
  found: z.boolean().nullable().describe('Reverse match state; null in forward mode.'),
  ids: z
    .partialRecord(
      externalTypeSchema,
      z.array(z.string().describe('Opaque identifier.')).describe('IDs in upstream order.'),
    )
    .describe(
      'This segment of answered types; consult typeTotals to distinguish empty evidence from IDs on another segment.',
    ),
  typeTotals: z
    .partialRecord(
      externalTypeSchema,
      z
        .number()
        .int()
        .nonnegative()
        .describe('Complete fetched identifier count for this answered type.'),
    )
    .describe('Answered types only; zero means successful absence; failed types are omitted.'),
  failedTypes: z.array(failedTypeSchema).describe('Failed types in fixed vocabulary order.'),
  record: taxonRecordSchema.nullable().describe('Reverse matched record only.'),
  guidance: z
    .string()
    .nullable()
    .describe('Guidance when no identifiers or reverse match are found.'),
  attribution: attributionSchema,
});
export const crosswalkIdTool = tool('worms_crosswalk_id', {
  description:
    'Crosswalk an AphiaID from worms_resolve_taxon to one or all nine external identifier systems, or reverse an externalId with required type to a full taxon record. Supply exactly one selector. Forward resultOffset indexes whole identifiers across types in requested order; resume nextResultOffset with unchanged selectors. typeTotals distinguishes successful absence from IDs on another segment; failed types remain separate. IDs stay opaque, including leading zeros and LSIDs. No IDs cannot establish taxon absence; IUCN identifiers are not threat categories.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    resultOffset: localOffsetSchema.describe(
      'Zero-based forward identifier position across types in requested order; repeat unchanged selectors. Inactive for reverse lookup.',
    ),
    aphiaId: aphiaIdSchema
      .optional()
      .describe('Forward selector; mutually exclusive with externalId.'),
    externalId: optionalEvidenceTextSchema.describe(
      'Reverse selector; opaque identifier up to 512 characters; blank omitted.',
    ),
    type: z
      .preprocess(
        (value) => (typeof value === 'string' ? value.trim().toLowerCase() || undefined : value),
        externalTypeSchema.optional(),
      )
      .describe(
        'Required for reverse; omit forward to query all nine types. Codes ignore case and surrounding whitespace. See worms_list_reference external_id_types.',
      ),
  }),
  output: outputSchema,
  enrichment: {
    echo: z
      .object({
        requestedTypes: z
          .array(externalTypeSchema)
          .optional()
          .describe('Forward types in request order.'),
        type: externalTypeSchema.optional().describe('Reverse system.'),
        externalId: z.string().optional().describe('Reverse opaque identifier.'),
      })
      .describe('Effective crosswalk selectors.'),
    notice: z.string().optional().describe('Partial-outage retry guidance.'),
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
    {
      reason: 'invalid_selector',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both or neither selector supplied, or externalId is exactly "." or "..".',
      recovery:
        'Call worms_crosswalk_id with either aphiaId or externalId and type; externalId cannot be . or .. (dot-only).',
      retryable: false,
    },
    {
      reason: 'missing_external_type',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Reverse selector has no identifier type.',
      recovery:
        'Call worms_list_reference with topic: external_id_types, then worms_crosswalk_id with externalId and type.',
      retryable: false,
    },
  ],
  async handler(input, ctx) {
    using scope = new WormsScope(ctx);
    if ((input.aphiaId !== undefined) === (input.externalId !== undefined))
      throw ctx.fail('invalid_selector', 'Supply exactly one of aphiaId or externalId.');
    const service = getWormsService();
    const guidance =
      'Call worms_list_reference with topic: external_id_types to check the identifier system, or worms_resolve_taxon with a scientific name.';
    if (input.externalId !== undefined) {
      if (input.externalId === '.' || input.externalId === '..')
        throw ctx.fail('invalid_selector', 'externalId cannot be . or ..');
      if (input.type === undefined)
        throw ctx.fail('missing_external_type', 'Reverse lookup requires type.');
      const record = await service.externalRecord(input.externalId, input.type, scope);
      const enrichment = { echo: { type: input.type, externalId: input.externalId } };
      ctx.enrich(enrichment);
      scope.check();
      return budgetPrefix(
        1,
        (_take, budget) => ({
          resultOffset: input.resultOffset,
          returnedCount: record ? 1 : 0,
          totalCount: record ? 1 : 0,
          nextResultOffset: null,
          ...budget,
          direction: 'reverse' as const,
          aphiaId: record?.aphiaId ?? null,
          externalId: input.externalId,
          type: input.type,
          found: record !== null,
          ids: {},
          typeTotals: {},
          failedTypes: [],
          record,
          guidance: record === null ? guidance : null,
          attribution: attribution(),
        }),
        enrichment,
        () => scope.check(),
      );
    }
    const id = input.aphiaId;
    if (id === undefined)
      throw ctx.fail('invalid_selector', 'Supply an AphiaID for forward lookup.');
    const requestedTypes = input.type === undefined ? [...externalTypes] : [input.type];
    const settled = await Promise.allSettled(
      requestedTypes.map((type) => service.externalIds(id, type, scope)),
    );
    scope.check();
    const ids: Partial<Record<(typeof externalTypes)[number], string[]>> = {};
    const failedTypes: z.infer<typeof failedTypeSchema>[] = [];
    let firstFailure: unknown;
    for (let index = 0; index < settled.length; index++) {
      const result = settled[index];
      const type = requestedTypes[index];
      if (!result || !type) continue;
      if (result.status === 'fulfilled') ids[type] = result.value;
      else {
        firstFailure ??= result.reason;
        failedTypes.push({ type, error: scope.optionalError(result.reason) });
      }
    }
    if (failedTypes.length === requestedTypes.length) {
      if (firstFailure instanceof McpError) throw crosswalkFailure(firstFailure, failedTypes);
      throw firstFailure;
    }
    const enrichment = {
      echo: { requestedTypes },
      ...(failedTypes.length
        ? {
            notice: `Identifier lookups failed for ${failedTypes.map((entry) => entry.type).join(', ')}; call worms_crosswalk_id with one failed type to retry.`,
          }
        : {}),
    };
    ctx.enrich(enrichment);
    scope.check();
    const sequence = requestedTypes.flatMap((type) =>
      (ids[type] ?? []).map((identifier) => ({ type, identifier })),
    );
    return localSlice(
      sequence,
      input.resultOffset,
      (segment, pagination) => {
        const pagedIds = Object.fromEntries(
          Object.keys(ids).map((type) => [
            type,
            segment.filter((entry) => entry.type === type).map((entry) => entry.identifier),
          ]),
        ) as typeof ids;
        return {
          ...pagination,
          direction: 'forward' as const,
          aphiaId: id,
          ...(input.type !== undefined ? { type: input.type } : {}),
          found: null,
          ids: pagedIds,
          typeTotals: Object.fromEntries(
            Object.entries(ids).map(([type, values]) => [type, values.length]),
          ),
          failedTypes,
          record: null,
          guidance: Object.values(ids).every((values) => values.length === 0) ? guidance : null,
          attribution: attribution(),
        };
      },
      enrichment,
      () => scope.check(),
    );
  },
  format: formatData,
});
