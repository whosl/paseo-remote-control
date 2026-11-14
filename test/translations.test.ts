import { describe, expect, it } from "vitest";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { localizeRemoteText, remoteMessages, type RemoteTranslate } from "../client/messages";
import { settingsMessages } from "../client/settings-messages";
import { readFileSync } from "node:fs";
import ts from "typescript";

function runtime(initial: string) {
  let locale = initial;
  const listeners = new Set<() => void>();
  const instance = new PluginTranslationRuntime({
    getLocale: () => locale,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  return { instance, listeners, setLocale: (value: string) => { locale = value; for (const listener of listeners) listener(); } };
}

function flatten(resource: object, prefix = ""): Record<string, string> {
  return Object.fromEntries(Object.entries(resource).flatMap(([key, value]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [[name, value]] : Object.entries(flatten(value, name));
  }));
}

describe("Paseo-managed plugin translations", () => {
  it("keeps visible JSX text in the catalogs instead of hard-coded English", () => {
    for (const file of ["../client/viewer/screen.tsx", "../client/viewer/contribute.tsx", "../client/settings-screen.tsx"]) {
      const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if (ts.isJsxText(node)) expect(node.text.trim()).not.toMatch(/[a-zA-Z]/);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  });

  it("covers every built-in Windows fallback status message", () => {
    const file = new URL("../server/host/windows-display.ts", import.meta.url);
    const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const english = Object.values(remoteMessages.resources.en);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "change") {
        const message = node.arguments[1];
        if (message && ts.isStringLiteral(message)) expect(english).toContain(message.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  });

  it.each(["en", "en-US", "fr", "de", "ja", "ko", "es", "pt-BR", "ar", "ru", "zhx", "zh", "zh-CN", "zh-TW", "zh-HK", "zh-SG", "zh-MO", "zh-Hans", "zh-Hant", "zh-Hant-TW"])("uses Chinese only for Chinese locale %s", locale => {
    const { instance } = runtime(locale);
    try {
      const catalogs = [
        { resources: remoteMessages.resources, message: (key: string, options: Record<string, unknown>) => remoteMessages.message(key as never, options as never) },
        { resources: settingsMessages.resources, message: (key: string, options: Record<string, unknown>) => settingsMessages.message(key as never, options as never) },
      ];
      for (const messages of catalogs) {
        const english = flatten(messages.resources.en);
        const chinese = flatten(messages.resources.zh!);
        expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
        for (const [key, source] of Object.entries(english)) {
          const options = Object.fromEntries([...source.matchAll(/{{\s*(\w+)\s*}}/g)].map(match => [match[1]!, match[1] === "count" ? 3 : `value-${match[1]}`]));
          const expected = (locale === "zh" || locale.startsWith("zh-") ? chinese[key]! : source)
            .replace(/{{\s*(\w+)\s*}}/g, (_match, name: string) => String(options[name]));
          expect(instance.resolve(messages.message(key, options))).toBe(expected);
        }
      }
    } finally { instance.dispose(); }
  });

  it("updates existing navigation labels and independent clients without rebuilding messages", () => {
    const a = runtime("en"), b = runtime("zh-CN");
    const title = remoteMessages.message("title");
    let notifications = 0;
    const unsubscribe = a.instance.subscribe(() => notifications++);
    try {
      expect(a.instance.resolve(title)).toBe("Remote Control");
      expect(b.instance.resolve(title)).toBe("远程控制");
      a.setLocale("zh-TW");
      expect(a.instance.resolve(title)).toBe("远程控制");
      a.setLocale("de");
      expect(a.instance.resolve(title)).toBe("Remote Control");
      expect(b.instance.resolve(title)).toBe("远程控制");
      expect(notifications).toBe(2);
    } finally { unsubscribe(); a.instance.dispose(); b.instance.dispose(); }
    expect(a.listeners.size).toBe(0);
  });

  it("localizes known daemon and clipboard messages at render time, preserving raw diagnostics", () => {
    const app = runtime("zh-CN");
    const t: RemoteTranslate = (key, ...args) => app.instance.t(remoteMessages, key, ...args);
    try {
      expect(localizeRemoteText("Virtual fallback active. Waiting for a physical display.", t)).toBe("虚拟备用屏已启用，正在等待物理显示器连接。");
      expect(localizeRemoteText("Human control", t)).toBe("人类控制");
      expect(localizeRemoteText("Agent fixture-123", t)).toBe("智能体 fixture-123");
      expect(localizeRemoteText("Copied 3 characters from host", t)).toBe("已从主机复制 3 个字符");
      expect(localizeRemoteText("Error: Display changed; wait for a fresh frame", t)).toBe("显示器已变化，请等待新画面后操作");
      expect(localizeRemoteText("Clipboard sync failed: This client does not expose its clipboard", t)).toBe("剪贴板同步失败：当前客户端不支持访问剪贴板");
      expect(localizeRemoteText("QueryDisplayConfig failed (87)", t)).toBe("QueryDisplayConfig failed (87)");
      expect(localizeRemoteText("66PC / App ID / custom diagnostic", t)).toBe("66PC / App ID / custom diagnostic");
      expect(localizeRemoteText(null, t)).toBeNull();
      app.setLocale("fr");
      expect(localizeRemoteText("Human control", t)).toBe("Human control");
    } finally { app.instance.dispose(); }
  });
});
