/**
 * @fileoverview Taxonomy contracts exercised through real handlers and fetch.
 * @module tests/tools/list-reference.taxonomy.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClassificationTool } from '@/mcp-server/tools/definitions/get-classification.tool.js';
import { getTaxonTool } from '@/mcp-server/tools/definitions/get-taxon.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { resolveTaxonTool } from '@/mcp-server/tools/definitions/resolve-taxon.tool.js';
import { failures } from '@/services/worms/index.js';
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

describe('reference vocabulary', () => {
  it.each(['deadline', 'cancellation'] as const)(
    'stops a synchronous flat rank scan at periodic clock checks after %s',
    async (mode) => {
      const abort = new AbortController();
      const initialTime = Date.now();
      let reads = 0;
      let clock: ReturnType<typeof vi.spyOn> | undefined;
      const rows: unknown[] = Array.from({ length: 30_000 }, (_, id) => ({ taxonRankID: id }));
      rows.push('malformed tail must never be normalized');
      fakeFetch(() => {
        const response = Response.json(rows);
        clock = vi.spyOn(Date, 'now').mockImplementation(() => {
          reads++;
          if (reads < 80) return initialTime;
          if (mode === 'cancellation') abort.abort();
          return initialTime + 45_001;
        });
        return response;
      });
      try {
        const result = await settle(
          runToolContract(
            listReferenceTool,
            { topic: 'ranks' },
            { context: { signal: abort.signal } },
          ),
        );
        expect(reads).toBeGreaterThanOrEqual(80);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject(
          mode === 'deadline'
            ? { error: { data: { reason: 'upstream_timeout' } } }
            : { error: { code: -32011 } },
        );
        expect(result.structuredContent).not.toHaveProperty('entries');
      } finally {
        clock?.mockRestore();
      }
    },
  );
  it.each([
    ['upstream_rejected', 400],
    ['upstream_rate_limited', 429],
    ['upstream_access_denied', 403],
    ['upstream_unavailable', 500],
    ['upstream_timeout', 504],
    ['invalid_upstream_response', 404],
    ['response_too_large', 200],
  ] as const)('renders declared %s recovery on both error surfaces', async (reason, status) => {
    fakeFetch(() =>
      reason === 'response_too_large'
        ? new Response(new Uint8Array(8 * 1024 * 1024 + 1))
        : new Response('private upstream content', { status }),
    );
    const result = await settle(runToolContract(listReferenceTool, { topic: 'ranks' }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: failures[reason][0],
        data: { reason, retryable: failures[reason][2], recovery: { hint: failures[reason][1] } },
      },
    });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain(reason);
    expect(text).toContain(failures[reason][1]);
    expect(JSON.stringify(result)).not.toContain('private upstream content');
  });
  it.each(['external_id_types', 'statuses', 'environment_flags'] as const)(
    'renders complete static %s without requests',
    async (topic) => {
      const network = fakeFetch(() => {
        throw new Error('Static reference fetched upstream');
      });
      const result = await settle(runToolContract(listReferenceTool, { topic }));
      expectParity(result);
      expect(network.calls).toHaveLength(0);
      expect(result.structuredContent).toMatchObject({ topic });
    },
  );
  it('preserves live sparse ranks and explicit nulls', async () => {
    const network = fakeFetch((url) => {
      expect(url.pathname).toBe('/rest/AphiaTaxonRanksByID/-1');
      return Response.json([{ taxonRankID: 1, taxonRank: null }, {}]);
    });
    const result = await settle(runToolContract(listReferenceTool, { topic: 'ranks' }));
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      entries: [{ taxonRankId: 1, taxonRank: null }, {}],
    });
    expect(network.calls).toHaveLength(1);
  });
  it('retains branching trait topology and numeric strings', async () => {
    fakeFetch((url) => {
      expect(url.searchParams.get('include_children')).toBe('true');
      return Response.json([
        { measurementTypeID: '001', children: [{ measurementType: null, children: [{}] }, {}] },
        {},
      ]);
    });
    const result = await settle(runToolContract(listReferenceTool, { topic: 'trait_types' }));
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      entries: [
        { nodeIndex: 0, parentIndex: null, depth: 0, measurementTypeId: '001' },
        { nodeIndex: 1, parentIndex: 0, depth: 1, measurementType: null },
        { nodeIndex: 2, parentIndex: 1, depth: 2 },
        { nodeIndex: 3, parentIndex: 0, depth: 1 },
        { nodeIndex: 4, parentIndex: null, depth: 0 },
      ],
    });
  });
  it('returns empty live references with paired recovery guidance', async () => {
    fakeFetch(() => new Response(null, { status: 204 }));
    const result = await settle(runToolContract(listReferenceTool, { topic: 'ranks' }));
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      entries: [],
      notice: expect.stringContaining('same topic later'),
    });
  });
});

describe('taxon resolution', () => {
  it('accepts 500 names and preserves all 450 deferred positions', async () => {
    const names = Array.from({ length: 500 }, (_, index) => `Taxon ${index % 67}`);
    const network = fakeFetch((url) => {
      expect(url.searchParams.getAll('scientificnames[]')).toEqual(names.slice(0, 50));
      return Response.json(Array.from({ length: 50 }, () => []));
    });
    const result = await settle(runToolContract(resolveTaxonTool, { names }));
    expectParity(result);
    const data = result.structuredContent as {
      results: { input: string; inputIndex: number }[];
      nextInputOffset: number;
      deferredCount: number;
    };
    expect(data.results.map((row) => row.input)).toEqual(names.slice(0, data.results.length));
    expect(data.nextInputOffset).toBe(data.results.length);
    expect(data.deferredCount).toBe(500 - data.results.length);
    expect(network.calls).toHaveLength(1);
  });
  it('preserves duplicate positions, null misses, sparse matches, and defaults', async () => {
    const network = fakeFetch((url) => {
      expect(url.pathname).toBe('/rest/AphiaRecordsByNames');
      expect(url.searchParams.getAll('scientificnames[]')).toEqual(['A', 'B', 'A']);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        marine_only: 'true',
        extant_only: 'true',
        like: 'false',
      });
      return Response.json([
        [
          record(1, {
            valid_AphiaID: null,
            scientificname: 'A\r\n\n`|<> &',
            url: 'https://example.org/a_(b)?x=1&y=2',
          }),
        ],
        null,
        [record(1)],
      ]);
    });
    const result = await settle(runToolContract(resolveTaxonTool, { names: [' A ', 'B', 'A'] }));
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      mode: 'exact',
      results: [
        { input: 'A', matches: [{ aphiaId: 1, validAphiaId: null }] },
        { input: 'B', matches: [], guidance: expect.stringContaining('fuzzy: true') },
        { input: 'A' },
      ],
      echo: { marineOnly: true, extantOnly: true, fuzzy: false },
    });
    expect(network.calls).toHaveLength(1);
  });
  it('routes explicit fuzzy options and retains all deferred names', async () => {
    const names = Array.from({ length: 53 }, (_, index) => `Taxon ${index}`);
    fakeFetch((url) => {
      expect(url.pathname).toBe('/rest/AphiaRecordsByMatchNames');
      expect(url.searchParams.getAll('scientificnames[]')).toHaveLength(50);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        marine_only: 'false',
        extant_only: 'false',
        match_authority: 'false',
      });
      return Response.json(Array.from({ length: 50 }, () => []));
    });
    const result = await settle(
      runToolContract(resolveTaxonTool, {
        names,
        fuzzy: true,
        marineOnly: false,
        extantOnly: false,
      }),
    );
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      results: expect.any(Array),
      nextInputOffset: expect.any(Number),
      deferredCount: expect.any(Number),
      echo: { matchAuthority: false },
    });
  });
  it.each([0, 49, 50])('reports honest vernacular pagination for %i rows', async (count) => {
    const network = fakeFetch((url) => {
      expect(url.pathname).toBe('/rest/AphiaRecordsByVernacular/sea%20star');
      expect(url.searchParams.toString()).toBe('offset=51');
      return count
        ? Response.json(Array.from({ length: count }, (_, index) => record(index + 1)))
        : new Response(null, { status: 204 });
    });
    const result = await settle(
      runToolContract(resolveTaxonTool, { vernacular: 'sea star', offset: 51 }),
    );
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      page: {
        offset: 51,
        returnedCount: count,
        hasMore: count === 50 ? null : false,
        nextOffset: count === 50 ? 101 : null,
      },
      echo: { marineOnly: null, extantOnly: null },
    });
    expect(network.calls).toHaveLength(1);
  });
  it.each([
    [{}, 'invalid_selector'],
    [{ names: ['A'], vernacular: 'B' }, 'invalid_selector'],
    [{ names: ['A'], offset: 2 }, 'unsupported_mode_options'],
    [{ vernacular: 'A', fuzzy: true }, 'unsupported_mode_options'],
    [{ vernacular: 'A', marineOnly: false }, 'unsupported_mode_options'],
    [{ vernacular: 'A', extantOnly: false }, 'unsupported_mode_options'],
  ] as const)('rejects invalid selector/options before fetch: %j', async (input, reason) => {
    const network = fakeFetch(() => {
      throw new Error('Invalid input reached fetch');
    });
    const result = await settle(
      runToolContract(resolveTaxonTool, {
        ...input,
        names: 'names' in input ? [...input.names] : undefined,
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { data: { reason } } });
    expect(network.calls).toHaveLength(0);
  });
});

describe('taxon retrieval', () => {
  it('accepts 500 IDs and preserves all 450 deferred positions', async () => {
    const ids = Array.from({ length: 500 }, (_, index) => (index % 67) + 1);
    const network = fakeFetch((url) => {
      expect(url.searchParams.getAll('aphiaids[]')).toEqual(ids.slice(0, 50).map(String));
      return Response.json(ids.slice(0, 50).map((id) => record(id)));
    });
    const result = await settle(runToolContract(getTaxonTool, { aphiaIds: ids }));
    expectParity(result);
    const data = result.structuredContent as {
      results: { requestedAphiaId: number; record: { aphiaId: number } }[];
      nextInputOffset: number;
      deferredCount: number;
    };
    expect(data.results.map((row) => row.requestedAphiaId)).toEqual(
      ids.slice(0, data.results.length),
    );
    expect(data.results.map((row) => row.record.aphiaId)).toEqual(
      ids.slice(0, data.results.length),
    );
    expect(data.nextInputOffset).toBe(data.results.length);
    expect(data.deferredCount).toBe(500 - data.results.length);
    expect(network.calls).toHaveLength(1);
  });
  it('retains the primary record after an exhausted optional request timeout', async () => {
    const network = fakeFetch((_url, init, index) => {
      if (!index) return Response.json([record(1)]);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const result = await settle(
      runToolContract(getTaxonTool, { aphiaIds: [1], includeVernaculars: true }),
    );
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      results: [
        { found: true, record: { aphiaId: 1 }, vernacularError: { reason: 'upstream_timeout' } },
      ],
    });
    expect(network.calls).toHaveLength(3);
  });
  it('discards primary success when the whole-tool deadline expires during optional work', async () => {
    const network = fakeFetch((_url, _init, index) => {
      if (!index) return Response.json([record(1)]);
      vi.setSystemTime(Date.now() + 45_001);
      return Response.json([]);
    });
    const result = await settle(
      runToolContract(getTaxonTool, { aphiaIds: [1], includeVernaculars: true }),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'upstream_timeout' } },
    });
    expect(result.structuredContent).not.toHaveProperty('results');
    expect(network.calls).toHaveLength(2);
  });
  it('cancels optional work atomically even after primary success', async () => {
    const abort = new AbortController();
    const network = fakeFetch((_url, _init, index) => {
      if (!index) return Response.json([record(1)]);
      abort.abort();
      return Response.json([]);
    });
    const result = await settle(
      runToolContract(
        getTaxonTool,
        { aphiaIds: [1], includeVernaculars: true },
        { context: { signal: abort.signal } },
      ),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
    expect(result.structuredContent).not.toHaveProperty('results');
    expect(network.calls).toHaveLength(2);
  });
  it('retains positional null/all-null misses, duplicates, and flag uncertainty', async () => {
    fakeFetch(() =>
      Response.json([
        record(1, { isMarine: 1, isExtinct: 0, isBrackish: null, citation: '' }),
        null,
        { AphiaID: null, scientificname: null },
        record(1),
      ]),
    );
    const result = await settle(runToolContract(getTaxonTool, { aphiaIds: [1, 2, 3, 1] }));
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      results: [
        {
          found: true,
          record: { aphiaId: 1, isMarine: true, isExtinct: false, isBrackish: null, citation: '' },
        },
        { requestedAphiaId: 2, found: false, record: null },
        { requestedAphiaId: 3, found: false, record: null },
        { requestedAphiaId: 1, found: true },
      ],
      echo: { includeVernaculars: false },
    });
  });
  it('returns all deferred IDs without a second batch request', async () => {
    const ids = Array.from({ length: 54 }, (_, index) => index + 1);
    const network = fakeFetch((url) => {
      expect(url.searchParams.getAll('aphiaids[]')).toEqual(ids.slice(0, 50).map(String));
      return new Response(null, { status: 204 });
    });
    const result = await settle(runToolContract(getTaxonTool, { aphiaIds: ids }));
    expectParity(result);
    const data = result.structuredContent as {
      results: { requestedAphiaId: number; found: boolean }[];
      nextInputOffset: number;
    };
    expect(data.results).toMatchObject(
      ids.slice(0, data.results.length).map((id) => ({ requestedAphiaId: id, found: false })),
    );
    expect(data.nextInputOffset).toBe(data.results.length);
    expect(network.calls).toHaveLength(1);
  });
  it('retrieves optional sparse vernaculars through a second paced request', async () => {
    const network = fakeFetch((_url, _init, index) =>
      Response.json(
        index === 0 ? [record(1)] : [{ vernacular: 'A\r\nB', language_code: null }, {}],
      ),
    );
    const result = await settle(
      runToolContract(getTaxonTool, { aphiaIds: [1], includeVernaculars: true }),
    );
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      results: [{ vernaculars: [{ vernacular: 'A\r\nB', languageCode: null }, {}] }],
    });
    expect((network.starts[1] ?? 0) - (network.starts[0] ?? 0)).toBeGreaterThanOrEqual(500);
  });
  it.each([403, 400, 422])(
    'distinguishes optional outage from atomic rejection HTTP %i',
    async (status) => {
      fakeFetch((_url, _init, index) =>
        index === 0
          ? Response.json([record(1)])
          : new Response('private upstream body', { status }),
      );
      const result = await settle(
        runToolContract(getTaxonTool, { aphiaIds: [1], includeVernaculars: true }),
      );
      if (status === 403) {
        expectParity(result);
        expect(result.structuredContent).toMatchObject({
          results: [
            {
              record: { aphiaId: 1 },
              vernacularError: { reason: 'upstream_access_denied', retryable: false },
            },
          ],
        });
      } else {
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { data: { reason: 'upstream_rejected' } },
        });
      }
      expect(JSON.stringify(result)).not.toContain('private upstream body');
    },
  );
  it('rejects vernacular batches before requests', async () => {
    const network = fakeFetch(() => {
      throw new Error('Unexpected request');
    });
    const result = await settle(
      runToolContract(getTaxonTool, { aphiaIds: [1, 2], includeVernaculars: true }),
    );
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'vernacular_batch' } },
    });
    expect(network.calls).toHaveLength(0);
  });
  it.each([[record(2)], [], [{}], [record(1, { isMarine: 2 })]])(
    'rejects malformed or misassociated batch %j',
    async (...rows) => {
      fakeFetch(() => Response.json(rows));
      const result = await settle(runToolContract(getTaxonTool, { aphiaIds: [1] }));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_upstream_response' } },
      });
    },
  );
});

describe('classification', () => {
  it.each(['malformed child', [], { rank: 'identity missing' }])(
    'rejects a malformed classification child below 600 valid ancestors: %j',
    async (child) => {
      let tree: unknown = child;
      for (let id = 600; id > 0; id--) tree = { AphiaID: id, child: tree };
      const network = fakeFetch(() => Response.json(tree));
      const result = await settle(runToolContract(getClassificationTool, { aphiaId: 600 }));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_upstream_response', retryable: false } },
      });
      expect(result.structuredContent).not.toHaveProperty('ranks');
      expect(network.calls).toHaveLength(1);
    },
  );
  it.each([403, 400])(
    'retains lineage only for optional outage, not rejection HTTP %i',
    async (status) => {
      fakeFetch((_url, _init, index) =>
        index === 0 ? Response.json({ AphiaID: 1 }) : new Response(null, { status }),
      );
      const result = await settle(
        runToolContract(getClassificationTool, { aphiaId: 1, includeChildren: true }),
      );
      if (status === 403) {
        expectParity(result);
        expect(result.structuredContent).toMatchObject({
          found: true,
          ranks: [{ aphiaId: 1 }],
          childrenError: { reason: 'upstream_access_denied' },
        });
        expect(result.structuredContent).not.toHaveProperty('children');
        expect(result.structuredContent).not.toHaveProperty('page');
      } else {
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { data: { reason: 'upstream_rejected' } },
        });
      }
    },
  );
  it('normalizes a deep finite lineage iteratively and preserves all ranks', async () => {
    let tree: unknown = null;
    for (let index = 1200; index > 0; index--)
      tree = { AphiaID: index, scientificname: index === 2 ? null : `Node ${index}`, child: tree };
    fakeFetch(() => Response.json(tree));
    const ranks = await collectLocal(
      (resultOffset) => runToolContract(getClassificationTool, { aphiaId: 1200, resultOffset }),
      'ranks',
    );
    expect(ranks).toHaveLength(1200);
    expect(ranks[1199]).toEqual({ aphiaId: 1200, scientificname: 'Node 1200' });
  });
  it.each([0, 49, 50])(
    'fetches exactly one %i-row child page with explicit filters',
    async (count) => {
      const network = fakeFetch((url, _init, index) => {
        if (!index) return Response.json({ AphiaID: 1 });
        expect(url.searchParams.toString()).toBe('offset=51&marine_only=false&extant_only=false');
        return count
          ? Response.json(Array.from({ length: count }, (_, i) => record(i + 2)))
          : new Response(null, { status: 204 });
      });
      const result = await settle(
        runToolContract(getClassificationTool, {
          aphiaId: 1,
          includeChildren: true,
          offset: 51,
          marineOnly: false,
          extantOnly: false,
        }),
      );
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        page: {
          offset: 51,
          returnedCount: count,
          hasMore: count === 50 ? null : false,
          nextOffset: count === 50 ? 101 : null,
        },
      });
      expect(network.calls).toHaveLength(2);
    },
  );
  it('does not fetch children for absent classification', async () => {
    const network = fakeFetch(() => new Response(null, { status: 204 }));
    const result = await settle(
      runToolContract(getClassificationTool, { aphiaId: 1, includeChildren: true }),
    );
    expectParity(result);
    expect(result.structuredContent).toMatchObject({ found: false, ranks: [] });
    expect(network.calls).toHaveLength(1);
  });
});

describe('schema boundaries', () => {
  it('rejects empty, oversized, and invalid scientific batches before network', async () => {
    const network = fakeFetch(() => {
      throw new Error('Invalid input reached fetch');
    });
    for (const names of [[], [' '], Array.from({ length: 501 }, () => 'A'), ['x'.repeat(513)]]) {
      const result = await settle(runToolContract(resolveTaxonTool, { names }));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    }
    expect(network.calls).toHaveLength(0);
  });
  it('rejects invalid AphiaIDs and offsets before requests', async () => {
    const network = fakeFetch(() => {
      throw new Error('Invalid input reached fetch');
    });
    for (const aphiaIds of [
      [],
      [0],
      [-1],
      [1.5],
      [Number.MAX_SAFE_INTEGER + 1],
      Array.from({ length: 501 }, () => 1),
    ]) {
      const result = await settle(runToolContract(getTaxonTool, { aphiaIds }));
      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    }
    for (const offset of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      const result = await settle(runToolContract(getClassificationTool, { aphiaId: 1, offset }));
      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    }
    const reference = await settle(
      runToolContract(listReferenceTool, { topic: 'invalid' as 'ranks' }),
    );
    expect(reference.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(network.calls).toHaveLength(0);
  });
});
