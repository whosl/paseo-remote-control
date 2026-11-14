import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ComputerUseSettingsScreen } from "./client/settings-screen";
import contributeViewer from "./client/viewer/contribute";
import { remoteMessages } from "./client/messages";

export default function contribute(client: PluginClientContext) {
  const cleanupViewer = contributeViewer(client);
  const cleanupSettings = client.addSettingsScreen({ id: "computer-use", title: remoteMessages.message("agentSettingsTitle"), icon: "Monitor", Component: ComputerUseSettingsScreen });
  return () => { cleanupSettings(); cleanupViewer(); };
}
