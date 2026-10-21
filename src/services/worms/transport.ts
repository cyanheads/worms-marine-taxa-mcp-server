/**
 * @fileoverview Shared bounded WoRMS request lifecycle and paced transport.
 * @module services/worms/transport
 */
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createPacer, withRetry } from '@cyanheads/mcp-ts-core/utils';

export const failures = {
  upstream_rejected: [
    JsonRpcErrorCode.ValidationError,
    'Call worms_list_reference for valid vocabulary, then retry the original tool with corrected inputs.',
    false,
  ],
  upstream_rate_limited: [
    JsonRpcErrorCode.RateLimited,
    'Wait for the stated retry delay, then retry the same tool with fewer concurrent calls.',
    true,
  ],
  upstream_access_denied: [
    JsonRpcErrorCode.ServiceUnavailable,
    'Retry the same tool later; the keyless WoRMS service currently refuses access.',
    false,
  ],
  upstream_unavailable: [
    JsonRpcErrorCode.ServiceUnavailable,
    'Retry the same tool later; use worms_list_reference with topic: external_id_types for offline vocabulary.',
    true,
  ],
  upstream_timeout: [
    JsonRpcErrorCode.Timeout,
    'Retry the same tool later; call worms_crosswalk_id with one type to reduce crosswalk work.',
    true,
  ],
  invalid_upstream_response: [
    JsonRpcErrorCode.SerializationError,
    'Retry the same tool later; use worms_get_taxon to verify a known AphiaID.',
    false,
  ],
  response_too_large: [
    JsonRpcErrorCode.ServiceUnavailable,
    'Call worms_get_taxon for the taxon record; this tool cannot return the oversized WoRMS response.',
    false,
  ],
} as const;
export type FailureReason = keyof typeof failures;
/** Preserve the first ordered failure while attaching safe crosswalk diagnostics. */
export function crosswalkFailure(error: McpError, failedTypes: unknown[]) {
  return new McpError(error.code, error.message, { ...error.data, failedTypes }, { cause: error });
}
/** Create safe errors without upstream response bodies or private headers. */
export function failure(
  reason: FailureReason,
  message = reason.replaceAll('_', ' '),
  extra: Record<string, unknown> = {},
) {
  const [code, recovery, retryable] = failures[reason];
  return new McpError(code, message, { ...extra, reason, recovery: { hint: recovery }, retryable });
}

/** A single absolute deadline spanning every logical request and local pass. */
export class WormsScope implements Disposable {
  readonly expiresAt = Date.now() + 45_000;
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(readonly ctx: Context) {
    this.signal = ctx.signal
      ? AbortSignal.any([ctx.signal, this.controller.signal])
      : this.controller.signal;
    this.timer = setTimeout(() => this.controller.abort(failure('upstream_timeout')), 45_000);
  }
  /** Check caller cancellation before deadline, including synchronous tree passes. */
  check(): void {
    if (this.ctx.signal?.aborted)
      throw new McpError(JsonRpcErrorCode.RequestCancelled, 'Request cancelled.');
    if (
      this.controller.signal.aborted &&
      this.controller.signal.reason instanceof McpError &&
      this.controller.signal.reason.data?.reason === 'upstream_rejected'
    )
      throw this.controller.signal.reason;
    if (Date.now() >= this.expiresAt || this.controller.signal.aborted)
      throw failure('upstream_timeout');
  }
  /** Retain optional failures only while the complete tool call remains viable. */
  optionalError(error: unknown) {
    this.check();
    if (!(error instanceof McpError)) throw error;
    if (
      error.code === JsonRpcErrorCode.RequestCancelled ||
      error.data?.reason === 'upstream_rejected'
    )
      throw error;
    const reason = error.data?.reason;
    if (typeof reason !== 'string' || !(reason in failures)) throw error;
    const key = reason as FailureReason;
    return {
      reason,
      code: error.code,
      message: error.message,
      recovery: failures[key][1],
      retryable: failures[key][2],
    };
  }
  [Symbol.dispose]() {
    clearTimeout(this.timer);
  }
}

const pacer = createPacer({
  name: 'worms',
  maxConcurrent: 1,
  minStartGapMs: 500,
  maxQueueDepth: 100,
});
/** Dispose the shared queue only at application teardown. */
export function disposeTransport() {
  pacer.dispose();
}

/** Fetch one allowlisted endpoint with bounded reading, validation and retries. */
export async function request<T>(
  scope: WormsScope,
  endpoint: string,
  query: URLSearchParams,
  parse: (data: unknown) => T,
): Promise<T | null> {
  scope.check();
  if (
    !/^Aphia(?:RecordsByNames|RecordsByMatchNames|RecordsByAphiaIDs|RecordByAphiaID\/\d+|RecordsByVernacular\/[^/]+|VernacularsByAphiaID\/\d+|ClassificationByAphiaID\/\d+|ChildrenByAphiaID\/\d+|TaxonRanksByID\/-1|AttributeKeysByID\/0|SynonymsByAphiaID\/\d+|DistributionsByAphiaID\/\d+|AttributesByAphiaID\/\d+|ExternalIDByAphiaID\/\d+|RecordByExternalID\/[^/]+)$/.test(
      endpoint,
    )
  )
    throw new Error('Unsupported WoRMS endpoint.');
  const allowed = new Set([
    'scientificnames[]',
    'aphiaids[]',
    'like',
    'marine_only',
    'extant_only',
    'match_authority',
    'offset',
    'include_children',
    'include_inherited',
    'type',
  ]);
  for (const key of query.keys())
    if (!allowed.has(key)) throw new Error('Unsupported WoRMS query key.');
  try {
    return await withRetry(
      ({ signal }) =>
        pacer.run(
          async (pacedSignal) => {
            scope.check();
            const attemptController = new AbortController();
            const timer = setTimeout(
              () => attemptController.abort(failure('upstream_timeout')),
              Math.min(10_000, scope.expiresAt - Date.now()),
            );
            const fetchSignal = AbortSignal.any([pacedSignal, attemptController.signal]);
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
            try {
              const response = await fetch(
                `https://www.marinespecies.org/rest/${endpoint}?${query}`,
                { signal: fetchSignal, headers: { Accept: 'application/json' } },
              );
              if (response.status === 204) {
                await response.body?.cancel();
                return null;
              }
              if (!response.ok) {
                await response.body?.cancel();
                const status = response.status;
                const reason =
                  status === 400 || status === 422
                    ? 'upstream_rejected'
                    : status === 429
                      ? 'upstream_rate_limited'
                      : status === 401 || status === 403
                        ? 'upstream_access_denied'
                        : status === 408 || status === 504
                          ? 'upstream_timeout'
                          : status >= 500
                            ? 'upstream_unavailable'
                            : 'invalid_upstream_response';
                const error = failure(
                  reason,
                  `WoRMS returned HTTP ${status}.`,
                  response.headers.has('retry-after')
                    ? { retryAfter: response.headers.get('retry-after') }
                    : {},
                );
                if (reason === 'upstream_rejected') scope.controller.abort(error);
                throw error;
              }
              const chunks: Uint8Array[] = [];
              let size = 0;
              reader = response.body?.getReader();
              if (reader) {
                for (;;) {
                  scope.check();
                  fetchSignal.throwIfAborted();
                  const result = await reader.read();
                  if (result.done) break;
                  size += result.value.byteLength;
                  if (size > 8 * 1024 * 1024) {
                    await reader.cancel();
                    throw failure('response_too_large');
                  }
                  chunks.push(result.value);
                }
              }
              const bytes = new Uint8Array(size);
              let position = 0;
              for (const chunk of chunks) {
                bytes.set(chunk, position);
                position += chunk.byteLength;
              }
              const text = new TextDecoder().decode(bytes);
              scope.check();
              fetchSignal.throwIfAborted();
              if (/^\s*<(?:!doctype\s+html|html\b)/i.test(text))
                throw failure('upstream_unavailable', 'WoRMS returned HTML instead of JSON.');
              let data: unknown;
              try {
                data = JSON.parse(text);
              } catch {
                throw failure('invalid_upstream_response', 'WoRMS returned malformed JSON.');
              }
              scope.check();
              fetchSignal.throwIfAborted();
              const result = parse(data);
              scope.check();
              fetchSignal.throwIfAborted();
              return result;
            } catch (error) {
              scope.check();
              if (attemptController.signal.aborted) throw failure('upstream_timeout');
              if (error instanceof McpError) throw error;
              if (fetchSignal.aborted) throw fetchSignal.reason;
              throw failure('upstream_unavailable', 'WoRMS network request failed.');
            } finally {
              clearTimeout(timer);
              if (reader) {
                await reader.cancel().catch(() => {});
                reader.releaseLock();
              }
            }
          },
          { signal },
        ),
      {
        signal: scope.signal,
        deadlineMs: Math.max(1, scope.expiresAt - Date.now()),
        maxRetries: 1,
        baseDelayMs: 1000,
        maxDelayMs: 45_000,
        context: scope.ctx,
        operation: endpoint,
      },
    );
  } catch (error) {
    scope.check();
    if (error instanceof McpError && error.data?.reason === 'pacer_shed')
      throw failure('upstream_rate_limited', 'WoRMS request queue is full.', { retryable: false });
    if (error instanceof McpError && error.data?.reason === 'retry_deadline_exceeded') {
      scope.controller.abort(failure('upstream_timeout'));
      throw failure('upstream_timeout');
    }
    throw error;
  }
}
