import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { FeedbackPressable as Pressable } from "./feedback";

export const chrome = { text: "#eef0f4", muted: "#a1a7b2", border: "rgba(255,255,255,0.12)", surface: "rgba(25,28,33,0.94)", blue: "#8bc8ff", green: "#99d5ba" };

export function Control({ icon, label, active, disabled, onPress, small = false, above = small }: {
  icon: string; label: string; active?: boolean; disabled?: boolean; small?: boolean; above?: boolean; onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!active, disabled: !!disabled }} disabled={disabled}
      hitSlop={small ? 4 : 0} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} onPress={onPress}
      style={({ pressed }) => ({ width: small ? 36 : 44, height: small ? 36 : 44, borderRadius: 24, alignItems: "center", justifyContent: "center", borderWidth: 1,
        borderColor: active ? "rgba(153,213,186,0.4)" : chrome.border, backgroundColor: active ? "#244036" : pressed || hovered ? "#333943" : chrome.surface, opacity: disabled ? 0.35 : 1 })}>
      <Icon name={icon} size={small ? 17 : 20} color={active ? chrome.green : chrome.text} />
      {hovered ? <View pointerEvents="none" style={{ position: "absolute", ...(above ? { bottom: "100%", marginBottom: 8 } : { top: "100%", marginTop: 8 }), backgroundColor: "#272c34", borderRadius: 7, paddingHorizontal: 9, paddingVertical: 5, minWidth: 80, zIndex: 100 }}>
        <Text style={{ color: chrome.text, fontSize: 11, textAlign: "center" }}>{label}</Text>
      </View> : null}
    </Pressable>
  );
}

export function Key({ label, icon, active, disabled, onPress }: { label: string; icon?: string; active?: boolean; disabled?: boolean; onPress(): void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!active, disabled: !!disabled }} disabled={disabled} hitSlop={3} onPress={onPress}
    style={({ pressed }) => ({ minWidth: 42, height: 38, opacity: disabled ? 0.4 : 1, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", borderRadius: 9, borderWidth: 1,
      borderColor: active ? "#739b8a" : chrome.border, backgroundColor: active ? "#2b463c" : pressed ? "#39414d" : "#272c34" })}>
    {icon ? <Icon name={icon} size={16} color={chrome.text} /> : <Text style={{ color: active ? chrome.green : chrome.text, fontSize: 12, fontWeight: "500" }}>{label}</Text>}
  </Pressable>;
}
