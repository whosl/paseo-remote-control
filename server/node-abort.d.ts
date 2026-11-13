// React Native declares the older Abort API globally. The server runs on
// Node 22, whose cancellation API includes reasons and throwIfAborted.
export {};
declare global {
  interface AbortSignal {
    readonly reason: unknown;
    throwIfAborted(): void;
  }
  interface AbortController { abort(reason?: unknown): void }
}
