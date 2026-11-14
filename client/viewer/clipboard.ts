import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { clipboardRpc } from "../../shared/screen/rpc";
import { hasBrowserClipboard, readBrowserClipboard, writeBrowserClipboard } from "./web";
export const readLocalClipboard = readBrowserClipboard;

/**
 * Mirrors host copies into this client's clipboard (web and desktop clients only).
 * After a copy shortcut is sent, the host clipboard is checked a few times because apps copy asynchronously.
 */
export function useHostClipboard(active: boolean, viewerId?: string) {
  const read = useRpc(clipboardRpc);
  const readRef = useRef(read);
  readRef.current = read;
  const viewerRef = useRef(viewerId);
  viewerRef.current = viewerId;
  const known = useRef<number | null>(null);
  const pasted = useRef<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const supported = hasBrowserClipboard();

  useEffect(() => {
    if (!active || !supported) return;
    readRef.current(viewerRef.current ? { viewerId: viewerRef.current } : {}).then(
      (clipboard) => (known.current = clipboard.changeCount),
      () => undefined,
    );
  }, [active, supported]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [message]);

  /** Copies the host clipboard here. With `onlyIfChanged`, skips it unless something on the host copied since the last check. */
  const pull = useCallback(
    async (onlyIfChanged: boolean): Promise<boolean> => {
      if (!supported) return false;
      try {
        const clipboard = await readRef.current(viewerRef.current ? { viewerId: viewerRef.current } : {});
        if (onlyIfChanged && clipboard.changeCount === known.current) return false;
        known.current = clipboard.changeCount;
        // A change that is only our own paste landing is not a host copy; keep waiting for the real one.
        if (onlyIfChanged && clipboard.text !== undefined && clipboard.text === pasted.current) return false;
        pasted.current = null;
        if (clipboard.text === undefined) {
          setMessage("Host clipboard has no text");
          return true;
        }
        await writeBrowserClipboard(clipboard.text);
        setMessage(`Copied ${clipboard.text.length} characters from host`);
        return true;
      } catch (error) {
        setMessage(`Clipboard sync failed: ${error instanceof Error ? error.message : String(error)}`);
        return true;
      }
    },
    [supported],
  );

  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = useCallback((delay: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      run();
    }, delay);
    timers.current.add(timer);
  }, []);

  const afterHostCopy = useCallback(() => {
    let attempt = 0;
    const delays = [150, 350, 700, 1200];
    const check = () => {
      void pull(true).then((done) => {
        if (!done && ++attempt < delays.length) later(delays[attempt]! - delays[attempt - 1]!, check);
      });
    };
    later(delays[0]!, check);
  }, [pull, later]);

  /** Records text just pasted on the host from here, so that change is not mirrored back as a copy. */
  const notePasted = useCallback((text: string) => {
    pasted.current = text;
  }, []);

  return { supported, message, pull: () => void pull(false), afterHostCopy, notePasted, setMessage };
}
