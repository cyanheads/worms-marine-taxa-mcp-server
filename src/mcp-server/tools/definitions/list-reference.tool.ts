/**
 * @fileoverview Static vocabularies (identifiers, statuses, flags, distribution terms) and live rank/trait-key references.
 * @module mcp-server/tools/definitions/list-reference.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  attribution,
  attributionSchema,
  codecTrailer,
  formatData,
  getWormsService,
  localOffsetSchema,
  localPageFields,
  localSlice,
  WormsScope,
} from '../../../services/worms/index.js';

const topics = [
  'external_id_types',
  'statuses',
  'environment_flags',
  'distribution_terms',
  'ranks',
  'trait_types',
] as const;
const statusGroups = ['accepted', 'unaccepted', 'uncertain', 'technical'] as const;
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
        value: z.string().describe('Status value as WoRMS records it.'),
        description: z.string().describe('One-line meaning and how to read validAphiaId.'),
        group: z
          .enum(statusGroups)
          .describe(
            'accepted (name in use), unaccepted (follow validAphiaId to the accepted name), uncertain (validAphiaId is the record itself or null), or technical (editorial state).',
          ),
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
    z
      .strictObject({
        field: z.string().describe('worms_get_distributions filter field.'),
        description: z.string().describe('Matching rule and coverage of the observed values.'),
        observedValues: z
          .array(z.string())
          .describe('Recorded values seen in WoRMS distributions; non-exhaustive.'),
      })
      .describe('Distribution filter vocabulary entry.'),
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
/** Statuses from the WoRMS editor manual plus the two technical statuses its REST API documents. */
const statuses: [value: string, group: (typeof statusGroups)[number], description: string][] = [
  [
    'accepted',
    'accepted',
    'Valid name (ICZN) or name considered taxonomically correct (ICBN); validAphiaId is the record itself. This status guide is non-exhaustive.',
  ],
  [
    'unreplaced junior homonym',
    'accepted',
    'Later-established homonym that has not been replaced and stays in use; validAphiaId is the record itself.',
  ],
  [
    'nomen protectum',
    'accepted',
    'Protected name given precedence over an unused senior synonym or homonym (ICZN Article 23.9.2); validAphiaId is the record itself.',
  ],
  [
    'nomen novum',
    'accepted',
    'New replacement name published as an explicit substitute for a previously published name; validAphiaId is the record itself.',
  ],
  [
    'alternative representation',
    'accepted',
    'Also an accepted name, with or without a subgenus, but less preferred; validAphiaId is the preferred representation.',
  ],
  [
    'unaccepted',
    'unaccepted',
    'Synonym or any other name that is not accepted; inspect unacceptreason, then follow validAphiaId to the accepted name.',
  ],
  [
    'superseded combination',
    'unaccepted',
    'Species transferred to another genus and now known by the new combination; follow validAphiaId to the accepted name.',
  ],
  [
    'superseded rank',
    'unaccepted',
    'Taxon moved up or down the hierarchy, such as a subspecies now accepted as a species; follow validAphiaId to the accepted name.',
  ],
  [
    'junior subjective synonym',
    'unaccepted',
    'Later-established name that a published opinion applies to the same taxon (heterotypic synonym in the ICN); follow validAphiaId to the accepted name.',
  ],
  [
    'junior objective synonym',
    'unaccepted',
    'Later-established name with the same type material (homotypic synonym in the ICN); follow validAphiaId to the accepted name.',
  ],
  [
    'junior homonym',
    'unaccepted',
    'Later-established identical name not given precedence (later homonym in the ICN); follow validAphiaId to the accepted name.',
  ],
  [
    'nomen nudum',
    'unaccepted',
    'Name published without the description, diagnosis, or type the codes require, so not available; validAphiaId can be null.',
  ],
  [
    'nomen oblitum',
    'unaccepted',
    'Forgotten name, unused since 1899, that does not take precedence over a younger synonym or homonym (ICZN Article 23.9.2); follow validAphiaId to the accepted name.',
  ],
  [
    'nomen rejiciendum',
    'unaccepted',
    'Rejected name set aside in favour of another, under the code or by taxonomic judgment; follow validAphiaId to the accepted name.',
  ],
  [
    'misspelling - incorrect original spelling',
    'unaccepted',
    "Error in the name's original publication that does not comply with ICZN rules; follow validAphiaId to the accepted name.",
  ],
  [
    'misspelling - incorrect subsequent spelling',
    'unaccepted',
    'Erroneous spelling captured from the literature; follow validAphiaId to the accepted name.',
  ],
  [
    'unjustified emendation',
    'unaccepted',
    'Demonstrably intentional change of the original spelling that the code does not justify (ICZN Article 33.2); follow validAphiaId to the accepted name.',
  ],
  [
    'incorrect grammatical agreement of specific epithet',
    'unaccepted',
    'Epithet spelling that a change in rank or combination requires to be corrected; follow validAphiaId to the accepted name.',
  ],
  [
    'misapplication',
    'unaccepted',
    'Name misapplied to an incorrectly identified specimen; follow validAphiaId to the accepted name.',
  ],
  [
    'unavailable name',
    'unaccepted',
    'Name not compliant with the relevant ICZN or ICN code; follow validAphiaId to the accepted name.',
  ],
  [
    'interim unpublished',
    'unaccepted',
    'Name published online only without evidence of ZooBank registration, unavailable until a print issue (ICZN Article 8.5); follow validAphiaId to the accepted name.',
  ],
  [
    'uncertain',
    'uncertain',
    'Taxonomic or nomenclatural uncertainty that is neither accepted nor unaccepted; validAphiaId is the record itself or null.',
  ],
  [
    'nomen dubium',
    'uncertain',
    'Name of uncertain application, with no type or a very vague original description; validAphiaId is the record itself or null.',
  ],
  [
    'taxon inquirendum',
    'uncertain',
    'Taxon whose validity is uncertain or disputed by experts; validAphiaId is the record itself or null.',
  ],
  [
    'temporary name',
    'uncertain',
    'Ad hoc higher taxon holding children whose classification is not finalised, such as incertae sedis; validAphiaId is the record itself or null.',
  ],
  [
    'unassessed',
    'uncertain',
    'Name from a nomenclator or collection database whose status has not yet been researched; validAphiaId is the record itself or null.',
  ],
  [
    'quarantined',
    'technical',
    'Hidden from the public WoRMS interface after an editor decision; inspect the taxon record for available details.',
  ],
  ['deleted', 'technical', 'The AphiaID should no longer be used; replace it with validAphiaId.'],
];
/** Values observed across six taxa (444 distribution rows) on 2026-10-20; WoRMS publishes no vocabulary. */
const distributionTerms = [
  ['establishmentMeans', ['Alien', 'Native', 'Native - Non-endemic']],
  [
    'invasiveness',
    ['Invasive', 'Not invasive', 'Uncertain', 'Not specified', 'Of concern', 'Management recorded'],
  ],
  [
    'occurrence',
    [
      'Reported',
      'Established',
      'Established and expanding',
      'Uncertain',
      'Detected in the wild',
      'Detected in invasion pathway',
      'In captivity/cultivated',
      'Sometimes present',
    ],
  ],
] as const;
export const listReferenceTool = tool('worms_list_reference', {
  description:
    'List supported external identifier systems, a non-exhaustive taxonomic-status guide grouped as accepted, unaccepted, uncertain, or technical, environment-flag semantics, observed worms_get_distributions filter values, live taxonomic ranks, or live trait definitions. Resume nextResultOffset as resultOffset with the same topic. Identifier codes, statuses, environment flags, and distribution terms are available offline. A record status can be the specific reason itself, such as junior subjective synonym, rather than unaccepted. IUCN identifiers are not threat categories; null flags mean not recorded. Trait definitions retain complete-tree preorder indices across pages; parents may be on earlier pages.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    resultOffset: localOffsetSchema,
    topic: z
      .enum(topics)
      .describe(
        'Reference topic: external_id_types, statuses, environment_flags, distribution_terms, ranks, or trait_types.',
      ),
  }),
  output: z.object({
    ...localPageFields,
    topic: z.enum(topics).describe('Requested reference topic.'),
    entries: z
      .array(entrySchema)
      .describe('Whole reference entries in this segment with topic-specific fields.'),
    attribution: attributionSchema,
  }),
  enrichment: { notice: z.string().optional().describe('Guidance for empty live references.') },
  enrichmentTrailer: codecTrailer('notice'),
  errors: [
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'HTTP 400/422 rejected the inputs.',
      recovery:
        'Retry the same tool later; WoRMS rejected a reference request that carries no caller input.',
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
      recovery: 'Retry the same tool later; WoRMS returned a response this server cannot read.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'response_too_large',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Upstream response exceeds 8 MiB.',
      recovery:
        "Use worms_get_classification for a taxon's ranks or worms_get_traits for its attributes; this tool cannot return the oversized WoRMS list.",
      retryable: false,
      thrownBy: 'service',
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
        entries = statuses.map(([value, group, description]) => ({ value, description, group }));
        break;
      case 'distribution_terms':
        entries = distributionTerms.map(([field, observedValues]) => ({
          field,
          description: `Values observed for the worms_get_distributions ${field} filter; non-exhaustive. The filter matches a whole value ignoring case, never part of one.`,
          observedValues: [...observedValues],
        }));
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
    const enrichment =
      entries.length === 0
        ? {
            notice:
              'Call worms_list_reference with the same topic later; use worms_get_traits for recorded taxon attributes or worms_get_classification for actual ranks.',
          }
        : {};
    ctx.enrich(enrichment);
    scope.check();
    return localSlice(
      entries,
      input.resultOffset,
      (segment, pagination) => ({
        topic: input.topic,
        entries: segment,
        attribution: attribution(),
        ...pagination,
      }),
      enrichment,
      () => scope.check(),
    );
  },
  format: formatData,
});
