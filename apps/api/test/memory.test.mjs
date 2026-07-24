import assert from "node:assert/strict";
import test from "node:test";

import {
  createConversation,
  findCrossConversationMemory,
  getConversationMessages,
  listConversations,
  saveMessage,
} from "../src/memory.mjs";

test("handles null database pool gracefully", async () => {
  assert.equal(await createConversation(null, { userId: "u1" }), null);
  assert.deepEqual(await listConversations(null, { userId: "u1" }), []);
  assert.deepEqual(await getConversationMessages(null, { conversationId: "c1", userId: "u1" }), []);
  assert.equal(await saveMessage(null, { conversationId: "c1", role: "user", content: "hi" }), null);
  assert.equal(await findCrossConversationMemory(null, { userId: "u1" }), "");
});
