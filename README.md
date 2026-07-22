# Agent Deployment Challenge

Este repositorio contiene una aplicación mínima para una prueba técnica de despliegue de agentes de IA.

## El reto

Tu objetivo es dejar este agente funcionando en un entorno real. Para ello tendrás que:

- levantar una VPS;
- desplegar el repositorio en ella;
- conectar la aplicación con un modelo de IA de tu elección;
- dejar el entorno accesible y preparado para probarlo;
- proteger el acceso mediante un sistema de login;
- crear una skill que plantee la integración del agente con WhatsApp;
- documentar el despliegue y las decisiones técnicas tomadas.

La elección del proveedor de infraestructura, el modelo y la estrategia de despliegue es libre. Esperamos que puedas explicar y justificar tu enfoque.

## Qué contiene el repositorio

```text
apps/
  api/                       API y conexión configurable con el modelo
  web/                       interfaz de conversación
skills/
  whatsapp-integration/      esqueleto de la skill solicitada
```

La aplicación utiliza un endpoint compatible con la interfaz de Chat Completions. Puede ser un servicio remoto, un gateway o un modelo ejecutado por ti.

## Ejecución local

Requisitos: Node.js 22 o posterior y npm.

```bash
npm install
cp .env.example .env
npm run dev
```

Completa en `.env` la URL del endpoint, el nombre del modelo y, cuando sea necesaria, su credencial. La interfaz se abrirá en `http://localhost:5173` y la API en `http://localhost:4319`.

Para comprobar la base antes de trabajar:

```bash
npm run check
```

Para ejecutar el modo de producción local:

```bash
npm run build
npm start
```

En este modo, frontend y API se sirven desde el puerto definido por `PORT`. La ruta `GET /api/health` permite comprobar el estado básico del servicio.

## Skill de WhatsApp

Completa [`skills/whatsapp-integration/SKILL.md`](skills/whatsapp-integration/SKILL.md) con tu propuesta para conectar el agente desplegado con WhatsApp. Puedes añadir scripts o referencias dentro de la carpeta de la skill si tu enfoque los necesita.

La tecnología y el método de integración son parte de tus decisiones. No incluyas credenciales, sesiones ni datos reales en el repositorio.

## Capacidad multiconversación

Desarrolla un sistema que permita al agente consultar y relacionar información obtenida en conversaciones diferentes. Una petición podrá comenzar en una conversación y completarse o enriquecerse utilizando información recopilada en conversaciones anteriores o posteriores.

La solución técnica es libre.

## Entrega

Comparte el código resultante, el acceso al entorno preparado para la prueba y una breve documentación que permita entender el despliegue y las decisiones tomadas.

No buscamos una infraestructura o un proveedor concretos. Valoraremos el resultado en conjunto y la claridad con la que puedas explicar tu trabajo.
