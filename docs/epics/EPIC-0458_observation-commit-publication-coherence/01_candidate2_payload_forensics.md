# EPIC-0458 Candidate 2 payload forensics

## Conclusion

Candidate 2 failed because the MCP and backend independently canonicalized the
same semantic payload with different key-order algorithms.

- MCP used JavaScript `localeCompare`.
- Backend Assignment Kernel V2 used ordinal UTF-16 code-unit comparison.

The authoritative operation result recorded the MCP digest
`6e1eda885bb15cff38a47bf00dde8fbabc4a436813ec180e3c7d5ee7ed8d645a`.
Observation validation recomputed
`e628fb74ec6f7d479aafc4135c5a60852f5d65e57b5c9e88c15a39add9c426c4`
from the identical payload object and rejected it.

No payload mutation or evidence-store write failure occurred.

## Exact retained artifacts

The immutable private accounting record retains:

- courier job: 1,917 bytes,
  `9dc87671c1b404c364428b61c3ead623977326462e812747860eeed0f7131f07`
- courier result envelope: 804,528 bytes,
  `7a6c09121a3c716067a9879ab568c773b1ccc9168230d78256a2b655d5d9afb8`
- evidence object: 400,625 bytes,
  `b571064add16c872c57ed189ac76ee0052aefd2637a0d7ef800d321e1f8ed293`
- evidence reference: 3,516 bytes,
  `c32ae8b695343b3218677de522fea898ecfc501e16ebd05e1cc9ead95f97e3b5`

The result contains 217 tool records. The evidence object is byte-for-byte
equal to `JSON.stringify(result.result)` after JSON transport parsing. Evidence
persistence therefore completed before Observation validation failed.

## Representation comparison

| Stage | Representation | Bytes | SHA-256 |
|---|---|---:|---|
| native/C# payload JSON | `source_json_utf8/system-text-json-v1` | 402,629 | `4e6242decd234a1203e02b1ba4bc7edc34fe7ef1d1d1012a2311d35e5e85a21e` |
| parsed Node transport | `utf8_json_bytes/json-stringify-v8` | 400,625 | `b571064add16c872c57ed189ac76ee0052aefd2637a0d7ef800d321e1f8ed293` |
| MCP normalized identity | `canonical_json/locale-compare-unversioned` | 400,625 | `6e1eda885bb15cff38a47bf00dde8fbabc4a436813ec180e3c7d5ee7ed8d645a` |
| backend normalized identity | `canonical_json/assignment-kernel-v2-ordinal` | 400,625 | `e628fb74ec6f7d479aafc4135c5a60852f5d65e57b5c9e88c15a39add9c426c4` |
| evidence object | `evidence_object_bytes/json-stringify-v8` | 400,625 | `b571064add16c872c57ed189ac76ee0052aefd2637a0d7ef800d321e1f8ed293` |

The native/C# and Node transport byte digests are legitimately different
source representations. System.Text.Json escapes characters differently from
V8 `JSON.stringify`; JSON parsing preserves the same values. Neither source
digest may be compared directly with a normalized semantic digest.

## Exact ordering difference

Eight nested `request_schema.properties` objects sort differently. The first
contains `parameter`, `parameterName`, and `paramName`:

- locale order: `parameter`, `parameterName`, `paramName`
- ordinal order: `paramName`, `parameter`, `parameterName`

Other affected key groups include connection/open fields, printer fields,
link/linked fields, column fields, viewport/view-query fields, and
place-on-sheet/placement fields.

The minimal fixture is:

```json
{"parameter":1,"parameterName":2,"paramName":3}
```

It hashes as:

- locale canonical:
  `e2d742746dfc5aee417ab32585d2cceee3f3474703fb0028c85659d350b018d8`
- ordinal canonical:
  `653ec46c5439542a3e3894d035258de882dd5bfcef1acff9611ebf126138d8a0`

## Ruled-out transformations

- No values were omitted or transformed between the MCP payload and evidence
  object.
- No `undefined` value survived JSON transport.
- Numeric values and Unicode semantic values were unchanged.
- The Observation envelope contained the same payload object that MCP hashed.
- `canonical_attempt_settlement` was included in both normalized digests.
- No envelope extraction, nested prose recovery, result alias, or evidence
  projection reconstructed the payload.

The only normalized-identity mismatch was locale-dependent key ordering.

## Failing-before regression

The sanitized Candidate 2 fixture retains one real affected registry tool and
the settlement-control shape while replacing identities and timestamps. Before
the repair, its focused MCP regression failed with:

```text
actual:   4ba777e03f2039be75ddd741e7f48a043a2a2d6b2fd331480e46557ffd95411b
expected: 209757281c926ff24d53050a086f357774af069249d8ec28be9975dc28a53890
```

This failure was recorded before any production hashing implementation was
changed.
