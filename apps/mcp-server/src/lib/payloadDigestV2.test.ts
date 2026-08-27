import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  PAYLOAD_CANONICALIZATION_VERSION_V2,
  canonicalPayloadBytesV2,
  canonicalPayloadJsonV2,
  payloadDigestV2
} from "@revitoperator/payload-digest-v2";

function sharedPackageFile(name: string): string {
  const candidates = [
    path.resolve(process.cwd(), "..", "..", "packages", "payload-digest-v2", name),
    path.resolve(process.cwd(), "..", "public", "packages", "payload-digest-v2", name)
  ];
  const selected = candidates.find(candidate => existsSync(candidate));
  assert.ok(selected, `Missing shared payload digest package file ${name}`);
  return selected;
}

test("MCP process matches every shared payload digest golden vector", () => {
  const golden = JSON.parse(readFileSync(sharedPackageFile("golden-vectors.json"), "utf8"));
  assert.equal(golden.canonicalization_version, PAYLOAD_CANONICALIZATION_VERSION_V2);
  for (const vector of golden.vectors) {
    const digest = payloadDigestV2(vector.value);
    assert.equal(canonicalPayloadJsonV2(vector.value), vector.canonical_json, vector.id);
    assert.equal(Buffer.from(canonicalPayloadBytesV2(vector.value)).toString("utf8"), vector.canonical_json, vector.id);
    assert.equal(digest.digest, vector.digest, vector.id);
    assert.equal(digest.byte_count, vector.byte_count, vector.id);
    assert.deepEqual(payloadDigestV2(JSON.parse(JSON.stringify(vector.value))), digest, `${vector.id}:json-round-trip`);
  }
});
