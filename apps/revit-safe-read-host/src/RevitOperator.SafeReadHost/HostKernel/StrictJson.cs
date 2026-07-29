using System;
using System.Collections.Generic;
using System.Text;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal enum StrictJsonKind { Object, String, Boolean }

    internal sealed class StrictJsonProperty
    {
        public StrictJsonProperty(string name,StrictJsonValue value){Name=name;Value=value;}
        public string Name{get;} public StrictJsonValue Value{get;}
    }

    internal sealed class StrictJsonValue
    {
        private readonly List<StrictJsonProperty>? _properties;private readonly string? _text;private readonly bool _boolean;
        private StrictJsonValue(List<StrictJsonProperty> properties){Kind=StrictJsonKind.Object;_properties=properties;}
        private StrictJsonValue(string text){Kind=StrictJsonKind.String;_text=text;}
        private StrictJsonValue(bool value){Kind=StrictJsonKind.Boolean;_boolean=value;}
        public StrictJsonKind Kind{get;}
        public static StrictJsonValue Object(List<StrictJsonProperty> properties)=>new StrictJsonValue(properties);
        public static StrictJsonValue String(string text)=>new StrictJsonValue(text);
        public static StrictJsonValue Boolean(bool value)=>new StrictJsonValue(value);
        public bool HasExactProperties(params string[] names){if(Kind!=StrictJsonKind.Object||_properties==null||_properties.Count!=names.Length)return false;for(int i=0;i<names.Length;i++)if(!System.String.Equals(_properties[i].Name,names[i],StringComparison.Ordinal))return false;return true;}
        public bool TryGetObject(string name,out StrictJsonValue value){return TryGet(name,StrictJsonKind.Object,out value);}
        public bool TryGetString(string name,out string value){value=System.String.Empty;StrictJsonValue item;if(!TryGet(name,StrictJsonKind.String,out item)||item._text==null)return false;value=item._text;return true;}
        public bool TryGetBoolean(string name,out bool value){value=false;StrictJsonValue item;if(!TryGet(name,StrictJsonKind.Boolean,out item))return false;value=item._boolean;return true;}
        public string RequiredString(string name){string value;if(!TryGetString(name,out value))throw new InvalidOperationException("Strict JSON string property is unavailable.");return value;}
        private bool TryGet(string name,StrictJsonKind kind,out StrictJsonValue value){value=null!;if(Kind!=StrictJsonKind.Object||_properties==null)return false;for(int i=0;i<_properties.Count;i++){StrictJsonProperty property=_properties[i];if(System.String.Equals(property.Name,name,StringComparison.Ordinal)){if(property.Value.Kind!=kind)return false;value=property.Value;return true;}}return false;}
    }

    internal static class StrictJson
    {
        public static StrictJsonValue Parse(byte[] utf8,int maximumBytes,int maximumDepth)
        {
            if(utf8==null||utf8.Length==0||utf8.Length>maximumBytes)throw new FormatException("Strict JSON byte bound failed.");
            string text;try{text=new UTF8Encoding(false,true).GetString(utf8);}catch(DecoderFallbackException error){throw new FormatException("Strict JSON UTF-8 is invalid.",error);}
            return Parse(text,maximumBytes,maximumDepth);
        }
        public static StrictJsonValue Parse(string text,int maximumCharacters,int maximumDepth)
        {
            if(String.IsNullOrEmpty(text)||text.Length>maximumCharacters||maximumDepth<1||maximumDepth>16)throw new FormatException("Strict JSON bounds failed.");
            Parser parser=new Parser(text,maximumDepth);StrictJsonValue value=parser.ReadValue(1);if(value.Kind!=StrictJsonKind.Object||!parser.AtEnd)throw new FormatException("Strict JSON requires one object with no trailing content.");return value;
        }

        private sealed class Parser
        {
            private const int MaximumProperties=64,MaximumKeyCharacters=128,MaximumStringCharacters=4096;
            private readonly string _text;private readonly int _maximumDepth;private int _offset;
            public Parser(string text,int maximumDepth){_text=text;_maximumDepth=maximumDepth;}
            public bool AtEnd=>_offset==_text.Length;
            public StrictJsonValue ReadValue(int depth)
            {
                if(depth>_maximumDepth||_offset>=_text.Length)throw new FormatException("Strict JSON depth or value is invalid.");
                char current=_text[_offset];if(current=='{')return ReadObject(depth);if(current=='"')return StrictJsonValue.String(ReadString(false));if(Match("true"))return StrictJsonValue.Boolean(true);if(Match("false"))return StrictJsonValue.Boolean(false);throw new FormatException("Strict JSON value type is unsupported.");
            }
            private StrictJsonValue ReadObject(int depth)
            {
                Require('{');List<StrictJsonProperty> properties=new List<StrictJsonProperty>();HashSet<string> names=new HashSet<string>(StringComparer.Ordinal);if(Peek('}')){_offset++;return StrictJsonValue.Object(properties);}
                while(true)
                {
                    if(properties.Count>=MaximumProperties)throw new FormatException("Strict JSON property bound exceeded.");
                    string name=ReadString(true);if(name.Length==0||name.Length>MaximumKeyCharacters||!names.Add(name))throw new FormatException("Strict JSON property name is invalid or duplicated.");Require(':');StrictJsonValue value=ReadValue(depth+1);properties.Add(new StrictJsonProperty(name,value));
                    if(Peek('}')){_offset++;break;}Require(',');
                }
                return StrictJsonValue.Object(properties);
            }
            private string ReadString(bool propertyName)
            {
                Require('"');StringBuilder output=new StringBuilder();
                while(_offset<_text.Length)
                {
                    char current=_text[_offset++];if(current=='"')return output.ToString();if(current<0x20)throw new FormatException("Strict JSON contains an unescaped control character.");
                    if(current=='\\')
                    {
                        if(propertyName||_offset>=_text.Length)throw new FormatException("Strict JSON property names must be canonical.");char escaped=_text[_offset++];
                        switch(escaped){case '"':output.Append('"');break;case '\\':output.Append('\\');break;case '/':output.Append('/');break;case 'b':output.Append('\b');break;case 'f':output.Append('\f');break;case 'n':output.Append('\n');break;case 'r':output.Append('\r');break;case 't':output.Append('\t');break;case 'u':AppendEscapedUnicode(output);break;default:throw new FormatException("Strict JSON escape is invalid.");}
                    }
                    else
                    {
                        if(Char.IsHighSurrogate(current)){if(_offset>=_text.Length||!Char.IsLowSurrogate(_text[_offset]))throw new FormatException("Strict JSON Unicode surrogate is invalid.");output.Append(current);output.Append(_text[_offset++]);}
                        else if(Char.IsLowSurrogate(current))throw new FormatException("Strict JSON Unicode surrogate is invalid.");else output.Append(current);
                    }
                    if(output.Length>MaximumStringCharacters)throw new FormatException("Strict JSON string bound exceeded.");
                }
                throw new FormatException("Strict JSON string is unterminated.");
            }
            private void AppendEscapedUnicode(StringBuilder output)
            {
                char first=(char)ReadHex4();if(Char.IsHighSurrogate(first)){if(_offset+6>_text.Length||_text[_offset]!='\\'||_text[_offset+1]!='u')throw new FormatException("Strict JSON Unicode surrogate pair is incomplete.");_offset+=2;char second=(char)ReadHex4();if(!Char.IsLowSurrogate(second))throw new FormatException("Strict JSON Unicode surrogate pair is invalid.");output.Append(first);output.Append(second);return;}if(Char.IsLowSurrogate(first))throw new FormatException("Strict JSON Unicode surrogate is invalid.");output.Append(first);
            }
            private int ReadHex4(){if(_offset+4>_text.Length)throw new FormatException("Strict JSON Unicode escape is incomplete.");int value=0;for(int i=0;i<4;i++){char c=_text[_offset++];int nibble=c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:c>='A'&&c<='F'?c-'A'+10:-1;if(nibble<0)throw new FormatException("Strict JSON Unicode escape is invalid.");value=(value<<4)|nibble;}return value;}
            private bool Match(string value){if(_offset+value.Length>_text.Length)return false;for(int i=0;i<value.Length;i++)if(_text[_offset+i]!=value[i])return false;_offset+=value.Length;return true;}
            private bool Peek(char value)=>_offset<_text.Length&&_text[_offset]==value;
            private void Require(char value){if(!Peek(value))throw new FormatException("Strict JSON punctuation is invalid.");_offset++;}
        }
    }
}
