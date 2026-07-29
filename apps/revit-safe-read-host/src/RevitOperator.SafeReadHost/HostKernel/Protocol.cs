using System;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal static class Protocol
    {
        public static string NewSecret() { byte[] value=new byte[32]; using(RandomNumberGenerator rng=RandomNumberGenerator.Create())rng.GetBytes(value); try{return Base64Url(value);}finally{Array.Clear(value,0,value.Length);} }
        public static byte[] NewNonce() { byte[] value=new byte[32]; using(RandomNumberGenerator rng=RandomNumberGenerator.Create())rng.GetBytes(value); return value; }
        public static string Base64Url(byte[] value)=>Convert.ToBase64String(value).TrimEnd('=').Replace('+','-').Replace('/','_');
        public static string Sha256(byte[] value) { using(SHA256 sha=SHA256.Create())return "sha256:"+Hex(sha.ComputeHash(value)); }
        public static string Sha256(string value)=>Sha256(new UTF8Encoding(false).GetBytes(value));
        public static string Hex(byte[] value){StringBuilder b=new StringBuilder(value.Length*2);foreach(byte item in value)b.Append(item.ToString("x2",CultureInfo.InvariantCulture));return b.ToString();}
        public static bool IsCanonicalGuid(string? value){Guid parsed;return value!=null&&value.Length==36&&Guid.TryParseExact(value,"D",out parsed)&&String.Equals(parsed.ToString("D"),value,StringComparison.Ordinal);}
        public static bool IsHash(string? value){if(value==null||value.Length!=71||!value.StartsWith("sha256:",StringComparison.Ordinal))return false;for(int i=7;i<value.Length;i++)if(!((value[i]>='0'&&value[i]<='9')||(value[i]>='a'&&value[i]<='f')))return false;return true;}
        public static bool IsSecret(string? value){if(value==null||value.Length!=43)return false;for(int i=0;i<value.Length;i++){char c=value[i];if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'||c=='-'))return false;}return true;}
        public static bool SecretEquals(string expected,string? actual){if(actual==null||expected.Length!=actual.Length)return false;int d=0;for(int i=0;i<expected.Length;i++)d|=expected[i]^actual[i];return d==0;}
        public static bool IsSafeToken(string? value,int max=127){if(String.IsNullOrEmpty(value)||value!.Length>max)return false;for(int i=0;i<value.Length;i++){char c=value[i];if(!((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='.'||c=='_'||c==':'||c=='-'))return false;}return true;}
        public static string Quote(string value){StringBuilder b=new StringBuilder(value.Length+2);b.Append('"');foreach(char c in value){switch(c){case '"':b.Append("\\\"");break;case '\\':b.Append("\\\\");break;case '\b':b.Append("\\b");break;case '\f':b.Append("\\f");break;case '\n':b.Append("\\n");break;case '\r':b.Append("\\r");break;case '\t':b.Append("\\t");break;default:if(c<32)b.Append("\\u"+((int)c).ToString("x4"));else b.Append(c);break;}}b.Append('"');return b.ToString();}
    }

    internal sealed class InstanceIdentity
    {
        private InstanceIdentity(string id,string token){HostInstanceId=id;StartupToken=token;}
        public string HostInstanceId{get;} public string StartupToken{get;}
        public static InstanceIdentity Create()=>new InstanceIdentity(Guid.NewGuid().ToString("D"),Protocol.NewSecret());
        public bool TokenMatches(string? value)=>Protocol.SecretEquals(StartupToken,value);
    }

    internal static class PortPolicy
    {
        public static bool IsAllowed(int port)=>port>=SafeReadContract.MinimumPort&&port<=SafeReadContract.MaximumPort;
        public static bool TryReadOverride(string? raw,out bool has,int portDefault,out int port){has=false;port=portDefault;if(String.IsNullOrEmpty(raw))return true;int parsed;if(!Int32.TryParse(raw,NumberStyles.None,CultureInfo.InvariantCulture,out parsed)||!IsAllowed(parsed))return false;has=true;port=parsed;return true;}
    }
}
