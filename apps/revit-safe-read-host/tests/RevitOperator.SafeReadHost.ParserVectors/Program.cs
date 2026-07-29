using System;
using System.Text;
using RevitOperator.SafeReadHost.HostKernel;

internal static class Program
{
    private static int Main()
    {
        Valid("{}");Valid("{\"ok\":true,\"nested\":{\"value\":\"\\uD83D\\uDE00\"}}");
        foreach(string invalid in new[]{""," {}","{} ","[]","null","{\"a\":1}","{\"a\":\"1\",\"a\":\"2\"}","{\"a\":\"\\x\"}","{\"a\":\"\\uD800\"}","{\"\\u0061\":true}"})Invalid(invalid);
        try{StrictJson.Parse(new byte[]{0xff},16,4);return 2;}catch(FormatException){}
        StrictJsonValue ordered=StrictJson.Parse("{\"a\":true,\"b\":false}",64,2);if(!ordered.HasExactProperties("a","b")||ordered.HasExactProperties("b","a"))return 3;
        Console.WriteLine("STRICT_JSON_CROSS_TARGET_OK");return 0;
    }
    private static void Valid(string json){StrictJson.Parse(Encoding.UTF8.GetBytes(json),4096,8);}
    private static void Invalid(string json){try{StrictJson.Parse(json,4096,8);throw new InvalidOperationException("Expected rejection: "+json);}catch(FormatException){}}
}
