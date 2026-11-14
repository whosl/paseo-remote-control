import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Host-side preferences. Display IDs stay stable for a given monitor while it is connected.
const file =
  process.platform === "darwin"
    ? path.join(homedir(), "Library", "Application Support", "paseo-remote-control", "preferences.json")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"), "paseo-remote-control", "preferences.json")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "paseo-remote-control", "preferences.json");
const legacyFile = file.replace("paseo-remote-control", "paseo-screen");
/** Where Windows hosts kept preferences before 0.5.0; read until the new file exists. */
const legacyWindowsFile = path.join(homedir(), ".config", "paseo-screen", "preferences.json");
const candidates = process.platform === "win32" ? [file, legacyFile, legacyWindowsFile] : [file, legacyFile];

interface Preferences {
  display?: number;
  /** Remote input is refused while true; viewers can still watch. Kept across restarts. */
  controlPaused?: boolean;
  humanPriority?: boolean;
  displayFallbackEnabled?: boolean;
  displayKey?: string;
}

async function read(): Promise<Preferences> {
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, "utf8")) as Preferences;
    } catch {
      // Missing or unreadable: try the next location, then fall back to defaults.
    }
  }
  return {};
}

export async function readPreferredDisplay(): Promise<number | null> {
  return (await read()).display ?? null;
}

export function writePreferredDisplay(display: number, displayKey?: string): Promise<void> {
  return update((preferences) => (preferences.display === display && preferences.displayKey === displayKey ? null : { ...preferences, display, displayKey }));
}

export async function readDisplayFallbackPolicy(): Promise<{ enabled: boolean; selectedKey: string | null }> {
  const preferences = await read();
  return { enabled: preferences.displayFallbackEnabled === true, selectedKey: typeof preferences.displayKey === "string" ? preferences.displayKey : null };
}
export function writeDisplayFallbackEnabled(enabled: boolean): Promise<void> {
  return update((preferences) => ({ ...preferences, displayFallbackEnabled: enabled }));
}

export async function readControlPaused(): Promise<boolean> {
  return (await read()).controlPaused === true;
}

export function writeControlPaused(paused: boolean): Promise<void> {
  return update((preferences) => ((preferences.controlPaused === true) === paused ? null : { ...preferences, controlPaused: paused }));
}

export async function readControlPolicy(): Promise<{ paused: boolean; humanPriority: boolean }> {
  for (const candidate of candidates) {
    try {
      const preferences: Preferences = JSON.parse(await readFile(candidate, "utf8"));
      if (!preferences || typeof preferences !== "object" || (preferences.controlPaused !== undefined && typeof preferences.controlPaused !== "boolean") || (preferences.humanPriority !== undefined && typeof preferences.humanPriority !== "boolean")) throw new Error("Invalid control preferences");
      return { paused: preferences.controlPaused === true, humanPriority: preferences.humanPriority === true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { paused: true, humanPriority: true };
    }
  }
  return { paused: false, humanPriority: false };
}
export function writeControlPolicy(state: { paused: boolean; humanPriority: boolean }): Promise<void> {
  return update((preferences) => ({ ...preferences, controlPaused: state.paused, humanPriority: state.humanPriority }));
}

/**
 * Read-modify-write, one at a time, so a display choice saved at the same moment as a pause cannot
 * overwrite it. `change` returns null when nothing needs writing.
 */
let pending: Promise<unknown> = Promise.resolve();
function update(change: (preferences: Preferences) => Preferences | null): Promise<void> {
  const next = pending.then(async () => {
    const changed = change(await read());
    if (changed) await write(changed);
  });
  pending = next.catch(() => undefined);
  return next;
}

/** Writes through a temporary file and a rename, so a concurrent read never sees a half-written file. */
async function write(preferences: Preferences): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, JSON.stringify(preferences, null, 2));
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
