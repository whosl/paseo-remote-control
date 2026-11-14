"""Private stdio-signalled WebRTC worker. No HTTP server and no unauthenticated signalling."""
import asyncio
import json
import logging
import os
import signal
import subprocess
import sys
import time

from aiortc import MediaStreamTrack, RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCRtpSender, RTCSessionDescription
from aiortc.contrib.media import MediaPlayer

logging.basicConfig(stream=sys.stderr, level=logging.ERROR)
sessions = {}
closing = False


class LatestVideo(MediaStreamTrack):
    kind = "video"

    def __init__(self, source):
        super().__init__()
        self.source = source
        self.latest = None
        self.changed = asyncio.Event()
        self.pump = asyncio.create_task(self.read())

    async def read(self):
        try:
            while True:
                self.latest = await self.source.recv()
                self.changed.set()
        except Exception:
            self.stop()

    async def recv(self):
        await self.changed.wait()
        self.changed.clear()
        if self.latest is None:
            from aiortc.mediastreams import MediaStreamError
            raise MediaStreamError
        return self.latest

    def stop(self):
        super().stop()
        self.latest = None
        self.changed.set()
        if self.pump is not asyncio.current_task():
            self.pump.cancel()


async def stop(session):
    state = sessions.pop(session, None)
    if state is None:
        return
    # Unblock PyAV's pipe reader before stopping its track / joining its worker thread.
    process = state.get("capture")
    if process is not None and process.poll() is None:
        process.kill()
        await asyncio.to_thread(process.wait)
    track = state.get("track")
    if track is not None:
        track.stop()
    player = state.get("player")
    if player is not None and player.video is not None:
        player.video.stop()
    await state["pc"].close()


async def offer(message):
    session = message["session"]
    if len(sessions) >= 2:
        raise RuntimeError("Two direct screen viewers are already active; use the Paseo fallback")
    pc = RTCPeerConnection(RTCConfiguration(iceServers=[RTCIceServer(**server) for server in message.get("iceServers", [])]))
    state = {"pc": pc, "at": time.monotonic()}
    sessions[session] = state

    @pc.on("connectionstatechange")
    async def changed():
        if pc.connectionState in ("failed", "closed"):
            await stop(session)

    try:
        await pc.setRemoteDescription(RTCSessionDescription(sdp=message["sdp"], type="offer"))
        width, fps = int(message["width"]), int(message["fps"])
        filter_string = f"select='isnan(prev_selected_t)+gte(t-prev_selected_t,{1 / fps})',scale={width}:-2"
        process = subprocess.Popen([
            message["recorder"], "-o", message["output"], "--no-dmabuf", "-c", "rawvideo", "-m", "nut",
            "-F", filter_string, "-x", "yuv420p", "-f", "pipe:1",
        ], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        state["capture"] = process
        # Raw YUV frames go straight to the WebRTC encoder: no JPEG encode/decode round trip.
        player = await asyncio.to_thread(MediaPlayer, process.stdout, format="nut", options={"probesize": "32", "analyzeduration": "0"})
        state["player"] = player
        if session not in sessions:
            if player.video is not None:
                player.video.stop()
            raise RuntimeError("Screen session was cancelled")
        if player.video is None:
            raise RuntimeError("The native capture returned no video track")
        track = LatestVideo(player.video)
        state["track"] = track
        sender = pc.addTrack(track)
        codecs = [codec for codec in RTCRtpSender.getCapabilities("video").codecs if codec.mimeType.lower() == "video/h264"]
        for transceiver in pc.getTransceivers():
            if transceiver.sender is sender:
                transceiver.setCodecPreferences(codecs)
        await pc.setLocalDescription(await pc.createAnswer())
        return {"session": session, "sdp": pc.localDescription.sdp}
    except BaseException:
        await stop(session)
        raise


async def dispatch(message):
    method = message["method"]
    if method == "offer":
        return await asyncio.wait_for(offer(message), timeout=12)
    if method == "ping":
        state = sessions.get(message["session"])
        if state is None:
            raise RuntimeError("Direct screen session has ended")
        state["at"] = time.monotonic()
        return {}
    if method == "stop":
        await stop(message["session"])
        return {}
    raise RuntimeError("Unknown direct screen command")


async def handle(message):
    try:
        result = await dispatch(message)
        response = {"id": message["id"], "result": result}
    except Exception as error:
        response = {"id": message.get("id"), "error": str(error)}
    print(json.dumps(response, separators=(",", ":")), flush=True)


async def reap():
    while not closing:
        await asyncio.sleep(2)
        for session, state in list(sessions.items()):
            capture = state.get("capture")
            if time.monotonic() - state["at"] > 15 or (capture is not None and capture.poll() is not None):
                await stop(session)


async def main():
    global closing
    loop = asyncio.get_running_loop()
    end = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, end.set)
    reader = asyncio.StreamReader(limit=128 * 1024)
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    tasks = set()
    reaper = asyncio.create_task(reap())

    async def read_commands():
        while not end.is_set():
            line = await reader.readline()
            if not line:
                end.set()
                return
            try:
                task = asyncio.create_task(handle(json.loads(line)))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
            except (ValueError, KeyError):
                pass

    commands = asyncio.create_task(read_commands())
    await end.wait()
    closing = True
    commands.cancel()
    reaper.cancel()
    for task in list(tasks):
        task.cancel()
    await asyncio.gather(*list(tasks), return_exceptions=True)
    await asyncio.gather(*(stop(session) for session in list(sessions)), return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())
