/**
 * @fileoverview Taxonomy contracts exercised through real handlers and fetch.
 * @module tests/tools/list-reference.taxonomy.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crosswalkIdTool } from '@/mcp-server/tools/definitions/crosswalk-id.tool.js';
import { getClassificationTool } from '@/mcp-server/tools/definitions/get-classification.tool.js';
import { getDistributionsTool } from '@/mcp-server/tools/definitions/get-distributions.tool.js';
import { getSynonymsTool } from '@/mcp-server/tools/definitions/get-synonyms.tool.js';
import { getTaxonTool } from '@/mcp-server/tools/definitions/get-taxon.tool.js';
import { getTraitsTool } from '@/mcp-server/tools/definitions/get-traits.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { resolveTaxonTool } from '@/mcp-server/tools/definitions/resolve-taxon.tool.js';
import { offsetSchema } from '@/services/worms/index.js';
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
  const failing = [
    { tool: resolveTaxonTool, run: () => runToolContract(resolveTaxonTool, { names: ['A'] }) },
    { tool: getTaxonTool, run: () => runToolContract(getTaxonTool, { aphiaIds: [1] }) },
    {
      tool: getClassificationTool,
      run: () => runToolContract(getClassificationTool, { aphiaId: 1 }),
    },
    { tool: getSynonymsTool, run: () => runToolContract(getSynonymsTool, { aphiaId: 1 }) },
    {
      tool: getDistributionsTool,
      run: () => runToolContract(getDistributionsTool, { aphiaId: 1 }),
    },
    { tool: getTraitsTool, run: () => runToolContract(getTraitsTool, { aphiaId: 1 }) },
    {
      tool: crosswalkIdTool,
      run: () => runToolContract(crosswalkIdTool, { aphiaId: 1, type: 'ncbi' }),
    },
    { tool: listReferenceTool, run: () => runToolContract(listReferenceTool, { topic: 'ranks' }) },
  ];
  it.each(
    failing.flatMap(({ tool, run }) =>
      (
        [
          ['upstream_rejected', 400],
          ['upstream_rate_limited', 429],
          ['upstream_access_denied', 403],
          ['upstream_unavailable', 500],
          ['upstream_timeout', 504],
          ['invalid_upstream_response', 404],
          ['response_too_large', 200],
        ] as const
      ).map(([reason, status]) => ({ name: tool.name, tool, run, reason, status })),
    ),
  )(
    '$name throws $reason with its own declared recovery on both error surfaces',
    async ({ tool, run, reason, status }) => {
      fakeFetch(() =>
        reason === 'response_too_large'
          ? new Response(new Uint8Array(8 * 1024 * 1024 + 1))
          : new Response('private upstream content', { status }),
      );
      const entry = declared(tool, reason);
      const result = await settle(run());
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: entry.code,
          data: { reason, retryable: entry.retryable, recovery: { hint: entry.recovery } },
        },
      });
      if (tool === crosswalkIdTool && reason !== 'upstream_rejected')
        expect(result.structuredContent).toMatchObject({
          error: { data: { failedTypes: [{ type: 'ncbi', error: { recovery: entry.recovery } }] } },
        });
      const text = contentText(result);
      expect(text).toContain(reason);
      expect(text).toContain(entry.recovery);
      expect(JSON.stringify(result)).not.toContain('private upstream content');
      const narrowing = tool === crosswalkIdTool && reason === 'upstream_timeout';
      expect(entry.recovery.includes('with one type')).toBe(narrowing);
      if (narrowing)
        expect(entry.recovery).toContain(
          'if type was omitted, call worms_crosswalk_id with one type',
        );
      else expect(entry.recovery).not.toContain(tool.name);
      if (reason === 'response_too_large' && tool === resolveTaxonTool)
        expect(entry.recovery).toMatch(
          /^If several names were submitted, submit fewer per call; for one name or a vernacular, /,
        );
      if (reason === 'response_too_large' && tool === getTaxonTool)
        expect(entry.recovery).toMatch(
          /^If several aphiaIds were submitted, submit fewer per call\. For a single ID, /,
        );
      if (tool !== crosswalkIdTool)
        expect(entry.recovery).not.toMatch(
          /worms_crosswalk_id|worms_list_reference|external_id_types/,
        );
      if (tool === resolveTaxonTool || tool === listReferenceTool)
        expect(entry.recovery).not.toMatch(/worms_get_taxon|AphiaID/);
    },
  );
  it('groups every documented WoRMS status with a meaning and the non-exhaustive marker', async () => {
    offline();
    const result = await settle(runToolContract(listReferenceTool, { topic: 'statuses' }));
    expectParity(result);
    const entries = (
      result.structuredContent as {
        entries: { value: string; description: string; group: string }[];
      }
    ).entries;
    const grouped = Object.groupBy(entries, (entry) => entry.group);
    expect(
      Object.fromEntries(
        Object.entries(grouped).map(([group, rows]) => [group, rows?.map((row) => row.value)]),
      ),
    ).toEqual({
      accepted: [
        'accepted',
        'unreplaced junior homonym',
        'nomen protectum',
        'nomen novum',
        'alternative representation',
      ],
      unaccepted: [
        'unaccepted',
        'superseded combination',
        'superseded rank',
        'junior subjective synonym',
        'junior objective synonym',
        'junior homonym',
        'nomen nudum',
        'nomen oblitum',
        'nomen rejiciendum',
        'misspelling - incorrect original spelling',
        'misspelling - incorrect subsequent spelling',
        'unjustified emendation',
        'incorrect grammatical agreement of specific epithet',
        'misapplication',
        'unavailable name',
        'interim unpublished',
      ],
      uncertain: ['uncertain', 'nomen dubium', 'taxon inquirendum', 'temporary name', 'unassessed'],
      technical: ['quarantined', 'deleted'],
    });
    expect(entries.find((entry) => entry.value === 'accepted')?.description).toContain(
      'non-exhaustive',
    );
    for (const entry of entries) {
      expect(Object.keys(entry)).toEqual(['value', 'description', 'group']);
      expect(entry.description).toMatch(/^\S.*\.$/);
      expect(entry.description).not.toContain('\n');
    }
    expect(result.structuredContent).toMatchObject({ totalCount: 28, nextResultOffset: null });
  });
  it('lists observed distribution filter values verbatim without requests', async () => {
    offline();
    const result = await settle(
      runToolContract(listReferenceTool, { topic: 'distribution_terms' }),
    );
    expectParity(result);
    const entries = (
      result.structuredContent as {
        entries: { field: string; description: string; observedValues: string[] }[];
      }
    ).entries;
    expect(entries.map(({ field, observedValues }) => [field, observedValues])).toEqual([
      ['establishmentMeans', ['Alien', 'Native', 'Native - Non-endemic']],
      [
        'invasiveness',
        [
          'Invasive',
          'Not invasive',
          'Uncertain',
          'Not specified',
          'Of concern',
          'Management recorded',
        ],
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
    ]);
    for (const entry of entries) {
      expect(entry.description).toContain('non-exhaustive');
      expect(entry.description).toContain('whole value');
      expect(entry.description).toContain(`worms_get_distributions ${entry.field}`);
    }
    expect(result.structuredContent).toMatchObject({
      topic: 'distribution_terms',
      totalCount: 3,
      nextResultOffset: null,
    });
  });
  it.each(['external_id_types', 'statuses', 'environment_flags', 'distribution_terms'] as const)(
    'renders complete static %s without requests and reassembles it from any resultOffset',
    async (topic) => {
      offline();
      const full = await settle(runToolContract(listReferenceTool, { topic }));
      expectParity(full);
      expect(full.structuredContent).toMatchObject({ topic });
      const entries = (full.structuredContent as { entries: unknown[] }).entries;
      for (const resultOffset of [
        1,
        Math.floor(entries.length / 2),
        entries.length - 1,
        entries.length,
        99,
      ]) {
        const segment = await settle(runToolContract(listReferenceTool, { topic, resultOffset }));
        expectParity(segment);
        expect(segment.structuredContent).toMatchObject({
          resultOffset,
          totalCount: entries.length,
          returnedCount: Math.max(0, entries.length - resultOffset),
          nextResultOffset: null,
        });
        expect((segment.structuredContent as { entries: unknown[] }).entries).toEqual(
          entries.slice(resultOffset),
        );
      }
    },
  );
  it('points every distribution text filter at the distribution_terms topic', () => {
    for (const field of ['establishmentMeans', 'invasiveness', 'occurrence'] as const)
      expect(getDistributionsTool.input.shape[field].description).toContain(
        'worms_list_reference topic: distribution_terms',
      );
  });
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
  it.each(
    [false, true].flatMap((fuzzy) =>
      [true, false].flatMap((marineOnly) =>
        [true, false].map((extantOnly) => ({ fuzzy, marineOnly, extantOnly })),
      ),
    ),
  )('names every lifting option in miss guidance for %j', async (options) => {
    const network = fakeFetch(() => Response.json([null, [record(877220)]]));
    const result = await settle(
      runToolContract(resolveTaxonTool, { names: ['Trilobita', 'Hit'], ...options }),
    );
    expectParity(result);
    const guidance = [
      options.fuzzy
        ? 'Check spelling and call worms_resolve_taxon with corrected names.'
        : 'Call worms_resolve_taxon with the same names and fuzzy: true.',
      ...(options.marineOnly
        ? ['Call worms_resolve_taxon with marineOnly: false to include non-marine taxa.']
        : []),
      ...(options.extantOnly
        ? ['Call worms_resolve_taxon with extantOnly: false to include extinct taxa.']
        : []),
    ].join(' ');
    expect(result.structuredContent).toMatchObject({
      mode: options.fuzzy ? 'fuzzy' : 'exact',
      results: [
        { input: 'Trilobita', matches: [], guidance },
        { input: 'Hit', matches: [{ aphiaId: 877220 }], guidance: null },
      ],
    });
    expect(network.calls[0]?.searchParams.get('extant_only')).toBe(String(options.extantOnly));
  });
  it('describes offset as vernacular-only on this tool without changing the shared schema', () => {
    const property = (schema: z.ZodType) =>
      z.toJSONSchema(schema, { io: 'input' }).properties?.offset as { description: string };
    const { description, ...offset } = property(resolveTaxonTool.input);
    const { description: shared, ...sharedOffset } = property(getClassificationTool.input);
    expect(description).toMatch(/^Vernacular only/);
    expect(offset).toStrictEqual(sharedOffset);
    expect(offset).toMatchObject({ type: 'integer', default: 1 });
    expect(shared).toBe(offsetSchema.description);
    expect(offsetSchema.description).toBe('One-based starting record, advancing by 50; default 1.');
    expect(getClassificationTool.input.shape.offset.description).toBe(offsetSchema.description);
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
  it.each(
    (['exact', 'contains'] as const).flatMap((vernacularMatch) =>
      [0, 49, 50].map((count) => ({ vernacularMatch, count })),
    ),
  )(
    'reports honest $vernacularMatch vernacular pagination for $count rows',
    async ({ vernacularMatch, count }) => {
      const network = fakeFetch(() =>
        count
          ? Response.json(Array.from({ length: count }, (_, index) => record(index + 1)))
          : new Response(null, { status: 204 }),
      );
      const result = await settle(
        runToolContract(resolveTaxonTool, { vernacular: 'sea star', offset: 51, vernacularMatch }),
      );
      expectParity(result);
      expect(network.calls.map((url) => [url.pathname, url.searchParams.toString()])).toEqual([
        [
          '/rest/AphiaRecordsByVernacular/sea%20star',
          `like=${vernacularMatch === 'contains'}&offset=51`,
        ],
      ]);
      expect(result.structuredContent).toMatchObject({
        mode: 'vernacular',
        results: [{ input: 'sea star', matches: Array.from({ length: count }, () => ({})) }],
        page: {
          offset: 51,
          returnedCount: count,
          hasMore: count === 50 ? null : false,
          nextOffset: count === 50 ? 101 : null,
        },
        echo: { marineOnly: null, extantOnly: null, fuzzy: false, offset: 51, vernacularMatch },
      });
      const data = result.structuredContent as { notice?: string };
      if (count) expect(data).not.toHaveProperty('notice');
      else if (vernacularMatch === 'exact')
        expect(data.notice).toContain('vernacularMatch: "contains"');
      else {
        expect(data.notice).toBe(
          'Call worms_resolve_taxon with a broader vernacular or offset: 1.',
        );
        expect(data.notice).not.toContain('vernacularMatch');
      }
    },
  );
  it.each([
    {
      vernacularMatch: 'exact',
      offset: 1,
      notice:
        'Call worms_resolve_taxon with vernacularMatch: "contains" to match part of a recorded common name, or with a broader vernacular.',
    },
    {
      vernacularMatch: 'exact',
      offset: 51,
      notice:
        'Call worms_resolve_taxon with vernacularMatch: "contains" to match part of a recorded common name, or with a broader vernacular or offset: 1.',
    },
    {
      vernacularMatch: 'contains',
      offset: 1,
      notice: 'Call worms_resolve_taxon with a broader vernacular.',
    },
    {
      vernacularMatch: 'contains',
      offset: 51,
      notice: 'Call worms_resolve_taxon with a broader vernacular or offset: 1.',
    },
  ] as const)(
    'offers offset: 1 for an empty $vernacularMatch vernacular page only past offset 1 (offset $offset)',
    async ({ vernacularMatch, offset, notice }) => {
      const network = fakeFetch(() => new Response(null, { status: 204 }));
      const result = await settle(
        runToolContract(resolveTaxonTool, { vernacular: 'grouper', vernacularMatch, offset }),
      );
      expectParity(result);
      expect(network.calls.map((url) => url.searchParams.get('offset'))).toEqual([String(offset)]);
      expect(result.structuredContent).toMatchObject({
        results: [{ input: 'grouper', matches: [] }],
        echo: { offset, vernacularMatch },
        notice,
      });
    },
  );
  it.each(['exact', 'contains'] as const)(
    'names a single-input step when one %s vernacular returns an oversized response',
    async (vernacularMatch) => {
      fakeFetch(() => new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
      const result = await settle(
        runToolContract(resolveTaxonTool, { vernacular: 'grouper', vernacularMatch }),
      );
      const hint = declared(resolveTaxonTool, 'response_too_large').recovery;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'response_too_large', recovery: { hint } } },
      });
      expect(contentText(result)).toContain(hint);
      expect(hint).toContain(
        'for one name or a vernacular, submit a more specific one, or use exact matching if fuzzy: true or vernacularMatch: "contains" was set',
      );
    },
  );
  it.each([{}, { vernacularMatch: ' ' as 'exact' }])(
    'sends an explicit exact vernacular search for %j and keeps its results',
    async (option) => {
      const network = fakeFetch(() =>
        Response.json([record(126436, { scientificname: 'Gadus morhua' })]),
      );
      const result = await settle(
        runToolContract(resolveTaxonTool, { vernacular: 'Atlantic cod', ...option }),
      );
      expectParity(result);
      expect(network.calls.map((url) => url.search)).toEqual(['?like=false&offset=1']);
      expect(result.structuredContent).toMatchObject({
        mode: 'vernacular',
        results: [
          { input: 'Atlantic cod', matches: [{ aphiaId: 126436, scientificname: 'Gadus morhua' }] },
        ],
        echo: { offset: 1, vernacularMatch: 'exact' },
      });
    },
  );
  it('accepts the default exact vernacularMatch on scientific names without echoing it', async () => {
    const network = fakeFetch(() => Response.json([[record(1)]]));
    const result = await settle(
      runToolContract(resolveTaxonTool, { names: ['A'], vernacularMatch: 'exact', offset: 1 }),
    );
    expectParity(result);
    expect(network.calls.map((url) => url.pathname)).toEqual(['/rest/AphiaRecordsByNames']);
    expect(network.calls[0]?.searchParams.get('like')).toBe('false');
    expect(result.structuredContent).toMatchObject({ mode: 'exact', echo: { fuzzy: false } });
    expect(result.structuredContent).not.toHaveProperty('echo.vernacularMatch');
    expect(result.structuredContent).not.toHaveProperty('echo.offset');
  });
  it.each([
    [{}, 'invalid_selector'],
    [{ names: ['A'], vernacular: 'B' }, 'invalid_selector'],
    [{ names: ['A'], offset: 2 }, 'unsupported_mode_options'],
    [{ vernacular: 'A', fuzzy: true }, 'unsupported_mode_options'],
    [{ vernacular: 'A', marineOnly: false }, 'unsupported_mode_options'],
    [{ vernacular: 'A', extantOnly: false }, 'unsupported_mode_options'],
    [{ names: ['A'], vernacularMatch: 'contains' }, 'unsupported_mode_options'],
    [{ vernacular: 'A', vernacularMatch: 'contains', fuzzy: true }, 'unsupported_mode_options'],
    [
      { vernacular: 'A', vernacularMatch: 'contains', marineOnly: false },
      'unsupported_mode_options',
    ],
  ] as const)('rejects invalid selector/options before fetch: %j', async (input, reason) => {
    offline();
    const result = await settle(
      runToolContract(resolveTaxonTool, {
        ...input,
        names: 'names' in input ? [...input.names] : undefined,
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { data: { reason } } });
  });
});

/** Upstream AphiaSourcesByAphiaID rows (126436 and 104464, references shortened) plus a sparse row. */
const sourceRows = [
  {
    source_id: 8,
    use: 'original description',
    reference:
      'Linnaeus, C. (1758). Systema Naturae [...]. Editio decima, reformata. 1:[iii] + 824 pp.',
    page: '252',
    url: 'https://www.marinespecies.org/aphia.php?p=sourcedetails&id=8',
    link: 'https://biodiversitylibrary.org/page/726886',
    fulltext: null,
    doi: '10.5962/bhl.title.542',
  },
  {
    source_id: 1411,
    use: 'basis of record',
    reference: 'van der Land, J.; Costello, M.J. (2001). Pisces, in: Costello, M.J. et al. (Ed.).',
    page: null,
    url: 'https://www.marinespecies.org/aphia.php?p=sourcedetails&id=1411',
    link: null,
    fulltext: null,
    doi: null,
  },
  {
    source_id: 452925,
    use: 'ecology source',
    reference:
      'Looby, A.; Jézéquel, Y. (2023). Global inventory of species categorized by known underwater sonifery.',
    page: null,
    url: 'https://www.marinespecies.org/aphia.php?p=sourcedetails&id=452925',
    link: null,
    fulltext: 'https://www.marinespecies.org/aphia.php?p=sourceget&id=452925',
    doi: '10.1038/s41597-023-02745-4',
  },
  {
    source_id: 451406,
    use: 'context source (Deepsea)',
    reference: 'Halland, G.R. (2017). Uptake and excretion of polystyrene microplastics.',
    page: null,
    url: 'https://www.marinespecies.org/aphia.php?p=sourcedetails&id=451406',
    link: 'http:// http://hdl.handle.net/11250/2496224  ',
    fulltext: null,
    doi: null,
  },
  { source_id: 5, reference: null },
];

describe('taxon retrieval', () => {
  it.each(['missing', 'failure'])(
    'omits filtered source counts after a %s primary/source read',
    async (mode) => {
      const network = fakeFetch((url) =>
        url.pathname === '/rest/AphiaRecordsByAphiaIDs'
          ? Response.json(mode === 'missing' ? [null] : [record(1)])
          : new Response(null, { status: 403 }),
      );
      const result = await settle(
        runToolContract(getTaxonTool, {
          aphiaIds: [1],
          includeSources: true,
          sourceUse: 'original description',
        }),
      );
      expectParity(result);
      for (const key of ['sourceTotalCount', 'unfilteredSourceCount', 'sources'])
        expect(result.structuredContent).not.toHaveProperty(`results.0.${key}`);
      expect(network.calls).toHaveLength(mode === 'missing' ? 1 : 2);
      if (mode === 'failure')
        expect(result.structuredContent).toMatchObject({
          results: [{ sourcesError: { reason: 'upstream_access_denied' } }],
        });
    },
  );
  it('rejects an oversized sourceUse before primary retrieval', async () => {
    offline();
    const result = await settle(
      runToolContract(getTaxonTool, {
        aphiaIds: [1],
        includeSources: true,
        sourceUse: 'x'.repeat(513),
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
  });
  it.each(['original description', 'ORIGINAL DESCRIPTION'])(
    'filters complete sources by whole use %s before offset and preserves every field',
    async (sourceUse) => {
      const selected = {
        source_id: 90278,
        use: 'original description',
        reference: 'A\r\n\n`|<>',
        page: null,
        url: 'https://example.org/a_(b)',
        link: '',
        fulltext: null,
        doi: '10.1/x',
      };
      const rows = Array.from({ length: 631 }, (_, index) =>
        index === 627
          ? selected
          : { source_id: index, use: index === 628 ? null : 'additional source' },
      );
      rows.push(selected);
      const network = fakeFetch((url) =>
        Response.json(url.pathname === '/rest/AphiaRecordsByAphiaIDs' ? [record(104464)] : rows),
      );
      const result = await settle(
        runToolContract(getTaxonTool, {
          aphiaIds: [104464],
          includeSources: true,
          sourceUse,
          sourceOffset: 1,
        }),
      );
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        results: [
          {
            record: { aphiaId: 104464 },
            sourceTotalCount: 2,
            unfilteredSourceCount: 632,
            sources: [
              {
                sourceId: 90278,
                ...Object.fromEntries(
                  Object.entries(selected).filter(([key]) => key !== 'source_id'),
                ),
              },
            ],
          },
        ],
        nextSourceOffset: null,
        echo: { sourceUse },
      });
      expect(network.calls).toHaveLength(2);
    },
  );
  it.each(['original', ' original description ', 'unknown'])(
    'reports no matching source use %s without inventing an empty bibliography',
    async (sourceUse) => {
      fakeFetch((url) =>
        Response.json(
          url.pathname === '/rest/AphiaRecordsByAphiaIDs'
            ? [record(1)]
            : [{ use: 'original description' }, { use: null }, {}],
        ),
      );
      const result = await settle(
        runToolContract(getTaxonTool, {
          aphiaIds: [1],
          includeSources: true,
          sourceUse,
          sourceOffset: 99,
        }),
      );
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        results: [{ sources: [], sourceTotalCount: 0, unfilteredSourceCount: 3 }],
        notice: expect.stringContaining('remove or change sourceUse'),
        echo: { sourceUse },
      });
      expect(contentText(result)).not.toContain('sourceOffset: 0');
    },
  );
  it.each(['', ' \r\n '])(
    'omits blank sourceUse %j and reports successful unfiltered counts',
    async (sourceUse) => {
      fakeFetch((url) =>
        Response.json(url.pathname === '/rest/AphiaRecordsByAphiaIDs' ? [record(1)] : sourceRows),
      );
      const result = await settle(
        runToolContract(getTaxonTool, { aphiaIds: [1], includeSources: true, sourceUse }),
      );
      expectParity(result);
      expect(result.structuredContent).toMatchObject({ results: [{ sourceTotalCount: 5 }] });
      expect(result.structuredContent).not.toHaveProperty('results.0.unfilteredSourceCount');
      expect(result.structuredContent).not.toHaveProperty('echo.sourceUse');
    },
  );
  it.each([false, true])(
    'distinguishes empty sources from past-end selection (empty %s)',
    async (empty) => {
      fakeFetch((url) =>
        Response.json(
          url.pathname === '/rest/AphiaRecordsByAphiaIDs'
            ? [record(1)]
            : empty
              ? []
              : [{ use: 'original description' }],
        ),
      );
      const result = await settle(
        runToolContract(getTaxonTool, {
          aphiaIds: [1],
          includeSources: true,
          sourceUse: 'original description',
          sourceOffset: 99,
        }),
      );
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        results: [
          { sources: [], sourceTotalCount: empty ? 0 : 1, unfilteredSourceCount: empty ? 0 : 1 },
        ],
        notice: expect.stringContaining(empty ? 'No sources were returned' : 'sourceOffset: 0'),
      });
      if (empty) expect(contentText(result)).not.toContain('sourceOffset: 0');
    },
  );
  it('keeps sourceUse inactive without includeSources', async () => {
    const network = fakeFetch(() => Response.json([record(1)]));
    const result = await settle(
      runToolContract(getTaxonTool, { aphiaIds: [1], sourceUse: 'original description' }),
    );
    expectParity(result);
    for (const key of [
      'results.0.sources',
      'results.0.sourceTotalCount',
      'results.0.unfilteredSourceCount',
      'echo.sourceUse',
    ])
      expect(result.structuredContent).not.toHaveProperty(key);
    expect(network.calls).toHaveLength(1);
  });
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
  it.each([
    ['includeVernaculars', 'vernacularError', '/rest/AphiaVernacularsByAphiaID/1'],
    ['includeSources', 'sourcesError', '/rest/AphiaSourcesByAphiaID/1'],
  ] as const)(
    'retains the primary record after an exhausted optional %s request timeout',
    async (option, errorField, path) => {
      const network = fakeFetch((_url, init, index) =>
        index ? hang(init) : Response.json([record(1)]),
      );
      const result = await settle(runToolContract(getTaxonTool, { aphiaIds: [1], [option]: true }));
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        results: [
          {
            found: true,
            record: { aphiaId: 1 },
            [errorField]: {
              reason: 'upstream_timeout',
              recovery: declared(getTaxonTool, 'upstream_timeout').recovery,
            },
          },
        ],
      });
      expect(network.calls.map((url) => url.pathname)).toEqual([
        '/rest/AphiaRecordsByAphiaIDs',
        path,
        path,
      ]);
    },
  );
  it.each([
    ['includeVernaculars', 'vernacularError'],
    ['includeSources', 'sourcesError'],
  ] as const)(
    'returns the single record beside an oversized optional %s list with a single-ID step',
    async (option, errorField) => {
      const network = fakeFetch((_url, _init, index) =>
        index ? new Response(new Uint8Array(8 * 1024 * 1024 + 1)) : Response.json([record(1)]),
      );
      const result = await settle(runToolContract(getTaxonTool, { aphiaIds: [1], [option]: true }));
      expectParity(result);
      const { recovery } = declared(getTaxonTool, 'response_too_large');
      expect(result.structuredContent).toMatchObject({
        results: [
          {
            found: true,
            record: { aphiaId: 1 },
            [errorField]: { reason: 'response_too_large', recovery, retryable: false },
          },
        ],
        nextVernacularOffset: null,
        nextSourceOffset: null,
      });
      expect(recovery).toContain(
        'For a single ID, use the record returned beside an oversized common-name or source list',
      );
      expect(network.calls).toHaveLength(2);
    },
  );
  it('describes both nested continuations as null when consumed or not requested', () => {
    const properties = z.toJSONSchema(getTaxonTool.output).properties as Record<
      string,
      { description: string }
    >;
    expect(properties.nextVernacularOffset?.description).toBe(
      'Resume common names for the same singleton record; null when consumed or not requested.',
    );
    expect(properties.nextSourceOffset?.description).toBe(
      'Resume sources for the same singleton record; null when consumed or not requested.',
    );
  });
  it.each(['includeVernaculars', 'includeSources'] as const)(
    'discards primary success when the whole-tool deadline expires during optional %s work',
    async (option) => {
      const network = fakeFetch((_url, _init, index) => {
        if (!index) return Response.json([record(1)]);
        vi.setSystemTime(Date.now() + 45_001);
        return Response.json([]);
      });
      const result = await settle(runToolContract(getTaxonTool, { aphiaIds: [1], [option]: true }));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'upstream_timeout' } },
      });
      expect(result.structuredContent).not.toHaveProperty('results');
      expect(network.calls).toHaveLength(2);
    },
  );
  it.each(['includeVernaculars', 'includeSources'] as const)(
    'cancels optional %s work atomically even after primary success',
    async (option) => {
      const abort = new AbortController();
      const network = fakeFetch((_url, _init, index) => {
        if (!index) return Response.json([record(1)]);
        abort.abort();
        return Response.json([]);
      });
      const result = await settle(
        runToolContract(
          getTaxonTool,
          { aphiaIds: [1], [option]: true },
          { context: { signal: abort.signal } },
        ),
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
      expect(result.structuredContent).not.toHaveProperty('results');
      expect(network.calls).toHaveLength(2);
    },
  );
  it('retains positional null/all-null misses, duplicates, and flag uncertainty', async () => {
    const network = fakeFetch(() =>
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
      nextVernacularOffset: null,
      nextSourceOffset: null,
      echo: { includeVernaculars: false, includeSources: false },
    });
    const data = result.structuredContent as { results: object[] };
    for (const row of data.results) {
      expect(row).not.toHaveProperty('sources');
      expect(row).not.toHaveProperty('sourcesError');
    }
    expect(network.calls).toHaveLength(1);
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
      nextSourceOffset: null,
      echo: { includeVernaculars: true, includeSources: false },
    });
    expect(result.structuredContent).not.toHaveProperty('results.0.sources');
    expect(network.calls.map((url) => url.pathname)).toEqual([
      '/rest/AphiaRecordsByAphiaIDs',
      '/rest/AphiaVernacularsByAphiaID/1',
    ]);
    expect((network.starts[1] ?? 0) - (network.starts[0] ?? 0)).toBeGreaterThanOrEqual(500);
  });
  it('retrieves every source row unmodified, in source order, after the record', async () => {
    const network = fakeFetch((url) =>
      Response.json(
        url.pathname === '/rest/AphiaRecordsByAphiaIDs' ? [record(126436)] : sourceRows,
      ),
    );
    const result = await settle(
      runToolContract(getTaxonTool, { aphiaIds: [126436], includeSources: true }),
    );
    expectParity(result);
    expect(network.calls.map((url) => [url.pathname, url.search])).toEqual([
      ['/rest/AphiaRecordsByAphiaIDs', '?aphiaids%5B%5D=126436'],
      ['/rest/AphiaSourcesByAphiaID/126436', ''],
    ]);
    const data = result.structuredContent as { results: { sources: unknown[] }[] };
    expect(data.results[0]?.sources).toStrictEqual(
      sourceRows.map(({ source_id, ...fields }) => ({ sourceId: source_id, ...fields })),
    );
    expect(result.structuredContent).toMatchObject({
      results: [{ found: true, record: { aphiaId: 126436 } }],
      nextInputOffset: null,
      nextVernacularOffset: null,
      nextSourceOffset: null,
      echo: { includeVernaculars: false, includeSources: true },
    });
    expect(result.structuredContent).not.toHaveProperty('results.0.sourcesError');
    expect(result.structuredContent).not.toHaveProperty('results.0.vernaculars');
  });
  it('returns an empty source list for HTTP 204 without sourcesError', async () => {
    fakeFetch((url) =>
      url.pathname === '/rest/AphiaRecordsByAphiaIDs'
        ? Response.json([record(1)])
        : new Response(null, { status: 204 }),
    );
    const result = await settle(
      runToolContract(getTaxonTool, { aphiaIds: [1], includeSources: true }),
    );
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      results: [{ found: true, sources: [] }],
      nextSourceOffset: null,
    });
    expect(result.structuredContent).not.toHaveProperty('results.0.sourcesError');
  });
  it.each([
    ['literal null', [null]],
    ['batch 204', null],
  ] as const)('makes no source request for a missing record (%s)', async (_label, batch) => {
    const network = fakeFetch(() =>
      batch ? Response.json(batch) : new Response(null, { status: 204 }),
    );
    const result = await settle(
      runToolContract(getTaxonTool, { aphiaIds: [7], includeSources: true }),
    );
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      results: [{ requestedAphiaId: 7, found: false, record: null }],
      nextSourceOffset: null,
    });
    expect(result.structuredContent).not.toHaveProperty('results.0.sources');
    expect(result.structuredContent).not.toHaveProperty('results.0.sourcesError');
    expect(network.calls.map((url) => url.pathname)).toEqual(['/rest/AphiaRecordsByAphiaIDs']);
    expect(result.structuredContent).not.toHaveProperty('results.0.sourceTotalCount');
    expect(result.structuredContent).not.toHaveProperty('results.0.unfilteredSourceCount');
  });
  it.each(
    (
      [
        ['includeVernaculars', 'vernaculars', 'vernacularError', 'nextVernacularOffset'],
        ['includeSources', 'sources', 'sourcesError', 'nextSourceOffset'],
      ] as const
    ).flatMap(([option, field, errorField, next]) =>
      (
        [
          [403, 'upstream_access_denied', 2],
          [500, 'upstream_unavailable', 3],
          [400, 'upstream_rejected', 2],
          [422, 'upstream_rejected', 2],
        ] as const
      ).map(([status, reason, calls]) => ({
        option,
        field,
        errorField,
        next,
        status,
        reason,
        calls,
      })),
    ),
  )(
    'keeps the record for an optional $option outage but fails atomically on HTTP $status',
    async ({ option, field, errorField, next, status, reason, calls }) => {
      const network = fakeFetch((_url, _init, index) =>
        index === 0
          ? Response.json([record(1)])
          : new Response('private upstream body', { status }),
      );
      const result = await settle(runToolContract(getTaxonTool, { aphiaIds: [1], [option]: true }));
      if (reason === 'upstream_rejected') {
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { data: { reason } } });
        expect(result.structuredContent).not.toHaveProperty('results');
      } else {
        expectParity(result);
        const { code, recovery, retryable } = declared(getTaxonTool, reason);
        expect(result.structuredContent).toMatchObject({
          results: [
            {
              found: true,
              record: { aphiaId: 1 },
              [errorField]: { reason, code, recovery, retryable },
            },
          ],
          [next]: null,
        });
        expect(result.structuredContent).not.toHaveProperty(`results.0.${field}`);
        if (option === 'includeSources') {
          expect(result.structuredContent).not.toHaveProperty('results.0.sourceTotalCount');
          expect(result.structuredContent).not.toHaveProperty('results.0.unfilteredSourceCount');
        }
      }
      expect(network.calls).toHaveLength(calls);
      expect(JSON.stringify(result)).not.toContain('private upstream body');
    },
  );
  it.each([
    [{ aphiaIds: [1, 2], includeVernaculars: true }, 'vernacular_batch'],
    [{ aphiaIds: [1, 2], includeSources: true }, 'sources_batch'],
    [{ aphiaIds: [1], includeVernaculars: true, includeSources: true }, 'enrichment_conflict'],
    [{ aphiaIds: [1, 2], includeVernaculars: true, includeSources: true }, 'enrichment_conflict'],
  ] as const)('rejects %j before requests', async (input, reason) => {
    offline();
    const result = await settle(
      runToolContract(getTaxonTool, { ...input, aphiaIds: [...input.aphiaIds] }),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32007, data: { reason, recovery: { hint: expect.any(String) } } },
    });
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
      const network = fakeFetch(withStatus(null, () => Response.json(tree)));
      const result = await settle(runToolContract(getClassificationTool, { aphiaId: 600 }));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_upstream_response', retryable: false } },
      });
      expect(result.structuredContent).not.toHaveProperty('ranks');
      expect(network.calls).toHaveLength(2);
    },
  );
  it.each([403, 400])(
    'retains lineage only for optional outage, not rejection HTTP %i',
    async (status) => {
      fakeFetch(
        withStatus(null, (url) =>
          url.pathname === '/rest/AphiaClassificationByAphiaID/1'
            ? Response.json({ AphiaID: 1 })
            : new Response(null, { status }),
        ),
      );
      const result = await settle(
        runToolContract(getClassificationTool, { aphiaId: 1, includeChildren: true }),
      );
      if (status === 403) {
        expectParity(result);
        expect(result.structuredContent).toMatchObject({
          found: true,
          ranks: [{ aphiaId: 1 }],
          childrenError: {
            reason: 'upstream_access_denied',
            recovery: declared(getClassificationTool, 'upstream_access_denied').recovery,
          },
        });
        for (const key of ['children', 'page', 'statusError'])
          expect(result.structuredContent).not.toHaveProperty(key);
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
    fakeFetch(withStatus(null, () => Response.json(tree)));
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
      const network = fakeFetch(
        withStatus(null, (url) => {
          if (url.pathname === '/rest/AphiaClassificationByAphiaID/1')
            return Response.json({ AphiaID: 1 });
          expect(url.searchParams.toString()).toBe('offset=51&marine_only=false&extant_only=false');
          return count
            ? Response.json(Array.from({ length: count }, (_, i) => record(i + 2)))
            : new Response(null, { status: 204 });
        }),
      );
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
      expect(network.calls).toHaveLength(3);
    },
  );
  it.each([
    { offset: 1, notice: 'Use worms_list_reference with topic: ranks to inspect rank vocabulary.' },
    {
      offset: 51,
      notice:
        'Call worms_get_classification with offset: 1 to return to the first children page; use worms_list_reference with topic: ranks to inspect rank vocabulary.',
    },
  ])(
    'returns to the first children page only from an empty page past it (offset $offset)',
    async ({ offset, notice }) => {
      const network = fakeFetch(
        withStatus(record(223913, { status: 'accepted', valid_AphiaID: 223913 }), (url) =>
          url.pathname === '/rest/AphiaClassificationByAphiaID/223913'
            ? Response.json({ AphiaID: 137205, child: { AphiaID: 223913 } })
            : new Response(null, { status: 204 }),
        ),
      );
      const result = await settle(
        runToolContract(getClassificationTool, { aphiaId: 223913, includeChildren: true, offset }),
      );
      expectParity(result);
      expect(result.structuredContent).toMatchObject({
        ranks: [{ aphiaId: 137205 }, { aphiaId: 223913 }],
        children: [],
        page: { offset, returnedCount: 0, hasMore: false, nextOffset: null },
        echo: { includeChildren: true, marineOnly: true, extantOnly: true, offset },
        notice,
      });
      expect(network.calls.at(-1)?.searchParams.get('offset')).toBe(String(offset));
    },
  );
  it('does not fetch children for absent classification', async () => {
    const network = fakeFetch(() => new Response(null, { status: 204 }));
    const result = await settle(
      runToolContract(getClassificationTool, { aphiaId: 1, includeChildren: true }),
    );
    expectParity(result);
    expect(result.structuredContent).toMatchObject({ found: false, ranks: [] });
    expect(network.calls.map((url) => url.pathname)).toEqual([
      '/rest/AphiaRecordByAphiaID/1',
      '/rest/AphiaClassificationByAphiaID/1',
    ]);
  });
});

describe('schema boundaries', () => {
  it.each([503, 900])(
    'terminates long checklists at inputOffset %i without requests',
    async (inputOffset) => {
      offline();
      for (const result of [
        await settle(runToolContract(getTaxonTool, { aphiaIds: Array(503).fill(1), inputOffset })),
        await settle(
          runToolContract(resolveTaxonTool, { names: Array(503).fill('A'), inputOffset }),
        ),
      ]) {
        expectParity(result);
        expect(result.structuredContent).toMatchObject({
          results: [],
          nextInputOffset: null,
          deferredCount: 0,
        });
      }
    },
  );
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid long-checklist inputOffset %i before requests',
    async (inputOffset) => {
      offline();
      for (const result of [
        await settle(runToolContract(getTaxonTool, { aphiaIds: Array(503).fill(1), inputOffset })),
        await settle(
          runToolContract(resolveTaxonTool, { names: Array(503).fill('A'), inputOffset }),
        ),
      ])
        expect(result.isError).toBe(true);
    },
  );
  it.each([
    getClassificationTool,
    getSynonymsTool,
    getDistributionsTool,
    getTraitsTool,
    crosswalkIdTool,
  ])('$name normalizes a canonical LSID before every upstream selector', async (tool) => {
    const network = fakeFetch((url) => {
      expect(url.pathname.endsWith('/137205')).toBe(true);
      if (url.pathname.includes('AphiaRecordByAphiaID'))
        return Response.json(record(137205, { status: 'accepted', valid_AphiaID: 137205 }));
      if (url.pathname.includes('AphiaClassificationByAphiaID'))
        return Response.json({ AphiaID: 2, child: { AphiaID: 137205 } });
      return Response.json([]);
    });
    const result = await settle(
      runToolContract(tool, {
        aphiaId: 'urn:lsid:marinespecies.org:taxname:137205',
        ...(tool === crosswalkIdTool ? { type: 'lsid' } : {}),
      }),
    );
    expectParity(result);
    expect(result.structuredContent).toMatchObject({ aphiaId: 137205 });
    expect(network.calls.length).toBe(tool === crosswalkIdTool ? 1 : 2);
    expect(
      tool.output.safeParse({ ...tool.output.parse(result.structuredContent), aphiaId: '137205' })
        .success,
    ).toBe(false);
  });
  it.each([
    'urn:lsid:example.org:taxname:1',
    'urn:lsid:marinespecies.org:taxname:0',
    'urn:lsid:marinespecies.org:taxname:9007199254740992',
    'urn:lsid:marinespecies.org:taxname:1.5',
    'urn:lsid:marinespecies.org:taxname:-1',
    'urn:lsid:marinespecies.org:taxname:1:2',
    'Gadus morhua',
    '1e3',
    '0x10',
  ])('rejects unrecognized ID %s with crosswalk guidance before requests', async (aphiaId) => {
    offline();
    const result = await settle(runToolContract(getTaxonTool, { aphiaIds: [aphiaId] }));
    expect(result.isError).toBe(true);
    const text = contentText(result);
    expect(text).toContain('worms_crosswalk_id');
    expect(text).toContain('externalId');
    expect(text).toContain('lsid');
    expect(text).toContain('worms_resolve_taxon');
  });
  it('rejects empty and invalid scientific batches, including malformed deferred tails, before network', async () => {
    offline();
    for (const names of [
      [],
      [' '],
      [...Array.from({ length: 501 }, () => 'A'), ' '],
      ['x'.repeat(513)],
    ]) {
      const result = await settle(runToolContract(resolveTaxonTool, { names }));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    }
  });
  it('rejects invalid AphiaIDs and offsets before requests', async () => {
    offline();
    for (const aphiaIds of [
      [],
      [0],
      [-1],
      [1.5],
      [Number.MAX_SAFE_INTEGER + 1],
      [...Array.from({ length: 501 }, () => 1), 0],
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
    for (const vernacularMatch of ['like', 'Contains', 'true']) {
      const result = await settle(
        runToolContract(resolveTaxonTool, {
          vernacular: 'grouper',
          vernacularMatch: vernacularMatch as 'exact',
        }),
      );
      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    }
  });
});
