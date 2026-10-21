/**
 * @fileoverview Static vocabulary and live rank/trait-key references.
 * @module mcp-server/tools/definitions/list-reference.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  attribution,
  attributionSchema,
  formatData,
  getWormsService,
  renderData,
  WormsScope,
} from '@/services/worms/index.js';

const topics = [
  'external_id_types',
  'statuses',
  'environment_flags',
  'ranks',
  'trait_types',
] as const;
const sparseText = z.string().nullable().optional();
const sparseId = z.number().int().nullable().optional();
const attributeId = z
  .union([
    z.number().int().describe('Integer identifier.'),
    z.string().regex(/^\d+$/).describe('Numeric string identifier preserved verbatim.'),
    z.null().describe('Unknown identifier.'),
  ])
  .optional();
const entrySchema = z
  .union([
    z
      .strictObject({
        code: z.string().describe('External identifier code.'),
        label: z.string().describe('System name.'),
        description: z.string().describe('Identifier semantics.'),
      })
      .describe('External identifier vocabulary entry.'),
    z
      .object({
        value: z.string().describe('Observed status value.'),
        description: z.string().describe('Non-exhaustive status guide.'),
      })
      .describe('Non-exhaustive status vocabulary entry.'),
    z
      .object({
        field: z.string().describe('Environment flag.'),
        description: z.string().describe('Flag semantics.'),
        upstreamValues: z
          .tuple([z.literal(0), z.literal(1), z.null()])
          .describe('Known upstream values.'),
        interpretation: z
          .object({
            zero: z.string().describe('Meaning of zero.'),
            one: z.string().describe('Meaning of one.'),
            null: z.string().describe('Meaning of null.'),
          })
          .describe('Tri-state interpretation.'),
      })
      .describe('Environment flag vocabulary entry.'),
    z
      .strictObject({
        taxonRankId: sparseId.describe('Rank identifier.'),
        taxonRank: sparseText.describe('Rank name.'),
        kingdomAphiaId: sparseId.describe('Kingdom identifier.'),
        kingdom: sparseText.describe('Kingdom name.'),
      })
      .describe('Live rank vocabulary entry.'),
    z
      .object({
        nodeIndex: z.number().int().describe('Preorder node index.'),
        parentIndex: z.number().int().nullable().describe('Parent index, null at roots.'),
        depth: z.number().int().describe('Tree depth.'),
        measurementTypeId: attributeId.describe('Measurement type identifier.'),
        measurementType: sparseText.describe('Measurement description.'),
        inputId: attributeId.describe('Input data type identifier.'),
        categoryId: attributeId.describe('Attribute category identifier.'),
      })
      .describe('Live trait-key vocabulary entry.'),
  ])
  .describe('Topic-specific reference entry.');
const externalTypes = [
  ['algaebase', 'AlgaeBase', 'AlgaeBase taxon identifier.'],
  ['bold', 'BOLD', 'Barcode of Life Data System identifier.'],
  ['dyntaxa', 'Dyntaxa', 'Swedish taxonomic database identifier.'],
  ['fishbase', 'FishBase', 'FishBase species identifier.'],
  ['iucn', 'IUCN', 'IUCN identifier; not a Red List assessment or threat category.'],
  ['lsid', 'LSID', 'Complete Life Science Identifier.'],
  ['ncbi', 'NCBI', 'NCBI taxonomy identifier.'],
  ['tsn', 'ITIS TSN', 'Integrated Taxonomic Information System serial number.'],
  ['gisd', 'GISD', 'Global Invasive Species Database identifier.'],
] as const;
export const listReferenceTool = tool('worms_list_reference', {
  description:
    'List supported external identifier systems, a non-exhaustive taxonomic-status guide, environment-flag semantics, live taxonomic ranks, or live trait definitions. Static topics require no upstream request. IUCN identifiers are not threat categories; null flags mean not recorded. Trait definitions retain complete tree topology.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    topic: z
      .enum(topics)
      .describe(
        'Reference topic: external_id_types, statuses, environment_flags, ranks, or trait_types.',
      ),
  }),
  output: z.object({
    topic: z.enum(topics).describe('Requested reference topic.'),
    entries: z
      .array(entrySchema)
      .describe('Complete reference entries with topic-specific fields.'),
    attribution: attributionSchema,
  }),
  enrichment: { notice: z.string().optional().describe('Guidance for empty live references.') },
  enrichmentTrailer: { notice: { render: (value) => renderData(value, '$["notice"]') } },
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
    let entries: z.infer<typeof entrySchema>[];
    switch (input.topic) {
      case 'external_id_types':
        entries = externalTypes.map(([code, label, description]) => ({ code, label, description }));
        break;
      case 'statuses':
        entries = [
          {
            value: 'accepted',
            description: 'Accepted taxon name; this status guide is non-exhaustive.',
          },
          {
            value: 'unaccepted',
            description: 'Unaccepted name; inspect unacceptreason and validAphiaId.',
          },
          {
            value: 'quarantined',
            description: 'Technical status; inspect the taxon record for available details.',
          },
          {
            value: 'deleted',
            description: 'Technical status; inspect the taxon record for available details.',
          },
        ];
        break;
      case 'environment_flags':
        entries = ['isMarine', 'isBrackish', 'isFreshwater', 'isTerrestrial', 'isExtinct'].map(
          (field) => ({
            field,
            description:
              field === 'isExtinct' ? 'Recorded extinction flag.' : 'Recorded environment flag.',
            upstreamValues: [0, 1, null] as [0, 1, null],
            interpretation: {
              zero: 'False.',
              one: 'True.',
              null: 'Not recorded; unknown, not false.',
            },
          }),
        );
        break;
      case 'ranks':
        entries = await getWormsService().ranks(scope);
        break;
      case 'trait_types':
        entries = await getWormsService().attributeKeys(scope);
        break;
    }
    if (entries.length === 0)
      ctx.enrich({
        notice:
          'Call worms_list_reference with the same topic later; use worms_get_traits for recorded taxon attributes or worms_get_classification for actual ranks.',
      });
    scope.check();
    return { topic: input.topic, entries, attribution: attribution() };
  },
  format: formatData,
});
