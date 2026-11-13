import { createContext, useCallback, useContext, type PropsWithChildren } from "react";
import { Platform, Pressable as NativePressable, Vibration, type PressableProps } from "react-native";
import { vibrateBrowser } from "./web";

type NativeHaptics = { selectionAsync?(): Promise<void> };
const Feedback = createContext<() => void>(() => {});

function clickFeedback(): void {
  if (Platform.OS === "web") { vibrateBrowser(); return; }
  if (Platform.OS !== "ios" && Platform.OS !== "android") return;
  const fallback = () => { try { Vibration.vibrate(8); } catch { /* Feedback must never interrupt input. */ } };
  // Expo apps already install this JSI registry. Do not bundle a second Expo/RN runtime.
  try {
    const module = (globalThis as typeof globalThis & { expo?: { modules?: { ExpoHaptics?: NativeHaptics } } }).expo?.modules?.ExpoHaptics;
    if (module?.selectionAsync) { void Promise.resolve(module.selectionAsync()).catch(fallback); return; }
  } catch { /* Older clients may only expose React Native Vibration. */ }
  fallback();
}

export function FeedbackProvider({ enabled, children }: PropsWithChildren<{ enabled: boolean }>) {
  const pulse = useCallback(() => { if (enabled) clickFeedback(); }, [enabled]);
  return <Feedback.Provider value={pulse}>{children}</Feedback.Provider>;
}

export const useFeedback = () => useContext(Feedback);

export function FeedbackPressable({ onPress, ...props }: PressableProps) {
  const pulse = useFeedback();
  return <NativePressable {...props} onPress={(event) => { pulse(); onPress?.(event); }} />;
}
