import { createHmac } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readVideoIceConfiguration } from "../server/screen/video-config";

const directories: string[] = [];
async function fixture(data?: unknown) {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-video-config-")); directories.push(directory);
  const file = path.join(directory, "webrtc.json");
  if (data !== undefined) await writeFile(file, typeof data === "string" ? data : JSON.stringify(data), { mode: 0o600 });
  return file;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const settings = { stunUrls: ["stun:turn.example.com:3478"], turnUrls: ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:443?transport=tcp"], sharedSecret: "private-host-key-that-must-not-cross-rpc", ttlSeconds: 3600 };

describe("TURN host configuration", () => {
  it("keeps direct viewing available when no relay is provisioned", async () => {
    expect(await readVideoIceConfiguration({ file: await fixture() })).toEqual({ iceServers: [], iceTransportPolicy: "all" });
  });
  it("issues Coturn REST credentials with expiry, without exposing the signing key", async () => {
    const config = await readVideoIceConfiguration({ file: await fixture(settings), now: 1_800_000_000_000, suffix: "fixture" });
    const username = "1800003600:paseo-fixture";
    expect(config.iceTransportPolicy).toBe("all");
    expect(config.iceServers).toEqual([{ urls: settings.stunUrls }, { urls: settings.turnUrls, username, credential: createHmac("sha1", settings.sharedSecret).update(username).digest("base64") }]);
    expect(JSON.stringify(config)).not.toContain(settings.sharedSecret);
  });
  it("gives independent clients distinct credentials", async () => {
    const file = await fixture(settings);
    const a = await readVideoIceConfiguration({ file }), b = await readVideoIceConfiguration({ file });
    expect(a.iceServers[1]?.username).not.toBe(b.iceServers[1]?.username);
    expect(a.iceServers[1]?.credential).not.toBe(b.iceServers[1]?.credential);
  });
  it("can select a tested TURN transport for aiortc while retaining browser alternatives", async () => {
    const hostTurnUrl = settings.turnUrls[1];
    const file = await fixture({ ...settings, hostTurnUrl });
    expect((await readVideoIceConfiguration({ file, role: "host" })).iceServers[1]?.urls).toEqual([hostTurnUrl]);
    expect((await readVideoIceConfiguration({ file })).iceServers[1]?.urls).toEqual(settings.turnUrls);
    await expect(readVideoIceConfiguration({ file: await fixture({ ...settings, hostTurnUrl: "turn:unlisted.example:3478" }) })).rejects.toThrow("configuration is invalid");
  });
  it("rejects invalid files without including secret values in diagnostics", async () => {
    for (const data of ["{broken", { ...settings, turnUrls: ["https://private.example/"] }, { ...settings, sharedSecret: "short-private-key" }, { ...settings, ttlSeconds: 1 }]) {
      await expect(readVideoIceConfiguration({ file: await fixture(data) })).rejects.toThrow("Video relay configuration is invalid");
    }
  });
  it("rejects oversized configuration", async () => {
    await expect(readVideoIceConfiguration({ file: await fixture("a".repeat(16385)) })).rejects.toThrow("too large");
  });
  it.skipIf(process.platform === "win32")("refuses world-readable signing keys", async () => {
    const file = await fixture(settings); await chmod(file, 0o644);
    await expect(readVideoIceConfiguration({ file })).rejects.toThrow("mode 0600");
  });
});
