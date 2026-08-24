import assert from "node:assert/strict";
import test from "node:test";

import { countryToContinent, geographicCountryLabel } from "./geography";

test("groups provider country labels into continents", () => {
  assert.equal(countryToContinent("United States"), "North America");
  assert.equal(countryToContinent("Brazil"), "South America");
  assert.equal(countryToContinent("Korea (South)"), "Asia");
  assert.equal(countryToContinent("Russian Federation"), "Europe");
  assert.equal(countryToContinent("South Africa"), "Africa");
  assert.equal(countryToContinent("New Zealand"), "Oceania");
  assert.equal(countryToContinent("Côte d’Ivoire"), "Africa");
});

test("keeps missing and unknown geography explicit", () => {
  assert.equal(geographicCountryLabel("Not reported"), "Unclassified");
  assert.equal(geographicCountryLabel("  France  "), "France");
  assert.equal(countryToContinent("Not applicable"), "Unclassified");
  assert.equal(countryToContinent("Atlantis"), "Unclassified");
});
