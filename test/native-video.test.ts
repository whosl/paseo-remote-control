import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeVideoCommandJson, nativeVideoEvent, NativeVideoSession, type NativeVideoCommand, type NativeVideoState } from "../client/viewer/native-video-session";
import { nativeVideoDocument } from "../client/viewer/native-video-html";

const nonce = "fixture-video";
const event = (type: string, sequence = 1, extra: Record<string, unknown> = {}) => `https://paseo-rtc.invalid/#paseo-rtc=${encodeURIComponent(JSON.stringify({ nonce, type, sequence, ...extra }))}`;
const settle = () => Promise.resolve();
function setup(offer = vi.fn(async () => ({ session: "session-A", sdp: "answer" }))) {
  const signalling = { offer, ping: vi.fn(async () => ({})), stop: vi.fn(async () => ({})) };
  const commands: NativeVideoCommand[] = [], states: NativeVideoState[] = [];
  const session = new NativeVideoSession(nonce, { display: 1, maxWidth: 1280, fps: 24 }, signalling, command => commands.push(command), state => states.push(state));
  return { session, signalling, commands, states };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Android video session", () => {
  it("negotiates over Paseo and only becomes active after the first decoded frame", async () => {
    const h = setup();
    h.session.receive(event("offer", 1, { sdp: "offer" })); await settle();
    expect(h.signalling.offer).toHaveBeenCalledWith({ display: 1, maxWidth: 1280, fps: 24, sdp: "offer" });
    expect(h.commands).toEqual([{ nonce, answer: "answer" }]);
    expect(h.states.at(-1)?.active).toBe(false);
    h.session.receive(event("ready", 2, { width: 1280, height: 720 }));
    expect(h.states.at(-1)?.active).toBe(true);
    h.session.receive(event("stats", 3, { fps: 23.8, kbps: 1500, rttMs: 7 }));
    expect(h.states.at(-1)).toMatchObject({ fps: 23.8, kbps: 1500, rttMs: 7 });
    await vi.advanceTimersByTimeAsync(3000); expect(h.signalling.ping).toHaveBeenCalledTimes(1);
    h.session.stop(); expect(h.signalling.stop).toHaveBeenCalledWith({ session: "session-A" });
  });

  it("refuses stale views, replayed events, unsolicited ready events and duplicate offers", async () => {
    const h = setup();
    h.session.receive(event("ready", 1, { width: 1280, height: 720 }));
    expect(h.states.at(-1)?.active).toBe(false);
    h.session.receive(event("offer", 2, { nonce: "another-view", sdp: "wrong" }));
    h.session.receive(event("offer", 1, { sdp: "replayed" }));
    expect(h.signalling.offer).not.toHaveBeenCalled();
    h.session.receive(event("offer", 2, { sdp: "offer" }));
    h.session.receive(event("offer", 3, { sdp: "duplicate" }));
    await settle(); expect(h.signalling.offer).toHaveBeenCalledTimes(1); h.session.stop();
  });

  it("closes a late server answer after pause/unmount instead of starting playback", async () => {
    let resolve!: (answer: { session: string; sdp: string }) => void;
    const h = setup(vi.fn(() => new Promise(r => { resolve = r; })));
    h.session.receive(event("offer", 1, { sdp: "offer" })); h.session.stop();
    resolve({ session: "late", sdp: "late-answer" }); await settle();
    expect(h.signalling.stop).toHaveBeenCalledWith({ session: "late" });
    expect(h.commands).toEqual([{ nonce, stop: true }]);
    await vi.advanceTimersByTimeAsync(20_000); expect(h.signalling.ping).not.toHaveBeenCalled();
  });

  it("returns to JPEG if negotiation fails", async () => {
    const h = setup(vi.fn(async () => { throw new Error("Host unavailable"); }));
    h.session.receive(event("offer", 1, { sdp: "offer" })); await settle();
    expect(h.states.at(-1)).toMatchObject({ active: false, connecting: false, reason: "Host unavailable; using Paseo frames." });
    expect(h.commands.at(-1)?.stop).toBe(true);
  });

  it("times out a silent WebView and ignores later messages", async () => {
    const h = setup(); await vi.advanceTimersByTimeAsync(25_000);
    expect(h.states.at(-1)?.reason).toContain("did not arrive");
    h.session.receive(event("offer", 1, { sdp: "late" }));
    expect(h.signalling.offer).not.toHaveBeenCalled();
  });

  it("falls back when a server heartbeat fails and stops only once", async () => {
    const h = setup(); h.signalling.ping.mockRejectedValue(new Error("lost"));
    h.session.receive(event("offer", 1, { sdp: "offer" })); await settle();
    await vi.advanceTimersByTimeAsync(3000); h.session.stop();
    expect(h.signalling.stop).toHaveBeenCalledTimes(1);
    expect(h.states.at(-1)?.reason).toContain("session ended");
  });

  it("ignores invalid statistics without disturbing a playing video", async () => {
    const h = setup(); h.session.receive(event("offer", 1, { sdp: "offer" })); await settle();
    h.session.receive(event("ready", 2, { width: 1280, height: 720 }));
    h.session.receive(event("stats", 3, { fps: -1, kbps: 100 }));
    h.session.receive(event("stats", 4, { fps: "NaN", kbps: 100 }));
    expect(h.states.at(-1)).toMatchObject({ active: true, fps: 0 }); h.session.stop();
  });
});

describe("native WebView bridge", () => {
  it("accepts only bounded messages from its own local document", () => {
    expect(nativeVideoEvent(event("offer"), nonce)?.type).toBe("offer");
    for (const url of ["https://evil.invalid/#paseo-rtc={}", "file:///secret", event("offer").replace(nonce, "wrong"), "https://paseo-rtc.invalid/#paseo-rtc=%", event("offer", -1), event("offer", 1, { sdp: "a".repeat(200_000) })]) expect(nativeVideoEvent(url, nonce)).toBeNull();
  });

  it("round trips SDP line endings and template syntax through Android's native injection", () => {
    const command = { nonce, answer: "v=0\r\na=example:` ${doNotEvaluate()} \\ end\r\n" };
    const encoded = nativeVideoCommandJson(command);
    const returned = runInNewContext("`" + encoded + "`");
    expect(JSON.parse(returned)).toEqual(command);
  });

  it("assembles bounded title packets, acknowledges duplicates and preserves the SDP answer", async () => {
    const h = setup();
    const encoded = encodeURIComponent(JSON.stringify({ nonce, type: "offer", sequence: 1, sdp: "offer".repeat(1500) }));
    const total = Math.ceil(encoded.length / 1000);
    for (let index = 0; index < total; index++) {
      const title = `paseo-rtc:${nonce}:${index + 1}:1:${index}:${total}:${encoded.slice(index * 1000, (index + 1) * 1000)}`;
      h.session.receive("data:text/html;charset=utf-8;base64,", title);
      h.session.receive("data:text/html;charset=utf-8;base64,", title);
    }
    await settle();
    expect(h.signalling.offer).toHaveBeenCalledTimes(1);
    expect(h.commands.at(-1)).toEqual({ nonce, ack: total, answer: "answer" });
    h.session.receive("data:", `paseo-rtc:${nonce}:${total}:1:${total - 1}:${total}:${encoded.slice((total - 1) * 1000)}`);
    expect(h.commands.at(-1)?.answer).toBe("answer"); h.session.stop();
  });

  it("ignores malformed, oversized and out-of-order title packets", () => {
    const h = setup();
    for (const title of [`paseo-rtc:wrong:1:1:0:1:x`, `paseo-rtc:${nonce}:1:1:1:2:x`, `paseo-rtc:${nonce}:1:1:0:201:x`, `paseo-rtc:${nonce}:1:1:0:1:${"x".repeat(1001)}`]) h.session.receive("data:", title);
    expect(h.commands).toEqual([]); expect(h.signalling.offer).not.toHaveBeenCalled(); h.session.stop();
  });

  it("negotiates the production document across native title events and injected properties", async () => {
    const h = setup();
    let command: NativeVideoCommand = { nonce };
    const video = { readyState: 2, videoWidth: 1280, videoHeight: 720, srcObject: null, onloadeddata: () => {}, onerror: () => {}, play: async () => {}, pause: vi.fn() };
    const canvas = { width: 0, height: 0, style: { display: "none" }, getContext: () => ({ drawImage: vi.fn() }) };
    const document = { title: "", querySelector: (tag: string) => tag === "video" ? video : canvas };
    const close = vi.fn();
    class Peer {
      constructor(configuration: unknown) { expect(JSON.parse(JSON.stringify(configuration))).toEqual(ice); }
      iceGatheringState = "complete"; connectionState = "connected";
      localDescription = { type: "offer", sdp: "v=0\r\n" + "a=example\r\n".repeat(1000) };
      ontrack = (_event: unknown) => {}; onconnectionstatechange = () => {};
      addTransceiver() { return { setCodecPreferences() {} }; }
      async createOffer() { return this.localDescription; }
      async setLocalDescription() {}
      async setRemoteDescription(value: { sdp: string }) { expect(value.sdp).toBe("answer"); video.onloadeddata(); }
      async getStats() { return new Map<string, Record<string, unknown>>([
        ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
        ["pair", { id: "pair", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "local", remoteCandidateId: "remote" }],
        ["local", { candidateType: "relay" }], ["remote", { candidateType: "host" }],
      ]); }
      close = close;
    }
    // Drive the same native session, then mirror its injected command property into the document.
    const session = new NativeVideoSession(nonce, { display: 1, maxWidth: 1280, fps: 24 }, h.signalling, value => { command = value; }, value => h.states.push(value));
    const ice = { iceServers: [{ urls: ["turns:turn.example.com:443?transport=tcp"], username: "expiring-viewer", credential: "ephemeral-password" }], iceTransportPolicy: "all" as const };
    const html = nativeVideoDocument(nonce, ice);
    runInNewContext(html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>")), {
      document, history: { replaceState: () => session.receive("data:text/html;charset=utf-8;base64,", document.title) },
      window: { ReactNativeWebView: { injectedObjectJson: () => JSON.stringify(command) } },
      RTCPeerConnection: Peer, RTCRtpReceiver: { getCapabilities: () => ({ codecs: [{ mimeType: "video/H264" }] }) },
      MediaStream: class {}, addEventListener() {}, performance, setTimeout, clearTimeout, setInterval, clearInterval, Error,
    });
    await vi.advanceTimersByTimeAsync(4500);
    expect(h.signalling.offer).toHaveBeenCalledTimes(1);
    expect(h.states.at(-1)?.active).toBe(true);
    expect(h.states.at(-1)?.relay).toBe(true);
    session.stop(); await vi.advanceTimersByTimeAsync(50);
    expect(close).toHaveBeenCalledTimes(1); expect(canvas.style.display).toBe("block"); h.session.stop();
  });

  it("uses an inline receive-only document without remote assets or an app-wide messaging override", () => {
    const html = nativeVideoDocument(nonce);
    expect(html).toContain("direction:'recvonly'");
    expect(html).toContain("video/h264");
    expect(html).toContain("history.replaceState");
    expect(html).not.toContain("getUserMedia");
    expect(html).not.toContain("postMessage");
    expect(nativeVideoDocument("</script><script>evil()")).not.toContain("</script><script>evil()");
  });
});
