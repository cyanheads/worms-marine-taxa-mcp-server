/**
 * @fileoverview Lossless nested CommonMark list codec for scientific data.
 * @module services/worms/format
 */

/** HTTP(S) URL spans; excludes every character a CommonMark autolink cannot carry. */
const URL_RE = /https?:\/\/[^\s<>"\p{Cc}]+/gu;
/** Deepest list level; containers at this item depth render as one inline JSON token. */
const MAX_LIST_DEPTH = 6;
const BARE_KEY = /^[A-Za-z][A-Za-z0-9]*$/;

type Entry = [key: string | number, value: unknown];

const isContainer = (value: unknown): value is object =>
  value !== null && typeof value === 'object';

/**
 * Backslash-escape every character that opens inline syntax mid-line, GFM tables and strikethrough
 * included, plus the `:` of `://` and the `.` of `www.` so no GFM extended autolink starts inside a
 * token and swallows its escapes as literal backslashes.
 */
const escapeInline = (text: string) =>
  text.replace(/[\\`*_[\]<&|~]|:(?=\/\/)|(?<=www)\./gi, '\\$&');

/** Members or elements as JSON sees them: undefined members omitted, undefined elements null. */
function entries(value: object): Entry[] {
  return Array.isArray(value)
    ? value.map((entry, index) => [index, entry === undefined ? null : entry])
    : Object.entries(value).filter(([, entry]) => entry !== undefined);
}

/** Every URL span in the value's string leaves, in JSON serialization order. */
function urlSpans(value: unknown): string[] {
  const spans: string[] = [];
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (typeof current === 'string')
      for (const match of current.matchAll(URL_RE)) spans.push(match[0]);
    else if (isContainer(current))
      for (const [, entry] of entries(current).toReversed()) stack.push(entry);
  }
  return spans;
}

/** A string that is exactly one URL is its autolink; anything else is its JSON token, then its URLs as autolinks. */
function token(value: unknown): string {
  const spans = urlSpans(value);
  if (typeof value === 'string' && spans.length === 1 && spans[0] === value) return `<${value}>`;
  return escapeInline(JSON.stringify(value)) + spans.map((url) => ` <${url}>`).join('');
}

/** Entries rendered as a nested list: a non-empty object, or an array holding a container. */
function nestedEntries(value: unknown, depth: number): Entry[] | undefined {
  if (!isContainer(value) || depth >= MAX_LIST_DEPTH) return undefined;
  const children = entries(value);
  const nests = Array.isArray(value)
    ? children.some(([, child]) => isContainer(child))
    : children.length > 0;
  return nests ? children : undefined;
}

/** Render members as `key: value` items, iteratively so data depth never reaches the call stack. */
function renderMembers(members: Entry[]): string {
  const lines: string[] = [];
  const stack = members.toReversed().map(([key, value]) => ({ key, value, depth: 1 }));
  for (let item = stack.pop(); item; item = stack.pop()) {
    const { key, value, depth } = item;
    const label =
      typeof key === 'number'
        ? ''
        : `${BARE_KEY.test(key) ? key : escapeInline(JSON.stringify(key))}: `;
    const prefix = `${'  '.repeat(depth - 1)}- ${label}`;
    const children = nestedEntries(value, depth);
    if (!children) {
      lines.push(prefix + token(value));
      continue;
    }
    lines.push(`${prefix}${Array.isArray(value) ? 'array' : 'object'} ${children.length}`);
    for (const [childKey, child] of children.toReversed())
      stack.push({ key: childKey, value: child, depth: depth + 1 });
  }
  return lines.join('\n');
}

/** Complete paired-surface formatter; the root is the tool's output object. */
export function formatData(value: object): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: renderMembers(entries(value)) }];
}

/** Render one enrichment field as a root member item, as the trailer and pager both do. */
export function renderEnrichmentField(key: string, value: unknown): string {
  return renderMembers(entries({ [key]: value }));
}

/** `enrichmentTrailer` config rendering each named enrichment field through the codec. */
export function codecTrailer<const K extends string>(...keys: K[]) {
  return Object.fromEntries(
    keys.map((key) => [key, { render: (value: unknown) => renderEnrichmentField(key, value) }]),
  ) as Record<K, { render: (value: unknown) => string }>;
}
