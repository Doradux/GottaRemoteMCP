import express from "express";

export const GOTTA_CHAT_SYSTEM_PROMPT = `Actúa como @remote desktop commander conectado a mi ordenador mediante GottaRemoteMCP.
IMPORTANTE: No intentes usar tu navegador web integrado ni curl desde tu sandbox, ya que tu entorno bloquea conexiones externas.
En su lugar, mi navegador tiene activo el puente automático GottaRemoteMCP que lee tus respuestas.

Cada vez que quieras ejecutar un comando, leer/escribir/editar un archivo, buscar código o controlar el escritorio, incluye en tu respuesta un bloque de código con el lenguaje \`\`\`gotta y un JSON válido dentro. Mi puente lo ejecutará automáticamente en mi PC y te enviará la salida en el siguiente mensaje.
Cuando recibas el "[GottaRemoteMCP Output]" y ya tengas la información o hayas completado la tarea, escribe SIEMPRE tus conclusiones, análisis y respuesta final directamente en el chat (sin añadir más bloques JSON).`;

export function registerUserscriptBridge(
  app: express.Application,
  getCredentials: () => { user: string; pass: string; getBaseUrl: (req: express.Request) => string }
) {
  // Userscript para Tampermonkey/Violentmonkey (usa GM_xmlhttpRequest para saltar la CSP de chatgpt.com y gemini.google.com)
  app.get("/c/:user/:pass/gotta.user.js", (req, res) => {
    const { user, pass, getBaseUrl } = getCredentials();
    if (req.params.user !== user || req.params.pass !== pass) {
      return res.status(401).send("// Unauthorized");
    }
    const endpointBase = `${getBaseUrl(req)}/c/${user}/${pass}`;

    const script = `// ==UserScript==
// @name         GottaRemoteMCP Bridge (ChatGPT & Gemini Normal Chat)
// @namespace    https://github.com/Doradux/GottaRemoteMCP
// @version      0.4.0
// @description  Conecta cualquier chat normal de ChatGPT o Gemini con tu PC (sin API keys, saltando CSP y bloqueos de red)
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://gemini.google.com/*
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function() {
  'use strict';
  const ENDPOINT = ${JSON.stringify(endpointBase)};
  const INITIAL_PROMPT = ${JSON.stringify(GOTTA_CHAT_SYSTEM_PROMPT)};
  let autoRun = true;
  const executedHashes = new Set();

  function gmRequest(method, url, bodyObj) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        data: bodyObj ? JSON.stringify(bodyObj) : undefined,
        onload: (resp) => {
          try {
            resolve(JSON.parse(resp.responseText));
          } catch (e) {
            resolve({ raw: resp.responseText });
          }
        },
        onerror: (err) => reject(err)
      });
    });
  }

  async function executeGottaCommand(payload) {
    const act = payload.action || "exec";
    const t = Date.now();
    if (act === "exec") {
      return await gmRequest("POST", ENDPOINT + "/exec?format=json&_t=" + t, {
        command: payload.cmd || payload.command,
        cwd: payload.cwd,
        timeout: payload.timeout
      });
    }
    if (act === "read") {
      const p = encodeURIComponent(payload.path || "");
      const s = payload.start ? "&start=" + payload.start : "";
      const e = payload.end ? "&end=" + payload.end : "";
      return await gmRequest("GET", ENDPOINT + "/read?format=json&path=" + p + s + e + "&_t=" + t);
    }
    if (act === "write") {
      return await gmRequest("POST", ENDPOINT + "/write?format=json&_t=" + t, {
        path: payload.path,
        content: payload.content,
        append: payload.append
      });
    }
    if (act === "edit") {
      return await gmRequest("POST", ENDPOINT + "/edit?format=json&_t=" + t, {
        path: payload.path,
        search: payload.search,
        replace: payload.replace
      });
    }
    if (act === "ls") {
      return await gmRequest("GET", ENDPOINT + "/ls?format=json&path=" + encodeURIComponent(payload.path || ".") + "&_t=" + t);
    }
    if (act === "search") {
      return await gmRequest("GET", ENDPOINT + "/search?format=json&q=" + encodeURIComponent(payload.q || "") + "&path=" + encodeURIComponent(payload.path || ".") + "&_t=" + t);
    }
    if (act === "sessions") {
      return await gmRequest("GET", ENDPOINT + "/sessions?format=json&_t=" + t);
    }
    if (act === "session-output") {
      return await gmRequest("GET", ENDPOINT + "/session-output?format=json&pid=" + encodeURIComponent(payload.pid) + "&_t=" + t);
    }
    if (act === "kill") {
      return await gmRequest("GET", ENDPOINT + "/kill?format=json&pid=" + encodeURIComponent(payload.pid) + "&_t=" + t);
    }
    if (act === "input") {
      const q = new URLSearchParams({ ...payload, action: payload.type || payload.action || "click", format: "json", _t: String(t) }).toString();
      return await gmRequest("GET", ENDPOINT + "/input?" + q);
    }
    return await gmRequest("GET", ENDPOINT + "?format=json&_t=" + t);
  }

  function sendTextToChat(text) {
    // Soporte ChatGPT (#prompt-textarea) y Gemini (.ql-editor / rich-textarea)
    const chatgptBox = document.querySelector('#prompt-textarea');
    if (chatgptBox) {
      chatgptBox.focus();
      if (chatgptBox.tagName === 'TEXTAREA') {
        chatgptBox.value = text;
        chatgptBox.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        chatgptBox.innerHTML = '<p>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\\n/g, '<br>') + '</p>';
        chatgptBox.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
      setTimeout(() => {
        const sendBtn = document.querySelector('[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="Enviar"]');
        if (sendBtn && !sendBtn.disabled) sendBtn.click();
      }, 300);
      return;
    }

    const geminiBox = document.querySelector('.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"]');
    if (geminiBox) {
      geminiBox.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      geminiBox.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => {
        const sendBtn = document.querySelector('button.send-button, button[aria-label*="Send"], button[aria-label*="Enviar"]');
        if (sendBtn) sendBtn.click();
      }, 300);
    }
  }

  function mountWidget() {
    if (document.getElementById('gotta-remote-widget')) return;
    const box = document.createElement('div');
    box.id = 'gotta-remote-widget';
    box.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:999999;background:#111827;color:#f9fafb;padding:12px 14px;border-radius:12px;border:1px solid #10b981;font-family:system-ui,sans-serif;font-size:12px;box-shadow:0 10px 25px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:8px;max-width:280px;';
    box.innerHTML = \`
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <span style="font-weight:700;color:#10b981;">🟢 GottaRemoteMCP Activo</span>
        <label style="cursor:pointer;display:flex;align-items:center;gap:4px;">
          <input type="checkbox" id="gotta-autorun" checked /> Auto
        </label>
      </div>
      <div style="font-size:11px;color:#9ca3af;word-break:break-all;">\${ENDPOINT}</div>
      <button id="gotta-init-btn" style="background:#10b981;color:#06281e;border:none;border-radius:6px;padding:6px 10px;font-weight:700;cursor:pointer;">
        🚀 Conectar este Chat con mi PC
      </button>
    \`;
    document.body.appendChild(box);
    document.getElementById('gotta-autorun').addEventListener('change', (e) => {
      autoRun = e.target.checked;
    });
    document.getElementById('gotta-init-btn').addEventListener('click', () => {
      sendTextToChat(INITIAL_PROMPT);
    });
  }

  setInterval(async () => {
    mountWidget();
    if (!autoRun) return;
    // Esperar a que el modelo termine de generar (no haya botón de Stop visible)
    const isGenerating = document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Detener"]');
    if (isGenerating) return;

    const codeBlocks = Array.from(document.querySelectorAll('pre code'));
    for (const block of codeBlocks) {
      const cls = (block.className || '') + ' ' + (block.parentElement?.className || '');
      const text = (block.textContent || '').trim();
      const isGotta = cls.includes('language-gotta') || (text.startsWith('{') && text.includes('"action"') && (text.includes('"cmd"') || text.includes('"path"') || text.includes('"sessions"')));
      if (!isGotta) continue;

      const hash = text + '_' + codeBlocks.indexOf(block);
      if (executedHashes.has(hash)) continue;

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }

      executedHashes.add(hash);
      try {
        const res = await executeGottaCommand(parsed);
        const reply = "[GottaRemoteMCP Output]\\n\`\`\`json\\n" + JSON.stringify(res, null, 2).slice(0, 12000) + "\\n\`\`\`";
        sendTextToChat(reply);
      } catch (err) {
        sendTextToChat("[GottaRemoteMCP Error] " + String(err));
      }
    }
  }, 1500);
})();
`;
    res.type("application/javascript; charset=utf-8").send(script);
  });
}
