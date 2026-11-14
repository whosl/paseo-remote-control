import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PixelRatio, Platform, ScrollView, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import { chooseDisplayRpc, displayFallbackRpc, requestPermissionsRpc, statusRpc, videoOfferRpc, videoPingRpc, videoStopRpc, type ScreenDisplay, type ScreenInputEvent, type ScreenModifier, type ScreenStatus } from "../../shared/screen/rpc";
import { readLocalClipboard, useHostClipboard } from "./clipboard";
import { useControlPause } from "./control";
import { chrome, Control, Key } from "./controls";
import { FeedbackPressable as Pressable, FeedbackProvider, useFeedback } from "./feedback";
import { fitContent } from "./geometry";
import { isAppleClient, KEY, keyMapping } from "./keys";
import { TouchStage } from "./touch-stage";
import type { InputMode } from "./touch-controller";
import { QUALITIES, useFrames, useInputQueue } from "./use-screen";
import { useDirectVideo, useFullscreen } from "./web";
import { useWebInput } from "./web-input";
import { useOwnership } from "../ownership";

const isWeb = Platform.OS === "web";
type Panel = "displays" | "settings" | "clipboard";

export function RemoteScreen(props: PluginScreenProps) {
  const [feedback, setFeedback] = useState(true);
  return <FeedbackProvider enabled={feedback}><ScreenViewer {...props} feedbackEnabled={feedback} setFeedbackEnabled={setFeedback} /></FeedbackProvider>;
}

function ScreenViewer({ theme, layout, host, feedbackEnabled, setFeedbackEnabled }: PluginScreenProps & { feedbackEnabled: boolean; setFeedbackEnabled(value: boolean): void }) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const queryClient = useQueryClient();
  const fetchStatus = useRpc(statusRpc);
  const status = useQuery({ queryKey: ["paseo-screen", host.id, "status"], queryFn: () => fetchStatus({}), refetchInterval: 5000 });
  const requestPermissions = useRpc(requestPermissionsRpc);
  const request = useMutation({ mutationFn: () => requestPermissions({}), onSuccess: () => void status.refetch() });
  const chooseDisplayOnHost = useRpc(chooseDisplayRpc);
  const updateFallback = useRpc(displayFallbackRpc);
  const fallbackChange = useMutation({
    mutationFn: (action: "enable" | "disable" | "return-physical") => updateFallback({ action }),
    onSuccess: (displayFallback) => {
      queryClient.setQueryData<ScreenStatus>(["paseo-screen", host.id, "status"], (old) => old ? { ...old, displayFallback } : old);
      void status.refetch();
    },
  });
  const offerVideo = useRpc(videoOfferRpc);
  const pingVideo = useRpc(videoPingRpc);
  const stopVideo = useRpc(videoStopRpc);
  const [preferDirect, setPreferDirect] = useState(true);
  const [videoNode, setVideoNode] = useState<unknown>(null);
  const [paused, setPaused] = useState(false);
  const [control, setControl] = useState(true);
  const [qualityIndex, setQualityIndex] = useState(1);
  const [inputMode, setInputMode] = useState<InputMode>("touchscreen");
  const feedback = useFeedback();
  const [chosenDisplay, setChosenDisplay] = useState<number | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [minimal, setMinimal] = useState(false);
  const [rootNode, setRootNode] = useState<unknown>(null);
  const fullscreen = useFullscreen(rootNode);
  const togglePanel = (next: Panel) => setPanel((previous) => previous === next ? null : next);

  // Transient helper errors and sleeping monitors must not discard the chosen display.
  const lastGood = useRef<ScreenStatus | null>(null);
  const lastAwake = useRef<ScreenStatus | null>(null);
  if (status.data && !status.data.error) lastGood.current = status.data;
  if (status.data && !status.data.error && status.data.displays.length) lastAwake.current = status.data;
  const fallback = status.data?.displayFallback;
  const managedSelection = fallback !== undefined;
  // A managed host owns selection across hotplug; an old numeric ID may now identify another monitor.
  const displays = managedSelection ? status.data?.displays ?? [] : lastAwake.current?.displays ?? [];
  const display = displays.find((item) => !!fallback?.selectedKey && item.stableKey === fallback.selectedKey)
    ?? (!managedSelection ? displays.find((item) => item.id === chosenDisplay) : undefined)
    ?? displays.find((item) => item.id === (managedSelection ? status.data?.preferredDisplay : lastAwake.current?.preferredDisplay))
    ?? displays.find((item) => item.main) ?? displays[0];
  const chooseDisplay = useCallback((id: number) => {
    setChosenDisplay(id);
    void chooseDisplayOnHost({ display: id }).then(() => status.refetch()).catch((error) => setInputError(String(error)));
  }, [chooseDisplayOnHost, status.refetch]);
  const canCapture = lastGood.current?.screenRecording === true;
  const hostPlatform = lastGood.current?.platform ?? "darwin";
  const mapping = useMemo(() => keyMapping(hostPlatform, isAppleClient()), [hostPlatform]);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [rotated, setRotated] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [aspect, setAspect] = useState(16 / 10);
  const content = fitContent(stage, aspect, !isWeb && rotated);
  const quality = QUALITIES[qualityIndex]!;
  const wanted = content.width > 0 ? Math.ceil(content.width * Math.min(PixelRatio.get(), 2) / 160) * 160 : quality.maxWidth;
  // Direct video does not carry frame display keys yet; managed hotplug uses identity-bearing JPEGs.
  const direct = useDirectVideo(videoNode, canCapture && !paused && preferDirect && !managedSelection && lastGood.current?.webrtc === true, display?.id, Math.max(320, Math.min(quality.maxWidth, wanted)), [30, 24, 15][qualityIndex]!, { offer: offerVideo, ping: pingVideo, stop: stopVideo });
  const frames = useFrames(canCapture && !paused && !direct.active, display?.id, quality, content.width * Math.ceil(zoom), lastGood.current?.frameWait === true, display?.stableKey);
  const frameAspect = frames.display ? frames.display.width / frames.display.height : null;
  useEffect(() => { if (frameAspect) setAspect(frameAspect); }, [frameAspect]);
  const frameMatchesDisplay = !!frames.uri && !!frames.display && frames.display.id === display?.id
    && (display?.stableKey === undefined || frames.display.stableKey === display.stableKey)
    && (!fallback?.selectedKey || frames.display.stableKey === fallback.selectedKey);
  const ownership = useOwnership(host.id);
  const hostControlBase = useControlPause(host.id);
  const hostControl = { ...hostControlBase, paused: ownership.state?.paused ?? hostControlBase.paused };
  useEffect(() => { if (!hostControl.paused) setInputError(null); }, [hostControl.paused]);
  const controlling = ((direct.active && !managedSelection) || frameMatchesDisplay) && !fallbackChange.isPending && control && !paused && lastGood.current?.accessibility === true && !hostControl.paused && ownership.known && ownership.state?.mode !== "agent" && !ownership.changing;
  const send = useInputQueue(display?.id, setInputError, chooseDisplay, frames.display?.stableKey, controlling);
  const clipboard = useHostClipboard(controlling && ownership.state?.humanPriority === true);
  const pasteOnHost = useCallback((text: string, shift = false) => {
    if (!controlling) return;
    send(shift ? { type: "paste", text, shift } : { type: "paste", text });
    clipboard.notePasted(text);
  }, [controlling, send, clipboard.notePasted]);
  const pasteLocalClipboard = useCallback(async (shift = false) => {
    const text = await readLocalClipboard();
    if (text) pasteOnHost(text, shift);
    else { setPanel("clipboard"); clipboard.setMessage("Paste your text into the clipboard panel."); }
  }, [pasteOnHost, clipboard.setMessage]);
  const [viewNode, setViewNode] = useState<unknown>(null);
  useWebInput(viewNode, isWeb && controlling, send, mapping, {
    onHostCopy: clipboard.afterHostCopy, onPaste: pasteOnHost, onPasteFallback: (shift) => void pasteLocalClipboard(shift),
    onClick: feedback,
  });
  const short = stage.height > 0 && stage.height < 450;
  const compact = layout.compact || (stage.width > 0 && stage.width < 700) || short;
  const tiny = stage.width > 0 && stage.width < 350;
  const toggleFullscreen = () => { void fullscreen.toggle().catch((error) => setInputError(`Fullscreen: ${String(error)}`)); };
  const message = inputError ?? ownership.error ?? (direct.active ? null : frames.error) ?? clipboard.message;
  const permissionMissing = !!status.data && (!status.data.supported || !!status.data.error || !status.data.screenRecording || !status.data.accessibility);

  return (
    <View ref={setRootNode} style={styles.screen}>
      {fallback?.state === "return-available" ? <View accessibilityLiveRegion="polite" style={styles.fallbackBanner}>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text style={styles.rowTitle}>Physical display reconnected</Text>
          <Text style={styles.description}>Keep using the virtual display, or switch back when ready.</Text>
          {fallbackChange.error ? <Text style={styles.description}>{fallbackChange.error.message}</Text> : null}
        </View>
        <Action styles={styles} label={fallbackChange.isPending ? "Switching…" : "Switch back"} disabled={fallbackChange.isPending || fallback.returnDisplay === null} onPress={() => fallbackChange.mutate("return-physical")} />
      </View> : null}
      <View style={styles.viewport} onLayout={(event: LayoutChangeEvent) => setStage(event.nativeEvent.layout)}>
        <View style={styles.picture}>
          {frames.uri ? <TouchStage uri={paused && direct.still ? direct.still : frames.uri} stage={stage} content={content} rotated={!isWeb && rotated} controlling={controlling} mode={inputMode} send={send} onZoomChange={setZoom} onPictureNode={setViewNode} onVideoNode={setVideoNode} />
          : <View style={styles.empty}>
              <Icon name="Monitor" size={32} color={chrome.muted} />
              <Text style={styles.emptyTitle}>{status.isLoading ? "Connecting to your computer" : canCapture ? "Starting the screen" : "Your screen will appear here"}</Text>
              <Text style={styles.hint}>A private view of {host.label}</Text>
            </View>}
        </View>

        {ownership.state?.mode === "agent" || ownership.state?.humanPriority ? <View style={{ position: "absolute", top: minimal ? 16 : short ? 62 : 82, left: 12, right: 12, alignItems: "center", zIndex: 20 }} pointerEvents="box-none">
          <View accessibilityLabel="Control ownership notice" style={{ maxWidth: 620, width: "100%", flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "rgba(20,34,44,0.97)", borderColor: ownership.state.mode === "agent" ? chrome.blue : chrome.green, borderWidth: 1, borderRadius: 13, padding: 12 }}>
            <Icon name={ownership.state.mode === "agent" ? "Bot" : "UserRound"} size={20} color={chrome.blue} />
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}><Text style={{ color: chrome.text, fontSize: 13, fontWeight: "600" }}>{ownership.state.mode === "agent" ? `${ownership.state.label} is controlling` : ownership.state.paused ? "All remote input is paused" : "You have control"}</Text><Text numberOfLines={2} style={{ color: chrome.muted, fontSize: 11 }}>{ownership.state.mode === "agent" ? [ownership.state.app, ownership.state.tool, "Watching live"].filter(Boolean).join(" · ") : "Agents cannot act until you allow them again."}</Text></View>
            <Pressable accessibilityRole="button" accessibilityLabel={ownership.state.mode === "agent" ? "Take over from agent" : "Allow agents to control"} disabled={ownership.changing || ownership.state.paused} onPress={ownership.state.mode === "agent" ? ownership.takeOver : ownership.allowAgents} style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: chrome.blue, opacity: ownership.changing || ownership.state.paused ? 0.45 : 1 }}><Text style={{ color: "#11232e", fontSize: 12, fontWeight: "600" }}>{ownership.changing ? "Switching…" : ownership.state.mode === "agent" ? "Take over" : "Allow agents"}</Text></Pressable>
          </View>
        </View> : null}

        {!minimal ? <>
          <View pointerEvents="box-none" style={[styles.top, { top: short ? 10 : 20, left: compact ? 12 : 24, right: compact ? 12 : 24, gap: tiny ? 4 : 8 }]}>
            <View pointerEvents="box-none" style={styles.side}>
              {compact ? <Control small={tiny} icon="Monitor" label={`Connected to ${host.label}`} onPress={() => togglePanel("displays")} /> :
                <Pressable accessibilityRole="button" accessibilityLabel="Choose display" onPress={() => togglePanel("displays")} style={styles.hostPill}>
                  <Icon name="Monitor" size={18} color={chrome.muted} /><View><Text style={styles.hostName} numberOfLines={1}>{host.label}</Text><Text style={styles.eyebrow}>REMOTE SCREEN</Text></View>
                </Pressable>}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Display selector" onPress={() => togglePanel("displays")} style={styles.resolution}>
              <View style={[styles.dot, { backgroundColor: paused || frames.asleep ? chrome.muted : frames.error && !direct.active ? theme.colors.statusWarning : chrome.blue }]} />
              <Text style={styles.resolutionText}>{display ? `${display.pixelWidth} × ${display.pixelHeight}` : "Connecting"}</Text>
              <Icon name="ChevronDown" size={13} color={chrome.muted} />
            </Pressable>
            <View pointerEvents="box-none" style={[styles.side, styles.rightSide, { gap: tiny ? 4 : 8 }]}>
              {!compact && fullscreen.supported ? <Control icon={fullscreen.active ? "Minimize" : "Maximize"} label={fullscreen.active ? "Exit fullscreen" : "Fullscreen"} onPress={toggleFullscreen} /> : null}
              <Control small={tiny} above={false} icon="Keyboard" label={keyboard ? "Hide keyboard" : "Show keyboard"} active={keyboard} onPress={() => setKeyboard(!keyboard)} />
              <Control small={tiny} above={false} icon="SlidersHorizontal" label="Screen settings" active={panel === "settings"} onPress={() => togglePanel("settings")} />
            </View>
          </View>

          <View pointerEvents="box-none" style={[styles.bottom, { bottom: short ? 10 : compact ? 20 : 24 }]}>
            <View style={styles.dock}>
              <Control small icon={paused ? "Play" : "Pause"} label={paused ? "Resume picture" : "Pause picture"} active={paused} onPress={() => setPaused(!paused)} />
              <View style={styles.divider} />
              <Pressable accessibilityRole="button" accessibilityLabel={control ? "Switch to view only" : "Enable remote control"} accessibilityState={{ selected: control }} onPress={() => setControl(!control)} style={styles.controlMode}>
                <Icon name={controlling ? "MousePointer2" : "Eye"} size={17} color={controlling ? chrome.green : chrome.muted} />
                {!compact ? <Text style={[styles.modeLabel, { color: controlling ? chrome.green : chrome.text }]}>{controlling ? "Control" : "View only"}</Text> : null}
              </Pressable>
              <View style={styles.divider} />
              <Control small icon="Clipboard" label="Clipboard" active={panel === "clipboard"} onPress={() => togglePanel("clipboard")} />
              <Control small icon={inputMode === "trackpad" ? "Touchpad" : "Hand"} label={inputMode === "trackpad" ? "Trackpad mode · Switch to touchscreen" : "Touchscreen mode · Switch to trackpad"} active={inputMode === "trackpad"} onPress={() => setInputMode(inputMode === "trackpad" ? "touchscreen" : "trackpad")} />
              {!isWeb ? <Control small icon="RotateCw" label="Rotate picture" active={rotated} onPress={() => setRotated(!rotated)} /> : null}
              {compact && fullscreen.supported ? <Control small icon={fullscreen.active ? "Minimize" : "Maximize"} label={fullscreen.active ? "Exit fullscreen" : "Fullscreen"} onPress={toggleFullscreen} /> : null}
              <Control small icon="PanelBottomClose" label="Hide controls" onPress={() => { setPanel(null); setMinimal(true); }} />
            </View>
            {inputMode === "trackpad" ? <Text pointerEvents="none" style={[styles.hint, { maxWidth: compact ? 290 : undefined }]}>{controlling ? "Trackpad · Move with one finger · Tap to click\nTwo fingers scroll / right-click · Hold to drag" : "View only · Remote input is disabled"}</Text> : !compact && !short ? <Text pointerEvents="none" style={styles.hint}>{controlling ? "Click to control · Scroll to navigate · Keyboard for shortcuts" : "View only · Your computer is not receiving input"}</Text> : null}
          </View>
        </> : <View style={styles.reveal}><Control above icon="Ellipsis" label="Show controls" onPress={() => setMinimal(false)} /></View>}

        {(direct.active ? status.data?.locked : frames.locked) && !frames.asleep ? <View pointerEvents="none" style={styles.locked}><Icon name="LockKeyhole" size={14} color={chrome.text} /><Text style={styles.hint}>{hostPlatform === "win32" ? "Unlock this PC locally to continue" : "Screen locked · Use the keyboard to unlock"}</Text></View> : null}
        {message ? <View style={[styles.toast, { top: short ? 62 : 88 }]}><Icon name={frames.error || inputError ? "CircleAlert" : "ClipboardCheck"} size={16} color={chrome.blue} /><Text selectable style={styles.toastText}>{message}</Text><Control small icon="X" label="Dismiss message" onPress={() => { setInputError(null); clipboard.setMessage(null); }} /></View> : null}

        {permissionMissing ? <View style={styles.centerOverlay} pointerEvents="box-none"><View style={styles.notice}><PermissionNotice status={status.data!} requesting={request.isPending} onRequest={() => request.mutate()} styles={styles} /></View></View>
          : paused || frames.asleep || hostControl.paused ? <View pointerEvents="box-none" style={styles.centerOverlay}><View style={styles.notice}>
            <Icon name={frames.asleep ? "Moon" : "Pause"} size={24} color={theme.colors.foregroundMuted} />
            <Text style={styles.panelTitle}>{frames.asleep ? "The display is asleep" : hostControl.paused ? "Control paused on this host" : "Picture paused"}</Text>
            <Text style={styles.description}>{hostControl.paused ? "All viewers can watch, but no one can click, type or access the clipboard." : "Remote input is disabled until you resume."}</Text>
            <Action styles={styles} label={frames.asleep ? "Wake display" : hostControl.paused ? "Resume host control" : "Resume picture"} onPress={() => { if (frames.asleep) frames.wake(); if (hostControl.paused) hostControl.setPaused(false); setPaused(false); }} />
          </View></View> : null}

        {panel && !minimal ? <View style={[styles.panel, compact ? { left: 12, right: 12, top: 68, maxHeight: Math.max(130, stage.height - 144) } : { right: 24, top: 84, width: 342, maxHeight: Math.max(150, stage.height - 190) }]}>
          <View style={styles.panelHeader}><Text style={styles.panelTitle}>{panel === "displays" ? "Your displays" : panel === "settings" ? "Screen settings" : "Clipboard"}</Text><Pressable accessibilityRole="button" accessibilityLabel="Close panel" onPress={() => setPanel(null)} style={styles.close}><Icon name="X" size={18} color={theme.colors.foregroundMuted} /></Pressable></View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.panelBody}>
            {panel === "displays" ? <>
              <Text style={styles.description}>Choose the screen you want to work on.</Text>
              {fallback?.state === "virtual" || fallback?.state === "return-available" ? <Text style={styles.description}>Virtual fallback is active.</Text> : null}
              {displays.map((item) => <Pressable key={item.stableKey ?? item.id} accessibilityRole="button" accessibilityLabel={`View ${item.name}, ${displayKindLabel(item, hostPlatform)}`} accessibilityState={{ selected: item.id === display?.id }} onPress={() => { chooseDisplay(item.id); frames.wake(); setPanel(null); }} style={[styles.displayRow, item.id === display?.id && styles.selectedRow]}>
                <Icon name={item.builtin ? "Laptop" : "Monitor"} size={22} color={item.id === display?.id ? theme.colors.accent : theme.colors.foregroundMuted} />
                <View style={{ flex: 1, gap: 4 }}><Text style={styles.rowTitle} numberOfLines={2}>{item.name}</Text><Text style={styles.description}>{displayKindLabel(item, hostPlatform)} · {item.pixelWidth} × {item.pixelHeight}{item.main ? " · Main" : ""}</Text></View>
                {item.id === display?.id ? <Icon name="Check" size={18} color={theme.colors.accent} /> : null}
              </Pressable>)}
            </> : panel === "settings" ? <>
              {hostPlatform === "win32" ? <>
                <Text style={styles.sectionLabel}>WINDOWS HEADLESS</Text>
                <Text style={styles.description}>Automatic fallback keeps a virtual screen available when physical displays disconnect. Reconnecting a display offers Switch back; it never switches silently.</Text>
                <Text style={styles.description}>{!fallback ? "This host does not report headless fallback support. Update the host to configure it." : !fallback.provisioned ? "A virtual display driver must be installed and provisioned separately by an administrator on the host. This control does not install drivers." : fallback.message}</Text>
                {fallback ? <Pressable accessibilityRole="switch" accessibilityLabel="Automatic headless fallback" accessibilityState={{ checked: fallback.enabled, disabled: !fallback.provisioned || fallbackChange.isPending }} disabled={!fallback.provisioned || fallbackChange.isPending} onPress={() => fallbackChange.mutate(fallback.enabled ? "disable" : "enable")} style={[styles.displayRow, (!fallback.provisioned || fallbackChange.isPending) && { opacity: 0.5 }]}>
                  <Text style={[styles.rowTitle, { flex: 1 }]}>Automatic fallback</Text><Text style={styles.description}>{fallbackChange.isPending ? "Updating…" : fallback.enabled ? "On" : "Off"}</Text>
                </Pressable> : null}
                {fallback?.state === "virtual" || fallback?.state === "return-available" ? <Text style={styles.description}>Virtual fallback is active.</Text> : null}
                {fallback && !fallback.provisioned && fallback.message ? <Text style={styles.description}>{fallback.message}</Text> : null}
                {fallback?.state === "error" && fallback.provisioned ? <Action styles={styles} label={fallbackChange.isPending ? "Retrying…" : "Retry fallback"} disabled={fallbackChange.isPending} onPress={() => fallbackChange.mutate("enable")} /> : null}
                {fallback?.error || fallbackChange.error ? <Text selectable accessibilityLiveRegion="polite" style={[styles.description, { color: theme.colors.statusWarning }]}>{fallbackChange.error?.message ?? fallback?.error}</Text> : null}
                {status.data?.windowsTopology?.error ? <Text selectable style={styles.description}>{status.data.windowsTopology.error}</Text> : null}
                <View style={styles.rule} />
              </> : null}
              <Text style={styles.sectionLabel}>INPUT</Text>
              <Text style={styles.description}>Control owner: {ownership.state?.label ?? "Connecting…"}. Watching does not claim control. Your first input reserves human control until you explicitly allow agents again.</Text>
              <Action styles={styles} label={ownership.changing ? "Switching control…" : "Take control / stop agents"} disabled={ownership.changing} onPress={ownership.takeOver} />
              <View style={styles.qualityRow}>{(["touchscreen", "trackpad"] as InputMode[]).map((mode) => <Pressable key={mode} accessibilityRole="button" accessibilityLabel={`Select ${mode} mode`} accessibilityState={{ selected: inputMode === mode }} onPress={() => setInputMode(mode)} style={[styles.quality, inputMode === mode && styles.selectedRow]}><Icon name={mode === "trackpad" ? "Touchpad" : "Hand"} size={18} color={theme.colors.foreground} /><Text style={styles.rowTitle}>{mode === "trackpad" ? "Trackpad" : "Touchscreen"}</Text></Pressable>)}</View>
              <Text style={styles.description}>{inputMode === "trackpad" ? "One finger moves the pointer. Tap to click, two-finger tap to right-click, two-finger slide to scroll. Hold one finger, then move to drag. Pinch to zoom; the picture follows the pointer near its edges." : "Tap where you want to click. Long-press to right-click. Pinch to zoom, then slide one finger to pan. Physical mouse input stays unchanged in either mode."}</Text>
              <Action styles={styles} label={feedbackEnabled ? "Haptic feedback: on" : "Haptic feedback: off"} onPress={() => setFeedbackEnabled(!feedbackEnabled)} />
              <Text style={styles.description}>Click feedback happens on this device, without waiting for the host. Vibration depends on the device and system settings.</Text>
              <View style={styles.rule} />
              <Text style={styles.sectionLabel}>PICTURE QUALITY</Text>
              <View style={styles.qualityRow}>{QUALITIES.map((quality, index) => <Pressable key={quality.label} accessibilityRole="button" accessibilityLabel={`${quality.label} quality`} accessibilityState={{ selected: index === qualityIndex }} onPress={() => setQualityIndex(index)} style={[styles.quality, index === qualityIndex && styles.selectedRow]}><Text style={styles.rowTitle}>{quality.label}</Text><Text style={styles.description}>{["Less data", "Everyday", "More detail"][index]}</Text></Pressable>)}</View>
              <Text style={styles.sectionLabel}>LIVE CONNECTION</Text>
              <View style={styles.metrics}><Metric label={direct.active ? "VIDEO FPS" : "UPDATES/S"} value={paused ? "—" : (direct.active ? direct.fps : frames.fps).toFixed(1)} styles={styles} /><Metric label="ROUND TRIP" value={direct.active && direct.rttMs === null ? "—" : `${direct.active ? direct.rttMs : frames.latencyMs} ms`} styles={styles} /><Metric label={direct.active ? "VIDEO RATE" : "FRAME"} value={direct.active ? `${direct.kbps} kbps` : `${frames.kilobytes} KB`} styles={styles} /></View>
              <View style={styles.transport}><View style={[styles.dot, { backgroundColor: direct.active ? theme.colors.accent : theme.colors.foregroundMuted }]} /><Text style={styles.rowTitle}>{direct.active ? "WebRTC · H.264 · Encrypted" : direct.connecting ? "Connecting direct video…" : "Paseo · JPEG frames"}</Text></View>
              {direct.supported && !managedSelection && lastGood.current?.webrtc ? <><Action styles={styles} label={preferDirect ? "Use Paseo transport only" : "Try direct WebRTC video"} onPress={() => setPreferDirect(!preferDirect)} /><Text style={styles.description}>Direct video uses encrypted peer-to-peer media. Signalling and input stay on Paseo. If direct video cannot connect, frames automatically use Paseo instead.</Text>{direct.reason ? <Text style={styles.description}>{direct.reason}</Text> : null}</> : <Text style={styles.description}>Uses your existing Paseo connection. No separate VNC port or public screen URL.</Text>}
              {hostControl.known ? <><View style={styles.rule} /><Text style={styles.sectionLabel}>HOST SAFETY</Text><Text style={styles.description}>Unlike View only, this stops remote input for everyone connected to this computer.</Text><Action styles={styles} label={hostControl.changing ? "Updating…" : hostControl.paused ? "Resume control for everyone" : "Pause control for everyone"} disabled={hostControl.changing} onPress={() => hostControl.setPaused(!hostControl.paused)} /></> : null}
              {hostPlatform === "win32" ? <Text style={styles.description}>Windows support is experimental. UAC and secure desktops cannot be controlled.</Text> : null}
            </> : <ClipboardPanel styles={styles} enabled={controlling} onPaste={pasteOnHost} onRead={() => void pasteLocalClipboard()} onCopy={clipboard.supported ? clipboard.pull : undefined} />}
          </ScrollView>
        </View> : null}
      </View>
      {keyboard ? <KeyboardTray enabled={controlling} niri={lastGood.current?.backend === "niri-native"} hostPlatform={hostPlatform} send={send} paste={pasteOnHost} onClose={() => setKeyboard(false)} /> : null}
    </View>
  );
}

function displayKindLabel(display: ScreenDisplay, hostPlatform: string): string {
  if (display.managedVirtual) return "Virtual fallback";
  if (display.kind === "virtual") return "Virtual display";
  if (display.kind === undefined && hostPlatform !== "win32") return "Display";
  if (display.kind === "physical") return "Physical";
  if (display.kind === "fallback") return "Windows fallback";
  return "Unknown";
}

function Action({ styles, label, disabled, onPress }: { styles: Styles; label: string; disabled?: boolean; onPress(): void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} accessibilityState={{ disabled: !!disabled }} onPress={onPress} style={[styles.action, disabled && { opacity: 0.4 }]}><Text style={styles.actionText}>{label}</Text></Pressable>;
}
function Metric({ styles, label, value }: { styles: Styles; label: string; value: string }) {
  return <View style={{ flex: 1, gap: 5 }}><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></View>;
}
function ClipboardPanel({ styles, enabled, onPaste, onRead, onCopy }: { styles: Styles; enabled: boolean; onPaste(text: string, shift?: boolean): void; onRead(): void; onCopy?: () => void }) {
  const [text, setText] = useState("");
  return <><Text style={styles.description}>Paste text here to send it to the focused app. Supports Chinese and multiline text. This replaces the host's text clipboard.</Text><TextInput accessibilityLabel="Text to paste on host" style={styles.clipboardInput} placeholder="Paste your text here…" placeholderTextColor={styles.description.color} value={text} onChangeText={setText} multiline maxLength={10000} editable={enabled} />
    <Action styles={styles} label="Paste on host" disabled={!enabled || !text} onPress={() => { onPaste(text); setText(""); }} />
    <Action styles={styles} label="Paste into terminal (Ctrl+Shift+V)" disabled={!enabled || !text} onPress={() => { onPaste(text, true); setText(""); }} />
    {isWeb ? <Action styles={styles} label="Read this device's clipboard" disabled={!enabled} onPress={onRead} /> : null}
    {onCopy ? <Action styles={styles} label="Copy from host" disabled={!enabled} onPress={onCopy} /> : null}
    {!enabled ? <Text style={styles.description}>Resume remote control to use the clipboard.</Text> : null}</>;
}
function KeyboardTray({ enabled, niri, hostPlatform, send, paste, onClose }: { enabled: boolean; niri: boolean; hostPlatform: string; send(event: ScreenInputEvent): void; paste(text: string): void; onClose(): void }) {
  const [text, setText] = useState("");
  const [modifiers, setModifiers] = useState<ScreenModifier[]>([]);
  const key = (keyCode: number) => { if (enabled) { send({ type: "key", keyCode, modifiers }); setModifiers([]); } };
  const submit = () => {
    if (!enabled || !text) return;
    if (niri && /[^\x20-\x7e\n\t\r]/.test(text)) paste(text);
    else {
      let chunk = "";
      for (const point of text) { if (chunk.length + point.length > 200) { send({ type: "text", text: chunk }); chunk = ""; } chunk += point; }
      if (chunk) send({ type: "text", text: chunk });
    }
    setText("");
  };
  useEffect(() => { if (!enabled) setModifiers([]); }, [enabled]);
  return <View style={base.keyboard}>
    <View style={base.composer}><Icon name="Keyboard" size={18} color={chrome.muted} /><TextInput accessibilityLabel="Type on the host" style={base.textInput} placeholder={enabled ? "Type on your computer…" : "Resume control to type"} placeholderTextColor={chrome.muted} autoCorrect={false} autoCapitalize="none" value={text} onChangeText={setText} onSubmitEditing={submit} editable={enabled} maxLength={10000} /><Key label="Send text" icon="ArrowUp" onPress={submit} disabled={!enabled || !text} /><Control small icon="X" label="Hide keyboard" onPress={onClose} /></View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={base.keyRow}>
      {(["ctrl", "alt", "shift", "cmd"] as ScreenModifier[]).map((modifier) => <Key key={modifier} label={modifier === "cmd" ? hostPlatform === "darwin" ? "Cmd" : "Super" : modifier === "ctrl" ? "Ctrl" : modifier === "alt" ? "Alt" : "Shift"} active={modifiers.includes(modifier)} disabled={!enabled} onPress={() => setModifiers((old) => old.includes(modifier) ? old.filter((item) => item !== modifier) : [...old, modifier])} />)}
      <View style={base.keyDivider} />
      {([["Esc", KEY.escape], ["Tab", KEY.tab], ["Enter", KEY.enter], ["Backspace", KEY.backspace], ["←", KEY.left], ["↑", KEY.up], ["↓", KEY.down], ["→", KEY.right]] as const).map(([label, code]) => <Key key={label} label={label} onPress={() => key(code)} disabled={!enabled} />)}
      <Key label={hostPlatform === "darwin" ? "Cmd+C" : "Ctrl+C"} disabled={!enabled} onPress={() => send({ type: "key", char: "c", modifiers: [hostPlatform === "darwin" ? "cmd" : "ctrl"] })} />
      <View style={base.keyDivider} />
      <Key label={hostPlatform === "darwin" ? "Cmd+Tab" : "Alt+Tab"} disabled={!enabled} onPress={() => send({ type: "key", keyCode: KEY.tab, modifiers: [hostPlatform === "darwin" ? "cmd" : "alt"] })} />
      <Key label={hostPlatform === "darwin" ? "Cmd+Space" : hostPlatform === "win32" ? "Start" : "Super"} disabled={!enabled} onPress={() => send({ type: "key", keyCode: hostPlatform === "darwin" ? KEY.space : KEY.command, modifiers: hostPlatform === "darwin" ? ["cmd"] : [] })} />
      <Key label={hostPlatform === "darwin" ? "Cmd+W" : "Ctrl+W"} disabled={!enabled} onPress={() => send({ type: "key", char: "w", modifiers: [hostPlatform === "darwin" ? "cmd" : "ctrl"] })} />
      {hostPlatform !== "darwin" ? <Key label="Alt+F4" disabled={!enabled} onPress={() => send({ type: "key", keyCode: KEY.f4, modifiers: ["alt"] })} /> : <Key label="Cmd+Q" disabled={!enabled} onPress={() => send({ type: "key", char: "q", modifiers: ["cmd"] })} />}
      <Key label="Workspace left" icon="ChevronLeft" disabled={!enabled} onPress={() => send({ type: "key", keyCode: KEY.left, modifiers: hostPlatform === "darwin" ? ["ctrl"] : hostPlatform === "win32" ? ["ctrl", "cmd"] : ["ctrl", "alt"] })} />
      <Key label="Workspace right" icon="ChevronRight" disabled={!enabled} onPress={() => send({ type: "key", keyCode: KEY.right, modifiers: hostPlatform === "darwin" ? ["ctrl"] : hostPlatform === "win32" ? ["ctrl", "cmd"] : ["ctrl", "alt"] })} />
    </ScrollView>
  </View>;
}
function PermissionNotice({ status, requesting, onRequest, styles }: { status: ScreenStatus; requesting: boolean; onRequest(): void; styles: Styles }) {
  if (!status.supported || status.error) return <><Icon name="CircleAlert" size={25} color={styles.description.color} /><Text style={styles.panelTitle}>Screen unavailable</Text><Text selectable style={styles.description}>{status.error ?? "This host is not supported."}</Text></>;
  const portal = status.platform === "linux" && status.backend === "wayland";
  return <><Icon name="ShieldCheck" size={25} color={styles.description.color} /><Text style={styles.panelTitle}>{status.screenRecording ? "View-only permission" : "Allow screen sharing"}</Text><Text style={styles.description}>{portal ? status.awaitingApproval ? "Waiting for someone at the host to approve screen sharing and remote interaction." : `${status.permissionError ? `${status.permissionError} ` : ""}Approve sharing on the host. Turn on Allow Remote Interaction, and Allow Clipboard Access for copy and paste.` : status.platform === "linux" ? "This Linux host is missing input or capture support. Check the host's screen backend." : "Allow Screen Recording and Accessibility for Paseo in System Settings → Privacy & Security, then restart Paseo on the Mac."}</Text><Action styles={styles} label={requesting ? "Requesting…" : "Show prompt on host"} disabled={requesting} onPress={onRequest} /></>;
}

const base = StyleSheet.create({
  keyboard: { backgroundColor: "#15181d", borderTopWidth: 1, borderColor: chrome.border, padding: 10, gap: 8 },
  composer: { flexDirection: "row", alignItems: "center", gap: 8 },
  textInput: { flex: 1, minWidth: 0, height: 40, backgroundColor: "#22272f", color: chrome.text, borderRadius: 10, paddingHorizontal: 12, fontSize: 14 },
  keyRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingBottom: 2 },
  keyDivider: { width: 1, height: 22, backgroundColor: chrome.border, marginHorizontal: 4 },
});
type Styles = ReturnType<typeof createStyles>;
function createStyles({ colors: c }: PluginTheme) {
  return StyleSheet.create({
    screen: { flex: 1, minHeight: 0, width: "100%", backgroundColor: c.surface0, overflow: "hidden" },
    fallbackBanner: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, backgroundColor: c.surface1, borderBottomWidth: 1, borderColor: c.border },
    viewport: { flex: 1, minHeight: 0, position: "relative", backgroundColor: "#050608" },
    picture: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
    empty: { alignItems: "center", gap: 12, padding: 24 },
    emptyTitle: { color: chrome.text, fontSize: 17, fontWeight: "500", textAlign: "center" },
    top: { position: "absolute", flexDirection: "row", alignItems: "center", gap: 8, zIndex: 10 },
    side: { flex: 1, flexDirection: "row", alignItems: "center", minWidth: 0 },
    rightSide: { justifyContent: "flex-end", gap: 8 },
    hostPill: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: chrome.surface, borderWidth: 1, borderColor: chrome.border, borderRadius: 15, paddingHorizontal: 14, paddingVertical: 9, maxWidth: "100%" },
    hostName: { color: chrome.text, fontSize: 13, fontWeight: "600", maxWidth: 150 },
    eyebrow: { color: chrome.muted, fontSize: 8, letterSpacing: 1.6, marginTop: 3 },
    resolution: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 11, paddingHorizontal: 13, borderWidth: 1, borderColor: chrome.border, borderRadius: 24, backgroundColor: chrome.surface },
    resolutionText: { color: chrome.text, fontSize: 12, fontWeight: "500", fontVariant: ["tabular-nums"] },
    dot: { width: 6, height: 6, borderRadius: 3 },
    bottom: { position: "absolute", alignSelf: "center", alignItems: "center", gap: 12, zIndex: 10 },
    dock: { flexDirection: "row", alignItems: "center", gap: 5, padding: 7, borderWidth: 1, borderColor: chrome.border, borderRadius: 30, backgroundColor: chrome.surface },
    divider: { width: 1, height: 19, backgroundColor: chrome.border, marginHorizontal: 3 },
    controlMode: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 7, height: 36 },
    modeLabel: { fontSize: 12, fontWeight: "500" },
    hint: { color: chrome.muted, fontSize: 11, textAlign: "center" },
    reveal: { position: "absolute", right: 16, bottom: 16, zIndex: 10 },
    toast: { position: "absolute", left: 16, right: 16, alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 8, padding: 8, borderWidth: 1, borderColor: chrome.border, borderRadius: 12, backgroundColor: chrome.surface, zIndex: 15, maxWidth: 600 },
    toastText: { color: chrome.text, flex: 1, fontSize: 12 },
    locked: { position: "absolute", bottom: 118, alignSelf: "center", flexDirection: "row", gap: 8, backgroundColor: chrome.surface, padding: 10, borderRadius: 12 },
    centerOverlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", padding: 20 },
    notice: { maxWidth: 380, width: "100%", backgroundColor: c.surface1, borderRadius: 18, borderWidth: 1, borderColor: c.border, padding: 22, gap: 14, alignItems: "center" },
    panel: { position: "absolute", backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 18, zIndex: 30, overflow: "hidden", shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 10 },
    panelHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 18, paddingRight: 10, paddingTop: 10, paddingBottom: 8, borderBottomWidth: 1, borderColor: c.border },
    panelTitle: { color: c.foreground, fontSize: 16, fontWeight: "600" },
    close: { padding: 10 },
    panelBody: { padding: 16, gap: 14 },
    description: { color: c.foregroundMuted, fontSize: 12, lineHeight: 18 },
    displayRow: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 12 },
    selectedRow: { borderColor: c.accent, backgroundColor: c.surface2 },
    rowTitle: { color: c.foreground, fontSize: 12, fontWeight: "600" },
    sectionLabel: { color: c.foregroundMuted, fontSize: 10, fontWeight: "600", letterSpacing: 1.2 },
    qualityRow: { flexDirection: "row", gap: 6 },
    quality: { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingVertical: 12, alignItems: "center", gap: 5 },
    metrics: { flexDirection: "row", gap: 8, paddingVertical: 3 },
    transport: { flexDirection: "row", alignItems: "center", gap: 8 },
    metricValue: { color: c.foreground, fontSize: 17, fontWeight: "500", fontVariant: ["tabular-nums"] },
    metricLabel: { color: c.foregroundMuted, fontSize: 8, letterSpacing: 0.8 },
    rule: { height: 1, backgroundColor: c.border, marginVertical: 3 },
    action: { backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11, alignItems: "center" },
    actionText: { color: c.foreground, fontSize: 12, fontWeight: "500" },
    clipboardInput: { minHeight: 110, maxHeight: 180, backgroundColor: c.surface0, color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, fontSize: 13, textAlignVertical: "top" },
  });
}
