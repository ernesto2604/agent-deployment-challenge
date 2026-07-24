const DEFAULT_PORT = 4319;
const DEFAULT_TIMEOUT_MS = 60_000;

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

export function loadConfig(env = process.env) {
  const modelBaseUrl = env.MODEL_API_BASE_URL?.trim() ?? "";
  const modelName = env.MODEL_NAME?.trim() ?? "";
  const databaseUrl = env.DATABASE_URL?.trim() ?? "";

  if (modelBaseUrl) {
    try {
      new URL(modelBaseUrl);
    } catch {
      throw new Error("MODEL_API_BASE_URL must be a valid URL");
    }
  }

  if (databaseUrl) {
    let parsedDatabaseUrl;

    try {
      parsedDatabaseUrl = new URL(databaseUrl);
    } catch {
      throw new Error("DATABASE_URL must be a valid URL");
    }

    if (!["postgres:", "postgresql:"].includes(parsedDatabaseUrl.protocol)) {
      throw new Error(
        "DATABASE_URL must use the postgres or postgresql protocol",
      );
    }
  }

  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: parsePositiveInteger(env.PORT, DEFAULT_PORT, "PORT"),

    database: {
      url: databaseUrl,
    },

    databaseConfigured: Boolean(databaseUrl),

    model: {
      apiKey: env.MODEL_API_KEY?.trim() ?? "",
      baseUrl: modelBaseUrl.replace(/\/$/, ""),
      name: modelName,
      systemPrompt:
        env.MODEL_SYSTEM_PROMPT?.trim() ||
        "Eres un asistente virtual atento, inteligente y con capacidad de memoria entre conversaciones. Cuando el usuario te pregunte sobre datos o detalles mencionados en conversaciones anteriores (como su nombre, preferencias o vehículo), respóndele de forma directa, natural, cercana y afirmativa (por ejemplo: 'Te llamas Carlos y tu coche es rojo'), sin incluir disculpas ni aclaraciones sobre si tienes o no memoria.",
      timeoutMs: parsePositiveInteger(
        env.MODEL_REQUEST_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS,
        "MODEL_REQUEST_TIMEOUT_MS",
      ),
    },

    modelConfigured: Boolean(modelBaseUrl && modelName),
  };
}
