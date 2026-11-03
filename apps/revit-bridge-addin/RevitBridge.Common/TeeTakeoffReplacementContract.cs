using System;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public static class TeeTakeoffReplacementContract
    {
        public static bool TryValidate(JsonElement body,out string error)
        {
            error=string.Empty;
            if(body.ValueKind!=JsonValueKind.Object){error="MEP connection body must be an object.";return false;}
            bool Present(string n)=>body.TryGetProperty(n,out var v)&&v.ValueKind!=JsonValueKind.Null;
            string Text(string n)=>body.TryGetProperty(n,out var v)&&v.ValueKind==JsonValueKind.String?(v.GetString()??"").Trim():"";
            var mode=Text("connectionMode");
            if(!mode.Equals("replace_tee_with_takeoff",StringComparison.OrdinalIgnoreCase))
            {
                if(Present("teeElementId")||Present("secondMainElementId")){error="teeElementId and secondMainElementId require connectionMode replace_tee_with_takeoff.";return false;}
                return true;
            }
            var names=new[]{"teeElementId","mainElementId","secondMainElementId","branchElementId"};
            var ids=new long[4];
            for(var i=0;i<names.Length;i++)
                if(!body.TryGetProperty(names[i],out var v)||v.ValueKind!=JsonValueKind.Number||!v.TryGetInt64(out ids[i])||ids[i]<=0)
                {error="replace_tee_with_takeoff requires four distinct positive tee/main/secondMain/branch element IDs.";return false;}
            if(ids.Distinct().Count()!=4||!Text("kind").Equals("duct",StringComparison.OrdinalIgnoreCase)||
                !body.TryGetProperty("expectedTakeoffTypeId",out var type)||type.ValueKind!=JsonValueKind.Number||!type.TryGetInt64(out var typeId)||typeId<=0)
            {error="replace_tee_with_takeoff requires four distinct element IDs, kind duct and a loaded expectedTakeoffTypeId.";return false;}
            if(Present("verify")&&body.GetProperty("verify").ValueKind!=JsonValueKind.True||Present("worksetId")||Text("worksetName").Length>0)
            {error="Replacement verification cannot be disabled; workset is inherited from the retained main.";return false;}
            if(Present("originToleranceFt"))
            {
                var t=body.GetProperty("originToleranceFt");
                if(t.ValueKind!=JsonValueKind.Number||!t.TryGetDouble(out var value)||double.IsNaN(value)||double.IsInfinity(value)||value<=0||value>0.01)
                {error="Replacement originToleranceFt must be positive and at most 0.01 ft.";return false;}
            }
            return true;
        }
    }
}
