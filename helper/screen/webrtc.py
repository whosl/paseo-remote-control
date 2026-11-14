"""Private stdio-signalled WebRTC worker. No HTTP server and no unauthenticated signalling."""
import asyncio
import fractions
import json
import logging
import os
import signal
import subprocess
import sys
import time

import av
import aiortc.codecs as codecs
from aiortc import MediaStreamTrack, RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCRtpSender, RTCSessionDescription
from aiortc.codecs.h264 import H264Encoder
from aiortc.contrib.media import MediaPlayer

logging.basicConfig(stream=sys.stderr, level=logging.ERROR)
sessions = {}
closing = False


class ScreenH264Encoder(H264Encoder):
    """Screen-oriented encoder for the pinned aiortc 1.16 factory, in this worker only."""

    def __init__(self):
        super().__init__()
        self._bitrate = 1_000_000
        self._maximum = 12_000_000
        self._estimate = None
        self._size = None
        self._desired = 8_000_000
        self._probe_target = 0
        self._probe_after = time.monotonic() + 1
        self._probing = True
        self._loss_ceiling = None
        self._last_loss = 0

    @property
    def target_bitrate(self):
        return self._bitrate

    @target_bitrate.setter
    def target_bitrate(self, bitrate):
        # Preserve receiver REMB feedback, including estimates below the default
        # encoder's 500 kbps floor. More detail must not overwhelm a weak link.
        estimate = max(100_000, int(bitrate))
        if self._estimate is not None and estimate < self._estimate * 0.9:
            self._probing = False
            self._probe_target = 0
        self._estimate = estimate
        self._bitrate = min(max(estimate, self._probe_target), self._maximum, self._loss_ceiling or self._maximum)

    def packet_loss(self, fraction):
        if fraction >= 0.05:
            self._probing = False
            self._probe_target = 0
            self._last_loss = time.monotonic()
            self._loss_ceiling = max(100_000, int(self._bitrate * 0.75))
            self._bitrate = min(self._bitrate, self._loss_ceiling)
        elif self._loss_ceiling is not None and time.monotonic() - self._last_loss >= 10:
            self._loss_ceiling = min(self._maximum, int(self._loss_ceiling * 1.02))

    def _encode_frame(self, frame, force_keyframe):
        size = (frame.width, frame.height)
        if self._size != size:
            self._size = size
            pixels = frame.width * frame.height
            self._maximum = (4_000_000 if pixels <= 1280 * 720 else 8_000_000 if pixels <= 1920 * 1080 else 12_000_000)
            self._desired = (2_000_000 if pixels <= 1280 * 720 else 4_000_000 if pixels <= 1920 * 1080 else 8_000_000)
            # Probe from a conservative startup rate. A high first-frame burst
            # can lose the keyframe on a limited TURN uplink before REMB arrives.
            self._bitrate = min(self._estimate if self._estimate is not None else 1_000_000, self._maximum, self._loss_ceiling or self._maximum)
            self._probe_target = 0
            self._probe_after = time.monotonic() + 1
        # An app-limited receiver estimate can otherwise keep a healthy link at
        # the startup rate forever. Probe by at most 25% once a second; the first
        # meaningful REMB decrease permanently ends probing for this encoder.
        if self._probing and self._bitrate < self._desired and time.monotonic() >= self._probe_after:
            self._probe_target = min(self._desired, self._bitrate * 5 // 4)
            self._bitrate = self._probe_target
            self._probe_after = time.monotonic() + 1
        if self.codec and (self.codec.width != frame.width or self.codec.height != frame.height
                           or abs(self.target_bitrate - self.codec.bit_rate) / self.codec.bit_rate > 0.1):
            self.buffer_data = b""
            self.buffer_pts = None
            self.codec = None
        if self.codec is None:
            self.codec = av.CodecContext.create("libx264", "w")
            self.codec.width, self.codec.height = size
            self.codec.bit_rate = self.target_bitrate
            self.codec.pix_fmt = "yuv420p"
            self.codec.framerate = fractions.Fraction(30, 1)
            self.codec.time_base = fractions.Fraction(1, 30)
            self.codec.thread_count = min(8, os.cpu_count() or 1)
            self.codec.gop_size = 60
            self.codec.max_b_frames = 0
            macroblocks = ((frame.width + 15) // 16) * ((frame.height + 15) // 16)
            level = "3.1" if macroblocks <= 3600 else "4.0" if macroblocks <= 8192 else "5.0" if macroblocks <= 22080 else "5.2"
            self.codec.options = {"preset": "veryfast", "tune": "zerolatency", "level": level}
            self.codec.profile = "Baseline"
        return super()._encode_frame(frame, force_keyframe)


# RTCRtpSender imports get_encoder, whose globals resolve this class on demand.
# No installed library files or other Paseo processes are modified.
codecs.H264Encoder = ScreenH264Encoder


class VideoPacer:
    """Bounded RTP pacing; backpressure keeps LatestVideo from queuing old frames."""

    def __init__(self, sender):
        self.sender = sender
        self.send = sender.transport._send_rtp
        self.lock = asyncio.Lock()
        self.deadline = 0

    def encoder(self):
        # The encoder factory and this adapter are tested against the pinned 1.16.
        return getattr(self.sender, "_RTCRtpSender__encoder", None)

    async def send_rtp(self, data):
        if len(data) > 1 and 192 <= data[1] <= 223:
            return await self.send(data)  # RTCP must not wait behind video.
        async with self.lock:
            loop = asyncio.get_running_loop()
            delay = self.deadline - loop.time()
            if delay > 0:
                await asyncio.sleep(delay)
            await self.send(data)
            encoder = self.encoder()
            rate = encoder.target_bitrate if isinstance(encoder, ScreenH264Encoder) else 1_000_000
            self.deadline = max(self.deadline, loop.time() - 0.003) + (len(data) + 64) * 8 / (rate * 1.1)


async def watch_loss(state):
    pacer = state.get("pacer")
    if pacer is None:
        return
    encoder = pacer.encoder()
    if not isinstance(encoder, ScreenH264Encoder):
        return
    for report in (await state["sender"].getStats()).values():
        if report.type == "remote-inbound-rtp" and report.timestamp != state.get("loss_report"):
            state["loss_report"] = report.timestamp
            # aiortc 1.16 exposes the RTCP wire fraction (0..255), not a float ratio.
            encoder.packet_loss(report.fractionLost / 256)


def capture_filter(width, fps):
    # Quantize to time slots instead of requiring a full floating-point period
    # since the last frame. Capture jitter otherwise turns 30 fps into ~20 fps.
    return f"select='isnan(prev_selected_t)+gt(floor(t*{fps}),floor(prev_selected_t*{fps}))',scale={width}:-2"


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
        filter_string = capture_filter(width, fps)
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
        state["sender"] = sender
        pacer = state["pacer"] = VideoPacer(sender)
        sender.transport._send_rtp = pacer.send_rtp
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
        await asyncio.sleep(1)
        for session, state in list(sessions.items()):
            try:
                await watch_loss(state)
            except Exception:
                pass  # A stats read must not disable idle-session cleanup.
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
