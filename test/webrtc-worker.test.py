"""Exercise the pinned media libraries, encoder feedback and real FFmpeg frame selection."""
import fractions
import asyncio
import importlib.util
import pathlib
import unittest
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


if __name__ == "__main__":
    unittest.main()
