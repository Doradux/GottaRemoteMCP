const INITIAL_PROMPT = `Actúa como @remote desktop commander conectado a mi ordenador mediante GottaRemoteMCP.
IMPORTANTE: No intentes usar tu navegador web integrado ni curl desde tu sandbox, ya que tu entorno bloquea conexiones externas.
En su lugar, mi navegador tiene activo el puente automático GottaRemoteMCP que lee tus respuestas.

Cada vez que quieras ejecutar un comando, leer/escribir/editar un archivo, buscar código o controlar el escritorio, incluye en tu respuesta un bloque de código con el lenguaje \`\`\`gotta y un JSON válido dentro. Mi puente lo ejecutará automáticamente en mi PC y te enviará la salida en el siguiente mensaje.

Acciones soportadas dentro de \`\`\`gotta:
- Ejecutar comando bash (mantiene cwd): {"action": "exec", "cmd": "pwd && ls -la"}
- Leer archivo: {"action": "read", "path": "/ruta/archivo", "start": 1, "end": 150}
- Escribir archivo: {"action": "write", "path": "/ruta/archivo", "content": "contenido..."}
- Editar bloque exacto: {"action": "edit", "path": "/ruta/archivo", "search": "viejo", "replace": "nuevo"}
- Listar directorio: {"action": "ls", "path": "."}
- Buscar código: {"action": "search", "q": "patron", "path": "."}
- Sesiones/Procesos: {"action": "sessions"} | {"action": "session-output", "pid": 123} | {"action": "kill", "pid": 123}
- Escritorio (ratón/teclado): {"action": "input", "type": "click", "x": 500, "y": 300}

Empecemos: responde ahora únicamente con un bloque \`\`\`gotta ejecutando "pwd && whoami && uname -a" para confirmar que tienes control del sistema.`;

let currentEndpoint = "";
let autoRun = true;
const executedHashes = new Set();

chrome.storage.local.get(["gottaEndpoint"], (res) => {
  if (res.gottaEndpoint) {
    currentEndpoint = res.gottaEndpoint;
    updateWidgetLabel();
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.gottaEndpoint) {
    currentEndpoint = changes.gottaEndpoint.newValue || "";
    updateWidgetLabel();
  }
});

function sendTextToChat(text) {
  const chatgptBox = document.querySelector("#prompt-textarea");
  if (chatgptBox) {
    chatgptBox.focus();
    if (chatgptBox.tagName === "TEXTAREA") {
      chatgptBox.value = text;
      chatgptBox.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      chatgptBox.innerHTML =
        "<p>" +
        text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/\n/g, "<br>") +
        "</p>";
      chatgptBox.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })
      );
    }
    setTimeout(() => {
      const sendBtn = document.querySelector(
        '[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="Enviar"]'
      );
      if (sendBtn && !sendBtn.disabled) sendBtn.click();
    }, 300);
    return;
  }

  const geminiBox = document.querySelector(
    '.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"]'
  );
  if (geminiBox) {
    geminiBox.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
    geminiBox.dispatchEvent(new Event("input", { bubbles: true }));
    setTimeout(() => {
      const sendBtn = document.querySelector(
        'button.send-button, button[aria-label*="Send"], button[aria-label*="Enviar"]'
      );
      if (sendBtn) sendBtn.click();
    }, 300);
  }
}

function updateWidgetLabel() {
  const epEl = document.getElementById("gotta-ep-input");
  if (epEl && document.activeElement !== epEl) {
    epEl.value = currentEndpoint;
  }
}

function mountWidget() {
  if (document.getElementById("gotta-remote-ext-widget")) return;
  const box = document.createElement("div");
  box.id = "gotta-remote-ext-widget";
  box.style.cssText =
    "position:fixed;bottom:18px;right:18px;z-index:999999;background:#111827;color:#f9fafb;padding:12px 14px;border-radius:12px;border:1px solid #10b981;font-family:system-ui,sans-serif;font-size:12px;box-shadow:0 10px 25px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:8px;width:290px;";
  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <span style="font-weight:700;color:#10b981;">🟢 GottaRemoteMCP Bridge</span>
      <label style="cursor:pointer;display:flex;align-items:center;gap:4px;">
        <input type="checkbox" id="gotta-ext-autorun" checked /> Auto
      </label>
    </div>
    <input id="gotta-ep-input" type="text" placeholder="Pega aquí la URL /c/user/pass de bash" style="background:#1f2937;color:#fff;border:1px solid #374151;border-radius:6px;padding:5px 8px;font-size:11px;width:100%;box-sizing:border-box;" />
    <button id="gotta-ext-init-btn" style="background:#10b981;color:#06281e;border:none;border-radius:6px;padding:7px 10px;font-weight:700;cursor:pointer;">
      🚀 Conectar este Chat con mi PC
    </button>
  `;
  document.body.appendChild(box);

  const epInput = document.getElementById("gotta-ep-input");
  epInput.value = currentEndpoint;
  epInput.addEventListener("input", (e) => {
    currentEndpoint = e.target.value.trim().replace(/\/+$/, "");
    chrome.storage.local.set({ gottaEndpoint: currentEndpoint });
  });

  document.getElementById("gotta-ext-autorun").addEventListener("change", (e) => {
    autoRun = e.target.checked;
  });

  document.getElementById("gotta-ext-init-btn").addEventListener("click", () => {
    if (!currentEndpoint) {
      alert("Pega primero la URL de Control generada en tu terminal bash (ej. http://localhost:3000/c/cmd_.../gotta_...)");
      return;
    }
    sendTextToChat(INITIAL_PROMPT);
  });
}

setInterval(() => {
  mountWidget();
  if (!autoRun || !currentEndpoint) return;

  const isGenerating = document.querySelector(
    '[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Detener"]'
  );
  if (isGenerating) return;

  const codeBlocks = Array.from(document.querySelectorAll("pre code"));
  for (const block of codeBlocks) {
    const cls = (block.className || "") + " " + (block.parentElement?.className || "");
    const text = (block.textContent || "").trim();
    const isGotta =
      cls.includes("language-gotta") ||
      (text.startsWith("{") &&
        text.includes('"action"') &&
        (text.includes('"cmd"') || text.includes('"path"') || text.includes('"sessions"')));
    if (!isGotta) continue;

    const hash = text + "_" + codeBlocks.indexOf(block);
    if (executedHashes.has(hash)) continue;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }

    executedHashes.add(hash);
    chrome.runtime.sendMessage(
      { type: "GOTTA_EXEC", endpoint: currentEndpoint, payload: parsed },
      (resp) => {
        if (!resp || !resp.ok) {
          sendTextToChat("[GottaRemoteMCP Error] " + (resp?.error || "Error de conexión"));
          return;
        }
        const reply =
          "[GottaRemoteMCP Output]\n```json\n" +
          JSON.stringify(resp.data, null, 2).slice(0, 12000) +
          "\n```";
        sendTextToChat(reply);
      }
    );
  }
}, 1500);
