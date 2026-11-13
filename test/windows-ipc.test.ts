import net from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ComputerUseSocketListener } from "../server/computer-use-mcp/mcp/socket-listener";
import type { ComputerUseMcpServer } from "../server/computer-use-mcp/mcp/server";

async function check(auth: "valid" | "wrong" | "missing" | "oversized") {
  const dir = mkdtempSync(path.join(tmpdir(), "rc-ipc-"));
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\rc-test-${randomUUID()}` : path.join(dir, "s");
  let created = 0;
  const token = randomUUID();
  const listener = new ComputerUseSocketListener({ socketPath: endpoint, authToken: token, createServerForClient: () => {
    created++;
    return { handleMessage: async () => ({ jsonrpc: "2.0", id: 1, result: { ok: true } }) } as unknown as ComputerUseMcpServer;
  } });
  const socket = new net.Socket();
  try {
    await listener.start();
    const response = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("IPC test timed out")), 2500);
      let text = "";
      socket.on("data", data => { text += String(data); clearTimeout(timer); resolve(text); });
      socket.on("close", () => { clearTimeout(timer); resolve(text); });
      socket.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (auth !== "valid" && ["EPIPE", "ECONNRESET"].includes(error.code ?? "")) resolve(text);
        else reject(error);
      });
      socket.connect(endpoint, () => {
        if (auth === "oversized") { socket.write("x".repeat(17 * 1024)); return; }
        if (auth !== "missing") socket.write(JSON.stringify({ hello: { clientId: "fixture", authToken: auth === "valid" ? token : "wrong" } }) + "\n");
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
      });
    });
    return { response, created };
  } finally { socket.destroy(); await listener.stop(); rmSync(dir, { recursive: true, force: true }); }
}

describe("Authenticated local MCP IPC", () => {
  it("refuses a wrong token before constructing a tool server", async () => { expect(await check("wrong")).toEqual({ response: "", created: 0 }); });
  it("refuses requests without an authenticated hello", async () => { expect(await check("missing")).toEqual({ response: "", created: 0 }); });
  it("bounds unauthenticated IPC buffering", async () => { expect(await check("oversized")).toEqual({ response: "", created: 0 }); });
  it("accepts an authenticated provider shim", async () => { const r = await check("valid"); expect(r.created).toBe(1); expect(JSON.parse(r.response).result).toEqual({ ok: true }); });
});
