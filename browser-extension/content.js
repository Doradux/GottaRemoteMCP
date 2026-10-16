const INITIAL_PROMPT = `Actúa como @remote desktop commander conectado a mi ordenador mediante GottaRemoteMCP.
IMPORTANTE: No uses tu navegador web integrado ni curl desde tu sandbox. Mi navegador tiene activo el puente automático GottaRemoteMCP que lee tus bloques de código y los ejecuta en mi PC.

Cada vez que quieras ejecutar un comando en terminal, leer/escribir/editar un archivo, listar directorios o controlar el escritorio, responde con un bloque de código JSON que contenga la clave "action". Mi puente lo ejecutará automáticamente en mi PC y te pegará la salida en el siguiente mensaje.

Formato de objetos JSON soportados:
- Ejecutar comando bash (mantiene cwd): {"action": "exec", "cmd": "COMANDO_A_EJECUTAR"}
- Leer archivo: {"action": "read", "path": "RUTA", "start": 1, "end": 150}
- Escribir archivo: {"action": "write", "path": "RUTA", "content": "CONTENIDO"}
- Editar bloque exacto: {"action": "edit", "path": "RUTA", "search": "BUSCAR", "replace": "REEMPLAZAR"}
- Listar directorio: {"action": "ls", "path": "."}
- Buscar código: {"action": "search", "q": "PATRON", "path": "."}
- Sesiones/Procesos: {"action": "sessions"} | {"action": "session-output", "pid": 123} | {"action": "kill", "pid": 123}
- Escritorio (ratón/teclado): {"action": "input", "type": "click", "x": 500, "y": 300}

Para verificar la conexión ahora mismo, responde únicamente con un bloque de código JSON que ejecute el comando: pwd && whoami && uname -a`;

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

let currentEndpoint = "";
let autoRun = true;
const executedBlocks = new WeakSet();
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
    document.querySelector('button.send-button') ||
    document.querySelector('button[aria-label*="Send"]') ||
    document.querySelector('button[aria-label*="Enviar"]')
  );
}

function sendTextToChat(text) {
  try {
    navigator.clipboard.writeText(text).catch(() => {});
  } catch {}

  const editor = findChatEditor();
  if (!editor) {
    setLog("⚠️ No se encontró la caja de texto del chat. Texto copiado al portapapeles (haz Ctrl+V).", "#fbbf24");
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
    // ProseMirror (ChatGPT) y Quill (Gemini) responden de forma nativa a Paste con DataTransfer o execCommand
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);

    let inserted = false;
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      editor.dispatchEvent(pasteEvent);
      if ((editor.textContent || "").trim().length > 5) {
        inserted = true;
      }
    } catch {}

    if (!inserted) {
      document.execCommand("insertText", false, text);
    }
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  }

  setTimeout(() => {
    const btn = findSendButton();
    if (btn && !btn.disabled) {
      btn.click();
      setLog("✅ Enviado al chat. Esperando respuesta de la IA...", "#10b981");
    } else {
      // Fallback: simular pulsación de Enter en el editor
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      );
      setLog("✅ Texto insertado en el chat (si no se envió solo, pulsa Enter).", "#10b981");
    }
  }, 400);

  return true;
}

function markExistingBlocksAsSeen() {
  const blocks = document.querySelectorAll("pre code");
  blocks.forEach((b, i) => {
    executedBlocks.add(b);
    const t = (b.textContent || "").trim();
    if (t) executedHashes.add(t + "_" + i);
  });
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

function mountWidget() {
  if (document.getElementById("gotta-remote-ext-widget")) return;
  const box = document.createElement("div");
  box.id = "gotta-remote-ext-widget";
  box.style.cssText =
    "position:fixed;bottom:18px;right:18px;z-index:999999;background:#111827;color:#f9fafb;padding:12px 14px;border-radius:12px;border:1px solid #10b981;font-family:system-ui,sans-serif;font-size:12px;box-shadow:0 10px 25px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:8px;width:310px;";
  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <span style="font-weight:700;color:#10b981;">🟢 GottaRemoteMCP Bridge</span>
      <label style="cursor:pointer;display:flex;align-items:center;gap:4px;font-size:11px;">
        <input type="checkbox" id="gotta-ext-autorun" checked /> Auto-Run
      </label>
    </div>
    <div style="display:flex;gap:6px;">
      <input id="gotta-ep-input" type="text" placeholder="http://localhost:3000/c/user/pass" style="background:#1f2937;color:#fff;border:1px solid #374151;border-radius:6px;padding:5px 8px;font-size:11px;flex:1;min-width:0;" />
      <button id="gotta-ext-ping-btn" title="Probar conexión con tu PC" style="background:#374151;color:#f9fafb;border:none;border-radius:6px;padding:5px 8px;font-size:11px;cursor:pointer;white-space:nowrap;">
        🔍 Probar
      </button>
    </div>
    <div id="gotta-ext-status-log" style="background:#030712;border:1px solid #1f2937;border-radius:6px;padding:6px 8px;font-size:11px;color:#9ca3af;min-height:16px;line-height:1.35;word-break:break-word;">
      ⚪ Listo para conectar
    </div>
    <button id="gotta-ext-init-btn" style="background:#10b981;color:#06281e;border:none;border-radius:6px;padding:8px 10px;font-weight:700;cursor:pointer;">
      🚀 Conectar este Chat con mi PC
    </button>
  `;
  document.body.appendChild(box);

  const epInput = document.getElementById("gotta-ep-input");
  epInput.value = currentEndpoint;
  epInput.addEventListener("input", (e) => {
    currentEndpoint = e.target.value.trim().replace(/\?.*$/, "").replace(/\/+$/, "");
    chrome.storage.local.set({ gottaEndpoint: currentEndpoint });
  });

  document.getElementById("gotta-ext-autorun").addEventListener("change", (e) => {
    autoRun = e.target.checked;
  });

  document.getElementById("gotta-ext-ping-btn").addEventListener("click", () => {
    pingServer();
  });

  document.getElementById("gotta-ext-init-btn").addEventListener("click", () => {
    markExistingBlocksAsSeen();
    pingServer((ok) => {
      if (!ok) return;
      setLog("📨 Insertando prompt en el chat...", "#60a5fa");
      sendTextToChat(INITIAL_PROMPT);
    });
  });

  // Auto-descubrir o verificar al montar el widget
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

function isInsideUserMessage(el) {
  return Boolean(
    el.closest('[data-message-author-role="user"]') ||
      el.closest(".user-query") ||
      el.closest("user-query")
  );
}

function executeBlockAndReply(block, parsed) {
  const summary = parsed.cmd || parsed.command || parsed.path || parsed.q || parsed.action;
  setLog(`⚡ Ejecutando en PC: ${summary}...`, "#fbbf24");

  chrome.runtime.sendMessage(
    { type: "GOTTA_EXEC", endpoint: currentEndpoint, payload: parsed },
    (resp) => {
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

      // Añadir insignia visual debajo del bloque de código en el chat
      const pre = block.closest("pre");
      if (pre && !pre.parentElement.querySelector(".gotta-exec-badge")) {
        const badge = document.createElement("div");
        badge.className = "gotta-exec-badge";
        badge.style.cssText =
          "background:#064e3b;color:#a7f3d0;font-size:11px;padding:4px 8px;border-radius:6px;margin-top:4px;display:inline-block;font-family:monospace;";
        badge.textContent = `✅ Ejecutado en tu PC por GottaRemoteMCP (${parsed.action}: ${summary || "ok"})`;
        pre.parentElement.appendChild(badge);
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

setInterval(() => {
  mountWidget();
  if (!autoRun || !currentEndpoint) return;

  const isGenerating = document.querySelector(
    '[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Detener"], .result-streaming'
  );
  if (isGenerating) return;

  const codeBlocks = Array.from(document.querySelectorAll("pre code"));
  for (let i = 0; i < codeBlocks.length; i++) {
    const block = codeBlocks[i];
    if (executedBlocks.has(block)) continue;
    if (isInsideUserMessage(block)) {
      executedBlocks.add(block);
      continue;
    }

    const text = (block.textContent || "").trim();
    if (!text.startsWith("{") || !text.endsWith("}")) continue;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object" || !VALID_ACTIONS.has(parsed.action)) {
      continue;
    }

    const hash = text + "_" + i;
    if (executedHashes.has(hash)) {
      executedBlocks.add(block);
      continue;
    }

    executedBlocks.add(block);
    executedHashes.add(hash);
    executeBlockAndReply(block, parsed);
  }
}, 1200);
