import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Pressable, Text } from "react-native";
import { useControlPause } from "./control";
import { RemoteScreen } from "./screen";
import { useOwnership } from "../ownership";
import { remoteMessages, useRemoteTranslation } from "../messages";

function ScreenItem({ currentScreen, openScreen, host, theme }: PluginSidebarItemProps) {
  const { t } = useRemoteTranslation();
  // The pause button lets someone at the host (or anyone paired) stop remote input without opening the viewer.
  const control = useControlPause(host.id);
  const ownership = useOwnership(host.id);
  const agentActive = ownership.state?.mode === "agent";
  const label = control.paused ? t("resumeRemoteControl") : t("pauseRemoteControl");
  // Every host with the plugin installed adds its own row, so name the host.
  return (
    <SidebarRow
      icon="Monitor"
      label={`${t("remoteHost", { host: host.label })}${agentActive ? t("agentActiveSuffix") : control.paused ? t("controlPausedSuffix") : ""}`}
      active={currentScreen?.screenId === "screen"}
      onPress={() => openScreen({ screenId: "screen" })}
      trailing={
        control.known ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={agentActive ? t("takeOverAgent") : label}
            // Not `disabled`: a disabled button passes the press to the row, which would open the viewer.
            onPress={() => {
              if (agentActive) ownership.takeOver();
              else if (!control.changing) control.setPaused(!control.paused);
            }}
            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
          >
            <Text style={{ color: control.paused ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 13 }}>
              {agentActive ? t("takeOver") : control.paused ? "▶" : "⏸"}
            </Text>
          </Pressable>
        ) : null
      }
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: "screen", title: remoteMessages.message("title"), Component: RemoteScreen }),
    client.addSidebarHeaderItem({ id: "screen", title: remoteMessages.message("title"), Component: ScreenItem }),
    client.addCommandCenterItem({
      id: "open-screen",
      title: remoteMessages.message("showHostScreen"),
      icon: "Monitor",
      keywords: ["remote", "screen", "desktop", "vnc", "control", "远程", "屏幕", "桌面", "控制"],
      context: "global",
      onSelect: ({ openScreen }) => openScreen({ screenId: "screen" }),
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
