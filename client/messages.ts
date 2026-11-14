import { defineTranslations, useTranslation } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zh from "./locales/zh.json";

// The presenting Paseo app supplies the locale, including its System preference.
export const remoteMessages = defineTranslations({ resources: { en, zh } });
export const useRemoteTranslation = () => useTranslation(remoteMessages);
export type RemoteTranslate = ReturnType<typeof useRemoteTranslation>["t"];

const literalKeys = new Map(
  Object.entries(en).filter(([, value]) => !value.includes("{{"))
    .map(([key, value]) => [value, key as keyof typeof en]),
);

/** Localize known plugin messages at render time, not in shared daemon state. */
export function localizeRemoteText(text: string | null | undefined, t: RemoteTranslate): string | null {
  if (text == null) return null;
  const key = literalKeys.get(text);
  if (key) return t(key);
  if (text.startsWith("Error: ")) {
    const detail = text.slice(7);
    const translated = localizeRemoteText(detail, t);
    if (translated !== detail) return translated;
  }
  const copied = /^Copied (\d+) characters from host$/.exec(text);
  if (copied) return t("copiedCharacters", { count: Number(copied[1]) });
  const agent = /^Agent ([\w-]+)$/.exec(text);
  if (agent) return t("agentLabel", { id: agent[1] });
  const clipboard = /^Clipboard sync failed: ([\s\S]*)$/.exec(text);
  if (clipboard) return t("clipboardFailed", { error: localizeRemoteText(clipboard[1], t) });
  const fullscreen = /^Fullscreen: ([\s\S]*)$/.exec(text);
  if (fullscreen) return t("fullscreenError", { error: localizeRemoteText(fullscreen[1], t) });
  // Unknown diagnostics, device names and application content remain unmodified.
  return text;
}
