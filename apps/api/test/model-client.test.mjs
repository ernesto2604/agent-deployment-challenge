import assert from "node:assert/strict";
import test from "node:test";

import { requestCompletion } from "../src/model-client.mjs";

test("sends a compatible request and returns the assistant content", async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://model.example/v1/chat/completions");
    assert.equal(options.headers.authorization, "Bearer test-key");

    const body = JSON.parse(options.body);
    assert.equal(body.model, "test-model");
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[1].content, "Hello");

    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Hello back" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const content = await requestCompletion({
    fetchImpl,
    model: {
      apiKey: "test-key",
      baseUrl: "https://model.example/v1",
      name: "test-model",
      systemPrompt: "Be useful",
      timeoutMs: 1_000,
    },
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.equal(content, "Hello back");
});
