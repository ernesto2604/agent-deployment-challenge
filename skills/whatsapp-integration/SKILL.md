---
name: whatsapp-integration
description: Diseño técnico para la integración oficial con WhatsApp Business Cloud API. Permite recibir mensajes, asociarlos a la cuenta de usuario mediante su número de teléfono, procesarlos de forma asíncrona usando la memoria existente y responder utilizando el modelo configurado.
---

# WhatsApp Integration Skill

## Objetivo

Esta skill proporciona el diseño técnico para la integración del **Agent Console** con **WhatsApp Business Cloud API** (Meta). El objetivo es que los usuarios registrados puedan chatear con su agente desde WhatsApp manteniendo su identidad, sesiones, y memoria histórica (FTS) de forma segura y escalable.

---

## 1. Variables de Entorno (`.env`)

Para la conexión con Meta, se deben añadir las siguientes variables al backend:

```env
# Meta WhatsApp Cloud API
WHATSAPP_ENABLED=true
WHATSAPP_VERIFY_TOKEN=tu_token_de_verificacion_webhook
WHATSAPP_APP_SECRET=tu_app_secret_de_meta # Requerido para X-Hub-Signature-256
WHATSAPP_API_TOKEN=tu_token_de_acceso_permanente
WHATSAPP_PHONE_NUMBER_ID=123456789012345
WHATSAPP_API_VERSION=v19.0 # Versión configurable de Graph API
```

---

## 2. Modelo de Datos y Asociación de Usuarios

Actualmente, `memory.mjs` depende del `user_id` (UUID) para asegurar el aislamiento. Para vincular un número de WhatsApp entrante a un usuario registrado, se debe extender el esquema:

### Alterar tabla `users` o crear tabla `identities`:
La solución más sencilla es añadir el teléfono a `users` mediante una migración SQL:

```sql
ALTER TABLE users ADD COLUMN phone_number VARCHAR(20) UNIQUE;
CREATE INDEX idx_users_phone ON users(phone_number);
```

### Tabla de Idempotencia (`whatsapp_messages`):
Para evitar procesar eventos duplicados de Meta, se debe almacenar el `message_id`:

```sql
CREATE TABLE processed_webhook_events (
  provider_message_id VARCHAR(255) PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

---

## 3. Endpoints del Webhook (`/api/webhook/whatsapp`)

### GET: Validación de Meta (Handshake)
Meta envía un reto que debe ser respondido si el token coincide.
- **Validación**: Compara `hub.verify_token` con `WHATSAPP_VERIFY_TOKEN`.
- **Respuesta**: Devuelve el entero `hub.challenge`.

### POST: Recepción de Mensajes
Debe incorporar reconocimiento rápido y procesamiento asíncrono para evitar timeouts de Meta.

#### A. Reconocimiento Rápido (Early ACK) y Seguridad
1. **Firma**: Calcular HMAC-SHA256 del payload crudo usando `WHATSAPP_APP_SECRET` y compararlo con la cabecera `X-Hub-Signature-256`. Si falla, devolver `401 Unauthorized`.
2. **ACK Temprano**: Si la firma es correcta, devolver inmediatamente `HTTP 200 OK`.
3. **Paso a Background**: Iniciar el procesamiento del mensaje de forma asíncrona (Promise o cola tipo BullMQ/Redis).

#### B. Procesamiento Asíncrono
1. **Idempotencia**: Extraer el `id` del mensaje entrante. Intentar insertar en `processed_webhook_events`. Si hay colisión de clave primaria, ignorar silenciosamente (evento duplicado).
2. **Identidad**: Extraer el teléfono (`from`). Hacer `SELECT id FROM users WHERE phone_number = $1`. Si no existe, detener o enviar mensaje de invitación a registro.
3. **Contexto**: Obtener la conversación actual del usuario o crear una nueva si han pasado X horas.
4. **Memoria y LLM**: 
   - Llamar a `findCrossConversationMemory(pool, { userId })`.
   - Preparar el prompt asegurando la inyección segura de la memoria.
   - Llamar a `requestCompletion()`.
5. **Persistencia**: Guardar el mensaje del usuario y la respuesta del asistente en PostgreSQL usando `saveMessage`.
6. **Envío Final**: Hacer una petición HTTP `POST` a `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages` con el texto generado y el `WHATSAPP_API_TOKEN` como Bearer token.

---

## 4. Ejemplos de Verificación Local

### Simular Handshake:
```bash
curl -X GET "http://localhost:4319/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=tu_token_de_verificacion_webhook&hub.challenge=11582014"
```

### Simular Mensaje Entrante (Requiere firma correcta en X-Hub-Signature-256):
```bash
# Ejemplo simplificado. En la realidad, debes firmar el RAW BODY con tu APP_SECRET
curl -X POST "http://localhost:4319/api/webhook/whatsapp" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=abcdef1234567890..." \
  -d '{
    "object": "whatsapp_business_account",
    "entry": [{
      "id": "12345",
      "changes": [{
        "value": {
          "messages": [{
            "id": "wamid.HBgL...",
            "from": "34600000000",
            "text": { "body": "Hola, ¿puedes resumir mis tareas?" }
          }]
        }
      }]
    }]
  }'
```

---

## 5. Consideraciones de Producción

- **Prompt Injection**: Al inyectar historial histórico recuperado por FTS en el system prompt, se debe usar un formato delimitado claro (p.ej. `<contexto>...</contexto>`) e instruir al modelo explícitamente para que no obedezca comandos dentro de esas etiquetas.
- **Rate Limiting Meta**: Meta impone límites sobre cuántos mensajes se pueden enviar por segundo. Para gran escala, usar una cola de trabajos (ej. Redis/Bull) es fundamental para respetar los límites sin perder mensajes.
- **Ventana de 24 horas**: Se debe almacenar la fecha del último mensaje del usuario. Solo se puede responder libremente en las 24 horas siguientes.
