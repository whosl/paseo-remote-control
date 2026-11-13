import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../client/viewer/feedback.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const settle = () => new Promise((resolve) => setImmediate(resolve));
function setup(platform, selectionAsync) {
  const calls = { selection: 0, fallback: 0, browser: 0, press: 0 };
  const api = {};
  let pulse;
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: { createContext: () => ({ Provider: "Provider" }), useCallback: (fn) => fn, useContext: () => pulse },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Platform: { OS: platform }, Pressable: "Pressable", Vibration: { vibrate: () => calls.fallback++ } },
    "./web": { vibrateBrowser: () => calls.browser++ },
  };
  runInNewContext(code, { exports: api, require: (name) => { assert.ok(name in modules); return modules[name]; },
    expo: selectionAsync ? { modules: { ExpoHaptics: { selectionAsync: () => { calls.selection++; return selectionAsync(); } } } } : undefined });
  return { calls, api, enable: (enabled) => pulse = api.FeedbackProvider({ enabled }).props.value };
}
for (const platform of ["ios", "android"]) {
  const h = setup(platform, () => Promise.resolve());
  h.enable(true)(); await settle();
  assert.equal(h.calls.selection, 1); assert.equal(h.calls.fallback, 0);
  h.enable(false)(); await settle(); assert.equal(h.calls.selection, 1);
  h.enable(true);
  h.api.FeedbackPressable({ onPress: () => h.calls.press++ }).props.onPress({});
  await settle(); assert.equal(h.calls.selection, 2); assert.equal(h.calls.press, 1);
  for (const driver of [undefined, () => { throw Error("unavailable"); }, () => Promise.reject(Error("unavailable"))]) {
    const fallback = setup(platform, driver); fallback.enable(true)(); await settle();
    assert.equal(fallback.calls.fallback, 1);
  }
}
const web = setup("web"); web.enable(true)(); assert.equal(web.calls.browser, 1); assert.equal(web.calls.fallback, 0);
const desktop = setup("macos"); desktop.enable(true)(); assert.equal(desktop.calls.fallback, 0);
console.log("Haptic dispatch, optional native bridge/fallback, disabled feedback and single button pulse checks passed (mock drivers)");
