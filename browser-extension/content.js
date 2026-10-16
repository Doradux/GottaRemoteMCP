const COMPACT_MCP_CONTEXT = `[GottaRemoteMCP Sistema Activo en mi PC]
Tienes control directo de mi ordenador mediante el puente de mi navegador.
- NO uses tu navegador web integrado ni curl desde tu sandbox.
- Para ejecutar cualquier acción en mi PC, responde ÚNICAMENTE con un bloque de código \`\`\`gotta que contenga un JSON válido:
  • Comando bash (mantiene cwd): {"action":"exec","cmd":"..."}
  • Leer archivo: {"action":"read","path":"...","start":1,"end":150}
  • Escribir archivo: {"action":"write","path":"...","content":"..."}
  • Editar bloque: {"action":"edit","path":"...","search":"...","replace":"..."}
  • Listar carpeta: {"action":"ls","path":"."}
  • Buscar código: {"action":"search","q":"...","path":"."}
  • Ratón/Teclado: {"action":"input","type":"click","x":500,"y":300}
- Mi navegador ejecutará tu JSON en mi PC y te devolverá "[GottaRemoteMCP Output]" automáticamente en el siguiente mensaje.
- MUY IMPORTANTE: Cuando recibas el "[GottaRemoteMCP Output]" y ya tengas la información o hayas completado la acción, escribe SIEMPRE tus conclusiones, análisis y respuesta final en lenguaje natural directamente aquí en el chat para mí (sin añadir más bloques JSON).`;

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

const IGNORED_PLACEHOLDERS = new Set([
  "...",
  "pwd && ls -la",
  "COMANDO_A_EJECUTAR",
  "RUTA",
  "/ruta/archivo",
]);

let currentEndpoint = "";
let autoRun = true;
let isMinimized = false;
let isExecuting = false;
let isInternalSend = false;
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

function isValidGottaCommand(parsed) {
  if (!parsed || typeof parsed !== "object" || !VALID_ACTIONS.has(parsed.action)) {
    return false;
  }
  if (parsed.action === "exec") {
    const cmd = String(parsed.cmd || parsed.command || "").trim();
    if (!cmd || IGNORED_PLACEHOLDERS.has(cmd)) return false;
  }
  if (parsed.action === "read" || parsed.action === "write" || parsed.action === "edit") {
    const p = String(parsed.path || "").trim();
    if (!p || IGNORED_PLACEHOLDERS.has(p)) return false;
  }
  return true;
}

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
                if (isValidGottaCommand(parsed)) {
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
    if (!article.querySelector('[data-message-author-role="assistant"]')) {
      return true;
    }
  }
  return false;
}

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

/**
 * Localiza el botón azul de enviar (↑) tanto por selectores directos como buscando
 * el último botón activo dentro del contenedor del compositor de ChatGPT/Gemini.
 */
function findSendButton(editorEl) {
  const directSelectors = [
    "#composer-submit-button",
    '[data-testid="send-button"]',
    '[data-testid="composer-send-button"]',
    '[data-testid="fruitjuice-send-button"]',
    "button.send-button",
    'button[aria-label="Send prompt"]',
    'button[aria-label="Enviar prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Enviar mensaje"]',
    'button[aria-label*="Send" i]:not([aria-label*="Stop" i])',
    'button[aria-label*="Enviar" i]',
  ];

  for (const sel of directSelectors) {
    const btn = document.querySelector(sel);
    if (btn && btn.offsetParent !== null && !btn.disabled) {
      return btn;
    }
  }

  // Fallback estructural: subir desde #prompt-textarea hasta encontrar la barra inferior de botones del compositor
  const editor = editorEl || findChatEditor();
  if (editor) {
    let parent = editor.parentElement;
    for (let depth = 0; depth < 7 && parent; depth++) {
      const buttons = Array.from(parent.querySelectorAll("button")).filter(
        (b) => b.offsetParent !== null && !b.disabled
      );
      if (buttons.length >= 2) {
        // El botón de envío (↑) en ChatGPT/Gemini siempre es el último botón a la derecha del compositor
        const lastBtn = buttons[buttons.length - 1];
        const label = (
          (lastBtn.getAttribute("aria-label") || "") +
          " " +
          (lastBtn.getAttribute("data-testid") || "")
        ).toLowerCase();
        if (!label.includes("voice") && !label.includes("voz") && !label.includes("speech")) {
          return lastBtn;
        }
      }
      parent = parent.parentElement;
    }
  }

  return null;
}

function triggerFullClick(btn) {
  const opts = { bubbles: true, cancelable: true, view: window };
  btn.dispatchEvent(new PointerEvent("pointerdown", opts));
  btn.dispatchEvent(new MouseEvent("mousedown", opts));
  btn.dispatchEvent(new PointerEvent("pointerup", opts));
  btn.dispatchEvent(new MouseEvent("mouseup", opts));
  btn.click();
  const form = btn.closest("form");
  if (form && typeof form.requestSubmit === "function") {
    try {
      form.requestSubmit(btn);
    } catch {}
  }
}

function getEditorText(editor) {
  if (!editor) return "";
  if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
    return (editor.value || "").trim();
  }
  return (editor.innerText || editor.textContent || "").trim();
}

function sendTextToChat(text) {
  isInternalSend = true;
  try {
    navigator.clipboard.writeText(text).catch(() => {});
  } catch {}

  const editor = findChatEditor();
  if (!editor) {
    isInternalSend = false;
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

  // Reintentar clic en el botón azul (↑) hasta que la caja de texto quede vacía (confirmación real de envío)
  let attempts = 0;
  const tryClickSend = () => {
    attempts++;
    const currentEditor = findChatEditor() || editor;
    const remaining = getEditorText(currentEditor);

    if (!remaining) {
      isInternalSend = false;
      setLog("✅ Salida enviada al chat. Esperando conclusiones de la IA...", "#10b981");
      return;
    }

    const btn = findSendButton(currentEditor);
    if (btn) {
      triggerFullClick(btn);
    } else {
      currentEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      );
    }

    if (attempts < 10) {
      setTimeout(tryClickSend, 300);
    } else {
      isInternalSend = false;
      setLog("⚠️ Texto listo en la caja: pulsa el botón azul (↑) para enviar.", "#fbbf24");
    }
  };

  setTimeout(tryClickSend, 250);
  return true;
}

function chatAlreadyHasMcpContext() {
  const userMsgs = Array.from(
    document.querySelectorAll('[data-message-author-role="user"], .user-query, user-query')
  );
  for (const m of userMsgs) {
    const t = m.textContent || "";
    if (t.includes("GottaRemoteMCP") || t.includes("```gotta")) {
      return true;
    }
  }
  return false;
}

function setupTransparentAutoContext() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (isInternalSend || !autoRun || !currentEndpoint) return;
      if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) {
        return;
      }
      const editor = findChatEditor();
      if (!editor || (!editor.contains(e.target) && e.target !== editor)) return;

      const userText = getEditorText(editor);
      if (!userText || userText.includes("GottaRemoteMCP")) return;
      if (chatAlreadyHasMcpContext()) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      const existing = scanAllPageForGottaObjects();
      existing.forEach((item) => executedHashes.add(item.raw));

      setLog("🚀 Conectando tu mensaje con GottaRemoteMCP...", "#60a5fa");
      sendTextToChat(`${userText}\n\n${COMPACT_MCP_CONTEXT}`);
    },
    true
  );

  window.addEventListener(
    "mousedown",
    (e) => {
      if (isInternalSend || !autoRun || !currentEndpoint) return;
      const editor = findChatEditor();
      const sendBtn = findSendButton(editor);
      if (!sendBtn || (!sendBtn.contains(e.target) && e.target !== sendBtn)) return;

      const userText = getEditorText(editor);
      if (!userText || userText.includes("GottaRemoteMCP")) return;
      if (chatAlreadyHasMcpContext()) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      const existing = scanAllPageForGottaObjects();
      existing.forEach((item) => executedHashes.add(item.raw));

      setLog("🚀 Conectando tu mensaje con GottaRemoteMCP...", "#60a5fa");
      sendTextToChat(`${userText}\n\n${COMPACT_MCP_CONTEXT}`);
    },
    true
  );
}

function getCleanElementText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll(".gotta-exec-badge").forEach((b) => b.remove());
  return (clone.textContent || "").trim();
}

function pingServer(callback) {
  setLog("🔄 Conectando con tu PC...", "#60a5fa");
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
      setLog(`✅ Listo en ${host} (${cwd}) — Solo escribe en el chat`, "#10b981");
      if (callback) callback(true);
    }
  );
}

function executeGottaPayload(targetEl, parsed) {
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
        sendTextToChat(
          `[GottaRemoteMCP Error]\n${errMsg}\n\nExplica el problema al usuario en el chat o intenta un comando alternativo.`
        );
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
        "\n```\n" +
        "Instrucción: Ya tienes aquí arriba la salida real devuelta por el ordenador del usuario. Si necesitas otro comando para terminar, pon otro bloque ```gotta. Si ya tienes el resultado, NO pongas más bloques JSON y responde directamente al usuario explicándole el resultado y tus conclusiones.";
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
    "position:fixed;top:16px;right:18px;z-index:999999;background:#111827;color:#f9fafb;padding:10px 12px;border-radius:12px;border:1px solid #10b981;font-family:system-ui,sans-serif;font-size:12px;box-shadow:0 10px 25px rgba(0,0,0,0.55);display:flex;flex-direction:column;gap:7px;width:280px;user-select:none;";
  box.innerHTML = `
    <div id="gotta-drag-handle" title="Arrastra desde aquí para mover el cuadro" style="display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:move;padding-bottom:4px;border-bottom:1px solid #1f2937;">
      <span style="font-weight:700;color:#10b981;display:flex;align-items:center;gap:5px;">
        ⠿ 🟢 GottaRemoteMCP
      </span>
      <div style="display:flex;align-items:center;gap:6px;">
        <label style="cursor:pointer;display:flex;align-items:center;gap:3px;font-size:11px;">
          <input type="checkbox" id="gotta-ext-autorun" checked /> Activo
        </label>
        <button id="gotta-ext-min-btn" title="Minimizar / Expandir" style="background:#1f2937;color:#9ca3af;border:none;border-radius:4px;padding:1px 6px;font-size:12px;cursor:pointer;">
          —
        </button>
      </div>
    </div>
    <div id="gotta-ext-body" style="display:flex;flex-direction:column;gap:7px;">
      <div style="display:flex;gap:5px;">
        <input id="gotta-ep-input" type="text" placeholder="http://localhost:3000/c/user/pass" style="background:#1f2937;color:#fff;border:1px solid #374151;border-radius:6px;padding:5px 7px;font-size:11px;flex:1;min-width:0;" />
        <button id="gotta-ext-ping-btn" title="Sincronizar o probar conexión con tu PC" style="background:#374151;color:#f9fafb;border:none;border-radius:6px;padding:5px 7px;font-size:11px;cursor:pointer;white-space:nowrap;">
          🔄 Sync
        </button>
      </div>
      <div id="gotta-ext-status-log" style="background:#030712;border:1px solid #1f2937;border-radius:6px;padding:6px 8px;font-size:11px;color:#9ca3af;min-height:16px;line-height:1.35;word-break:break-word;user-select:text;">
        ⚪ Conectando...
      </div>
      <button id="gotta-ext-runlast-btn" title="Re-ejecutar manualmente el último comando JSON del chat" style="background:#1f2937;color:#d1d5db;border:1px solid #374151;border-radius:6px;padding:5px 8px;font-weight:600;font-size:11px;cursor:pointer;">
        ▶️ Ejecutar último JSON del chat
      </button>
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
    setLog(
      autoRun
        ? "✅ Puente activo — Escribe directamente en el chat"
        : "⏸️ Puente en pausa",
      autoRun ? "#10b981" : "#9ca3af"
    );
  });

  document.getElementById("gotta-ext-min-btn").addEventListener("click", () => {
    isMinimized = !isMinimized;
    const bodyEl = document.getElementById("gotta-ext-body");
    const minBtn = document.getElementById("gotta-ext-min-btn");
    if (isMinimized) {
      bodyEl.style.display = "none";
      box.style.width = "185px";
      minBtn.textContent = "+";
    } else {
      bodyEl.style.display = "flex";
      box.style.width = "280px";
      minBtn.textContent = "—";
    }
  });

  document.getElementById("gotta-ext-ping-btn").addEventListener("click", () => {
    pingServer();
  });

  document.getElementById("gotta-ext-runlast-btn").addEventListener("click", () => {
    const found = scanAllPageForGottaObjects();
    if (found.length > 0) {
      const last = found[found.length - 1];
      executedHashes.add(last.raw);
      executeGottaPayload(last.el, last.parsed);
      return;
    }
    setLog("⚠️ No se encontró ningún comando JSON en la página.", "#fbbf24");
  });

  const initialFound = scanAllPageForGottaObjects();
  initialFound.forEach((item) => executedHashes.add(item.raw));

  setTimeout(() => pingServer(), 300);
}

setupTransparentAutoContext();

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

  const last = found[found.length - 1];
  if (!executedHashes.has(last.raw)) {
    found.forEach((item) => executedHashes.add(item.raw));
    executeGottaPayload(last.el, last.parsed);
  }
}, 800);
