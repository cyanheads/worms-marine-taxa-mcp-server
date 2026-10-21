/**
 * @fileoverview CommonMark inverse checks for complete hostile and deep data.
 * @module tests/services/format.test
 */
import { describe, expect, it } from 'vitest';
import { formatData } from '@/services/worms/index.js';
import { decodeContent } from '../helpers/worms.js';

describe('lossless Markdown data', () => {
  it('round-trips every scalar/container and literal control sequences', () => {
    const value = {
      empty: '',
      null: null,
      false: false,
      zero: 0,
      emptyArray: [],
      emptyObject: {},
      nested: [{ 'quote"[]': 'line\r\n\nline\t\\n `|<>![]() ** & \\' }],
    };
    expect(decodeContent({ content: formatData(value) })).toEqual(value);
  });
  it.each([
    'https://example.org/a_(b)?x=1&y=2#fragment',
    'citation https://example.org/é?q=a%20b and https://example.org/c',
    'https://example.org/a\\b',
    'https://example.org/a%2Fb?x=%22quoted%22',
  ])('preserves parsed working link destinations: %s', (url) => {
    expect(decodeContent({ content: formatData({ url }) })).toEqual({ url });
  });
  it('renders deep data without recursive stack exhaustion', () => {
    let value: unknown = { leaf: 'complete' };
    for (let index = 0; index < 1500; index++) value = [value];
    const content = formatData(value);
    const decoded = decodeContent({ content });
    let tip = decoded;
    for (let index = 0; index < 1500; index++) tip = (tip as unknown[])[0];
    expect(tip).toEqual({ leaf: 'complete' });
  });
});
