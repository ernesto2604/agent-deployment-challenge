export class ModelRequestError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "ModelRequestError";
    this.status = status;
  }
}

export async function requestCompletion({ model, messages, fetchImpl = fetch }) {
  const headers = { "content-type": "application/json" };
  if (model.apiKey) headers.authorization = `Bearer ${model.apiKey}`;

  let response;

  try {
    response = await fetchImpl(`${model.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model.name,
        messages: [
          { role: "system", content: model.systemPrompt },
          ...messages,
        ],
      }),
      signal: AbortSignal.timeout(model.timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError") {
      throw new ModelRequestError("The model request timed out", 504);
    }
    throw new ModelRequestError("The model endpoint could not be reached");
  }

  if (!response.ok) {
    throw new ModelRequestError("The model endpoint rejected the request");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ModelRequestError("The model endpoint returned invalid JSON");
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new ModelRequestError("The model endpoint returned an empty response");
  }

  return content.trim();
}
