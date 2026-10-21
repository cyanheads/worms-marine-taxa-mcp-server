/**
 * @fileoverview Nested CommonMark list codec: grammar, strict inverse, depth, size, and scan cost.
 * @module tests/services/format.test
 */
import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { codecTrailer, formatData, renderEnrichmentField } from '@/services/worms/index.js';
import { decodeContent } from '../helpers/worms.js';

/** markdown-it `default`: the commonmark grammar plus GFM tables and strikethrough. */
const gfmTables = new MarkdownIt('default');
gfmTables.normalizeLink = (url) => url;
gfmTables.normalizeLinkText = (url) => url;
/** markdown-it with GFM-style extended (bare URL) autolinks. */
const gfmLinkify = new MarkdownIt('default', { linkify: true });

const roundTrip = (value: object) => {
  const content = formatData(value);
  const expected = JSON.parse(JSON.stringify(value));
  expect(decodeContent({ content })).toStrictEqual(expected);
  expect(decodeContent({ content }, gfmTables)).toStrictEqual(expected);
  return content[0].text;
};

/** A normalized Aphia record carrying every documented field. */
const fullRecord = (aphiaId: number) => ({
  aphiaId,
  url: `https://www.marinespecies.org/aphia.php?p=taxdetails&id=${aphiaId}`,
  scientificname: 'Caretta caretta',
  authority: '(Linnaeus, 1758)',
  status: 'accepted',
  unacceptreason: null,
  taxonRankId: 220,
  rank: 'Species',
  validAphiaId: aphiaId,
  validName: 'Caretta caretta',
  validAuthority: '(Linnaeus, 1758)',
  parentAphiaId: 137066,
  originalAphiaId: 1298345,
  kingdom: 'Animalia',
  phylum: 'Chordata',
  class: null,
  order: 'Testudines',
  family: 'Cheloniidae',
  genus: 'Caretta',
  citation: `Uetz, P. (ed.) (2026). The Reptile Database. Caretta caretta (Linnaeus, 1758). Accessed through: World Register of Marine Species at: https://www.marinespecies.org/aphia.php?p=taxdetails&id=${aphiaId} on 2026-10-21`,
  lsid: `urn:lsid:marinespecies.org:taxname:${aphiaId}`,
  modified: '2018-09-21T14:00:23.180Z',
  isMarine: true,
  isBrackish: null,
  isFreshwater: null,
  isTerrestrial: null,
  isExtinct: null,
  matchType: 'exact',
});

describe('list codec grammar', () => {
  it('renders root members as list items with escaped JSON tokens', () => {
    expect(roundTrip({ a: [], b: {}, c: null, d: 'x' })).toBe(
      '- a: \\[\\]\n- b: {}\n- c: null\n- d: "x"',
    );
  });
  it('nests containers with relative keys and links a lone URL', () => {
    const url = 'https://www.marinespecies.org/aphia.php?p=taxdetails&id=137205';
    expect(
      roundTrip({
        results: [{ inputIndex: 0, record: { url, authority: '(Linnaeus, 1758)', class: null } }],
      }),
    ).toBe(
      [
        '- results: array 1',
        '  - object 2',
        '    - inputIndex: 0',
        '    - record: object 3',
        `      - url: <${url}>`,
        '      - authority: "(Linnaeus, 1758)"',
        '      - class: null',
      ].join('\n'),
    );
  });
  it('quotes keys that are not bare identifiers and keeps all-scalar arrays inline', () => {
    expect(roundTrip({ x_y: 1, 'a b': [2, 'https://x.org/a'] })).toBe(
      '- "x\\_y": 1\n- "a b": \\[2,"https\\://x.org/a"\\] <https://x.org/a>',
    );
  });
  it('renders one enrichment field as a root item through the trailer config', () => {
    expect(renderEnrichmentField('echo', { includeVernaculars: false })).toBe(
      '- echo: object 1\n  - includeVernaculars: false',
    );
    expect(codecTrailer('notice', 'echo').notice.render('Narrow the name.')).toBe(
      '- notice: "Narrow the name."',
    );
    expect(renderEnrichmentField('notice', undefined)).toBe('');
  });
  it.each([
    [
      'https://example.org/a_(b)?x=1&y=2#fragment',
      '- url: <https://example.org/a_(b)?x=1&y=2#fragment>',
    ],
    [
      'citation https://example.org/é?q=a%20b and https://example.org/c',
      '- url: "citation https\\://example.org/é?q=a%20b and https\\://example.org/c" <https://example.org/é?q=a%20b> <https://example.org/c>',
    ],
    ['https://example.org/a\\b', '- url: <https://example.org/a\\b>'],
    [
      'https://example.org/a%2Fb?x=%22quoted%22',
      '- url: <https://example.org/a%2Fb?x=%22quoted%22>',
    ],
  ])('preserves exact link destinations: %s', (url, line) => {
    expect(roundTrip({ url })).toBe(line);
  });
  it('keeps URLs inside JSON tokens out of GFM extended autolinks', () => {
    const url = 'https://www.marinespecies.org/aphia.php?p=taxdetails&id=137205';
    const text = roundTrip({
      citation: `Accessed at: ${url} on 2026-10-21`,
      host: 'www.x.org/a_b',
    });
    expect(text).toBe(
      [
        `- citation: "Accessed at: https\\://www\\.marinespecies.org/aphia.php?p=taxdetails\\&id=137205 on 2026-10-21" <${url}>`,
        '- host: "www\\.x.org/a\\_b"',
      ].join('\n'),
    );
    expect(gfmLinkify.render(text)).not.toMatch(/\\|%5C/);
  });
});

describe('strict inverse', () => {
  it('round-trips hostile scalars, keys, and containers exactly', () => {
    const value = {
      empty: '',
      null: null,
      absent: undefined,
      leadingZero: '001',
      one: 1,
      tiny: -1.5e-7,
      large: 1e21,
      true: true,
      false: false,
      emptyArray: [],
      emptyObject: {},
      nestedEmpty: [[], {}],
      objects: [{ a: 1 }, { b: [{ c: null }] }],
      mixed: [1, 'two', null, false, { three: 3 }, ['four'], undefined],
      keys: Object.fromEntries([
        ['', 'empty key'],
        ['0', 'index key'],
        ['a b', 'spaced key'],
        ['quote"[]', 'punctuated key'],
        ['__proto__', 'own key'],
      ]),
      lines: 'CR\rLF\nCRLF\r\n\nblank\n\n\ttab\\n',
      markup:
        '`code` | pipe | <script>alert(1)</script> &amp; &#x41; *x* _y_ ~~x~~ # h > q [l](u) ![i](u) \\',
      separators: 'U+2028\u2028U+2029\u2029NEL\u0085NUL\u0000',
      urls: ['https://example.org/a', 'see https://example.org/b.', 'http://example.org/&amp;'],
    };
    roundTrip(value);
  });
  it.each([
    ['a wrong object count', '- a: object 2\n  - b: 1'],
    ['a wrong array count', '- a: array 1\n  - object 1\n    - b: 1\n  - object 1\n    - c: 2'],
    ['emphasis', '- a: *x*'],
    ['inline HTML', '- a: <b>x</b>'],
    ['an autolink that differs from the URL span', '- a: "https://x.org/a" <https://x.org/b>'],
    ['a missing autolink', '- a: "see https://x.org"'],
    ['a lone URL left quoted', '- a: "https://x.org" <https://x.org>'],
    ['a non-canonical JSON token', '- a: 1.0'],
    ['a quoted bare key', '- "a": 1'],
    ['a duplicate key', '- a: 1\n- a: 2'],
    ['an all-scalar array as a list', '- a: array 1\n  - 1'],
    ['an object that should nest', '- a: {"b":1}'],
    ['a heading', '# a'],
    ['another bullet marker', '* a: 1'],
    ['a nested list under a scalar', '- a: 1\n  - b: 2'],
    ['a container without a nested list', '- a: object 1'],
    [
      'a list nested past six levels',
      [
        '- a: object 1',
        '  - b: object 1',
        '    - c: object 1',
        '      - d: object 1',
        '        - e: object 1',
        '          - f: object 1',
        '            - g: 1',
      ].join('\n'),
    ],
  ])('rejects %s', (_, text) => {
    expect(() => decodeContent({ content: [{ type: 'text', text }] })).toThrow('content[] decode');
  });
});

describe('depth and size', () => {
  it('round-trips a 1,500-level value while nesting lists at most six levels', () => {
    let deep: unknown = { leaf: 'complete' };
    for (let index = 0; index < 1500; index++) deep = [deep];
    const lines = roundTrip({ deep }).split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[5]).toMatch(/^ {10}- \\\[\\\[/);
  });
  it('keeps full Aphia records within 1.5x of their structured bytes', () => {
    const value = {
      results: Array.from({ length: 9 }, (_, index) => ({
        inputIndex: index,
        requestedAphiaId: 137205 + index,
        found: true,
        record: fullRecord(137205 + index),
        guidance: null,
      })),
      nextInputOffset: 9,
      deferredCount: 1,
    };
    const text = roundTrip(value);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      1.5 * Buffer.byteLength(JSON.stringify(value)),
    );
  });
});

describe('scan cost over upstream-sized strings', () => {
  const LARGEST = 320_000;
  /** Best-of-three thread CPU microseconds to render the value LARGEST / length times. */
  const cpu = (text: string) => {
    const repeats = Math.round(LARGEST / text.length);
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const start = process.threadCpuUsage();
      for (let repeat = 0; repeat < repeats; repeat++) formatData({ value: text });
      const used = process.threadCpuUsage(start);
      best = Math.min(best, used.user + used.system);
    }
    return { batch: best, perCall: best / repeats };
  };
  it.each([
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
    ['a repeated URL opener with no closer', (n: number) => 'https:/'.repeat(n / 7)],
    ['overlapping URL prefixes', (n: number) => 'http://'.repeat(n / 7)],
    ['adjacent URLs', (n: number) => 'http://a '.repeat(n / 9)],
    ['repeated scheme separators outside a URL', (n: number) => '://'.repeat(n / 3)],
    ['repeated www dots', (n: number) => 'www.'.repeat(n / 4)],
    ['escapable punctuation', (n: number) => '\\`*_[]<&|~'.repeat(n / 10)],
  ])('grows linearly over %s', (_, build) => {
    cpu(build(5000));
    const perCall: number[] = [];
    for (let size = 5000; size <= LARGEST; size *= 2) {
      const { batch, perCall: micros } = cpu(build(size));
      expect(batch, `${size} characters`).toBeLessThan(250_000);
      perCall.push(micros);
    }
    expect((perCall.at(-1) as number) / (perCall[0] as number)).toBeLessThan(256);
  });
});
