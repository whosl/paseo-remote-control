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
import secrets
import struct
import threading
import select
import weakref

import av
import aiortc.codecs as codecs
from aiortc import MediaStreamTrack, RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCRtpSender, RTCSessionDescription
from aiortc.codecs.h264 import H264Encoder
from aiortc.contrib.media import MediaPlayer

logging.basicConfig(stream=sys.stderr, level=logging.ERROR)
sessions = {}
closing = False
windows_timer = False
output_lock = threading.Lock()
vaapi_encoders = weakref.WeakSet()


def emit(message):
    # Encoder notifications originate on aiortc's executor thread. Keep them
    # from interleaving with an SDP response on the private stdio transport.
    with output_lock:
        print(json.dumps(message, separators=(",", ":")), flush=True)


def video_timer(enable):
    global windows_timer
    if sys.platform != "win32" or enable == windows_timer:
        return
    import ctypes
    if enable:
        windows_timer = ctypes.windll.winmm.timeBeginPeriod(1) == 0
    else:
        ctypes.windll.winmm.timeEndPeriod(1)
        windows_timer = False


class VaapiCodec:
    """Framed private pipes isolate the system VA-API libraries from PyAV's FFmpeg ABI."""
    name = "h264_vaapi"
    has_b_frames = False
    framerate = fractions.Fraction(30, 1)
    thread_count = 1
    io_timeout = 3

    def __init__(self, size, bitrate):
        self.width, self.height = size
        self.bit_rate = bitrate
        self.process = None
        try:
            binary = os.environ["PASEO_REMOTE_CONTROL_VAAPI_ENCODER"]
            device = os.environ.get("PASEO_REMOTE_CONTROL_VAAPI_DEVICE", "/dev/dri/renderD128")
            options = {"stdin": subprocess.PIPE, "stdout": subprocess.PIPE, "stderr": subprocess.DEVNULL, "bufsize": 0}
            try:
                self.process = subprocess.Popen([binary, device], **options, pipesize=1024 * 1024)
            except PermissionError:
                self.process = subprocess.Popen([binary, device], **options)
            os.set_blocking(self.process.stdin.fileno(), False)
            os.set_blocking(self.process.stdout.fileno(), False)
            if self._read(4, time.monotonic() + self.io_timeout) != b"PVA1":
                raise RuntimeError("Invalid VA-API helper protocol")
            vaapi_encoders.add(self)
        except BaseException:
            self.close()
            raise

    def _read(self, count, deadline):
        result = bytearray()
        fd = self.process.stdout.fileno()
        while len(result) < count:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
                raise TimeoutError("VA-API encoder timed out")
            try:
                chunk = os.read(fd, count - len(result))
            except BlockingIOError:
                continue
            if not chunk:
                raise RuntimeError("VA-API encoder disconnected")
            result.extend(chunk)
        return bytes(result)

    def _write(self, data, deadline):
        pending = memoryview(data)
        fd = self.process.stdin.fileno()
        while pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([], [fd], [], remaining)[1]:
                raise TimeoutError("VA-API encoder timed out")
            try:
                sent = os.write(fd, pending)
            except BlockingIOError:
                continue
            if not sent:
                raise RuntimeError("VA-API encoder disconnected")
            pending = pending[sent:]

    def encode(self, frame):
        image = frame.reformat(format="nv12")
        deadline = time.monotonic() + self.io_timeout
        pts = int(frame.pts * frame.time_base * 90000)
        self._write(struct.pack("<IIIIq", self.width, self.height, self.bit_rate, int(frame.pict_type == av.video.frame.PictureType.I), pts), deadline)
        for index, plane in enumerate(image.planes):
            rows = self.height if index == 0 else self.height // 2
            pixels = memoryview(plane)
            if plane.line_size == self.width:
                self._write(pixels[:rows * self.width], deadline)
            else:
                for row in range(rows):
                    self._write(pixels[row * plane.line_size:row * plane.line_size + self.width], deadline)
        size = struct.unpack("<i", self._read(4, deadline))[0]
        if size < 0 or size > 32 * 1024 * 1024:
            raise RuntimeError("VA-API encoder refused the frame")
        return [av.Packet(self._read(size, deadline))] if size else []

    def close(self):
        process, self.process = getattr(self, "process", None), None
        if process is not None:
            if process.poll() is None:
                process.kill()
            try:
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass  # A stuck kernel device must not prevent software fallback.
            process.stdin.close()
            process.stdout.close()

    def __del__(self):
        self.close()


class ScreenH264Encoder(H264Encoder):
    """Screen-oriented encoder for the pinned aiortc 1.16 factory, in this worker only."""

    def __init__(self, prefer_hardware=None, hardware_backend=None):
        super().__init__()
        self._hardware = (sys.platform == "win32" or bool(os.environ.get("PASEO_REMOTE_CONTROL_VAAPI_ENCODER"))) if prefer_hardware is None else prefer_hardware
        self._hardware_backend = hardware_backend or ("h264_vaapi" if sys.platform == "linux" and os.environ.get("PASEO_REMOTE_CONTROL_VAAPI_ENCODER") else "h264_nvenc")
        self._hardware_failed = False
        self._reported_backend = None
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
        if fraction >= (0.02 if sys.platform == "win32" else 0.05):
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
        if self.codec and self.codec.name in ("h264_nvenc", "h264_vaapi"):
            # FFmpeg's NVENC wrapper reconfigures supported dynamic rate control
            # from AVCodecContext.bit_rate on the next frame. Avoid reopening a
            # GPU session for every REMB update (which stalls for ~200 ms).
            self.codec.bit_rate = self.target_bitrate
        if self.codec and (self.codec.width != frame.width or self.codec.height != frame.height
                           or abs(self.target_bitrate - self.codec.bit_rate) / self.codec.bit_rate > 0.1):
            self.buffer_data = b""
            self.buffer_pts = None
            if isinstance(self.codec, VaapiCodec):
                self.codec.close()
            self.codec = None
        if self.codec is None:
            try:
                self.codec = self._create_codec(self._hardware_backend if self._hardware and not self._hardware_failed else "libx264", size)
            except Exception:
                if not self._hardware or self._hardware_failed:
                    raise
                self._hardware_failed = True
                self.codec = self._create_codec("libx264", size)
        try:
            yield from super()._encode_frame(frame, force_keyframe)
        except Exception:
            if self.codec is None or self.codec.name not in ("h264_nvenc", "h264_vaapi"):
                raise
            # Driver/session exhaustion and device loss must not end the viewer.
            # Start a fresh software stream with an IDR on the same input frame.
            self._hardware_failed = True
            if isinstance(self.codec, VaapiCodec):
                self.codec.close()
            self.codec = None
            self.buffer_data, self.buffer_pts = b"", None
            self.codec = self._create_codec("libx264", size)
            yield from super()._encode_frame(frame, True)
        if self._reported_backend != self.codec.name:
            self._reported_backend = self.codec.name
            emit({"event": "encoder", "backend": self.codec.name, "fallback": self._hardware_failed})

    def _create_codec(self, name, size):
        if name == "h264_vaapi":
            return VaapiCodec(size, self.target_bitrate)
        codec = av.CodecContext.create(name, "w")
        codec.width, codec.height = size
        codec.bit_rate = self.target_bitrate
        codec.pix_fmt = "yuv420p"
        codec.framerate = fractions.Fraction(30, 1)
        codec.time_base = fractions.Fraction(1, 30)
        codec.thread_count = min(8, os.cpu_count() or 1)
        codec.gop_size = 60
        codec.max_b_frames = 0
        macroblocks = ((size[0] + 15) // 16) * ((size[1] + 15) // 16)
        level = "3.1" if macroblocks <= 3600 else "4.0" if macroblocks <= 8192 else "5.0" if macroblocks <= 22080 else "5.2"
        codec.options = ({"preset": "p4", "tune": "ull", "rc": "cbr", "zerolatency": "1", "delay": "0", "rc-lookahead": "0", "forced-idr": "1", "profile": "baseline", "level": level}
                         if name == "h264_nvenc" else {"preset": "veryfast", "tune": "zerolatency", "level": level})
        codec.profile = "Baseline"
        codec.open()  # Missing drivers and unsupported devices fail before media is sent.
        return codec


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
            # Leave room for encoding time and frame-size variation. The media
            # budget/loss controller sets the average rate; pacing smooths bursts.
            self.deadline = max(self.deadline, loop.time() - 0.003) + (len(data) + 64) * 8 / (rate * 1.5)


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


class WindowsVideo(MediaStreamTrack):
    """One bounded raw BGRA feed from the interactive, identity-checking helper."""
    kind = "video"

    def __init__(self, width, height):
        super().__init__()
        if not (2 <= width <= 2560 and 2 <= height <= 8192 and width % 2 == height % 2 == 0):
            raise ValueError("Invalid raw video dimensions")
        self.width, self.height = width, height
        self.token = secrets.token_hex(32)
        self.reader = None
        self.writer = None
        self.server = None
        self.ready = asyncio.Event()
        self.claimed = False

    async def accept(self, reader, writer):
        try:
            token = await asyncio.wait_for(reader.readuntil(b"\n"), 2)
            if self.claimed or not secrets.compare_digest(token, (self.token + "\n").encode()):
                return
            self.claimed = True
            self.reader, self.writer = reader, writer
            self.server.close()
            self.ready.set()
            return
        except Exception:
            pass
        finally:
            if writer is not self.writer:
                writer.close()

    async def recv(self):
        from aiortc.mediastreams import MediaStreamError
        try:
            await asyncio.wait_for(self.ready.wait(), 5)
            if self.readyState != "live":
                raise MediaStreamError
            timestamp = struct.unpack("<q", await asyncio.wait_for(self.reader.readexactly(8), 5))[0]
            raw = await asyncio.wait_for(self.reader.readexactly(self.width * self.height * 4), 5)
            image = av.VideoFrame(self.width, self.height, "bgra")
            plane = image.planes[0]
            row_bytes = self.width * 4
            if plane.line_size == row_bytes:
                plane.update(raw)
            else:
                padded = bytearray(plane.buffer_size)
                for row in range(self.height):
                    padded[row * plane.line_size:row * plane.line_size + row_bytes] = raw[row * row_bytes:(row + 1) * row_bytes]
                plane.update(padded)
            image.pts, image.time_base = timestamp, fractions.Fraction(1, 90000)
            return image
        except (Exception, asyncio.CancelledError):
            self.stop()
            raise MediaStreamError

    def stop(self):
        super().stop()
        if self.server is not None:
            self.server.close()
        if self.writer is not None:
            self.writer.close()
        self.ready.set()


async def prepare_windows(message):
    if len(sessions) >= 2:
        raise RuntimeError("Two direct screen viewers are already active; use the Paseo fallback")
    source = WindowsVideo(int(message["width"]), int(message["height"]))
    source.server = await asyncio.start_server(source.accept, "127.0.0.1", 0, limit=128)
    sessions[message["session"]] = {"source": source, "at": time.monotonic(), "pc": None}
    video_timer(True)
    return {"port": source.server.sockets[0].getsockname()[1], "token": source.token}


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
    source = state.get("source")
    if source is not None:
        source.stop()
    player = state.get("player")
    if player is not None and player.video is not None:
        player.video.stop()
    if state["pc"] is not None:
        await state["pc"].close()
    if not any("source" in item for item in sessions.values()):
        video_timer(False)


async def offer(message):
    session = message["session"]
    if session not in sessions and len(sessions) >= 2:
        raise RuntimeError("Two direct screen viewers are already active; use the Paseo fallback")
    pc = RTCPeerConnection(RTCConfiguration(iceServers=[RTCIceServer(**server) for server in message.get("iceServers", [])]))
    state = sessions.get(session, {})
    state.update({"pc": pc, "at": time.monotonic()})
    sessions[session] = state

    @pc.on("connectionstatechange")
    async def changed():
        if pc.connectionState in ("failed", "closed"):
            await stop(session)

    try:
        await pc.setRemoteDescription(RTCSessionDescription(sdp=message["sdp"], type="offer"))
        if "source" in state:
            source = state["source"]
        else:
            width, fps = int(message["width"]), int(message["fps"])
            process = subprocess.Popen([
                message["recorder"], "-o", message["output"], "--no-dmabuf", "-c", "rawvideo", "-m", "nut",
                "-F", capture_filter(width, fps), "-x", "nv12" if os.environ.get("PASEO_REMOTE_CONTROL_VAAPI_ENCODER") else "yuv420p", "-f", "pipe:1",
            ], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            state["capture"] = process
            player = await asyncio.to_thread(MediaPlayer, process.stdout, format="nut", options={"probesize": "32", "analyzeduration": "0"})
            state["player"] = player
            if session not in sessions:
                if player.video is not None:
                    player.video.stop()
                raise RuntimeError("Screen session was cancelled")
            if player.video is None:
                raise RuntimeError("The native capture returned no video track")
            source = player.video
        track = LatestVideo(source)
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
    if method == "windows-prepare":
        return await prepare_windows(message)
    if method == "offer":
        return await asyncio.wait_for(offer(message), timeout=12)
    if method == "ping":
        state = sessions.get(message["session"])
        if state is None:
            raise RuntimeError("Direct screen session has ended")
        if state.get("track") is not None and state["track"].readyState != "live":
            await stop(message["session"])
            raise RuntimeError("Screen capture ended; wait for a fresh frame")
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
    emit(response)


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
        try:
            loop.add_signal_handler(sig, end.set)
        except NotImplementedError:
            pass  # Windows worker exits on stdin EOF / process termination.
    # stdin is not an overlapped Windows pipe. A daemon reader also avoids an
    # executor thread blocking interpreter shutdown after Linux SIGTERM.
    lines = asyncio.Queue(maxsize=32)

    def read_stdin():
        try:
            while True:
                line = sys.stdin.buffer.readline(128 * 1024)
                asyncio.run_coroutine_threadsafe(lines.put(line), loop).result()
                if not line:
                    return
        except Exception:
            pass

    threading.Thread(target=read_stdin, daemon=True).start()
    tasks = set()
    reaper = asyncio.create_task(reap())

    async def read_commands():
        while not end.is_set():
            line = await lines.get()
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
    for encoder in list(vaapi_encoders):
        encoder.close()


if __name__ == "__main__":
    asyncio.run(main())
