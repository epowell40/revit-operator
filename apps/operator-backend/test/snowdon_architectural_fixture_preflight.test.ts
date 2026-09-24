import assert from "node:assert/strict";
import test from "node:test";
import { verifySnowdonArchitecturalFixtureBeforeAgent } from "../src/benchmark/snowdon_architectural_fixture_preflight.js";

function modelHealth(loaded: boolean, title = "Snowdon Towers Sample HVAC") {
  return {
    status: "Ok",
    document: { title, path: `C:\\fixtures\\${title}.rvt` },
    links: { revit: { items: [{
      typeId: 31,
      name: "Snowdon Towers Sample Architectural.rvt",
      instanceCount: 1,
      loaded,
      path: loaded ? "C:\\fixtures\\Snowdon Towers Sample Architectural.rvt" : null
    }] } }
  };
}

test("linked HVAC fixture refuses to start an agent when the Architectural link is unloaded", async () => {
  const receipts: unknown[] = [];
  let agentStarted = false;
  await assert.rejects(async () => {
    await verifySnowdonArchitecturalFixtureBeforeAgent({
      enabled: true,
      fixture: "snowdon_hvac",
      readModelHealth: async () => modelHealth(false),
      retainReceipt: (receipt) => receipts.push(receipt)
    });
    agentStarted = true;
  }, /background_link_unloaded/);
  assert.equal(agentStarted, false);
  assert.equal(receipts.length, 1);
  assert.equal((receipts[0] as { passed: boolean }).passed, false);
});

test("linked HVAC fixture is checked again after reopening before the next agent case", async () => {
  const observations = [modelHealth(true), modelHealth(false)];
  const receipts: unknown[] = [];
  let agentStarts = 0;
  const startCase = async () => {
    await verifySnowdonArchitecturalFixtureBeforeAgent({
      enabled: true,
      fixture: "snowdon_hvac",
      readModelHealth: async () => observations.shift(),
      retainReceipt: (receipt) => receipts.push(receipt)
    });
    agentStarts++;
  };
  await startCase();
  await assert.rejects(startCase(), /background_link_unloaded/);
  assert.equal(agentStarts, 1);
  assert.equal(receipts.length, 2);
});

test("derived HVAC fixture also refuses an unloaded Architectural link", async () => {
  const receipts: unknown[] = [];
  await assert.rejects(verifySnowdonArchitecturalFixtureBeforeAgent({
    enabled: true,
    fixture: "snowdon_hvac_loose",
    expectedDocumentTitle: "Snowdon Towers Sample HVAC Loose",
    requiresArchitecturalLink: true,
    readModelHealth: async () => modelHealth(false, "Snowdon Towers Sample HVAC Loose"),
    retainReceipt: (receipt) => receipts.push(receipt)
  }), /background_link_unloaded/);
  assert.equal(receipts.length, 1);
  const loaded = await verifySnowdonArchitecturalFixtureBeforeAgent({
    enabled: true,
    fixture: "snowdon_hvac_loose",
    expectedDocumentTitle: "Snowdon Towers Sample HVAC Loose",
    requiresArchitecturalLink: true,
    readModelHealth: async () => modelHealth(true, "Snowdon Towers Sample HVAC Loose"),
    retainReceipt: () => {}
  });
  assert.equal(loaded?.passed, true);
  await assert.rejects(verifySnowdonArchitecturalFixtureBeforeAgent({
    enabled: true,
    fixture: "snowdon_hvac_loose",
    expectedDocumentTitle: "Snowdon Towers Sample HVAC Loose",
    requiresArchitecturalLink: true,
    readModelHealth: async () => modelHealth(true),
    retainReceipt: () => {}
  }), /wrong active model/);
});

test("opt-in check leaves other fixtures alone and rejects a wrong active model", async () => {
  let nativeReads = 0;
  const other = await verifySnowdonArchitecturalFixtureBeforeAgent({
    enabled: true,
    fixture: "snowdon_electrical",
    readModelHealth: async () => { nativeReads++; return modelHealth(false); },
    retainReceipt: () => assert.fail("other fixture must not create a receipt")
  });
  assert.equal(other, null);
  assert.equal(nativeReads, 0);
  await assert.rejects(verifySnowdonArchitecturalFixtureBeforeAgent({
    enabled: true,
    fixture: "snowdon_hvac",
    readModelHealth: async () => modelHealth(true, "Snowdon Towers Sample Plumbing"),
    retainReceipt: () => {}
  }), /wrong active model/);
});
