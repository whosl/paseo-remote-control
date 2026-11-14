import { createHmac, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { VideoIceConfiguration } from "../../shared/screen/rpc";

const stun = z.string().max(512).regex(/^stuns?:[^\s/]+$/);
const turn = z.string().max(512).regex(/^turns?:[^\s/]+$/);
const settings = z.object({
  stunUrls: z.array(stun).max(8).default([]),
  turnUrls: z.array(turn).min(1).max(8),
  hostTurnUrl: turn.optional(),
  sharedSecret: z.string().min(32).max(256),
  ttlSeconds: z.number().int().min(300).max(86400).default(3600),
}).refine(value => !value.hostTurnUrl || value.turnUrls.includes(value.hostTurnUrl));

/** Only expiring credentials cross the authenticated RPC; the shared key stays on the host. */
export async function readVideoIceConfiguration(options: { file?: string; now?: number; suffix?: string; role?: "viewer" | "host" } = {}): Promise<VideoIceConfiguration> {
  const file = options.file ?? process.env.PASEO_REMOTE_CONTROL_RTC_CONFIG ?? path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "paseo-remote-control", "webrtc.json");
  let raw: string;
  try {
    const info = await stat(file);
    if (info.size > 16384) throw new Error("Video relay configuration is too large");
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("Video relay configuration must be private (mode 0600)");
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { iceServers: [], iceTransportPolicy: "all" };
    throw error;
  }
  let parsed: z.infer<typeof settings>;
  try { parsed = settings.parse(JSON.parse(raw)); }
  catch { throw new Error("Video relay configuration is invalid"); }
  const expiresAt = Math.floor((options.now ?? Date.now()) / 1000) + parsed.ttlSeconds;
  const username = `${expiresAt}:paseo-${options.suffix ?? randomBytes(12).toString("hex")}`;
  const credential = createHmac("sha1", parsed.sharedSecret).update(username).digest("base64");
  return {
    iceTransportPolicy: "all",
    iceServers: [
      ...(parsed.stunUrls.length ? [{ urls: parsed.stunUrls }] : []),
      // aiortc uses one TURN URL, while browsers gather from all configured URLs.
      { urls: options.role === "host" && parsed.hostTurnUrl ? [parsed.hostTurnUrl] : parsed.turnUrls, username, credential },
    ],
  };
}
