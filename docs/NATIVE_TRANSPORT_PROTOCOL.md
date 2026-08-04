# Native Revit transport v1

Certified Revit bridge calls treat loopback HTTP as an untrusted carrier. A
more-specific HTTP.sys prefix or a listener replacement can observe only a
fixed route and an authenticated ciphertext; it cannot read an Operator token,
correlation identifier, write grant, target tool path, action body, response
status, or response body, and it cannot manufacture an accepted response.
This boundary assumes the Operator token remains private to the trusted Revit
and Sidecar processes. It does not defend against an arbitrary same-user
process that can read the token from disk or inspect trusted process memory.

The legacy raw-header/plaintext contract exists only when both runtime values
match exactly:

```text
REVIT_OPERATOR_MODE=development
OPERATOR_TOOL_EXPOSURE_PROFILE=laboratory
```

Every other mode fails closed unless this protocol is used.

## Compatibility and deployment boundary

The current v1 request schema includes the mandatory authenticated channel
and alias fields documented below. An earlier pre-release v1 implementation
did not carry those fields and is intentionally not wire-compatible. The exact
request parser rejects that older shape before native admission; it is not
silently interpreted as a generic call.

The Sidecar/MCP client and Revit add-in are therefore one atomic workstation
release unit for this revision. OperatorDeploy must install both from the same
release package, and Revit must be restarted to activate the new add-in before
the new Sidecar is started. A mixed old/new rollout fails closed at protected
request parsing. Deployments must not update either endpoint independently.

## Discovery and outer HTTP contract

On every successful native listener start Revit generates a fresh random
32-byte epoch and writes `%LOCALAPPDATA%\RevitOperator\bridge_transport.v1.json`:

```json
{
  "version": "revit-operator.native-transport.v1",
  "algorithm": "A256CBC-HS512",
  "transport_path": "/revit/operator-transport/v1",
  "url": "http://127.0.0.1:5000",
  "server_epoch": "<32 bytes, unpadded base64url>"
}
```

Certified clients must read this receipt, require every field, and use only:

```text
POST {url}/revit/operator-transport/v1
Content-Type: application/vnd.revit-operator.native-transport+json
```

They must not send `X-Operator-Token`, `X-Operator-Correlation-Id`, or
`X-Operator-Write-Grant`. The server rejects those headers in certified modes.
`bridge_url.txt` remains a legacy/display receipt and is not sufficient for a
certified call.

The outer response status is `200` for every authenticated request whose
response could be protected. The real status is inside the response envelope;
clients must not accept or interpret an outer status or plaintext body as a
native result.

## Key derivation

The Operator token is trimmed by the existing token store and encoded as strict
UTF-8. V1 requires 32 through 4096 token bytes. Decode `server_epoch` as exactly
32 bytes.

For each direction independently:

```text
PRK  = HMAC-SHA-512(key=server_epoch, data=UTF8(operator_token))
INFO = UTF8("revit-operator.native-transport.v1\0" + direction + "\0A256CBC-HS512")
OKM  = HMAC-SHA-512(key=PRK, data=INFO || 0x01)
Kmac = OKM[0..31]
Kenc = OKM[32..63]
```

`direction` is the exact lowercase ASCII string `request` or `response`.
Separate derivation prevents request-to-response reflection.

## Inner plaintexts

The request plaintext is strict UTF-8 JSON with exactly these fields and this
serialization order:

```json
{
  "request_id": "<32 or 64 lowercase hexadecimal characters>",
  "request_nonce": "<32 random bytes, unpadded base64url>",
  "issued_at_unix_ms": 1785345600123,
  "method": "POST",
  "path": "/revit/set-parameter",
  "body_present": true,
  "body_json": "{\"elementId\":42}",
  "channel": "generic_call",
  "alias": "revit_call_tool",
  "write_grant": "<possibly empty>"
}
```

The method, path, and body must pass `OperatorNativeHttpRequestFence`. GET has
no body; POST has a present strict JSON body of at most 2 MiB. The target path,
request ID/correlation, body, and write grant therefore exist only inside the
ciphertext. Write grants are limited to 16 KiB and the final request envelope
to 8 MiB.

channel is exactly search, generic_call, or typed_mcp. alias is a lowercase
tool alias and must agree with that channel. In particular, generic_call
requires revit_call_tool, while non-generic channels may not claim that alias.
Both fields are authenticated and are required by the exact Revit-side parser.

The response plaintext has exactly:

```json
{
  "request_id": "<exact request_id>",
  "request_nonce": "<exact request_nonce>",
  "issued_at_unix_ms": 1785345600456,
  "status_code": 403,
  "body_json": "{\"ok\":false}"
}
```

Clients must verify both request bindings before using the inner status or
body. Response bodies are limited to 16 MiB.

## Encryption and authentication

Generate a fresh random 16-byte IV for every message. Encrypt the inner bytes
with AES-256-CBC and PKCS#7 padding using `Kenc`.

The protected JSON envelope has exactly:

```json
{
  "v": "revit-operator.native-transport.v1",
  "alg": "A256CBC-HS512",
  "epoch": "<server_epoch>",
  "dir": "request",
  "iv": "<unpadded base64url>",
  "ciphertext": "<unpadded base64url>",
  "tag": "<unpadded base64url>"
}
```

Construct AAD as strict UTF-8 without a trailing newline:

```text
revit-operator.native-transport.v1\n
A256CBC-HS512\n
{server_epoch}\n
{direction}\n
POST\n
/revit/operator-transport/v1
```

Construct the MAC input as:

```text
AAD || IV || CIPHERTEXT || uint64be(bit_length(AAD))
```

`tag` is the first 32 bytes of `HMAC-SHA-512(Kmac, MAC_INPUT)`. Verify it in
constant time before attempting AES decryption. Base64url is RFC 4648 URL-safe,
unpadded, and canonical; padded or alternate encodings are rejected.

Envelope limits are 8 MiB for requests and 48 MiB for responses. These bounds
include worst-case JSON escaping around the 2 MiB and 16 MiB inner body limits.

## Freshness and replay

Request and response timestamps accept at most 30 seconds of age and 10 seconds
of future clock skew. Revit atomically reserves each authenticated
`request_id:request_nonce` before admission. Its cache holds at most 4096 live
entries and fails closed when full. A new server epoch is generated on every
listener start, so a captured request cannot cross a Revit restart.

Clients must generate a new request ID, request nonce, and IV for every call.
They must never automatically retry a mutating request after dispatch when its
authenticated response is unavailable.

## Canonical vector

The executable cross-runtime request and response vectors are in
`RevitBridge.Common.Tests/OperatorNativeTransportTests.cs`. The fixed inputs are:

```text
token       0123456789abcdef0123456789abcdef
epoch       bytes 00..1f
request id  fedcba9876543210fedcba9876543210
request nonce bytes 20..3f
request IV  bytes 40..4f
request time 1785345600123
method/path POST /revit/set-parameter
body        {"elementId":42,"value":"AHU-1"}
channel     generic_call
alias       revit_call_tool
write grant grant-v1-test
response IV bytes 60..6f
response time 1785345600456
response status 403
response body {"ok":false,"error":"approval required"}
```

Any implementation that does not reproduce those complete envelope strings is
not wire-compatible.
