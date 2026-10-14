# Auditoría Especial de Cumplimiento: Interacciones con ChatGPT Web

**Documento:** `docs/compliance/CHATGPT_WEB_COMPLIANCE_REVIEW.md`  
**Proyecto:** ISyMCP / chatgpt-http-mcp-impl  
**Fecha:** 2026-10-14  
**Prioridad:** P0 — Account Safety  
**Objeto:** Evaluación legal y técnica de la automatización sobre `chatgpt.com`.

---

## 1. Alcance de la Inspección

Se ha auditado la totalidad de los componentes de ISyMCP que interactúan directa o indirectamente con `https://chatgpt.com`:
* `src/visible/browser-host.ts`: Apertura de Chrome con banderas CDP (`--remote-debugging-port`), desactivación de banderas de automatización (`--disable-blink-features=AutomationControlled`).
* `src/visible/browser-driver.ts`: Manipulación de elementos del DOM de ChatGPT mediante Playwright (`textbox.fill`, `candidate.click`, `box.pressSequentially`, `send.click`).
* `src/visible/browser-worker.ts`: Exposición de socket unix `browser.sock` para someter mensajes y leer respuestas.
* `src/visible/browser-observer.ts`: Extracción de contenido del DOM mediante selectores (`[data-turn-key]`, `domToMarkdown`).
* `src/visible/browser-turn.ts`: Adaptador de turnos para inyectar prompts desde el bridge HTTP/Responses.
* `src/web-turn.ts`: Versión previa headless para navegación automatizada.

---

## 2. Preguntas Críticas de la Auditoría

### Pregunta 1: ¿Un agente externo puede iniciar un turno en ChatGPT mediante este mecanismo?
* **Hallazgo técnico:** SÍ. Cualquier proceso local con acceso al socket unix o que llame a `POST /v1/responses` puede provocar que el driver tome control del cursor y teclado del navegador y envíe un mensaje a ChatGPT sin que el usuario esté tocando el teclado.
* **Evaluación contractual:** **NO PERMITIDO**. OpenAI diseña la interfaz web exclusivamente para interacción humana interactiva. Iniciar turnos de forma desatendida mediante automatización externa contradice la finalidad del servicio web de consumidor.

---

### Pregunta 2: ¿La interfaz empleada está oficialmente autorizada para ese tipo de automatización?
* **Hallazgo técnico:** NO. Se utiliza el navegador Chrome conectado a Playwright a través de CDP (Chrome DevTools Protocol) interactuando con el DOM de la aplicación web de React de ChatGPT.
* **Evaluación contractual:** **NO AUTORIZADA**. Los Términos de Uso de OpenAI prohíben explícitamente "automatically or programmatically extract data or Output from our Services, except as permitted through our APIs" (§2(c)(iii)). La interfaz web NO es una API pública.

---

### Pregunta 3: ¿El mecanismo obtiene datos mediante extracción programática no permitida?
* **Hallazgo técnico:** SÍ. `browser-observer.ts` utiliza un observador de mutaciones del DOM y llamadas periódicas a `page.evaluate()` para volcar los nodos HTML de las respuestas y convertirlos a Markdown mediante `domToMarkdown`.
* **Evaluación contractual:** Constituye extracción programática (*scraping*) de la salida generada por el modelo dentro de una sesión web, violando directamente la sección 2(c)(iii) de los Términos de Uso.

---

### Pregunta 4: ¿La operación utiliza endpoints privados o comportamientos internos no documentados?
* **Hallazgo técnico:** No invoca directamente endpoints HTTP privados en background (evita hacer `fetch` a `/backend-api/*` por fuera del navegador), pero explota la estructura interna no documentada del DOM de ChatGPT (nombres accesibles, selectores `[app-mention-path]`, atributos `[data-turn-key]`).
* **Evaluación contractual:** Los comportamientos internos del DOM de ChatGPT no forman parte de un contrato de API garantizado. Su dependencia es frágil y su automatización está sujeta a medidas defensivas de la plataforma.

---

### Pregunta 5: ¿El mecanismo intenta reproducir el comportamiento de un usuario humano para evitar restricciones?
* **Hallazgo técnico:** SÍ.
  1. Se eliminó la bandera `navigator.webdriver` (`--disable-blink-features=AutomationControlled`).
  2. Se emplea `pressSequentially` con intervalos de pulsación para asemejar escritura humana.
  3. Se diseñó el flujo para eludir la detección de bots de Cloudflare Turnstile aprovechando la sesión interactiva del usuario.
* **Evaluación contractual:** **INFRACCIÓN CRÍTICA DE SEGURIDAD**. Intentar enmascarar o simular interacción humana para eludir filtros anti-automatización o protecciones de la plataforma viola directamente la prohibición expresa de "bypass any protective measures or safety filters we place on our Services" (§2(c)(viii) ToU).

---

### Pregunta 6: ¿La automatización puede continuar sin intervención del propietario de la cuenta?
* **Hallazgo técnico:** Una vez que el usuario inicia sesión manualmente en la ventana inicial, los scripts pueden someter peticiones sucesivas de forma autónoma sin confirmación humana previa por cada turno.
* **Evaluación contractual:** Representa automatización desatendida sobre una cuenta de consumidor, incompatible con los términos de servicio de la interfaz web.

---

### Pregunta 7: ¿Existe alguna autorización oficial específica para este comportamiento?
* **Hallazgo técnico:** Ninguna. Ni en la documentación de OpenAI ni en los términos de servicio existe autorización alguna para operar bots o agentes basados en CDP sobre la interfaz web de `chatgpt.com`.

---

## 3. Dictamen y Consecuencias para la Cuenta

### Dictamen de Cumplimiento
* **Clasificación:** **DENY** (Rotundo).
* **Riesgo para la cuenta:** **EXTREMO**.
  * Detección por sistemas heurísticos de OpenAI (análisis de eventos de puntero, cadencia de escritura, coherencia de foco del DOM).
  * Riesgo inminente de baneo de cuenta, suspensión de suscripción de pago (Plus/Pro) y revocación de acceso a la plataforma.

### Acción Correctiva Inmediata
1. **Desactivar de forma permanente** el envío desatendido a través de `sendVisibleWebTurn` y `browser-worker.ts` en cualquier flujo de agentes autónomos.
2. Mantener la ventana de Chrome visible **únicamente** para que el operador humano interactúe a mano con ChatGPT.
3. Si un agente necesita interactuar programáticamente con modelos de OpenAI, **debe utilizarse la API oficial autorizada (`api.openai.com`)** mediante una API key legítima con su correspondiente facturación y rate limits, o limitar ChatGPT a recibir llamadas de MCP cuando el humano lo solicite en su chat.
