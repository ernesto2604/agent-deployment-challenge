import { useEffect, useRef, useState } from "react";

const EMPTY_HEALTH = { state: "checking", modelName: null, database: null };
const TOKEN_KEY = "agent-challenge:token";
const STORAGE_KEY = "agent-challenge:conversation:v1";

const STATUS_LABELS = {
  checking: "Comprobando",
  offline: "Sin conexión",
  ready: "Modelo conectado",
  unconfigured: "Modelo pendiente",
};

function loadStoredMessages() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return [];

    return value
      .filter(
        (message) =>
          (message?.role === "user" || message?.role === "assistant") &&
          typeof message?.content === "string" &&
          message.content.trim(),
      )
      .slice(-30)
      .map((message) => ({
        id: typeof message.id === "string" ? message.id : crypto.randomUUID(),
        role: message.role,
        content: message.content,
      }));
  } catch {
    return [];
  }
}

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "No se pudo completar la solicitud");
  }
  return payload;
}

function ModelStatus({ health }) {
  return (
    <div className={`status status--${health.state}`} role="status">
      <span className="status__dot" aria-hidden="true" />
      <span>{STATUS_LABELS[health.state]}</span>
      {health.modelName ? <strong>{health.modelName}</strong> : null}
    </div>
  );
}

function EmptyState() {
  return (
    <section className="empty-state">
      <span className="empty-state__index">01 / READY</span>
      <h2>El canal está abierto.</h2>
      <p>
        Escribe un mensaje para comprobar la conexión entre esta interfaz y el
        modelo configurado.
      </p>
      <div className="signal" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}

function Message({ message, index }) {
  const actor = message.role === "user" ? "Tú" : "Agente";

  return (
    <article className={`message message--${message.role}`}>
      <header>
        <span>{String(index + 1).padStart(2, "0")}</span>
        <strong>{actor}</strong>
      </header>
      <p>{message.content}</p>
    </article>
  );
}

function AuthModal({ onAuthSuccess, health }) {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email || !password) return;
    setError("");
    setLoading(true);

    const endpoint = isRegister ? "/api/auth/register" : "/api/auth/login";

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await readJson(response);
      localStorage.setItem(TOKEN_KEY, data.token);
      onAuthSuccess(data.user, data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-overlay">
      <div className="auth-modal">
        <h2>{isRegister ? "Crear Cuenta" : "Acceso al Agente"}</h2>
        <p>
          {isRegister
            ? "Regístrate para guardar tu historial de conversaciones y acceder al modelo de IA."
            : "Inicia sesión con tu cuenta para acceder a la consola del agente."}
        </p>

        {error ? <p className="composer__error">{error}</p> : null}

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="email">Correo Electrónico</label>
            <input
              id="email"
              type="email"
              placeholder="tu@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="auth-field">
            <label htmlFor="password">Contraseña</label>
            <input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
            />
          </div>

          <button className="auth-submit" type="submit" disabled={loading}>
            {loading ? "Procesando…" : isRegister ? "Registrarse e Iniciar Sesión" : "Iniciar Sesión"}
          </button>
        </form>

        <div className="auth-toggle">
          <span>{isRegister ? "¿Ya tienes una cuenta?" : "¿No tienes cuenta aún?"}</span>
          <button
            type="button"
            onClick={() => {
              setIsRegister(!isRegister);
              setError("");
            }}
          >
            {isRegister ? "Iniciar Sesión" : "Registrarse"}
          </button>
        </div>
      </div>
    </div>
  );
}

function submitOnEnter(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
}

export default function App() {
  const [health, setHealth] = useState(EMPTY_HEALTH);
  const [messages, setMessages] = useState(loadStoredMessages);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [activeConversationId, setActiveConversationId] = useState(null);
  const endRef = useRef(null);
  const sendingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();

    async function checkHealthAndAuth() {
      try {
        const healthResponse = await fetch("/api/health", { signal: controller.signal });
        const healthPayload = await readJson(healthResponse);
        setHealth({
          state: healthPayload.model?.configured ? "ready" : "unconfigured",
          modelName: healthPayload.model?.name || null,
          database: healthPayload.database,
        });

        // Validate token if stored
        if (token) {
          try {
            const meResponse = await fetch("/api/auth/me", {
              headers: { Authorization: `Bearer ${token}` },
              signal: controller.signal,
            });
            const meData = await readJson(meResponse);
            setUser(meData.user);
          } catch {
            localStorage.removeItem(TOKEN_KEY);
            setToken("");
            setUser(null);
          }
        }
      } catch (requestError) {
        if (requestError.name !== "AbortError") {
          setHealth({ state: "offline", modelName: null, database: null });
        }
      }
    }

    void checkHealthAndAuth();

    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // Storage unavailable fallback
    }
  }, [messages]);

  async function handleCreateNewConversation() {
    setMessages([]);
    setActiveConversationId(null);

    if (user && token) {
      try {
        const response = await fetch("/api/conversations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ title: `Conversación ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` }),
        });
        const data = await readJson(response);
        setActiveConversationId(data.conversation?.id);
      } catch (err) {
        console.error("Error al crear conversación:", err);
      }
    }
  }

  function handleLogout() {
    if (token) {
      void fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setUser(null);
    setMessages([]);
    setActiveConversationId(null);
  }

  async function sendMessage(event) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sendingRef.current) return;

    sendingRef.current = true;
    const nextMessages = [
      ...messages.slice(-29),
      { id: crypto.randomUUID(), role: "user", content },
    ];
    setMessages(nextMessages);
    setDraft("");
    setError("");
    setSending(true);

    try {
      const headers = { "content-type": "application/json" };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch("/api/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({
          messages: nextMessages,
          conversationId: activeConversationId,
        }),
      });
      const payload = await readJson(response);
      if (payload.conversationId) {
        setActiveConversationId(payload.conversationId);
      }
      setMessages((current) => [
        ...current,
        { ...payload.message, id: crypto.randomUUID() },
      ]);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  const showAuthModal = !user;

  return (
    <main className="app-shell">
      {showAuthModal ? (
        <AuthModal
          health={health}
          onAuthSuccess={(u, t) => {
            setUser(u);
            setToken(t);
          }}
        />
      ) : null}

      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">A</span>
          <div>
            <p>Deployment challenge</p>
            <h1>Agent Console</h1>
          </div>
        </div>
        <div className="topbar__actions">
          {user ? (
            <div className="user-badge">
              <span>👤 {user.email}</span>
              <button
                className="reset-button"
                type="button"
                onClick={handleLogout}
              >
                Salir
              </button>
            </div>
          ) : null}
          <button
            className="reset-button"
            type="button"
            onClick={handleCreateNewConversation}
            disabled={sending || messages.length === 0}
          >
            Nueva sesión
          </button>
          <ModelStatus health={health} />
        </div>
      </header>

      <div className="workspace">
        <aside className="context-panel">
          <span className="eyebrow">Entorno / 01</span>
          <h2>Una superficie mínima para una decisión completa.</h2>
          <p>
            Infraestructura, modelo y operación quedan en tus manos. Este panel
            solo confirma que todas las piezas se encuentran.
          </p>
          <dl>
            <div>
              <dt>Interfaz</dt>
              <dd>Activa</dd>
            </div>
            <div>
              <dt>API</dt>
              <dd>{health.state === "offline" ? "No disponible" : "Detectada"}</dd>
            </div>
            <div>
              <dt>Base de Datos</dt>
              <dd>{health.database?.connected ? "PostgreSQL 16 Activa" : "Inactiva"}</dd>
            </div>
            <div>
              <dt>Sesión</dt>
              <dd>{user ? user.email : "Local"}</dd>
            </div>
          </dl>
        </aside>

        <section className="chat-panel" aria-label="Conversación con el agente">
          <div className="chat-log" aria-live="polite">
            {messages.length === 0 ? <EmptyState /> : null}
            {messages.map((message, index) => (
              <Message key={message.id} message={message} index={index} />
            ))}
            {sending ? (
              <div className="thinking" role="status">
                <span />
                <span />
                <span />
                El agente está procesando
              </div>
            ) : null}
            <div ref={endRef} />
          </div>

          <form className="composer" onSubmit={sendMessage}>
            {error ? <p className="composer__error">{error}</p> : null}
            <label htmlFor="message">Mensaje</label>
            <div className="composer__row">
              <textarea
                id="message"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={submitOnEnter}
                placeholder="Escribe para probar el agente…"
                rows="2"
                maxLength="8000"
                disabled={sending}
              />
              <button type="submit" disabled={sending || !draft.trim()}>
                <span>Enviar</span>
                <span aria-hidden="true">↗</span>
              </button>
            </div>
            <small>Enter para enviar · Shift + Enter para una nueva línea</small>
          </form>
        </section>
      </div>
    </main>
  );
}
