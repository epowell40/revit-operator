import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExistingConditionsDeleteRequest,
  verifyExistingConditionsDeletedElementReadback
} from "../src/existing_conditions/redaction_delete_request.js";

test("existing-conditions redaction emits the exact bulk confirmation only for apply", () => {
  assert.deepEqual(buildExistingConditionsDeleteRequest([3, 2, 3, 1], false), {
    ids: [3, 2, 1],
    apply: false
  });
  assert.deepEqual(buildExistingConditionsDeleteRequest([3, 2, 3, 1], true), {
    ids: [3, 2, 1],
    apply: true,
    confirm: "DELETE 3 ELEMENTS"
  });
});

test("existing-conditions redaction rejects an empty normalized delete scope", () => {
  assert.throws(
    () => buildExistingConditionsDeleteRequest([0, -1, Number.NaN], true),
    /existing_conditions_redaction_delete_ids_required/
  );
});

test("existing-conditions redaction requires exact absent-element readback", () => {
  assert.deepEqual(
    verifyExistingConditionsDeletedElementReadback([
      { id: 9, found: false, error: "Element not found" },
      { id: 7, found: false, error: "Element not found" }
    ], [7, 9]),
    [7, 9]
  );
  assert.throws(
    () => verifyExistingConditionsDeletedElementReadback([{ id: 7, found: false }], [7, 9]),
    /readback_ids_do_not_match_requested_scope/
  );
  assert.throws(
    () => verifyExistingConditionsDeletedElementReadback([{ id: 7, found: false }, { id: 7, found: false }], [7]),
    /readback_ids_invalid_or_duplicate/
  );
  assert.throws(
    () => verifyExistingConditionsDeletedElementReadback([{ id: 7, found: true }], [7]),
    /requested_ids_still_found:7/
  );
});
