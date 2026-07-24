-- Add GIN index on messages.content for PostgreSQL Full-Text Search
-- This enables fast ts_rank relevance queries across conversation history

CREATE INDEX IF NOT EXISTS messages_content_fts_index
  ON messages USING GIN (to_tsvector('spanish', content));
