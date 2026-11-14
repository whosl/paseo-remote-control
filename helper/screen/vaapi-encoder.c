/* Private stdio H.264 encoder using the host's FFmpeg/VA-API, isolated from PyAV's ABI.
 * SPDX-License-Identifier: MIT
 * Protocol v1: PVA1 hello; LE width,height,bitrate,keyframe,pts then tight NV12 pixels;
 * reply LE int32 Annex-B byte count + bytes, or -1 before exiting on any error.
 * No networking, input injection, files or display capture. EOF releases all GPU resources.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/opt.h>

typedef struct {
    AVBufferRef *device;
    AVCodecContext *codec;
    AVFrame *software;
    int width, height, bitrate;
} Encoder;

static uint32_t u32(const uint8_t *p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static int reply(const uint8_t *data, int size) {
    uint32_t n = (uint32_t)size;
    uint8_t header[4] = {n, n >> 8, n >> 16, n >> 24};
    if (fwrite(header, 1, 4, stdout) != 4 || (size > 0 && fwrite(data, 1, size, stdout) != (size_t)size)) return -1;
    return fflush(stdout);
}

static void close_codec(Encoder *e) {
    av_frame_free(&e->software);
    avcodec_free_context(&e->codec);
}

static int configure(Encoder *e, int width, int height, int bitrate) {
    close_codec(e);
    const AVCodec *codec = avcodec_find_encoder_by_name("h264_vaapi");
    if (!codec || !(e->codec = avcodec_alloc_context3(codec))) return -1;
    AVCodecContext *c = e->codec;
    c->width = width; c->height = height; c->bit_rate = bitrate;
    c->rc_max_rate = bitrate; c->rc_buffer_size = bitrate / 3;
    c->time_base = (AVRational){1, 90000}; c->framerate = (AVRational){30, 1};
    c->sample_aspect_ratio = (AVRational){1, 1}; c->pix_fmt = AV_PIX_FMT_VAAPI;
    c->gop_size = 60; c->max_b_frames = 0; c->refs = 1;
    c->profile = FF_PROFILE_H264_CONSTRAINED_BASELINE;
    int blocks = ((width + 15) / 16) * ((height + 15) / 16);
    c->level = blocks <= 3600 ? 31 : blocks <= 8192 ? 40 : blocks <= 22080 ? 50 : 52;
    c->flags |= AV_CODEC_FLAG_LOW_DELAY;
    if (av_opt_set(c->priv_data, "rc_mode", "CBR", 0) < 0 || av_opt_set(c->priv_data, "async_depth", "1", 0) < 0) return -1;
    AVBufferRef *frames = av_hwframe_ctx_alloc(e->device);
    if (!frames) return -1;
    AVHWFramesContext *pool = (AVHWFramesContext *)frames->data;
    pool->format = AV_PIX_FMT_VAAPI; pool->sw_format = AV_PIX_FMT_NV12;
    pool->width = width; pool->height = height; pool->initial_pool_size = 4;
    int result = av_hwframe_ctx_init(frames);
    if (result >= 0) { c->hw_frames_ctx = av_buffer_ref(frames); if (!c->hw_frames_ctx) result = -1; }
    av_buffer_unref(&frames);
    if (result < 0 || avcodec_open2(c, codec, NULL) < 0) return -1;
    e->software = av_frame_alloc();
    if (!e->software) return -1;
    e->software->width = width; e->software->height = height; e->software->format = AV_PIX_FMT_NV12;
    if (av_frame_get_buffer(e->software, 32) < 0) return -1;
    e->width = width; e->height = height; e->bitrate = bitrate;
    return 0;
}

static int encode(Encoder *e, int64_t pts, int keyframe) {
    AVFrame *hw = av_frame_alloc();
    AVPacket *packet = av_packet_alloc();
    if (!hw || !packet) { av_frame_free(&hw); av_packet_free(&packet); return -1; }
    int result = av_hwframe_get_buffer(e->codec->hw_frames_ctx, hw, 0);
    if (result >= 0) result = av_hwframe_transfer_data(hw, e->software, 0);
    hw->pts = pts; hw->pict_type = keyframe ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;
    if (result >= 0) result = avcodec_send_frame(e->codec, hw);
    av_frame_free(&hw);
    if (result >= 0) result = avcodec_receive_packet(e->codec, packet);
    if (result == AVERROR(EAGAIN)) result = reply(NULL, 0);
    else if (result >= 0 && packet->size <= 32 * 1024 * 1024) result = reply(packet->data, packet->size);
    else result = -1;
    av_packet_free(&packet);
    return result;
}

int main(int argc, char **argv) {
    Encoder e = {0};
    av_log_set_level(AV_LOG_ERROR);
    setvbuf(stdin, NULL, _IOFBF, 1024 * 1024);
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        printf("{\"protocol\":1,\"libavcodec\":%u,\"libavutil\":%u}\n", avcodec_version() >> 16, avutil_version() >> 16);
        return 0;
    }
    if (argc != 2 || strncmp(argv[1], "/dev/dri/renderD", 16) != 0) return 2;
    if (av_hwdevice_ctx_create(&e.device, AV_HWDEVICE_TYPE_VAAPI, argv[1], NULL, 0) < 0) return 3;
    if (fwrite("PVA1", 1, 4, stdout) != 4 || fflush(stdout)) goto failed;
    uint8_t header[24];
    for (;;) {
        size_t count = fread(header, 1, sizeof(header), stdin);
        if (count == 0 && feof(stdin)) break;
        if (count != sizeof(header)) goto failed;
        uint32_t width = u32(header), height = u32(header + 4), bitrate = u32(header + 8), keyframe = u32(header + 12);
        int64_t pts = (int64_t)((uint64_t)u32(header + 16) | (uint64_t)u32(header + 20) << 32);
        if (width < 2 || width > 2560 || height < 2 || height > 8192 || (width & 1) || (height & 1) ||
            bitrate < 100000 || bitrate > 12000000 || keyframe > 1 || pts < 0) goto failed;
        /* VA-API rate control configuration is recreated on a meaningful rate change.
         * Keep the device open; each new context begins with its own SPS/PPS and IDR. */
        if (!e.codec || e.width != (int)width || e.height != (int)height || abs((int)bitrate - e.bitrate) > e.bitrate / 10) {
            if (configure(&e, width, height, bitrate) < 0) goto failed;
            keyframe = 1;
        }
        if (av_frame_make_writable(e.software) < 0) goto failed;
        for (int plane = 0; plane < 2; plane++) {
            int rows = plane ? height / 2 : height;
            for (int row = 0; row < rows; row++)
                if (fread(e.software->data[plane] + row * e.software->linesize[plane], 1, width, stdin) != width) goto failed;
        }
        if (encode(&e, pts, keyframe) < 0) goto failed;
    }
    close_codec(&e); av_buffer_unref(&e.device);
    return 0;
failed:
    reply(NULL, -1);
    close_codec(&e); av_buffer_unref(&e.device);
    return 1;
}
