/**
 * @fileoverview Real MCP JSON-RPC stdio transport with a process-boundary upstream fake.
 * @module tests/integration/worms-stdio.test
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect, it } from 'vitest';
import { expectParity } from '../helpers/worms.js';

it('initializes, lists eight tools, and round-trips real evidence over JSON-RPC', async () => {
  const child = spawn(
    'bun',
    ['--preload', './tests/helpers/evidence-stdio-upstream.ts', './src/index.ts'],
    {
      cwd: new URL('../../', import.meta.url),
      env: {
        ...process.env,
        MCP_TRANSPORT_TYPE: 'stdio',
        MCP_AUTH_MODE: 'none',
        LOG_LEVEL: 'error',
        OTEL_ENABLED: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  lines.on('line', (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === 'number') pending.get(message.id)?.resolve(message);
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values())
      waiter.reject(new Error(`Server exited ${code}: ${stderr}`));
  });
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++nextId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(
          () => reject(new Error(`JSON-RPC ${method} timed out: ${stderr}`)),
          15_000,
        );
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return await response;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
  try {
    const initialized = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'evidence-integration', version: '1.0.0' },
    });
    expect(initialized).not.toHaveProperty('error');
    expect(initialized.result).toMatchObject({
      serverInfo: { name: 'worms-marine-taxa-mcp-server' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const catalog = await request('tools/list', {});
    expect((catalog.result as { tools: unknown[] }).tools).toHaveLength(8);
    const taxon = (catalog.result as { tools: { name: string }[] }).tools.find(
      (tool) => tool.name === 'worms_get_taxon',
    );
    expect(taxon).toMatchObject({
      inputSchema: {
        properties: {
          aphiaIds: {
            items: {
              anyOf: expect.arrayContaining([
                expect.objectContaining({ type: 'integer' }),
                expect.objectContaining({ type: 'string' }),
              ]),
            },
          },
        },
      },
    });
    const called = await request('tools/call', {
      name: 'worms_get_traits',
      arguments: { aphiaId: 1 },
    });
    expect(called).not.toHaveProperty('error');
    const result = called.result as Awaited<ReturnType<typeof runToolContract>>;
    expectParity(result);
    expect(result.structuredContent).toMatchObject({
      aphiaId: 1,
      traits: [
        { nodeIndex: 0, measurementTypeId: '001', measurementValue: 'A\r\n\n`|<>' },
        { nodeIndex: 1, parentIndex: 0, depth: 1, sourceId: '002' },
      ],
    });
    expect(result.structuredContent).not.toHaveProperty('statusError');
    for (const aphiaIds of [[1], ['1'], [' 1 '], '[1]']) {
      const repaired = await request('tools/call', {
        name: 'worms_get_taxon',
        arguments: { aphiaIds },
      });
      const value = repaired.result as Awaited<ReturnType<typeof runToolContract>>;
      expectParity(value);
      expect(value.structuredContent).toMatchObject({
        results: [{ requestedAphiaId: 1, record: { aphiaId: 1 } }],
      });
    }
    const scalar = await request('tools/call', {
      name: 'worms_get_traits',
      arguments: { aphiaId: '1' },
    });
    expectParity(scalar.result as Awaited<ReturnType<typeof runToolContract>>);
    expect(
      (scalar.result as Awaited<ReturnType<typeof runToolContract>>).structuredContent,
    ).toMatchObject({ aphiaId: 1, traits: [{ measurementTypeId: '001' }, { sourceId: '002' }] });
    const names = await request('tools/call', {
      name: 'worms_resolve_taxon',
      arguments: { names: 'Gadus morhua' },
    });
    expectParity(names.result as Awaited<ReturnType<typeof runToolContract>>);
    expect(
      (names.result as Awaited<ReturnType<typeof runToolContract>>).structuredContent,
    ).toMatchObject({ results: [{ inputIndex: 0, matches: [{ aphiaId: 1 }] }] });
    const lsid = await request('tools/call', {
      name: 'worms_get_taxon',
      arguments: { aphiaIds: ['urn:lsid:marinespecies.org:taxname:1'] },
    });
    expectParity(lsid.result as Awaited<ReturnType<typeof runToolContract>>);
    expect(
      (lsid.result as Awaited<ReturnType<typeof runToolContract>>).structuredContent,
    ).toMatchObject({ results: [{ requestedAphiaId: 1 }] });
    for (const name of [
      'worms_get_classification',
      'worms_get_synonyms',
      'worms_get_distributions',
      'worms_get_traits',
      'worms_crosswalk_id',
    ]) {
      const response = await request('tools/call', {
        name,
        arguments: {
          aphiaId: 'urn:lsid:marinespecies.org:taxname:1',
          ...(name === 'worms_crosswalk_id' ? { type: 'lsid' } : {}),
        },
      });
      const value = response.result as Awaited<ReturnType<typeof runToolContract>>;
      expectParity(value);
      expect(value.structuredContent).toMatchObject({ aphiaId: 1 });
    }
    const invalid = await request('tools/call', {
      name: 'worms_crosswalk_id',
      arguments: { aphiaId: 1, type: 'gbif' },
    });
    expect(invalid.result).toMatchObject({ isError: true });
  } finally {
    lines.close();
    child.stdin.end();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  }
});
