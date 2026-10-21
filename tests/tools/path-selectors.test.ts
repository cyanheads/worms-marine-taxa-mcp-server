/**
 * @fileoverview Path selector validation through real handlers and the fetch boundary.
 * @module tests/tools/path-selectors.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crosswalkIdTool } from '@/mcp-server/tools/definitions/crosswalk-id.tool.js';
import { resolveTaxonTool } from '@/mcp-server/tools/definitions/resolve-taxon.tool.js';
import { expectParity, fakeFetch, record, settle, setupWorms } from '../helpers/worms.js';

beforeEach(setupWorms);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('path selectors', () => {
  it.each([
    ...['.', '..'].flatMap((value) =>
      ['externalId', 'vernacular'].map((selector) => ({ value, selector })),
    ),
    ...[' . ', ' .. '].map((value) => ({ value, selector: 'vernacular' })),
  ])('rejects dot-only $selector $value before fetch', async ({ value, selector }) => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetch);
    const result =
      selector === 'externalId'
        ? await settle(runToolContract(crosswalkIdTool, { externalId: value, type: 'ncbi' }))
        : await settle(runToolContract(resolveTaxonTool, { vernacular: value }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'invalid_selector',
          recovery: { hint: expect.stringContaining('cannot be . or ..') },
        },
      },
    });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('invalid_selector');
    expect(text).toContain('cannot be . or ..');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['sp. fish', '...', '0001/a b', 'urn:lsid:test:1', 'https://example.org/a.b', '%2e%2e'])(
    'preserves meaningful path selector %j on both surfaces',
    async (value) => {
      const network = fakeFetch((url) => {
        if (url.pathname.startsWith('/rest/AphiaRecordByExternalID/')) {
          expect(url.pathname).toBe(`/rest/AphiaRecordByExternalID/${encodeURIComponent(value)}`);
          return Response.json(record(1));
        }
        expect(url.pathname).toBe(`/rest/AphiaRecordsByVernacular/${encodeURIComponent(value)}`);
        return Response.json([record(1)]);
      });
      const reverse = await settle(
        runToolContract(crosswalkIdTool, { externalId: value, type: 'lsid' }),
      );
      expectParity(reverse);
      expect(reverse.structuredContent).toMatchObject({ externalId: value, found: true });
      const vernacular = await settle(runToolContract(resolveTaxonTool, { vernacular: value }));
      expectParity(vernacular);
      expect(vernacular.structuredContent).toMatchObject({
        results: [{ input: value, matches: [{ aphiaId: 1 }] }],
      });
      expect(network.calls).toHaveLength(2);
    },
  );

  it('preserves scientific names containing dots in query parameters', async () => {
    const names = ['Calanus sp.', 'A. marina'];
    const network = fakeFetch((url) => {
      expect(url.pathname).toBe('/rest/AphiaRecordsByNames');
      expect(url.searchParams.getAll('scientificnames[]')).toEqual(names);
      return Response.json([[record(1)], []]);
    });
    const result = await settle(runToolContract(resolveTaxonTool, { names }));
    expectParity(result);
    expect(result.structuredContent).toMatchObject({ results: names.map((input) => ({ input })) });
    expect(network.calls).toHaveLength(1);
  });
});
