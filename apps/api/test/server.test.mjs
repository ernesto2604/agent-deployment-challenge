import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createApp } from "../src/server.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Build a minimal stub config with an optional fake model server URL */
function stubConfig(modelPort) {
  return {
    modelConfigured: true,
    model: {
      apiKey: "",
      baseUrl: `http://127.0.0.1:${modelPort}/v1`,
      name: "local-test-model",
      systemPrompt: "Be useful",
      timeoutMs: 1_000,
    },
  };
}

/** Fake model server that always returns a canned response */
function makeModelServer() {
  return http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { content: "Integration works" } }],
      }),
    );
  });
}

// In-memory stub that mimics a pg Pool without touching a real DB
function makeStubPool({ users = [], sessions = [], conversations = [] } = {}) {
  const _users = [...users];
  const _sessions = [...sessions];
  const _conversations = [...conversations];

  return {
    async query(sql, params = []) {
      // conversations ownership check
      if (sql.includes("FROM conversations WHERE id = $1 AND user_id = $2")) {
        const [convId, userId] = params;
        const rows = _conversations.filter(
          (c) => c.id === convId && c.user_id === userId,
        );
        return { rows, rowCount: rows.length };
      }
      // listConversations
      if (sql.includes("FROM conversations") && sql.includes("WHERE user_id")) {
        const rows = _conversations.filter((c) => c.user_id === params[0]);
        return { rows };
      }
      // schema_migrations (runner)
      if (sql.includes("schema_migrations")) return { rows: [{ count: "1" }] };
      return { rows: [] };
    },
    connect: async () => ({
      query: async () => ({ rows: [] }),
      release: () => {},
    }),
    end: async () => {},
  };
}

// ---------------------------------------------------------------------------
// 1. Health check always returns 200
// ---------------------------------------------------------------------------
test("GET /api/health returns 200", async () => {
  const app = await createApp({ modelConfigured: false, model: {} }, { databasePool: null });
  const server = http.createServer(app);
  const addr = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    assert.equal(res.status, 200);
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// 2. POST /api/chat without token returns 401 (when DB is configured)
// ---------------------------------------------------------------------------
test("POST /api/chat without token returns 401", async () => {
  const modelServer = makeModelServer();
  const modelAddr = await listen(modelServer);

  const app = await createApp(stubConfig(modelAddr.port), {
    databasePool: makeStubPool(),
  });
  const appServer = http.createServer(app);
  const appAddr = await listen(appServer);

  try {
    const res = await fetch(`http://127.0.0.1:${appAddr.port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
    });
    assert.equal(res.status, 401);
    const payload = await res.json();
    assert.ok(payload.error);
  } finally {
    await close(appServer);
    await close(modelServer);
  }
});

// ---------------------------------------------------------------------------
// 3. POST /api/chat with invalid token returns 401
// ---------------------------------------------------------------------------
test("POST /api/chat with invalid token returns 401", async () => {
  const modelServer = makeModelServer();
  const modelAddr = await listen(modelServer);

  const app = await createApp(stubConfig(modelAddr.port), {
    databasePool: makeStubPool(),
  });
  const appServer = http.createServer(app);
  const appAddr = await listen(appServer);

  try {
    const res = await fetch(`http://127.0.0.1:${appAddr.port}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer invalid-token-xyz",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close(appServer);
    await close(modelServer);
  }
});

// ---------------------------------------------------------------------------
// 4. POST /api/auth/login with wrong credentials returns 401
// ---------------------------------------------------------------------------
test("POST /api/auth/login with wrong credentials returns 401", async () => {
  // Pool that rejects login (no users)
  const pool = makeStubPool();
  pool.query = async (sql) => {
    if (sql.includes("FROM users")) return { rows: [] };
    if (sql.includes("schema_migrations")) return { rows: [{ count: "1" }] };
    return { rows: [] };
  };

  const app = await createApp({ modelConfigured: false, model: {} }, { databasePool: pool });
  const server = http.createServer(app);
  const addr = await listen(server);

  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// 5. GET /api/auth/me without token returns 401
// ---------------------------------------------------------------------------
test("GET /api/auth/me without token returns 401", async () => {
  const app = await createApp({ modelConfigured: false, model: {} }, { databasePool: null });
  const server = http.createServer(app);
  const addr = await listen(server);

  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/auth/me`);
    assert.equal(res.status, 401);
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// 6. GET /api/conversations without token returns 401
// ---------------------------------------------------------------------------
test("GET /api/conversations without token returns 401", async () => {
  const app = await createApp({ modelConfigured: false, model: {} }, { databasePool: makeStubPool() });
  const server = http.createServer(app);
  const addr = await listen(server);

  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/conversations`);
    assert.equal(res.status, 401);
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// 7. POST /api/chat returns 503 when no DB pool is injected (fail-closed)
// ---------------------------------------------------------------------------
test("POST /api/chat returns 503 when model is configured but DB is missing", async () => {
  const modelServer = makeModelServer();
  const modelAddr = await listen(modelServer);

  const app = await createApp(stubConfig(modelAddr.port), { databasePool: null });
  const appServer = http.createServer(app);
  const appAddr = await listen(appServer);

  try {
    const res = await fetch(`http://127.0.0.1:${appAddr.port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
    });
    assert.equal(res.status, 503);
    const payload = await res.json();
    assert.ok(payload.error);
  } finally {
    await close(appServer);
    await close(modelServer);
  }
});

// ---------------------------------------------------------------------------
// 8. Unknown routes return 404
// ---------------------------------------------------------------------------
test("unknown routes return 404", async () => {
  const app = await createApp({ modelConfigured: false, model: {} }, { databasePool: null });
  const server = http.createServer(app);
  const addr = await listen(server);

  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/does-not-exist`);
    assert.equal(res.status, 404);
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// 9. Authenticated user gets a valid chat response (happy path)
// ---------------------------------------------------------------------------
test("authenticated user receives a valid chat response", async () => {
  const modelServer = makeModelServer();
  const modelAddr = await listen(modelServer);

  const SESSION_TOKEN = "happy-path-token";
  const USER_ID = "happy-user-uuid";
  const CONV_ID = "happy-conv-uuid";

  const pool = makeStubPool();
  pool.query = async (sql, params = []) => {
    // Session validation — must match columns validateSession() expects
    if (sql.includes("FROM sessions") && sql.includes("JOIN users")) {
      return {
        rows: [{
          session_id: "session-happy",
          expires_at: new Date(Date.now() + 60_000),
          user_id: USER_ID,
          email: "happy@test.com",
        }],
      };
    }
    // createConversation — server always creates a new one when no conversationId sent
    if (sql.includes("INSERT INTO conversations")) {
      return { rows: [{ id: CONV_ID, user_id: USER_ID, title: "Nueva conversación", created_at: new Date(), updated_at: new Date() }] };
    }
    // Memory FTS / recent query — no prior history
    if (sql.includes("FROM messages")) return { rows: [] };
    if (sql.includes("schema_migrations")) return { rows: [{ count: "1" }] };
    // saveMessage / updateConversation
    return { rows: [], rowCount: 1 };
  };
  pool.connect = async () => ({
    query: async () => ({ rows: [] }),
    release: () => {},
  });

  const app = await createApp(stubConfig(modelAddr.port), { databasePool: pool });
  const appServer = http.createServer(app);
  const appAddr = await listen(appServer);

  try {
    const res = await fetch(`http://127.0.0.1:${appAddr.port}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${SESSION_TOKEN}`,
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.deepEqual(payload.message, { role: "assistant", content: "Integration works" });
    assert.ok(payload.conversationId, "Should return a conversationId");
  } finally {
    await close(appServer);
    await close(modelServer);
  }
});

// ---------------------------------------------------------------------------
// 10. POST /api/chat with a conversationId from another user returns 404
// ---------------------------------------------------------------------------
test("POST /api/chat with a foreign conversationId returns 404", async () => {
  const modelServer = makeModelServer();
  const modelAddr = await listen(modelServer);

  const FOREIGN_CONV_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const SESSION_TOKEN = "valid-session-token";
  const USER_ID = "user-uuid-001";

  const pool = makeStubPool();
  pool.query = async (sql, params = []) => {
    // Session validation — must match exact columns validateSession() selects
    if (sql.includes("FROM sessions") && sql.includes("JOIN users")) {
      return {
        rows: [{
          session_id: "session-001",
          expires_at: new Date(Date.now() + 60_000),
          user_id: USER_ID,
          email: "user@test.com",
        }],
      };
    }
    // Conversation ownership check — empty means foreign/non-existent
    if (sql.includes("FROM conversations WHERE id")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("schema_migrations")) return { rows: [{ count: "1" }] };
    return { rows: [] };
  };

  const app = await createApp(stubConfig(modelAddr.port), { databasePool: pool });
  const appServer = http.createServer(app);
  const appAddr = await listen(appServer);

  try {
    const res = await fetch(`http://127.0.0.1:${appAddr.port}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${SESSION_TOKEN}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
        conversationId: FOREIGN_CONV_ID,
      }),
    });
    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.ok(payload.error);
  } finally {
    await close(appServer);
    await close(modelServer);
  }
});

// ---------------------------------------------------------------------------
// 11. findCrossConversationMemory passes correct SQL params to exclude current conversation
// ---------------------------------------------------------------------------
test("findCrossConversationMemory passes correct SQL params to exclude current conversation", async () => {
  const { findCrossConversationMemory } = await import("../src/memory.mjs");

  const CURRENT_CONV_ID = "current-conv-id";
  const USER_ID = "user-001";

  let capturedSql;
  let capturedParams;

  const mockPool = {
    query: async (sql, params) => {
      // Capture the first real query (FTS or recent fallback)
      if (!capturedSql && sql.includes("FROM messages")) {
        capturedSql = sql;
        capturedParams = params;
      }
      return { rows: [] };
    },
  };

  // No queryText → goes straight to the recent fallback query
  await findCrossConversationMemory(mockPool, {
    userId: USER_ID,
    currentConversationId: CURRENT_CONV_ID,
  });

  assert.ok(capturedSql, "Should have executed a SQL query");
  // Verify the SQL actively excludes the current conversation
  assert.match(capturedSql, /c\.id\s*!=\s*\$2/, "SQL must exclude current conversation with c.id != $2");
  // Verify correct parameter order
  assert.equal(capturedParams[0], USER_ID, "First param must be userId");
  assert.equal(capturedParams[1], CURRENT_CONV_ID, "Second param must be currentConversationId");
});
