import test from "node:test";
import assert from "node:assert/strict";
import { archivedCensusEvidence } from "../server/evidence.js";
test("Census fallback is sourced2020ZCTA94110 and its population identity balances", () => {
  const e = archivedCensusEvidence();
  assert.equal(e.mode, "cached-live");
  assert.equal(e.observedAt, "2020-04-01");
  assert.match(e.url!, /^https:\/\/www2\.census\.gov\//);
  assert.equal(e.values!.population, 68336);
  assert.equal(e.values!.hispanicOrLatino, 22160);
  assert.equal(
    Number(e.values!.population),
    Number(e.values!.hispanicOrLatino) + Number(e.values!.notHispanicOrLatino),
  );
  assert.equal(e.values!.zcta, "94110");
});
