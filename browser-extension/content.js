const INITIAL_PROMPT = `Actúa como @remote desktop commander conectado a mi ordenador mediante GottaRemoteMCP.
IMPORTANTE: No uses tu navegador web integrado ni curl desde tu sandbox. Mi navegador tiene activo el puente automático GottaRemoteMCP que lee tus respuestas y las ejecuta en mi PC.

Cada vez que quieras ejecutar un comando en terminal, abrir programas gráficos, leer/escribir/editar un archivo, listar directorios o controlar el escritorio, responde con un bloque de código \`\`\`gotta (o \`\`\`json) con un objeto JSON válido que contenga la clave "action". Mi puente lo ejecutará automáticamente en mi PC y te enviará la salida en el siguiente mensaje.

Formato de objetos JSON soportados:
- Ejecutar comando bash (mantiene cwd): {"action": "exec", "cmd": "COMANDO_A_EJECUTAR"}
- Leer archivo: {"action": "read", "path": "RUTA", "start": 1, "end": 150}
- Escribir archivo: {"action": "write", "path": "RUTA", "content": "CONTENIDO"}
- Editar bloque exacto: {"action": "edit", "path": "RUTA", "search": "BUSCAR", "replace": "REEMPLAZAR"}
- Listar directorio: {"action": "ls", "path": "."}
- Buscar código: {"action": "search", "q": "PATRON", "path": "."}
- Sesiones/Procesos: {"action": "sessions"} | {"action": "session-output", "pid": 123} | {"action": "kill", "pid": 123}
- Escritorio (ratón/teclado): {"action": "input", "type": "click", "x": 500, "y": 300}

Para verificar la conexión ahora mismo, responde únicamente con un bloque JSON que ejecute el comando: pwd && whoami && uname -a`;

const VALID_ACTIONS = new Set([
  "exec",
  "read",
  "write",
  "edit",
  "ls",
  "search",
  "sessions",
  "session-output",
  "kill",
  "input",
  "status",
  "screen",
]);

// Ignorar los ejemplos literales del propio prompt de instrucciones
const IGNORED_EXAMPLE_CMDS = new Set(["pwd && ls -la", "COMANDO_A_EJECUTAR"]);

let currentEndpoint = "";
let autoRun = true;
let isMinimized = false;
let isExecuting = false;
const executedHashes = new Set();

function setLog(text, color = "#d1d5db") {
  const logEl = document.getElementById("gotta-ext-status-log");
  if (logEl) {
    logEl.style.color = color;
    logEl.textContent = text;
  }
}

function updateWidgetInput() {
  const epEl = document.getElementById("gotta-ep-input");
  if (epEl && document.activeElement !== epEl) {
    epEl.value = currentEndpoint;
  }
}

/**
 * Extrae todos los objetos JSON válidos con {"action": ...} desde cualquier texto
 * (tanto dentro de cajas </> gotta / CodeMirror / pre / code como en texto plano).
 */
function extractGottaObjectsFromText(rawText) {
  const results = [];
  if (!rawText || !rawText.includes('"action"')) return results;

  for (let start = 0; start < rawText.length; start++) {
    if (rawText[start] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < rawText.length; i++) {
      const ch = rawText[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
      } else {
        if (ch === '"') {
          inString = true;
        } else if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) {
            const candidate = rawText.slice(start, i + 1);
            if (candidate.includes('"action"')) {
              try {
                const parsed = JSON.parse(candidate);
                if (
                  parsed &&
                  typeof parsed === "object" &&
                  VALID_ACTIONS.has(parsed.action) &&
                  !IGNORED_EXAMPLE_CMDS.has(parsed.cmd) &&
                  parsed.path !== "RUTA" &&
                  parsed.path !== "/ruta/archivo"
                ) {
                  results.push({ raw: candidate, parsed });
                  start = i;
                }
              } catch {
                // Ignorar si no es JSON válido
              }
            }
            break;
          }
        }
      }
    }
  }
  return results;
}

function isUserElement(el) {
  if (!el) return false;
  if (
    el.closest('[data-message-author-role="user"]') ||
    el.closest(".user-query") ||
    el.closest("user-query") ||
    el.closest("#gotta-remote-ext-widget") ||
    el.closest("form")
  ) {
    return true;
  }
  const article = el.closest("article");
  if (article && article.querySelector('[data-message-author-role="user"]')) {
    // Si el article solo tiene mensaje de usuario y no de assistant
    if (!article.querySelector('[data-message-author-role="assistant"]')) {
      return true;
    }
  }
  return false;
}

/**
 * Busca todos los contenedores de respuesta o bloques de código del asistente en la página.
 */
function findCandidateBlocks() {
  const candidates = Array.from(
    document.querySelectorAll(
      '[data-message-author-role="assistant"], pre, code, .cm-content, model-response, .model-response-text, article'
    )
  );
  return candidates.filter((el) => !isUserElement(el));
}

function findChatEditor() {
  return (
    document.querySelector("#prompt-textarea") ||
    document.querySelector('div.ProseMirror[contenteditable="true"]') ||
    document.querySelector('.ql-editor[contenteditable="true"]') ||
    document.querySelector('div[contenteditable="true"][role="textbox"]') ||
    document.querySelector("textarea")
  );
}

function findSendButton() {
  return (
    document.querySelector('[data-testid="send-button"]') ||
    document.querySelector('[data-testid="fruitjuice-send-button"]') ||
    document.querySelector("button.send-button") ||
    document.querySelector('form button[aria-label="Send prompt"]') ||
    document.querySelector('form button[aria-label="Enviar prompt"]') ||
    document.querySelector('form button[aria-label="Enviar mensaje"]')
  );
}

function sendTextToChat(text) {
  try {
    navigator.clipboard.writeText(text).catch(() => {});
  } catch {}

  const editor = findChatEditor();
  if (!editor) {
    setLog(
      "⚠️ No se encontró la caja del chat. Respuesta copiada al portapapeles (Ctrl+V).",
      "#fbbf24"
    );
    return false;
  }

  editor.focus();

  if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(editor, text);
    } else {
      editor.value = text;
    }
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    // Seleccionar todo el contenido actual del editor ProseMirror / Quill e insertar con execCommand
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);

    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch {}

    if (!ok || (editor.textContent || "").trim().length < 3) {
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        const pasteEvent = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });
        editor.dispatchEvent(pasteEvent);
      } catch {}
    }

    if ((editor.textContent || "").trim().length < 3) {
      editor.innerHTML =
        "<p>" +
        text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/\n/g, "</p><p>") +
        "</p>";
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    }
  }

  // Intentar pulsar el botón de envío tras habilitarse en React/ProseMirror
  let attempts = 0;
  const tryClickSend = () => {
    attempts++;
    const btn = findSendButton();
    if (btn && !btn.disabled) {
      btn.click();
      setLog("✅ Respuesta enviada al chat automáticamente.", "#10b981");
      return;
    }
    if (attempts < 4) {
      setTimeout(tryClickSend, 250);
    } else {
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      );
      setLog("✅ Respuesta insertada en la caja del chat (pulsa Enter si no salió).", "#10b981");
    }
  };
  setTimeout(tryClickSend, 250);

  return true;
}

function getCleanElementText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll(".gotta-exec-badge").forEach((b) => b.remove());
  return (clone.textContent || "").trim();
}

function pingServer(callback) {
  setLog("🔄 Probando conexión con GottaRemoteMCP...", "#60a5fa");
  chrome.runtime.sendMessage(
    { type: "GOTTA_PING", endpoint: currentEndpoint },
    (resp) => {
      if (chrome.runtime.lastError) {
        setLog("❌ Recarga esta pestaña (F5) tras actualizar la extensión.", "#f87171");
        if (callback) callback(false);
        return;
      }
      if (!resp || !resp.ok) {
        setLog("❌ " + (resp?.error || "No se pudo conectar al PC"), "#f87171");
        if (callback) callback(false);
        return;
      }
      if (resp.endpoint && resp.endpoint !== currentEndpoint) {
        currentEndpoint = resp.endpoint;
        updateWidgetInput();
      }
      const st = resp.data?.status || {};
      const host = st.hostname || st.host || "PC";
      const cwd = st.cwd || resp.data?.cwd || "~";
      setLog(`✅ Conectado a ${host} (${cwd})`, "#10b981");
      if (callback) callback(true);
    }
  );
}

function executeGottaPayload(targetEl, parsed, rawJson) {
  if (isExecuting) return;
  isExecuting = true;

  const summary = String(
    parsed.cmd || parsed.command || parsed.path || parsed.q || parsed.action
  ).slice(0, 55);
  setLog(`⚡ Ejecutando en PC: ${summary}...`, "#fbbf24");

  chrome.runtime.sendMessage(
    { type: "GOTTA_EXEC", endpoint: currentEndpoint, payload: parsed },
    (resp) => {
      isExecuting = false;
      if (!resp || !resp.ok) {
        const errMsg = resp?.error || "Error de conexión con GottaRemoteMCP";
        setLog(`❌ Error: ${errMsg}`, "#f87171");
        sendTextToChat(`[GottaRemoteMCP Error] ${errMsg}`);
        return;
      }

      if (resp.endpoint && resp.endpoint !== currentEndpoint) {
        currentEndpoint = resp.endpoint;
        updateWidgetInput();
      }

      const container = targetEl?.closest("article") || targetEl;
      if (container && !container.querySelector(".gotta-exec-badge")) {
        const badge = document.createElement("div");
        badge.className = "gotta-exec-badge";
        badge.style.cssText =
          "background:#064e3b;color:#a7f3d0;font-size:11px;padding:5px 10px;border-radius:6px;margin-top:8px;display:inline-block;font-family:monospace;border:1px solid #10b981;";
        badge.textContent = `✅ Ejecutado en tu PC por GottaRemoteMCP (${parsed.action}: ${summary})`;
        container.appendChild(badge);
      }

      setLog(`✅ Ejecutado (${summary}). Enviando salida al chat...`, "#10b981");
      const reply =
        "[GottaRemoteMCP Output]\n```json\n" +
        JSON.stringify(resp.data, null, 2).slice(0, 12000) +
        "\n```";
      sendTextToChat(reply);
    }
  );
}

function makeWidgetDraggable(box, handle) {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  chrome.storage.local.get(["gottaWidgetPos"], (res) => {
    if (res.gottaWidgetPos) {
      const { left, top } = res.gottaWidgetPos;
      const clampedLeft = Math.max(8, Math.min(window.innerWidth - 200, left));
      const clampedTop = Math.max(8, Math.min(window.innerHeight - 60, top));
      box.style.left = clampedLeft + "px";
      box.style.top = clampedTop + "px";
      box.style.right = "auto";
      box.style.bottom = "auto";
    }
  });

  handle.addEventListener("mousedown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
    isDragging = true;
    const rect = box.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    initialLeft = rect.left;
    initialTop = rect.top;
    box.style.right = "auto";
    box.style.bottom = "auto";
    box.style.left = initialLeft + "px";
    box.style.top = initialTop + "px";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const newLeft = Math.max(
      4,
      Math.min(window.innerWidth - box.offsetWidth - 4, initialLeft + dx)
    );
    const newTop = Math.max(4, Math.min(window.innerHeight - 40, initialTop + dy));
    box.style.left = newLeft + "px";
    box.style.top = newTop + "px";
  });

  window.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    const rect = box.getBoundingClientRect();
    chrome.storage.local.set({
      gottaWidgetPos: { left: rect.left, top: rect.top },
    });
  });
}

function scanAllPageForGottaObjects() {
  const allFound = [];
  const seenRaws = new Set();
  const blocks = findCandidateBlocks();

  for (const el of blocks) {
    const txt = getCleanElementText(el);
    if (!txt.includes('"action"')) continue;
    const objs = extractGottaObjectsFromText(txt);
    for (const obj of objs) {
      if (!seenRaws.has(obj.raw)) {
        seenRaws.add(obj.raw);
        allFound.push({ el, ...obj });
      }
    }
  }
  return allFound;
}

function mountWidget() {
  if (document.getElementById("gotta-remote-ext-widget")) return;
  const box = document.createElement("div");
  box.id = "gotta-remote-ext-widget";
  box.style.cssText =
    "position:fixed;top:16px;right:18px;z-index:999999;background:#111827;color:#f9fafb;padding:10px 12px;border-radius:12px;border:1px solid #10b981;font-family:system-ui,sans-serif;font-size:12px;box-shadow:0 10px 25px rgba(0,0,0,0.55);display:flex;flex-direction:column;gap:7px;width:290px;user-select:none;";
  box.innerHTML = `
    <div id="gotta-drag-handle" title="Arrastra desde aquí para mover el cuadro" style="display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:move;padding-bottom:4px;border-bottom:1px solid #1f2937;">
      <span style="font-weight:700;color:#10b981;display:flex;align-items:center;gap:5px;">
        ⠿ 🟢 GottaRemoteMCP
      </span>
      <div style="display:flex;align-items:center;gap:6px;">
        <label style="cursor:pointer;display:flex;align-items:center;gap:3px;font-size:11px;">
          <input type="checkbox" id="gotta-ext-autorun" checked /> Auto
        </label>
        <button id="gotta-ext-min-btn" title="Minimizar / Expandir" style="background:#1f2937;color:#9ca3af;border:none;border-radius:4px;padding:1px 6px;font-size:12px;cursor:pointer;">
          —
        </button>
      </div>
    </div>
    <div id="gotta-ext-body" style="display:flex;flex-direction:column;gap:7px;">
      <div style="display:flex;gap:5px;">
        <input id="gotta-ep-input" type="text" placeholder="http://localhost:3000/c/user/pass" style="background:#1f2937;color:#fff;border:1px solid #374151;border-radius:6px;padding:5px 7px;font-size:11px;flex:1;min-width:0;" />
        <button id="gotta-ext-ping-btn" title="Probar conexión con tu PC" style="background:#374151;color:#f9fafb;border:none;border-radius:6px;padding:5px 7px;font-size:11px;cursor:pointer;white-space:nowrap;">
          🔍 Probar
        </button>
      </div>
      <div id="gotta-ext-status-log" style="background:#030712;border:1px solid #1f2937;border-radius:6px;padding:6px 8px;font-size:11px;color:#9ca3af;min-height:16px;line-height:1.35;word-break:break-word;user-select:text;">
        ⚪ Listo para conectar
      </div>
      <div style="display:flex;gap:5px;">
        <button id="gotta-ext-init-btn" style="flex:1;background:#10b981;color:#06281e;border:none;border-radius:6px;padding:7px 8px;font-weight:700;font-size:11px;cursor:pointer;">
          🚀 Conectar Chat
        </button>
        <button id="gotta-ext-runlast-btn" title="Ejecutar ahora mismo el último comando JSON que aparece en el chat" style="background:#2563eb;color:#fff;border:none;border-radius:6px;padding:7px 8px;font-weight:600;font-size:11px;cursor:pointer;white-space:nowrap;">
          ▶️ Ejecutar último
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(box);

  makeWidgetDraggable(box, document.getElementById("gotta-drag-handle"));

  const epInput = document.getElementById("gotta-ep-input");
  epInput.value = currentEndpoint;
  epInput.addEventListener("input", (e) => {
    currentEndpoint = e.target.value.trim().replace(/\?.*$/, "").replace(/\/+$/, "");
    chrome.storage.local.set({ gottaEndpoint: currentEndpoint });
  });

  document.getElementById("gotta-ext-autorun").addEventListener("change", (e) => {
    autoRun = e.target.checked;
  });

  document.getElementById("gotta-ext-min-btn").addEventListener("click", () => {
    isMinimized = !isMinimized;
    const bodyEl = document.getElementById("gotta-ext-body");
    const minBtn = document.getElementById("gotta-ext-min-btn");
    if (isMinimized) {
      bodyEl.style.display = "none";
      box.style.width = "190px";
      minBtn.textContent = "+";
    } else {
      bodyEl.style.display = "flex";
      box.style.width = "290px";
      minBtn.textContent = "—";
    }
  });

  document.getElementById("gotta-ext-ping-btn").addEventListener("click", () => {
    pingServer();
  });

  document.getElementById("gotta-ext-init-btn").addEventListener("click", () => {
    const existing = scanAllPageForGottaObjects();
    existing.forEach((item) => executedHashes.add(item.raw));
    pingServer((ok) => {
      if (!ok) return;
      setLog("📨 Insertando prompt en el chat...", "#60a5fa");
      sendTextToChat(INITIAL_PROMPT);
    });
  });

  document.getElementById("gotta-ext-runlast-btn").addEventListener("click", () => {
    const found = scanAllPageForGottaObjects();
    if (found.length > 0) {
      const last = found[found.length - 1];
      executedHashes.add(last.raw);
      executeGottaPayload(last.el, last.parsed, last.raw);
      return;
    }
    setLog("⚠️ No se encontró ningún comando JSON en la página.", "#fbbf24");
  });

  setTimeout(() => pingServer(), 400);
}

chrome.storage.local.get(["gottaEndpoint"], (res) => {
  if (res.gottaEndpoint) {
    currentEndpoint = res.gottaEndpoint;
    updateWidgetInput();
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.gottaEndpoint) {
    currentEndpoint = changes.gottaEndpoint.newValue || "";
    updateWidgetInput();
  }
});

function isAssistantStreaming() {
  const stopBtn = document.querySelector('[data-testid="stop-button"]');
  if (stopBtn && stopBtn.offsetParent !== null) return true;
  if (document.querySelector(".result-streaming")) return true;
  return false;
}

setInterval(() => {
  mountWidget();
  if (!autoRun || !currentEndpoint || isExecuting) return;
  if (isAssistantStreaming()) return;

  const found = scanAllPageForGottaObjects();
  if (found.length === 0) return;

  // Ejecutar cualquier comando nuevo que no haya sido ejecutado aún en esta sesión
  const last = found[found.length - 1];
  if (!executedHashes.has(last.raw)) {
    // Marcar los anteriores como vistos para ejecutar solo el último turno pendiente
    found.forEach((item) => executedHashes.add(item.raw));
    executeGottaPayload(last.el, last.parsed, last.raw);
  }
}, 900);
