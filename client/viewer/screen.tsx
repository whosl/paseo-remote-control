import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PixelRatio, Platform, ScrollView, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import { chooseDisplayRpc, displayFallbackRpc, requestPermissionsRpc, statusRpc, videoConfigRpc, videoClientEventRpc, videoOfferRpc, videoPingRpc, videoStopRpc, type ScreenDisplay, type ScreenInputEvent, type ScreenModifier, type ScreenStatus } from "../../shared/screen/rpc";
import { readLocalClipboard, useHostClipboard } from "./clipboard";
import { useControlPause } from "./control";
import { chrome, Control, Key } from "./controls";
import { FeedbackPressable as Pressable, FeedbackProvider, useFeedback } from "./feedback";
import { fitContent } from "./geometry";
import { isAppleClient, KEY, keyMapping } from "./keys";
import { TouchStage } from "./touch-stage";
import type { InputMode } from "./touch-controller";
import { QUALITIES, useFrames, useInputQueue } from "./use-screen";
import { formatBandwidth } from "./frame-metrics";
import { useViewerSession } from "./use-viewer-session";
import { useDirectVideo, useFullscreen } from "./web";
import { useNativeVideo } from "./native-video";
import { useWebInput } from "./web-input";
import { useOwnership } from "../ownership";
import { localizeRemoteText, useRemoteTranslation, type RemoteTranslate } from "../messages";

const isWeb = Platform.OS === "web";
type Panel = "displays" | "settings" | "clipboard";

export function RemoteScreen(props: PluginScreenProps) {
  const [feedback, setFeedback] = useState(true);
  return <FeedbackProvider enabled={feedback}><ScreenViewer {...props} feedbackEnabled={feedback} setFeedbackEnabled={setFeedback} /></FeedbackProvider>;
}

function ScreenViewer({ theme, layout, host, feedbackEnabled, setFeedbackEnabled }: PluginScreenProps & { feedbackEnabled: boolean; setFeedbackEnabled(value: boolean): void }) {
  const viewer = useViewerSession(host.id);
  const { t } = useRemoteTranslation();
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
  const configureVideo = useRpc(videoConfigRpc);
  const reportVideo = useRpc(videoClientEventRpc);
  const pingVideo = useRpc(videoPingRpc);
  const stopVideo = useRpc(videoStopRpc);
  const [preferDirect, setPreferDirect] = useState(true);
  const [videoAttempt, setVideoAttempt] = useState(0);
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
  const directEnabled = canCapture && !paused && preferDirect && !managedSelection && lastGood.current?.webrtc === true;
  const videoWidth = Math.max(320, Math.min(quality.maxWidth, wanted));
  const videoFps = [30, 24, 15][qualityIndex]!;
  const browserDirect = useDirectVideo(videoNode, isWeb && directEnabled, display?.id, videoWidth, videoFps, { config: () => configureVideo({}), offer: offerVideo, ping: pingVideo, stop: stopVideo }, videoAttempt);
  const nativeDirect = useNativeVideo(!isWeb && directEnabled, display?.id, videoWidth, videoFps, { config: () => configureVideo({}), report: reportVideo, offer: offerVideo, ping: pingVideo, stop: stopVideo }, paused, videoAttempt);
  const direct = isWeb ? browserDirect : nativeDirect;
  const frames = useFrames(canCapture && !paused && !direct.active, display?.id, quality, content.width * Math.ceil(zoom), lastGood.current?.frameWait === true, display?.stableKey, lastGood.current?.platform);
  const frameAspect = frames.display ? frames.display.width / frames.display.height : null;
  useEffect(() => { if (frameAspect) setAspect(frameAspect); }, [frameAspect]);
  const frameMatchesDisplay = !!frames.uri && !!frames.display && frames.display.id === display?.id
    && (display?.stableKey === undefined || frames.display.stableKey === display.stableKey)
    && (!fallback?.selectedKey || frames.display.stableKey === fallback.selectedKey);
  const ownership = useOwnership(host.id, viewer.viewerId);
  const hostControlBase = useControlPause(host.id);
  const hostControl = { ...hostControlBase, paused: ownership.state?.paused ?? hostControlBase.paused };
  useEffect(() => { if (!hostControl.paused) setInputError(null); }, [hostControl.paused]);
  const controlling = !!viewer.viewerId && ((direct.active && !managedSelection) || frameMatchesDisplay) && !fallbackChange.isPending && control && !paused && lastGood.current?.accessibility === true && !hostControl.paused && ownership.known && ownership.state?.mode !== "agent" && !ownership.changing;
  const send = useInputQueue(display?.id, setInputError, chooseDisplay, frames.display?.stableKey, controlling, viewer.viewerId);
  const clipboard = useHostClipboard(controlling && ownership.state?.humanPriority === true, viewer.viewerId);
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
  const message = localizeRemoteText(inputError ?? viewer.error ?? ownership.error ?? (direct.active ? null : frames.error) ?? clipboard.message, t);
  const permissionMissing = !!status.data && (!status.data.supported || !!status.data.error || !status.data.screenRecording || !status.data.accessibility);
  const fps = paused ? "—" : (direct.active ? direct.fps : frames.fps).toFixed(1);
  const bandwidth = paused ? "—" : formatBandwidth(direct.active ? direct.kbps : frames.kbps);
  const connectionMode = direct.active ? direct.relay === true ? t("webrtcRelay") : direct.relay === false ? t("webrtcDirect") : "WebRTC / H.264" : "Paseo / JPEG";
  const agentActive = ownership.state?.mode === "agent";

  return (
    <View ref={setRootNode} style={styles.screen}>
      {fallback?.state === "return-available" ? <View accessibilityLiveRegion="polite" style={styles.fallbackBanner}>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text style={styles.rowTitle}>{t("physicalReconnected")}</Text>
          <Text style={styles.description}>{t("physicalReconnectedHint")}</Text>
          {fallbackChange.error ? <Text style={styles.description}>{localizeRemoteText(fallbackChange.error.message, t)}</Text> : null}
        </View>
        <Action styles={styles} label={fallbackChange.isPending ? t("switching") : t("switchBack")} disabled={fallbackChange.isPending || fallback.returnDisplay === null} onPress={() => fallbackChange.mutate("return-physical")} />
      </View> : null}
      {agentActive ? <View accessibilityLabel={t("ownershipNotice")} style={styles.agentNotice}>
        <Icon name="Bot" size={16} color={theme.colors.accent} />
        <Text accessibilityLiveRegion="polite" numberOfLines={1} style={styles.agentNoticeText}>{t("agentControlling", { agent: localizeRemoteText(ownership.state?.label, t) })}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t("takeOverAgent")} disabled={ownership.changing || ownership.state?.paused} onPress={ownership.takeOver} style={[styles.agentTakeover, (ownership.changing || ownership.state?.paused) && { opacity: 0.45 }]}>
          <Text style={styles.agentTakeoverText}>{ownership.changing ? t("switching") : t("takeOver")}</Text>
        </Pressable>
      </View> : null}
      <View style={styles.viewport} onLayout={(event: LayoutChangeEvent) => setStage(event.nativeEvent.layout)}>
        <View style={styles.picture}>
          {frames.uri ? <TouchStage uri={paused && direct.still ? direct.still : frames.uri} stage={stage} content={content} rotated={!isWeb && rotated} controlling={controlling} mode={inputMode} send={send} onZoomChange={setZoom} onPictureNode={setViewNode} onVideoNode={setVideoNode} nativeVideo={nativeDirect.video} />
          : <View style={styles.empty}>
              <Icon name="Monitor" size={32} color={chrome.muted} />
              <Text style={styles.emptyTitle}>{status.isLoading ? t("connectingComputer") : canCapture ? t("startingScreen") : t("screenWillAppear")}</Text>
              <Text style={styles.hint}>{t("privateView", { host: host.label })}</Text>
            </View>}
        </View>

        {!minimal ? <>
          <View pointerEvents="box-none" style={[styles.top, { top: short ? 10 : 20, left: compact ? 12 : 24, right: compact ? 12 : 24, gap: tiny ? 4 : 8 }]}>
            <View pointerEvents="box-none" style={styles.side}>
              {compact ? <Control small={tiny} icon="Monitor" label={t("connectedHost", { host: host.label })} onPress={() => togglePanel("displays")} /> :
                <Pressable accessibilityRole="button" accessibilityLabel={t("chooseDisplay")} onPress={() => togglePanel("displays")} style={styles.hostPill}>
                  <Icon name="Monitor" size={18} color={chrome.muted} /><View><Text style={styles.hostName} numberOfLines={1}>{host.label}</Text><Text style={styles.eyebrow}>{t("remoteScreenEyebrow")}</Text></View>
                </Pressable>}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={t("displaySelector")} onPress={() => togglePanel("displays")} style={styles.resolution}>
              <View style={[styles.dot, { backgroundColor: paused || frames.asleep ? chrome.muted : frames.error && !direct.active ? theme.colors.statusWarning : chrome.blue }]} />
              <Text style={styles.resolutionText}>{display ? `${display.pixelWidth} × ${display.pixelHeight}` : t("connecting")}</Text>
              <Icon name="ChevronDown" size={13} color={chrome.muted} />
            </Pressable>
            <View pointerEvents="box-none" style={[styles.side, styles.rightSide, { gap: tiny ? 4 : 8 }]}>
              {!compact && fullscreen.supported ? <Control icon={fullscreen.active ? "Minimize" : "Maximize"} label={fullscreen.active ? t("exitFullscreen") : t("fullscreen")} onPress={toggleFullscreen} /> : null}
              <Control small={tiny} above={false} icon="Keyboard" label={keyboard ? t("hideKeyboard") : t("showKeyboard")} active={keyboard} onPress={() => setKeyboard(!keyboard)} />
              <Control small={tiny} above={false} icon="SlidersHorizontal" label={t("screenSettings")} active={panel === "settings"} onPress={() => togglePanel("settings")} />
            </View>
          </View>

          <View pointerEvents="box-none" style={[styles.bottom, { bottom: short ? 10 : compact ? 20 : 24 }]}>
            <View style={styles.dock}>
              <Control small icon={paused ? "Play" : "Pause"} label={paused ? t("resumePicture") : t("pausePicture")} active={paused} onPress={() => setPaused(!paused)} />
              <View style={styles.divider} />
              <Pressable accessibilityRole="button" accessibilityLabel={control ? t("switchViewOnly") : t("enableRemoteControl")} accessibilityHint={ownership.state?.humanPriority ? t("humanPriority") : undefined} accessibilityState={{ selected: control }} onPress={() => setControl(!control)} style={styles.controlMode}>
                <View style={styles.inputIcon}>
                  <Icon name={controlling ? "MousePointer2" : "Eye"} size={17} color={controlling ? chrome.green : chrome.muted} />
                  {ownership.known && ownership.state?.humanPriority ? <View pointerEvents="none" style={styles.priorityBadge}><Icon name="ShieldCheck" size={10} color={chrome.green} /></View> : null}
                </View>
                {!compact ? <Text style={[styles.modeLabel, { color: controlling ? chrome.green : chrome.text }]}>{controlling ? t("control") : t("viewOnly")}</Text> : null}
              </Pressable>
              <View style={styles.divider} />
              <Control small icon="Clipboard" label={t("clipboard")} active={panel === "clipboard"} onPress={() => togglePanel("clipboard")} />
              <Control small icon={inputMode === "trackpad" ? "Touchpad" : "Hand"} label={inputMode === "trackpad" ? t("switchTouchscreen") : t("switchTrackpad")} active={inputMode === "trackpad"} onPress={() => setInputMode(inputMode === "trackpad" ? "touchscreen" : "trackpad")} />
              {!isWeb ? <Control small icon="RotateCw" label={t("rotatePicture")} active={rotated} onPress={() => setRotated(!rotated)} /> : null}
              {compact && fullscreen.supported ? <Control small icon={fullscreen.active ? "Minimize" : "Maximize"} label={fullscreen.active ? t("exitFullscreen") : t("fullscreen")} onPress={toggleFullscreen} /> : null}
              <Control small icon="PanelBottomClose" label={t("hideControls")} onPress={() => { setPanel(null); setMinimal(true); }} />
            </View>
            {inputMode === "trackpad" ? <Text pointerEvents="none" style={[styles.hint, { maxWidth: compact ? 290 : undefined }]}>{controlling ? t("trackpadHint") : t("viewOnlyDisabled")}</Text> : !compact && !short ? <Text pointerEvents="none" style={styles.hint}>{controlling ? t("controlHint") : t("viewOnlyHint")}</Text> : null}
          </View>
        </> : <View style={styles.reveal}><Control above icon="Ellipsis" label={t("showControls")} onPress={() => setMinimal(false)} /></View>}

        {(direct.active ? status.data?.locked : frames.locked) && !frames.asleep ? <View pointerEvents="none" style={styles.locked}><Icon name="LockKeyhole" size={14} color={chrome.text} /><Text style={styles.hint}>{hostPlatform === "win32" ? t("unlockPc") : t("unlockScreen")}</Text></View> : null}
        {message ? <View style={[styles.toast, { top: short ? 62 : 88 }]}><Icon name={frames.error || inputError ? "CircleAlert" : "ClipboardCheck"} size={16} color={chrome.blue} /><Text selectable style={styles.toastText}>{message}</Text><Control small icon="X" label={t("dismissMessage")} onPress={() => { setInputError(null); clipboard.setMessage(null); }} /></View> : null}

        {permissionMissing ? <View style={styles.centerOverlay} pointerEvents="box-none"><View style={styles.notice}><PermissionNotice status={status.data!} requesting={request.isPending} onRequest={() => request.mutate()} styles={styles} /></View></View>
          : paused || frames.asleep || hostControl.paused ? <View pointerEvents="box-none" style={styles.centerOverlay}><View style={styles.notice}>
            <Icon name={frames.asleep ? "Moon" : "Pause"} size={24} color={theme.colors.foregroundMuted} />
            <Text style={styles.panelTitle}>{frames.asleep ? t("displayAsleep") : hostControl.paused ? t("hostControlPaused") : t("picturePaused")}</Text>
            <Text style={styles.description}>{hostControl.paused ? t("hostPausedHint") : t("resumeInputHint")}</Text>
            <Action styles={styles} label={frames.asleep ? t("wakeDisplay") : hostControl.paused ? t("resumeHostControl") : t("resumePicture")} onPress={() => { if (frames.asleep) frames.wake(); if (hostControl.paused) hostControl.setPaused(false); setPaused(false); }} />
          </View></View> : null}

        {panel && !minimal ? <View style={[styles.panel, compact ? { left: 12, right: 12, top: 68, maxHeight: Math.max(130, stage.height - 144) } : { right: 24, top: 84, width: 342, maxHeight: Math.max(150, stage.height - 190) }]}>
          <View style={styles.panelHeader}><Text style={styles.panelTitle}>{panel === "displays" ? t("yourDisplays") : panel === "settings" ? t("screenSettings") : t("clipboard")}</Text><Pressable accessibilityRole="button" accessibilityLabel={t("closePanel")} onPress={() => setPanel(null)} style={styles.close}><Icon name="X" size={18} color={theme.colors.foregroundMuted} /></Pressable></View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.panelBody}>
            {panel === "displays" ? <>
              <Text style={styles.description}>{t("chooseScreenHint")}</Text>
              {fallback?.state === "virtual" || fallback?.state === "return-available" ? <Text style={styles.description}>{t("virtualActive")}</Text> : null}
              {displays.map((item) => <Pressable key={item.stableKey ?? item.id} accessibilityRole="button" accessibilityLabel={t("viewDisplay", { name: item.name, kind: displayKindLabel(item, hostPlatform, t) })} accessibilityState={{ selected: item.id === display?.id }} onPress={() => { chooseDisplay(item.id); frames.wake(); setPanel(null); }} style={[styles.displayRow, item.id === display?.id && styles.selectedRow]}>
                <Icon name={item.builtin ? "Laptop" : "Monitor"} size={22} color={item.id === display?.id ? theme.colors.accent : theme.colors.foregroundMuted} />
                <View style={{ flex: 1, gap: 4 }}><Text style={styles.rowTitle} numberOfLines={2}>{item.name}</Text><Text style={styles.description}>{displayKindLabel(item, hostPlatform, t)} · {item.pixelWidth} × {item.pixelHeight}{item.main ? t("mainSuffix") : ""}</Text></View>
                {item.id === display?.id ? <Icon name="Check" size={18} color={theme.colors.accent} /> : null}
              </Pressable>)}
            </> : panel === "settings" ? <>
              <Text style={styles.sectionLabel}>{t("qualitySection")}</Text>
              <View style={styles.qualityRow}>{QUALITIES.map((quality, index) => <Pressable key={quality.label} accessibilityRole="button" accessibilityLabel={t("qualityLabel", { quality: t((["qualityFast", "qualityBalanced", "qualitySharp"] as const)[index]!) })} accessibilityState={{ selected: index === qualityIndex }} onPress={() => setQualityIndex(index)} style={[styles.quality, index === qualityIndex && styles.selectedRow]}><Text style={styles.rowTitle}>{t((["qualityFast", "qualityBalanced", "qualitySharp"] as const)[index]!)}</Text><Text style={styles.description}>{[t("lessData"), t("everyday"), t("moreDetail")][index]}</Text></Pressable>)}</View>
              <View style={styles.connectionStats}>
                <Text accessibilityLabel={t("frameRateLabel", { value: fps })} style={styles.connectionStat}>{`${fps} fps`}</Text>
                <Text accessibilityLabel={t("bandwidthLabel", { value: bandwidth })} style={styles.connectionStat}>{bandwidth}</Text>
                {direct.supported && !managedSelection && lastGood.current?.webrtc
                  ? <Pressable accessibilityRole="button" accessibilityLabel={direct.active ? t("paseoOnly") : t("tryWebrtc")} accessibilityHint={t("connectionModeLabel", { mode: connectionMode })} onPress={() => {
                      if (direct.active) setPreferDirect(false);
                      else { setPreferDirect(true); setVideoAttempt(value => value + 1); }
                    }}><Text style={[styles.connectionStat, { textDecorationLine: "underline" }]}>{connectionMode}</Text></Pressable>
                  : <Text accessibilityLabel={t("connectionModeLabel", { mode: connectionMode })} style={styles.connectionStat}>{connectionMode}</Text>}
              </View>
              {preferDirect && (direct.connecting || direct.reason) ? <Text style={styles.description}>{direct.connecting ? t("connectingVideo") : localizeRemoteText(direct.reason, t)}</Text> : null}
              <View style={styles.rule} />
              <Text style={styles.sectionLabel}>{t("inputSection")}</Text>
              <View style={styles.qualityRow}>{(["touchscreen", "trackpad"] as InputMode[]).map((mode) => <Pressable key={mode} accessibilityRole="button" accessibilityLabel={t("selectInputMode", { mode: mode === "trackpad" ? t("trackpad") : t("touchscreen") })} accessibilityState={{ selected: inputMode === mode }} onPress={() => setInputMode(mode)} style={[styles.quality, inputMode === mode && styles.selectedRow]}><Icon name={mode === "trackpad" ? "Touchpad" : "Hand"} size={18} color={theme.colors.foreground} /><Text style={styles.rowTitle}>{mode === "trackpad" ? t("trackpad") : t("touchscreen")}</Text></Pressable>)}</View>
              <Text style={styles.description}>{inputMode === "trackpad" ? t("trackpadDescription") : t("touchscreenDescription")}</Text>
              <Action styles={styles} label={feedbackEnabled ? t("hapticsOn") : t("hapticsOff")} onPress={() => setFeedbackEnabled(!feedbackEnabled)} />
              <Text style={styles.description}>{t("hapticsHint")}</Text>
              <View style={styles.rule} />
              <Text style={styles.sectionLabel}>{t("ownershipSection")}</Text>
              <Text style={styles.description}>{t("ownerHint", { owner: localizeRemoteText(ownership.state?.label, t) ?? t("connectingEllipsis") })}</Text>
              <Action styles={styles} label={ownership.changing ? t("switchingControl") : t("takeControlStopAgents")} disabled={ownership.changing} onPress={ownership.takeOver} />
              {ownership.state?.humanPriority && !agentActive ? <>
                <Text style={styles.description}>{t("agentsBlocked")}</Text>
                <Action styles={styles} label={ownership.changing ? t("switchingControl") : t("allowAgents")} disabled={ownership.changing || !ownership.known || ownership.state.paused} onPress={ownership.allowAgents} />
                {ownership.state.paused ? <Text style={styles.description}>{t("allowAgentsResume")}</Text> : null}
              </> : ownership.known && !agentActive ? <Text style={styles.description}>{t("agentsAllowedHint")}</Text> : null}
              <View style={styles.rule} />
              {hostPlatform === "win32" ? <>
                <Text style={styles.sectionLabel}>{t("windowsHeadless")}</Text>
                <Text style={styles.description}>{t("fallbackHint")}</Text>
                <Text style={styles.description}>{!fallback ? t("fallbackUnsupported") : !fallback.provisioned ? t("fallbackProvisioning") : localizeRemoteText(fallback.message, t)}</Text>
                {fallback ? <Pressable accessibilityRole="switch" accessibilityLabel={t("automaticHeadlessFallback")} accessibilityState={{ checked: fallback.enabled, disabled: !fallback.provisioned || fallbackChange.isPending }} disabled={!fallback.provisioned || fallbackChange.isPending} onPress={() => fallbackChange.mutate(fallback.enabled ? "disable" : "enable")} style={[styles.displayRow, (!fallback.provisioned || fallbackChange.isPending) && { opacity: 0.5 }]}>
                  <Text style={[styles.rowTitle, { flex: 1 }]}>{t("automaticFallback")}</Text><Text style={styles.description}>{fallbackChange.isPending ? t("updating") : fallback.enabled ? t("on") : t("off")}</Text>
                </Pressable> : null}
                {fallback?.state === "virtual" || fallback?.state === "return-available" ? <Text style={styles.description}>{t("virtualActive")}</Text> : null}
                {fallback && !fallback.provisioned && fallback.message ? <Text style={styles.description}>{localizeRemoteText(fallback.message, t)}</Text> : null}
                {fallback?.state === "error" && fallback.provisioned ? <Action styles={styles} label={fallbackChange.isPending ? t("retrying") : t("retryFallback")} disabled={fallbackChange.isPending} onPress={() => fallbackChange.mutate("enable")} /> : null}
                {fallback?.error || fallbackChange.error ? <Text selectable accessibilityLiveRegion="polite" style={[styles.description, { color: theme.colors.statusWarning }]}>{localizeRemoteText(fallbackChange.error?.message ?? fallback?.error, t)}</Text> : null}
                {status.data?.windowsTopology?.error ? <Text selectable style={styles.description}>{status.data.windowsTopology.error}</Text> : null}
                <View style={styles.rule} />
              </> : null}
              {hostControl.known ? <><Text style={styles.sectionLabel}>{t("hostSafety")}</Text><Text style={styles.description}>{t("hostSafetyHint")}</Text><Action styles={styles} label={hostControl.changing ? t("updating") : hostControl.paused ? t("resumeEveryone") : t("pauseEveryone")} disabled={hostControl.changing} onPress={() => hostControl.setPaused(!hostControl.paused)} /></> : null}
              {hostPlatform === "win32" ? <Text style={styles.description}>{t("windowsExperimental")}</Text> : null}
            </> : <ClipboardPanel styles={styles} enabled={controlling} onPaste={pasteOnHost} onRead={() => void pasteLocalClipboard()} onCopy={clipboard.supported ? clipboard.pull : undefined} />}
          </ScrollView>
        </View> : null}
      </View>
      {keyboard ? <KeyboardTray enabled={controlling} niri={lastGood.current?.backend === "niri-native"} hostPlatform={hostPlatform} send={send} paste={pasteOnHost} onClose={() => setKeyboard(false)} /> : null}
    </View>
  );
}

function displayKindLabel(display: ScreenDisplay, hostPlatform: string, t: RemoteTranslate): string {
  if (display.managedVirtual) return t("virtualFallback");
  if (display.kind === "virtual") return t("virtualDisplay");
  if (display.kind === undefined && hostPlatform !== "win32") return t("display");
  if (display.kind === "physical") return t("physical");
  if (display.kind === "fallback") return t("windowsFallback");
  return t("unknown");
}

function Action({ styles, label, disabled, onPress }: { styles: Styles; label: string; disabled?: boolean; onPress(): void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} accessibilityState={{ disabled: !!disabled }} onPress={onPress} style={[styles.action, disabled && { opacity: 0.4 }]}><Text style={styles.actionText}>{label}</Text></Pressable>;
}
function ClipboardPanel({ styles, enabled, onPaste, onRead, onCopy }: { styles: Styles; enabled: boolean; onPaste(text: string, shift?: boolean): void; onRead(): void; onCopy?: () => void }) {
  const { t } = useRemoteTranslation();
  const [text, setText] = useState("");
  return <><Text style={styles.description}>{t("clipboardDescription")}</Text><TextInput accessibilityLabel={t("pasteTextLabel")} style={styles.clipboardInput} placeholder={t("pastePlaceholder")} placeholderTextColor={styles.description.color} value={text} onChangeText={setText} multiline maxLength={10000} editable={enabled} />
    <Action styles={styles} label={t("pasteOnHost")} disabled={!enabled || !text} onPress={() => { onPaste(text); setText(""); }} />
    <Action styles={styles} label={t("pasteInTerminal")} disabled={!enabled || !text} onPress={() => { onPaste(text, true); setText(""); }} />
    {isWeb ? <Action styles={styles} label={t("readClipboard")} disabled={!enabled} onPress={onRead} /> : null}
    {onCopy ? <Action styles={styles} label={t("copyFromHost")} disabled={!enabled} onPress={onCopy} /> : null}
    {!enabled ? <Text style={styles.description}>{t("resumeClipboard")}</Text> : null}</>;
}
function KeyboardTray({ enabled, niri, hostPlatform, send, paste, onClose }: { enabled: boolean; niri: boolean; hostPlatform: string; send(event: ScreenInputEvent): void; paste(text: string): void; onClose(): void }) {
  const { t } = useRemoteTranslation();
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
    <View style={base.composer}><Icon name="Keyboard" size={18} color={chrome.muted} /><TextInput accessibilityLabel={t("typeOnHost")} style={base.textInput} placeholder={enabled ? t("typePlaceholder") : t("resumeTyping")} placeholderTextColor={chrome.muted} autoCorrect={false} autoCapitalize="none" value={text} onChangeText={setText} onSubmitEditing={submit} editable={enabled} maxLength={10000} /><Key label={t("sendText")} icon="ArrowUp" onPress={submit} disabled={!enabled || !text} /><Control small icon="X" label={t("hideKeyboard")} onPress={onClose} /></View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={base.keyRow}>
      {(["ctrl", "alt", "shift", "cmd"] as ScreenModifier[]).map((modifier) => <Key key={modifier} label={modifier === "cmd" ? hostPlatform === "darwin" ? "Cmd" : "Super" : modifier === "ctrl" ? "Ctrl" : modifier === "alt" ? "Alt" : "Shift"} active={modifiers.includes(modifier)} disabled={!enabled} onPress={() => setModifiers((old) => old.includes(modifier) ? old.filter((item) => item !== modifier) : [...old, modifier])} />)}
      <View style={base.keyDivider} />
      {([["Esc", KEY.escape], ["Tab", KEY.tab], ["Enter", KEY.enter], ["Backspace", KEY.backspace], ["←", KEY.left], ["↑", KEY.up], ["↓", KEY.down], ["→", KEY.right]] as const).map(([label, code]) => <Key key={label} label={label} onPress={() => key(code)} disabled={!enabled} />)}
      <Key label={hostPlatform === "darwin" ? "Cmd+C" : "Ctrl+C"} disabled={!enabled} onPress={() => send({ type: "key", char: "c", modifiers: [hostPlatform === "darwin" ? "cmd" : "ctrl"] })} />
      <View style={base.keyDivider} />
      <Key label={hostPlatform === "darwin" ? "Cmd+Tab" : "Alt+Tab"} disabled={!enabled} onPress={() => send({ type: "key", keyCode: KEY.tab, modifiers: [hostPlatform === "darwin" ? "cmd" : "alt"] })} />
      <Key label={hostPlatform === "darwin" ? "Cmd+Space" : hostPlatform === "win32" ? t("start") : "Super"} disabled={!enabled} onPress={() => send({ type: "key", keyCode: hostPlatform === "darwin" ? KEY.space : KEY.command, modifiers: hostPlatform === "darwin" ? ["cmd"] : [] })} />
      <Key label={hostPlatform === "darwin" ? "Cmd+W" : "Ctrl+W"} disabled={!enabled} onPress={() => send({ type: "key", char: "w", modifiers: [hostPlatform === "darwin" ? "cmd" : "ctrl"] })} />
      {hostPlatform !== "darwin" ? <Key label="Alt+F4" disabled={!enabled} onPress={() => send({ type: "key", keyCode: KEY.f4, modifiers: ["alt"] })} /> : <Key label="Cmd+Q" disabled={!enabled} onPress={() => send({ type: "key", char: "q", modifiers: ["cmd"] })} />}
      <Key label={t("workspaceLeft")} icon="ChevronLeft" disabled={!enabled} onPress={() => send({ type: "key", keyCode: KEY.left, modifiers: hostPlatform === "darwin" ? ["ctrl"] : hostPlatform === "win32" ? ["ctrl", "cmd"] : ["ctrl", "alt"] })} />
      <Key label={t("workspaceRight")} icon="ChevronRight" disabled={!enabled} onPress={() => send({ type: "key", keyCode: KEY.right, modifiers: hostPlatform === "darwin" ? ["ctrl"] : hostPlatform === "win32" ? ["ctrl", "cmd"] : ["ctrl", "alt"] })} />
    </ScrollView>
  </View>;
}
function PermissionNotice({ status, requesting, onRequest, styles }: { status: ScreenStatus; requesting: boolean; onRequest(): void; styles: Styles }) {
  const { t } = useRemoteTranslation();
  if (!status.supported || status.error) return <><Icon name="CircleAlert" size={25} color={styles.description.color} /><Text style={styles.panelTitle}>{t("screenUnavailable")}</Text><Text selectable style={styles.description}>{localizeRemoteText(status.error, t) ?? t("hostUnsupported")}</Text></>;
  const portal = status.platform === "linux" && status.backend === "wayland";
  return <><Icon name="ShieldCheck" size={25} color={styles.description.color} /><Text style={styles.panelTitle}>{status.screenRecording ? t("viewPermission") : t("allowSharing")}</Text><Text style={styles.description}>{portal ? status.awaitingApproval ? t("waitingApproval") : [status.permissionError, t("portalApproval")].filter(Boolean).join(" ") : status.platform === "linux" ? t("linuxMissingBackend") : t("macPermissions")}</Text><Action styles={styles} label={requesting ? t("requesting") : t("showHostPrompt")} disabled={requesting} onPress={onRequest} /></>;
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
    agentNotice: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: c.surface1, borderBottomWidth: 1, borderColor: c.border },
    agentNoticeText: { flex: 1, minWidth: 0, color: c.foreground, fontSize: 12, fontWeight: "500" },
    agentTakeover: { minHeight: 32, justifyContent: "center", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: c.accent },
    agentTakeoverText: { color: c.accentForeground, fontSize: 12, fontWeight: "600" },
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
    inputIcon: { width: 19, height: 20, alignItems: "center", justifyContent: "center" },
    priorityBadge: { position: "absolute", top: -4, right: -5, padding: 1, borderRadius: 6, backgroundColor: chrome.surface },
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
    connectionStats: { flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 3 },
    connectionStat: { color: c.foregroundMuted, fontSize: 11, lineHeight: 17, fontVariant: ["tabular-nums"] },
    rule: { height: 1, backgroundColor: c.border, marginVertical: 3 },
    action: { backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11, alignItems: "center" },
    actionText: { color: c.foreground, fontSize: 12, fontWeight: "500" },
    clipboardInput: { minHeight: 110, maxHeight: 180, backgroundColor: c.surface0, color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, fontSize: 13, textAlignVertical: "top" },
  });
}
