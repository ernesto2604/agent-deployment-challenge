import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import express from "express";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(sourceDirectory, "../../..");

dotenv.config({
  path: path.join(projectRoot, ".env"),
  quiet: true,
});

import {
  loginUser,
  logoutSession,
  registerUser,
  validateSession,
} from "./auth.mjs";
import { loadConfig } from "./config.mjs";
import { checkDatabase, createDatabasePool } from "./database.mjs";
import {
  createConversation,
  findCrossConversationMemory,
  getConversationMessages,
  listConversations,
  saveMessage,
} from "./memory.mjs";
import { performMigrations } from "./db/runner.mjs";
import { validateMessages } from "./messages.mjs";
import { ModelRequestError, requestCompletion } from "./model-client.mjs";

const webDirectory = path.resolve(sourceDirectory, "../../web/dist");

export async function createApp(config = loadConfig(), dependencies = {}) {
  const app = express();

  const databasePool =
    dependencies.databasePool ?? createDatabasePool(config.database?.url);

  app.locals.databasePool = databasePool;

  if (databasePool) {
    await performMigrations(databasePool);
  }

  app.disable("x-powered-by");

  app.use((request, response, next) => {
    response.set({
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    next();
  });

  app.use(express.json({ limit: "64kb" }));

  // Helper middleware for session extraction
  const authenticate = async (request, response, next) => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : request.headers["x-session-token"];

    if (!token) {
      request.user = null;
      return next();
    }

    try {
      const sessionData = await validateSession(databasePool, token);
      request.user = sessionData?.user ?? null;
      request.sessionToken = token;
    } catch {
      request.user = null;
    }
    next();
  };

  app.use(authenticate);

  app.get("/api/health", async (_request, response) => {
    const database = await checkDatabase(databasePool);
    const databaseUnavailable = database.configured && !database.connected;

    return response.status(200).json({
      status: databaseUnavailable ? "degraded" : "ok",
      model: {
        configured: config.modelConfigured,
        name: config.modelConfigured ? config.model.name : null,
      },
      database,
    });
  });

  app.post("/api/auth/register", async (request, response) => {
    if (!databasePool) {
      return response.status(503).json({ error: "La base de datos no está configurada" });
    }
    const { email, password } = request.body || {};
    try {
      const user = await registerUser(databasePool, { email, password });
      const session = await loginUser(databasePool, { email, password });
      return response.status(201).json(session);
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/auth/login", async (request, response) => {
    if (!databasePool) {
      return response.status(503).json({ error: "La base de datos no está configurada" });
    }
    const { email, password } = request.body || {};
    try {
      const session = await loginUser(databasePool, { email, password });
      return response.json(session);
    } catch (error) {
      return response.status(401).json({ error: error.message });
    }
  });

  app.get("/api/auth/me", (request, response) => {
    if (!request.user) {
      return response.status(401).json({ error: "No autenticado" });
    }
    return response.json({ user: request.user });
  });

  app.post("/api/auth/logout", async (request, response) => {
    if (request.sessionToken && databasePool) {
      await logoutSession(databasePool, request.sessionToken);
    }
    return response.json({ status: "ok" });
  });

  // Conversations endpoints
  app.get("/api/conversations", async (request, response) => {
    if (!request.user) {
      return response.status(401).json({ error: "No autenticado" });
    }
    const conversations = await listConversations(databasePool, { userId: request.user.id });
    return response.json({ conversations });
  });

  app.post("/api/conversations", async (request, response) => {
    if (!request.user) {
      return response.status(401).json({ error: "No autenticado" });
    }
    const title = request.body?.title || "Nueva conversación";
    const conversation = await createConversation(databasePool, { userId: request.user.id, title });
    return response.status(201).json({ conversation });
  });

  app.get("/api/conversations/:id/messages", async (request, response) => {
    if (!request.user) {
      return response.status(401).json({ error: "No autenticado" });
    }
    const messages = await getConversationMessages(databasePool, {
      conversationId: request.params.id,
      userId: request.user.id,
    });
    return response.json({ messages });
  });

  // Chat endpoint with Cross-Conversation Memory
  app.post("/api/chat", async (request, response) => {
    const requestId = crypto.randomUUID();

    if (!config.modelConfigured) {
      return response.status(503).json({
        error: "The model is not configured",
        requestId,
      });
    }

    const validation = validateMessages(request.body?.messages);
    if (!validation.ok) {
      return response.status(400).json({ error: validation.error, requestId });
    }

    if (!databasePool) {
      return response.status(503).json({
        error: "La base de datos y la autenticación no están configuradas",
        requestId,
      });
    }

    if (!request.user) {
      return response.status(401).json({ error: "No autenticado", requestId });
    }

    let activeConvId = request.body?.conversationId;
    let modelConfig = { ...config.model };

    if (request.user && databasePool) {
      if (activeConvId) {
        try {
          const ownedCheck = await databasePool.query(
            "SELECT id FROM conversations WHERE id = $1 AND user_id = $2",
            [activeConvId, request.user.id],
          );
          if (ownedCheck.rowCount === 0) {
            return response.status(404).json({
              error: "Conversación no encontrada",
              requestId,
            });
          }
        } catch (dbError) {
          console.error(`[${requestId}] conversation ownership check failed:`, dbError?.message);
          return response.status(503).json({
            error: "Error al verificar la conversación",
            requestId,
          });
        }
      }

      if (!activeConvId) {
        // Always create a new conversation so the memory search can include
        // ALL previous conversations (including the most recent one).
        // Reusing the latest would exclude it from the FTS memory query.
        const created = await createConversation(databasePool, {
          userId: request.user.id,
          title: "Nueva conversación",
        });
        activeConvId = created?.id;
      }

      const lastUserMessage = validation.messages.findLast?.((m) => m.role === "user")
        ?? validation.messages.filter((m) => m.role === "user").at(-1);

      const memoryContext = await findCrossConversationMemory(databasePool, {
        userId: request.user.id,
        currentConversationId: activeConvId,
        queryText: lastUserMessage?.content ?? "",
      });

      if (memoryContext) {
        modelConfig.systemPrompt = `${config.model.systemPrompt}\n\n${memoryContext}`;
      }
    }

    try {
      const content = await requestCompletion({
        model: modelConfig,
        messages: validation.messages,
      });

      // Save messages to DB if user & activeConvId are present
      if (request.user && activeConvId && databasePool) {
        const lastUserMsg = validation.messages.at(-1);
        if (lastUserMsg) {
          await saveMessage(databasePool, {
            conversationId: activeConvId,
            role: lastUserMsg.role,
            content: lastUserMsg.content,
          });
        }
        await saveMessage(databasePool, {
          conversationId: activeConvId,
          role: "assistant",
          content,
        });
      }

      return response.json({
        message: { role: "assistant", content },
        conversationId: activeConvId,
        requestId,
      });
    } catch (error) {
      const status = error instanceof ModelRequestError ? error.status : 500;
      const publicMessage =
        error instanceof ModelRequestError ? error.message : "An unexpected error occurred";

      console.error(`[${requestId}] chat request failed: ${error?.message ?? "unknown error"}`);
      return response.status(status).json({ error: publicMessage, requestId });
    }
  });

  if (fs.existsSync(webDirectory)) {
    app.use(express.static(webDirectory, { index: false }));
    app.use((request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api/")) {
        return next();
      }
      return response.sendFile(path.join(webDirectory, "index.html"));
    });
  }

  app.use((error, _request, response, next) => {
    if (error?.status === 413) {
      return response.status(413).json({ error: "Request body is too large" });
    }
    if (error instanceof SyntaxError && error?.status === 400) {
      return response.status(400).json({ error: "Request body contains invalid JSON" });
    }
    return next(error);
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found" });
  });

  return app;
}

export async function startServer(config = loadConfig()) {
  const app = await createApp(config);
  const server = app.listen(config.port, config.host, () => {
    console.log(`Agent challenge listening on http://${config.host}:${config.port}`);
  });

  server.on("close", () => {
    const pool = app.locals.databasePool;
    if (pool) {
      void pool.end();
    }
  });

  return server;
}

const isEntryPoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isEntryPoint) {
  startServer();
}
