import { ProviderError } from './types.js';

export interface Deadline {
  readonly signal: AbortSignal;
  /** The error to surface once `signal` has fired: a timeout is retryable, a caller abort is not. */
  abortError(): ProviderError;
  dispose(): void;
}

/** Combines a timeout with an optional caller signal into one AbortSignal. */
export function startDeadline(providerId: string, timeoutMs: number, parent?: AbortSignal): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', forwardAbort, { once: true });

  return {
    signal: controller.signal,
    abortError: () =>
      timedOut
        ? new ProviderError(`${providerId} timed out after ${timeoutMs}ms`, providerId, true)
        : new ProviderError(`${providerId} request was aborted`, providerId, false),
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', forwardAbort);
    },
  };
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
