export async function createConversation(pool, { userId, title = "Nueva conversación" }) {
  if (!pool) return null;
  const result = await pool.query(
    `INSERT INTO conversations (user_id, title)
     VALUES ($1, $2)
     RETURNING id, user_id, title, summary, created_at, updated_at`,
    [userId, title],
  );
  return result.rows[0];
}

export async function listConversations(pool, { userId }) {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, title, summary, created_at, updated_at
     FROM conversations
     WHERE user_id = $1
     ORDER BY updated_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function getConversationMessages(pool, { conversationId, userId }) {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT m.id, m.role, m.content, m.created_at
     FROM messages m
     JOIN conversations c ON m.conversation_id = c.id
     WHERE m.conversation_id = $1 AND c.user_id = $2
     ORDER BY m.created_at ASC`,
    [conversationId, userId],
  );
  return result.rows;
}

export async function saveMessage(pool, { conversationId, role, content }) {
  if (!pool || !conversationId) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const messageResult = await client.query(
      `INSERT INTO messages (conversation_id, role, content)
       VALUES ($1, $2, $3)
       RETURNING id, conversation_id, role, content, created_at`,
      [conversationId, role, content],
    );
    await client.query(
      `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
      [conversationId],
    );
    await client.query("COMMIT");
    return messageResult.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function findCrossConversationMemory(pool, { userId, currentConversationId, queryText = "", queryLimit = 15 }) {
  if (!pool || !userId) return "";

  try {
    let rows = [];

    // --- FTS relevance search (if a query text is provided) ---
    if (queryText && queryText.trim().length > 2) {
      const ftsResult = await pool.query(
        `SELECT conversation_id, conversation_title, role, content, created_at
         FROM (
           SELECT
             c.id AS conversation_id,
             c.title AS conversation_title,
             m.role,
             m.content,
             m.created_at,
             ts_rank(to_tsvector('spanish', m.content), plainto_tsquery('spanish', $3)) AS rank
           FROM messages m
           JOIN conversations c ON m.conversation_id = c.id
           WHERE c.user_id = $1
             AND ($2::uuid IS NULL OR c.id != $2)
             AND to_tsvector('spanish', m.content) @@ plainto_tsquery('spanish', $3)
         ) sub
         ORDER BY rank DESC, created_at DESC
         LIMIT $4`,
        [userId, currentConversationId || null, queryText, queryLimit],
      );
      rows = ftsResult.rows;
    }

    // --- Fallback: most recent messages from other conversations ---
    if (rows.length === 0) {
      const recentResult = await pool.query(
        `SELECT conversation_id, conversation_title, role, content, created_at
         FROM (
           SELECT c.id AS conversation_id, c.title AS conversation_title, m.role, m.content, m.created_at
           FROM messages m
           JOIN conversations c ON m.conversation_id = c.id
           WHERE c.user_id = $1 AND ($2::uuid IS NULL OR c.id != $2)
           ORDER BY m.created_at DESC
           LIMIT $3
         ) sub
         ORDER BY created_at ASC`,
        [userId, currentConversationId || null, queryLimit],
      );
      rows = recentResult.rows;
    }

    if (rows.length === 0) return "";

    const grouped = {};
    for (const row of rows) {
      const title = `Conversación previa ("${row.conversation_title || "Sesión anterior"}")`;
      if (!grouped[title]) grouped[title] = [];
      grouped[title].push(`${row.role === "user" ? "Usuario" : "Agente"}: ${row.content}`);
    }

    const memoryBlocks = Object.entries(grouped).map(
      ([title, msgs]) => `--- ${title} ---\n${msgs.join("\n")}`,
    );

    return `[MEMORIA CRUZADA DEL USUARIO E HISTORIAL DE CONVERSACIONES ANTERIORES]:\n${memoryBlocks.join("\n\n")}\n\n[INSTRUCCIÓN CRÍTICA DE MEMORIA]: Revisa cuidadosamente toda la memoria anterior. Si el usuario te ha dicho su nombre, color favorito, mascota, o cualquier dato en conversaciones anteriores, utilízalos para responder con total precisión cuando te pregunte por ellos.`;
  } catch (error) {
    console.error("Error al consultar memoria multiconversación:", error);
    return "";
  }
}

