using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using Autodesk.Revit.UI;

namespace RevitBridge.Operator
{
    internal static class OperatorCapabilities
    {
        public const string Version = "operator.capabilities.v1";

        public static object Get(UIApplication? app = null)
        {
            var allowlist = new List<object>();
            foreach (var p in OperatorActionAllowlist.EnumerateAllowed())
            {
                allowlist.Add(new { method = p.Method, path = p.Path });
            }

            object? addin = null;
            try
            {
                var asm = typeof(OperatorCapabilities).Assembly;
                var name = asm.GetName();
                string? fileVersion = null;
                string? productVersion = null;
                string? location = null;
                try
                {
                    location = asm.Location;
                    var fvi = FileVersionInfo.GetVersionInfo(location);
                    fileVersion = fvi?.FileVersion;
                    productVersion = fvi?.ProductVersion;
                }
                catch
                {
                    // ignore
                }

                addin = new
                {
                    assembly = name.Name,
                    assembly_version = name.Version?.ToString(),
                    file_version = fileVersion,
                    product_version = productVersion,
                    location
                };
            }
            catch
            {
                addin = null;
            }

            return new
            {
                version = Version,
                generated_at = DateTime.UtcNow.ToString("o"),
                addin,
                tool_host = new
                {
                    version = OperatorToolHostProtocol.Version,
                    actions = new
                    {
                        open = "/ui/open",
                        close = "/ui/close"
                    },
                    bridge = new
                    {
                        message_types = new[]
                        {
                            "host.ping",
                            "host.close",
                            "revit.ping",
                            "revit.pickElements",
                            "revit.pickPoints",
                            "revit.showElements",
                            "revit.executeAction",
                            "backend.request"
                        },
                        notes = new[]
                        {
                            "Hosted pages run inside WebView2 and must use the host bridge for Revit or authenticated backend calls.",
                            "High-risk tool-host actions are blocked in safe mode unless the user enables writes."
                        }
                    }
                },
                tools = OperatorToolManifest.Tools,
                tool_registry = new
                {
                    version = OperatorToolIntrospection.RegistryVersion,
                    endpoints = new
                    {
                        registry = "/revit/tool-registry",
                        tool_search = "/revit/tool-search",
                        tool_doc = "/revit/tool-doc",
                        tool_examples = "/revit/tool-examples",
                        self_test = "/revit/self-test"
                    },
                    note = "Use /revit/tool-search to find the best curated /revit/* primitive by intent, then /revit/tool-doc for exact fields/enums/units. /revit/tool-registry is larger."
                },
                native_api = new
                {
                    version = "operator.native_api_gateway.v1",
                    endpoints = new
                    {
                        policy = "/revit/native-api-policy",
                        catalog = "/revit/native-api-catalog",
                        search = "/revit/native-api-search",
                        call = "/revit/native-api-call"
                    },
                    policy = OperatorNativeApiPolicy.GetStatus(),
                    note = "Native API gateway supports reflected member discovery/search/call with profile-based guardrails (balanced|broad|unrestricted)."
                },
                native_operator = BuildNativeOperatorProbe(app),
                sidecar = BuildSidecarProbe(),
                allowlist
            };
        }

        private static object BuildNativeOperatorProbe(UIApplication? app)
        {
            var uidoc = app?.ActiveUIDocument;
            var doc = uidoc?.Document;
            var view = doc?.ActiveView;
            return new
            {
                schema = "operator.native_capabilities.v1",
                revit_api_bridge_available = true,
                external_event_queue_available = true,
                current_document_available = doc != null,
                active_view_available = view != null,
                active_view_capture_export_available = true,
                spatial_query_tools_available = true,
                room_query_tools_available = true,
                dialog_guardian_registered = App.Instance?.DialogComputerUse != null,
                webview2_available = OperatorWebView2Probe.IsAvailable(),
                local_config_log_write_path_available = CanWriteLocalOperatorPath(),
                mode = (Environment.GetEnvironmentVariable("REVIT_OPERATOR_MODE") ?? "local").Trim(),
                document = doc == null ? null : new
                {
                    title = doc.Title,
                    path = doc.PathName,
                    is_workshared = SafeBool(() => doc.IsWorkshared)
                },
                active_view = view == null ? null : new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                    name = view.Name,
                    type = view.ViewType.ToString(),
                    scale = SafeInt(() => view.Scale)
                },
                native_tools = new
                {
                    capture_active_view = "/revit/export-image",
                    export_active_view_image = "/revit/export-image",
                    capture_current_sheet_or_view = "/revit/export-view-frame",
                    get_visible_elements_with_screen_or_view_coordinates = "/revit/export-visible-elements",
                    highlight_elements_for_capture = "/revit/highlight-and-export",
                    capture_before_after = "compose /revit/export-view-frame or /revit/export-visible-elements before and after the write",
                    get_spatial_context_for_room = "/revit/spatial-context",
                    model_to_view2d = "/revit/export-visible-elements mapping",
                    view2d_to_model = "/revit/pick-at-pixel or /revit/pick-candidate-cluster",
                    get_nearest_wall = "/revit/get-placement-context",
                    get_room_wall_segments = "/revit/resolve-room-wall",
                    get_similar_nearby_device = "/revit/rank-similar-devices-on-wall",
                    place_similar_device_nearby = "/revit/create-similar-from-instance",
                    assign_electrical_circuit = "/revit/assign-electrical-circuit",
                    move_element_along_wall = "/revit/adjust-hosted-instance-on-host",
                    rotate_element_to_face_wall = "/revit/adjust-hosted-instance-on-host",
                    verify_device_in_room = "/revit/audit-hosted-instance-placement",
                    verify_device_on_or_near_wall = "/revit/audit-hosted-instance-placement",
                    verify_device_orientation = "/revit/audit-hosted-instance-placement"
                }
            };
        }

        private static object BuildSidecarProbe()
        {
            var url = (Environment.GetEnvironmentVariable("OPERATOR_SIDECAR_HEALTH_URL") ?? "").Trim();
            if (string.IsNullOrWhiteSpace(url))
            {
                var port = (Environment.GetEnvironmentVariable("OPERATOR_SIDECAR_PORT") ?? "5010").Trim();
                url = $"http://127.0.0.1:{port}/health";
            }
            return new
            {
                reachable = false,
                health_endpoint = url,
                desktop_screenshot_available = false,
                mouse_keyboard_automation_available = false,
                os_window_tools_available = false,
                note = "Sidecar health is diagnosed by backend /environment/sidecar-diagnostics. Native Revit API workflows remain available without sidecar."
            };
        }

        private static bool CanWriteLocalOperatorPath()
        {
            try
            {
                var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevitOperator", "Logs");
                Directory.CreateDirectory(root);
                var file = Path.Combine(root, $".probe_{Process.GetCurrentProcess().Id}_{DateTime.UtcNow.Ticks}.tmp");
                File.WriteAllText(file, "ok");
                File.Delete(file);
                return true;
            }
            catch { return false; }
        }

        private static bool SafeBool(Func<bool> fn) { try { return fn(); } catch { return false; } }
        private static int SafeInt(Func<int> fn) { try { return fn(); } catch { return 0; } }
    }

    internal static class OperatorWebView2Probe
    {
        public static bool IsAvailable()
        {
            try
            {
                var type = Type.GetType("Microsoft.Web.WebView2.Wpf.WebView2, Microsoft.Web.WebView2.Wpf");
                return type != null;
            }
            catch { return false; }
        }
    }
}
