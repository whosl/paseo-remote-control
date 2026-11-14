import { Component, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import * as ReactNative from "react-native";
import * as HostUi from "@getpaseo/plugin/client/ui";
import type { ViewProps } from "react-native";
import type { DirectVideoSignalling } from "./web";
import { nativeVideoDocument } from "./native-video-html";
import { androidVideoViewName } from "./native-video-view";
import { initialNativeVideo, nativeVideoCommandJson, NativeVideoSession, type NativeVideoCommand } from "./native-video-session";

const { AppState, Platform, UIManager, View } = ReactNative;

type Event = { nativeEvent: { url?: string; title?: string; description?: string } };
interface NativeProps extends ViewProps {
  source: { html: string; baseUrl: string };
  newSource: { html: string; baseUrl: string };
  javaScriptEnabled: boolean;
  messagingEnabled: boolean;
  injectedJavaScript: string;
  injectedJavaScriptObject: string;
  domStorageEnabled: boolean;
  allowFileAccess: boolean;
  allowFileAccessFromFileURLs: boolean;
  allowUniversalAccessFromFileURLs: boolean;
  mixedContentMode: string;
  setSupportMultipleWindows: boolean;
  mediaPlaybackRequiresUserAction: boolean;
  thirdPartyCookiesEnabled: boolean;
  onLoadingStart(event: Event): void;
  onLoadingFinish(event: Event): void;
  onLoadingError(event: Event): void;
  onRenderProcessGone(): void;
}

function androidVideoView(): ComponentType<NativeProps> | null {
  // Reuse Paseo's registration; do not register a duplicate view or replace the
  // app-wide WebView messaging module. Missing lazy capabilities are not cached.
  return androidVideoViewName(Platform.OS, UIManager, () => HostUi.DocumentFrame) as ComponentType<NativeProps> | null;
}

class VideoBoundary extends Component<{ children: ReactNode; onError(): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? null : this.props.children; }
}

type Playback = {
  profile: string;
  nonce: string;
  source: { html: string; baseUrl: string };
  command: NativeVideoCommand;
  shown: boolean;
  session: NativeVideoSession;
};

/** Reuses Paseo's compiled WebView through the public React Native native-view API. */
export function useNativeVideo(enabled: boolean, display: number | undefined, maxWidth: number, fps: number, signalling: DirectVideoSignalling, freeze = false, retry: number | string = 0, expectedDisplayKey?: string) {
  const NativeView = androidVideoView();
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  useEffect(() => AppState.addEventListener("change", value => setForeground(value !== "background")).remove, []);
  const profile = `${display}:${maxWidth}:${fps}:${retry}:${expectedDisplayKey ?? ""}`;
  const [reported, setReported] = useState({ profile, state: initialNativeVideo });
  const state = reported.profile === profile ? reported.state : initialNativeVideo;
  const [playback, setPlayback] = useState<Playback | null>(null);
  const rpc = useRef(signalling); rpc.current = signalling;

  useEffect(() => {
    if (!enabled || !foreground || !NativeView) { setReported({ profile, state: initialNativeVideo }); return; }
    let current = true;
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const session = new NativeVideoSession(nonce, { display, expectedDisplayKey, maxWidth, fps }, rpc.current,
      command => setPlayback(old => old?.nonce === nonce ? { ...old, command } : old),
      next => {
        if (!current) return;
        setReported({ profile, state: next });
        if (next.active) setPlayback(old => old?.nonce === nonce ? { ...old, shown: true } : old);
      });
    void (async () => {
      try {
        const configuration = await rpc.current.config?.();
        if (!current || session.stopped) return;
        setPlayback({ profile, nonce, source: { html: nativeVideoDocument(nonce, configuration), baseUrl: "https://paseo-rtc.invalid/" }, command: { nonce }, shown: false, session });
      } catch { session.stop("Direct video unavailable; using Paseo frames."); }
    })();
    return () => { current = false; session.stop(); };
  }, [enabled, foreground, NativeView, display, maxWidth, fps, profile, expectedDisplayKey]);

  const fail = (reason: string) => playback?.session.stop(reason);
  const video = NativeView && playback && playback.profile === profile && foreground ? (
    <VideoBoundary key={playback.nonce} onError={() => fail("Native video is unavailable; using Paseo frames.")}>
      <View pointerEvents="none" style={{ position: "absolute", inset: 0, opacity: state.active || (freeze && playback.shown) ? 1 : 0 }}>
        <NativeView style={{ flex: 1 }} source={playback.source} newSource={playback.source}
          javaScriptEnabled messagingEnabled={false} injectedJavaScript="true;" injectedJavaScriptObject={nativeVideoCommandJson(playback.command)}
          domStorageEnabled={false} allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
          mixedContentMode="never" setSupportMultipleWindows={false} mediaPlaybackRequiresUserAction={false} thirdPartyCookiesEnabled={false}
          onLoadingStart={event => playback.session.receive(event.nativeEvent.url ?? "", event.nativeEvent.title)}
          onLoadingFinish={event => playback.session.receive(event.nativeEvent.url ?? "", event.nativeEvent.title)}
          onLoadingError={event => fail(event.nativeEvent.description ?? "Video playback unavailable; using Paseo frames.")}
          onRenderProcessGone={() => fail("Video decoding failed; using Paseo frames.")} />
      </View>
    </VideoBoundary>
  ) : null;
  const reason = state.reason ?? (Platform.OS === "android" && enabled && NativeView === null ? "Native video is unavailable; using Paseo frames." : null);
  return { ...state, reason, supported: NativeView !== null, video };
}
