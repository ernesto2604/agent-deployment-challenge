---
name: whatsapp-integration
description: Diseña la integración del Agent Console con WhatsApp Cloud API. Usa esta skill cuando sea necesario recibir mensajes de WhatsApp, asociarlos de forma segura con usuarios registrados, recuperar su memoria multiconversación y enviar respuestas mediante el modelo configurado.
---

# WhatsApp Integration Skill

## Objetivo

Esta skill proporciona el diseño técnico para la integración del **Agent Console** con **WhatsApp Business Cloud API** (Meta). El objetivo es que los usuarios registrados puedan chatear con su agente desde WhatsApp manteniendo su identidad, contexto conversacional y memoria histórica (FTS) de forma segura y escalable.

---

## 1. Variables de Entorno (`.env`)

Para la conexión con Meta, no se deben incluir secretos en el repositorio ni en las imágenes Docker; deben inyectarse mediante variables protegidas del entorno de despliegue o mediante un gestor de secretos.

```env
# Meta WhatsApp Cloud API
WHATSAPP_ENABLED=true
WHATSAPP_VERIFY_TOKEN=tu_token_de_verificacion_webhook
WHATSAPP_APP_SECRET=tu_app_secret_de_meta # Requerido para X-Hub-Signature-256
WHATSAPP_API_TOKEN=tu_token_de_usuario_del_sistema # Token persistente con permisos whatsapp_business_messaging
WHATSAPP_PHONE_NUMBER_ID=123456789012345
WHATSAPP_API_VERSION=v25.0 # La versión debe fijarse explícitamente y revisarse antes del despliegue
```

---

## 2. Modelo de Datos y Asociación de Usuarios

### Códigos de Vinculación (`identity_link_tokens`)
El usuario autenticado en la aplicación web genera un código de vinculación de un solo uso (OTP) y lo envía desde el número de WhatsApp que desea asociar. Para almacenar los códigos pendientes de forma segura:

```sql
CREATE TABLE identity_link_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp')),
  token_hash TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX identity_link_tokens_active_index
  ON identity_link_tokens (expires_at)
  WHERE used_at IS NULL;
```

El OTP nunca se almacena en texto plano, sino mediante un hash. Cuando llega un mensaje de WhatsApp con un código válido, no utilizado y no caducado, se crea la identidad con `verified_at = NOW()` y se marca el código mediante `used_at`. Los códigos deben tener una duración corta y un número limitado de intentos.

### Verificación de Identidad (`user_identities`)
Tabla que almacena exclusivamente las identidades que ya han superado el proceso de vinculación:

```sql
CREATE TABLE user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp')),
  provider_user_id VARCHAR(32) NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_user_id)
);
```

### Conversación del Canal (`channel_conversations`)
Para saber qué conversación utilizar en WhatsApp y controlar el periodo de inactividad de forma independiente a la web:

```sql
CREATE TABLE channel_conversations (
  identity_id UUID PRIMARY KEY REFERENCES user_identities(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Tabla de Idempotencia y Trabajos (`whatsapp_webhook_events`)
Para procesar eventos asíncronamente y manejar reintentos sin generar respuestas dobles:

```sql
CREATE TABLE whatsapp_webhook_events (
  provider_message_id VARCHAR(255) PRIMARY KEY,
  message_payload JSONB NOT NULL,
  response_text TEXT,
  outbound_message_id VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX whatsapp_webhook_events_pending_index
  ON whatsapp_webhook_events (status, next_attempt_at);
```

---

## 3. Endpoints del Webhook (`/api/webhook/whatsapp`)

### GET: Validación de Meta (Handshake)
1. Comprobar que `hub.mode === "subscribe"`.
2. Comparar `hub.verify_token` con `WHATSAPP_VERIFY_TOKEN`.
3. Si ambos valores son válidos, devolver `hub.challenge` como texto plano con `HTTP 200`.
4. Si la validación falla, devolver `HTTP 403`.

### POST: Recepción de Mensajes

#### A. RAW Body y Firma HMAC (Seguridad)
El endpoint de WhatsApp debe registrarse **antes** del middleware global `express.json()`, usando `express.raw({ type: "application/json" })`, o utilizar la opción `verify` de `express.json()` para conservar una copia exacta del RAW body. 

Antes de llamar a `crypto.timingSafeEqual`, se debe comprobar el prefijo `sha256=` y verificar que ambos buffers tienen la misma longitud. La firma nunca debe calcularse serializando de nuevo `request.body`.

#### B. Persistencia y ACK Temprano (Endpoint)
Lo correcto en producción sería:
1. Verificar la firma HMAC de Meta.
2. Validar mínimamente el evento (`object === "whatsapp_business_account"`).
3. Parsear el payload y recorrer sus elementos `entry`, `changes` y `messages`.
4. Crear de forma idempotente un trabajo duradero **por cada mensaje entrante** con `type === "text"`, utilizando el identificador del mensaje como clave primaria e insertando el mensaje individual en `message_payload`. Si la base de datos falla, devolver un `HTTP 500`.
5. Una vez persistidos todos los trabajos, responder `HTTP 200 OK` a Meta.

#### C. Lógica del Procesamiento Asíncrono (Worker)
Cada worker procesa directamente un mensaje individual almacenado en `message_payload`, adquiriendo el trabajo de forma atómica para evitar ejecuciones concurrentes del mismo mensaje:

```sql
SELECT provider_message_id FROM whatsapp_webhook_events
WHERE status IN ('pending', 'failed') AND next_attempt_at <= NOW()
ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1;
```
*(Tras adquirirlo, se cambia el `status` a `processing` en la misma transacción).*

El flujo principal será:
1. **Resolver la identidad**: Normalizar `from` a formato E.164 y buscar:
   ```sql
   SELECT user_id FROM user_identities
   WHERE provider = 'whatsapp' AND provider_user_id = $1 AND verified_at IS NOT NULL;
   ```
   *(Si no existe una identidad verificada, no se proporcionará acceso a la memoria privada y se responderá únicamente con instrucciones para vincular la cuenta o introducir el OTP).*
2. **Encontrar o crear la conversación del canal**: Buscar la conversación asociada a la identidad en `channel_conversations`. Si no existe o se ha superado el periodo de inactividad, crear una nueva.
3. **Guardar** el mensaje entrante en la base de datos.
4. **Recuperar** el historial de la conversación actual:
   ```javascript
   const conversationMessages = await getConversationMessages(pool, { conversationId, userId });
   ```
5. **Recuperar** memoria de otras conversaciones:
   ```javascript
   const memoryContext = await findCrossConversationMemory(pool, {
     userId,
     currentConversationId: conversationId,
     queryText: incomingText,
   });
   ```
6. **Construir** el prompt y generar la respuesta con el LLM.
7. **Guardar** la respuesta del asistente en PostgreSQL.
8. **Enviar** por WhatsApp mediante Graph API.

#### D. Petición de Salida (Graph API)
La respuesta se enviará mediante:
```http
POST https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages
Authorization: Bearer ${WHATSAPP_API_TOKEN}
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "34600000000",
  "type": "text",
  "text": {
    "preview_url": false,
    "body": "Respuesta generada por el agente"
  }
}
```

---

## 4. Consideraciones y Políticas

- **Idempotencia del Worker**: Cada fase del procesamiento debe ser reanudable. Si la respuesta del asistente ya fue generada y persistida (`response_text`), un reintento por fallo de red no debe volver a llamar al LLM; únicamente debe reintentar el envío pendiente a WhatsApp. Al tener éxito, se almacena el `outbound_message_id`.
- **Ventana de 24 horas**: Comienza o se renueva cuando el usuario envía un mensaje. Dentro de ella se pueden enviar respuestas de texto libres. Fuera de ella, solo se puede contactar al usuario mediante una plantilla aprobada por Meta.
- **Cumplimiento normativo**: Antes de activar la integración, revisar las condiciones vigentes de WhatsApp Business Platform, los requisitos de consentimiento y la normativa aplicable, especialmente el RGPD, la LOPDGDD y el Reglamento (UE) 2024/1689 (AI Act).
- **Privacidad**: Ofuscar teléfonos y contenido en logs, normalizar los números a E.164, definir la retención de identidades y eliminar o minimizar el `message_payload` una vez completado el procesamiento.
- **Prompt Injection**: Inyectar historial FTS en el prompt requiere etiquetas delimitadas (`<contexto>...</contexto>`) e instruir explícitamente al LLM para no obedecer inyecciones almacenadas en el historial.
