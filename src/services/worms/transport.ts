/**
 * @fileoverview Shared bounded WoRMS request lifecycle and paced transport.
 * @module services/worms/transport
 */
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createPacer, withRetry } from '@cyanheads/mcp-ts-core/utils';

/**
 * Code and retryability per classified upstream failure. Recovery is per tool: each tool's
 * `errors[]` entry for the reason is the hint the framework attaches to a thrown failure, and
 * `optionalError` copies the same entry into item errors.
 */
export const failures = {
  upstream_rejected: [JsonRpcErrorCode.ValidationError, false],
  upstream_rate_limited: [JsonRpcErrorCode.RateLimited, true],
  upstream_access_denied: [JsonRpcErrorCode.ServiceUnavailable, false],
  upstream_unavailable: [JsonRpcErrorCode.ServiceUnavailable, true],
  upstream_timeout: [JsonRpcErrorCode.Timeout, true],
  invalid_upstream_response: [JsonRpcErrorCode.SerializationError, false],
  response_too_large: [JsonRpcErrorCode.ServiceUnavailable, false],
} as const;
export type FailureReason = keyof typeof failures;
/** Preserve the first ordered failure while attaching safe crosswalk diagnostics. */
export function crosswalkFailure(error: McpError, failedTypes: unknown[]) {
  return new McpError(error.code, error.message, { ...error.data, failedTypes }, { cause: error });
}
/** Create safe errors without upstream response bodies, private headers, or a tool-neutral hint. */
export function failure(
  reason: FailureReason,
  message = reason.replaceAll('_', ' '),
  extra: Record<string, unknown> = {},
) {
  const [code, retryable] = failures[reason];
  return new McpError(code, message, { ...extra, reason, retryable });
}

/** A single absolute deadline spanning every logical request and local pass. */
export class WormsScope implements Disposable {
  readonly expiresAt = Date.now() + 45_000;
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(readonly ctx: Context) {
    this.signal = AbortSignal.any([ctx.signal, this.controller.signal]);
    this.timer = setTimeout(() => this.controller.abort(failure('upstream_timeout')), 45_000);
  }
  /** Check caller cancellation before deadline, including synchronous tree passes. */
  check(): void {
    if (this.ctx.signal.aborted)
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
  /**
   * Retain optional failures only while the complete tool call remains viable, with the calling
   * tool's declared recovery; a reason its contract does not declare fails the call.
   */
  optionalError(error: unknown) {
    this.check();
    if (!(error instanceof McpError)) throw error;
    if (
      error.code === JsonRpcErrorCode.RequestCancelled ||
      error.data?.reason === 'upstream_rejected'
    )
      throw error;
    const reason = error.data?.reason;
    if (typeof reason !== 'string' || !Object.hasOwn(failures, reason)) throw error;
    const declared = this.ctx.recoveryFor(reason);
    if (!('recovery' in declared)) throw error;
    return {
      reason,
      code: error.code,
      message: error.message,
      recovery: declared.recovery.hint,
      retryable: failures[reason as FailureReason][1],
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

const allowedEndpoint =
  /^Aphia(?:RecordsByNames|RecordsByMatchNames|RecordsByAphiaIDs|RecordByAphiaID\/\d+|RecordsByVernacular\/[^/]+|VernacularsByAphiaID\/\d+|SourcesByAphiaID\/\d+|ClassificationByAphiaID\/\d+|ChildrenByAphiaID\/\d+|TaxonRanksByID\/-1|AttributeKeysByID\/0|SynonymsByAphiaID\/\d+|DistributionsByAphiaID\/\d+|AttributesByAphiaID\/\d+|ExternalIDByAphiaID\/\d+|RecordByExternalID\/[^/]+)$/;
const allowedQueryKeys = new Set([
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
const maxResponseBytes = 8 * 1024 * 1024;

/** Classify a non-OK upstream status; 504 is a timeout before the generic 5xx outage. */
function statusReason(status: number): FailureReason {
  if (status === 400 || status === 422) return 'upstream_rejected';
  if (status === 429) return 'upstream_rate_limited';
  if (status === 401 || status === 403) return 'upstream_access_denied';
  if (status === 408 || status === 504) return 'upstream_timeout';
  return status >= 500 ? 'upstream_unavailable' : 'invalid_upstream_response';
}

/** Fetch one allowlisted endpoint with bounded reading, validation and retries. */
export async function request<T>(
  scope: WormsScope,
  endpoint: string,
  query: URLSearchParams,
  parse: (data: unknown) => T,
): Promise<T | null> {
  scope.check();
  if (!allowedEndpoint.test(endpoint)) throw new Error('Unsupported WoRMS endpoint.');
  for (const key of query.keys())
    if (!allowedQueryKeys.has(key)) throw new Error('Unsupported WoRMS query key.');
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
            const live = () => {
              scope.check();
              fetchSignal.throwIfAborted();
            };
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
                const reason = statusReason(response.status);
                const error = failure(
                  reason,
                  `WoRMS returned HTTP ${response.status}.`,
                  response.headers.has('retry-after')
                    ? { retryAfter: response.headers.get('retry-after') }
                    : {},
                );
                if (reason === 'upstream_rejected') scope.controller.abort(error);
                throw error;
              }
              const decoder = new TextDecoder();
              let text = '';
              let size = 0;
              reader = response.body?.getReader();
              if (reader) {
                for (;;) {
                  live();
                  const result = await reader.read();
                  if (result.done) break;
                  size += result.value.byteLength;
                  if (size > maxResponseBytes) {
                    await reader.cancel();
                    throw failure('response_too_large');
                  }
                  text += decoder.decode(result.value, { stream: true });
                }
              }
              text += decoder.decode();
              live();
              if (/^\s*<(?:!doctype\s+html|html\b)/i.test(text))
                throw failure('upstream_unavailable', 'WoRMS returned HTML instead of JSON.');
              let data: unknown;
              try {
                data = JSON.parse(text);
              } catch {
                throw failure('invalid_upstream_response', 'WoRMS returned malformed JSON.');
              }
              live();
              const result = parse(data);
              live();
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
      throw failure('upstream_rate_limited', 'WoRMS request queue is full.');
    if (error instanceof McpError && error.data?.reason === 'retry_deadline_exceeded') {
      scope.controller.abort(failure('upstream_timeout'));
      throw failure('upstream_timeout');
    }
    throw error;
  }
}
