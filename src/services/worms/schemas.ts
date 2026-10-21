/**
 * @fileoverview Shared sparse WoRMS domain schemas and normalizers.
 * @module services/worms/schemas
 */
import { z } from '@cyanheads/mcp-ts-core';

export const aphiaIdSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .describe('Positive safe-integer AphiaID; obtain from worms_resolve_taxon.');
export const offsetSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER - 50)
  .default(1)
  .describe('One-based starting record, advancing by 50; default 1.');
export const textSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .describe('Nonempty name, at most 512 characters.');
/** Treat a blank or whitespace-only optional string as omitted. */
export function blankAsUnset(value: unknown) {
  return typeof value === 'string' && !value.trim() ? undefined : value;
}
export const optionalTextSchema = z.preprocess(blankAsUnset, textSchema.optional());
/** Opaque optional input; omit blanks without rewriting populated strings. */
export const optionalEvidenceTextSchema = z.preprocess(
  blankAsUnset,
  z.string().min(1).max(512).optional(),
);
const sparseText = z.string().nullable().optional();
const sparseId = z.number().int().safe().nullable().optional();
export const externalTypes = [
  'algaebase',
  'bold',
  'dyntaxa',
  'fishbase',
  'iucn',
  'lsid',
  'ncbi',
  'tsn',
  'gisd',
] as const;
export const externalTypeSchema = z
  .enum(externalTypes)
  .describe(
    'Identifier system: algaebase, bold, dyntaxa, fishbase, iucn, lsid, ncbi, tsn, or gisd; inspect worms_list_reference with topic: external_id_types.',
  );
const evidenceId = z
  .union([
    z.number().int().safe().describe('Integer identifier.'),
    z.string().regex(/^\d+$/).describe('Numeric string preserved verbatim.'),
    z.null().describe('Unknown identifier.'),
  ])
  .optional();
export const distributionSchema = z
  .object({
    sourceAphiaId: aphiaIdSchema
      .optional()
      .describe('AphiaID the record is attached to; present only with includeSynonyms.'),
    locality: sparseText.describe('Recorded locality.'),
    locationId: sparseText.describe('Locality identifier.'),
    higherGeography: sparseText.describe('Broader recorded geography.'),
    higherGeographyId: sparseText.describe('Broader geography identifier.'),
    recordStatus: sparseText.describe('Distribution record status.'),
    qualityStatus: sparseText.describe('Record quality status.'),
    typeStatus: sparseText.describe('Type status.'),
    establishmentMeans: sparseText.describe('Recorded establishment means.'),
    invasiveness: sparseText.describe('Recorded invasiveness.'),
    occurrence: sparseText.describe('Recorded occurrence.'),
    latitude: z.number().finite().nullable().optional().describe('Recorded WGS84 latitude.'),
    longitude: z.number().finite().nullable().optional().describe('Recorded WGS84 longitude.'),
  })
  .describe('Recorded distribution evidence; omitted or null fields are unknown.');
export const traitSchema = z
  .object({
    nodeIndex: z.number().int().describe('Preorder node index.'),
    parentIndex: z.number().int().nullable().describe('Immediate parent index; null at roots.'),
    depth: z.number().int().describe('Tree depth.'),
    aphiaId: evidenceId.describe('Recorded taxon identifier.'),
    measurementTypeId: evidenceId.describe('Measurement type identifier.'),
    measurementType: sparseText.describe('Measurement type.'),
    measurementValue: sparseText.describe('Unmodified recorded value; no inferred units.'),
    sourceId: evidenceId.describe('Source identifier.'),
    reference: sparseText.describe('Unmodified source reference.'),
    qualityStatus: sparseText.describe('Recorded quality status.'),
    categoryId: evidenceId.describe('Category identifier.'),
    inheritedAphiaId: evidenceId.describe('Original inheritance marker.'),
    inheritedFrom: evidenceId.describe(
      'Known different source taxon (a higher taxon or a synonym), otherwise null.',
    ),
    parentType: sparseText.describe('Immediate parent measurement type; null at roots.'),
  })
  .describe('Trait evidence node with complete topology; omitted or null facts are unknown.');
export const taxonRecordSchema = z
  .object({
    aphiaId: aphiaIdSchema,
    url: sparseText.describe('Upstream taxon URL.'),
    scientificname: sparseText.describe('Scientific name.'),
    authority: sparseText.describe('Authorship.'),
    rank: sparseText.describe('Open taxonomic rank.'),
    status: sparseText.describe('Open taxonomic status.'),
    unacceptreason: sparseText.describe('Reason for nonacceptance.'),
    taxonRankId: sparseId.describe('Rank identifier.'),
    validAphiaId: sparseId.describe('Accepted taxon identifier.'),
    validName: sparseText.describe('Accepted scientific name.'),
    validAuthority: sparseText.describe('Accepted authorship.'),
    parentAphiaId: sparseId.describe('Parent usage identifier.'),
    originalAphiaId: sparseId.describe('Original usage identifier.'),
    kingdom: sparseText.describe('Kingdom.'),
    phylum: sparseText.describe('Phylum.'),
    class: sparseText.describe('Class.'),
    order: sparseText.describe('Order.'),
    family: sparseText.describe('Family.'),
    genus: sparseText.describe('Genus.'),
    citation: sparseText.describe('Unmodified record citation.'),
    lsid: sparseText.describe('Life science identifier.'),
    modified: sparseText.describe('Unmodified modification date.'),
    isMarine: z.boolean().nullable().optional().describe('Marine flag; null means unknown.'),
    isBrackish: z.boolean().nullable().optional().describe('Brackish flag.'),
    isFreshwater: z.boolean().nullable().optional().describe('Freshwater flag.'),
    isTerrestrial: z.boolean().nullable().optional().describe('Terrestrial flag.'),
    isExtinct: z.boolean().nullable().optional().describe('Extinct flag.'),
    matchType: sparseText.describe('Upstream match type.'),
  })
  .describe('Documented Aphia record; omitted or null scientific facts and flags are unknown.');
export type TaxonRecord = z.infer<typeof taxonRecordSchema>;
export const matchSchema = taxonRecordSchema
  .pick({
    aphiaId: true,
    scientificname: true,
    authority: true,
    rank: true,
    status: true,
    unacceptreason: true,
    validAphiaId: true,
    validName: true,
    validAuthority: true,
    matchType: true,
    url: true,
  })
  .describe('Scientific name match.');
export const rankNodeSchema = taxonRecordSchema
  .pick({
    aphiaId: true,
    rank: true,
    scientificname: true,
  })
  .describe('Classification node.');
export const childSchema = taxonRecordSchema
  .pick({
    aphiaId: true,
    scientificname: true,
    rank: true,
    status: true,
  })
  .describe('Direct child taxon.');
export const synonymSchema = taxonRecordSchema
  .pick({
    aphiaId: true,
    scientificname: true,
    authority: true,
    status: true,
    unacceptreason: true,
  })
  .describe('Synonym name usage.');
export const vernacularSchema = z
  .object({
    vernacular: sparseText.describe('Common name.'),
    languageCode: sparseText.describe('Language code.'),
    language: sparseText.describe('Language name.'),
  })
  .describe('Recorded common name.');
export const sourceSchema = z
  .object({
    sourceId: sparseId.describe('AphiaSource identifier.'),
    use: sparseText.describe(
      'How the source supports the name, such as original description or basis of record; open vocabulary.',
    ),
    reference: sparseText.describe('Unmodified bibliographic reference.'),
    page: sparseText.describe('Cited page.'),
    url: sparseText.describe('WoRMS source detail URL.'),
    link: sparseText.describe('External link to the source.'),
    fulltext: sparseText.describe('Full-text URL.'),
    doi: sparseText.describe('Source DOI.'),
  })
  .describe('Taxon source record; omitted or null fields are unknown.');
export const itemErrorSchema = z.object({
  reason: z.string().describe('Classified reason.'),
  code: z.number().describe('JSON-RPC code.'),
  message: z.string().describe('Safe failure message.'),
  recovery: z.string().describe('Recovery guidance.'),
  retryable: z.boolean().describe('Whether retry can succeed.'),
});
export const statusErrorSchema = itemErrorSchema
  .optional()
  .describe(
    'Failed taxonomic-status read; evidence is unaffected, but whether the AphiaID is its accepted name is unknown.',
  );
/**
 * Notice fragment for a submitted AphiaID that is not its own accepted name: both numeric IDs and
 * the caller's retry, or a worms_get_taxon check when no accepted taxon is linked. Accepted,
 * self-valid, and missing records yield none; upstream names and statuses never enter the text.
 */
export function statusNotice(
  id: number,
  record: TaxonRecord | null,
  retry: (validAphiaId: number) => string,
) {
  if (!record) return;
  const valid = record.validAphiaId;
  if (valid !== null && valid !== undefined)
    return valid === id
      ? undefined
      : `AphiaID ${id} is not the accepted name; WoRMS links it to accepted AphiaID ${valid}. ${retry(valid)}`;
  return record.status === 'accepted'
    ? undefined
    : `WoRMS links no accepted taxon to AphiaID ${id}; call worms_get_taxon with aphiaIds: [${id}] to inspect its status.`;
}
export const attributionSchema = z
  .object({
    citation: z.string().describe('WoRMS attribution.'),
    sourceUrl: z.string().describe('Canonical source URL.'),
    accessedDate: z.string().describe('UTC access date.'),
  })
  .describe('WoRMS source attribution.');
export const pageSchema = z.object({
  offset: z.number().int().describe('One-based start.'),
  pageSize: z.literal(50).describe('Upstream page size.'),
  returnedCount: z.number().int().describe('Rows returned.'),
  hasMore: z.literal(false).nullable().describe('False if exhausted; null if unknown.'),
  nextOffset: z.number().int().nullable().describe('Candidate next offset, or null.'),
});
/** Create access-time attribution without modifying record citations. */
export function attribution() {
  const date = new Date().toISOString().slice(0, 10);
  return {
    citation: `WoRMS Editorial Board (${date.slice(0, 4)}). World Register of Marine Species. Available from https://www.marinespecies.org at VLIZ. Accessed ${date}. doi:10.14284/170`,
    sourceUrl: 'https://www.marinespecies.org',
    accessedDate: date,
  };
}
/** A full page has uncertain continuation, never a fabricated total. */
export function page(offset: number, count: number) {
  return {
    offset,
    pageSize: 50 as const,
    returnedCount: count,
    hasMore: count < 50 ? (false as const) : null,
    nextOffset: count < 50 ? null : offset + 50,
  };
}
/** A fetched page seen through one local segment; nextOffset stays current until it is consumed. */
export function segmentPage(
  fetched: ReturnType<typeof page>,
  returnedCount: number,
  consumed: boolean,
) {
  return { ...fetched, returnedCount, nextOffset: consumed ? fetched.nextOffset : fetched.offset };
}
