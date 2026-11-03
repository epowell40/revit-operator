using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Assigned native connector inputs, separate from calculated Flow.
    /// Missing getters are unknown, never zero. This is observation, not design verification.</summary>
    public static class NativeConnectorFlowObservation
    {
        /// <summary>Bounded model-visible warning. Not a preservation certificate.</summary>
        public static JsonElement Changes(object before, object? after)
        {
            try
            {
                var b=JsonSerializer.SerializeToElement(before).GetProperty("nativePlacementState");
                var a=JsonSerializer.SerializeToElement(after).GetProperty("nativePlacementState");
                if (!b.GetProperty("complete").GetBoolean() || !a.GetProperty("complete").GetBoolean()) throw new InvalidOperationException();
                var old=b.GetProperty("owners").EnumerateArray().ToArray();
                var now=a.GetProperty("owners").EnumerateArray().ToArray();
                if (old.Length>5000 || now.Length>5000) throw new InvalidOperationException();
                var current=now.ToDictionary(o=>o.GetProperty("uniqueId").GetString()!);
                var changes=new List<object>(); var total=0; var unavailable=0;
                foreach(var owner in old)
                {
                    if (!current.TryGetValue(owner.GetProperty("uniqueId").GetString()!,out var next)) { unavailable++; continue; }
                    var ports=next.GetProperty("calculatedConnectorFlows").EnumerateArray().ToDictionary(c=>c.GetProperty("connectorId").GetInt32());
                    foreach(var port in owner.GetProperty("calculatedConnectorFlows").EnumerateArray())
                    {
                        var id=port.GetProperty("connectorId").GetInt32(); var prior=port.GetProperty("observation");
                        if (!ports.TryGetValue(id,out var cp)) { unavailable++; continue; }
                        var value=cp.GetProperty("observation");
                        if (prior.GetProperty("status").GetString()!="observed" || value.GetProperty("status").GetString()!="observed") { unavailable++; continue; }
                        var x=prior.GetProperty("value").GetDouble(); var y=value.GetProperty("value").GetDouble();
                        if (double.IsNaN(x)||double.IsNaN(y)||double.IsInfinity(x)||double.IsInfinity(y)) { unavailable++; continue; }
                        if (Math.Abs(x-y)<=1e-9*Math.Max(1,Math.Max(Math.Abs(x),Math.Abs(y)))) continue;
                        total++;
                        if (changes.Count<20) changes.Add(new { elementId=owner.GetProperty("elementId").GetInt64(),
                            uniqueId=owner.GetProperty("uniqueId").GetString(),connectorId=id,before=x,after=y });
                    }
                }
                return JsonSerializer.SerializeToElement(new { status="observed",scope="existing_observed_connector_outputs_only",
                    count=total,unavailableCount=unavailable,items=changes,truncated=total>changes.Count,units="cubic_feet_per_second",
                    verification=false,displayVerified=false,
                    guidance="Calculated outputs are not assigned CFM. Independently verify assigned inputs and actual affected tag/schedule text. Report calculated differences; do not overwrite design inputs to conceal them. This summary does not certify preservation, engineering performance or task completion." });
            }
            catch { return JsonSerializer.SerializeToElement(new { status="unavailable",verification=false,displayVerified=false,
                reason="calculated_flow_comparison_incomplete" }); }
        }
        public static JsonElement Read(string domain, Func<double> flow, Func<string> configuration, Func<string> direction)
        {
            if (domain != "DomainHvac" && domain != "DomainPiping")
                return JsonSerializer.SerializeToElement(new { status = "not_applicable", domain, reason = "non_flow_domain" });
            var field = "flow";
            try
            {
                var value = flow();
                if (double.IsNaN(value) || double.IsInfinity(value) || value < 0) throw new InvalidOperationException("Invalid assigned flow.");
                field = "configuration"; var config = configuration();
                if (string.IsNullOrWhiteSpace(config) || config.Length > 128) throw new InvalidOperationException("Missing configuration.");
                field = "direction"; var dir = direction();
                if (dir != "In" && dir != "Out" && dir != "Bidirectional") throw new InvalidOperationException("Unknown direction.");
                return JsonSerializer.SerializeToElement(new { status = "observed", domain, flow = value,
                    units = "cubic_feet_per_second", configuration = config, direction = dir, meaning = "assigned_connector_inputs" });
            }
            catch (Exception ex)
            {
                return JsonSerializer.SerializeToElement(new { status = "unavailable", domain, field,
                    reason = ex.GetType().Name, meaning = "assigned_connector_inputs_not_established" });
            }
        }
    }
}
