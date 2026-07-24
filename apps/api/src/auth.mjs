import crypto from "node:crypto";

const SALT_SIZE = 16;
const KEY_LENGTH = 64;
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_SIZE).toString("hex");
  const derivedKey = crypto.scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `${salt}:${derivedKey}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, key] = storedHash.split(":");
  const derivedKey = crypto.scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(key, "hex"), Buffer.from(derivedKey, "hex"));
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function validateEmail(email) {
  if (typeof email !== "string") return false;
  const trimmed = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

export async function registerUser(pool, { email, password }) {
  if (!validateEmail(email)) {
    throw new Error("Formato de correo electrónico inválido");
  }
  if (typeof password !== "string" || password.length < 6) {
    throw new Error("La contraseña debe tener al menos 6 caracteres");
  }

  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = hashPassword(password);

  try {
    const result = await pool.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, created_at`,
      [normalizedEmail, passwordHash],
    );
    return result.rows[0];
  } catch (error) {
    if (error.code === "23505") { // Unique violation
      throw new Error("El correo electrónico ya está registrado");
    }
    throw error;
  }
}

export async function loginUser(pool, { email, password }) {
  if (!email || !password) {
    throw new Error("Correo y contraseña son requeridos");
  }

  const normalizedEmail = email.trim().toLowerCase();
  const result = await pool.query(
    `SELECT id, email, password_hash FROM users WHERE email = $1`,
    [normalizedEmail],
  );

  if (result.rows.length === 0) {
    throw new Error("Credenciales inválidas");
  }

  const user = result.rows[0];
  const isValid = verifyPassword(password, user.password_hash);
  if (!isValid) {
    throw new Error("Credenciales inválidas");
  }

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, tokenHash, expiresAt],
  );

  return {
    user: { id: user.id, email: user.email },
    token: rawToken,
    expiresAt,
  };
}

export async function validateSession(pool, rawToken) {
  if (!rawToken || typeof rawToken !== "string") return null;

  const tokenHash = hashToken(rawToken);
  const result = await pool.query(
    `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.email
     FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [tokenHash],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    user: { id: row.user_id, email: row.email },
    session: { id: row.session_id, expiresAt: row.expires_at },
  };
}

export async function logoutSession(pool, rawToken) {
  if (!rawToken || typeof rawToken !== "string") return;
  const tokenHash = hashToken(rawToken);
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
}
