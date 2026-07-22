const ALLOWED_ROLES = new Set(["assistant", "user"]);
const MAX_MESSAGES = 30;
const MAX_MESSAGE_LENGTH = 8_000;

export function validateMessages(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: "A non-empty messages array is required" };
  }

  if (value.length > MAX_MESSAGES) {
    return { ok: false, error: `A maximum of ${MAX_MESSAGES} messages is allowed` };
  }

  const messages = [];

  for (const item of value) {
    const role = item?.role;
    const content = typeof item?.content === "string" ? item.content.trim() : "";

    if (!ALLOWED_ROLES.has(role)) {
      return { ok: false, error: "Every message must have a supported role" };
    }

    if (!content || content.length > MAX_MESSAGE_LENGTH) {
      return {
        ok: false,
        error: `Every message must contain between 1 and ${MAX_MESSAGE_LENGTH} characters`,
      };
    }

    messages.push({ role, content });
  }

  if (messages.at(-1)?.role !== "user") {
    return { ok: false, error: "The last message must come from the user" };
  }

  return { ok: true, messages };
}
