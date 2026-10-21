/**
 * @fileoverview Bounded transport, retry, pacing, and cancellation behavior.
 * @module tests/services/transport.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FailureReason,
  failure,
  failures,
  request,
  WormsScope,
} from '@/services/worms/index.js';
import { fakeFetch, hang, NetworkFailure, offline, settle, setupWorms } from '../helpers/worms.js';

beforeEach(setupWorms);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const endpoint = 'AphiaRecordByAphiaID/1';
const query = new URLSearchParams();

describe('classified bounded requests', () => {
  it.each([
    [400, 'upstream_rejected', JsonRpcErrorCode.ValidationError, false],
    [422, 'upstream_rejected', JsonRpcErrorCode.ValidationError, false],
    [401, 'upstream_access_denied', JsonRpcErrorCode.ServiceUnavailable, false],
    [403, 'upstream_access_denied', JsonRpcErrorCode.ServiceUnavailable, false],
    [404, 'invalid_upstream_response', JsonRpcErrorCode.SerializationError, false],
    [429, 'upstream_rate_limited', JsonRpcErrorCode.RateLimited, true],
    [408, 'upstream_timeout', JsonRpcErrorCode.Timeout, true],
    [504, 'upstream_timeout', JsonRpcErrorCode.Timeout, true],
    [500, 'upstream_unavailable', JsonRpcErrorCode.ServiceUnavailable, true],
  ] as const)(
    'classifies HTTP %i as %s, leaving the hint to the calling tool and leaking no body or headers',
    async (status, reason, code, retryable) => {
      const network = fakeFetch(
        () =>
          new Response('SECRET BODY', {
            status,
            headers: { 'x-secret': 'SECRET HEADER', 'retry-after': '1' },
          }),
      );
      using scope = new WormsScope(createMockContext());
      const error = await settle(
        request(scope, endpoint, query, (data) => data).catch((error: unknown) => error),
      );
      expect(error).toMatchObject({ code, data: { reason, retryable } });
      expect(error).not.toHaveProperty('data.recovery');
      expect(JSON.stringify(error)).not.toContain('SECRET');
      expect(network.calls).toHaveLength([429, 408, 504, 500].includes(status) ? 2 : 1);
    },
  );
  it.each([
    ['{broken', 'invalid_upstream_response', 1],
    ['<html>temporary outage</html>', 'upstream_unavailable', 2],
  ] as const)('classifies malformed content %s', async (body, reason, count) => {
    const network = fakeFetch(() => new Response(body));
    using scope = new WormsScope(createMockContext());
    await expect(settle(request(scope, endpoint, query, (data) => data))).rejects.toMatchObject({
      data: { reason },
    });
    expect(network.calls).toHaveLength(count);
  });
  it('retries the complete pipeline after a network failure', async () => {
    const network = fakeFetch((_url, _init, index) => {
      if (!index) throw new NetworkFailure('private network details');
      return Response.json({ ok: true });
    });
    using scope = new WormsScope(createMockContext());
    await expect(settle(request(scope, endpoint, query, (data) => data))).resolves.toEqual({
      ok: true,
    });
    expect(network.calls).toHaveLength(2);
  });
  it('honors Retry-After while keeping retries inside the tool budget', async () => {
    const network = fakeFetch((_url, _init, index) =>
      index === 0
        ? new Response(null, { status: 429, headers: { 'retry-after': '3' } })
        : Response.json([]),
    );
    using scope = new WormsScope(createMockContext());
    await expect(settle(request(scope, endpoint, query, (data) => data))).resolves.toEqual([]);
    expect((network.starts[1] ?? 0) - (network.starts[0] ?? 0)).toBeGreaterThanOrEqual(3000);
  });
  it('does not parse HTTP 204', async () => {
    fakeFetch(() => new Response(null, { status: 204 }));
    const parse = vi.fn();
    using scope = new WormsScope(createMockContext());
    await expect(settle(request(scope, endpoint, query, parse))).resolves.toBeNull();
    expect(parse).not.toHaveBeenCalled();
  });
  it('counts streamed bytes independently of Content-Length and cancels oversize readers', async () => {
    const cancel = vi.fn();
    fakeFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8 * 1024 * 1024));
              controller.enqueue(new Uint8Array(1));
            },
            cancel,
          }),
          { headers: { 'content-length': '1' } },
        ),
    );
    using scope = new WormsScope(createMockContext());
    await expect(settle(request(scope, endpoint, query, (data) => data))).rejects.toMatchObject({
      data: { reason: 'response_too_large', retryable: false },
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('accepts exactly 8 MiB instead of truncating it', async () => {
    const text = `"${'a'.repeat(8 * 1024 * 1024 - 2)}"`;
    fakeFetch(() => new Response(text));
    using scope = new WormsScope(createMockContext());
    const value = await settle(request(scope, endpoint, query, (data) => data));
    expect((value as string).length).toBe(8 * 1024 * 1024 - 2);
  });
  it('rejects unallowlisted paths and query keys before fetch', async () => {
    offline();
    using scope = new WormsScope(createMockContext());
    for (const path of [
      'https://evil.test',
      'AphiaSourcesByAphiaID/',
      'AphiaSourcesByAphiaID/1a',
      'AphiaSourcesByAphiaID/1/2',
      'AphiaSourceByAphiaID/1',
      'AphiaSourcesByAphiaID/%2e%2e',
    ])
      await expect(request(scope, path, query, (data) => data)).rejects.toThrow(
        'Unsupported WoRMS endpoint',
      );
    await expect(
      request(scope, endpoint, new URLSearchParams({ extra: 'x' }), (data) => data),
    ).rejects.toThrow('Unsupported WoRMS query key');
  });
  it('allowlists the taxon source path with no query keys', async () => {
    const network = fakeFetch(() => Response.json([{ source_id: 8 }]));
    using scope = new WormsScope(createMockContext());
    await expect(
      settle(request(scope, 'AphiaSourcesByAphiaID/126436', query, (data) => data)),
    ).resolves.toEqual([{ source_id: 8 }]);
    expect(network.calls.map((url) => [url.pathname, url.search])).toEqual([
      ['/rest/AphiaSourcesByAphiaID/126436', ''],
    ]);
  });
});

describe('pacing and absolute lifetime', () => {
  it('serializes simultaneous calls and spaces starts by at least 500ms', async () => {
    let active = 0;
    let maximum = 0;
    const network = fakeFetch(async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 100));
      active--;
      return Response.json([]);
    });
    using scope = new WormsScope(createMockContext());
    await settle(
      Promise.all(Array.from({ length: 4 }, () => request(scope, endpoint, query, (data) => data))),
    );
    expect(maximum).toBe(1);
    expect(network.starts).toHaveLength(4);
    for (let index = 1; index < 4; index++)
      expect(
        (network.starts[index] ?? 0) - (network.starts[index - 1] ?? 0),
      ).toBeGreaterThanOrEqual(500);
  });
  it('removes cancelled queued requests without starting them', async () => {
    const abort = new AbortController();
    const network = fakeFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return Response.json([]);
    });
    using first = new WormsScope(createMockContext());
    using queued = new WormsScope(createMockContext({ signal: abort.signal }));
    const running = request(first, endpoint, query, (data) => data);
    const pending = request(queued, endpoint, query, (data) => data).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10);
    abort.abort();
    const [, error] = await settle(Promise.all([running, pending]));
    expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(network.calls).toHaveLength(1);
  });
  it('cancels an active fetch with no retry', async () => {
    const abort = new AbortController();
    const network = fakeFetch((_url, init) => hang(init));
    using scope = new WormsScope(createMockContext({ signal: abort.signal }));
    const pending = request(scope, endpoint, query, (data) => data).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10);
    abort.abort();
    await expect(settle(pending)).resolves.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    expect(network.calls).toHaveLength(1);
  });
  const contract = (...reasons: FailureReason[]) =>
    reasons.map((reason) => ({
      reason,
      code: failures[reason][0],
      when: 'Forced in a transport test.',
      recovery: `Recover from ${reason} as this calling tool declares.`,
    }));
  it('takes each item recovery from the calling tool contract and rethrows undeclared reasons', () => {
    using scope = new WormsScope(
      createMockContext({ errors: contract('upstream_timeout', 'upstream_unavailable') }),
    );
    expect(scope.optionalError(failure('upstream_timeout'))).toEqual({
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      message: 'upstream timeout',
      recovery: 'Recover from upstream_timeout as this calling tool declares.',
      retryable: true,
    });
    expect(
      scope.optionalError(failure('upstream_unavailable', 'WoRMS returned HTTP 503.')),
    ).toEqual({
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'WoRMS returned HTTP 503.',
      recovery: 'Recover from upstream_unavailable as this calling tool declares.',
      retryable: true,
    });
    expect(() => scope.optionalError(failure('upstream_access_denied'))).toThrow(
      'upstream access denied',
    );
  });
  it('retains optional failures only while the whole tool remains viable', () => {
    const abort = new AbortController();
    using scope = new WormsScope(
      createMockContext({
        signal: abort.signal,
        errors: contract('upstream_timeout', 'upstream_rejected', 'upstream_unavailable'),
      }),
    );
    expect(scope.optionalError(failure('upstream_timeout'))).toMatchObject({
      reason: 'upstream_timeout',
      retryable: true,
    });
    expect(() => scope.optionalError(failure('upstream_rejected'))).toThrow();
    expect(() => scope.optionalError(new Error('programmer error'))).toThrow('programmer error');
    vi.advanceTimersByTime(45_000);
    expect(() => scope.optionalError(failure('upstream_unavailable'))).toThrow('upstream timeout');
    abort.abort();
    expect(() => scope.check()).toThrow('Request cancelled');
  });
  it('bounds the pending queue and releases cancelled requests', async () => {
    const abort = new AbortController();
    const network = fakeFetch((_url, init) => hang(init));
    using scope = new WormsScope(createMockContext({ signal: abort.signal }));
    const pending = Array.from({ length: 103 }, () =>
      request(scope, endpoint, query, (data) => data).catch((error: unknown) => error),
    );
    await vi.advanceTimersByTimeAsync(10);
    const shed = await pending[102];
    abort.abort();
    const results = await settle(Promise.all(pending));
    expect(shed).toMatchObject({ data: { reason: 'upstream_rate_limited', retryable: true } });
    expect(
      results.filter(
        (error) => (error as { code?: number }).code === JsonRpcErrorCode.RequestCancelled,
      ),
    ).toHaveLength(101);
    expect(network.calls).toHaveLength(1);
  });
  it('cancels during an incomplete streamed response without parsing or retrying', async () => {
    const abort = new AbortController();
    const network = fakeFetch(
      (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"partial":'));
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                once: true,
              });
            },
          }),
        ),
    );
    const parse = vi.fn();
    using scope = new WormsScope(createMockContext({ signal: abort.signal }));
    const pending = request(scope, endpoint, query, parse).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    abort.abort();
    await expect(settle(pending)).resolves.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    expect(parse).not.toHaveBeenCalled();
    expect(network.calls).toHaveLength(1);
  });
  it('retries one timed-out attempt and classifies exhausted attempt timeouts', async () => {
    const network = fakeFetch((_url, init) => hang(init));
    using scope = new WormsScope(createMockContext());
    await expect(settle(request(scope, endpoint, query, (data) => data))).rejects.toMatchObject({
      data: { reason: 'upstream_timeout' },
    });
    expect(network.calls).toHaveLength(2);
  });
  it('checks the absolute deadline after local parsing and discards the result', async () => {
    fakeFetch(() => Response.json({ valid: true }));
    using scope = new WormsScope(createMockContext());
    await expect(
      settle(
        request(scope, endpoint, query, (data) => {
          vi.setSystemTime(Date.now() + 45_001);
          return data;
        }),
      ),
    ).rejects.toMatchObject({ data: { reason: 'upstream_timeout' } });
  });
  it('cannot extend the absolute budget with a long Retry-After', async () => {
    const network = fakeFetch(
      () => new Response(null, { status: 429, headers: { 'retry-after': '60' } }),
    );
    using scope = new WormsScope(createMockContext());
    await expect(settle(request(scope, endpoint, query, (data) => data))).rejects.toMatchObject({
      data: { reason: 'upstream_rate_limited' },
    });
    expect(network.calls).toHaveLength(1);
  });
});
