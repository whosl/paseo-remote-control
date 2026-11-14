"""Exercise the pinned media libraries, encoder feedback and real FFmpeg frame selection."""
import fractions
import asyncio
import importlib.util
import pathlib
import unittest
import os
from types import SimpleNamespace
from unittest.mock import patch

import av
from aiortc.codecs import get_encoder
from aiortc.codecs.h264 import h264_depayload
from aiortc.rtcrtpparameters import RTCRtpCodecParameters

spec = importlib.util.spec_from_file_location("screen_worker", pathlib.Path(__file__).parents[1] / "helper/screen/webrtc.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def frame(width, height, pts=0):
    image = av.VideoFrame(width, height, "yuv420p")
    for plane in image.planes:
        plane.update(bytes([128]) * plane.buffer_size)
    image.pts, image.time_base = pts, fractions.Fraction(1, 30)
    return image


class ScreenEncoderTests(unittest.TestCase):
    def test_sender_factory_uses_the_screen_encoder(self):
        encoder = get_encoder(RTCRtpCodecParameters(mimeType="video/H264", clockRate=90000))
        self.assertIsInstance(encoder, worker.ScreenH264Encoder)

    def test_quality_budget_and_decodable_resolution(self):
        for width, height, initial, ceiling in [(1280, 720, 1_000_000, 4_000_000), (1920, 1080, 1_000_000, 8_000_000), (2560, 1440, 1_000_000, 12_000_000)]:
            with self.subTest(width=width):
                encoder = worker.ScreenH264Encoder()
                payloads, _ = encoder.encode(frame(width, height))
                self.assertEqual(encoder.target_bitrate, initial)
                self.assertLessEqual(encoder.codec.thread_count, 8)
                self.assertFalse(encoder.codec.has_b_frames)
                self.assertEqual(encoder.codec.framerate, 30)
                decoder = av.CodecContext.create("h264", "r")
                decoded = decoder.decode(av.Packet(b"".join(h264_depayload(payload) for payload in payloads)))
                self.assertEqual((decoded[0].width, decoded[0].height), (width, height))
                encoder.target_bitrate = 100_000_000
                self.assertEqual(encoder.target_bitrate, ceiling)

    def test_network_feedback_can_reduce_the_highest_quality_budget(self):
        encoder = worker.ScreenH264Encoder()
        encoder.encode(frame(2560, 1440))
        encoder.target_bitrate = 200_000
        encoder.encode(frame(2560, 1440, 1))
        self.assertEqual(encoder.target_bitrate, 200_000)
        self.assertEqual(encoder.codec.bit_rate, 200_000)
        encoder.target_bitrate = 1
        self.assertEqual(encoder.target_bitrate, 100_000)
        encoder.target_bitrate = 6_000_000
        encoder.encode(frame(2560, 1440, 2))
        self.assertEqual(encoder.codec.bit_rate, 6_000_000)

    def test_independent_viewers_and_resize_preserve_feedback(self):
        first, second = worker.ScreenH264Encoder(), worker.ScreenH264Encoder()
        first.encode(frame(2560, 1440))
        second.encode(frame(1280, 720))
        first.target_bitrate = 300_000
        self.assertEqual(second.target_bitrate, 1_000_000)
        first.encode(frame(1920, 1080, 1))
        self.assertEqual(first.target_bitrate, 300_000)
        self.assertEqual((first.codec.width, first.codec.height), (1920, 1080))

    def test_startup_probe_is_bounded_and_stops_when_receiver_estimate_falls(self):
        with patch.object(worker.time, 'monotonic', return_value=0) as clock:
            encoder = worker.ScreenH264Encoder()
            encoder.encode(frame(2560, 1440))
            encoder.target_bitrate = 1_000_000
            clock.return_value = 1
            encoder.encode(frame(2560, 1440, 1))
            self.assertEqual(encoder.target_bitrate, 1_250_000)
            encoder.encode(frame(2560, 1440, 2))
            self.assertEqual(encoder.target_bitrate, 1_250_000)
            encoder.target_bitrate = 1_100_000
            self.assertEqual(encoder.target_bitrate, 1_250_000)
            encoder.target_bitrate = 600_000
            self.assertEqual(encoder.target_bitrate, 600_000)
            clock.return_value = 30
            encoder.encode(frame(2560, 1440, 3))
            self.assertEqual(encoder.target_bitrate, 600_000)

    def test_packet_loss_limits_even_an_optimistic_bandwidth_estimate(self):
        with patch.object(worker.time, 'monotonic', return_value=0) as clock:
            encoder = worker.ScreenH264Encoder()
            encoder.encode(frame(2560, 1440))
            encoder.target_bitrate = 8_000_000
            encoder.packet_loss(0.2)
            self.assertEqual(encoder.target_bitrate, 6_000_000)
            encoder.target_bitrate = 10_000_000
            self.assertEqual(encoder.target_bitrate, 6_000_000)
            encoder.packet_loss(0.2)
            self.assertEqual(encoder.target_bitrate, 4_500_000)
            encoder.packet_loss(0)
            encoder.target_bitrate = 10_000_000
            self.assertEqual(encoder.target_bitrate, 4_500_000)
            clock.return_value = 11
            encoder.packet_loss(0)
            encoder.target_bitrate = 10_000_000
            self.assertEqual(encoder.target_bitrate, 4_590_000)

    def test_capture_jitter_does_not_discard_a_third_of_motion_frames(self):
        graph = av.filter.Graph()
        source = graph.add_buffer(width=16, height=16, format="yuv420p", time_base=fractions.Fraction(1, 1000))
        expression = worker.capture_filter(16, 30).split("',scale=")[0].removeprefix("select='")
        select, sink = graph.add("select", expression), graph.add("buffersink")
        graph.link_nodes(source, select, sink)
        graph.configure()
        emitted = []
        for index in range(120):
            image = frame(16, 16)
            image.pts = round(index * 1000 / 60 + (0.45 if index % 2 else 0))
            image.time_base = fractions.Fraction(1, 1000)
            graph.push(image)
            try:
                while True:
                    emitted.append(graph.pull())
            except av.error.BlockingIOError:
                pass
        self.assertGreaterEqual(len(emitted), 59)
        self.assertLessEqual(len(emitted), 61)
        slots = [int(float(image.pts * image.time_base) * 30 + 1e-6) for image in emitted]
        self.assertEqual(len(set(slots)), len(slots))


class HardwareFallbackTests(unittest.TestCase):
    def assert_decodable(self, payloads, width, height):
        decoder = av.CodecContext.create("h264", "r")
        decoded = decoder.decode(av.Packet(b"".join(h264_depayload(payload) for payload in payloads)))
        self.assertEqual((decoded[0].width, decoded[0].height), (width, height))

    def test_missing_driver_falls_back_once_and_retains_network_feedback(self):
        encoder = worker.ScreenH264Encoder(prefer_hardware=True)
        create = encoder._create_codec
        attempts = []
        def unavailable(name, size):
            attempts.append(name)
            if name == "h264_nvenc":
                raise RuntimeError("No NVENC device")
            return create(name, size)
        with patch.object(encoder, "_create_codec", side_effect=unavailable), patch.object(worker, "emit") as report:
            payloads, _ = encoder.encode(frame(640, 480))
            self.assert_decodable(payloads, 640, 480)
            self.assertEqual(encoder.codec.name, "libx264")
            encoder.target_bitrate = 200_000
            encoder.encode(frame(640, 480, 1))
            encoder.encode(frame(1280, 720, 2))
            self.assertEqual(encoder.codec.bit_rate, 200_000)
            self.assertEqual(attempts.count("h264_nvenc"), 1)
            report.assert_called_once_with({"event": "encoder", "backend": "libx264", "fallback": True})

    def test_device_loss_reencodes_the_same_frame_as_a_software_idr(self):
        encoder = worker.ScreenH264Encoder(prefer_hardware=True)
        create = encoder._create_codec
        broken = SimpleNamespace(name="h264_nvenc", width=640, height=480, bit_rate=1_000_000)
        def lost(_frame):
            raise RuntimeError("NVENC device lost")
        broken.encode = lost
        with patch.object(encoder, "_create_codec", side_effect=lambda name, size: broken if name == "h264_nvenc" else create(name, size)), patch.object(worker, "emit"):
            payloads, timestamp = encoder.encode(frame(640, 480, 9))
            self.assert_decodable(payloads, 640, 480)
            self.assertEqual(timestamp, 27000)
            self.assertTrue(encoder._hardware_failed)
            self.assertEqual(encoder.codec.name, "libx264")

    def test_software_selection_does_not_probe_the_gpu(self):
        encoder = worker.ScreenH264Encoder(prefer_hardware=False)
        with patch.object(encoder, "_create_codec", wraps=encoder._create_codec) as create, patch.object(worker, "emit"):
            encoder.encode(frame(640, 480))
            self.assertEqual([call.args[0] for call in create.call_args_list], ["libx264"])

    @unittest.skipUnless(os.environ.get("PASEO_RC_RUN_NVENC") == "1", "requires an explicitly selected NVENC host")
    def test_real_gpu_bgra_resize_dynamic_bitrate_and_independent_idr_decode(self):
        encoder = worker.ScreenH264Encoder(prefer_hardware=True)
        with patch.object(worker, "emit"):
            for width, height in [(1920, 1080), (1280, 720), (2560, 1440)]:
                image = av.VideoFrame(width, height, "bgra")
                image.planes[0].update(bytes([30, 90, 170, 255]) * (image.planes[0].buffer_size // 4))
                image.pts, image.time_base = 0, fractions.Fraction(1, 30)
                payloads, _ = encoder.encode(image, True)
                self.assertEqual(encoder.codec.name, "h264_nvenc")
                self.assertFalse(encoder._hardware_failed)
                self.assert_decodable(payloads, width, height)
                context = encoder.codec
                encoder.target_bitrate = 300_000
                image.pts = 1
                encoder.encode(image)
                self.assertIs(encoder.codec, context)
                encoder.target_bitrate = 3_000_000
                image.pts = 2
                payloads, _ = encoder.encode(image, True)
                self.assertIs(encoder.codec, context)
                self.assertEqual(encoder.codec.bit_rate, 3_000_000)
                self.assert_decodable(payloads, width, height)


class PacingTests(unittest.IsolatedAsyncioTestCase):
    async def test_rtp_is_spread_over_time(self):
        sent = []
        async def send(data):
            sent.append(asyncio.get_running_loop().time())
        sender = SimpleNamespace(transport=SimpleNamespace(_send_rtp=send))
        pacer = worker.VideoPacer(sender)
        for _ in range(6):
            await pacer.send_rtp(bytes([128, 97]) + bytes(998))
        self.assertEqual(len(sent), 6)
        self.assertGreater(sent[-1] - sent[0], 0.025)

    async def test_rtcp_bypasses_video_pacing(self):
        sent = []
        async def send(data):
            sent.append(data)
        sender = SimpleNamespace(transport=SimpleNamespace(_send_rtp=send))
        pacer = worker.VideoPacer(sender)
        pacer.deadline = asyncio.get_running_loop().time() + 60
        with patch.object(worker.asyncio, 'sleep') as sleep:
            await pacer.send_rtp(bytes([128, 200]))
            sleep.assert_not_called()
        self.assertEqual(sent, [bytes([128, 200])])

    async def test_receiver_loss_fraction_is_converted_once_per_report(self):
        encoder = worker.ScreenH264Encoder()
        encoder.encode(frame(1280, 720))
        async def send(data):
            pass
        async def stats():
            return {'report': SimpleNamespace(type='remote-inbound-rtp', timestamp=1, fractionLost=128)}
        sender = SimpleNamespace(transport=SimpleNamespace(_send_rtp=send), getStats=stats, _RTCRtpSender__encoder=encoder)
        state = {'sender': sender, 'pacer': worker.VideoPacer(sender)}
        await worker.watch_loss(state)
        self.assertEqual(encoder.target_bitrate, 750_000)
        await worker.watch_loss(state)
        self.assertEqual(encoder.target_bitrate, 750_000)


class WindowsRawFeedTests(unittest.IsolatedAsyncioTestCase):
    async def test_private_bgra_feed_rejects_wrong_nonce_and_decodes_with_row_padding(self):
        source = worker.WindowsVideo(34, 18)
        source.server = await asyncio.start_server(source.accept, "127.0.0.1", 0, limit=128)
        port = source.server.sockets[0].getsockname()[1]
        try:
            reader, bad = await asyncio.open_connection("127.0.0.1", port)
            bad.write(b"wrong-token\n"); await bad.drain()
            self.assertEqual(await asyncio.wait_for(reader.read(), 2), b"")
            self.assertFalse(source.claimed)
            bad.close(); await bad.wait_closed()
            _, good = await asyncio.open_connection("127.0.0.1", port)
            good.write((source.token + "\n").encode())
            good.write(worker.struct.pack("<q", 9000) + bytes([40, 80, 120, 255]) * (34 * 18))
            await good.drain()
            image = await source.recv()
            self.assertEqual((image.width, image.height, image.pts, image.time_base), (34, 18, 9000, fractions.Fraction(1, 90000)))
            self.assertEqual(bytes(image.planes[0])[:8], bytes([40, 80, 120, 255]) * 2)
            encoder = worker.ScreenH264Encoder()
            payloads, _ = encoder.encode(image)
            decoder = av.CodecContext.create("h264", "r")
            decoded = decoder.decode(av.Packet(b"".join(h264_depayload(payload) for payload in payloads)))
            self.assertEqual((decoded[0].width, decoded[0].height), (34, 18))
            good.close(); await good.wait_closed()
            from aiortc.mediastreams import MediaStreamError
            with self.assertRaises(MediaStreamError):
                await source.recv()
            self.assertEqual(source.readyState, "ended")
        finally:
            source.stop()
            await source.server.wait_closed()

    async def test_prepared_feed_stop_closes_listener_and_enforces_viewer_limit(self):
        await worker.prepare_windows({"session": "test-one", "width": 34, "height": 18})
        await worker.prepare_windows({"session": "test-two", "width": 34, "height": 18})
        try:
            with self.assertRaisesRegex(RuntimeError, "Two direct"):
                await worker.prepare_windows({"session": "test-three", "width": 34, "height": 18})
        finally:
            await worker.stop("test-one"); await worker.stop("test-two")
        self.assertEqual(worker.sessions, {})


if __name__ == "__main__":
    unittest.main()
