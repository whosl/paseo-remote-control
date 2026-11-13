import type {
  HelperCommandName,
  HelperCommands,
  HelperUnsolicitedEvent,
} from "./helper-protocol";

export interface HelperPort {
  // Visual backends may need to focus a real window before sending input.
  // macOS does not expose this operation and keeps its background behavior.
  focusWindow?(
    params: { app: string; windowId?: number; blockedBundleIds: string[]; blockedBundleIdPrefixes?: string[] },
    options?: { signal?: AbortSignal },
  ): Promise<import("./results").ActionExecutionResult>;
  request<K extends HelperCommandName>(
    cmd: K,
    params: HelperCommands[K]["params"],
    options?: { signal?: AbortSignal; timeoutMs?: number; meta?: Record<string, unknown> },
  ): Promise<HelperCommands[K]["result"]>;

  onEvent(listener: (event: HelperUnsolicitedEvent) => void): () => void;

  stop(): Promise<void>;
}
