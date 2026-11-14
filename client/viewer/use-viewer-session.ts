import { useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { viewerOpenRpc, viewerCloseRpc } from "../../shared/control";
import { startViewerSession } from "./viewer-session";

export function useViewerSession(hostId: string) {
  const open = useRpc(viewerOpenRpc), close = useRpc(viewerCloseRpc);
  const api = useRef({ open, close });
  api.current = { open, close };
  const [state, setState] = useState<{ hostId: string; viewerId?: string; error: string | null }>({ hostId, error: null });
  useEffect(() => {
    setState({ hostId, error: null });
    const current = api.current;
    const session = startViewerSession({
      open: () => current.open({}), close: current.close,
      report: error => console.warn("[remote-control] Could not confirm automatic viewer handoff", error),
    }, (viewerId, error) => setState({ hostId, viewerId, error }));
    return () => { void session.close(); };
  }, [hostId]);
  return state.hostId === hostId ? state : { hostId, viewerId: undefined, error: null };
}
