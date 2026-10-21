/**
 * @fileoverview Lossless field-path Markdown codec for scientific data.
 * @module services/worms/format
 */

/** CommonMark escaping preserves the JSON token after text decoding. */
export function escapeMarkdown(value: string): string {
  return value.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '\\$&');
}

/** Render every scalar and container iteratively; JSON tokens retain line endings. */
export function renderData(value: unknown, root = '$'): string {
  const lines: string[] = [];
  const stack: { path: string; value: unknown }[] = [{ path: root, value }];
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    const { path, value: current } = item;
    const prefix = escapeMarkdown(JSON.stringify(path));
    if (current !== null && typeof current === 'object') {
      const entries = Array.isArray(current)
        ? current.map((entry, index) => [index, entry] as const)
        : Object.entries(current);
      lines.push(`${prefix} ${Array.isArray(current) ? 'array' : 'object'} ${entries.length}`);
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry) stack.push({ path: `${path}[${JSON.stringify(entry[0])}]`, value: entry[1] });
      }
    } else {
      lines.push(
        `${prefix} ${current === null ? 'null' : typeof current} ${escapeMarkdown(JSON.stringify(current))}`,
      );
      if (typeof current === 'string') {
        for (const match of current.matchAll(/https?:\/\/[^\s<>"\p{Cc}]+/gu)) {
          const url = match[0];
          const destination = escapeMarkdown(url);
          lines.push(
            `${prefix} link ${match.index}:${match.index + url.length} [${escapeMarkdown(url)}](${destination})`,
          );
        }
      }
    }
  }
  return lines.join('\n\n');
}

/** Complete paired-surface formatter. */
export function formatData(value: unknown) {
  return [{ type: 'text' as const, text: renderData(value) }];
}
