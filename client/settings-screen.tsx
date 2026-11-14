import { useCallback, useEffect, useMemo, useState } from "react";
import { Text } from "react-native";
import {
  useRpc,
  useSettings,
  useTranslation,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  controlStopRpc,
  permissionsOpenRpc,
  statusGetRpc,
  type ComputerUseStatusOutput,
} from "../shared/rpc";
import {
  SUPPORTED_PROVIDERS,
  computerUseSettings,
  parseBundleIdList,
  toggleProvider,
} from "../shared/settings";
import { settingsMessages } from "./settings-messages";

type ReadySettings = Extract<
  SettingsState<typeof computerUseSettings.schema>,
  { status: "ready" }
>;

function grantedLabelKey(status: ComputerUseStatusOutput | null, granted: boolean) {
  if (!status) return "permissions.checking";
  if (status.helperBuildState !== "ready") return "permissions.unknown";
  return granted ? "permissions.granted" : "permissions.missing";
}

function BlockedAppsEditor({ settings }: { settings: ReadySettings }) {
  const { t } = useTranslation(settingsMessages);
  // The draft owns only the text. The save merges it into the current
  // values at the current revision, so a provider or enable change made
  // while the user types is neither lost nor reported as a conflict. A
  // change to the saved list itself remounts this editor with the new list.
  const [draft, setDraft] = useState(() => settings.values.extraBlockedBundleIds.join("\n"));
  const save = useCallback(() => {
    void settings.save(
      { ...settings.values, extraBlockedBundleIds: parseBundleIdList(draft) },
      settings.revision,
    );
  }, [settings, draft]);

  return (
    <SettingsCard>
      <SettingsInput
        label={t("blockedApps.label")}
        hint={t("blockedApps.hint")}
        initialValue={draft}
        placeholder={t("blockedApps.placeholder")}
        onChangeText={setDraft}
        disabled={settings.saving}
        error={settings.saveError}
      />
      <SettingsAction
        label={t("blockedApps.count", { count: settings.values.extraBlockedBundleIds.length })}
        actionLabel={t("blockedApps.save")}
        disabled={settings.saving}
        onPress={save}
      />
    </SettingsCard>
  );
}

function SettingsControls({
  settings,
  theme,
}: {
  settings: ReadySettings;
  theme: PluginSurfaceProps["theme"];
}) {
  const { t } = useTranslation(settingsMessages);
  const getStatus = useRpc(statusGetRpc);
  const openPermissions = useRpc(permissionsOpenRpc);
  const stopControl = useRpc(controlStopRpc);
  const [status, setStatus] = useState<ComputerUseStatusOutput | null>(null);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const res = await getStatus({});
        if (active) setStatus(res);
      } catch {
        // A failed poll keeps the last status; the next poll retries.
      }
    };
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [getStatus]);

  const textStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme]);

  const onToggleEnabled = useCallback(
    (enabled: boolean) => {
      void settings.save({ ...settings.values, enabled }, settings.revision);
    },
    [settings],
  );

  const onToggleBrowserApps = useCallback(
    (allowBrowserApps: boolean) => {
      void settings.save({ ...settings.values, allowBrowserApps }, settings.revision);
    },
    [settings],
  );

  const onChangeScreenshots = useCallback(
    (screenshots: ReadySettings["values"]["screenshots"]) => {
      void settings.save({ ...settings.values, screenshots }, settings.revision);
    },
    [settings],
  );

  const onToggleProvider = useCallback(
    (provider: string, enabled: boolean) => {
      void settings.save(
        {
          ...settings.values,
          injectProviders: toggleProvider(settings.values.injectProviders, provider, enabled),
        },
        settings.revision,
      );
    },
    [settings],
  );

  const openAccessibility = useCallback(() => {
    void openPermissions({ pane: "accessibility" });
  }, [openPermissions]);

  const openScreenRecording = useCallback(() => {
    void openPermissions({ pane: "screen-recording" });
  }, [openPermissions]);

  const handleStop = useCallback(() => {
    void stopControl({});
  }, [stopControl]);

  const helperState = status?.helperBuildState ?? "checking";
  const linux = status?.platform === "linux" || status?.platform === "windows";
  const windows = status?.platform === "windows";
  const screenshotOptions = [
    { label: t(linux ? "screenshots.autoVisual" : "screenshots.autoAx"), value: "auto" },
    { label: t("screenshots.always"), value: "always" },
    { label: t(linux ? "screenshots.neverVisual" : "screenshots.neverAx"), value: "never" },
  ] as const;

  return (
    <SettingsSection title={t("title")}>
      <SettingsCard>
        <SettingsSwitch
          label={t("enable")}
          hint={t("enableHint")}
          value={settings.values.enabled}
          disabled={settings.saving}
          onValueChange={onToggleEnabled}
        />
        <SettingsSwitch
          label={t("allowBrowserApps")}
          hint={t("browserHint")}
          value={settings.values.allowBrowserApps}
          disabled={settings.saving}
          onValueChange={onToggleBrowserApps}
        />
        <SettingsSelect
          label={t("screenshots.label")}
          value={settings.values.screenshots}
          options={screenshotOptions}
          disabled={settings.saving}
          onValueChange={onChangeScreenshots}
        />
      </SettingsCard>

      {linux ? (
        <SettingsCard>
          <SettingsRow
            label={t(windows ? "backend.windowsTitle" : "backend.linuxTitle")}
            hint={t(windows ? "backend.windowsHint" : "backend.linuxHint")}
          />
          <SettingsRow
            label={t("backend.captureInput")}
            hint={t(windows ? "backend.windowsCaptureHint" : "backend.linuxCaptureHint")}
          />
          <SettingsRow label={t("backend.label")} error={status?.helperBuildError ?? null}>
            <Text style={textStyle}>{t(`helperState.${helperState}`)}</Text>
          </SettingsRow>
          {status?.socketError ? (
            <SettingsRow label={t("backend.agentConnection")} error={status.socketError} />
          ) : null}
          {status?.activeOwner ? (
            <SettingsAction
              label={t("inControl", { owner: status.activeAgentId ?? status.activeOwner })}
              actionLabel={t("stop")}
              onPress={handleStop}
            />
          ) : null}
        </SettingsCard>
      ) : <SettingsCard>
        <SettingsAction
          label={t("permissions.accessibility", {
            status: t(grantedLabelKey(status, status?.axTrusted ?? false)),
          })}
          hint={t("permissions.accessibilityHint")}
          actionLabel={t("permissions.openSettings")}
          onPress={openAccessibility}
        />
        <SettingsAction
          label={t("permissions.screenRecording", {
            status: t(grantedLabelKey(status, status?.screenCaptureGranted ?? false)),
          })}
          hint={t("permissions.screenRecordingHint")}
          actionLabel={t("permissions.openSettings")}
          onPress={openScreenRecording}
        />
        <SettingsRow label={t("backend.helperBuild")} error={status?.helperBuildError ?? null}>
          <Text style={textStyle}>{t(`helperState.${helperState}`)}</Text>
        </SettingsRow>
        {status?.socketError ? (
          <SettingsRow label={t("backend.agentConnection")} error={status.socketError} />
        ) : null}
        {status?.activeOwner ? (
          <SettingsAction
            label={t("inControl", { owner: status.activeAgentId ?? status.activeOwner })}
            actionLabel={t("stop")}
            onPress={handleStop}
          />
        ) : null}
      </SettingsCard>}

      <SettingsCard>
        {SUPPORTED_PROVIDERS.map((provider) => (
          <SettingsSwitch
            key={provider.id}
            label={t("providerAccess", { provider: provider.label })}
            value={settings.values.injectProviders.includes(provider.id)}
            disabled={settings.saving}
            onValueChange={(enabled) => onToggleProvider(provider.id, enabled)}
          />
        ))}
      </SettingsCard>

      {/* Remount only when the saved list changes, so saving another setting
          does not discard ids the user typed but has not saved yet. */}
      <BlockedAppsEditor
        key={settings.values.extraBlockedBundleIds.join("\n")}
        settings={settings}
      />
    </SettingsSection>
  );
}

export function ComputerUseSettingsScreen({ theme }: PluginSurfaceProps) {
  const { t } = useTranslation(settingsMessages);
  const settings = useSettings(computerUseSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);

  if (settings.status === "loading") {
    return <Text style={style}>{t("loading")}</Text>;
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title={t("title")}>
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label={t("tryAgain")} actionLabel={t("reload")} onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction
            label={t("restoreDefaults")}
            actionLabel={t("reset")}
            onPress={settings.reset}
          />
        ) : null}
      </SettingsSection>
    );
  }

  return <SettingsControls settings={settings} theme={theme} />;
}
