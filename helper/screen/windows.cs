// paseo-screen-helper for Windows (experimental): captures the screen with GDI and injects input with
// SendInput for the paseo-screen plugin. Compiled on the host with the .NET Framework's csc.exe, which
// accepts C# 5 only, so this file avoids newer syntax.
//
// Protocol: one JSON object per line on stdin, one JSON reply per line on stdout.
//   {"id": 1, "cmd": "status"}
//   {"id": 2, "cmd": "frame", "display": 1, "maxWidth": 1600, "quality": 0.6, "since": "abc"}
//   {"id": 3, "cmd": "input", "display": 1, "events": [{"type": "click", "x": 0.5, "y": 0.5}]}
//   {"id": 4, "cmd": "clipboard"}
// Coordinates in input events are normalized to 0...1 within the chosen display. Key codes are macOS
// virtual key codes (physical key positions) and are pressed by scan code, so the host's layout decides
// the character. The "cmd" modifier is the Windows key.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace PaseoScreen
{
    class HelperError : Exception
    {
        public HelperError(string message) : base(message) { }
    }

    class DisplayInfo
    {
        public int Id;
        public Rectangle Bounds;
        public bool Primary;
        public string Name;
        public Rectangle WorkArea;
        public string DeviceName;
        public string Kind = "unknown";
        public string StableKey;
        public bool ManagedVirtual;
        public int TargetCount;

        public Dictionary<string, object> Json()
        {
            var json = new Dictionary<string, object>();
            json["id"] = Id;
            json["x"] = Bounds.X;
            json["y"] = Bounds.Y;
            // The process is per-monitor DPI aware, so bounds are physical pixels; points equal pixels.
            json["width"] = Bounds.Width;
            json["height"] = Bounds.Height;
            json["pixelWidth"] = Bounds.Width;
            json["pixelHeight"] = Bounds.Height;
            json["main"] = Primary;
            json["builtin"] = false;
            json["name"] = Name;
            json["kind"] = Kind;
            json["stableKey"] = StableKey;
            json["deviceName"] = DeviceName;
            json["managedVirtual"] = ManagedVirtual;
            return json;
        }
    }

    static class Program
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        static StreamWriter output;

        [STAThread]
        static int Main(string[] args)
        {
            Native.EnableDpiAwareness();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Stream stream = null;
            try
            {
                if (args.Length == 3 && args[0] == "--pipe")
                {
                    // The UI writes unsolicited stop events while the command thread is blocked reading.
                    // An overlapped handle is required; a synchronous pipe serializes those operations.
                    var pipe = new NamedPipeClientStream(".", args[1], PipeDirection.InOut, PipeOptions.Asynchronous);
                    stream = pipe; pipe.Connect(20000);
                }
                output = new StreamWriter(stream ?? Console.OpenStandardOutput(), new UTF8Encoding(false));
                output.AutoFlush = true;
                if (stream != null) Reply(new Dictionary<string, object> { { "hello", File.ReadAllText(args[2], Encoding.UTF8).Trim() }, { "sessionId", Process.GetCurrentProcess().SessionId } });
                var input = new StreamReader(stream ?? Console.OpenStandardInput(), new UTF8Encoding(false));
                string line;
                while ((line = input.ReadLine()) != null)
                {
                    if (line.Length == 0) continue;
                    Handle(line);
                }
                return 0;
            }
            finally
            {
                RawVideo.StopAll();
                Input.ReleaseAll();
                try { ControlNotice.Stop(); } catch { }
                if (stream != null) stream.Dispose();
            }
        }

        public static void Reply(Dictionary<string, object> reply)
        {
            lock (Json) { output.Write(Json.Serialize(reply)); output.Write("\n"); }
        }

        static void Handle(string line)
        {
            Dictionary<string, object> request;
            try
            {
                lock (Json) request = Json.Deserialize<Dictionary<string, object>>(line);
            }
            catch (Exception)
            {
                request = null;
            }
            if (request == null)
            {
                var invalid = new Dictionary<string, object>();
                invalid["ok"] = false;
                invalid["error"] = "invalid JSON request";
                Reply(invalid);
                return;
            }
            object id = request.ContainsKey("id") ? request["id"] : null;
            Dictionary<string, object> result;
            try
            {
                string command = Str(request, "cmd");
                switch (command)
                {
                    case "status":
                    case "request":
                        result = Status();
                        break;
                    case "frame":
                        result = Capture.Frame(request);
                        break;
                    case "video-start": result = RawVideo.Start(request); break;
                    case "input":
                        result = Input.Handle(request);
                        break;
                    case "display-configure-virtual": result = Displays.ConfigureVirtual(request); break;
                    case "display-migrate-windows": result = WindowsScene.Migrate(request); break;
                    case "scene": result = WindowsScene.Read(); break;
                    case "focus": result = WindowsScene.Focus(request); break;
                    case "notice": result = ControlNotice.Update(request); break;
                    case "notice-location": result = ControlNotice.Location(); break;
                    case "release": Input.ReleaseAll(); result = new Dictionary<string, object>(); break;
                    case "signature": result = WindowsScene.Signature(request); break;
                    case "clipboard-write": ClipboardText.Write(Program.Str(request, "text") ?? ""); result = new Dictionary<string, object>(); break;
                    case "clipboard":
                        result = ClipboardText.Read();
                        break;
                    default:
                        throw new HelperError("unknown command: " + (command ?? "nil"));
                }
                result["ok"] = true;
            }
            catch (Exception error)
            {
                result = new Dictionary<string, object>();
                result["ok"] = false;
                result["error"] = error is HelperError ? error.Message : error.GetType().Name + ": " + error.Message;
            }
            result["id"] = id;
            Reply(result);
        }

        static Dictionary<string, object> Status()
        {
            WindowsTopology topology;
            var displays = Displays.List(out topology);
            var status = new Dictionary<string, object>();
            // Windows has no screen-capture or input permission for desktop apps.
            status["screenRecording"] = Process.GetCurrentProcess().SessionId != 0;
            status["backend"] = "windows-gdi";
            status["captureMode"] = "screenshot";
            status["webrtc"] = false;
            status["frameWait"] = false;
            status["sessionId"] = Process.GetCurrentProcess().SessionId;
            status["accessibility"] = true;
            status["locked"] = Native.SecureDesktopShowing();
            status["windowsTopology"] = topology.Json();
            var list = new List<object>();
            foreach (var display in displays) list.Add(display.Json());
            status["displays"] = list;
            var active = Displays.Containing(Native.ForegroundWindowCenter(), displays);
            if (active != null) status["activeDisplay"] = active.Id;
            return status;
        }

        // MARK: JSON helpers

        public static string Str(Dictionary<string, object> map, string key)
        {
            object value;
            return map != null && map.TryGetValue(key, out value) ? value as string : null;
        }

        public static double Num(Dictionary<string, object> map, string key, double fallback)
        {
            object value;
            if (map == null || !map.TryGetValue(key, out value) || value == null || value is string || value is bool) return fallback;
            try { return Convert.ToDouble(value); } catch (Exception) { return fallback; }
        }

        public static bool Bool(Dictionary<string, object> map, string key)
        {
            object value;
            return map != null && map.TryGetValue(key, out value) && value is bool && (bool)value;
        }

        public static bool Has(Dictionary<string, object> map, string key)
        {
            object value;
            return map != null && map.TryGetValue(key, out value) && value != null;
        }
    }

    // MARK: Displays

    class WindowsDisplayTarget
    {
        public string StableKey;
        public string Kind;
        public bool ManagedVirtual;
        public bool Active;
        public string DeviceName;
        public string TargetName;
        public string MonitorDevicePath;
        public string AdapterDevicePath;
        public uint OutputTechnology;
        public uint NameFlags;
        public uint StatusFlags;
        public string[] HardwareIds = new string[0];
        public Rectangle SourceBounds;

        public Dictionary<string, object> Json()
        {
            return new Dictionary<string, object> {
                { "stableKey", StableKey }, { "kind", Kind }, { "managedVirtual", ManagedVirtual },
                { "active", Active }, { "deviceName", DeviceName }, { "targetName", TargetName },
                { "monitorDevicePath", MonitorDevicePath }, { "adapterDevicePath", AdapterDevicePath },
                { "outputTechnology", OutputTechnology }, { "hardwareIds", HardwareIds },
                { "nameFlags", NameFlags }, { "statusFlags", StatusFlags }
            };
        }
    }

    class WindowsTopology
    {
        public bool Reliable = true;
        public int PhysicalConnected;
        public int PhysicalActive;
        public int UnknownConnected;
        public string Error;
        public readonly List<WindowsDisplayTarget> Targets = new List<WindowsDisplayTarget>();

        public void Fail(string error)
        {
            Reliable = false;
            if (Error == null) Error = error;
        }

        public Dictionary<string, object> Json()
        {
            var json = new Dictionary<string, object> {
                { "reliable", Reliable }, { "physicalConnected", PhysicalConnected }, { "physicalActive", PhysicalActive }
            };
            if (Error != null) json["error"] = Error;
            // Native-only diagnostics: do not require these device paths in the viewer's public schema.
            var paths = new List<object>();
            foreach (var target in Targets) paths.Add(target.Json());
            json["paths"] = paths;
            return json;
        }

        static string AdapterKey(Native.LUID adapter)
        {
            return adapter.HighPart.ToString("x8") + adapter.LowPart.ToString("x8");
        }

        static string PathKey(Native.LUID adapter, uint id)
        {
            return AdapterKey(adapter) + ":" + id;
        }

        static string Classify(uint technology, bool managed, uint statusFlags)
        {
            if (managed || technology == 17) return "virtual"; // INDIRECT_VIRTUAL, not INDIRECT_WIRED (16).
            // Forced projection is not evidence of an attached monitor. Miracast/other/indirect wired
            // may be real displays; leave them unknown and prevent headless automation.
            if ((statusFlags & 0x1c) != 0) return "unknown";
            switch (technology)
            {
                case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 8: case 9:
                case 10: case 11: case 12: case 13: case 14: case 18: case 0x80000000:
                    return "physical";
                default: return "unknown";
            }
        }

        static Native.DISPLAYCONFIG_DEVICE_INFO_HEADER Header(uint type, Type structure, Native.LUID adapter, uint id)
        {
            return new Native.DISPLAYCONFIG_DEVICE_INFO_HEADER {
                type = type, size = (uint)Marshal.SizeOf(structure), adapterId = adapter, id = id
            };
        }

        public static WindowsTopology Read(bool allPaths)
        {
            var topology = new WindowsTopology();
            try { topology.ReadPaths(allPaths); }
            catch (Exception error) { topology.Fail("Windows display query failed: " + error.Message); }
            return topology;
        }

        void ReadPaths(bool allPaths)
        {
            // QDC_ALL_PATHS includes connected but inactive physical monitors. Never use the CCD
            // persistence database, EDID cache, screen dimensions or GDI monitor count for presence.
            // https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-querydisplayconfig
            uint flags = allPaths ? 1U : 2U;
            Native.DISPLAYCONFIG_PATH_INFO[] paths = null;
            Native.DISPLAYCONFIG_MODE_INFO[] modes = null;
            uint pathCount = 0, modeCount = 0;
            for (int attempt = 0; attempt < 4; attempt++)
            {
                int result = Native.GetDisplayConfigBufferSizes(flags, out pathCount, out modeCount);
                if (result != 0) { Fail("GetDisplayConfigBufferSizes failed (" + result + ")"); return; }
                if (pathCount > 16384 || modeCount > 65536) { Fail("Display topology exceeds query limits"); return; }
                paths = new Native.DISPLAYCONFIG_PATH_INFO[Math.Max(1, (int)pathCount)];
                modes = new Native.DISPLAYCONFIG_MODE_INFO[Math.Max(1, (int)modeCount)];
                result = Native.QueryDisplayConfig(flags, ref pathCount, paths, ref modeCount, modes, IntPtr.Zero);
                if (result == 122) continue; // ERROR_INSUFFICIENT_BUFFER: hotplug between sizing and query.
                if (result != 0) { Fail("QueryDisplayConfig failed (" + result + ")"); return; }
                if (pathCount > paths.Length || modeCount > modes.Length) { Fail("Invalid display query size"); return; }
                ReadTargets(paths, pathCount, modes, modeCount);
                return;
            }
            Fail("Display topology kept changing during QueryDisplayConfig");
        }

        void ReadTargets(Native.DISPLAYCONFIG_PATH_INFO[] paths, uint pathCount, Native.DISPLAYCONFIG_MODE_INFO[] modes, uint modeCount)
        {
            var targets = new Dictionary<string, WindowsDisplayTarget>(StringComparer.Ordinal);
            var sources = new Dictionary<string, string>(StringComparer.Ordinal);
            var adapters = new Dictionary<string, string>(StringComparer.Ordinal);
            var hardware = new Dictionary<string, string[]>(StringComparer.Ordinal);
            for (int i = 0; i < pathCount; i++)
            {
                var path = paths[i];
                bool active = (path.flags & 1) != 0;
                // During removal an active path can still have targetAvailable == FALSE (MSDN).
                if (path.targetInfo.targetAvailable == 0)
                {
                    if (active) Fail("An active display target is being disconnected");
                    continue;
                }
                string targetId = PathKey(path.targetInfo.adapterId, path.targetInfo.id);
                WindowsDisplayTarget target;
                if (!targets.TryGetValue(targetId, out target))
                {
                    var name = new Native.DISPLAYCONFIG_TARGET_DEVICE_NAME();
                    name.header = Header(2, typeof(Native.DISPLAYCONFIG_TARGET_DEVICE_NAME), path.targetInfo.adapterId, path.targetInfo.id);
                    int result = Native.DisplayConfigGetDeviceInfo(ref name);
                    if (result != 0) Fail("DisplayConfigGetDeviceInfo(target) failed (" + result + ")");
                    string adapterId = AdapterKey(path.targetInfo.adapterId);
                    string adapterPath;
                    if (!adapters.TryGetValue(adapterId, out adapterPath))
                    {
                        var adapter = new Native.DISPLAYCONFIG_ADAPTER_NAME();
                        adapter.header = Header(4, typeof(Native.DISPLAYCONFIG_ADAPTER_NAME), path.targetInfo.adapterId, 0);
                        int adapterResult = Native.DisplayConfigGetDeviceInfo(ref adapter);
                        adapterPath = adapterResult == 0 ? adapter.adapterDevicePath : null;
                        if (adapterResult != 0) Fail("DisplayConfigGetDeviceInfo(adapter) failed (" + adapterResult + ")");
                        adapters[adapterId] = adapterPath;
                        hardware[adapterId] = Native.AdapterHardwareIds(adapterPath);
                    }
                    bool managed = false;
                    foreach (string hwid in hardware[adapterId])
                        if (string.Equals(hwid, @"Root\MttVDD", StringComparison.OrdinalIgnoreCase) || string.Equals(hwid, "MttVDD", StringComparison.OrdinalIgnoreCase)) managed = true;
                    target = new WindowsDisplayTarget {
                        TargetName = name.monitorFriendlyDeviceName ?? "", MonitorDevicePath = name.monitorDevicePath ?? "",
                        AdapterDevicePath = adapterPath ?? "", OutputTechnology = result == 0 ? name.outputTechnology : path.targetInfo.outputTechnology,
                        NameFlags = name.flags, StatusFlags = path.targetInfo.statusFlags,
                        HardwareIds = hardware[adapterId], ManagedVirtual = managed && result == 0
                    };
                    target.Kind = result == 0 ? Classify(target.OutputTechnology, target.ManagedVirtual, path.targetInfo.statusFlags) : "unknown";
                    // Inactive QDC paths have default target details/status flags. The device-name
                    // flag still explicitly rules out treating this forced target as physical.
                    if (target.Kind == "physical" && (target.NameFlags & 2) != 0) target.Kind = "unknown";
                    // Monitor interface paths survive GDI DISPLAYn renumbering. LUID/target is only a
                    // conservative session identity if the driver supplies neither interface path.
                    string identity = !string.IsNullOrEmpty(target.MonitorDevicePath) ? target.MonitorDevicePath :
                        !string.IsNullOrEmpty(adapterPath) ? adapterPath + ":" + path.targetInfo.id : targetId;
                    target.StableKey = "windows-target:" + identity.ToLowerInvariant();
                    targets[targetId] = target;
                    Targets.Add(target);
                }
                if (!active) continue;
                string sourceId = PathKey(path.sourceInfo.adapterId, path.sourceInfo.id);
                string deviceName;
                if (!sources.TryGetValue(sourceId, out deviceName))
                {
                    var source = new Native.DISPLAYCONFIG_SOURCE_DEVICE_NAME();
                    source.header = Header(1, typeof(Native.DISPLAYCONFIG_SOURCE_DEVICE_NAME), path.sourceInfo.adapterId, path.sourceInfo.id);
                    int result = Native.DisplayConfigGetDeviceInfo(ref source);
                    deviceName = result == 0 ? source.viewGdiDeviceName : null;
                    if (string.IsNullOrEmpty(deviceName)) Fail("DisplayConfigGetDeviceInfo(source) failed (" + result + ")");
                    sources[sourceId] = deviceName;
                }
                if (target.Active && !string.Equals(target.DeviceName, deviceName, StringComparison.OrdinalIgnoreCase))
                    Fail("A display target has multiple active sources");
                target.Active = true;
                target.DeviceName = deviceName;
                uint modeIndex = path.sourceInfo.modeInfoIdx;
                if (modeIndex >= modeCount || modes[modeIndex].infoType != 1 || modes[modeIndex].id != path.sourceInfo.id ||
                    AdapterKey(modes[modeIndex].adapterId) != AdapterKey(path.sourceInfo.adapterId))
                {
                    Fail("An active display has no valid source mode");
                    continue;
                }
                var mode = modes[modeIndex];
                if (mode.width == 0 || mode.height == 0 || mode.width > int.MaxValue || mode.height > int.MaxValue)
                    Fail("An active display has invalid source bounds");
                else target.SourceBounds = new Rectangle(mode.position.x, mode.position.y, (int)mode.width, (int)mode.height);
            }
            // A forced NVIDIA source is not a monitor. friendlyNameForced (bit 2) explicitly says
            // there is no detectable monitor attached; blank names on their own do NOT prove this.
            // Corroborate with current PnP devnodes, excluding only monitors mapped to other known
            // CCD targets (including the managed VDD), never cached EDID/registry monitor entries.
            // https://learn.microsoft.com/windows/win32/api/wingdi/ns-wingdi-displayconfig_target_device_name_flags
            var forced = new List<WindowsDisplayTarget>();
            var monitorPaths = new List<string>();
            foreach (var target in Targets)
            {
                if ((target.Kind == "physical" || target.Kind == "virtual") && !string.IsNullOrEmpty(target.MonitorDevicePath))
                    monitorPaths.Add(target.MonitorDevicePath);
                bool nvidia = false;
                foreach (string hwid in target.HardwareIds)
                    if (hwid.StartsWith(@"PCI\VEN_10DE&", StringComparison.OrdinalIgnoreCase)) nvidia = true;
                if (target.Kind != "unknown" || !nvidia || target.NameFlags != 2 || (target.Active && (target.StatusFlags & 0x1c) == 0) ||
                    Classify(target.OutputTechnology, false, 0) != "physical" ||
                    !string.IsNullOrEmpty(target.TargetName) || !string.IsNullOrEmpty(target.MonitorDevicePath)) continue;
                if (target.Active)
                {
                    if (string.IsNullOrEmpty(target.DeviceName)) continue;
                    var monitor = new Native.DISPLAY_DEVICE(); monitor.cb = Marshal.SizeOf(typeof(Native.DISPLAY_DEVICE));
                    if (Native.EnumDisplayDevices(target.DeviceName, 0, ref monitor, 1)) continue;
                }
                forced.Add(target);
            }
            if (forced.Count != 0)
            {
                string evidenceError;
                if (Native.PresentMonitorsMapped(monitorPaths, out evidenceError))
                    foreach (var target in forced) target.Kind = "fallback";
                else Fail(evidenceError);
            }
            foreach (var target in Targets)
            {
                if (target.Kind == "physical") { PhysicalConnected++; if (target.Active) PhysicalActive++; }
                else if (target.Kind == "unknown") UnknownConnected++;
            }
            if (UnknownConnected != 0) Fail("A connected display's physical/virtual type could not be verified");
        }

        public void Describe(DisplayInfo display)
        {
            var keys = new List<string>();
            bool physical = false, unknown = false, virtualTarget = false, managed = true, anyActive = false;
            WindowsDisplayTarget first = null;
            foreach (var target in Targets)
            {
                anyActive |= target.Active;
                if (!target.Active || !string.Equals(target.DeviceName, display.DeviceName, StringComparison.OrdinalIgnoreCase)) continue;
                if (first == null) first = target;
                keys.Add(target.StableKey);
                physical |= target.Kind == "physical";
                unknown |= target.Kind == "unknown";
                virtualTarget |= target.Kind == "virtual";
                managed &= target.ManagedVirtual;
                if (target.SourceBounds != display.Bounds) Fail("Display bounds changed during enumeration");
            }
            display.TargetCount = keys.Count;
            if (first != null)
            {
                display.Kind = physical ? "physical" : unknown ? "unknown" : virtualTarget ? "virtual" : "fallback";
                display.ManagedVirtual = managed && keys.Count == 1 && display.Kind == "virtual";
                if (!string.IsNullOrEmpty(first.TargetName)) display.Name = first.TargetName;
                keys.Sort(StringComparer.Ordinal);
                display.StableKey = keys.Count == 1 ? keys[0] : "windows-clone:" + string.Join("|", keys.ToArray());
            }
            else
            {
                display.Kind = Reliable && !anyActive ? "fallback" : "unknown";
                display.StableKey = "windows-" + display.Kind + ":" + (display.DeviceName ?? "").ToLowerInvariant();
            }
        }

        public void ValidateDisplays(List<DisplayInfo> displays)
        {
            foreach (var target in Targets)
            {
                if (!target.Active) continue;
                bool found = false;
                foreach (var display in displays)
                    if (string.Equals(display.DeviceName, target.DeviceName, StringComparison.OrdinalIgnoreCase)) found = true;
                if (!found) Fail("An active display source disappeared during enumeration");
            }
            if (!Reliable)
                foreach (var display in displays)
                    if (display.Kind == "fallback") { display.Kind = "unknown"; display.StableKey = "windows-unknown:" + (display.DeviceName ?? "").ToLowerInvariant(); }
        }
    }

    static class Displays
    {
        public static List<DisplayInfo> List()
        {
            // Frames and input need fresh active identities, not every possible source/target pairing.
            return List(WindowsTopology.Read(false));
        }

        public static List<DisplayInfo> List(out WindowsTopology topology)
        {
            topology = WindowsTopology.Read(true);
            return List(topology);
        }

        // Capturing an already pinned target needs only fresh active paths. The physical-first
        // policy still uses ALL_PATHS, including inactive physical connectors, above.
        public static List<DisplayInfo> Active(out WindowsTopology topology)
        {
            topology = WindowsTopology.Read(false);
            return List(topology);
        }

        static List<DisplayInfo> List(WindowsTopology topology)
        {
            var displays = new List<DisplayInfo>();
            Native.MonitorEnumProc callback = delegate (IntPtr monitor, IntPtr hdc, ref Native.RECT rect, IntPtr data)
            {
                var info = new Native.MONITORINFOEX();
                info.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFOEX));
                if (Native.GetMonitorInfo(monitor, ref info))
                {
                    var bounds = Rectangle.FromLTRB(info.rcMonitor.left, info.rcMonitor.top, info.rcMonitor.right, info.rcMonitor.bottom);
                    var display = new DisplayInfo
                    {
                        Id = DisplayNumber(info.szDevice, displays.Count + 1),
                        Bounds = bounds,
                        Primary = (info.dwFlags & 1) != 0,
                        Name = FriendlyName(info.szDevice, displays.Count + 1),
                        DeviceName = info.szDevice,
                        WorkArea = Rectangle.FromLTRB(info.rcWork.left, info.rcWork.top, info.rcWork.right, info.rcWork.bottom),
                    };
                    topology.Describe(display);
                    displays.Add(display);
                }
                else topology.Fail("GetMonitorInfo failed during display enumeration");
                return true;
            };
            if (!Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero))
                topology.Fail("EnumDisplayMonitors failed");
            GC.KeepAlive(callback);
            topology.ValidateDisplays(displays);
            return displays;
        }

        public static DisplayInfo ByKey(string key, List<DisplayInfo> displays)
        {
            if (string.IsNullOrEmpty(key)) throw new HelperError("A display stableKey is required");
            DisplayInfo found = null;
            foreach (var display in displays)
            {
                if (!string.Equals(display.StableKey, key, StringComparison.Ordinal)) continue;
                if (found != null) throw new HelperError("Display identity is ambiguous; wait for a fresh frame");
                found = display;
            }
            if (found == null) throw new HelperError("Display changed; wait for a fresh frame");
            return found;
        }

        static DisplayInfo ConfigurableVirtual(string key, out WindowsTopology topology)
        {
            var displays = List(out topology);
            if (!topology.Reliable) throw new HelperError("Display topology is unavailable: " + topology.Error);
            if (topology.PhysicalConnected != 0 || topology.UnknownConnected != 0)
                throw new HelperError("A physical or unidentified display is connected; virtual display configuration is refused");
            var display = ByKey(key, displays);
            if (display.Kind != "virtual" || !display.ManagedVirtual || display.TargetCount != 1 || string.IsNullOrEmpty(display.DeviceName))
                throw new HelperError("Only a verified, active VirtualDrivers VDD display can be configured");
            if (Native.SecureDesktopShowing()) throw new HelperError("Unlock the interactive desktop before configuring a virtual display");
            return display;
        }

        public static Dictionary<string, object> ConfigureVirtual(Dictionary<string, object> request)
        {
            if ((request.ContainsKey("width") && Program.Num(request, "width", double.NaN) != 1920) ||
                (request.ContainsKey("height") && Program.Num(request, "height", double.NaN) != 1080))
                throw new HelperError("The managed virtual display supports only the requested 1920x1080 profile");
            string key = Program.Str(request, "stableKey");
            WindowsTopology topology;
            var display = ConfigurableVirtual(key, out topology);
            var mode = new Native.DEVMODE();
            mode.dmSize = (ushort)Marshal.SizeOf(typeof(Native.DEVMODE));
            if (!Native.EnumDisplaySettings(display.DeviceName, -1, ref mode))
                throw new HelperError("Could not read the virtual display's current mode");
            if (mode.dmPelsWidth == 1920 && mode.dmPelsHeight == 1080)
                return new Dictionary<string, object> { { "display", display.Json() }, { "changed", false }, { "windowsTopology", topology.Json() } };

            // Only this named, already active VDD source. No position, primary, registry or global change.
            // https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-changedisplaysettingsexw
            mode.dmDriverExtra = 0;
            mode.dmFields = 0x00080000 | 0x00100000; // DM_PELSWIDTH | DM_PELSHEIGHT
            mode.dmPelsWidth = 1920; mode.dmPelsHeight = 1080;
            int test = Native.ChangeDisplaySettingsEx(display.DeviceName, ref mode, IntPtr.Zero, 2, IntPtr.Zero); // CDS_TEST
            if (test != 0) throw new HelperError("The VDD driver rejected 1920x1080 (" + test + ")");

            // Re-read connectivity and identity after CDS_TEST, immediately before the only write.
            var current = ConfigurableVirtual(key, out topology);
            if (!string.Equals(current.DeviceName, display.DeviceName, StringComparison.OrdinalIgnoreCase) || current.Bounds != display.Bounds)
                throw new HelperError("Display changed; wait for a fresh frame");
            int changed = Native.ChangeDisplaySettingsEx(current.DeviceName, ref mode, IntPtr.Zero, 0, IntPtr.Zero);
            if (changed != 0) throw new HelperError("The VDD mode change failed (" + changed + ")");
            var updated = ByKey(key, List(out topology));
            if (updated.Bounds.Width != 1920 || updated.Bounds.Height != 1080)
                throw new HelperError("The VDD driver accepted the mode but 1920x1080 is not active; refresh display status");
            return new Dictionary<string, object> { { "display", updated.Json() }, { "changed", true }, { "windowsTopology", topology.Json() } };
        }

        /// "\\.\DISPLAY2" is display 2; the number stays the same while the monitor is connected.
        static int DisplayNumber(string device, int fallback)
        {
            if (device == null) return fallback;
            int start = device.Length;
            while (start > 0 && char.IsDigit(device[start - 1])) start--;
            int number;
            return start < device.Length && int.TryParse(device.Substring(start), out number) ? number : fallback;
        }

        static string FriendlyName(string device, int index)
        {
            var monitor = new Native.DISPLAY_DEVICE();
            monitor.cb = Marshal.SizeOf(typeof(Native.DISPLAY_DEVICE));
            if (device != null && Native.EnumDisplayDevices(device, 0, ref monitor, 0) && !string.IsNullOrEmpty(monitor.DeviceString))
            {
                return monitor.DeviceString.Trim();
            }
            return "Display " + index;
        }

        public static DisplayInfo Resolve(object requested, List<DisplayInfo> displays)
        {
            if (displays.Count == 0) throw new HelperError("no display is connected");
            if (requested != null && !(requested is string) && !(requested is bool))
            {
                int id = Convert.ToInt32(requested);
                foreach (var display in displays) if (display.Id == id) return display;
            }
            foreach (var display in displays) if (display.Primary) return display;
            return displays[0];
        }

        public static DisplayInfo Containing(Point point, List<DisplayInfo> displays)
        {
            foreach (var display in displays) if (display.Bounds.Contains(point)) return display;
            return null;
        }

        /// The nearest point on any display, so a drag past the outer edge of the desktop stops there.
        public static Point ClampToDesktop(double x, double y, List<DisplayInfo> displays)
        {
            var best = new Point((int)Math.Round(x), (int)Math.Round(y));
            double bestDistance = double.MaxValue;
            foreach (var display in displays)
            {
                var b = display.Bounds;
                double cx = Math.Min(Math.Max(x, b.Left), b.Right - 1);
                double cy = Math.Min(Math.Max(y, b.Top), b.Bottom - 1);
                double distance = Math.Sqrt((cx - x) * (cx - x) + (cy - y) * (cy - y));
                if (distance < bestDistance)
                {
                    bestDistance = distance;
                    best = new Point((int)Math.Round(cx), (int)Math.Round(cy));
                }
            }
            return best;
        }
    }

    // Private, authenticated loopback feed to the worker. It carries pixels only, never input.
    // A blocking write provides backpressure; no queue of stale desktop frames is retained.
    static class RawVideo
    {
        static readonly List<TcpClient> clients = new List<TcpClient>();

        public static Dictionary<string, object> Start(Dictionary<string, object> request)
        {
            string key = Program.Str(request, "stableKey"), token = Program.Str(request, "token");
            int port = (int)Program.Num(request, "port", 0);
            int width = (int)Program.Num(request, "width", 0), height = (int)Program.Num(request, "height", 0);
            int fps = (int)Program.Num(request, "fps", 0);
            if (port < 1 || port > 65535 || token == null || token.Length != 64 ||
                width < 2 || width > 2560 || height < 2 || height > 8192 || (width & 1) != 0 || (height & 1) != 0 || fps < 1 || fps > 30)
                throw new HelperError("Invalid private video feed");
            WindowsTopology topology;
            var display = Displays.ByKey(key, Displays.List(out topology));
            if (!topology.Reliable || display.TargetCount != 1 || Native.SecureDesktopShowing()) throw new HelperError("Unlock a stable display before starting video");
            var client = new TcpClient();
            client.NoDelay = true; client.SendTimeout = 2000; client.SendBufferSize = 64 * 1024;
            lock (clients) { if (clients.Count >= 2) { client.Close(); throw new HelperError("Two video captures are already active"); } clients.Add(client); }
            var thread = new Thread(delegate() {
                bool timer = Native.timeBeginPeriod(1) == 0;
                try
                {
                    client.Connect("127.0.0.1", port);
                    using (var stream = client.GetStream())
                    using (var full = new Bitmap(display.Bounds.Width, display.Bounds.Height, PixelFormat.Format32bppArgb))
                    using (var scaled = new Bitmap(width, height, PixelFormat.Format32bppArgb))
                    using (var graphics = Graphics.FromImage(full))
                    using (var resize = Graphics.FromImage(scaled))
                    {
                        var hello = Encoding.ASCII.GetBytes(token + "\n"); stream.Write(hello, 0, hello.Length);
                        resize.InterpolationMode = InterpolationMode.Bilinear;
                        var bytes = new byte[width * height * 4];
                        var clock = Stopwatch.StartNew(); double next = 0;
                        for (;;)
                        {
                            var current = Displays.ByKey(key, Displays.Active(out topology));
                            if (!topology.Reliable || current.TargetCount != 1 || current.Bounds != display.Bounds || current.DeviceName != display.DeviceName || Native.SecureDesktopShowing()) break;
                            graphics.CopyFromScreen(display.Bounds.Location, Point.Empty, display.Bounds.Size, CopyPixelOperation.SourceCopy);
                            Capture.DrawCursor(graphics, display.Bounds);
                            var pixels = width == full.Width && height == full.Height ? full : scaled;
                            if (pixels == scaled) resize.DrawImage(full, 0, 0, width, height);
                            // Reject a frame if the topology/secure desktop changed during the GDI copy.
                            current = Displays.ByKey(key, Displays.Active(out topology));
                            if (!topology.Reliable || current.Bounds != display.Bounds || current.DeviceName != display.DeviceName || Native.SecureDesktopShowing()) break;
                            var data = pixels.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                            try { for (int row = 0; row < height; row++) Marshal.Copy(IntPtr.Add(data.Scan0, row * data.Stride), bytes, row * width * 4, width * 4); }
                            finally { pixels.UnlockBits(data); }
                            var timestamp = BitConverter.GetBytes((long)(clock.Elapsed.TotalSeconds * 90000));
                            stream.Write(timestamp, 0, timestamp.Length); stream.Write(bytes, 0, bytes.Length);
                            next = Math.Max(next + 1000.0 / fps, clock.Elapsed.TotalMilliseconds);
                            int delay = (int)(next - clock.Elapsed.TotalMilliseconds); if (delay > 0) Thread.Sleep(delay);
                        }
                    }
                }
                catch (Exception) { /* Disconnect, hotplug and lock end this feed; the viewer falls back. */ }
                finally { client.Close(); lock (clients) clients.Remove(client); if (timer) Native.timeEndPeriod(1); }
            });
            thread.IsBackground = true; thread.Start();
            return new Dictionary<string, object> { { "started", true } };
        }

        public static void StopAll() { lock (clients) { foreach (var client in clients) client.Close(); clients.Clear(); } }
    }

    // MARK: Capture

    static class Capture
    {
        static ImageCodecInfo jpegCodec;

        public static Dictionary<string, object> Frame(Dictionary<string, object> request)
        {
            if (Program.Bool(request, "wake")) Native.WakeDisplay();
            var displays = Displays.List();
            var display = Displays.Resolve(request.ContainsKey("display") ? request["display"] : null, displays);
            int maxWidth = Math.Max(320, (int)Program.Num(request, "maxWidth", 1600));
            double quality = Math.Min(1, Math.Max(0.1, Program.Num(request, "quality", 0.6)));
            bool locked = Native.SecureDesktopShowing();

            byte[] jpeg;
            int imageWidth, imageHeight;
            try
            {
                if (Program.Has(request, "expectedWindow")) WindowsScene.CheckTarget(request);
                jpeg = Grab(display.Bounds, maxWidth, quality, new IntPtr((long)Program.Num(request, "expectedWindow", 0)), out imageWidth, out imageHeight);
            }
            catch (Exception)
            {
                // The lock screen and UAC prompts run on a secure desktop that this process cannot read.
                if (!locked) throw;
                var blocked = new Dictionary<string, object>();
                blocked["locked"] = true;
                return blocked;
            }

            string hash = Fnv1a(jpeg);
            var result = new Dictionary<string, object>();
            result["display"] = display.Json();
            result["imageWidth"] = imageWidth;
            result["imageHeight"] = imageHeight;
            result["hash"] = hash;
            result["bytes"] = jpeg.Length;
            result["locked"] = locked;
            if (Program.Str(request, "since") == hash) result["unchanged"] = true;
            else result["jpeg"] = Convert.ToBase64String(jpeg);
            return result;
        }

        public static Bitmap BitmapOf(Rectangle bounds, IntPtr window)
        {
            var full = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb);
            try {
                using (var graphics = Graphics.FromImage(full)) {
                    if (window == IntPtr.Zero) graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
                    else {
                        graphics.Clear(Color.FromArgb(22, 26, 30));
                        Native.RECT rect;
                        if (!Native.GetWindowRect(window, out rect) || rect.right <= rect.left || rect.bottom <= rect.top) throw new HelperError("Target window disappeared before capture");
                        using (var app = new Bitmap(rect.right - rect.left, rect.bottom - rect.top, PixelFormat.Format24bppRgb)) {
                            using (var ag = Graphics.FromImage(app)) {
                                var dc = ag.GetHdc();
                                try { if (!Native.PrintWindow(window, dc, 2)) throw new HelperError("This app does not support window capture"); }
                                finally { ag.ReleaseHdc(dc); }
                            }
                            graphics.DrawImageUnscaled(app, rect.left - bounds.Left, rect.top - bounds.Top);
                        }
                    }
                    DrawCursor(graphics, bounds);
                }
                return full;
            } catch { full.Dispose(); throw; }
        }

        static byte[] Grab(Rectangle bounds, int maxWidth, double quality, IntPtr window, out int width, out int height)
        {
            using (var full = BitmapOf(bounds, window))
            {
                double scale = Math.Min(1.0, (double)maxWidth / bounds.Width);
                width = Math.Max(1, (int)(bounds.Width * scale));
                height = Math.Max(1, (int)(bounds.Height * scale));
                if (width == bounds.Width) return Encode(full, quality);
                using (var scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb))
                {
                    using (var graphics = Graphics.FromImage(scaled))
                    {
                        // HighQualityBilinear dominates the on-demand capture time on Windows.
                        // Fast/Balanced use bilinear filtering; Sharp retains the detailed filter.
                        bool detailed = quality >= 0.75;
                        graphics.InterpolationMode = detailed ? InterpolationMode.HighQualityBilinear : InterpolationMode.Bilinear;
                        graphics.PixelOffsetMode = detailed ? PixelOffsetMode.HighQuality : PixelOffsetMode.None;
                        graphics.DrawImage(full, 0, 0, width, height);
                    }
                    return Encode(scaled, quality);
                }
            }
        }

        /// CopyFromScreen leaves out the mouse pointer, so draw it in, as the macOS and Linux helpers show it.
        public static void DrawCursor(Graphics graphics, Rectangle bounds)
        {
            var info = new Native.CURSORINFO();
            info.cbSize = Marshal.SizeOf(typeof(Native.CURSORINFO));
            if (!Native.GetCursorInfo(ref info) || (info.flags & 1) == 0 || info.hCursor == IntPtr.Zero) return;
            if (!bounds.Contains(info.ptScreenPos.x, info.ptScreenPos.y)) return;
            Native.ICONINFO icon;
            int hotX = 0, hotY = 0;
            if (Native.GetIconInfo(info.hCursor, out icon))
            {
                hotX = icon.xHotspot;
                hotY = icon.yHotspot;
                if (icon.hbmMask != IntPtr.Zero) Native.DeleteObject(icon.hbmMask);
                if (icon.hbmColor != IntPtr.Zero) Native.DeleteObject(icon.hbmColor);
            }
            IntPtr hdc = graphics.GetHdc();
            try
            {
                Native.DrawIconEx(hdc, info.ptScreenPos.x - bounds.Left - hotX, info.ptScreenPos.y - bounds.Top - hotY, info.hCursor, 0, 0, 0, IntPtr.Zero, 3);
            }
            finally
            {
                graphics.ReleaseHdc(hdc);
            }
        }

        static byte[] Encode(Bitmap bitmap, double quality)
        {
            if (jpegCodec == null)
            {
                foreach (var codec in ImageCodecInfo.GetImageEncoders())
                {
                    if (codec.MimeType == "image/jpeg") jpegCodec = codec;
                }
                if (jpegCodec == null) throw new HelperError("no JPEG encoder is available");
            }
            using (var parameters = new EncoderParameters(1))
            using (var stream = new MemoryStream())
            {
                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Round(quality * 100));
                bitmap.Save(stream, jpegCodec, parameters);
                return stream.ToArray();
            }
        }

        static string Fnv1a(byte[] data)
        {
            ulong hash = 0xcbf29ce484222325UL;
            foreach (byte value in data)
            {
                hash ^= value;
                hash = unchecked(hash * 0x100000001b3UL);
            }
            return hash.ToString("x");
        }
    }

    // MARK: Input

    static class Input
    {
        /// macOS virtual key code to PC scan code; 0xE0xx marks an extended key.
        static readonly Dictionary<int, int> ScanCodes = new Dictionary<int, int>
        {
            {0, 0x1E}, {1, 0x1F}, {2, 0x20}, {3, 0x21}, {4, 0x23}, {5, 0x22}, {6, 0x2C}, {7, 0x2D}, {8, 0x2E}, {9, 0x2F},
            {10, 0x56}, {11, 0x30}, {12, 0x10}, {13, 0x11}, {14, 0x12}, {15, 0x13}, {16, 0x15}, {17, 0x14},
            {18, 0x02}, {19, 0x03}, {20, 0x04}, {21, 0x05}, {22, 0x07}, {23, 0x06}, {24, 0x0D}, {25, 0x0A},
            {26, 0x08}, {27, 0x0C}, {28, 0x09}, {29, 0x0B}, {30, 0x1B}, {31, 0x18}, {32, 0x16}, {33, 0x1A},
            {34, 0x17}, {35, 0x19}, {36, 0x1C}, {37, 0x26}, {38, 0x24}, {39, 0x28}, {40, 0x25}, {41, 0x27},
            {42, 0x2B}, {43, 0x33}, {44, 0x35}, {45, 0x31}, {46, 0x32}, {47, 0x34}, {48, 0x0F}, {49, 0x39},
            {50, 0x29}, {51, 0x0E}, {53, 0x01},
            {54, 0xE05C}, {55, 0xE05B}, {56, 0x2A}, {57, 0x3A}, {58, 0x38}, {59, 0x1D}, {60, 0x36}, {61, 0xE038}, {62, 0xE01D},
            {65, 0x53}, {67, 0x37}, {69, 0x4E}, {71, 0x45}, {75, 0xE035}, {76, 0xE01C}, {78, 0x4A},
            {82, 0x52}, {83, 0x4F}, {84, 0x50}, {85, 0x51}, {86, 0x4B}, {87, 0x4C}, {88, 0x4D}, {89, 0x47}, {91, 0x48}, {92, 0x49},
            {122, 0x3B}, {120, 0x3C}, {99, 0x3D}, {118, 0x3E}, {96, 0x3F}, {97, 0x40}, {98, 0x41}, {100, 0x42},
            {101, 0x43}, {109, 0x44}, {103, 0x57}, {111, 0x58},
            {114, 0xE052}, {115, 0xE047}, {116, 0xE049}, {117, 0xE053}, {119, 0xE04F}, {121, 0xE051},
            {123, 0xE04B}, {124, 0xE04D}, {125, 0xE050}, {126, 0xE048},
        };

        /// US scan codes for letters a layout cannot produce, matching the macOS and Linux helpers.
        static readonly Dictionary<char, int> UsLetters = new Dictionary<char, int>
        {
            {'a', 0x1E}, {'b', 0x30}, {'c', 0x2E}, {'d', 0x20}, {'e', 0x12}, {'f', 0x21}, {'g', 0x22}, {'h', 0x23}, {'i', 0x17},
            {'j', 0x24}, {'k', 0x25}, {'l', 0x26}, {'m', 0x32}, {'n', 0x31}, {'o', 0x18}, {'p', 0x19}, {'q', 0x10}, {'r', 0x13},
            {'s', 0x1F}, {'t', 0x14}, {'u', 0x16}, {'v', 0x2F}, {'w', 0x11}, {'x', 0x2D}, {'y', 0x15}, {'z', 0x2C},
        };

        // Modifier scan codes, pressed in this order and released in reverse.
        const int ScanCtrl = 0x1D, ScanAlt = 0x38, ScanShift = 0x2A, ScanWin = 0xE05B;

        static Point? lastPointer;
        static readonly HashSet<int> heldKeys = new HashSet<int>();
        static readonly HashSet<string> heldButtons = new HashSet<string>();
        public static void ReleaseAll()
        {
            foreach (int scan in new List<int>(heldKeys)) { try { Key(scan, false); } catch { } }
            foreach (string button in new List<string>(heldButtons)) {
                try { Mouse(ButtonFlag(button, false), 0); heldButtons.Remove(button); } catch { }
            }
        }

        public static Dictionary<string, object> Handle(Dictionary<string, object> request)
        {
            if (Native.SecureDesktopShowing()) throw new HelperError("Unlock the interactive desktop; secure desktop input is refused.");
            if (Program.Has(request, "expectedWindow")) WindowsScene.CheckTarget(request);
            var displays = Displays.List();
            if (request.ContainsKey("expectedDisplayKey") && displays.Count == 0)
                throw new HelperError("Display changed; wait for a fresh frame");
            var display = Displays.Resolve(request.ContainsKey("display") ? request["display"] : null, displays);
            if (request.ContainsKey("expectedDisplayKey") && !string.Equals(Program.Str(request, "expectedDisplayKey"), display.StableKey, StringComparison.Ordinal))
                throw new HelperError("Display changed; wait for a fresh frame");
            if (Program.Has(request, "expectedDisplayBounds")) {
                var expected = request["expectedDisplayBounds"] as Dictionary<string, object>;
                if (Program.Num(expected, "x", double.NaN) != display.Bounds.X || Program.Num(expected, "y", double.NaN) != display.Bounds.Y ||
                    Program.Num(expected, "width", 0) != display.Bounds.Width || Program.Num(expected, "height", 0) != display.Bounds.Height)
                    throw new HelperError("Display changed; wait for a fresh frame");
            }
            var events = request.ContainsKey("events") ? request["events"] as IList : null;
            int handled = 0;
            if (events != null)
            {
                foreach (object item in events)
                {
                    if (Program.Has(request, "expectedWindow")) WindowsScene.CheckTarget(request);
                    var e = item as Dictionary<string, object>;
                    if (e == null) continue;
                    if (Program.Has(request, "expectedWindow") && Program.Has(e, "x")) WindowsScene.CheckPoint(request, PointOf(e, display, displays));
                    Apply(e, display, displays);
                    handled++;
                }
            }
            var result = new Dictionary<string, object>();
            result["handled"] = handled;
            if (lastPointer.HasValue)
            {
                var landed = Displays.Containing(lastPointer.Value, displays);
                if (landed != null) result["pointerDisplay"] = landed.Id;
            }
            return result;
        }

        static void Apply(Dictionary<string, object> e, DisplayInfo display, List<DisplayInfo> displays)
        {
            var modifiers = Modifiers(e);
            string type = Program.Str(e, "type");
            switch (type)
            {
                case "move":
                    MoveTo(PointOf(e, display, displays));
                    break;
                case "down":
                    {
                        string button = Button(e);
                        MoveTo(PointOf(e, display, displays));
                        WithModifiers(modifiers, delegate { Mouse(ButtonFlag(button, true), 0); heldButtons.Add(button); });
                        break;
                    }
                case "up":
                    {
                        string button = Button(e);
                        MoveTo(PointOf(e, display, displays));
                        WithModifiers(modifiers, delegate { Mouse(ButtonFlag(button, false), 0); heldButtons.Remove(button); });
                        break;
                    }
                case "click":
                    {
                        string button = Button(e);
                        int count = Math.Max(1, Math.Min(3, (int)Program.Num(e, "count", 1)));
                        MoveTo(PointOf(e, display, displays));
                        WithModifiers(modifiers, delegate
                        {
                            // Windows counts a double-click from timing, so the presses go out back to back.
                            for (int i = 0; i < count; i++)
                            {
                                Mouse(ButtonFlag(button, true), 0);
                                Mouse(ButtonFlag(button, false), 0);
                            }
                        });
                        break;
                    }
                case "scroll":
                    {
                        if (Program.Has(e, "x")) MoveTo(PointOf(e, display, displays));
                        // macOS pixel deltas; a wheel notch (120) scrolls about 100 pixels.
                        double dx = Math.Max(-10000, Math.Min(10000, Program.Num(e, "dx", 0)));
                        double dy = Math.Max(-10000, Math.Min(10000, Program.Num(e, "dy", 0)));
                        if (dy != 0) Mouse(Native.MOUSEEVENTF_WHEEL, (int)Math.Round(-dy * 1.2));
                        if (dx != 0) Mouse(Native.MOUSEEVENTF_HWHEEL, (int)Math.Round(dx * 1.2));
                        break;
                    }
                case "key":
                    {
                        int scan = ResolveKey(e, modifiers.Contains("cmd") || modifiers.Contains("ctrl"));
                        if (scan < 0) throw new HelperError("no key for " + (Program.Str(e, "char") ?? Program.Num(e, "keyCode", -1).ToString()) + " on this keyboard layout");
                        object down;
                        bool hasDown = e.TryGetValue("down", out down) && down is bool;
                        WithModifiers(modifiers, delegate
                        {
                            if (hasDown)
                            {
                                Key(scan, (bool)down);
                            }
                            else
                            {
                                Key(scan, true);
                                Key(scan, false);
                            }
                        });
                        break;
                    }
                case "text":
                    TypeText(Program.Str(e, "text") ?? "");
                    break;
                case "paste":
                    Paste(Program.Str(e, "text") ?? "");
                    break;
                default:
                    throw new HelperError("unknown input event: " + (type ?? "nil"));
            }
        }

        static string Button(Dictionary<string, object> e)
        {
            string button = Program.Str(e, "button");
            return button == "right" || button == "middle" ? button : "left";
        }

        static uint ButtonFlag(string button, bool down)
        {
            if (button == "right") return down ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_RIGHTUP;
            if (button == "middle") return down ? Native.MOUSEEVENTF_MIDDLEDOWN : Native.MOUSEEVENTF_MIDDLEUP;
            return down ? Native.MOUSEEVENTF_LEFTDOWN : Native.MOUSEEVENTF_LEFTUP;
        }

        static List<string> Modifiers(Dictionary<string, object> e)
        {
            var names = new List<string>();
            var list = e.ContainsKey("modifiers") ? e["modifiers"] as IList : null;
            if (list == null) return names;
            foreach (object item in list)
            {
                var name = item as string;
                if (name == "meta" || name == "super") name = "cmd";
                if (name == "option") name = "alt";
                if (name == "control") name = "ctrl";
                if (name != null && !names.Contains(name)) names.Add(name);
            }
            return names;
        }

        /// Maps normalized coordinates on `display` to the global desktop. Values outside 0...1 (a drag that
        /// left the viewed display) continue onto neighbouring displays and stop at the desktop's outer edge.
        static Point PointOf(Dictionary<string, object> e, DisplayInfo display, List<DisplayInfo> displays)
        {
            double x = Program.Num(e, "x", 0.5), y = Program.Num(e, "y", 0.5);
            var b = display.Bounds;
            var point = Displays.ClampToDesktop(b.Left + x * (b.Width - 1), b.Top + y * (b.Height - 1), displays);
            lastPointer = point;
            return point;
        }

        static void MoveTo(Point point)
        {
            int left = Native.GetSystemMetrics(76), top = Native.GetSystemMetrics(77);
            int width = Math.Max(2, Native.GetSystemMetrics(78)), height = Math.Max(2, Native.GetSystemMetrics(79));
            var input = new Native.INPUT();
            input.type = Native.INPUT_MOUSE;
            input.u.mi.dx = (int)Math.Round((point.X - left) * 65535.0 / (width - 1));
            input.u.mi.dy = (int)Math.Round((point.Y - top) * 65535.0 / (height - 1));
            input.u.mi.dwFlags = Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK;
            Native.Send(input);
        }

        static void Mouse(uint flags, int data)
        {
            var input = new Native.INPUT();
            input.type = Native.INPUT_MOUSE;
            input.u.mi.dwFlags = flags;
            input.u.mi.mouseData = unchecked((uint)data);
            Native.Send(input);
        }

        static void Key(int scan, bool down)
        {
            var input = new Native.INPUT();
            input.type = Native.INPUT_KEYBOARD;
            input.u.ki.wScan = (ushort)(scan & 0xFF);
            uint flags = Native.KEYEVENTF_SCANCODE;
            if ((scan & 0xE000) == 0xE000) flags |= Native.KEYEVENTF_EXTENDEDKEY;
            if (!down) flags |= Native.KEYEVENTF_KEYUP;
            input.u.ki.dwFlags = flags;
            Native.Send(input);
            if (down) heldKeys.Add(scan); else heldKeys.Remove(scan);
        }

        static void WithModifiers(List<string> modifiers, ThreadStart body)
        {
            var held = new List<int>();
            if (modifiers.Contains("ctrl")) held.Add(ScanCtrl);
            if (modifiers.Contains("alt")) held.Add(ScanAlt);
            if (modifiers.Contains("shift")) held.Add(ScanShift);
            if (modifiers.Contains("cmd")) held.Add(ScanWin);
            try
            {
                foreach (int scan in held) Key(scan, true);
                body();
            }
            finally
            {
                for (int i = held.Count - 1; i >= 0; i--) Key(held[i], false);
            }
        }

        /// A physical key from `keyCode`, or the key that types `char` on the host's layout.
        static int ResolveKey(Dictionary<string, object> e, bool shortcut)
        {
            string text = Program.Str(e, "char");
            if (!string.IsNullOrEmpty(text))
            {
                char character = char.ToLowerInvariant(text[0]);
                short packed = Native.VkKeyScan(character);
                if (packed != -1)
                {
                    uint scan = Native.MapVirtualKey((uint)(packed & 0xFF), 0);
                    if (scan != 0) return (int)scan;
                }
                int fallback;
                return UsLetters.TryGetValue(character, out fallback) ? fallback : -1;
            }
            int code = (int)Program.Num(e, "keyCode", -1);
            int mapped;
            return ScanCodes.TryGetValue(code, out mapped) ? mapped : -1;
        }

        /// Types text as Unicode key events, so any character arrives regardless of the host's layout.
        /// Line breaks and tabs are real Return and Tab presses, as on the other hosts.
        static void TypeText(string text)
        {
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '\r')
                {
                    if (i + 1 < text.Length && text[i + 1] == '\n') continue;
                    c = '\n';
                }
                if (c == '\n')
                {
                    Key(0x1C, true);
                    Key(0x1C, false);
                    continue;
                }
                if (c == '\t')
                {
                    Key(0x0F, true);
                    Key(0x0F, false);
                    continue;
                }
                foreach (bool down in new[] { true, false })
                {
                    var input = new Native.INPUT();
                    input.type = Native.INPUT_KEYBOARD;
                    input.u.ki.wScan = c;
                    input.u.ki.dwFlags = Native.KEYEVENTF_UNICODE | (down ? 0u : Native.KEYEVENTF_KEYUP);
                    Native.Send(input);
                }
            }
        }

        /// Puts the text on the host clipboard and presses Ctrl+V.
        static void Paste(string text)
        {
            ClipboardText.Write(text);
            Thread.Sleep(30);
            short packed = Native.VkKeyScan('v');
            int scan = packed != -1 ? (int)Native.MapVirtualKey((uint)(packed & 0xFF), 0) : 0;
            if (scan == 0) scan = 0x2F;
            Key(ScanCtrl, true);
            Key(scan, true);
            Key(scan, false);
            Key(ScanCtrl, false);
        }
    }

    // MARK: Clipboard

    static class ClipboardText
    {
        public static Dictionary<string, object> Read()
        {
            var result = new Dictionary<string, object>();
            result["changeCount"] = (long)Native.GetClipboardSequenceNumber();
            string text = Retry(delegate { return Clipboard.ContainsText() ? Clipboard.GetText() : null; });
            if (text != null) result["text"] = text;
            result["nonText"] = text == null && Retry(delegate { return Clipboard.GetDataObject() == null || Clipboard.GetDataObject().GetFormats().Length == 0 ? "empty" : "data"; }) == "data";
            return result;
        }

        public static void Write(string text)
        {
            Retry(delegate
            {
                if (text.Length == 0) Clipboard.Clear();
                else Clipboard.SetText(text);
                return (string)null;
            });
        }

        /// Another app can hold the clipboard open for a moment; try a few times.
        static string Retry(Func<string> body)
        {
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    return body();
                }
                catch (ExternalException)
                {
                    if (attempt >= 5) throw new HelperError("the clipboard is in use by another app");
                    Thread.Sleep(30);
                }
            }
        }
    }

    static class WindowsScene
    {
        delegate bool EnumProc(IntPtr window, IntPtr data);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
        [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
        [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
        [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowLong(IntPtr window, int index);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int length);
        [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out uint value, uint size);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Native.POINT point);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);

        public static void CheckPoint(Dictionary<string, object> request, Point point)
        {
            var target = new IntPtr((long)Program.Num(request, "expectedWindow", 0)); Native.RECT rect;
            var hit = WindowFromPoint(new Native.POINT { x = point.X, y = point.Y });
            if (!Native.GetWindowRect(target, out rect) || point.X < rect.left || point.Y < rect.top || point.X >= rect.right || point.Y >= rect.bottom || GetAncestor(hit, 2) != target)
                throw new HelperError("The pointer target is outside or covered by another window");
        }

        public static void CheckTarget(Dictionary<string, object> request)
        {
            var target = new IntPtr((long)Program.Num(request, "expectedWindow", 0));
            uint pid; GetWindowThreadProcessId(target, out pid);
            using (var process = Process.GetProcessById((int)pid)) {
                if (Native.GetForegroundWindow() != target || !IsWindowVisible(target) ||
                    !string.Equals(process.ProcessName + ".exe", Program.Str(request, "expectedApp"), StringComparison.OrdinalIgnoreCase))
                    throw new HelperError("Target window changed before input; read it again");
            }
        }

        public static Dictionary<string, object> Read()
        {
            var windows = new List<object>();
            var displays = Displays.List();
            EnumProc callback = delegate(IntPtr window, IntPtr data) {
                if (!IsWindowVisible(window) || window == ControlNotice.WindowHandle) return true;
                uint pid; GetWindowThreadProcessId(window, out pid);
                Native.RECT rect;
                var title = new StringBuilder(2048); GetWindowText(window, title, title.Capacity);
                if (title.Length == 0 || !Native.GetWindowRect(window, out rect)) return true;
                try {
                    var process = Process.GetProcessById((int)pid);
                    var display = Displays.Containing(new Point((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2), displays);
                    windows.Add(new Dictionary<string, object> {
                        { "id", window.ToInt64() }, { "app", process.ProcessName.ToLowerInvariant() + ".exe" },
                        { "title", title.ToString() }, { "focused", Native.GetForegroundWindow() == window },
                        { "minimized", IsIconic(window) }, { "display", display == null ? 0 : display.Id },
                        { "x", rect.left }, { "y", rect.top }, { "width", rect.right - rect.left }, { "height", rect.bottom - rect.top }
                    });
                    process.Dispose();
                } catch (ArgumentException) { } catch (System.ComponentModel.Win32Exception) { }
                return true;
            };
            EnumWindows(callback, IntPtr.Zero); GC.KeepAlive(callback);
            var list = new List<object>(); foreach (var display in displays) list.Add(display.Json());
            return new Dictionary<string, object> { { "windows", windows }, { "displays", list }, { "locked", Native.SecureDesktopShowing() }, { "sessionId", Process.GetCurrentProcess().SessionId } };
        }

        public static Dictionary<string, object> Focus(Dictionary<string, object> request)
        {
            if (Native.SecureDesktopShowing()) throw new HelperError("Desktop locked or unavailable");
            var window = new IntPtr((long)Program.Num(request, "window", 0));
            uint pid; GetWindowThreadProcessId(window, out pid);
            using (var process = Process.GetProcessById((int)pid)) {
                if (!string.Equals(process.ProcessName + ".exe", Program.Str(request, "expectedApp"), StringComparison.OrdinalIgnoreCase)) throw new HelperError("The intended app/window changed before focus");
            }
            if (IsIconic(window)) ShowWindow(window, 9);
            SetForegroundWindow(window);
            return new Dictionary<string, object> { { "focused", Native.GetForegroundWindow() == window } };
        }

        static bool UserWindow(IntPtr window, bool movable)
        {
            if (!IsWindowVisible(window) || window == ControlNotice.WindowHandle ||
                window == GetDesktopWindow() || window == GetShellWindow() || GetAncestor(window, 2) != window)
                return false;
            uint style = unchecked((uint)GetWindowLong(window, -16));
            uint extended = unchecked((uint)GetWindowLong(window, -20));
            if ((style & 0x40000000U) != 0 || (extended & (0x80U | 0x08000000U)) != 0)
                return false; // Child windows, tool windows and no-activate overlays.
            if (movable && (IsIconic(window) || IsZoomed(window) || GetWindow(window, 4) != IntPtr.Zero ||
                (style & 0x08000000U) != 0 || (extended & 0x8U) != 0)) return false;
            var className = new StringBuilder(256);
            if (GetClassName(window, className, className.Capacity) == 0) return false;
            string name = className.ToString();
            if (name == "Shell_TrayWnd" || name == "Shell_SecondaryTrayWnd" || name == "Progman" || name == "WorkerW") return false;
            var title = new StringBuilder(2);
            if (GetWindowText(window, title, title.Capacity) == 0 && movable) return false;
            uint cloaked;
            try { if (DwmGetWindowAttribute(window, 14, out cloaked, 4) == 0 && cloaked != 0) return false; }
            catch (DllNotFoundException) { return false; }
            catch (EntryPointNotFoundException) { return false; }
            uint pid; GetWindowThreadProcessId(window, out pid);
            using (var self = Process.GetCurrentProcess())
            {
                if (pid == 0 || pid == (uint)self.Id) return false;
                using (var process = Process.GetProcessById((int)pid)) return process.SessionId == self.SessionId;
            }
        }

        static bool OnDisplay(IntPtr window, DisplayInfo display)
        {
            // MonitorFromWindow uses the pre-minimized rectangle for minimized windows.
            // https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-monitorfromwindow
            var monitor = MonitorFromWindow(window, 0);
            if (monitor == IntPtr.Zero) return false;
            var info = new Native.MONITORINFOEX(); info.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFOEX));
            if (!Native.GetMonitorInfo(monitor, ref info)) throw new HelperError("Could not verify a window's display");
            return string.Equals(info.szDevice, display.DeviceName, StringComparison.OrdinalIgnoreCase);
        }

        public static Dictionary<string, object> Migrate(Dictionary<string, object> request)
        {
            // The server exposes this command only after an explicit human action and ownership
            // takeover. Neither topology polling nor the capture/input paths ever call it.
            if (Native.SecureDesktopShowing()) throw new HelperError("Unlock the interactive desktop before moving windows");
            WindowsTopology topology;
            var displays = Displays.List(out topology);
            if (!topology.Reliable) throw new HelperError("Display topology is unavailable: " + topology.Error);
            var from = Displays.ByKey(Program.Str(request, "from"), displays);
            var to = Displays.ByKey(Program.Str(request, "to"), displays);
            if (from.Kind != "virtual" || to.Kind != "physical" || from.StableKey == to.StableKey || from.Bounds.IntersectsWith(to.Bounds))
                throw new HelperError("Windows can only move from an active virtual display to a separate active physical display");
            Rectangle area = to.WorkArea;
            if (area.Width <= 0 || area.Height <= 0 || !to.Bounds.Contains(area)) throw new HelperError("The physical display's work area is unavailable");
            int skipped = 0;
            var pending = new Dictionary<IntPtr, uint>();
            var verified = new HashSet<IntPtr>();
            var failures = new HashSet<IntPtr>();
            string aborted = null;
            EnumProc callback = delegate(IntPtr window, IntPtr data)
            {
                try
                {
                    Native.RECT nativeRect;
                    if (!UserWindow(window, true) || !Native.GetWindowRect(window, out nativeRect)) { skipped++; return true; }
                    var rect = Rectangle.FromLTRB(nativeRect.left, nativeRect.top, nativeRect.right, nativeRect.bottom);
                    if (rect.Width <= 0 || rect.Height <= 0 || !from.Bounds.Contains(rect)) { skipped++; return true; }
                    // Fresh active identities/bounds for every candidate; stop on hotplug or a locked
                    // desktop instead of moving the remaining windows onto an unrelated source.
                    if (Native.SecureDesktopShowing()) { aborted = "Desktop locked during window migration"; return false; }
                    var current = Displays.List();
                    var currentFrom = Displays.ByKey(from.StableKey, current);
                    var currentTo = Displays.ByKey(to.StableKey, current);
                    if (currentFrom.Kind != "virtual" || currentTo.Kind != "physical" || currentFrom.Bounds != from.Bounds || currentTo.Bounds != to.Bounds || currentTo.WorkArea != area)
                    {
                        aborted = "Display changed during window migration"; return false;
                    }
                    // The user/app may have moved or closed the window during the topology query.
                    if (!UserWindow(window, true) || !Native.GetWindowRect(window, out nativeRect)) { skipped++; return true; }
                    rect = Rectangle.FromLTRB(nativeRect.left, nativeRect.top, nativeRect.right, nativeRect.bottom);
                    if (rect.Width <= 0 || rect.Height <= 0 || !from.Bounds.Contains(rect)) { skipped++; return true; }
                    int width = Math.Min(rect.Width, area.Width), height = Math.Min(rect.Height, area.Height);
                    int x = area.Left + Math.Min(Math.Max(0, rect.Left - from.Bounds.Left), area.Width - width);
                    int y = area.Top + Math.Min(Math.Max(0, rect.Top - from.Bounds.Top), area.Height - height);
                    // No activation, z-order/owner change or blocking calls into another application's UI.
                    // https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-setwindowpos
                    uint pid; GetWindowThreadProcessId(window, out pid);
                    if (SetWindowPos(window, IntPtr.Zero, x, y, width, height, 0x0010 | 0x0004 | 0x0200 | 0x4000)) pending[window] = pid;
                    else failures.Add(window);
                }
                catch (HelperError error) { aborted = error.Message; return false; }
                catch (ArgumentException) { skipped++; }
                catch (InvalidOperationException) { skipped++; }
                catch (System.ComponentModel.Win32Exception) { failures.Add(window); }
                catch (Exception error) { aborted = "Window migration failed: " + error.Message; return false; }
                return true;
            };
            bool enumerated = EnumWindows(callback, IntPtr.Zero); GC.KeepAlive(callback);
            if (!enumerated && aborted == null) aborted = "Window enumeration failed";

            // Async success only means the other UI thread accepted the request. Give all requests a
            // single shared one-second budget, and never report a pending request as a completed move.
            var timer = Stopwatch.StartNew();
            while (pending.Count != 0)
            {
                foreach (var window in new List<IntPtr>(pending.Keys))
                {
                    uint pid; GetWindowThreadProcessId(window, out pid);
                    if (pid == 0 || pid != pending[window]) { pending.Remove(window); skipped++; continue; }
                    Native.RECT rect;
                    if (Native.GetWindowRect(window, out rect) && rect.right > rect.left && rect.bottom > rect.top &&
                        area.Contains(Rectangle.FromLTRB(rect.left, rect.top, rect.right, rect.bottom)))
                    {
                        verified.Add(window); pending.Remove(window);
                    }
                }
                long wait = 1000 - timer.ElapsedMilliseconds;
                if (pending.Count == 0 || wait <= 0) break;
                Thread.Sleep((int)Math.Min(20, wait));
            }
            foreach (var window in pending.Keys) failures.Add(window);

            // Minimized/maximized, owned, disabled, topmost or spanning user windows are not silently
            // restored/moved. If any remain on the virtual monitor, fail closed so the server keeps it
            // enabled. This also catches windows opened while the earlier moves were in flight.
            int remaining = 0;
            EnumProc check = delegate(IntPtr window, IntPtr data)
            {
                try
                {
                    if (UserWindow(window, false) && OnDisplay(window, from))
                    {
                        remaining++; failures.Add(window); verified.Remove(window);
                    }
                }
                catch (Exception error) { aborted = "Could not verify remaining windows: " + error.Message; return false; }
                return true;
            };
            if (!EnumWindows(check, IntPtr.Zero) && aborted == null) aborted = "Remaining window enumeration failed";
            GC.KeepAlive(check);
            try
            {
                var final = Displays.List(out topology);
                var finalFrom = Displays.ByKey(from.StableKey, final);
                var finalTo = Displays.ByKey(to.StableKey, final);
                if (!topology.Reliable || finalFrom.Kind != "virtual" || finalTo.Kind != "physical" ||
                    finalFrom.Bounds != from.Bounds || finalTo.Bounds != to.Bounds || finalTo.WorkArea != area || Native.SecureDesktopShowing())
                    aborted = "Desktop or display topology changed during window migration";
            }
            catch (HelperError error) { aborted = error.Message; }
            var result = new Dictionary<string, object> {
                { "from", from.StableKey }, { "to", to.StableKey }, { "moved", verified.Count }, { "skipped", skipped },
                { "failed", failures.Count + (aborted == null ? 0 : 1) }, { "remaining", remaining }
            };
            if (aborted != null) result["interrupted"] = aborted;
            return result;
        }

        public static Dictionary<string, object> Signature(Dictionary<string, object> request)
        {
            if (Native.SecureDesktopShowing()) throw new HelperError("Desktop locked or unavailable");
            var display = Displays.Resolve(request["display"], Displays.List());
            WindowsScene.CheckTarget(request);
            using (var full = Capture.BitmapOf(display.Bounds, new IntPtr((long)Program.Num(request, "expectedWindow", 0))))
            using (var small = new Bitmap(64, 40)) {
                using (var g = Graphics.FromImage(small)) g.DrawImage(full, 0, 0, 64, 40);
                var bytes = new byte[64 * 40];
                for (int y = 0; y < 40; y++) for (int x = 0; x < 64; x++) {
                    var c = small.GetPixel(x, y); bytes[y * 64 + x] = (byte)Math.Round(.299 * c.R + .587 * c.G + .114 * c.B);
                }
                return new Dictionary<string, object> { { "signature", Convert.ToBase64String(bytes) }, { "width", 64 }, { "height", 40 } };
            }
        }
    }

    class NoticeForm : Form
    {
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80; return p; } }
        protected override void WndProc(ref Message m) { if (m.Msg == 0x21) { m.Result = new IntPtr(3); return; } base.WndProc(ref m); }
    }

    static class ControlNotice
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string className, string title);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        static NoticeForm form;
        static Label label;
        static Thread thread;
        static bool closing;
        public static IntPtr WindowHandle;
        static void Start()
        {
            if (form != null && !form.IsDisposed) return;
            var ready = new ManualResetEvent(false);
            thread = new Thread(delegate() {
                form = new NoticeForm { Text = "Paseo Remote Control", FormBorderStyle = FormBorderStyle.None, ShowInTaskbar = false,
                    TopMost = true, Font = new Font("Segoe UI", 9), AutoScaleMode = AutoScaleMode.None, Size = new Size(600, 74), BackColor = Color.FromArgb(24, 34, 39), StartPosition = FormStartPosition.Manual };
                label = new Label { Location = new Point(16, 12), Size = new Size(324, 52), ForeColor = Color.White,
                    Font = new Font("Segoe UI", 10), AutoEllipsis = true };
                form.Controls.Add(label);
                var take = new Button { Text = "Take over", Location = new Point(350, 20), Size = new Size(112, 34), BackColor = Color.FromArgb(118, 219, 192), ForeColor = Color.FromArgb(16, 34, 34), FlatStyle = FlatStyle.Flat };
                var pause = new Button { Text = "Pause all", Location = new Point(474, 20), Size = new Size(110, 34), BackColor = form.BackColor, ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
                take.Click += delegate { Program.Reply(new Dictionary<string, object> { { "event", "control" }, { "action", "takeover" } }); };
                pause.Click += delegate { Program.Reply(new Dictionary<string, object> { { "event", "control" }, { "action", "pause" } }); };
                form.Controls.Add(take); form.Controls.Add(pause);
                WindowHandle = form.Handle; ready.Set();
                form.FormClosed += delegate { if (!closing) Program.Reply(new Dictionary<string, object> { { "event", "notice-lost" } }); };
                Application.Run();
            });
            thread.IsBackground = true; thread.SetApartmentState(ApartmentState.STA); thread.Start();
            if (!ready.WaitOne(3000)) throw new HelperError("Control notice could not start");
        }

        public static Dictionary<string, object> Update(Dictionary<string, object> request)
        {
            Start(); bool shown = false;
            form.Invoke((MethodInvoker)delegate {
                if (Program.Str(request, "mode") != "agent") { form.Hide(); return; }
                if (Native.SecureDesktopShowing()) throw new HelperError("Control notice cannot be shown on a secure desktop");
                string who = Program.Str(request, "label") ?? Program.Str(request, "agentId") ?? "Agent";
                label.Text = "AGENT CONTROLLING  " + who + "\n" + (Program.Str(request, "tool") ?? "") + "  " + (Program.Str(request, "app") ?? "");
                var area = Screen.FromPoint(Native.ForegroundWindowCenter()).WorkingArea;
                form.Location = new Point(area.Right - form.Width - 16, area.Top + 16);
                form.Show(); shown = form.Visible;
            });
            return new Dictionary<string, object> { { "shown", shown } };
        }
        public static void Stop() { closing = true; if (form != null && !form.IsDisposed) form.BeginInvoke((MethodInvoker)delegate { form.Close(); Application.ExitThread(); }); }
        public static Dictionary<string, object> Location()
        {
            var window = FindWindow(null, "Paseo Remote Control"); Native.RECT rect;
            var button = FindWindowEx(window, IntPtr.Zero, null, "Take over");
            if (window == IntPtr.Zero || button == IntPtr.Zero || !IsWindowVisible(window) || !Native.GetWindowRect(button, out rect)) return new Dictionary<string, object> { { "visible", false } };
            Native.RECT pauseRect;
            var pause = FindWindowEx(window, IntPtr.Zero, null, "Pause all");
            if (pause == IntPtr.Zero || !Native.GetWindowRect(pause, out pauseRect)) return new Dictionary<string, object> { { "visible", false } };
            var cursor = new Native.CURSORINFO(); cursor.cbSize = Marshal.SizeOf(typeof(Native.CURSORINFO)); Native.GetCursorInfo(ref cursor);
            return new Dictionary<string, object> { { "visible", true }, { "window", window.ToInt64() }, { "button", button.ToInt64() }, { "takeX", (rect.left + rect.right) / 2 }, { "takeY", (rect.top + rect.bottom) / 2 }, { "pauseX", (pauseRect.left + pauseRect.right) / 2 }, { "pauseY", (pauseRect.top + pauseRect.bottom) / 2 }, { "cursorX", cursor.ptScreenPos.x }, { "cursorY", cursor.ptScreenPos.y }, { "hit", WindowsScene.WindowFromPoint(cursor.ptScreenPos).ToInt64() } };
        }
    }

    // MARK: Win32

    static class Native
    {
        public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
        public const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
        public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000, MOUSEEVENTF_ABSOLUTE = 0x8000;
        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_SCANCODE = 0x0008;

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int x; public int y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int left; public int top; public int right; public int bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public InputUnion u; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct MONITORINFOEX
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct DISPLAY_DEVICE
        {
            public int cb;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
            public int StateFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
        }

        // CCD structures use DWORD/UINT32, including BOOL, with 32-bit LUID members on both ABIs.
        // https://learn.microsoft.com/windows/win32/api/wingdi/ns-wingdi-displayconfig_path_info
        [StructLayout(LayoutKind.Sequential)]
        public struct LUID { public uint LowPart; public int HighPart; }

        [StructLayout(LayoutKind.Sequential)]
        public struct DISPLAYCONFIG_PATH_SOURCE_INFO { public LUID adapterId; public uint id, modeInfoIdx, statusFlags; }

        [StructLayout(LayoutKind.Sequential)]
        public struct DISPLAYCONFIG_RATIONAL { public uint numerator, denominator; }

        [StructLayout(LayoutKind.Sequential)]
        public struct DISPLAYCONFIG_PATH_TARGET_INFO
        {
            public LUID adapterId;
            public uint id, modeInfoIdx, outputTechnology, rotation, scaling;
            public DISPLAYCONFIG_RATIONAL refreshRate;
            public uint scanLineOrdering;
            public int targetAvailable;
            public uint statusFlags;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct DISPLAYCONFIG_PATH_INFO
        {
            public DISPLAYCONFIG_PATH_SOURCE_INFO sourceInfo;
            public DISPLAYCONFIG_PATH_TARGET_INFO targetInfo;
            public uint flags;
        }

        // The mode union is 48 bytes (includes the 64-bit pixel clock). Only source fields are read.
        [StructLayout(LayoutKind.Explicit, Size = 64)]
        public struct DISPLAYCONFIG_MODE_INFO
        {
            [FieldOffset(0)] public uint infoType;
            [FieldOffset(4)] public uint id;
            [FieldOffset(8)] public LUID adapterId;
            [FieldOffset(16)] public uint width;
            [FieldOffset(20)] public uint height;
            [FieldOffset(28)] public POINT position;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct DISPLAYCONFIG_DEVICE_INFO_HEADER { public uint type, size; public LUID adapterId; public uint id; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct DISPLAYCONFIG_SOURCE_DEVICE_NAME
        {
            public DISPLAYCONFIG_DEVICE_INFO_HEADER header;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string viewGdiDeviceName;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct DISPLAYCONFIG_TARGET_DEVICE_NAME
        {
            public DISPLAYCONFIG_DEVICE_INFO_HEADER header;
            public uint flags, outputTechnology;
            public ushort edidManufactureId, edidProductCodeId;
            public uint connectorInstance;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string monitorFriendlyDeviceName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string monitorDevicePath;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct DISPLAYCONFIG_ADAPTER_NAME
        {
            public DISPLAYCONFIG_DEVICE_INFO_HEADER header;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string adapterDevicePath;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct DEVMODE
        {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
            public ushort dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
            public uint dmFields;
            public POINT dmPosition;
            public uint dmDisplayOrientation, dmDisplayFixedOutput;
            public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
            public ushort dmLogPixels;
            public uint dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
            public uint dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct SP_DEVICE_INTERFACE_DATA { public uint cbSize; public Guid interfaceClassGuid; public uint flags; public IntPtr reserved; }

        [StructLayout(LayoutKind.Sequential)]
        struct SP_DEVINFO_DATA { public uint cbSize; public Guid classGuid; public uint devInst; public IntPtr reserved; }

        [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint period);
        [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint period);
        [DllImport("user32.dll")] public static extern int GetDisplayConfigBufferSizes(uint flags, out uint pathCount, out uint modeCount);
        [DllImport("user32.dll")] public static extern int QueryDisplayConfig(uint flags, ref uint pathCount, [Out] DISPLAYCONFIG_PATH_INFO[] paths, ref uint modeCount, [Out] DISPLAYCONFIG_MODE_INFO[] modes, IntPtr topologyId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int DisplayConfigGetDeviceInfo(ref DISPLAYCONFIG_SOURCE_DEVICE_NAME info);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int DisplayConfigGetDeviceInfo(ref DISPLAYCONFIG_TARGET_DEVICE_NAME info);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int DisplayConfigGetDeviceInfo(ref DISPLAYCONFIG_ADAPTER_NAME info);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE mode);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string deviceName, ref DEVMODE mode, IntPtr window, uint flags, IntPtr param);
        [DllImport("setupapi.dll", SetLastError = true)] static extern IntPtr SetupDiCreateDeviceInfoList(IntPtr classGuid, IntPtr window);
        [DllImport("setupapi.dll", SetLastError = true)] static extern bool SetupDiDestroyDeviceInfoList(IntPtr devices);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr SetupDiGetClassDevs(ref Guid classGuid, string enumerator, IntPtr window, uint flags);
        [DllImport("setupapi.dll", SetLastError = true)] static extern bool SetupDiEnumDeviceInfo(IntPtr devices, uint index, ref SP_DEVINFO_DATA device);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetupDiOpenDeviceInterface(IntPtr devices, string devicePath, uint flags, ref SP_DEVICE_INTERFACE_DATA info);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr devices, ref SP_DEVICE_INTERFACE_DATA info, IntPtr detail, uint detailSize, out uint requiredSize, ref SP_DEVINFO_DATA device);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetupDiGetDeviceRegistryProperty(IntPtr devices, ref SP_DEVINFO_DATA device, uint property, out uint type, [Out] byte[] buffer, uint size, out uint requiredSize);

        public static bool PresentMonitorsMapped(List<string> monitorPaths, out string error)
        {
            error = null;
            var monitorClass = new Guid("4d36e96e-e325-11ce-bfc1-08002be10318");
            // DIGCF_PRESENT excludes phantom monitor devnodes left behind after unplugging.
            // https://learn.microsoft.com/windows/win32/api/setupapi/nf-setupapi-setupdigetclassdevsw
            IntPtr present = SetupDiGetClassDevs(ref monitorClass, null, IntPtr.Zero, 2);
            if (present == new IntPtr(-1)) { error = "Present monitor enumeration failed (" + Marshal.GetLastWin32Error() + ")"; return false; }
            var devnodes = new HashSet<uint>();
            try
            {
                for (uint index = 0; ; index++)
                {
                    var device = new SP_DEVINFO_DATA(); device.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
                    if (!SetupDiEnumDeviceInfo(present, index, ref device))
                    {
                        int result = Marshal.GetLastWin32Error();
                        if (result == 259) break; // ERROR_NO_MORE_ITEMS is the only successful end.
                        error = "Present monitor enumeration failed (" + result + ")"; return false;
                    }
                    devnodes.Add(device.devInst);
                }
            }
            finally { SetupDiDestroyDeviceInfoList(present); }
            if (devnodes.Count == 0) return true;

            // Resolve other QDC monitor interface paths to exact devnodes. Do not parse symbolic paths
            // or presume every present monitor is the VDD just because a VDD driver is installed.
            IntPtr mapped = SetupDiCreateDeviceInfoList(IntPtr.Zero, IntPtr.Zero);
            if (mapped == new IntPtr(-1)) { error = "Monitor device mapping failed"; return false; }
            try
            {
                foreach (string path in monitorPaths)
                {
                    var iface = new SP_DEVICE_INTERFACE_DATA(); iface.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVICE_INTERFACE_DATA));
                    if (!SetupDiOpenDeviceInterface(mapped, path, 0, ref iface)) { error = "A monitor interface changed during display detection"; return false; }
                    var device = new SP_DEVINFO_DATA(); device.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
                    uint required;
                    bool found = SetupDiGetDeviceInterfaceDetail(mapped, ref iface, IntPtr.Zero, 0, out required, ref device);
                    if (!found && Marshal.GetLastWin32Error() != 122) { error = "A monitor devnode could not be verified"; return false; }
                    devnodes.Remove(device.devInst);
                }
                if (devnodes.Count == 0) return true;
                error = "An unmatched present monitor prevents forced-display fallback";
                return false;
            }
            finally { SetupDiDestroyDeviceInfoList(mapped); }
        }

        public static string[] AdapterHardwareIds(string adapterPath)
        {
            if (string.IsNullOrEmpty(adapterPath)) return new string[0];
            // Resolve the interface to its devnode. A ROOT\\DISPLAY instance path says nothing about
            // the driver; the exact HardwareIDs property identifies VirtualDrivers' MttVDD instead.
            // https://learn.microsoft.com/windows/win32/api/setupapi/nf-setupapi-setupdigetdeviceinterfacedetailw
            IntPtr devices = SetupDiCreateDeviceInfoList(IntPtr.Zero, IntPtr.Zero);
            if (devices == new IntPtr(-1)) return new string[0];
            try
            {
                var iface = new SP_DEVICE_INTERFACE_DATA(); iface.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVICE_INTERFACE_DATA));
                if (!SetupDiOpenDeviceInterface(devices, adapterPath, 0, ref iface)) return new string[0];
                var device = new SP_DEVINFO_DATA(); device.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
                uint required;
                // With a NULL detail buffer this returns ERROR_INSUFFICIENT_BUFFER but fills DeviceInfoData.
                // The documented behavior avoids variable-length interface-detail ABI differences.
                bool found = SetupDiGetDeviceInterfaceDetail(devices, ref iface, IntPtr.Zero, 0, out required, ref device);
                if (!found && Marshal.GetLastWin32Error() != 122) return new string[0];
                uint type;
                SetupDiGetDeviceRegistryProperty(devices, ref device, 1, out type, null, 0, out required); // SPDRP_HARDWAREID
                if (required == 0 || required > 65536 || (required & 1) != 0) return new string[0];
                var buffer = new byte[required];
                if (!SetupDiGetDeviceRegistryProperty(devices, ref device, 1, out type, buffer, (uint)buffer.Length, out required) || type != 7 || required > buffer.Length)
                    return new string[0]; // REG_MULTI_SZ only; fail closed if the driver cannot be verified.
                return Encoding.Unicode.GetString(buffer, 0, (int)required).Split(new[] { '\0' }, StringSplitOptions.RemoveEmptyEntries);
            }
            finally { SetupDiDestroyDeviceInfoList(devices); }
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }

        [StructLayout(LayoutKind.Sequential)]
        public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }

        public delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data);

        [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplayDevices(string device, uint index, ref DISPLAY_DEVICE info, uint flags);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO info);
        [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
        [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int width, int height, int step, IntPtr brush, int flags);
        [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr handle);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char character);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
        [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, int length, out int needed);
        [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
        [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
        [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        public static void Send(INPUT input)
        {
            if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new HelperError("SendInput was refused (desktop or application integrity level). No elevation is attempted.");
        }

        /// Per-monitor DPI awareness makes monitor bounds, capture and input all use physical pixels.
        public static void EnableDpiAwareness()
        {
            // Each call exists from a later Windows version than the next; older ones fall through.
            try
            {
                if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
            }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
            try
            {
                if (SetProcessDpiAwareness(2) == 0) return;
            }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
            try
            {
                SetProcessDPIAware();
            }
            catch (DllNotFoundException) { }
        }

        /// True while the lock screen, sign-in screen or a UAC prompt (a secure desktop) has the input.
        public static bool SecureDesktopShowing()
        {
            IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
            if (desktop == IntPtr.Zero) return true;
            try
            {
                var name = new StringBuilder(256);
                int needed;
                if (!GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed)) return true;
                return Process.GetCurrentProcess().SessionId == 0 || !string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
            }
            finally
            {
                CloseDesktop(desktop);
            }
        }

        public static Point ForegroundWindowCenter()
        {
            RECT rect;
            IntPtr window = GetForegroundWindow();
            if (window == IntPtr.Zero || !GetWindowRect(window, out rect)) return new Point(int.MinValue, int.MinValue);
            return new Point((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
        }

        /// Turns the display back on, as a key press would. Called only for an explicit wake request.
        public static void WakeDisplay()
        {
            SetThreadExecutionState(0x00000002); // ES_DISPLAY_REQUIRED, once: resets the display idle timer.
            var nudge = new INPUT();
            nudge.type = INPUT_MOUSE;
            nudge.u.mi.dwFlags = MOUSEEVENTF_MOVE;
            nudge.u.mi.dx = 1;
            Send(nudge);
            nudge.u.mi.dx = -1;
            Send(nudge);
        }
    }
}
