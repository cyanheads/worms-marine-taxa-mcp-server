/**
 * @fileoverview Strict network fixtures and complete CommonMark surface decoding.
 * @module tests/helpers/worms
 */
import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { expect, vi } from 'vitest';
import { initWormsService } from '@/services/worms/index.js';

const markdown = new MarkdownIt('commonmark');
type CallToolResult = Awaited<ReturnType<typeof runToolContract>>;
markdown.normalizeLink = (url) => url;
markdown.normalizeLinkText = (url) => url;
let day = 0;

/** Set up deterministic clocks and an initialized real domain service. */
export function setupWorms() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2030, 0, ++day)));
  initWormsService();
}

/** Advance time while preserving microtask/I/O ordering, stopping on settlement. */
export async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let tick = 0; tick < 100 && !done; tick++) await vi.advanceTimersByTimeAsync(500);
  if (!done) throw new Error('Fixture failed to settle within the tool deadline.');
  return promise;
}

/** Fake only fetch; unexpected origins, endpoints, or request counts fail loudly. */
export function fakeFetch(
  respond: (url: URL, init: RequestInit | undefined, index: number) => Response | Promise<Response>,
) {
  const calls: URL[] = [];
  const starts: number[] = [];
  const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.origin).toBe('https://www.marinespecies.org');
    expect(url.pathname.startsWith('/rest/Aphia')).toBe(true);
    expect(init?.headers).toEqual({ Accept: 'application/json' });
    calls.push(url);
    starts.push(Date.now());
    return Promise.resolve(respond(url, init, calls.length - 1));
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, calls, starts };
}

/** Minimal valid sparse upstream taxon. */
export function record(id: number, extra: Record<string, unknown> = {}) {
  return { AphiaID: id, ...extra };
}

/** Decode the field/path codec after a real CommonMark parse and validate links. */
export function decodeContent(result: Pick<CallToolResult, 'content'>): unknown {
  const root: Record<string, unknown> = {};
  const values = new Map<string, unknown>();
  for (const block of result.content) {
    expect(block.type).toBe('text');
    if (block.type !== 'text') continue;
    for (const token of markdown.parse(block.text, {})) {
      if (token.type !== 'inline') continue;
      const children = token.children ?? [];
      const paragraphs = children
        .map((child) =>
          child.type === 'text' ? child.content : child.type === 'softbreak' ? '\n' : '',
        )
        .join('');
      for (const text of paragraphs.split('\n')) {
        const match =
          /^("(?:\\.|[^"\\])*") (object|array|string|number|boolean|null|undefined|end|link)(?: (.*))?$/s.exec(
            text,
          );
        expect(match, `Unexpected codec paragraph: ${text}`).not.toBeNull();
        if (!match) continue;
        const path = JSON.parse(match[1] ?? 'null') as string;
        const type = match[2];
        const encoded = match[3] ?? '';
        if (type === 'end') continue;
        if (type === 'link') {
          const range = /^(\d+):(\d+) /.exec(encoded);
          expect(range).not.toBeNull();
          const value = values.get(path);
          expect(typeof value).toBe('string');
          const destination = children.find((child) => child.type === 'link_open')?.attrGet('href');
          expect(destination).toBe((value as string).slice(Number(range?.[1]), Number(range?.[2])));
          continue;
        }
        const value: unknown = type === 'object' ? {} : type === 'array' ? [] : JSON.parse(encoded);
        values.set(path, value);
        if (path === '$') {
          root.value = value;
          continue;
        }
        const last = /\[((?:"(?:\\.|[^"\\])*")|\d+)\]$/.exec(path);
        expect(last, `Invalid field path ${path}`).not.toBeNull();
        if (!last) continue;
        const parentPath = path.slice(0, last.index);
        const parent = values.get(parentPath) ?? root.value;
        expect(parent).toBeDefined();
        const key = JSON.parse(last[1] ?? 'null') as string;
        (parent as Record<string, unknown>)[key] = value;
      }
    }
  }
  return root.value;
}

/** Assert every structured value, including enrichment, survives rendered content. */
export function expectParity(result: CallToolResult) {
  expect(result.isError).not.toBe(true);
  expect(decodeContent(result)).toEqual(result.structuredContent);
}

/** Follow explicit local selectors and verify each complete paired-surface segment. */
export async function collectLocal(
  call: (offset: number) => Promise<CallToolResult>,
  field: string,
) {
  const rows: unknown[] = [];
  let offset = 0;
  for (;;) {
    const result = await settle(call(offset));
    expectParity(result);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24000);
    const data = result.structuredContent as Record<string, unknown>;
    rows.push(...(data[field] as unknown[]));
    const next = data.nextResultOffset as number | null;
    if (next === null) return rows;
    expect(next).toBeGreaterThan(offset);
    offset = next;
  }
}
