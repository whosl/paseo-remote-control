import { defineTranslations } from "@getpaseo/plugin/client";

export const settingsMessages = defineTranslations({
  resources: {
    en: {
      title: "Computer Use",
      enable: "Enable Computer Use",
      enableHint:
        "Computer Use lets agents see and control apps on this host as you. Use Paseo's Stop button to take control back. Linux/Niri changes real focus and captures the whole target display; its global Escape hook and accessibility tree are unavailable.",
      allowBrowserApps: "Allow Computer Use in web browsers",
      browserHint: "Off: agents use Paseo's browser tools for the web.",
      screenshots: {
        label: "Screenshot mode",
        autoAx: "Auto (AX first; screenshot on request or for a sparse tree)",
        autoVisual: "Auto (visual screenshots)",
        always: "Always include screenshot",
        neverAx: "AX tree only (no screenshot sent to the agent)",
        neverVisual: "Do not send screenshots",
      },
      backend: {
        linuxTitle: "Linux/Niri visual backend",
        windowsTitle: "Windows visual backend",
        linuxHint:
          "Uses real desktop focus and display coordinates. Screenshots include other visible windows. There are no indexed controls, background input, or global Escape/shake hook.",
        windowsHint:
          "Uses real desktop focus and physical display coordinates. Only the target window is rendered for the agent; other apps stay blank. There are no indexed controls or global Escape/shake hook.",
        captureInput: "Capture / input",
        linuxCaptureHint:
          "Requires an unlocked Niri session, grim, wayvnc and wl-clipboard. Use Paseo Stop or disable Computer Use to stop an agent.",
        windowsCaptureHint:
          "Requires this user logged in to an unlocked Windows desktop. UAC, lock screens and elevated apps are not bypassed. Use Take over, Pause all or Paseo Stop.",
        label: "Backend",
        helperBuild: "Helper build",
        agentConnection: "Agent connection",
      },
      helperState: {
        checking: "Checking",
        idle: "Idle",
        building: "Building",
        ready: "Ready",
        failed: "Failed",
      },
      permissions: {
        checking: "Checking",
        unknown: "Unknown until the helper is built",
        granted: "Granted",
        missing: "Missing",
        accessibility: "Accessibility: {{status}}",
        accessibilityHint:
          "Grant it to the app that started the Paseo daemon, then quit and reopen that app.",
        screenRecording: "Screen Recording: {{status}}",
        screenRecordingHint:
          "Needed for screenshots. Quit and reopen the app after you grant it.",
        openSettings: "Open System Settings",
      },
      inControl: "In control: {{owner}}",
      stop: "Stop",
      providerAccess: "Give {{provider}} agents computer use",
      blockedApps: {
        label: "Extra blocked apps",
        hint:
          "Keychain Access, Passwords, the login window, the system password prompt, and the 1Password, Bitwarden, Dashlane, LastPass, NordPass, and Proton Pass apps are always blocked. Linux also blocks KeePassXC and Seahorse. Add macOS bundle ids or exact Linux app ids here, separated by commas or new lines.",
        placeholder: "com.example.Bank",
        count: "{{count}} extra blocked",
        save: "Save blocked apps",
      },
      loading: "Loading Computer Use settings…",
      tryAgain: "Try again",
      reload: "Reload",
      restoreDefaults: "Restore default settings",
      reset: "Reset",
    },
    zh: {
      title: "电脑操作",
      enable: "启用电脑操作",
      enableHint:
        "启用电脑操作后，智能体可以以你的身份查看并控制此主机上的应用。使用 Paseo 的“停止”按钮收回控制权。Linux/Niri 会改变实际焦点并截取整个目标显示器；不支持全局 Escape 停止功能或无障碍树。",
      allowBrowserApps: "允许在网页浏览器中使用电脑操作",
      browserHint: "关闭时，智能体使用 Paseo 的浏览器工具访问网页。",
      screenshots: {
        label: "截图模式",
        autoAx: "自动（优先使用无障碍树；按需或在树信息不足时截图）",
        autoVisual: "自动（视觉截图）",
        always: "始终附带截图",
        neverAx: "仅无障碍树（不向智能体发送截图）",
        neverVisual: "不发送截图",
      },
      backend: {
        linuxTitle: "Linux/Niri 视觉后端",
        windowsTitle: "Windows 视觉后端",
        linuxHint:
          "使用实际桌面焦点和显示器坐标。截图会包含其他可见窗口。不支持控件索引、后台输入或全局 Escape／摇动停止功能。",
        windowsHint:
          "使用实际桌面焦点和显示器物理坐标。仅向智能体显示目标窗口，其他应用区域留空。不支持控件索引或全局 Escape／摇动停止功能。",
        captureInput: "屏幕捕获 / 输入",
        linuxCaptureHint:
          "需要已解锁的 Niri 会话，以及 grim、wayvnc 和 wl-clipboard。使用 Paseo 的“停止”按钮或关闭电脑操作来停止智能体。",
        windowsCaptureHint:
          "需要当前用户已登录且 Windows 桌面已解锁。不会绕过 UAC、锁屏或需要管理员权限的应用。使用“接管”、“全部暂停”或 Paseo 的“停止”按钮。",
        label: "后端",
        helperBuild: "辅助程序构建",
        agentConnection: "智能体连接",
      },
      helperState: {
        checking: "检查中",
        idle: "空闲",
        building: "构建中",
        ready: "就绪",
        failed: "失败",
      },
      permissions: {
        checking: "检查中",
        unknown: "辅助程序构建完成后才能确认",
        granted: "已授权",
        missing: "未授权",
        accessibility: "辅助功能：{{status}}",
        accessibilityHint:
          "请为启动 Paseo 守护进程的应用授予权限，然后退出并重新打开该应用。",
        screenRecording: "屏幕录制：{{status}}",
        screenRecordingHint: "截图需要此权限。授权后，请退出并重新打开该应用。",
        openSettings: "打开系统设置",
      },
      inControl: "当前控制者：{{owner}}",
      stop: "停止",
      providerAccess: "允许 {{provider}} 智能体操作电脑",
      blockedApps: {
        label: "额外屏蔽的应用",
        hint:
          "“钥匙串访问”、“密码”、登录窗口、系统密码提示，以及 1Password、Bitwarden、Dashlane、LastPass、NordPass 和 Proton Pass 应用始终被屏蔽。Linux 还会屏蔽 KeePassXC 和 Seahorse。在此添加 macOS 应用的 bundle ID 或准确的 Linux 应用 ID，以逗号或换行分隔。",
        placeholder: "com.example.Bank",
        count: "额外屏蔽 {{count}} 个应用",
        save: "保存屏蔽列表",
      },
      loading: "正在加载电脑操作设置…",
      tryAgain: "重试",
      reload: "重新加载",
      restoreDefaults: "恢复默认设置",
      reset: "重置",
    },
  },
});
