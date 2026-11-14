import { afterEach, describe, expect, it, vi } from "vitest";

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile, mkdir: vi.fn(), rename: vi.fn(), rm: vi.fn(), writeFile: vi.fn() }));

async function windowsPreferences() {
  vi.resetModules();
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    return await import("../server/screen/preferences");
  } finally { Object.defineProperty(process, "platform", descriptor); }
}
afterEach(() => vi.clearAllMocks());
describe("Windows legacy control policy migration", () => {
  it.each([{ controlPaused: true, humanPriority: true }, { controlPaused: false, humanPriority: true }])("preserves legacy policy %j", async policy => {
    readFile.mockImplementation(async (file: string) => {
      if (file.includes(".config") && file.includes("paseo-screen")) return JSON.stringify(policy);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const prefs = await windowsPreferences();
    expect(await prefs.readControlPolicy()).toEqual({ paused: policy.controlPaused, humanPriority: policy.humanPriority });
  });
  it("fails closed for a corrupt new policy instead of falling through to legacy", async () => {
    readFile.mockResolvedValue("not json"); const prefs = await windowsPreferences();
    expect(await prefs.readControlPolicy()).toEqual({ paused: true, humanPriority: true });
  });
});
