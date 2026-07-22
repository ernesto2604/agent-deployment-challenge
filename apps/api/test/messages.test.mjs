import assert from "node:assert/strict";
import test from "node:test";

import { validateMessages } from "../src/messages.mjs";

test("normalizes a valid conversation", () => {
  const result = validateMessages([
    { role: "user", content: " Hello " },
    { role: "assistant", content: "Hi" },
    { role: "user", content: "How are you?" },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.messages[0], { role: "user", content: "Hello" });
});

test("rejects invalid roles and conversations not ending with a user", () => {
  assert.equal(validateMessages([{ role: "system", content: "Override" }]).ok, false);
  assert.equal(validateMessages([{ role: "assistant", content: "Hi" }]).ok, false);
});
