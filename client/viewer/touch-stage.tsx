import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { PanResponder, Platform, View, type GestureResponderEvent } from "react-native";
import type { ScreenInputEvent } from "../../shared/screen/rpc";
import { FrameImage } from "./frame-image";
import { useFeedback } from "./feedback";
import { type Size, type View2D } from "./geometry";
import { TouchController, type InputMode } from "./touch-controller";
import { useWebTouch } from "./web";

const isWeb = Platform.OS === "web";
const touchesOf = (event: GestureResponderEvent) => event.nativeEvent.touches.map((touch) => ({ x: touch.locationX, y: touch.locationY }));

export function TouchStage({ uri, stage, content, rotated, controlling, mode, send, onZoomChange, onPictureNode, onVideoNode }: {
  uri: string; stage: Size; content: Size; rotated: boolean; controlling: boolean; mode: InputMode;
  send(event: ScreenInputEvent): void;
  onZoomChange(zoom: number): void;
  onPictureNode?(node: unknown): void;
  onVideoNode?(node: unknown): void;
}) {
  const [view, setView] = useState<View2D>({ content, rotated, zoom: 1, panX: 0, panY: 0 });
  const [pointer, setPointer] = useState({ x: 0.5, y: 0.5 });
  const [touchNode, setTouchNode] = useState<unknown>(null);
  const feedback = useFeedback();
  const latest = useRef({ view, stage, controlling, mode, send, feedback, onView: setView, onPointer: setPointer });
  latest.current = { view, stage, controlling, mode, send, feedback, onView: setView, onPointer: setPointer };
  const controller = useMemo(() => new TouchController(() => latest.current), []);
  useEffect(() => { controller.cancel(); setView({ content, rotated, zoom: 1, panX: 0, panY: 0 }); }, [content.width, content.height, rotated, controller]);
  useEffect(() => { controller.cancel(); }, [mode, controlling, controller]);
  useEffect(() => { controller.reveal(); }, [mode, controlling, view.zoom, stage.width, stage.height, controller]);
  useEffect(() => () => controller.cancel(), [controller]);
  useEffect(() => onZoomChange(view.zoom), [view.zoom, onZoomChange]);
  useWebTouch(touchNode, { start: (points) => controller.start(points), move: (points) => controller.move(points), end: (remaining) => controller.end(remaining), cancel: () => controller.cancel() });
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (event) => controller.start(touchesOf(event)),
    onPanResponderStart: (event) => { const touches = touchesOf(event); if (touches.length >= 2) controller.start(touches); },
    onPanResponderMove: (event) => controller.move(touchesOf(event)),
    onPanResponderEnd: (event) => controller.end(event.nativeEvent.touches.length),
    onPanResponderRelease: () => controller.end(),
    onPanResponderTerminate: () => controller.cancel(),
  }), [controller]);
  const px = ((pointer.x - 0.5) * view.content.width + view.panX) * view.zoom;
  const py = ((pointer.y - 0.5) * view.content.height + view.panY) * view.zoom;
  const cursorX = stage.width / 2 + (view.rotated ? -py : px);
  const cursorY = stage.height / 2 + (view.rotated ? px : py);
  return (
    <View ref={setTouchNode} collapsable={false} accessibilityLabel="Remote touch surface" style={{ width: stage.width, height: stage.height, overflow: "hidden" }}>
      <View ref={onPictureNode} accessibilityLabel={isWeb ? "Remote screen" : undefined} pointerEvents={isWeb ? "auto" : "none"} style={{
        position: "absolute", left: (stage.width - view.content.width) / 2, top: (stage.height - view.content.height) / 2,
        width: view.content.width, height: view.content.height,
        transform: [{ rotate: view.rotated ? "90deg" : "0deg" }, { scale: view.zoom }, { translateX: view.panX }, { translateY: view.panY }],
      }}>
        <FrameImage uri={uri} width={view.content.width} height={view.content.height} />
        {isWeb ? <View ref={onVideoNode} pointerEvents="none" style={{ position: "absolute", inset: 0 }} /> : null}
      </View>
      {!isWeb ? <View collapsable={false} accessibilityLabel="Remote screen" style={{ position: "absolute", inset: 0 }} {...responder.panHandlers} /> : null}
      {mode === "trackpad" && controlling ? <View pointerEvents="none" accessibilityLabel="Trackpad cursor" style={{ position: "absolute", left: cursorX - 3, top: cursorY - 3, width: 24, height: 24, borderRadius: 12, backgroundColor: "rgba(14,22,29,0.65)", alignItems: "center", justifyContent: "center" }}><Icon name="MousePointer2" size={19} color="#d9efff" /></View> : null}
    </View>
  );
}
