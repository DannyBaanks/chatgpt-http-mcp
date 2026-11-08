# ISyMCP Control Center — ChatGPT Private Plugin & Custom Action

Este paquete contiene la especificación oficial, manifiesto y recursos para integrar **ISyMCP Control Center** como complemento privado en ChatGPT.

---

## 1. Archivos del Paquete

- `.well-known/ai-plugin.json`: Manifiesto estándar de plugin para ChatGPT.
- `openapi.json`: Especificación OpenAPI 3.1.0 completa con esquemas tipados para todos los endpoints del Control Center.
- `plugin-logo.png`: Logotipo oficial de alta resolución (256x256 RGBA).
- `metadata.json`: Metadatos de plataforma, rutas y contratos de seguridad.
- `README.md`: Esta guía de instalación y arquitectura.

---

## 2. Modos de Instalación en ChatGPT

### Modo A: GPT Action (Recomendado para ChatGPT Plus / Team / Enterprise)

1. En ChatGPT, ve a **Explorar GPTs** > **Crear un GPT** (o edita uno existente).
2. En la pestaña **Configurar**, ve a **Acciones** > **Crear nueva acción**.
3. En **Esquema**, copia y pega el contenido de `openapi.json` (o importa desde la URL de tu túnel: `https://<tu-tunel>/openapi.json`).
4. Si tu túnel requiere token:
   - En **Autenticación**, selecciona **API Key**.
   - Tipo de autenticación: **Custom**.
   - Cabecera: `x-isymcp-token`.
   - Ingresa el token del bridge (`cat ~/.codex-web-http/token`).
5. Guarda el GPT con visibilidad **"Solo yo" (Privado)**.
6. El GPT ahora tendrá acceso nativo a:
   - Consultar salud y métricas de procesos (`getControlCenterOverview`).
   - Descubrir comandos del CLI y parámetros tipados (`getControlCenterGlossary`).
   - Inspeccionar tareas y recibos criptográficos en SQLite WAL (`getControlCenterTasks`).
   - Aprobar tareas pendientes (`approveControlCenterTask`).
   - Leer protocolos de coordinación de agentes (`getControlCenterProtocol`).
   - Ejecutar herramientas del gateway y comandos CLI verificados (`executeCliCommand`, `dispatchControlCenterAction`).

### Modo B: Plugin de Desarrollador (Developer Plugin en Localhost o Túnel)

1. En ChatGPT (con modo de desarrollo de plugins habilitado):
2. Selecciona **Tienda de complementos** > **Desarrollar tu propio complemento**.
3. Ingresa el dominio del servidor:
   - Local: `http://localhost:8798`
   - Remoto: `https://<tu-tunel>.trycloudflare.com`
4. ChatGPT leerá automáticamente `/.well-known/ai-plugin.json` y `/openapi.json`.
5. Confirma la instalación del complemento privado.

### Modo C: Plugin Creator Action (`create_plugin(archive=PATH)`)

Para entornos automatizados con acceso al conector `Plugin Creator`:
```python
create_plugin(archive="/home/danny/Development/ISyCo Git/chatgpt-http-mcp/dist/isymcp-chatgpt-plugin.zip")
```

---

## 3. Seguridad y Límites de la Plataforma

> [!IMPORTANT]
> **Aislamiento Criptográfico y Fail-Closed:**
> Ninguna acción peligrosa (`shell.exec`, mutaciones de repositorios, spawn de procesos no interactivos) puede ejecutarse sin un `OperatorGrant` criptográfico (HMAC-SHA256 con anti-replay y TTL de 60 segundos) emitido por el operador local.
> Si se intenta invocar un comando mutante sin grant, la API devuelve HTTP 403 con un desafío criptográfico estructurado.

> [!NOTE]
> **Límite de Plataforma (`BLOCKED_BY_ACCOUNT_REGISTRATION`):**
> Un repositorio o servidor local NO puede inyectar unilateralmente código en `chatgpt.com` ni agregar pestañas a la barra lateral de ChatGPT sin la intervención del usuario en su cuenta de OpenAI (a través de los pasos de instalación descritos arriba).
