interface SessionApi {
  open(): Promise<{ viewerId: string }>;
  close(input: { viewerId: string }): Promise<unknown>;
  report(error: unknown): void;
}

/** One registration per mounted page. Late registration replies still get closed. */
export function startViewerSession(api: SessionApi, update: (viewerId: string | undefined, error: string | null) => void) {
  let disposed = false;
  let viewerId: string | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  const leave = () => {
    if (!viewerId) return Promise.resolve();
    return closing ??= api.close({ viewerId }).then(() => {}, api.report);
  };
  let pending: Promise<unknown>;
  const connect = () => {
    pending = api.open().then(result => {
      viewerId = result.viewerId;
      if (disposed) return leave();
      update(viewerId, null);
    }, error => {
      if (disposed) return;
      update(undefined, error instanceof Error ? error.message : String(error));
      retry = setTimeout(connect, 2000);
    });
  };
  connect();
  return {
    async close() {
      disposed = true;
      clearTimeout(retry);
      await pending;
      await leave();
    },
  };
}
