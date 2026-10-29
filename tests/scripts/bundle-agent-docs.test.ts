/**
 * @fileoverview Bundle agent-doc matcher: package-root agent trees are stripped and
 * reported, runtime `skills/` modules nested inside a package ship.
 * @module tests/scripts/bundle-agent-docs.test
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

type LintPackaging = {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries: (entries: string[], bundleLabel: string) => string[];
};

/**
 * Loaded through a computed URL so `tsc` never pulls the script into the program:
 * the framework's copy carries a repo-only `../src/` import that fails typechecking
 * in a server, and a script resync restores it.
 */
const lintPackagingUrl = new URL('../../scripts/lint-packaging.ts', import.meta.url).href;
const lintPackaging: LintPackaging = await import(lintPackagingUrl);

/** Runtime modules the MCP SDK loads at startup, plus scoped and nested copies of the same shape. */
const RUNTIME = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.cjs',
  'node_modules/@cyanheads/mcp-ts-core/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/some-pkg/node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/some-pkg/lib/skills/loader.js',
  'node_modules/some-pkg/dist/.claude/defaults.js',
];

/** Agent docs a dependency ships at its package root, scoped and nested, plus stray SKILL.md files. */
const AGENT_DOCS = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/api-utils/references/formatting.md',
  'node_modules/some-pkg/skills/guide/SKILL.md',
  'node_modules/some-pkg/skills/guide/references/notes.md',
  'node_modules/@scope/pkg/.claude/settings.json',
  'node_modules/@scope/pkg/.agents/skills/guide/SKILL.md',
  'node_modules/outer/node_modules/@scope/inner/skills/guide/SKILL.md',
  'node_modules/@outer/pkg/node_modules/inner/.claude/commands/run.md',
  'node_modules/a/node_modules/b/node_modules/c/framework-skills/x/SKILL.md',
  'node_modules/some-pkg/docs/SKILL.md',
];

describe('bundle agent-doc matcher', () => {
  it('keeps runtime skills/ modules nested inside a package', () => {
    expect(filterAgentDocEntries(RUNTIME)).toStrictEqual([]);
  });

  it('selects every package-root agent tree and stray SKILL.md', () => {
    expect(filterAgentDocEntries(AGENT_DOCS)).toStrictEqual(AGENT_DOCS);
  });

  it('selects only the agent docs from a mixed listing', () => {
    const listing = [...RUNTIME, ...AGENT_DOCS, 'dist/index.js', 'skills/guide/SKILL.md'];
    expect(filterAgentDocEntries(listing)).toStrictEqual(AGENT_DOCS);
  });

  it('uses one matcher in the cleaner and the packaging check', () => {
    expect(lintPackaging.AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
    expect(lintPackaging.AGENT_DOC_ENTRY.flags).toBe(AGENT_DOC_ENTRY.flags);
  });

  it('passes a cleaned bundle that keeps the runtime modules', () => {
    expect(lintPackaging.checkBundleEntries([...RUNTIME, 'dist/index.js'], 'bundle')).toStrictEqual(
      [],
    );
  });

  it('reports a bundle that still holds agent docs', () => {
    const errors = lintPackaging.checkBundleEntries([...RUNTIME, ...AGENT_DOCS], 'bundle');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`contains ${AGENT_DOCS.length} node_modules agent-doc entries`);
  });
});
