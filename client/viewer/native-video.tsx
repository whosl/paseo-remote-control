import { Component, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import * as ReactNative from "react-native";
import type { ViewProps } from "react-native";
import type { DirectVideoSignalling } from "./web";
import { nativeVideoDocument } from "./native-video-html";
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

let cachedView: ComponentType<NativeProps> | null | undefined;
function androidVideoView(): ComponentType<NativeProps> | null {
  if (Platform.OS !== "android") return null;
  if (cachedView !== undefined) return cachedView;
  try {
    if (!UIManager.getViewManagerConfig("RNCWebView")) return cachedView = null;
    // Reuse Paseo's registration. Registering the same name here could break a
    // lazily loaded terminal/document view later. If the app has not registered
    // its JS view config yet, VideoBoundary falls back without changing it.
    // Likewise, never replace the app-wide WebView messaging module.
    cachedView = "RNCWebView" as unknown as ComponentType<NativeProps>;
  } catch { cachedView = null; }
  return cachedView;
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
export function useNativeVideo(enabled: boolean, display: number | undefined, maxWidth: number, fps: number, signalling: DirectVideoSignalling, freeze = false) {
  const NativeView = androidVideoView();
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  useEffect(() => AppState.addEventListener("change", value => setForeground(value !== "background")).remove, []);
  const profile = `${display}:${maxWidth}:${fps}`;
  const [reported, setReported] = useState({ profile, state: initialNativeVideo });
  const state = reported.profile === profile ? reported.state : initialNativeVideo;
  const [playback, setPlayback] = useState<Playback | null>(null);
  const rpc = useRef(signalling); rpc.current = signalling;

  useEffect(() => {
    if (!enabled || !foreground || !NativeView) { setReported({ profile, state: initialNativeVideo }); return; }
    let current = true;
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const session = new NativeVideoSession(nonce, { display, maxWidth, fps }, rpc.current,
      command => setPlayback(old => old?.nonce === nonce ? { ...old, command } : old),
      next => {
        if (!current) return;
        setReported({ profile, state: next });
        if (next.active) setPlayback(old => old?.nonce === nonce ? { ...old, shown: true } : old);
      });
    setPlayback({ profile, nonce, source: { html: nativeVideoDocument(nonce), baseUrl: "https://paseo-rtc.invalid/" }, command: { nonce }, shown: false, session });
    return () => { current = false; session.stop(); };
  }, [enabled, foreground, NativeView, display, maxWidth, fps, profile]);

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
  return { ...state, supported: NativeView !== null, video };
}
