/**
 * @fileoverview Retrieve complete distributions, optionally unioned with synonym records, and apply
 * conjunctive local filters.
 * @module mcp-server/tools/definitions/get-distributions.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  aphiaIdInputSchema,
  aphiaIdSchema,
  attribution,
  attributionSchema,
  codecTrailer,
  distributionSchema,
  formatData,
  getWormsService,
  itemErrorSchema,
  localOffsetSchema,
  localPageFields,
  localSlice,
  normalizeAphiaId,
  optionalEvidenceTextSchema,
  statusErrorSchema,
  statusNotice,
  WormsScope,
} from '../../../services/worms/index.js';

type Row = z.infer<typeof distributionSchema>;
/** Synonyms per union window; it divides the 50-row synonym page, so a window never spans two pages. */
const synonymWindow = 10;
const synonymUnionSchema = z
  .object({
    acceptedAphiaId: aphiaIdSchema
      .nullable()
      .describe(
        'Accepted taxon whose records and synonyms are combined; null when none is linked.',
      ),
    synonymOffset: z.number().int().describe('Zero-based synonym position this window starts at.'),
    synonymAphiaIds: z
      .array(aphiaIdSchema)
      .describe('Synonyms in this window, in upstream order, failed reads included.'),
    nextSynonymOffset: z
      .number()
      .int()
      .nullable()
      .describe(
        'synonymOffset for the next window once nextResultOffset is null; null when the synonym list is consumed. A window ending a full 50-row synonym page has uncertain continuation and can lead to an empty window.',
      ),
    failedSynonyms: z
      .array(
        z
          .object({
            aphiaId: aphiaIdSchema,
            error: itemErrorSchema.describe('Classified distribution-read failure.'),
          })
          .describe('Synonym whose records could not be read.'),
      )
      .describe('Failed synonym reads; their records are absent from this window.'),
  })
  .describe('Synonym union window; present only with includeSynonyms.');

/** Tag each row with the AphiaID it is attached to. */
function tagged(aphiaId: number, rows: Row[], scope: WormsScope): Row[] {
  return rows.map((row, index) => {
    if (!(index % 256)) scope.check();
    return { sourceAphiaId: aphiaId, ...row };
  });
}

/**
 * Accepted-taxon rows (window 0 only), then up to ten synonyms from the one 50-row synonym page
 * holding synonymOffset, read one at a time. A failed synonym read is recorded, never fatal; the
 * record, synonym-page, and accepted-row reads are required.
 */
async function unionWindow(aphiaId: number, synonymOffset: number, scope: WormsScope) {
  const service = getWormsService();
  const record = await service.record(aphiaId, scope);
  const acceptedAphiaId =
    record?.validAphiaId ?? (record?.status === 'accepted' ? record.aphiaId : null);
  if (acceptedAphiaId === null)
    return {
      rows: synonymOffset
        ? []
        : tagged(aphiaId, await service.distributions(aphiaId, scope), scope),
      synonymUnion: {
        acceptedAphiaId,
        synonymOffset,
        synonymAphiaIds: [],
        nextSynonymOffset: null,
        failedSynonyms: [],
      },
      statusFragment: `WoRMS links no accepted taxon to AphiaID ${aphiaId}, so these are its own rows and no synonyms were read; call worms_get_taxon with aphiaIds: [${aphiaId}] to inspect its status.`,
    };
  const start = synonymOffset % 50;
  const synonymPage = await service.synonyms(acceptedAphiaId, synonymOffset - start + 1, scope);
  const window = synonymPage.slice(start, start + synonymWindow);
  let rows = synonymOffset
    ? []
    : tagged(acceptedAphiaId, await service.distributions(acceptedAphiaId, scope), scope);
  const failedSynonyms: { aphiaId: number; error: z.infer<typeof itemErrorSchema> }[] = [];
  for (const synonym of window) {
    try {
      rows = rows.concat(
        tagged(synonym.aphiaId, await service.distributions(synonym.aphiaId, scope), scope),
      );
    } catch (error) {
      failedSynonyms.push({ aphiaId: synonym.aphiaId, error: scope.optionalError(error) });
    }
  }
  const pageExhausted = start + window.length >= synonymPage.length && synonymPage.length < 50;
  return {
    rows,
    synonymUnion: {
      acceptedAphiaId,
      synonymOffset,
      synonymAphiaIds: window.map((synonym) => synonym.aphiaId),
      nextSynonymOffset: pageExhausted ? null : synonymOffset + window.length,
      failedSynonyms,
    },
    statusFragment:
      acceptedAphiaId === aphiaId
        ? undefined
        : record?.status === 'alternative representation'
          ? `AphiaID ${aphiaId} is an accepted alternative representation; these rows combine preferred AphiaID ${acceptedAphiaId} and its synonyms.`
          : `AphiaID ${aphiaId} is not the accepted name; these rows combine accepted AphiaID ${acceptedAphiaId} and its synonyms.`,
  };
}

const filtersSchema = z.object({
  recordStatus: z
    .preprocess(
      (value) => (typeof value === 'string' ? value.trim().toLowerCase() || undefined : value),
      z.enum(['valid', 'doubtful', 'inaccurate']).optional(),
    )
    .describe(
      'Record status valid, doubtful, or inaccurate; ignores case and surrounding whitespace; blank means no filter.',
    ),
  establishmentMeans: optionalEvidenceTextSchema.describe(
    'Case-insensitive whole-value establishment filter, such as Alien; blank omitted. Observed values: worms_list_reference topic: distribution_terms.',
  ),
  invasiveness: optionalEvidenceTextSchema.describe(
    'Case-insensitive whole-value invasiveness filter, such as Invasive; blank omitted. Observed values: worms_list_reference topic: distribution_terms.',
  ),
  occurrence: optionalEvidenceTextSchema.describe(
    'Case-insensitive whole-value occurrence filter, such as Established; blank omitted. Observed values: worms_list_reference topic: distribution_terms.',
  ),
});
export const getDistributionsTool = tool('worms_get_distributions', {
  description:
    "Retrieve recorded distributions for an AphiaID or canonical WoRMS LSID in byte-budgeted segments; resume nextResultOffset as resultOffset with unchanged selectors and filters. WoRMS attaches records to individual name usages, so one AphiaID's rows can miss those of its synonyms: includeSynonyms combines the accepted taxon's rows with those of up to 10 synonyms per call, each row tagged sourceAphiaId; consume nextResultOffset before advancing synonymOffset to synonymUnion.nextSynonymOffset with resultOffset 0. Filters apply to the complete fetched set before pagination and combine by conjunction: recordStatus normalizes case and surrounding whitespace before exact matching; others use case-insensitive whole-value equality without trimming. Rows retain duplicates and source order; no rows does not prove biological or taxon absence. A notice names the linked accepted ID, distinguishing an accepted alternative representation from its preferred ID.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: filtersSchema.extend({
    aphiaId: aphiaIdInputSchema,
    resultOffset: localOffsetSchema,
    includeSynonyms: z
      .boolean()
      .default(false)
      .describe(
        "Combine the accepted taxon's records with its synonyms', 10 synonyms per call; rows then carry sourceAphiaId.",
      ),
    synonymOffset: localOffsetSchema.describe(
      'Zero-based synonym position; once nextResultOffset is null, resubmit synonymUnion.nextSynonymOffset here with resultOffset 0. Inactive without includeSynonyms.',
    ),
  }),
  output: z.object({
    ...localPageFields,
    aphiaId: aphiaIdSchema,
    unfilteredCount: z
      .number()
      .int()
      .describe('All recorded rows before filtering; with includeSynonyms, those of this window.'),
    filteredCount: z.number().int().describe('Rows passing every effective filter.'),
    distributions: z
      .array(distributionSchema)
      .describe('Whole matching rows in this segment, in source order.'),
    synonymUnion: synonymUnionSchema.optional(),
    statusError: statusErrorSchema,
    attribution: attributionSchema,
  }),
  enrichment: {
    echo: filtersSchema.describe(
      'Only effective filters; recordStatus is canonical lowercase, other populated values are unchanged.',
    ),
    notice: z
      .string()
      .optional()
      .describe('Linked accepted/preferred-AphiaID and empty-evidence guidance, in that order.'),
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
    let rows: Row[];
    let synonymUnion: z.infer<typeof synonymUnionSchema> | undefined;
    let statusError: z.infer<typeof itemErrorSchema> | undefined;
    let statusFragment: string | undefined;
    if (input.includeSynonyms) {
      ({ rows, synonymUnion, statusFragment } = await unionWindow(
        input.aphiaId,
        input.synonymOffset,
        scope,
      ));
    } else {
      const service = getWormsService();
      const status = await service.status(input.aphiaId, scope);
      statusError = status.statusError;
      rows = await service.distributions(input.aphiaId, scope);
      statusFragment = statusNotice(
        input.aphiaId,
        status.record,
        (valid) =>
          `Call worms_get_distributions with aphiaId: ${valid}, or with includeSynonyms: true to combine the accepted taxon's records with its synonyms'.`,
      );
    }
    const echo = {
      ...(input.recordStatus !== undefined ? { recordStatus: input.recordStatus } : {}),
      ...(input.establishmentMeans !== undefined
        ? { establishmentMeans: input.establishmentMeans }
        : {}),
      ...(input.invasiveness !== undefined ? { invasiveness: input.invasiveness } : {}),
      ...(input.occurrence !== undefined ? { occurrence: input.occurrence } : {}),
    };
    const textFilters = (['establishmentMeans', 'invasiveness', 'occurrence'] as const).filter(
      (key) => input[key] !== undefined,
    );
    const distributions = rows.filter((row, index) => {
      if (!(index % 256)) scope.check();
      return (
        (input.recordStatus === undefined || row.recordStatus === input.recordStatus) &&
        textFilters.every(
          (key) =>
            typeof row[key] === 'string' && row[key].toLowerCase() === input[key]?.toLowerCase(),
        )
      );
    });
    /** Without fetched rows, dropping filters returns the same empty set, so only the ID check remains. */
    const notice = [
      statusFragment,
      distributions.length !== 0
        ? undefined
        : rows.length > 0
          ? 'Call worms_get_distributions without filters to inspect recorded distributions, or worms_get_taxon to check the AphiaID.'
          : 'Call worms_get_taxon to check the AphiaID.',
      distributions.length === 0 && rows.length > 0 && textFilters.length > 0
        ? 'Call worms_list_reference with topic: distribution_terms for observed filter values.'
        : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    const enrichment = { echo, ...(notice ? { notice } : {}) };
    ctx.enrich(enrichment);
    scope.check();
    return localSlice(
      distributions,
      input.resultOffset,
      (segment, pagination) => ({
        aphiaId: input.aphiaId,
        unfilteredCount: rows.length,
        filteredCount: distributions.length,
        distributions: segment,
        ...(synonymUnion ? { synonymUnion } : {}),
        ...(statusError ? { statusError } : {}),
        ...pagination,
        attribution: attribution(),
      }),
      enrichment,
      () => scope.check(),
    );
  },
  format: formatData,
});
