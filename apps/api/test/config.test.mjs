import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";

test("uses safe defaults without marking the model as configured", () => {
  const config = loadConfig({});

  assert.equal(config.port, 4319);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.modelConfigured, false);
});

test("loads a configured model", () => {
  const config = loadConfig({
    PORT: "9000",
    MODEL_API_BASE_URL: "https://model.example/v1/",
    MODEL_NAME: "candidate-model",
    MODEL_API_KEY: "test-only-key",
  });

  assert.equal(config.port, 9000);
  assert.equal(config.model.baseUrl, "https://model.example/v1");
  assert.equal(config.model.name, "candidate-model");
  assert.equal(config.modelConfigured, true);
});

test("rejects invalid numeric and URL values", () => {
  assert.throws(() => loadConfig({ PORT: "zero" }), /PORT/);
  assert.throws(
    () => loadConfig({ MODEL_API_BASE_URL: "not a url" }),
    /MODEL_API_BASE_URL/,
  );
});
