import { describe, expect, it, vi } from "vitest";
import { androidVideoViewName } from "../client/viewer/native-video-view";

describe("Android native video capability", () => {
  it("detects modern Fabric views without querying disabled legacy native constants", () => {
    const manager = { hasViewManagerConfig: vi.fn(() => true), getViewManagerConfig: vi.fn(() => null) };
    expect(androidVideoViewName("android", manager)).toBe("RNCWebView");
    expect(manager.hasViewManagerConfig).toHaveBeenCalledWith("RNCWebView");
    expect(manager.getViewManagerConfig).not.toHaveBeenCalled();
  });
  it("uses legacy discovery only when the modern API does not exist", () => {
    const getViewManagerConfig = vi.fn(() => ({ NativeProps: {} }));
    expect(androidVideoViewName("android", { getViewManagerConfig })).toBe("RNCWebView");
    expect(getViewManagerConfig).toHaveBeenCalledWith("RNCWebView");
  });
  it("respects an unavailable modern capability without consulting the deprecated API", () => {
    const manager = { hasViewManagerConfig: vi.fn(() => false), getViewManagerConfig: vi.fn(() => ({})) };
    expect(androidVideoViewName("android", manager)).toBeNull();
    expect(manager.getViewManagerConfig).not.toHaveBeenCalled();
  });
  it("can recover if a native capability becomes available after the first render", () => {
    let available = false;
    const manager = { hasViewManagerConfig: () => available };
    expect(androidVideoViewName("android", manager)).toBeNull();
    available = true;
    expect(androidVideoViewName("android", manager)).toBe("RNCWebView");
  });
  it("initializes the host's lazy view registration without registering another native component", () => {
    let registered = false;
    const manager = { hasViewManagerConfig: () => registered };
    const prepare = vi.fn(() => { registered = true; });
    expect(androidVideoViewName("android", manager, prepare)).toBe("RNCWebView");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(androidVideoViewName("web", manager, prepare)).toBeNull();
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it("keeps non-Android and unavailable runtimes on the portable fallback", () => {
    const hasViewManagerConfig = vi.fn(() => { throw new Error("unavailable"); });
    expect(androidVideoViewName("web", { hasViewManagerConfig })).toBeNull();
    expect(androidVideoViewName("ios", { hasViewManagerConfig })).toBeNull();
    expect(hasViewManagerConfig).not.toHaveBeenCalled();
    expect(androidVideoViewName("android", { hasViewManagerConfig })).toBeNull();
    expect(androidVideoViewName("android", undefined)).toBeNull();
    expect(androidVideoViewName("android", {})).toBeNull();
  });
});
