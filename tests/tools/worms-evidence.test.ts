/**
 * @fileoverview Evidence tools exercised through real services and network fixtures.
 * @module tests/tools/worms-evidence.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crosswalkIdTool } from '@/mcp-server/tools/definitions/crosswalk-id.tool.js';
import { getClassificationTool } from '@/mcp-server/tools/definitions/get-classification.tool.js';
import { getDistributionsTool } from '@/mcp-server/tools/definitions/get-distributions.tool.js';
import { getSynonymsTool } from '@/mcp-server/tools/definitions/get-synonyms.tool.js';
import { getTraitsTool } from '@/mcp-server/tools/definitions/get-traits.tool.js';
import {
  collectLocal,
  contentText,
  declared,
  expectParity,
  fakeFetch,
  hang,
  offline,
  record,
  settle,
  setupWorms,
  withStatus,
} from '../helpers/worms.js';

const externalTypes = [
  'algaebase',
  'bold',
  'dyntaxa',
  'fishbase',
  'iucn',
  'lsid',
  'ncbi',
  'tsn',
  'gisd',
];

beforeEach(setupWorms);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Paired surfaces of a default-mode evidence call whose status read WoRMS answered: no statusError. */
function expectEvidence(result: Awaited<ReturnType<typeof runToolContract>>) {
  expectParity(result);
  expect(result.structuredContent).not.toHaveProperty('statusError');
}

describe('synonym evidence', () => {
  it.each([0, 49, 50])(
    'redirects to the accepted ID and preserves a %i-row page',
    async (count) => {
      const network = fakeFetch((url, _init, index) => {
        if (!index) {
          expect(url.pathname).toBe('/rest/AphiaRecordByAphiaID/1');
          return Response.json(record(1, { status: 'unaccepted', valid_AphiaID: 2 }));
        }
        expect(url.pathname).toBe('/rest/AphiaSynonymsByAphiaID/2');
        expect(url.searchParams.toString()).toBe('offset=51');
        return count
          ? Response.json(
              Array.from({ length: count }, (_, i) =>
                record(i + 3, {
                  scientificname: 'A\r\n\n`|<>',
                  authority: null,
                  unacceptreason: '',
                }),
              ),
            )
          : new Response(null, { status: 204 });
      });
      const result = await settle(runToolContract(getSynonymsTool, { aphiaId: 1, offset: 51 }));
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        aphiaId: 1,
        found: true,
        validAphiaId: 2,
        page: {
          offset: 51,
          returnedCount: (result.structuredContent as { synonyms: unknown[] }).synonyms.length,
          hasMore: count === 50 ? null : false,
          nextOffset:
            (result.structuredContent as { nextResultOffset: number | null }).nextResultOffset !==
            null
              ? 51
              : count === 50
                ? 101
                : null,
        },
      });
      expect(network.calls).toHaveLength(2);
    },
  );
  it.each([null, record(1, { status: 'unaccepted', valid_AphiaID: null })])(
    'does not invent accepted-name evidence for %j',
    async (row) => {
      const network = fakeFetch(() =>
        row ? Response.json(row) : new Response(null, { status: 204 }),
      );
      const result = await settle(runToolContract(getSynonymsTool, { aphiaId: 1 }));
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        found: row !== null,
        validAphiaId: null,
        synonyms: [],
        guidance: expect.any(String),
      });
      expect(result.structuredContent).not.toHaveProperty('page');
      expect(network.calls).toHaveLength(1);
    },
  );
  it.each([1, 51])(
    'points an empty synonym page at offset %i back to the first page only past it',
    async (offset) => {
      const network = fakeFetch((url, _init, index) => {
        if (!index) return Response.json(record(1, { status: 'accepted' }));
        expect(url.searchParams.get('offset')).toBe(String(offset));
        return new Response(null, { status: 204 });
      });
      const result = await settle(runToolContract(getSynonymsTool, { aphiaId: 1, offset }));
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        validAphiaId: 1,
        synonyms: [],
        page: { offset, returnedCount: 0, hasMore: false, nextOffset: null },
        echo: { offset },
      });
      if (offset === 1) expect(result.structuredContent).not.toHaveProperty('notice');
      else
        expect(result.structuredContent).toMatchObject({
          notice:
            'No synonyms were returned for this page; call worms_get_synonyms with offset: 1 to inspect the first page.',
        });
      expect(network.calls).toHaveLength(2);
    },
  );
  it('uses the original ID only for explicitly accepted status and fails required reads atomically', async () => {
    fakeFetch((url, _init, index) => {
      if (!index) return Response.json(record(1, { status: 'accepted' }));
      expect(url.pathname).toBe('/rest/AphiaSynonymsByAphiaID/1');
      return new Response(null, { status: 403 });
    });
    const result = await settle(runToolContract(getSynonymsTool, { aphiaId: 1 }));
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'upstream_access_denied' } },
    });
    expect(result.isError).toBe(true);
  });
});

describe('distribution evidence', () => {
  it.each(['valid', 'doubtful', 'inaccurate'] as const)(
    'normalizes controlled status %s before conjunctive filtering and continuation',
    async (status) => {
      fakeFetch(
        withStatus(null, () =>
          Response.json([
            { recordStatus: status, occurrence: 'Present' },
            { recordStatus: status, occurrence: 'Present' },
            { recordStatus: status.toUpperCase(), occurrence: 'Present' },
            { recordStatus: status, occurrence: 'Absent' },
          ]),
        ),
      );
      const result = await settle(
        runToolContract(getDistributionsTool, {
          aphiaId: 1,
          recordStatus: ` \t${status.toUpperCase()}\n`,
          occurrence: 'PRESENT',
          resultOffset: 1,
        }),
      );
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        unfilteredCount: 4,
        filteredCount: 2,
        distributions: [{ recordStatus: status, occurrence: 'Present' }],
        echo: { recordStatus: status, occurrence: 'PRESENT' },
      });
    },
  );
  it.each(['unknown', 1, false])(
    'rejects invalid controlled status %s with allowed codes',
    async (recordStatus) => {
      offline();
      const result = await settle(
        runToolContract(getDistributionsTool, { aphiaId: 1, recordStatus }),
      );
      expect(result.isError).toBe(true);
      for (const code of ['valid', 'doubtful', 'inaccurate'])
        expect(contentText(result)).toContain(code);
    },
  );
  const matching = {
    locality: 'Sea\r\n\n`|<>',
    locationID: '001',
    recordStatus: 'valid',
    establishmentMeans: 'Native',
    invasiveness: 'not invasive',
    occurrence: 'present',
    decimalLatitude: null,
  };
  it('filters the complete fetched set conjunctively, preserving duplicates, order and nulls', async () => {
    const rows = [
      matching,
      { ...matching, occurrence: null },
      { ...matching, recordStatus: 'Valid' },
      { ...matching, establishmentMeans: 'Native range' },
      matching,
      {},
    ];
    const network = fakeFetch(
      withStatus(null, (url) => {
        expect(url.searchParams.toString()).toBe('');
        return Response.json(rows);
      }),
    );
    const result = await settle(
      runToolContract(getDistributionsTool, {
        aphiaId: 1,
        recordStatus: 'valid',
        establishmentMeans: 'NATIVE',
        invasiveness: 'NOT INVASIVE',
        occurrence: 'PRESENT',
      }),
    );
    expectEvidence(result);
    expect(result.structuredContent).toMatchObject({
      unfilteredCount: 6,
      filteredCount: 2,
      distributions: [
        { locality: matching.locality, locationId: '001', latitude: null },
        { locality: matching.locality },
      ],
      echo: { establishmentMeans: 'NATIVE' },
    });
    expect(network.calls).toHaveLength(2);
  });
  it('retains more than a page of unfiltered evidence and ignores blank filters', async () => {
    fakeFetch(withStatus(null, () => Response.json(Array.from({ length: 260 }, () => matching))));
    const result = await settle(
      runToolContract(getDistributionsTool, { aphiaId: 1, occurrence: ' ', recordStatus: '' }),
    );
    expectEvidence(result);
    expect(result.structuredContent).toMatchObject({
      unfilteredCount: 260,
      filteredCount: 260,
      echo: {},
    });
  });
  it.each([{}, { occurrence: 'Established' }])(
    'reports empty evidence for %j without claiming absence or suggesting the same rows',
    async (filter) => {
      const network = fakeFetch(() => new Response(null, { status: 204 }));
      const result = await settle(
        runToolContract(getDistributionsTool, { aphiaId: 1298345, ...filter }),
      );
      expectEvidence(result);
      expect(network.calls).toHaveLength(2);
      expect(result.structuredContent).toMatchObject({
        unfilteredCount: 0,
        filteredCount: 0,
        distributions: [],
        echo: filter,
        notice: 'Call worms_get_taxon to check the AphiaID.',
      });
    },
  );
  it.each([
    [{ occurrence: 'absent' }, true],
    [{ establishmentMeans: 'Native' }, true],
    [{ recordStatus: 'doubtful' }, false],
  ] as const)(
    'distinguishes zero local matches from zero upstream rows for %j',
    async (filter, pointsToTerms) => {
      fakeFetch(
        withStatus(null, () =>
          Response.json([
            { ...matching, establishmentMeans: 'Native - Non-endemic' },
            { locality: null, occurrence: null, recordStatus: 'valid' },
          ]),
        ),
      );
      const result = await settle(runToolContract(getDistributionsTool, { aphiaId: 1, ...filter }));
      expectEvidence(result);
      expect(result.structuredContent).toMatchObject({
        unfilteredCount: 2,
        filteredCount: 0,
        distributions: [],
        echo: filter,
        notice: expect.stringMatching(
          /^Call worms_get_distributions without filters to inspect recorded distributions, or worms_get_taxon to check the AphiaID\./,
        ),
      });
      const { notice } = result.structuredContent as { notice: string };
      if (pointsToTerms)
        expect(
          notice.endsWith(
            'Call worms_list_reference with topic: distribution_terms for observed filter values.',
          ),
        ).toBe(true);
      else expect(notice).not.toContain('distribution_terms');
    },
  );
});

describe('trait evidence', () => {
  it.each([{ children: {} }, { children: [{ measurementTypeID: 'not numeric' }] }])(
    'rejects malformed nested evidence %j atomically',
    async (node) => {
      fakeFetch(withStatus(null, () => Response.json([node])));
      const result = await settle(runToolContract(getTraitsTool, { aphiaId: 1 }));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_upstream_response' } },
      });
      expect(result.structuredContent).not.toHaveProperty('traits');
    },
  );
  it('retains depth-first branching topology, repeated values, sparse IDs and inheritance', async () => {
    fakeFetch(
      withStatus(null, (url) => {
        expect(url.searchParams.toString()).toBe('include_inherited=true');
        return Response.json([
          {
            measurementType: 'root',
            measurementValue: null,
            children: [
              {
                measurementType: null,
                measurementTypeID: '001',
                source_id: '002',
                CategoryID: null,
                AphiaID_Inherited: '0002',
                measurementValue: 'A\r\n\n`|<>',
                children: [
                  { AphiaID_Inherited: '0001', reference: 'https://example.org/a_(b)?x=1&y=2' },
                ],
              },
              { measurementType: 'root', AphiaID_Inherited: null },
            ],
          },
          {},
        ]);
      }),
    );
    const result = await settle(runToolContract(getTraitsTool, { aphiaId: 1 }));
    expectEvidence(result);
    expect(result.structuredContent).toMatchObject({
      traits: [
        {
          nodeIndex: 0,
          parentIndex: null,
          depth: 0,
          parentType: null,
          measurementValue: null,
          inheritedFrom: null,
        },
        {
          nodeIndex: 1,
          parentIndex: 0,
          depth: 1,
          parentType: 'root',
          measurementTypeId: '001',
          sourceId: '002',
          categoryId: null,
          inheritedFrom: '0002',
        },
        {
          nodeIndex: 2,
          parentIndex: 1,
          depth: 2,
          parentType: null,
          inheritedAphiaId: '0001',
          inheritedFrom: null,
        },
        { nodeIndex: 3, parentIndex: 0, depth: 1, measurementType: 'root' },
        { nodeIndex: 4, parentIndex: null, depth: 0 },
      ],
    });
  });
  it('normalizes and renders a finite chain past shallow recursive limits', async () => {
    let node: Record<string, unknown> = { measurementValue: 'leaf' };
    for (let depth = 0; depth < 1100; depth++)
      node = { measurementTypeID: `${depth}`, children: [node] };
    fakeFetch(withStatus(null, () => Response.json([node])));
    const traits = await collectLocal(
      (resultOffset) => runToolContract(getTraitsTool, { aphiaId: 1, resultOffset }),
      'traits',
    );
    expect(traits).toHaveLength(1101);
    expect(traits).toEqual(
      expect.arrayContaining([
        {
          nodeIndex: 1100,
          parentIndex: 1099,
          depth: 1100,
          measurementValue: 'leaf',
          inheritedFrom: null,
        },
      ]),
    );
  });
  it.each([true, false])('keeps empty inheritance=%s guidance honest', async (includeInherited) => {
    fakeFetch(
      withStatus(null, (url) => {
        expect(url.searchParams.get('include_inherited')).toBe(String(includeInherited));
        return new Response(null, { status: 204 });
      }),
    );
    const result = await settle(runToolContract(getTraitsTool, { aphiaId: 1, includeInherited }));
    expectEvidence(result);
    expect(result.structuredContent).toMatchObject({
      traits: [],
      echo: { includeInherited },
      notice: expect.stringContaining(
        includeInherited ? 'inheritance enabled' : 'includeInherited: true',
      ),
    });
  });
});

/** An upstream attribute node with a long value, so filtered sets span several segments. */
const attr = (measurementType: string | null, ...children: object[]): object => ({
  measurementType,
  measurementValue: 'v'.repeat(300),
  ...(children.length ? { children } : {}),
});
/** A single-child chain of measurement types, outermost first. */
const chain = (type: string, ...rest: string[]): object =>
  rest.length ? attr(type, chain(...(rest as [string, ...string[]]))) : attr(type);
const society = (type: string, ...rest: string[]) =>
  attr('Species importance to society', chain(type, ...rest));
const greaterNorthSea = 'OSPAR candidate indicators: Greater North Sea including outside EU';
const celticSeas = 'OSPAR candidate indicators: Celtic Seas';
const northSea = 'OSPAR candidate indicators: North Sea';
/** Root-for-root topology of the Gadus morhua (AphiaID 126436) attribute tree: 33 roots, 73 nodes. */
const gadusMorhua = [
  society('Identifier'),
  society('OSPAR Region where species is under threat and/or in decline'),
  society('OSPAR Region where species is under threat and/or in decline'),
  ...Array.from({ length: 3 }, () => society('HELCOM core biodiversity indicators')),
  society(greaterNorthSea),
  society(greaterNorthSea),
  society(celticSeas),
  society(celticSeas),
  society(celticSeas),
  society(northSea),
  society(northSea),
  society(celticSeas),
  chain('Body size', 'Unit', 'Type', 'Locality (MRGID)'),
  society('OSPAR common indicators: Greater North Sea'),
  society('OSPAR common indicators: Celtic Seas'),
  society('OSPAR common indicators: Bay of Biscay and Iberian Coast'),
  society(greaterNorthSea),
  society(greaterNorthSea),
  society(celticSeas),
  society(celticSeas),
  society(celticSeas),
  society(northSea),
  society(northSea),
  society(celticSeas),
  chain('Body size', 'Unit', 'Type', 'Dimension', 'Sex'),
  chain('Body size', 'Unit', 'Type', 'Dimension', 'Sex'),
  attr('Paraphyletic group'),
  society('HELCOM Red List Category'),
  attr('Species exhibits underwater soniferous behaviour'),
  attr('Nomenclature code'),
  society('IUCN Red List Category', 'Criteria', 'Year Assessed'),
];
type TraitRow = {
  nodeIndex: number;
  parentIndex: number | null;
  measurementType?: string | null;
};
/** Reference selection: each match, every ancestor, and every descendant, as node indices. */
function expectedSelection(tree: TraitRow[], type: string) {
  const keep = new Set<number>();
  for (const node of tree) {
    if (node.measurementType?.toLowerCase() !== type.toLowerCase()) continue;
    for (let at: number | null = node.nodeIndex; at !== null; at = tree[at]?.parentIndex ?? null)
      keep.add(at);
    const pending = [node.nodeIndex];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      keep.add(at);
      pending.push(...tree.filter((child) => child.parentIndex === at).map((c) => c.nodeIndex));
    }
  }
  return [...keep].sort((a, b) => a - b);
}

describe('trait measurementType filter', () => {
  /** Every fixture here answers the status read, so a statusError on any call is a regression. */
  const traits = async (input: Parameters<typeof runToolContract<typeof getTraitsTool>>[1]) => {
    const result = await runToolContract(getTraitsTool, input);
    expect(result.structuredContent).not.toHaveProperty('statusError');
    return result;
  };
  const collectTree = (tree: object[], measurementType?: string) => {
    fakeFetch(withStatus(null, () => Response.json(tree)));
    return collectLocal(
      (resultOffset) =>
        traits({ aphiaId: 126436, resultOffset, ...(measurementType ? { measurementType } : {}) }),
      'traits',
    ) as Promise<TraitRow[]>;
  };

  it.each([
    ['Body size', 14],
    ['Sex', 10],
    ['IUCN Red List Category', 4],
    ['Species importance to society', 56],
  ] as const)(
    'returns %j matches with subtrees and ancestors (%i of 73 nodes), topology unchanged',
    async (measurementType, count) => {
      const tree = await collectTree(gadusMorhua);
      expect(tree).toHaveLength(73);
      const network = fakeFetch(withStatus(null, () => Response.json(gadusMorhua)));
      const first = await settle(traits({ aphiaId: 126436, measurementType }));
      expectParity(first);
      expect(first.structuredContent).toMatchObject({
        unfilteredCount: 73,
        totalCount: count,
        echo: { includeInherited: true, measurementType },
      });
      expect(first.structuredContent).not.toHaveProperty('notice');
      expect(network.calls.map((url) => url.pathname)).toEqual([
        '/rest/AphiaRecordByAphiaID/126436',
        '/rest/AphiaAttributesByAphiaID/126436',
      ]);
      const filtered = await collectTree(gadusMorhua, measurementType);
      expect(filtered.map((node) => node.nodeIndex)).toEqual(
        expectedSelection(tree, measurementType),
      );
      expect(filtered).toHaveLength(count);
      expect(filtered).toEqual(filtered.map((node) => tree[node.nodeIndex]));
    },
  );
  it('pins the Body size selection to the three Body size trees', async () => {
    const filtered = await collectTree(gadusMorhua, 'Body size');
    expect(filtered.map((node) => node.nodeIndex)).toEqual([
      28, 29, 30, 31, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63,
    ]);
  });
  it.each(['Body size', 'body size', 'BODY SIZE'])(
    'matches %j case-insensitively on the whole value only',
    async (measurementType) => {
      const tree = [
        attr('Body size (qualitative)'),
        chain('Body size', 'Unit'),
        attr(' Body size '),
      ];
      const filtered = await collectTree(tree, measurementType);
      expect(filtered.map((node) => [node.nodeIndex, node.measurementType])).toEqual([
        [1, 'Body size'],
        [2, 'Unit'],
      ]);
    },
  );
  it.each([' Body size', 'Body size ', 'null'])(
    'matches nothing for untrimmed or absent type %j and says how to recover',
    async (measurementType) => {
      fakeFetch(
        withStatus(null, () => Response.json([chain('Body size', 'Unit'), attr(null), {}])),
      );
      const result = await settle(traits({ aphiaId: 1, measurementType }));
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        traits: [],
        totalCount: 0,
        unfilteredCount: 4,
        nextResultOffset: null,
        echo: { includeInherited: true, measurementType },
      });
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain('worms_get_traits without measurementType');
      expect(notice).toContain('worms_list_reference with topic: trait_types');
    },
  );
  it.each(['', '   '])('treats blank filter %j as unset', async (measurementType) => {
    fakeFetch(withStatus(null, () => Response.json([chain('Body size', 'Unit'), attr('Sex')])));
    const result = await settle(traits({ aphiaId: 1, measurementType }));
    expectParity(result);
    expect(result.structuredContent).toMatchObject({ totalCount: 3, unfilteredCount: 3 });
    expect((result.structuredContent as { echo: object }).echo).toStrictEqual({
      includeInherited: true,
    });
  });
  it('returns overlapping matches and shared ancestors once, in preorder', async () => {
    const tree = [
      attr('X', attr('A', attr('a', attr('U'))), attr('B', attr('A')), attr('C')),
      attr(null, attr(null)),
    ];
    const filtered = await collectTree(tree, 'a');
    expect(
      filtered.map((node) => [node.nodeIndex, node.parentIndex, node.measurementType]),
    ).toEqual([
      [0, null, 'X'],
      [1, 0, 'A'],
      [2, 1, 'a'],
      [3, 2, 'U'],
      [4, 0, 'B'],
      [5, 4, 'A'],
    ]);
  });
  it.each([true, false])(
    'filters only the tree returned for includeInherited=%s',
    async (includeInherited) => {
      fakeFetch(
        withStatus(null, (url) =>
          Response.json(
            url.searchParams.get('include_inherited') === 'true'
              ? [chain('Body size', 'Unit'), attr('Sex'), chain('Body size', 'Unit')]
              : [attr('Sex'), chain('Body size', 'Unit')],
          ),
        ),
      );
      const result = await settle(
        traits({ aphiaId: 1, includeInherited, measurementType: 'Body size' }),
      );
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        unfilteredCount: includeInherited ? 5 : 3,
        totalCount: includeInherited ? 4 : 2,
        echo: { includeInherited, measurementType: 'Body size' },
      });
    },
  );
  it.each([true, false])(
    'keeps the inheritance notice for an empty tree with inheritance=%s',
    async (includeInherited) => {
      fakeFetch(withStatus(null, () => new Response(null, { status: 204 })));
      const result = await settle(
        traits({ aphiaId: 1, includeInherited, measurementType: 'Body size' }),
      );
      expectParity(result);
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain(includeInherited ? 'inheritance enabled' : 'includeInherited: true');
      expect(notice).not.toContain('without measurementType');
      expect(result.structuredContent).toMatchObject({ unfilteredCount: 0, totalCount: 0 });
    },
  );
  it('rejects an oversized filter before fetching', async () => {
    offline();
    const result = await settle(traits({ aphiaId: 1, measurementType: 'x'.repeat(513) }));
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
  });
});

describe('external crosswalk evidence', () => {
  it.each(['NCBI', ' ncbi '])('normalizes input identifier vocabulary %j', async (type) => {
    const network = fakeFetch((url) => {
      expect(url.searchParams.get('type')).toBe('ncbi');
      return Response.json(['0001']);
    });
    const result = await settle(runToolContract(crosswalkIdTool, { aphiaId: 1, type }));
    expectParity(result);
    expect(result.structuredContent).toMatchObject({ type: 'ncbi', ids: { ncbi: ['0001'] } });
    expect(network.calls).toHaveLength(1);
  });
  it('requests every supported type explicitly in fixed order, retaining opaque IDs and empty successes', async () => {
    const network = fakeFetch((url) => {
      expect(url.pathname).toBe('/rest/AphiaExternalIDByAphiaID/1');
      return url.searchParams.get('type') === 'iucn'
        ? new Response(null, { status: 204 })
        : Response.json(['0001', 'urn:lsid:test:1', '0001']);
    });
    const result = await settle(runToolContract(crosswalkIdTool, { aphiaId: 1 }));
    expectParity(result);
    expect(network.calls.map((url) => url.searchParams.get('type'))).toEqual(externalTypes);
    expect(result.structuredContent).toMatchObject({
      direction: 'forward',
      found: null,
      record: null,
      ids: { algaebase: ['0001', 'urn:lsid:test:1', '0001'], iucn: [] },
      failedTypes: [],
      echo: { requestedTypes: externalTypes },
    });
    for (let i = 1; i < network.starts.length; i++)
      expect((network.starts[i] ?? 0) - (network.starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(500);
  });
  it('returns classified partial outages separately from successful absence', async () => {
    fakeFetch((url) =>
      url.searchParams.get('type') === 'bold'
        ? new Response(null, { status: 403 })
        : new Response(null, { status: 204 }),
    );
    const result = await settle(runToolContract(crosswalkIdTool, { aphiaId: 1 }));
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      ids: { algaebase: [], gisd: [] },
      failedTypes: [
        {
          type: 'bold',
          error: {
            reason: 'upstream_access_denied',
            retryable: false,
            recovery: declared(crosswalkIdTool, 'upstream_access_denied').recovery,
          },
        },
      ],
      notice: expect.stringContaining('bold'),
    });
    expect(result.structuredContent).not.toHaveProperty('ids.bold');
  });
  it('throws the fixed-order first failure when every type fails', async () => {
    fakeFetch(() => new Response(null, { status: 403 }));
    const result = await settle(runToolContract(crosswalkIdTool, { aphiaId: 1 }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'upstream_access_denied',
          failedTypes: externalTypes.map((type) => ({
            type,
            error: { reason: 'upstream_access_denied' },
          })),
        },
      },
    });
  });
  it.each([400, 422])(
    'rejects HTTP %i atomically after earlier success and cancels queued types',
    async (status) => {
      const network = fakeFetch((_url, _init, index) =>
        index === 0 ? Response.json(['1']) : new Response('untrusted private body', { status }),
      );
      const result = await settle(runToolContract(crosswalkIdTool, { aphiaId: 1 }));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'upstream_rejected' } },
      });
      expect(network.calls).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain('untrusted private body');
    },
  );
  it.each([true, false])(
    'encodes opaque reverse IDs without additional lookups; found=%s',
    async (found) => {
      const network = fakeFetch((url) => {
        expect(url.pathname).toBe('/rest/AphiaRecordByExternalID/0001%2Fa%20b');
        expect(url.searchParams.toString()).toBe('type=lsid');
        return found
          ? Response.json(record(1, { scientificname: null, citation: 'A\r\nB' }))
          : new Response(null, { status: 204 });
      });
      const result = await settle(
        runToolContract(crosswalkIdTool, { externalId: '0001/a b', type: 'lsid' }),
      );
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        direction: 'reverse',
        externalId: '0001/a b',
        found,
        aphiaId: found ? 1 : null,
        ids: {},
        failedTypes: [],
      });
      expect(network.calls).toHaveLength(1);
    },
  );
  it.each([
    [{}, 'invalid_selector'],
    [{ aphiaId: 1, externalId: '1' }, 'invalid_selector'],
    [{ externalId: '0001' }, 'missing_external_type'],
  ] as const)('rejects selector %j before fetch', async (input, reason) => {
    offline();
    const result = await settle(runToolContract(crosswalkIdTool, input));
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason, recovery: expect.anything() } },
    });
  });
  it('rejects unsupported types at the schema boundary', async () => {
    offline();
    const result = await settle(runToolContract(crosswalkIdTool, { aphiaId: 1, type: 'gbif' }));
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
  });
  it('discards earlier successes when the whole-tool deadline expires', async () => {
    const network = fakeFetch((_url, init, index) =>
      index === 0 ? Response.json(['0001']) : hang(init),
    );
    const result = await settle(runToolContract(crosswalkIdTool, { aphiaId: 1 }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'upstream_timeout' } },
    });
    expect(result.structuredContent).not.toHaveProperty('ids');
    const stopped = network.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(network.calls).toHaveLength(stopped);
  });
  it('cancels queued and in-flight lookups without returning partial evidence', async () => {
    const abort = new AbortController();
    const network = fakeFetch((_url, init) => hang(init));
    const pending = runToolContract(
      crosswalkIdTool,
      { aphiaId: 1 },
      { context: { signal: abort.signal } },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(network.calls).toHaveLength(1);
    abort.abort();
    const result = await settle(pending);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(JSON.stringify(result.content)).toContain('cancel');
    await vi.advanceTimersByTimeAsync(50_000);
    expect(network.calls).toHaveLength(1);
  });
});

describe('default-mode characterization', () => {
  const accepted = record(7, { status: 'accepted', valid_AphiaID: 7 });
  const paths = (calls: URL[]) => calls.map((url) => url.pathname);
  it("returns one ID's distribution rows unchanged, with no union or status fields", async () => {
    const row = { locality: 'A', locationID: '001', recordStatus: 'valid', decimalLatitude: 1.5 };
    const network = fakeFetch(withStatus(accepted, () => Response.json([row, row, {}])));
    const result = await settle(runToolContract(getDistributionsTool, { aphiaId: 7 }));
    expectParity(result);
    const data = result.structuredContent as Record<string, unknown>;
    const normalized = { locality: 'A', locationId: '001', recordStatus: 'valid', latitude: 1.5 };
    expect(data.distributions).toStrictEqual([normalized, normalized, {}]);
    expect(data).toMatchObject({
      aphiaId: 7,
      unfilteredCount: 3,
      filteredCount: 3,
      totalCount: 3,
      echo: {},
    });
    for (const key of ['synonymUnion', 'statusError', 'notice'])
      expect(data).not.toHaveProperty(key);
    expect(paths(network.calls)).toEqual([
      '/rest/AphiaRecordByAphiaID/7',
      '/rest/AphiaDistributionsByAphiaID/7',
    ]);
  });
  it('returns the complete trait tree with only includeInherited echoed', async () => {
    const network = fakeFetch(
      withStatus(accepted, () =>
        Response.json([
          { measurementType: 'Body size', children: [{ measurementType: 'Unit' }] },
          { measurementType: null },
        ]),
      ),
    );
    const result = await settle(runToolContract(getTraitsTool, { aphiaId: 7 }));
    expectParity(result);
    const data = result.structuredContent as Record<string, unknown>;
    const root = { parentIndex: null, depth: 0, parentType: null, inheritedFrom: null };
    expect(data.traits).toStrictEqual([
      { ...root, nodeIndex: 0, measurementType: 'Body size' },
      {
        nodeIndex: 1,
        parentIndex: 0,
        depth: 1,
        measurementType: 'Unit',
        parentType: 'Body size',
        inheritedFrom: null,
      },
      { ...root, nodeIndex: 2, measurementType: null },
    ]);
    expect(data).toMatchObject({ totalCount: 3, returnedCount: 3, nextResultOffset: null });
    expect(data.echo).toStrictEqual({ includeInherited: true });
    for (const key of ['statusError', 'notice']) expect(data).not.toHaveProperty(key);
    expect(paths(network.calls)).toEqual([
      '/rest/AphiaRecordByAphiaID/7',
      '/rest/AphiaAttributesByAphiaID/7',
    ]);
  });
  it("returns the submitted ID's own lineage with no status fields", async () => {
    const network = fakeFetch(
      withStatus(accepted, () =>
        Response.json({ AphiaID: 2, rank: 'Kingdom', child: { AphiaID: 7, scientificname: 'X' } }),
      ),
    );
    const result = await settle(runToolContract(getClassificationTool, { aphiaId: 7 }));
    expectParity(result);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.ranks).toStrictEqual([
      { aphiaId: 2, rank: 'Kingdom' },
      { aphiaId: 7, scientificname: 'X' },
    ]);
    expect(data).toMatchObject({ found: true, guidance: null });
    for (const key of ['statusError', 'notice']) expect(data).not.toHaveProperty(key);
    expect(paths(network.calls)).toEqual([
      '/rest/AphiaRecordByAphiaID/7',
      '/rest/AphiaClassificationByAphiaID/7',
    ]);
  });
});

type Upstream = {
  /** Status records by AphiaID; absent IDs answer 204. */
  records?: Record<number, Record<string, unknown>>;
  /** Complete synonym lists by accepted AphiaID, served 50 per one-based `offset`. */
  synonyms?: Record<number, Record<string, unknown>[]>;
  /** Distribution rows by AphiaID; absent or empty IDs answer 204. */
  distributions?: Record<number, Record<string, unknown>[]>;
  attributes?: Record<number, Record<string, unknown>[]>;
  classification?: Record<number, Record<string, unknown>>;
  /** Per-path override, consulted before the tables above. */
  override?: (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined;
};
const endpointPath =
  /^\/rest\/(AphiaRecordByAphiaID|AphiaSynonymsByAphiaID|AphiaDistributionsByAphiaID|AphiaAttributesByAphiaID|AphiaClassificationByAphiaID)\/(\d+)$/;
/** Route every evidence endpoint by exact path; an unrouted endpoint fails the test. */
function upstream(data: Upstream) {
  return fakeFetch((url, init) => {
    const custom = data.override?.(url, init);
    if (custom) return custom;
    const [, endpoint, rawId] = endpointPath.exec(url.pathname) ?? [];
    expect(endpoint, url.pathname).toBeDefined();
    const id = Number(rawId);
    const offset = Number(url.searchParams.get('offset'));
    const body =
      endpoint === 'AphiaRecordByAphiaID'
        ? data.records?.[id]
        : endpoint === 'AphiaSynonymsByAphiaID'
          ? data.synonyms?.[id]?.slice(offset - 1, offset + 49)
          : endpoint === 'AphiaDistributionsByAphiaID'
            ? data.distributions?.[id]
            : endpoint === 'AphiaAttributesByAphiaID'
              ? data.attributes?.[id]
              : data.classification?.[id];
    return body === undefined || (Array.isArray(body) && !body.length)
      ? new Response(null, { status: 204 })
      : Response.json(body);
  });
}
const pathOf = (url: URL) => `${url.pathname}${url.search}`;
/** A forced upstream failure: an exhausted attempt timeout, or an HTTP status. */
const forced = (failure: 'timeout' | number, init: RequestInit | undefined) =>
  failure === 'timeout' ? hang(init) : new Response(null, { status: failure });

describe('taxonomic status on evidence tools', () => {
  it.each([getClassificationTool, getDistributionsTool, getTraitsTool])(
    '$name identifies an accepted alternative and preferred ID while retaining submitted evidence',
    async (tool) => {
      const network = upstream({
        records: {
          1804094: record(1804094, {
            status: 'alternative representation',
            valid_AphiaID: 140480,
            scientificname: 'upstream name must stay out',
          }),
        },
        classification: { 1804094: { AphiaID: 2, child: { AphiaID: 1804094 } } },
        distributions: { 1804094: [{ locality: 'A' }] },
        attributes: { 1804094: [{ measurementType: 'A', children: [{ measurementValue: 'B' }] }] },
      });
      const result = await settle(runToolContract(tool, { aphiaId: 1804094 }));
      expectParity(result);
      const data = result.structuredContent as { notice: string };
      expect(data.notice).toContain(
        'AphiaID 1804094 is an accepted alternative representation; WoRMS links it to preferred AphiaID 140480.',
      );
      expect(data.notice).toContain(`${tool.name} with aphiaId: 140480`);
      expect(data.notice).not.toContain('not the accepted');
      expect(data.notice).not.toContain('upstream name');
      expect(network.calls).toHaveLength(2);
      expect(network.calls.every((url) => url.pathname.endsWith('/1804094'))).toBe(true);
      if (tool === getClassificationTool)
        expect(result.structuredContent).toMatchObject({
          ranks: [{ aphiaId: 2 }, { aphiaId: 1804094 }],
        });
    },
  );
  const unaccepted = record(1298345, {
    scientificname: 'Testudo caretta',
    status: 'superseded combination',
    valid_AphiaID: 137205,
    valid_name: 'Caretta caretta',
  });
  const lineage = { AphiaID: 2, scientificname: 'Testudinidae', child: { AphiaID: 1298345 } };
  const evidence = {
    distributions: {
      tool: getDistributionsTool,
      evidence: '/rest/AphiaDistributionsByAphiaID',
      retry: 'worms_get_distributions with aphiaId: 137205',
      empty: 'worms_get_taxon to check the AphiaID',
    },
    traits: {
      tool: getTraitsTool,
      evidence: '/rest/AphiaAttributesByAphiaID',
      retry: 'worms_get_traits with aphiaId: 137205',
      empty: 'inheritance enabled',
    },
    classification: {
      tool: getClassificationTool,
      evidence: '/rest/AphiaClassificationByAphiaID',
      retry: 'worms_get_classification with aphiaId: 137205',
      empty: null,
    },
  } as const;
  const names = Object.keys(evidence) as (keyof typeof evidence)[];
  const call = (name: keyof typeof evidence, aphiaId: number) =>
    settle(runToolContract(evidence[name].tool, { aphiaId }));
  const statusRows: [label: string, row: Record<string, unknown> | undefined][] = [
    ['accepted', record(1, { status: 'accepted', valid_AphiaID: 1 })],
    ['self-valid', record(1, { status: 'temporary name', valid_AphiaID: 1 })],
    ['explicitly accepted without a link', record(1, { status: 'accepted' })],
    ['missing', undefined],
  ];

  it.each(names)(
    '%s names both numeric IDs and the retry for an unaccepted AphiaID, before the empty notice',
    async (name) => {
      const network = upstream({
        records: { 1298345: unaccepted },
        classification: { 1298345: lineage },
      });
      const result = await call(name, 1298345);
      expectParity(result);
      const data = result.structuredContent as Record<string, unknown> & { notice: string };
      expect(data.notice).toContain('AphiaID 1298345');
      expect(data.notice).toContain('AphiaID 137205');
      expect(data.notice).toContain(evidence[name].retry);
      if (name === 'distributions') {
        expect(data.notice).toContain('includeSynonyms: true');
        expect(data.notice).not.toContain('without filters');
      }
      for (const upstreamText of ['Testudo', 'Caretta', 'superseded'])
        expect(data.notice).not.toContain(upstreamText);
      const empty = evidence[name].empty;
      if (empty) expect(data.notice.indexOf(empty)).toBeGreaterThan(data.notice.indexOf('137205'));
      if (name === 'classification')
        expect(data.ranks).toEqual([
          { aphiaId: 2, scientificname: 'Testudinidae' },
          { aphiaId: 1298345 },
        ]);
      expect(data).not.toHaveProperty('statusError');
      expect(network.calls.map((url) => url.pathname)).toEqual([
        '/rest/AphiaRecordByAphiaID/1298345',
        `${evidence[name].evidence}/1298345`,
      ]);
    },
  );
  it.each(names.flatMap((name) => statusRows.map(([label, row]) => ({ name, label, row }))))(
    '$name adds no status notice for a $label record',
    async ({ name, row }) => {
      upstream({
        records: row ? { 1: row } : {},
        distributions: { 1: [{ locality: 'A' }] },
        attributes: { 1: [{ measurementType: 'Body size' }] },
        classification: { 1: { AphiaID: 1 } },
      });
      const result = await call(name, 1);
      expectParity(result);
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(result.structuredContent).not.toHaveProperty('statusError');
    },
  );
  it.each(names)(
    '%s points to worms_get_taxon when a non-accepted record links no accepted taxon',
    async (name) => {
      upstream({
        records: { 1: record(1, { status: 'nomen dubium', valid_AphiaID: null }) },
        distributions: { 1: [{ locality: 'A' }] },
        attributes: { 1: [{ measurementType: 'Body size' }] },
        classification: { 1: { AphiaID: 1 } },
      });
      const result = await call(name, 1);
      expectParity(result);
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain('worms_get_taxon with aphiaIds: [1]');
      expect(notice).not.toContain('nomen dubium');
    },
  );
  it.each(
    names.flatMap((name) =>
      (
        [
          [403, 'upstream_access_denied', false],
          [503, 'upstream_unavailable', true],
          ['timeout', 'upstream_timeout', true],
          ['malformed', 'invalid_upstream_response', false],
        ] as const
      ).map(([failure, reason, retryable]) => ({ name, failure, reason, retryable })),
    ),
  )(
    '$name returns its evidence with statusError when the status read fails ($failure)',
    async ({ name, failure, reason, retryable }) => {
      const status = '/rest/AphiaRecordByAphiaID/1';
      const network = upstream({
        override: (url, init) =>
          url.pathname !== status
            ? undefined
            : failure === 'malformed'
              ? Response.json([record(1)])
              : forced(failure, init),
        distributions: { 1: [{ locality: 'A' }] },
        attributes: { 1: [{ measurementType: 'Body size' }] },
        classification: { 1: { AphiaID: 1 } },
      });
      const result = await call(name, 1);
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        statusError: {
          reason,
          recovery: declared(evidence[name].tool, reason).recovery,
          retryable,
        },
      });
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(
        (result.structuredContent as Record<string, unknown[]>)[
          name === 'traits' ? 'traits' : name === 'classification' ? 'ranks' : 'distributions'
        ],
      ).toHaveLength(1);
      expect(network.calls.map((url) => url.pathname)).toEqual([
        status,
        ...(retryable ? [status] : []),
        `${evidence[name].evidence}/1`,
      ]);
    },
  );
  it.each(names)('%s fails atomically when WoRMS rejects the status read', async (name) => {
    const network = upstream({
      override: (url) =>
        url.pathname === '/rest/AphiaRecordByAphiaID/1'
          ? new Response('untrusted body', { status: 400 })
          : undefined,
    });
    const result = await call(name, 1);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'upstream_rejected' } },
    });
    expect(network.calls).toHaveLength(1);
  });
  it.each(names)('%s stays atomic when the caller cancels during the status read', async (name) => {
    const abort = new AbortController();
    const network = upstream({ override: (_url, init) => hang(init) });
    const pending = runToolContract(
      evidence[name].tool,
      { aphiaId: 1 },
      { context: { signal: abort.signal } },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(network.calls).toHaveLength(1);
    abort.abort();
    const result = await settle(pending);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(network.calls).toHaveLength(1);
  });
});

describe('recovery hints after a forced timeout or outage', () => {
  const reasonOf = (failure: 'timeout' | 503) =>
    failure === 'timeout' ? 'upstream_timeout' : 'upstream_unavailable';
  const thrown = [
    {
      name: getSynonymsTool.name,
      tool: getSynonymsTool,
      run: () => runToolContract(getSynonymsTool, { aphiaId: 1 }),
    },
    {
      name: crosswalkIdTool.name,
      tool: crosswalkIdTool,
      run: () => runToolContract(crosswalkIdTool, { aphiaId: 1, type: 'ncbi' }),
    },
  ];

  it.each(
    thrown.flatMap((call) => (['timeout', 503] as const).map((failure) => ({ ...call, failure }))),
  )('$name throws its own next step after a forced $failure', async ({ tool, run, failure }) => {
    fakeFetch((_url, init) => forced(failure, init));
    const result = await settle(run());
    const reason = reasonOf(failure);
    const hint = declared(tool, reason).recovery;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason, recovery: { hint } } },
    });
    expect(contentText(result)).toContain(hint);
    if (tool === crosswalkIdTool) {
      expect(result.structuredContent).toMatchObject({
        error: { data: { failedTypes: [{ type: 'ncbi', error: { reason, recovery: hint } }] } },
      });
      expect(hint).toContain(
        failure === 'timeout'
          ? 'if type was omitted, call worms_crosswalk_id with one type'
          : 'topic: external_id_types',
      );
    }
  });
  it.each(['timeout', 503] as const)(
    'worms_crosswalk_id records a forced %s on one type, keeping the others, with its guidance on both surfaces',
    async (failure) => {
      fakeFetch((url, init) =>
        url.searchParams.get('type') === 'bold' ? forced(failure, init) : Response.json(['0001']),
      );
      const result = await settle(runToolContract(crosswalkIdTool, { aphiaId: 1 }));
      expectParity(result);
      const reason = reasonOf(failure);
      const recovery = declared(crosswalkIdTool, reason).recovery;
      expect(result.structuredContent).toMatchObject({
        ids: { algaebase: ['0001'], gisd: ['0001'] },
        failedTypes: [{ type: 'bold', error: { reason, recovery } }],
        echo: { requestedTypes: externalTypes },
        notice:
          'Identifier lookups failed for bold; call worms_crosswalk_id with one failed type to retry.',
      });
      if (failure === 'timeout')
        expect(recovery).toContain('call worms_crosswalk_id with one type');
    },
  );
});

describe('distribution synonym union', () => {
  it('identifies an accepted alternative while paging preferred-ID and synonym rows', async () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({
      locality: `${index}:${'x'.repeat(300)}`,
    }));
    const network = upstream({
      records: {
        1804094: record(1804094, { status: 'alternative representation', valid_AphiaID: 140480 }),
      },
      synonyms: { 140480: [record(3)] },
      distributions: { 140480: rows, 3: [{ locality: 'synonym' }] },
    });
    const collected = await collectLocal(async (resultOffset) => {
      const before = network.calls.length;
      const result = await settle(
        runToolContract(getDistributionsTool, {
          aphiaId: 1804094,
          includeSynonyms: true,
          resultOffset,
        }),
      );
      expect(result.structuredContent).toMatchObject({
        notice:
          'AphiaID 1804094 is an accepted alternative representation; these rows combine preferred AphiaID 140480 and its synonyms.',
        synonymUnion: { acceptedAphiaId: 140480, synonymAphiaIds: [3] },
      });
      expect(network.calls.length - before).toBe(4);
      return result;
    }, 'distributions');
    expect(collected).toEqual([
      ...rows.map((row) => ({ sourceAphiaId: 140480, ...row })),
      { sourceAphiaId: 3, locality: 'synonym' },
    ]);
  });
  it('normalizes recordStatus in a synonym union before local continuation', async () => {
    const network = upstream({
      records: { 1: record(1, { status: 'accepted' }) },
      synonyms: { 1: [record(2)] },
      distributions: {
        1: [{ recordStatus: 'valid', locality: 'A' }],
        2: [{ recordStatus: 'valid', locality: 'B' }],
      },
    });
    const result = await settle(
      runToolContract(getDistributionsTool, {
        aphiaId: 1,
        includeSynonyms: true,
        recordStatus: ' VaLiD ',
        resultOffset: 1,
      }),
    );
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      unfilteredCount: 2,
      filteredCount: 2,
      distributions: [{ sourceAphiaId: 2, locality: 'B' }],
      echo: { recordStatus: 'valid' },
    });
    expect(network.calls).toHaveLength(4);
  });
  const rows = (id: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      locality: `${id}:${i}:${'x'.repeat(300)}`,
      occurrence: i % 2 ? 'present' : null,
    }));
  const tagged = (id: number, count: number) =>
    rows(id, count).map(({ locality, occurrence }) => ({
      sourceAphiaId: id,
      locality,
      occurrence,
    }));
  const oyster = {
    records: {
      836033: record(836033, { status: 'accepted', valid_AphiaID: 836033 }),
      140656: record(140656, { status: 'superseded combination', valid_AphiaID: 836033 }),
    },
    synonyms: { 836033: [record(1545899), record(140656), record(605705)] },
    distributions: { 836033: rows(836033, 8), 140656: rows(140656, 104), 605705: rows(605705, 1) },
  };
  const union = (input: Parameters<typeof runToolContract<typeof getDistributionsTool>>[1]) =>
    settle(runToolContract(getDistributionsTool, { includeSynonyms: true, ...input }));

  it.each([836033, 140656])(
    'reassembles the same 113 tagged rows from AphiaID %i across resultOffset segments',
    async (aphiaId) => {
      const network = upstream(oyster);
      const first = await union({ aphiaId });
      expectParity(first);
      expect(first.structuredContent).toMatchObject({
        aphiaId,
        unfilteredCount: 113,
        filteredCount: 113,
        totalCount: 113,
        synonymUnion: {
          acceptedAphiaId: 836033,
          synonymOffset: 0,
          synonymAphiaIds: [1545899, 140656, 605705],
          nextSynonymOffset: null,
          failedSynonyms: [],
        },
      });
      const notice = (first.structuredContent as { notice?: string }).notice;
      if (aphiaId === 836033) expect(notice).toBeUndefined();
      else {
        expect(notice).toContain('AphiaID 140656');
        expect(notice).toContain('accepted AphiaID 836033 and its synonyms');
        expect(notice).not.toContain('superseded');
      }
      expect(network.calls.slice(0, 6).map(pathOf)).toEqual([
        `/rest/AphiaRecordByAphiaID/${aphiaId}`,
        '/rest/AphiaSynonymsByAphiaID/836033?offset=1',
        '/rest/AphiaDistributionsByAphiaID/836033',
        '/rest/AphiaDistributionsByAphiaID/1545899',
        '/rest/AphiaDistributionsByAphiaID/140656',
        '/rest/AphiaDistributionsByAphiaID/605705',
      ]);
      const collected = await collectLocal(
        (resultOffset) =>
          runToolContract(getDistributionsTool, { aphiaId, includeSynonyms: true, resultOffset }),
        'distributions',
      );
      expect(collected).toEqual([
        ...tagged(836033, 8),
        ...tagged(140656, 104),
        ...tagged(605705, 1),
      ]);
    },
  );
  it('filters across the window before slicing and counts the window', async () => {
    upstream(oyster);
    const result = await union({ aphiaId: 836033, occurrence: 'PRESENT' });
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      unfilteredCount: 113,
      filteredCount: 4 + 52,
      totalCount: 56,
      echo: { occurrence: 'PRESENT' },
    });
    const collected = await collectLocal(
      (resultOffset) =>
        runToolContract(getDistributionsTool, {
          aphiaId: 836033,
          includeSynonyms: true,
          occurrence: 'PRESENT',
          resultOffset,
        }),
      'distributions',
    );
    expect(collected).toEqual(
      [...tagged(836033, 8), ...tagged(140656, 104)].filter((row) => row.occurrence),
    );
  });
  it.each([
    { size: 74, windows: [0, 10, 20, 30, 40, 50, 60, 70] },
    { size: 50, windows: [0, 10, 20, 30, 40, 50] },
  ])(
    'walks a $size-synonym list ten at a time across the 50-row page boundary',
    async ({ size, windows }) => {
      const ids = Array.from({ length: size }, (_, i) => 2000 + i);
      const network = upstream({
        records: { 1: record(1, { status: 'accepted' }) },
        synonyms: { 1: ids.map((id) => record(id)) },
        distributions: Object.fromEntries([1, ...ids].map((id) => [id, [{ locality: `${id}` }]])),
      });
      const seen: number[] = [];
      const offsets: number[] = [];
      for (let synonymOffset: number | null = 0; synonymOffset !== null; ) {
        offsets.push(synonymOffset);
        const before = network.calls.length;
        const result = await union({ aphiaId: 1, synonymOffset });
        expectParity(result);
        const data = result.structuredContent as {
          distributions: { sourceAphiaId: number }[];
          synonymUnion: { synonymAphiaIds: number[]; nextSynonymOffset: number | null };
        };
        const window = data.synonymUnion.synonymAphiaIds;
        expect(window).toEqual(ids.slice(synonymOffset, synonymOffset + 10));
        expect(data.distributions.map((row) => row.sourceAphiaId)).toEqual(
          synonymOffset ? window : [1, ...window],
        );
        const calls = network.calls.slice(before);
        expect(pathOf(calls[1] as URL)).toBe(
          `/rest/AphiaSynonymsByAphiaID/1?offset=${synonymOffset < 50 ? 1 : 51}`,
        );
        expect(calls).toHaveLength(2 + (synonymOffset ? 0 : 1) + window.length);
        seen.push(...window);
        synonymOffset = data.synonymUnion.nextSynonymOffset;
      }
      expect(offsets).toEqual(windows);
      expect(seen).toEqual(ids);
    },
  );
  it('makes at most 13 paced requests per call, one synonym read at a time', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => 3000 + i);
    const network = upstream({
      records: { 1: record(1, { status: 'accepted' }) },
      synonyms: { 1: ids.map((id) => record(id)) },
      distributions: { 1: [{ locality: 'A' }] },
    });
    const result = await union({ aphiaId: 1 });
    expectParity(result);
    expect(network.calls).toHaveLength(13);
    for (let i = 1; i < network.starts.length; i++)
      expect((network.starts[i] ?? 0) - (network.starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(500);
    expect(result.structuredContent).toMatchObject({
      synonymUnion: { synonymAphiaIds: ids.slice(0, 10), nextSynonymOffset: 10 },
    });
  });
  it('queues one synonym read at a time, so a concurrent call is served between them', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => 3000 + i);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const network = upstream({
      records: { 1: record(1, { status: 'accepted' }), 2: record(2, { status: 'accepted' }) },
      synonyms: { 1: ids.map((id) => record(id)) },
      override: (url) =>
        url.pathname === '/rest/AphiaDistributionsByAphiaID/3000'
          ? held.then(() => new Response(null, { status: 204 }))
          : undefined,
    });
    const pending = runToolContract(getDistributionsTool, { aphiaId: 1, includeSynonyms: true });
    for (let tick = 0; tick < 100 && network.calls.length < 4; tick++)
      await vi.advanceTimersByTimeAsync(100);
    const concurrent = runToolContract(getDistributionsTool, { aphiaId: 2 });
    await vi.advanceTimersByTimeAsync(100);
    release();
    expectParity(await settle(pending));
    expectParity(await settle(concurrent));
    expect(network.calls.slice(3, 6).map((url) => url.pathname)).toEqual([
      '/rest/AphiaDistributionsByAphiaID/3000',
      '/rest/AphiaRecordByAphiaID/2',
      '/rest/AphiaDistributionsByAphiaID/3001',
    ]);
  });
  it.each([
    { synonymOffset: 45, window: [2045, 2046, 2047, 2048, 2049], next: 50, page: 1 },
    { synonymOffset: 80, window: [], next: null, page: 51 },
  ])(
    'serves synonymOffset $synonymOffset from the one page containing it',
    async ({ synonymOffset, window, next, page }) => {
      const ids = Array.from({ length: 74 }, (_, i) => 2000 + i);
      const network = upstream({
        records: { 1: record(1, { status: 'accepted' }) },
        synonyms: { 1: ids.map((id) => record(id)) },
      });
      const result = await union({ aphiaId: 1, synonymOffset });
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        distributions: [],
        unfilteredCount: 0,
        synonymUnion: { synonymOffset, synonymAphiaIds: window, nextSynonymOffset: next },
        notice: 'Call worms_get_taxon to check the AphiaID.',
      });
      expect(network.calls.map(pathOf)).toEqual([
        '/rest/AphiaRecordByAphiaID/1',
        `/rest/AphiaSynonymsByAphiaID/1?offset=${page}`,
        ...window.map((id) => `/rest/AphiaDistributionsByAphiaID/${id}`),
      ]);
    },
  );
  it.each([
    [403, 'upstream_access_denied', false],
    [503, 'upstream_unavailable', true],
  ] as const)(
    'records a synonym read failing with HTTP %i and keeps the other sources',
    async (status, reason, retryable) => {
      upstream({
        ...oyster,
        override: (url) =>
          url.pathname === '/rest/AphiaDistributionsByAphiaID/140656'
            ? new Response(null, { status })
            : undefined,
      });
      const result = await union({ aphiaId: 836033 });
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        unfilteredCount: 9,
        synonymUnion: {
          synonymAphiaIds: [1545899, 140656, 605705],
          failedSynonyms: [
            {
              aphiaId: 140656,
              error: {
                reason,
                retryable,
                recovery: declared(getDistributionsTool, reason).recovery,
              },
            },
          ],
        },
      });
      expect(
        (result.structuredContent as { distributions: { sourceAphiaId: number }[] }).distributions
          .map((row) => row.sourceAphiaId)
          .filter((id) => id === 140656),
      ).toEqual([]);
    },
  );
  it.each([
    ['status record', '/rest/AphiaRecordByAphiaID/836033', 403, 'upstream_access_denied'],
    ['synonym page', '/rest/AphiaSynonymsByAphiaID/836033', 403, 'upstream_access_denied'],
    ['accepted rows', '/rest/AphiaDistributionsByAphiaID/836033', 403, 'upstream_access_denied'],
    [
      'rejected synonym rows',
      '/rest/AphiaDistributionsByAphiaID/1545899',
      400,
      'upstream_rejected',
    ],
  ] as const)('fails atomically on the %s read', async (_label, path, status, reason) => {
    const network = upstream({
      ...oyster,
      override: (url) => (url.pathname === path ? new Response(null, { status }) : undefined),
    });
    const result = await union({ aphiaId: 836033 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { data: { reason } } });
    expect(result.structuredContent).not.toHaveProperty('distributions');
    expect(network.calls.map((url) => url.pathname)).not.toContain(
      '/rest/AphiaDistributionsByAphiaID/605705',
    );
  });
  it.each([
    ['a non-accepted record without a link', record(5, { status: 'nomen dubium' })],
    ['a missing record', undefined],
  ])('returns only the submitted rows for %s', async (_label, row) => {
    const network = upstream({
      records: row ? { 5: row } : {},
      distributions: { 5: rows(5, 2) },
    });
    const result = await union({ aphiaId: 5 });
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      distributions: tagged(5, 2),
      synonymUnion: {
        acceptedAphiaId: null,
        synonymOffset: 0,
        synonymAphiaIds: [],
        nextSynonymOffset: null,
        failedSynonyms: [],
      },
      notice: expect.stringContaining('worms_get_taxon with aphiaIds: [5]'),
    });
    expect((result.structuredContent as { notice: string }).notice).not.toContain('nomen');
    expect(network.calls.map((url) => url.pathname)).toEqual([
      '/rest/AphiaRecordByAphiaID/5',
      '/rest/AphiaDistributionsByAphiaID/5',
    ]);
  });
  it.each([
    ['a non-accepted record without a link', record(5, { status: 'nomen dubium' })],
    ['a missing record', undefined],
  ])('returns an empty window past the end for %s', async (_label, row) => {
    const network = upstream({
      records: row ? { 5: row } : {},
      distributions: { 5: rows(5, 2) },
    });
    const result = await union({ aphiaId: 5, synonymOffset: 10 });
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      distributions: [],
      unfilteredCount: 0,
      totalCount: 0,
      nextResultOffset: null,
      synonymUnion: {
        acceptedAphiaId: null,
        synonymOffset: 10,
        synonymAphiaIds: [],
        nextSynonymOffset: null,
        failedSynonyms: [],
      },
      notice: expect.stringContaining('worms_get_taxon with aphiaIds: [5]'),
    });
    expect(network.calls.map((url) => url.pathname)).toEqual(['/rest/AphiaRecordByAphiaID/5']);
  });
  it('ignores synonymOffset without includeSynonyms', async () => {
    const network = upstream(oyster);
    const result = await settle(
      runToolContract(getDistributionsTool, { aphiaId: 836033, synonymOffset: 20 }),
    );
    expectParity(result);
    const data = result.structuredContent as { distributions: object[] };
    expect(data.distributions).toEqual(
      rows(836033, 8).map(({ locality, occurrence }) => ({ locality, occurrence })),
    );
    expect(data).not.toHaveProperty('synonymUnion');
    expect(network.calls.map((url) => url.pathname)).toEqual([
      '/rest/AphiaRecordByAphiaID/836033',
      '/rest/AphiaDistributionsByAphiaID/836033',
    ]);
  });
  it('discards the window when the whole-tool deadline expires during synonym reads', async () => {
    const network = upstream({
      ...oyster,
      override: (url, init) =>
        [1545899, 140656, 605705].some(
          (id) => url.pathname === `/rest/AphiaDistributionsByAphiaID/${id}`,
        )
          ? hang(init)
          : undefined,
    });
    const result = await union({ aphiaId: 836033 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'upstream_timeout' } },
    });
    expect(result.structuredContent).not.toHaveProperty('distributions');
    const stopped = network.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(network.calls).toHaveLength(stopped);
  });
  it('cancels a union without returning partial rows', async () => {
    const abort = new AbortController();
    const network = upstream({
      ...oyster,
      override: (url, init) =>
        url.pathname === '/rest/AphiaDistributionsByAphiaID/140656' ? hang(init) : undefined,
    });
    const pending = runToolContract(
      getDistributionsTool,
      { aphiaId: 836033, includeSynonyms: true },
      { context: { signal: abort.signal } },
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(network.calls.at(-1)?.pathname).toBe('/rest/AphiaDistributionsByAphiaID/140656');
    abort.abort();
    const result = await settle(pending);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    const stopped = network.calls.length;
    await vi.advanceTimersByTimeAsync(50_000);
    expect(network.calls).toHaveLength(stopped);
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects synonymOffset %s before fetching',
    async (synonymOffset) => {
      const network = upstream({});
      const result = await union({ aphiaId: 1, synonymOffset });
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(network.calls).toHaveLength(0);
    },
  );
});
