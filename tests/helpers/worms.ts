/**
 * @fileoverview Strict network fixtures and the strict inverse of the content[] list codec.
 * @module tests/helpers/worms
 */
import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { expect, onTestFinished, vi } from 'vitest';
import { initWormsService } from '@/services/worms/index.js';

const markdown = new MarkdownIt('commonmark');
type CallToolResult = Awaited<ReturnType<typeof runToolContract>>;
type Token = ReturnType<typeof markdown.parse>[number];
markdown.normalizeLink = (url) => url;
markdown.normalizeLinkText = (url) => url;
/** The codec grammar's URL span and bare-key forms, restated so the decoder checks the spec. */
const URL_SPAN = /https?:\/\/[^\s<>"\p{Cc}]+/gu;
const BARE_KEY = /^[A-Za-z][A-Za-z0-9]*$/;
const MAX_LIST_DEPTH = 6;
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

type Respond = (
  url: URL,
  init: RequestInit | undefined,
  index: number,
) => Response | Promise<Response>;

/** Thrown by a responder to stand in for fetch's own network failure; any other throw fails the test. */
export class NetworkFailure extends TypeError {}

/**
 * Fake only fetch; unexpected origins, endpoints, or request counts fail loudly. The transport turns
 * anything fetch throws into a classified failure, so every throw from these guards or a responder is
 * also recorded and rethrown when the test finishes, except the two a real fetch produces: a
 * NetworkFailure, and a rejection with the request signal's abort reason.
 */
export function fakeFetch(respond: Respond) {
  const calls: URL[] = [];
  const starts: number[] = [];
  const unexpected: unknown[] = [];
  onTestFinished(() => {
    if (unexpected.length) throw unexpected[0];
  });
  const record = (error: unknown, init: RequestInit | undefined): never => {
    const aborted = init?.signal?.aborted && error === init.signal.reason;
    if (!aborted && !(error instanceof NetworkFailure)) unexpected.push(error);
    throw error;
  };
  const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    try {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.origin).toBe('https://www.marinespecies.org');
      expect(url.pathname.startsWith('/rest/Aphia')).toBe(true);
      expect(init?.headers).toEqual({ Accept: 'application/json' });
      calls.push(url);
      starts.push(Date.now());
      return Promise.resolve(respond(url, init, calls.length - 1)).catch((error: unknown) =>
        record(error, init),
      );
    } catch (error) {
      return record(error, init);
    }
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, calls, starts };
}

/** Fake fetch for calls rejected before the network: any request fails the test. */
export function offline() {
  fakeFetch(() => {
    throw new Error('Unexpected upstream request.');
  });
}

/** A response that never arrives: rejects with the request signal's abort reason, as fetch does. */
export function hang(init: RequestInit | undefined) {
  return new Promise<Response>((_resolve, reject) =>
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
  );
}

/** Minimal valid sparse upstream taxon. */
export function record(id: number, extra: Record<string, unknown> = {}) {
  return { AphiaID: id, ...extra };
}

type DeclaringTool = {
  name: string;
  errors?: readonly { reason: string; code: number; recovery: string; retryable?: boolean }[];
};
/** A tool's own `errors[]` entry for `reason`; a reason the tool does not declare fails the test. */
export function declared(tool: DeclaringTool, reason: string) {
  const entry = tool.errors?.find((candidate) => candidate.reason === reason);
  if (!entry) throw new Error(`${tool.name} does not declare ${reason}.`);
  return entry;
}

/** Every text block of a result, joined. */
export function contentText(result: Pick<CallToolResult, 'content'>) {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/** Answer the evidence tools' AphiaRecordByAphiaID status read with `row` (204 when null); route the rest to `respond`. */
export function withStatus(row: Record<string, unknown> | null, respond: Respond): Respond {
  return (url, init, index) =>
    url.pathname.startsWith('/rest/AphiaRecordByAphiaID/')
      ? row
        ? Response.json(row)
        : new Response(null, { status: 204 })
      : respond(url, init, index);
}

function fail(message: string): never {
  throw new Error(`content[] decode: ${message}`);
}

const isContainer = (value: unknown): value is object =>
  value !== null && typeof value === 'object';

/** URL spans of every string leaf in JSON serialization order. */
function urlSpans(value: unknown): string[] {
  const spans: string[] = [];
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (typeof current === 'string')
      for (const match of current.matchAll(URL_SPAN)) spans.push(match[0]);
    else if (isContainer(current)) stack.push(...Object.values(current).toReversed());
  }
  return spans;
}

/** Whether the grammar renders this value at this item depth as a nested list. */
function nests(value: unknown, depth: number): boolean {
  if (!isContainer(value) || depth >= MAX_LIST_DEPTH) return false;
  const children = Object.values(value);
  return Array.isArray(value) ? children.some(isContainer) : children.length > 0;
}

/** An item's leading text and its trailing autolinks; any other inline token is rejected. */
function splitInline(children: Token[]) {
  let text = '';
  const links: string[] = [];
  let open: { href: string; label: string } | undefined;
  for (const child of children) {
    if (child.type === 'link_open') {
      if (open || child.markup !== 'autolink') fail('link that is not an autolink');
      open = { href: String(child.attrGet('href')), label: '' };
    } else if (child.type === 'link_close' && open) {
      if (open.label !== open.href) fail('autolink label differs from its destination');
      links.push(open.href);
      open = undefined;
    } else if (child.type === 'text' && open) open.label += child.content;
    else if (child.type === 'text' && !links.length) text += child.content;
    else if (child.type !== 'text' || child.content !== ' ')
      fail(`unexpected inline ${child.type} ${JSON.stringify(child.content)}`);
  }
  return { text, links };
}

/** One canonical JSON token: exactly what JSON.stringify would emit for the decoded value. */
function canonicalJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  if (JSON.stringify(value) !== text) fail(`non-canonical JSON token ${text}`);
  return value;
}

/** Split `key: rest` for an object member item. */
function readKey(text: string): [key: string, rest: string] {
  let raw = /^[A-Za-z][A-Za-z0-9]*/.exec(text)?.[0];
  if (text.startsWith('"')) {
    let end = 1;
    while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
    raw = text.slice(0, end + 1);
  }
  if (!raw || text.slice(raw.length, raw.length + 2) !== ': ') fail(`missing key in ${text}`);
  const key = raw.startsWith('"') ? (canonicalJson(raw) as string) : raw;
  if (raw.startsWith('"') && BARE_KEY.test(key)) fail(`quoted bare key ${raw}`);
  return [key, text.slice(raw.length + 2)];
}

type Frame = { target: Record<string, unknown> | unknown[]; expected: number | null };

/** Parse one item's value; a declared container returns the frame its nested list fills. */
function readValue(text: string, links: string[], depth: number): [unknown, Frame | undefined] {
  const header = /^(object|array) ([1-9]\d*)$/.exec(text);
  if (header && !links.length) {
    if (depth >= MAX_LIST_DEPTH) fail(`list nested past ${MAX_LIST_DEPTH} levels`);
    const target = header[1] === 'array' ? [] : {};
    return [target, { target, expected: Number(header[2]) }];
  }
  const lone = text === '' && links.length === 1;
  if (links.length && !lone) {
    if (!text.endsWith(' ')) fail('autolinks must follow the token after one space');
    text = text.slice(0, -1);
  }
  const value = lone ? links[0] : canonicalJson(text);
  const spans = urlSpans(value);
  if (spans.length !== links.length || spans.some((span, i) => span !== links[i]))
    fail(`autolinks ${JSON.stringify(links)} differ from URL spans ${JSON.stringify(spans)}`);
  if (lone !== (typeof value === 'string' && spans.length === 1 && spans[0] === value))
    fail('a string that is exactly one URL renders as its autolink alone');
  if (nests(value, depth)) fail(`inline container at depth ${depth} must nest`);
  return [value, undefined];
}

/**
 * Strict inverse of the content[] codec over a real CommonMark parse (markdown-it `commonmark`,
 * no URL normalization, unless another parser is given). Throws on any token, key, count, or link
 * the grammar would not produce.
 */
export function decodeContent(
  result: Pick<CallToolResult, 'content'>,
  parser: typeof markdown = markdown,
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const block of result.content) {
    if (block.type !== 'text') fail(`non-text block ${block.type}`);
    const frames: Frame[] = [];
    let pending: Frame | undefined;
    let itemInline = false;
    for (const token of parser.parse(block.text, {})) {
      switch (token.type) {
        case 'bullet_list_open':
          if (token.markup !== '-') fail(`bullet marker ${token.markup}`);
          if (frames.length && !pending) fail('nested list under a scalar item');
          frames.push(frames.length ? (pending as Frame) : { target: root, expected: null });
          pending = undefined;
          break;
        case 'bullet_list_close': {
          const frame = frames.pop() as Frame;
          const size = Object.keys(frame.target).length;
          if (frame.expected !== null && size !== frame.expected)
            fail(`declared ${frame.expected} entries, found ${size}`);
          if (Array.isArray(frame.target) && !frame.target.some(isContainer))
            fail('an all-scalar array renders inline');
          break;
        }
        case 'list_item_open':
          itemInline = false;
          break;
        case 'list_item_close':
          if (pending) fail('declared container without a nested list');
          if (!itemInline) fail('empty list item');
          break;
        case 'paragraph_open':
        case 'paragraph_close':
          if (!frames.length) fail('paragraph outside the list');
          break;
        case 'inline': {
          if (itemInline) fail('second paragraph in one item');
          itemInline = true;
          const { target } = frames.at(-1) as Frame;
          const { text, links } = splitInline(token.children ?? []);
          const [key, rest] = Array.isArray(target) ? [null, text] : readKey(text);
          const [value, nested] = readValue(rest, links, frames.length);
          if (key === null) (target as unknown[]).push(value);
          else if (Object.hasOwn(target, key)) fail(`duplicate key ${key}`);
          // defineProperty keeps a "__proto__" key an own member, as JSON.parse does.
          else Object.defineProperty(target, key, { value, enumerable: true, writable: true });
          pending = nested;
          break;
        }
        default:
          fail(`unexpected block token ${token.type}`);
      }
    }
    if (frames.length || pending) fail('unclosed list');
  }
  return root;
}

/** Assert every structured value, including enrichment, survives rendered content exactly. */
export function expectParity(result: CallToolResult) {
  expect(result.isError).not.toBe(true);
  expect(decodeContent(result)).toStrictEqual(JSON.parse(JSON.stringify(result.structuredContent)));
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
