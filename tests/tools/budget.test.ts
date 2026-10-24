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
  contentText,
  expectParity,
  fakeFetch,
  offline,
  record,
  settle,
  setupWorms,
  withStatus,
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
  fakeFetch(withStatus(null, () => Response.json(rows)));
  const collected = await collectLocal(
    (resultOffset) =>
      runToolContract(getDistributionsTool, {
        aphiaId: 1,
        ...(resultOffset ? { resultOffset } : {}),
      }),
    'distributions',
  );
  expect(collected).toEqual(rows);
});

it.each(['names', 'ids'] as const)(
  'walks 503 %s with duplicates, misses, mixed IDs, and split groups past position 500',
  async (mode) => {
    const inputs = Array.from({ length: 503 }, (_, index) =>
      index === 501 ? 'A' : index % 11 === 0 ? 'Miss' : `B${index % 7}`,
    );
    const ids = inputs.map((name, index) =>
      name === 'Miss'
        ? 9
        : index % 2
          ? `urn:lsid:marinespecies.org:taxname:${(index % 7) + 1}`
          : (index % 7) + 1,
    );
    const network = fakeFetch((url) => {
      const sent = url.searchParams.getAll(mode === 'names' ? 'scientificnames[]' : 'aphiaids[]');
      expect(sent.length).toBeLessThanOrEqual(50);
      return Response.json(
        sent.map((value) =>
          mode === 'ids'
            ? value === '9'
              ? null
              : record(Number(value))
            : value === 'Miss'
              ? []
              : value === 'A'
                ? Array.from({ length: 50 }, (_, index) =>
                    record(1000 + index, { authority: 'x'.repeat(1000) }),
                  )
                : [record(Number(value.slice(1)) + 1)],
        ),
      );
    });
    const seen: {
      inputIndex: number;
      matches?: { aphiaId: number }[];
      requestedAphiaId?: number;
      found?: boolean;
    }[] = [];
    let inputOffset = 0;
    let matchOffset = 0;
    let calls = 0;
    for (;;) {
      const before = network.calls.length;
      const result = await settle(
        mode === 'names'
          ? runToolContract(resolveTaxonTool, {
              names: inputs,
              inputOffset,
              matchOffset,
              fuzzy: true,
            })
          : runToolContract(getTaxonTool, { aphiaIds: ids, inputOffset }),
      );
      expectParity(result);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24000);
      expect(network.calls.length - before).toBe(1);
      const sent = network.calls
        .at(-1)
        ?.searchParams.getAll(mode === 'names' ? 'scientificnames[]' : 'aphiaids[]');
      expect(sent).toEqual(
        mode === 'names'
          ? inputs.slice(inputOffset, inputOffset + 50)
          : ids.slice(inputOffset, inputOffset + 50).map((id) => String(id).split(':').at(-1)),
      );
      const data = result.structuredContent as {
        results: (typeof seen)[number][];
        nextInputOffset: number | null;
        nextMatchOffset: number | null;
        deferredCount: number;
      };
      seen.push(...data.results);
      calls++;
      expect(data.deferredCount).toBe(
        data.nextInputOffset === null ? 0 : 503 - data.nextInputOffset,
      );
      if (data.nextInputOffset === null) break;
      expect(
        data.nextInputOffset > inputOffset ||
          (data.nextInputOffset === inputOffset && (data.nextMatchOffset ?? 0) > matchOffset),
      ).toBe(true);
      inputOffset = data.nextInputOffset;
      matchOffset = data.nextMatchOffset ?? 0;
    }
    expect(new Set(seen.map((row) => row.inputIndex))).toEqual(
      new Set(Array.from({ length: 503 }, (_, index) => index)),
    );
    for (let index = 0; index < 503; index++) {
      const rows = seen.filter((row) => row.inputIndex === index);
      if (mode === 'names')
        expect(rows.flatMap((row) => row.matches ?? []).map((row) => row.aphiaId)).toEqual(
          inputs[index] === 'Miss'
            ? []
            : index === 501
              ? Array.from({ length: 50 }, (_, item) => 1000 + item)
              : [(index % 7) + 1],
        );
      else
        expect(rows).toMatchObject([
          {
            requestedAphiaId: inputs[index] === 'Miss' ? 9 : (index % 7) + 1,
            found: inputs[index] !== 'Miss',
          },
        ]);
      if (mode === 'ids' || index !== 501) expect(rows).toHaveLength(1);
      else expect(rows.length).toBeGreaterThan(1);
    }
    expect(network.calls).toHaveLength(calls);
  },
);

it.each(['names', 'ids'] as const)(
  'continues 500 duplicate maximum inputs without copying deferred %s',
  async (mode) => {
    const name = '海'.repeat(512);
    const network = fakeFetch((url) =>
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
    let toolCalls = 0;
    const positions: number[] = [];
    while (inputOffset < 500) {
      toolCalls++;
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
    expect(network.calls).toHaveLength(toolCalls);
  },
);

it('pages full Aphia records with content at most 1.5x structured bytes', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => 137205 + i);
  const network = fakeFetch((url) =>
    Response.json(
      url.searchParams.getAll('aphiaids[]').map((value) => {
        const id = Number(value);
        const url = `https://www.marinespecies.org/aphia.php?p=taxdetails&id=${id}`;
        return record(id, {
          url,
          scientificname: 'Caretta caretta',
          authority: '(Linnaeus, 1758)',
          status: 'accepted',
          unacceptreason: null,
          taxonRankID: 220,
          rank: 'Species',
          valid_AphiaID: id,
          valid_name: 'Caretta caretta',
          valid_authority: '(Linnaeus, 1758)',
          parentNameUsageID: 137066,
          originalNameUsageID: 1298345,
          kingdom: 'Animalia',
          phylum: 'Chordata',
          class: null,
          order: 'Testudines',
          family: 'Cheloniidae',
          genus: 'Caretta',
          citation: `Uetz, P. (ed.) (2026). The Reptile Database. Accessed through: World Register of Marine Species at: ${url} on 2026-10-21`,
          lsid: `urn:lsid:marinespecies.org:taxname:${id}`,
          isMarine: 1,
          isBrackish: null,
          isFreshwater: null,
          isTerrestrial: null,
          isExtinct: null,
          match_type: 'exact',
          modified: '2018-09-21T14:00:23.180Z',
        });
      }),
    ),
  );
  const pages: number[] = [];
  const collected: number[] = [];
  for (let inputOffset: number | null = 0; inputOffset !== null; ) {
    const result = await settle(runToolContract(getTaxonTool, { aphiaIds: ids, inputOffset }));
    expectParity(result);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24000);
    expect(Buffer.byteLength(contentText(result))).toBeLessThanOrEqual(
      1.5 * Buffer.byteLength(JSON.stringify(result.structuredContent)),
    );
    const data = result.structuredContent as {
      results: { record: { aphiaId: number; citation: string } }[];
      nextInputOffset: number | null;
    };
    pages.push(data.results.length);
    collected.push(...data.results.map((row) => row.record.aphiaId));
    inputOffset = data.nextInputOffset;
  }
  expect(collected).toEqual(ids);
  expect(pages[0]).toBeGreaterThanOrEqual(9);
  expect(network.calls).toHaveLength(pages.length);
});

it('sends scientific names from inputOffset and pages across 50-name boundaries', async () => {
  const names = Array.from({ length: 120 }, (_, i) => `Name ${i}`);
  const network = fakeFetch((url) =>
    Response.json(
      url.searchParams
        .getAll('scientificnames[]')
        .map((name) => [record(names.indexOf(name) + 1, { scientificname: name })]),
    ),
  );
  const result = await settle(runToolContract(resolveTaxonTool, { names, inputOffset: 45 }));
  expectParity(result);
  expect(network.calls).toHaveLength(1);
  expect(network.calls[0]?.searchParams.getAll('scientificnames[]')).toEqual(names.slice(45, 95));
  const data = result.structuredContent as {
    results: { inputIndex: number; input: string; matches: { aphiaId: number }[] }[];
  };
  expect(data.results.map((row) => [row.inputIndex, row.input, row.matches[0]?.aphiaId])).toEqual(
    names.slice(45, 95).map((name, i) => [45 + i, name, 46 + i]),
  );
  expect(result.structuredContent).toMatchObject({
    budgetLimited: false,
    nextInputOffset: 95,
    nextMatchOffset: 0,
    deferredCount: 25,
  });
});

it('discloses exact requiredBytes for an oversized fuzzy group with two enrichment fields', async () => {
  const matches = Array.from({ length: 50 }, (_, i) =>
    record(i + 1, { scientificname: `${i}${'x'.repeat(12000)}`, authority: null }),
  );
  const network = fakeFetch(() => Response.json([matches]));
  const result = await settle(runToolContract(resolveTaxonTool, { names: ['A'], fuzzy: true }));
  expectParity(result);
  expect(network.calls).toHaveLength(1);
  expect(network.calls[0]?.pathname).toBe('/rest/AphiaRecordsByMatchNames');
  expect(result.structuredContent).toMatchObject({
    results: [{ inputIndex: 0, matchOffset: 0, partialGroup: true, matches: [{ aphiaId: 1 }] }],
    nextInputOffset: 0,
    nextMatchOffset: 1,
    oversizedItem: true,
    echo: { fuzzy: true, matchAuthority: false },
    notice:
      'The scientific-name group at inputIndex 0 returned 50 matches; completeness is unknown. Call worms_resolve_taxon with fuzzy: false, or with a fuller name for that group, such as genus plus species epithet.',
    requiredBytes: Buffer.byteLength(JSON.stringify(result)),
  });
});

type NamePage = {
  results: { inputIndex: number; matchOffset: number; matches: { aphiaId: number }[] }[];
  nextInputOffset: number | null;
  nextMatchOffset: number | null;
  deferredCount: number;
  oversizedItem: boolean;
  requiredBytes?: number;
  echo: unknown;
  notice?: string;
};

/** Serve `A` as a 50-match group and every other name as one match, sized per name. */
function fakeNameGroups(match: (name: string, index: number) => Record<string, unknown>) {
  return fakeFetch((url) =>
    Response.json(
      url.searchParams
        .getAll('scientificnames[]')
        .map((name) =>
          name === 'A'
            ? Array.from({ length: 50 }, (_, i) => record(1000 + i, match(name, i)))
            : [record(Number(name.slice(1)) + 1, match(name, 0))],
        ),
    ),
  );
}

/** Follow both scientific continuation coordinates, checking each page's surfaces and budget. */
async function walkNames(names: string[]) {
  const pages: NamePage[] = [];
  let inputOffset = 0;
  let matchOffset = 0;
  for (;;) {
    const result = await settle(
      runToolContract(resolveTaxonTool, { names, inputOffset, matchOffset }),
    );
    expectParity(result);
    const data = result.structuredContent as NamePage;
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (data.oversizedItem) expect(data.requiredBytes).toBe(bytes);
    else expect(bytes).toBeLessThanOrEqual(24000);
    pages.push(data);
    if (data.nextInputOffset === null) return pages;
    inputOffset = data.nextInputOffset;
    matchOffset = data.nextMatchOffset as number;
  }
}

const B0_TO_B9_AND_A = [...Array.from({ length: 10 }, (_, i) => `B${i}`), 'A'];
const longAuthorities = (name: string, index: number) => ({
  scientificname: name,
  authority: `${index}${'x'.repeat(name === 'A' ? 1000 : 3000)}`,
});

it('continues matches inside a single name group then preserves the next miss', async () => {
  const matches = Array.from({ length: 50 }, (_, i) =>
    record(i + 1, { scientificname: `${i}${'🌊'.repeat(80)}`, authority: null }),
  );
  fakeFetch((url) =>
    Response.json(
      url.searchParams.getAll('scientificnames[]').map((name) => (name === 'A' ? matches : [])),
    ),
  );
  const pages = await walkNames(['A', 'B']);
  for (const data of pages)
    expect(data).toMatchObject({
      oversizedItem: false,
      notice: expect.stringContaining('completeness is unknown'),
    });
  expect(pages.at(-1)?.results.at(-1)?.inputIndex).toBe(1);
  expect(pages.flatMap((data) => data.results.flatMap((row) => row.matches))).toEqual(
    Array.from({ length: 50 }, (_, i) => expect.objectContaining({ aphiaId: i + 1 })),
  );
});

it('pages B0–B9 + A with unchanged results, echo, continuation, and the 50-match notice only where that group is', async () => {
  const network = fakeNameGroups(longAuthorities);
  const pages = await walkNames(B0_TO_B9_AND_A);
  expect(network.calls).toHaveLength(pages.length);
  expect(
    pages.map((data) => [
      data.results.map((row) => [row.inputIndex, row.matchOffset, row.matches.length]),
      data.nextInputOffset,
      data.nextMatchOffset,
      data.deferredCount,
    ]),
  ).toEqual([
    [
      [
        [0, 0, 1],
        [1, 0, 1],
        [2, 0, 1],
      ],
      3,
      0,
      8,
    ],
    [
      [
        [3, 0, 1],
        [4, 0, 1],
        [5, 0, 1],
      ],
      6,
      0,
      5,
    ],
    [
      [
        [6, 0, 1],
        [7, 0, 1],
        [8, 0, 1],
      ],
      9,
      0,
      2,
    ],
    [
      [
        [9, 0, 1],
        [10, 0, 6],
      ],
      10,
      6,
      1,
    ],
    [[[10, 6, 9]], 10, 15, 1],
    [[[10, 15, 9]], 10, 24, 1],
    [[[10, 24, 9]], 10, 33, 1],
    [[[10, 33, 9]], 10, 42, 1],
    [[[10, 42, 8]], null, null, 0],
  ]);
  for (const data of pages) {
    expect(data.echo).toStrictEqual({ marineOnly: true, extantOnly: true, fuzzy: false });
    if (data.results.some((row) => row.inputIndex === 10))
      expect(data.notice).toBe(
        'The scientific-name group at inputIndex 10 returned 50 matches; completeness is unknown. Call worms_resolve_taxon with a fuller name for that group, such as genus plus species epithet.',
      );
    else expect(data).not.toHaveProperty('notice');
  }
});

it('names every 50-match inputIndex a page holds, never the submitted names', async () => {
  fakeNameGroups((name) => ({ scientificname: name, authority: null }));
  const [data, ...rest] = await walkNames(['A', 'B0', 'A']);
  expect(rest).toEqual([]);
  expect(data?.results.map((row) => [row.inputIndex, row.matches.length])).toEqual([
    [0, 50],
    [1, 1],
    [2, 50],
  ]);
  expect(data?.notice).toBe(
    'The scientific-name groups at inputIndex 0, 2 returned 50 matches each; completeness is unknown. Call worms_resolve_taxon with fuller names for those groups, such as genus plus species epithet.',
  );
});

it('adds fuzzy: false to the 50-match notice only after a fuzzy call', async () => {
  const network = fakeNameGroups((name) => ({ scientificname: name, authority: null }));
  const result = await settle(
    runToolContract(resolveTaxonTool, { names: ['A', 'B0', 'A'], fuzzy: true }),
  );
  expectParity(result);
  expect(network.calls.map((url) => url.pathname)).toEqual(['/rest/AphiaRecordsByMatchNames']);
  expect(result.structuredContent).toMatchObject({
    echo: { fuzzy: true, matchAuthority: false },
    notice:
      'The scientific-name groups at inputIndex 0, 2 returned 50 matches each; completeness is unknown. Call worms_resolve_taxon with fuzzy: false, or with fuller names for those groups, such as genus plus species epithet.',
  });
});

it.each([
  [
    49,
    [
      [0, 1],
      [1, 1],
    ],
    'inputIndex 0 returned 50 matches;',
  ],
  [50, [[1, 1]], undefined],
])(
  'notices a 50-match group at matchOffset %i only while the page holds part of it',
  async (matchOffset, rows, notice) => {
    const network = fakeNameGroups((name) => ({ scientificname: name, authority: null }));
    const result = await settle(
      runToolContract(resolveTaxonTool, { names: ['A', 'B0'], matchOffset }),
    );
    expectParity(result);
    expect(network.calls).toHaveLength(1);
    const data = result.structuredContent as NamePage;
    expect(data.results.map((row) => [row.inputIndex, row.matches.length])).toEqual(rows);
    expect(data).toMatchObject({ nextInputOffset: null, nextMatchOffset: null, deferredCount: 0 });
    if (notice) expect(data.notice).toContain(notice);
    else expect(data).not.toHaveProperty('notice');
  },
);

it('measures an oversized item without the notice its page does not hold', async () => {
  fakeNameGroups((name) => ({
    scientificname: name,
    authority: name === 'A' ? null : '§'.repeat(30000),
  }));
  const [oversized, ...rest] = await walkNames(['B0', 'A']);
  expect(oversized).toMatchObject({
    results: [{ inputIndex: 0, matches: [{ aphiaId: 1 }] }],
    oversizedItem: true,
    nextInputOffset: 1,
    nextMatchOffset: 0,
  });
  expect(oversized).not.toHaveProperty('notice');
  expect(rest.map((data) => data.results.map((row) => row.inputIndex))).toEqual([[1]]);
  expect(rest[0]?.notice).toBe(
    'The scientific-name group at inputIndex 1 returned 50 matches; completeness is unknown. Call worms_resolve_taxon with a fuller name for that group, such as genus plus species epithet.',
  );
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

it.each([undefined, 'CONTEXT SOURCE (DEEPSEA)'])(
  'pages a 631-row unpaged source list with sourceUse %s while repeating the unchanged full primary record',
  async (sourceUse) => {
    const rows = Array.from({ length: 631 }, (_, position) => {
      const i = position === 14 ? 7 : position;
      return {
        source_id: 450000 + i,
        use: i % 7 ? 'additional source' : 'context source (Deepsea)',
        reference: `${i} ${'Calanus finmarchicus 海 [x] '.repeat(5 + (i % 30))}`,
        page: i % 50 ? null : `${i}`,
        url: `https://www.marinespecies.org/aphia.php?p=sourcedetails&id=${450000 + i}`,
        link: i % 20 ? null : `https://hdl.handle.net/11250/${i} `,
        fulltext: null,
        doi: i % 4 ? null : `10.1000/${i}`,
      };
    });
    const primary = { aphiaId: 104464, scientificname: 'Calanus finmarchicus', authority: null };
    const network = fakeFetch((url) =>
      Response.json(
        url.pathname === '/rest/AphiaRecordsByAphiaIDs'
          ? [record(104464, { scientificname: primary.scientificname, authority: null })]
          : rows,
      ),
    );
    const collected: unknown[] = [];
    const selected =
      sourceUse === undefined ? rows : rows.filter((row) => row.use === 'context source (Deepsea)');
    let sourceOffset = 0;
    let pages = 0;
    for (;;) {
      const result = await settle(
        runToolContract(getTaxonTool, {
          aphiaIds: [104464],
          includeSources: true,
          sourceOffset,
          sourceUse,
        }),
      );
      pages++;
      expectParity(result);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24000);
      const data = result.structuredContent as {
        results: { record: unknown; sources: unknown[] }[];
        nextSourceOffset: number | null;
        nextInputOffset: number | null;
        nextVernacularOffset: null;
        budgetLimited: boolean;
      };
      expect(data.results).toHaveLength(1);
      expect(data.results[0]?.record).toEqual(primary);
      expect(data.results[0]).toMatchObject({
        sourceTotalCount: selected.length,
        ...(sourceUse ? { unfilteredSourceCount: 631 } : {}),
      });
      if (!sourceUse) expect(data.results[0]).not.toHaveProperty('unfilteredSourceCount');
      expect(data.nextVernacularOffset).toBeNull();
      collected.push(...data.results[0]!.sources);
      if (data.nextSourceOffset === null) {
        expect(data.nextInputOffset).toBeNull();
        break;
      }
      expect(data.budgetLimited).toBe(true);
      expect(data.nextInputOffset).toBe(0);
      expect(data.nextSourceOffset).toBe(sourceOffset + data.results[0]!.sources.length);
      sourceOffset = data.nextSourceOffset;
    }
    expect(collected).toEqual(
      selected.map(({ source_id, ...fields }) => ({ sourceId: source_id, ...fields })),
    );
    expect(pages).toBeGreaterThan(1);
    expect(network.calls).toHaveLength(pages * 2);
  },
);

it('discloses an oversized source row, advances past it, and ends past the list', async () => {
  const reference = '海'.repeat(10000);
  fakeFetch((url) =>
    Response.json(
      url.pathname === '/rest/AphiaRecordsByAphiaIDs'
        ? [record(1)]
        : [{ source_id: 1, reference }, { source_id: 2 }],
    ),
  );
  const call = (sourceOffset: number) =>
    settle(runToolContract(getTaxonTool, { aphiaIds: [1], includeSources: true, sourceOffset }));
  const oversized = await call(0);
  expectParity(oversized);
  expect(oversized.structuredContent).toMatchObject({
    results: [{ record: { aphiaId: 1 }, sources: [{ sourceId: 1, reference }] }],
    oversizedItem: true,
    nextSourceOffset: 1,
    nextInputOffset: 0,
    requiredBytes: Buffer.byteLength(JSON.stringify(oversized)),
  });
  const last = await call(1);
  expectParity(last);
  expect(last.structuredContent).toMatchObject({
    results: [{ sources: [{ sourceId: 2 }] }],
    oversizedItem: false,
    nextSourceOffset: null,
    nextInputOffset: null,
  });
  const past = await call(5);
  expectParity(past);
  expect(past.structuredContent).toMatchObject({
    results: [{ record: { aphiaId: 1 }, sources: [] }],
    nextSourceOffset: null,
    nextInputOffset: null,
    deferredCount: 0,
  });
});

it.each(
  (['synonyms', 'children', 'vernacular', 'contains'] as const).flatMap((mode) =>
    [49, 50].map((count) => ({ mode, count })),
  ),
)(
  'consumes every local segment of an upstream $mode $count-row page before advancing',
  async ({ mode, count }) => {
    const rows = Array.from({ length: count }, (_, i) =>
      record(i + 2, { scientificname: `${i}${'海'.repeat(100)}` }),
    );
    const network = fakeFetch((url) => {
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
          : runToolContract(resolveTaxonTool, {
              vernacular: 'A',
              offset,
              resultOffset: local,
              ...(mode === 'contains' ? { vernacularMatch: 'contains' as const } : {}),
            });
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
    if (mode === 'vernacular' || mode === 'contains')
      expect(new Set(network.calls.map((url) => url.searchParams.get('like')))).toEqual(
        new Set([String(mode === 'contains')]),
      );
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
    fakeFetch(withStatus(null, () => Response.json(rows)));
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
  fakeFetch(withStatus(null, () => Response.json([{ locality }, { locality: 'last' }])));
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
    offline();
    const result = await settle(
      runToolContract(getDistributionsTool, { aphiaId: 1, resultOffset }),
    );
    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
  },
);

it('returns terminal empty evidence for a position past the local sequence', async () => {
  fakeFetch(withStatus(null, () => Response.json([{ locality: null }])));
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
  fakeFetch(
    withStatus(null, () =>
      Response.json(
        Array.from({ length: 50 }, (_, i) => ({
          locality: `${i}`,
          occurrence: value,
          invasiveness: value,
          establishmentMeans: value,
        })),
      ),
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
