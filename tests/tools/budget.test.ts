/**
 * @fileoverview Complete-result budget and lossless stateless continuation contracts.
 * @module tests/tools/budget.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { crosswalkIdTool } from '@/mcp-server/tools/definitions/crosswalk-id.tool.js';
import { getClassificationTool } from '@/mcp-server/tools/definitions/get-classification.tool.js';
import { getDistributionsTool } from '@/mcp-server/tools/definitions/get-distributions.tool.js';
import { getSynonymsTool } from '@/mcp-server/tools/definitions/get-synonyms.tool.js';
import { getTaxonTool } from '@/mcp-server/tools/definitions/get-taxon.tool.js';
import { getTraitsTool } from '@/mcp-server/tools/definitions/get-traits.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { resolveTaxonTool } from '@/mcp-server/tools/definitions/resolve-taxon.tool.js';
import {
  collectLocal,
  expectParity,
  fakeFetch,
  record,
  settle,
  setupWorms,
} from '../helpers/worms.js';

beforeEach(setupWorms);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('bounds complete results and reassembles Unicode distribution evidence', async () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({
    locality: `${i}:海🌊\\"\n${'x'.repeat(200)}`,
    occurrence: null,
  }));
  fakeFetch(() => Response.json(rows));
  const collected: unknown[] = [];
  let resultOffset = 0;
  for (let page = 0; page < 80; page++) {
    const result = await settle(
      runToolContract(getDistributionsTool, {
        aphiaId: 1,
        ...(resultOffset ? { resultOffset } : {}),
      }),
    );
    expectParity(result);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24000);
    const data = result.structuredContent as {
      distributions: unknown[];
      nextResultOffset: number | null;
    };
    collected.push(...data.distributions);
    if (data.nextResultOffset === null) break;
    expect(data.nextResultOffset).toBeGreaterThan(resultOffset);
    resultOffset = data.nextResultOffset;
  }
  expect(collected).toEqual(rows);
});

it.each(['names', 'ids'] as const)(
  'continues 500 duplicate maximum inputs without copying deferred %s',
  async (mode) => {
    const name = '海'.repeat(512);
    fakeFetch((url) =>
      mode === 'names'
        ? Response.json(
            url.searchParams
              .getAll('scientificnames[]')
              .map(() => [record(1, { scientificname: name, authority: null })]),
          )
        : Response.json(
            url.searchParams
              .getAll('aphiaids[]')
              .map(() =>
                record(1, { scientificname: name, citation: 'https://example.org/a_(b)?x=1&y=2' }),
              ),
          ),
    );
    let inputOffset = 0;
    const positions: number[] = [];
    while (inputOffset < 500) {
      const result = await settle(
        mode === 'names'
          ? runToolContract(resolveTaxonTool, { names: Array(500).fill(name), inputOffset })
          : runToolContract(getTaxonTool, { aphiaIds: Array(500).fill(1), inputOffset }),
      );
      expectParity(result);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24000);
      expect(result.structuredContent).not.toHaveProperty('deferredInputs');
      const data = result.structuredContent as {
        results: { inputIndex: number }[];
        nextInputOffset: number | null;
        deferredCount: number;
      };
      positions.push(...data.results.map((row) => row.inputIndex));
      for (const row of data.results)
        expect(row).toMatchObject(
          mode === 'names'
            ? { matches: [{ aphiaId: 1, scientificname: name, authority: null }] }
            : {
                record: {
                  aphiaId: 1,
                  scientificname: name,
                  citation: 'https://example.org/a_(b)?x=1&y=2',
                },
              },
        );
      if (data.nextInputOffset === null) {
        expect(data.deferredCount).toBe(0);
        break;
      }
      expect(data.nextInputOffset).toBeGreaterThan(inputOffset);
      inputOffset = data.nextInputOffset;
    }
    expect(positions).toEqual(Array.from({ length: 500 }, (_, i) => i));
  },
);

it('continues matches inside a single name group then preserves the next miss', async () => {
  const matches = Array.from({ length: 50 }, (_, i) =>
    record(i + 1, { scientificname: `${i}${'🌊'.repeat(80)}`, authority: null }),
  );
  fakeFetch(() => Response.json([matches, []]));
  let inputOffset = 0;
  let matchOffset = 0;
  const ids: number[] = [];
  for (;;) {
    const result = await settle(
      runToolContract(resolveTaxonTool, { names: ['A', 'B'], inputOffset, matchOffset }),
    );
    expectParity(result);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24000);
    const data = result.structuredContent as {
      results: { inputIndex: number; matches: { aphiaId: number }[] }[];
      nextInputOffset: number | null;
      nextMatchOffset: number;
    };
    for (const group of data.results) ids.push(...group.matches.map((row) => row.aphiaId));
    expect(result.structuredContent).toMatchObject({
      notice: expect.stringContaining('completeness is unknown'),
    });
    if (data.nextInputOffset === null) {
      expect(data.results.at(-1)?.inputIndex).toBe(1);
      break;
    }
    inputOffset = data.nextInputOffset;
    matchOffset = data.nextMatchOffset;
  }
  expect(ids).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
});

it('pages singleton common names while repeating the unchanged full primary record', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    vernacular: `${i}${'海'.repeat(100)}`,
    language: null,
  }));
  fakeFetch((url) =>
    Response.json(
      url.pathname.includes('AphiaRecordsByAphiaIDs')
        ? [record(1, { scientificname: 'A', authority: null })]
        : rows,
    ),
  );
  const collected: unknown[] = [];
  let vernacularOffset = 0;
  for (;;) {
    const result = await settle(
      runToolContract(getTaxonTool, { aphiaIds: [1], includeVernaculars: true, vernacularOffset }),
    );
    expectParity(result);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24000);
    const data = result.structuredContent as {
      results: { record: unknown; vernaculars: unknown[] }[];
      nextVernacularOffset: number | null;
    };
    expect(data.results[0]?.record).toEqual({ aphiaId: 1, scientificname: 'A', authority: null });
    collected.push(...data.results[0]!.vernaculars);
    if (data.nextVernacularOffset === null) break;
    expect(data.nextVernacularOffset).toBeGreaterThan(vernacularOffset);
    vernacularOffset = data.nextVernacularOffset;
  }
  expect(collected).toEqual(rows);
});

it.each(
  (['synonyms', 'children', 'vernacular'] as const).flatMap((mode) =>
    [49, 50].map((count) => ({ mode, count })),
  ),
)(
  'consumes every local segment of an upstream $mode $count-row page before advancing',
  async ({ mode, count }) => {
    const rows = Array.from({ length: count }, (_, i) =>
      record(i + 2, { scientificname: `${i}${'海'.repeat(100)}` }),
    );
    fakeFetch((url) => {
      if (url.pathname.includes('AphiaRecordByAphiaID'))
        return Response.json(record(1, { status: 'accepted' }));
      if (url.pathname.includes('AphiaClassification')) return Response.json({ AphiaID: 1 });
      return url.searchParams.get('offset') === '51'
        ? new Response(null, { status: 204 })
        : Response.json(rows);
    });
    let resultOffset = 0;
    const ids: number[] = [];
    const call = (offset: number, local: number) =>
      mode === 'synonyms'
        ? runToolContract(getSynonymsTool, { aphiaId: 1, offset, resultOffset: local })
        : mode === 'children'
          ? runToolContract(getClassificationTool, {
              aphiaId: 1,
              includeChildren: true,
              offset,
              resultOffset: local,
            })
          : runToolContract(resolveTaxonTool, { vernacular: 'A', offset, resultOffset: local });
    for (;;) {
      const result = await settle(call(1, resultOffset));
      expectParity(result);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24000);
      const data = result.structuredContent as {
        synonyms?: { aphiaId: number }[];
        children?: { aphiaId: number }[];
        results?: { matches: { aphiaId: number }[] }[];
        nextResultOffset: number | null;
        page: { hasMore: null; nextOffset: number };
      };
      ids.push(
        ...(data.synonyms ?? data.children ?? data.results![0]!.matches).map((row) => row.aphiaId),
      );
      expect(data.page.hasMore).toBe(count === 50 ? null : false);
      expect(data.page.nextOffset).toBe(
        data.nextResultOffset === null ? (count === 50 ? 51 : null) : 1,
      );
      if (data.nextResultOffset === null) break;
      expect(data.nextResultOffset).toBeGreaterThan(resultOffset);
      resultOffset = data.nextResultOffset;
    }
    expect(ids).toEqual(Array.from({ length: count }, (_, i) => i + 2));
    const empty = await settle(call(51, 0));
    expectParity(empty);
    expect(empty.structuredContent).toMatchObject({ page: { hasMore: false, nextOffset: null } });
  },
);

it.each(['ranks', 'trait_types', 'traits'] as const)(
  'reassembles large %s references and nested global topology',
  async (mode) => {
    const rows = Array.from({ length: 80 }, (_, i) => ({
      measurementTypeID: `${i}`,
      measurementType: `${i}${'海'.repeat(80)}`,
      taxonRankID: i,
      taxonRank: `${i}${'海'.repeat(80)}`,
      children: [{ measurementTypeID: '001', measurementType: null }],
    }));
    fakeFetch(() => Response.json(rows));
    const collected = await collectLocal(
      (resultOffset) =>
        mode === 'traits'
          ? runToolContract(getTraitsTool, { aphiaId: 1, resultOffset })
          : runToolContract(listReferenceTool, { topic: mode, resultOffset }),
      mode === 'traits' ? 'traits' : 'entries',
    );
    expect(collected).toHaveLength(mode === 'ranks' ? 80 : 160);
    expect(collected).toEqual(
      mode === 'ranks'
        ? rows.map((row) => ({ taxonRankId: row.taxonRankID, taxonRank: row.taxonRank }))
        : rows.flatMap((row, i) => [
            {
              nodeIndex: i * 2,
              parentIndex: null,
              depth: 0,
              measurementTypeId: row.measurementTypeID,
              measurementType: row.measurementType,
              ...(mode === 'traits' ? { parentType: null, inheritedFrom: null } : {}),
            },
            {
              nodeIndex: i * 2 + 1,
              parentIndex: i * 2,
              depth: 1,
              measurementTypeId: '001',
              measurementType: null,
              ...(mode === 'traits'
                ? { parentType: row.measurementType, inheritedFrom: null }
                : {}),
            },
          ]),
    );
  },
);

it('retains ordered opaque crosswalk identifiers and successful empty types across pages', async () => {
  const ids = Array.from({ length: 80 }, (_, i) => `${i}00${'海'.repeat(100)}`);
  fakeFetch((url) =>
    url.searchParams.get('type') === 'iucn'
      ? new Response(null, { status: 403 })
      : Response.json(
          url.searchParams.get('type') === 'algaebase'
            ? ids
            : url.searchParams.get('type') === 'lsid'
              ? ['0001']
              : [],
        ),
  );
  let resultOffset = 0;
  const all: string[] = [];
  for (;;) {
    const result = await settle(runToolContract(crosswalkIdTool, { aphiaId: 1, resultOffset }));
    expectParity(result);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24000);
    const data = result.structuredContent as {
      ids: { algaebase: string[]; bold: string[]; lsid: string[] };
      nextResultOffset: number | null;
    };
    expect(data.ids.bold).toEqual([]);
    expect(result.structuredContent).toMatchObject({
      typeTotals: { algaebase: 80, bold: 0, lsid: 1 },
      failedTypes: [{ type: 'iucn' }],
    });
    expect(result.structuredContent).not.toHaveProperty('typeTotals.iucn');
    expect(result.structuredContent).not.toHaveProperty('ids.iucn');
    if (resultOffset === 0) expect(data.ids.lsid).toEqual([]);
    if (data.nextResultOffset === null) expect(data.ids.lsid).toEqual(['0001']);
    all.push(...data.ids.algaebase);
    if (data.nextResultOffset === null) break;
    resultOffset = data.nextResultOffset;
  }
  expect(all).toEqual(ids);
});

it('discloses an indivisible oversized item and advances without clipping', async () => {
  const locality = '海'.repeat(10000);
  fakeFetch(() => Response.json([{ locality }, { locality: 'last' }]));
  const result = await settle(runToolContract(getDistributionsTool, { aphiaId: 1 }));
  expectParity(result);
  expect(result.structuredContent).toMatchObject({
    distributions: [{ locality }],
    oversizedItem: true,
    nextResultOffset: 1,
    requiredBytes: Buffer.byteLength(JSON.stringify(result)),
  });
  const last = await settle(runToolContract(getDistributionsTool, { aphiaId: 1, resultOffset: 1 }));
  expectParity(last);
  expect(last.structuredContent).toMatchObject({
    distributions: [{ locality: 'last' }],
    nextResultOffset: null,
  });
});

it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid local position %s without fetching',
  async (resultOffset) => {
    const network = fakeFetch(() => {
      throw new Error('unexpected network');
    });
    const result = await settle(
      runToolContract(getDistributionsTool, { aphiaId: 1, resultOffset }),
    );
    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(network.calls).toHaveLength(0);
  },
);

it('returns terminal empty evidence for a position past the local sequence', async () => {
  fakeFetch(() => Response.json([{ locality: null }]));
  const result = await settle(
    runToolContract(getDistributionsTool, { aphiaId: 1, resultOffset: 99 }),
  );
  expectParity(result);
  expect(result.structuredContent).toMatchObject({
    distributions: [],
    totalCount: 1,
    returnedCount: 0,
    nextResultOffset: null,
  });
});

it('includes effective-filter enrichment when selecting a byte-boundary prefix', async () => {
  const value = 'x'.repeat(512);
  fakeFetch(() =>
    Response.json(
      Array.from({ length: 50 }, (_, i) => ({
        locality: `${i}`,
        occurrence: value,
        invasiveness: value,
        establishmentMeans: value,
      })),
    ),
  );
  const plain = await settle(runToolContract(getDistributionsTool, { aphiaId: 1 }));
  const enriched = await settle(
    runToolContract(getDistributionsTool, {
      aphiaId: 1,
      occurrence: value,
      invasiveness: value,
      establishmentMeans: value,
    }),
  );
  expectParity(plain);
  expectParity(enriched);
  expect(Buffer.byteLength(JSON.stringify(enriched))).toBeLessThanOrEqual(24000);
  const ordinary = plain.structuredContent as { returnedCount: number };
  const withEcho = enriched.structuredContent as { returnedCount: number };
  expect(withEcho.returnedCount).toBeLessThan(ordinary.returnedCount);
});
