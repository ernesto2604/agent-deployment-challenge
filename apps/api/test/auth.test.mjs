import assert from "node:assert/strict";
import test from "node:test";

import {
  generateToken,
  hashPassword,
  hashToken,
  validateEmail,
  verifyPassword,
} from "../src/auth.mjs";

test("hashes and verifies passwords correctly", () => {
  const password = "securePassword123";
  const hash = hashPassword(password);

  assert.notEqual(hash, password);
  assert.equal(verifyPassword(password, hash), true);
  assert.equal(verifyPassword("wrongPassword", hash), false);
});

test("validates emails correctly", () => {
  assert.equal(validateEmail("user@example.com"), true);
  assert.equal(validateEmail("INVALID_EMAIL"), false);
  assert.equal(validateEmail(""), false);
  assert.equal(validateEmail(null), false);
});

test("generates and hashes tokens consistently", () => {
  const token = generateToken();
  assert.equal(token.length, 64);

  const hash1 = hashToken(token);
  const hash2 = hashToken(token);
  assert.equal(hash1, hash2);
  assert.notEqual(hash1, token);
});
