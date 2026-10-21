/**
 * @fileoverview Evidence tools exercised through real services and network fixtures.
 * @module tests/tools/worms-evidence.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crosswalkIdTool } from '@/mcp-server/tools/definitions/crosswalk-id.tool.js';
import { getDistributionsTool } from '@/mcp-server/tools/definitions/get-distributions.tool.js';
import { getSynonymsTool } from '@/mcp-server/tools/definitions/get-synonyms.tool.js';
import { getTraitsTool } from '@/mcp-server/tools/definitions/get-traits.tool.js';
import { expectParity, fakeFetch, record, settle, setupWorms } from '../helpers/worms.js';

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
          returnedCount: count,
          hasMore: count === 50 ? null : false,
          nextOffset: count === 50 ? 101 : null,
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
    const network = fakeFetch((url) => {
      expect(url.searchParams.toString()).toBe('');
      return Response.json(rows);
    });
    const result = await settle(
      runToolContract(getDistributionsTool, {
        aphiaId: 1,
        recordStatus: 'valid',
        establishmentMeans: 'NATIVE',
        invasiveness: 'NOT INVASIVE',
        occurrence: 'PRESENT',
      }),
    );
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      unfilteredCount: 6,
      filteredCount: 2,
      distributions: [
        { locality: matching.locality, locationId: '001', latitude: null },
        { locality: matching.locality },
      ],
      echo: { establishmentMeans: 'NATIVE' },
    });
    expect(network.calls).toHaveLength(1);
  });
  it('retains more than a page of unfiltered evidence and ignores blank filters', async () => {
    fakeFetch(() => Response.json(Array.from({ length: 260 }, () => matching)));
    const result = await settle(
      runToolContract(getDistributionsTool, { aphiaId: 1, occurrence: ' ', recordStatus: '' }),
    );
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      unfilteredCount: 260,
      filteredCount: 260,
      echo: {},
    });
  });
  it('reports empty evidence without claiming biological absence', async () => {
    fakeFetch(() => new Response(null, { status: 204 }));
    const result = await settle(runToolContract(getDistributionsTool, { aphiaId: 1 }));
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      unfilteredCount: 0,
      filteredCount: 0,
      distributions: [],
      notice: expect.stringContaining('worms_get_taxon'),
    });
  });
  it('distinguishes zero local matches from zero upstream rows', async () => {
    fakeFetch(() => Response.json([matching, { locality: null, occurrence: null }]));
    const result = await settle(
      runToolContract(getDistributionsTool, { aphiaId: 1, occurrence: 'absent' }),
    );
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      unfilteredCount: 2,
      filteredCount: 0,
      distributions: [],
      echo: { occurrence: 'absent' },
      notice: expect.any(String),
    });
  });
});

describe('trait evidence', () => {
  it.each([{ children: {} }, { children: [{ measurementTypeID: 'not numeric' }] }])(
    'rejects malformed nested evidence %j atomically',
    async (node) => {
      fakeFetch(() => Response.json([node]));
      const result = await settle(runToolContract(getTraitsTool, { aphiaId: 1 }));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_upstream_response' } },
      });
      expect(result.structuredContent).not.toHaveProperty('traits');
    },
  );
  it('retains depth-first branching topology, repeated values, sparse IDs and inheritance', async () => {
    fakeFetch((url) => {
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
    });
    const result = await settle(runToolContract(getTraitsTool, { aphiaId: 1 }));
    expectParity(result);
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
    fakeFetch(() => Response.json([node]));
    const result = await settle(runToolContract(getTraitsTool, { aphiaId: 1 }));
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      traits: expect.arrayContaining([
        {
          nodeIndex: 1100,
          parentIndex: 1099,
          depth: 1100,
          measurementValue: 'leaf',
          inheritedFrom: null,
        },
      ]),
    });
  });
  it.each([true, false])('keeps empty inheritance=%s guidance honest', async (includeInherited) => {
    fakeFetch((url) => {
      expect(url.searchParams.get('include_inherited')).toBe(String(includeInherited));
      return new Response(null, { status: 204 });
    });
    const result = await settle(runToolContract(getTraitsTool, { aphiaId: 1, includeInherited }));
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      traits: [],
      echo: { includeInherited },
      notice: expect.stringContaining(
        includeInherited ? 'inheritance enabled' : 'includeInherited: true',
      ),
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
            recovery: expect.stringContaining('keyless WoRMS'),
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
    const network = fakeFetch(() => {
      throw new Error('Unexpected fetch');
    });
    const result = await settle(runToolContract(crosswalkIdTool, input));
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason, recovery: expect.anything() } },
    });
    expect(network.calls).toHaveLength(0);
  });
  it('rejects unsupported types at the schema boundary', async () => {
    const network = fakeFetch(() => {
      throw new Error('Unexpected fetch');
    });
    const result = await settle(runToolContract(crosswalkIdTool, { aphiaId: 1, type: 'gbif' }));
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(network.calls).toHaveLength(0);
  });
  it('retains other types when an individual request exhausts its timeout', async () => {
    fakeFetch((url, init) =>
      url.searchParams.get('type') === 'bold'
        ? new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            }),
          )
        : Response.json(['0001']),
    );
    const result = await settle(runToolContract(crosswalkIdTool, { aphiaId: 1 }));
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      ids: { algaebase: ['0001'], gisd: ['0001'] },
      failedTypes: [{ type: 'bold', error: { reason: 'upstream_timeout' } }],
    });
  });
  it('discards earlier successes when the whole-tool deadline expires', async () => {
    const network = fakeFetch((_url, init, index) =>
      index === 0
        ? Response.json(['0001'])
        : new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            }),
          ),
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
    const network = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          }),
        ),
    );
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
