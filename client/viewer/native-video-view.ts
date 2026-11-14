interface ViewManager {
  hasViewManagerConfig?(name: string): boolean;
  getViewManagerConfig?(name: string): unknown;
}

/** Fabric can expose an installed component without the legacy native constants. */
export function androidVideoViewName(platform: string, manager: ViewManager | undefined, prepare?: () => unknown): "RNCWebView" | null {
  if (platform !== "android" || !manager) return null;
  try {
    // Access the host's lazy component export before reusing its native view tag.
    prepare?.();
    const available = typeof manager.hasViewManagerConfig === "function"
      ? manager.hasViewManagerConfig("RNCWebView")
      : typeof manager.getViewManagerConfig === "function" && !!manager.getViewManagerConfig("RNCWebView");
    return available ? "RNCWebView" : null;
  } catch { return null; }
}
