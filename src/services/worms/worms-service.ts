/**
 * @fileoverview Sparse taxonomic retrieval, positional matching and iterative trees.
 * @module services/worms/worms-service
 */
import { z } from '@cyanheads/mcp-ts-core';
import {
  childSchema,
  distributionSchema,
  matchSchema,
  rankNodeSchema,
  sourceSchema,
  synonymSchema,
  type TaxonRecord,
  taxonRecordSchema,
  traitSchema,
  vernacularSchema,
} from './schemas.js';
import { disposeTransport, failure, request, type WormsScope } from './transport.js';

/** Validate a shallow upstream object without traversing nested trees recursively. */
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw failure('invalid_upstream_response');
  return value as Record<string, unknown>;
}
/** Validate list endpoints without coercing malformed data into absence. */
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw failure('invalid_upstream_response');
  return value;
}
/** Normalize flat responses with periodic absolute-deadline checks. */
function scan<T>(data: unknown, scope: WormsScope, normalize: (row: unknown) => T): T[] {
  return array(data).map((row, index) => {
    if (!(index % 256)) scope.check();
    return normalize(row);
  });
}
/** Fetch a flat list endpoint; 204 is an empty list. */
async function list<T>(
  scope: WormsScope,
  endpoint: string,
  query: URLSearchParams,
  normalize: (row: unknown) => T,
): Promise<T[]> {
  return (await request(scope, endpoint, query, (data) => scan(data, scope, normalize))) ?? [];
}
/** Preserve omissions and nulls while applying documented field names. */
function mapped(raw: Record<string, unknown>, fields: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, source]) => Object.hasOwn(raw, source))
      .map(([target, source]) => [target, raw[source]]),
  );
}
/** Turn shape failures into nonretryable upstream failures. */
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw failure('invalid_upstream_response', 'WoRMS returned an incompatible response shape.');
  return parsed.data;
}
const recordFields = {
  aphiaId: 'AphiaID',
  url: 'url',
  scientificname: 'scientificname',
  authority: 'authority',
  rank: 'rank',
  status: 'status',
  unacceptreason: 'unacceptreason',
  taxonRankId: 'taxonRankID',
  validAphiaId: 'valid_AphiaID',
  validName: 'valid_name',
  validAuthority: 'valid_authority',
  parentAphiaId: 'parentNameUsageID',
  originalAphiaId: 'originalNameUsageID',
  kingdom: 'kingdom',
  phylum: 'phylum',
  class: 'class',
  order: 'order',
  family: 'family',
  genus: 'genus',
  citation: 'citation',
  lsid: 'lsid',
  modified: 'modified',
  isMarine: 'isMarine',
  isBrackish: 'isBrackish',
  isFreshwater: 'isFreshwater',
  isTerrestrial: 'isTerrestrial',
  isExtinct: 'isExtinct',
  matchType: 'match_type',
};
/** Normalize a full documented AphiaRecord, preserving unknown scientific facts. */
function normalizeRecord(value: unknown) {
  const result = mapped(object(value), recordFields);
  for (const key of ['isMarine', 'isBrackish', 'isFreshwater', 'isTerrestrial', 'isExtinct']) {
    if (result[key] === 0) result[key] = false;
    if (result[key] === 1) result[key] = true;
  }
  return checked(taxonRecordSchema, result);
}
/** Literal-null and all-null batch slots are missing records. */
function missingRecord(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0 &&
      Object.values(value).every((entry) => entry === null))
  );
}
const rankReferenceSchema = z.object({
  taxonRankId: z.number().int().nullable().optional(),
  taxonRank: z.string().nullable().optional(),
  kingdomAphiaId: z.number().int().nullable().optional(),
  kingdom: z.string().nullable().optional(),
});
const numericKeyId = z
  .union([z.number().int(), z.string().regex(/^\d+$/)])
  .nullable()
  .optional();
const attributeKeySchema = z.object({
  measurementTypeId: numericKeyId,
  measurementType: z.string().nullable().optional(),
  inputId: numericKeyId,
  categoryId: numericKeyId,
});

/** WoRMS service; every method consumes the caller's existing absolute deadline. */
export class WormsService {
  /** Retrieve positional ID records in one upstream batch. */
  async records(ids: number[], scope: WormsScope) {
    const query = new URLSearchParams();
    for (const id of ids) query.append('aphiaids[]', String(id));
    const result = await request(scope, 'AphiaRecordsByAphiaIDs', query, (data) => {
      const rows = array(data);
      if (rows.length !== ids.length)
        throw failure(
          'invalid_upstream_response',
          'WoRMS batch length does not match submitted IDs.',
        );
      return rows.map((row, index) => {
        if (!(index % 256)) scope.check();
        if (missingRecord(row)) return null;
        const record = normalizeRecord(row);
        if (record.aphiaId !== ids[index])
          throw failure('invalid_upstream_response', 'WoRMS batch IDs are out of position.');
        return record;
      });
    });
    return result ?? ids.map(() => null);
  }
  /** Single record endpoint for accepted-name evidence workflows. */
  record(id: number, scope: WormsScope) {
    return request(scope, `AphiaRecordByAphiaID/${id}`, new URLSearchParams(), normalizeRecord);
  }
  /** Status read beside other evidence: a classified outage becomes statusError; rejection, cancellation, and deadline expiry still fail the call. */
  async status(
    id: number,
    scope: WormsScope,
  ): Promise<{
    record: TaxonRecord | null;
    statusError?: ReturnType<WormsScope['optionalError']>;
  }> {
    try {
      return { record: await this.record(id, scope) };
    } catch (error) {
      return { record: null, statusError: scope.optionalError(error) };
    }
  }
  /** Exact/fuzzy name batches preserve every submitted position and duplicate. */
  async names(
    names: string[],
    fuzzy: boolean,
    marineOnly: boolean,
    extantOnly: boolean,
    scope: WormsScope,
  ) {
    const query = new URLSearchParams({
      marine_only: String(marineOnly),
      extant_only: String(extantOnly),
      ...(fuzzy ? { match_authority: 'false' } : { like: 'false' }),
    });
    for (const name of names) query.append('scientificnames[]', name);
    return (
      (await request(
        scope,
        fuzzy ? 'AphiaRecordsByMatchNames' : 'AphiaRecordsByNames',
        query,
        (data) => {
          const rows = array(data);
          if (rows.length !== names.length)
            throw failure(
              'invalid_upstream_response',
              'WoRMS name batch length does not match submitted names.',
            );
          return rows.map((group, index) => {
            if (!(index % 256)) scope.check();
            return group === null
              ? []
              : scan(group, scope, (row) => checked(matchSchema, normalizeRecord(row)));
          });
        },
      )) ?? names.map(() => [])
    );
  }
  /** Common-name search cannot apply marine/extant filters; `like` matches names containing the text. */
  vernacularSearch(name: string, like: boolean, offset: number, scope: WormsScope) {
    return list(
      scope,
      `AphiaRecordsByVernacular/${encodeURIComponent(name)}`,
      new URLSearchParams({ like: String(like), offset: String(offset) }),
      (row) => checked(matchSchema, normalizeRecord(row)),
    );
  }
  /** Retrieve optional common-name evidence without inventing absence on failure. */
  vernaculars(id: number, scope: WormsScope) {
    return list(scope, `AphiaVernacularsByAphiaID/${id}`, new URLSearchParams(), (row) =>
      checked(
        vernacularSchema,
        mapped(object(row), {
          vernacular: 'vernacular',
          languageCode: 'language_code',
          language: 'language',
        }),
      ),
    );
  }
  /** Retrieve the complete, unpaged source list of one taxon in source order; 204 is an empty list. */
  sources(id: number, scope: WormsScope) {
    return list(scope, `AphiaSourcesByAphiaID/${id}`, new URLSearchParams(), (row) =>
      checked(
        sourceSchema,
        mapped(object(row), {
          sourceId: 'source_id',
          use: 'use',
          reference: 'reference',
          page: 'page',
          url: 'url',
          link: 'link',
          fulltext: 'fulltext',
          doi: 'doi',
        }),
      ),
    );
  }
  /** Validate and flatten the complete root-to-tip classification iteratively. */
  classification(id: number, scope: WormsScope) {
    return request(scope, `AphiaClassificationByAphiaID/${id}`, new URLSearchParams(), (data) => {
      const ranks: z.infer<typeof rankNodeSchema>[] = [];
      let current: unknown = data;
      while (current !== null && current !== undefined) {
        if (!(ranks.length % 256)) scope.check();
        const node = object(current);
        ranks.push(
          checked(
            rankNodeSchema,
            mapped(node, { aphiaId: 'AphiaID', rank: 'rank', scientificname: 'scientificname' }),
          ),
        );
        current = node.child;
      }
      return ranks;
    });
  }
  /** One page of immediate children, without hidden lookahead. */
  children(
    id: number,
    offset: number,
    marineOnly: boolean,
    extantOnly: boolean,
    scope: WormsScope,
  ) {
    return list(
      scope,
      `AphiaChildrenByAphiaID/${id}`,
      new URLSearchParams({
        offset: String(offset),
        marine_only: String(marineOnly),
        extant_only: String(extantOnly),
      }),
      (row) => checked(childSchema, normalizeRecord(row)),
    );
  }
  /** Retrieve the live rank vocabulary, retaining all rows and sparsity. */
  ranks(scope: WormsScope) {
    return list(scope, 'AphiaTaxonRanksByID/-1', new URLSearchParams(), (row) =>
      checked(
        rankReferenceSchema,
        mapped(object(row), {
          taxonRankId: 'taxonRankID',
          taxonRank: 'taxonRank',
          kingdomAphiaId: 'AphiaID',
          kingdom: 'kingdom',
        }),
      ),
    );
  }
  /** Flatten attribute-key trees in preorder with explicit topology. */
  async attributeKeys(scope: WormsScope) {
    return (
      (await request(
        scope,
        'AphiaAttributeKeysByID/0',
        new URLSearchParams({ include_children: 'true' }),
        (data) => {
          const stack = scan(data, scope, (value) => ({
            value,
            parentIndex: null as number | null,
            depth: 0,
          })).reverse();
          const result: (z.infer<typeof attributeKeySchema> & {
            nodeIndex: number;
            parentIndex: number | null;
            depth: number;
          })[] = [];
          while (stack.length) {
            if (!(result.length % 256)) scope.check();
            const entry = stack.pop();
            if (!entry) break;
            const raw = object(entry.value);
            const nodeIndex = result.length;
            result.push({
              nodeIndex,
              parentIndex: entry.parentIndex,
              depth: entry.depth,
              ...checked(
                attributeKeySchema,
                mapped(raw, {
                  measurementTypeId: 'measurementTypeID',
                  measurementType: 'measurementType',
                  inputId: 'input_id',
                  categoryId: 'CategoryID',
                }),
              ),
            });
            if (raw.children !== null && raw.children !== undefined) {
              const children = array(raw.children);
              for (let index = children.length - 1; index >= 0; index--) {
                if (!(index % 256)) scope.check();
                stack.push({
                  value: children[index],
                  parentIndex: nodeIndex,
                  depth: entry.depth + 1,
                });
              }
            }
          }
          return result;
        },
      )) ?? []
    );
  }
  /** Retrieve one complete synonym page for an already resolved accepted taxon. */
  synonyms(id: number, offset: number, scope: WormsScope) {
    return list(
      scope,
      `AphiaSynonymsByAphiaID/${id}`,
      new URLSearchParams({ offset: String(offset) }),
      (row) => checked(synonymSchema, normalizeRecord(row)),
    );
  }
  /** Complete distribution evidence; filtering belongs to the caller's local view. */
  distributions(id: number, scope: WormsScope) {
    return list(scope, `AphiaDistributionsByAphiaID/${id}`, new URLSearchParams(), (row) =>
      checked(
        distributionSchema,
        mapped(object(row), {
          locality: 'locality',
          locationId: 'locationID',
          higherGeography: 'higherGeography',
          higherGeographyId: 'higherGeographyID',
          recordStatus: 'recordStatus',
          qualityStatus: 'qualityStatus',
          typeStatus: 'typeStatus',
          establishmentMeans: 'establishmentMeans',
          invasiveness: 'invasiveness',
          occurrence: 'occurrence',
          latitude: 'decimalLatitude',
          longitude: 'decimalLongitude',
        }),
      ),
    );
  }
  /** Complete attribute tree flattened iteratively in source preorder. */
  async traits(id: number, includeInherited: boolean, scope: WormsScope) {
    return (
      (await request(
        scope,
        `AphiaAttributesByAphiaID/${id}`,
        new URLSearchParams({ include_inherited: String(includeInherited) }),
        (data) => {
          const stack: {
            value: unknown;
            parentIndex: number | null;
            depth: number;
            parentType: string | null | undefined;
          }[] = [];
          const roots = array(data);
          for (let index = roots.length - 1; index >= 0; index--) {
            if (!(index % 256)) scope.check();
            stack.push({ value: roots[index], parentIndex: null, depth: 0, parentType: null });
          }
          const result: z.infer<typeof traitSchema>[] = [];
          while (stack.length) {
            if (!(result.length % 256)) scope.check();
            const entry = stack.pop();
            if (!entry) break;
            const raw = object(entry.value);
            const fields = mapped(raw, {
              aphiaId: 'AphiaID',
              measurementTypeId: 'measurementTypeID',
              measurementType: 'measurementType',
              measurementValue: 'measurementValue',
              sourceId: 'source_id',
              reference: 'reference',
              qualityStatus: 'qualitystatus',
              categoryId: 'CategoryID',
              inheritedAphiaId: 'AphiaID_Inherited',
            });
            const marker = fields.inheritedAphiaId;
            const node = checked(traitSchema, {
              ...fields,
              nodeIndex: result.length,
              parentIndex: entry.parentIndex,
              depth: entry.depth,
              ...(entry.parentType !== undefined ? { parentType: entry.parentType } : {}),
              inheritedFrom:
                marker !== undefined && marker !== null && Number(marker) !== id ? marker : null,
            });
            result.push(node);
            if (raw.children !== null && raw.children !== undefined) {
              const children = array(raw.children);
              for (let index = children.length - 1; index >= 0; index--) {
                if (!(index % 256)) scope.check();
                stack.push({
                  value: children[index],
                  parentIndex: node.nodeIndex,
                  depth: entry.depth + 1,
                  parentType: node.measurementType,
                });
              }
            }
          }
          return result;
        },
      )) ?? []
    );
  }
  /** Retrieve one explicitly selected external identifier system. */
  externalIds(id: number, type: string, scope: WormsScope) {
    return list(scope, `AphiaExternalIDByAphiaID/${id}`, new URLSearchParams({ type }), (value) =>
      checked(z.string(), value),
    );
  }
  /** Reverse opaque identifiers without numeric coercion or supplementary reads. */
  externalRecord(id: string, type: string, scope: WormsScope) {
    return request(
      scope,
      `AphiaRecordByExternalID/${encodeURIComponent(id)}`,
      new URLSearchParams({ type }),
      normalizeRecord,
    );
  }
  /** Shared pacer teardown. */
  dispose() {
    disposeTransport();
  }
}
let service: WormsService | undefined;
/** Initialize one domain service from application setup. */
export function initWormsService() {
  service = new WormsService();
}
/** Access the initialized domain service. */
export function getWormsService() {
  if (!service) throw new Error('WormsService not initialized; call initWormsService in setup.');
  return service;
}
