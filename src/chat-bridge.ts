import express from "express";
import path from "path";
import fs from "fs/promises";
import {
  editFileBlock,
  executeCommander,
  getCurrentCwd,
  getSessionOutput,
  listActiveSessions,
  readFileLines,
  searchInCode,
  terminateProcessOrSession,
} from "./commander.js";
import { captureScreenBase64, performDesktopInput } from "./desktop.js";
import { listProcesses, listRemoteOrLocalDirectory, writeRemoteOrLocalFile } from "./files.js";
import { GOTTA_CHAT_SYSTEM_PROMPT } from "./browser-bridge.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderBotHtmlPage(title: string, bodyText: string, baseUrl: string, extraHtml = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="robots" content="index,follow,noarchive" />
  <title>${escapeHtml(title)} - GottaRemoteMCP Commander</title>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p><strong>Current Working Directory (CWD):</strong> <code>${escapeHtml(getCurrentCwd())}</code></p>
  <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
  <hr />
  <pre id="commander-output">${escapeHtml(bodyText)}</pre>
  ${extraHtml}
  <hr />
  <p>Quick Commander Endpoints (append <code>&amp;_t=${Date.now()}</code> to avoid cache):</p>
  <ul>
    <li>Execute command: <code>${escapeHtml(baseUrl)}/exec?cmd=YOUR_URL_ENCODED_COMMAND</code> (or <code>?b64=BASE64_CMD</code>)</li>
    <li>List directory: <code>${escapeHtml(baseUrl)}/ls?path=.</code></li>
    <li>Read file: <code>${escapeHtml(baseUrl)}/read?path=FILE_PATH&amp;start=1&amp;end=200</code></li>
    <li>Write file: <code>${escapeHtml(baseUrl)}/write?path=FILE_PATH&amp;content=URL_ENCODED_TEXT</code> (or <code>?path=...&amp;b64=BASE64_CONTENT</code>)</li>
    <li>Surgical edit: <code>${escapeHtml(baseUrl)}/edit?path=FILE_PATH&amp;search=OLD_TEXT&amp;replace=NEW_TEXT</code></li>
    <li>Search code: <code>${escapeHtml(baseUrl)}/search?q=PATTERN&amp;path=.</code></li>
    <li>Mouse/Keyboard: <code>${escapeHtml(baseUrl)}/input?action=click&amp;x=500&amp;y=300</code></li>
    <li>View screen: <code>${escapeHtml(baseUrl)}/screen</code></li>
    <li>Active background sessions: <code>${escapeHtml(baseUrl)}/sessions</code></li>
  </ul>
</body>
</html>`;
}

export function buildChatPromptBlock(
  publicOrLocalUrl: string,
  localUrl: string,
  user: string,
  pass: string
): string {
  const publicBase = `${publicOrLocalUrl}/c/${user}/${pass}`;
  const localBase = `${localUrl}/c/${user}/${pass}`;
  return `
================================================================================
  CREDENCIALES GENERADAS (MODO SIN API - CHATGPT / GEMINI / AGENTES)
================================================================================
  Usuario         : ${user}
  Password/Key    : ${pass}
  Endpoint Local  : ${localBase}
  Endpoint Tunel  : ${publicBase}
  Userscript URL  : ${localBase}/gotta.user.js
--------------------------------------------------------------------------------
  COMO CONECTAR UN CHAT NORMAL DE CHATGPT O GEMINI (SALTANDO SU BLOQUEO DE RED):
  (ChatGPT bloquea en su servidor salida DNS/curl y dominios trycloudflare.com.
   Por eso incluimos el Puente de Navegador que ejecuta las órdenes desde tu
   propio navegador sin API keys y sin que OpenAI pueda bloquearlo):

  1. En Chrome/Brave/Edge abre: chrome://extensions
  2. Activa "Modo de desarrollador" -> "Cargar descomprimida" y selecciona:
     /home/marcos/GottaRemoteMCP/browser-extension
     (O si usas Tampermonkey, abre: ${localBase}/gotta.user.js)
  3. Abre https://chatgpt.com o https://gemini.google.com:
     Verás abajo a la derecha el widget verde "GottaRemoteMCP Bridge".
     Pega ahí la URL de Control:
     ${localBase}   (si el navegador está en este mismo PC)
     o ${publicBase} (si estás en otro dispositivo)
  4. Pulsa el botón verde "🚀 Conectar este Chat con mi PC" (o pega el bloque
     de abajo en el chat).
--------------------------------------------------------------------------------
  PROMPT PARA CHAT NORMAL (CON PUENTE DE NAVEGADOR ACTIVO):
--------------------------------------------------------------------------------
${GOTTA_CHAT_SYSTEM_PROMPT}
================================================================================
`;
}

export function registerNormalChatBridge(
  app: express.Application,
  getCredentials: () => { user: string; pass: string; getBaseUrl: (req: express.Request) => string },
  getSystemStatusFn: () => Promise<Record<string, any>>
) {
  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send(
      `User-agent: ChatGPT-User
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: GPTBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Googlebot
Allow: /

User-agent: *
Allow: /
`
    );
  });

  const router = express.Router({ mergeParams: true });

  router.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const { user, pass } = getCredentials();
    if (req.params.user !== user || req.params.pass !== pass) {
      return res
        .status(401)
        .type("text/html")
        .send("<h1>401 Unauthorized</h1><p>Credenciales de sesión inválidas.</p>");
    }
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    next();
  });

  const sendResponse = (
    req: express.Request,
    res: express.Response,
    title: string,
    payload: Record<string, any>,
    textSummary: string,
    extraHtml = ""
  ) => {
    const { user, pass, getBaseUrl } = getCredentials();
    const fullBase = `${getBaseUrl(req)}/c/${user}/${pass}`;
    if (req.query.format === "json" || req.headers.accept === "application/json") {
      return res.json(payload);
    }
    return res
      .type("text/html; charset=utf-8")
      .send(renderBotHtmlPage(title, textSummary, fullBase, extraHtml));
  };

  router.get("/", async (req, res) => {
    try {
      const status = await getSystemStatusFn();
      const sessions = listActiveSessions();
      const summary = JSON.stringify({ status, cwd: getCurrentCwd(), activeSessions: sessions }, null, 2);
      sendResponse(req, res, "GottaRemoteMCP Connected", { success: true, status, sessions }, summary);
    } catch (err: any) {
      sendResponse(req, res, "Error", { success: false, error: err.message }, err.message);
    }
  });

  const handleExec = async (req: express.Request, res: express.Response) => {
    try {
      const b64 = (req.query.b64 || req.body?.b64) as string | undefined;
      const rawCmd = (req.query.cmd || req.query.q || req.body?.command || req.body?.cmd) as
        | string
        | undefined;
      const command = b64 ? Buffer.from(b64, "base64").toString("utf8") : String(rawCmd || "");
      if (!command) {
        return sendResponse(
          req,
          res,
          "Missing Command",
          { success: false, error: "Falta parámetro ?cmd= o ?b64=" },
          "Error: Pasa ?cmd=COMANDO o ?b64=COMANDO_BASE64"
        );
      }

      const cwd = (req.query.cwd || req.body?.cwd) as string | undefined;
      const timeoutMs =
        req.query.timeout !== undefined
          ? Number(req.query.timeout)
          : req.body?.timeout !== undefined
            ? Number(req.body.timeout)
            : undefined;
      const result = await executeCommander(command, { cwd, timeoutMs });
      const textOut = `$ ${command}\n[Status: ${result.status} | ExitCode: ${result.exitCode ?? "running"} | PID: ${result.pid ?? "-"} | CWD: ${result.cwd}]\n\n${result.output}`;
      sendResponse(req, res, `Command: ${command}`, { success: true, ...result }, textOut);
    } catch (err: any) {
      sendResponse(req, res, "Command Error", { success: false, error: err.message }, err.message);
    }
  };
  router.get("/exec", handleExec);
  router.post("/exec", handleExec);

  router.get("/ls", async (req, res) => {
    try {
      const targetPath = path.resolve(getCurrentCwd(), String(req.query.path || "."));
      const entries = await listRemoteOrLocalDirectory(targetPath);
      const formatted = entries
        .map((e) => `${e.type === "directory" ? "[DIR] " : "[FILE]"} ${e.name} (${e.size} B)`)
        .join("\n");
      sendResponse(
        req,
        res,
        `Directory: ${targetPath}`,
        { success: true, path: targetPath, entries },
        `Path: ${targetPath}\n\n${formatted || "(Directorio vacío)"}`
      );
    } catch (err: any) {
      sendResponse(req, res, "Directory Error", { success: false, error: err.message }, err.message);
    }
  });

  router.get("/read", async (req, res) => {
    try {
      const filePath = String(req.query.path || "");
      const start = req.query.start ? Number(req.query.start) : undefined;
      const end = req.query.end ? Number(req.query.end) : undefined;
      const result = await readFileLines(filePath, start, end);
      sendResponse(
        req,
        res,
        `Read: ${result.path}`,
        { success: true, ...result },
        `File: ${result.path} (Total lines: ${result.totalLines})\n\n${result.content}`
      );
    } catch (err: any) {
      sendResponse(req, res, "Read Error", { success: false, error: err.message }, err.message);
    }
  });

  const handleWrite = async (req: express.Request, res: express.Response) => {
    try {
      const rawPath = String(req.query.path || req.body?.path || "");
      const targetPath = path.resolve(getCurrentCwd(), rawPath);
      const b64 = (req.query.b64 || req.body?.b64) as string | undefined;
      const content = b64
        ? Buffer.from(b64, "base64").toString("utf8")
        : String(req.query.content ?? req.body?.content ?? "");
      const append = req.query.append === "1" || req.body?.append === true;

      if (append) {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.appendFile(targetPath, content, "utf8");
        const msg = `Contenido añadido a ${targetPath} (+${Buffer.byteLength(content)} bytes)`;
        return sendResponse(req, res, `Append: ${targetPath}`, { success: true, message: msg }, msg);
      }

      const msg = await writeRemoteOrLocalFile(targetPath, content);
      sendResponse(req, res, `Write: ${targetPath}`, { success: true, message: msg }, msg);
    } catch (err: any) {
      sendResponse(req, res, "Write Error", { success: false, error: err.message }, err.message);
    }
  };
  router.get("/write", handleWrite);
  router.post("/write", handleWrite);

  const handleEdit = async (req: express.Request, res: express.Response) => {
    try {
      const filePath = String(req.query.path || req.body?.path || "");
      const searchB64 = (req.query.search_b64 || req.body?.search_b64) as string | undefined;
      const replaceB64 = (req.query.replace_b64 || req.body?.replace_b64) as string | undefined;
      const search = searchB64
        ? Buffer.from(searchB64, "base64").toString("utf8")
        : String(req.query.search ?? req.body?.search ?? "");
      const replace = replaceB64
        ? Buffer.from(replaceB64, "base64").toString("utf8")
        : String(req.query.replace ?? req.body?.replace ?? "");

      const msg = await editFileBlock(filePath, search, replace);
      sendResponse(req, res, `Edit: ${filePath}`, { success: true, message: msg }, msg);
    } catch (err: any) {
      sendResponse(req, res, "Edit Error", { success: false, error: err.message }, err.message);
    }
  };
  router.get("/edit", handleEdit);
  router.post("/edit", handleEdit);

  router.get("/search", async (req, res) => {
    try {
      const q = String(req.query.q || "");
      const searchPath = req.query.path ? String(req.query.path) : undefined;
      const out = await searchInCode(q, searchPath);
      sendResponse(req, res, `Search: ${q}`, { success: true, output: out }, out);
    } catch (err: any) {
      sendResponse(req, res, "Search Error", { success: false, error: err.message }, err.message);
    }
  });

  router.get("/sessions", async (req, res) => {
    const sessions = listActiveSessions();
    const procs = await listProcesses();
    const text = `=== SESIONES COMANDO EN SEGUNDO PLANO ===\n${JSON.stringify(sessions, null, 2)}\n\n=== TOP PROCESOS DEL SISTEMA ===\n${procs}`;
    sendResponse(req, res, "Sessions & Processes", { success: true, sessions }, text);
  });

  router.get("/session-output", (req, res) => {
    const pid = Number(req.query.pid);
    const session = getSessionOutput(pid);
    if (!session) {
      return sendResponse(
        req,
        res,
        "Session Not Found",
        { success: false, error: `No existe la sesión con PID ${pid}` },
        `No existe la sesión con PID ${pid}`
      );
    }
    sendResponse(
      req,
      res,
      `Session PID ${pid}`,
      { success: true, session },
      `PID: ${session.pid} | Command: ${session.command} | Status: ${session.status} | ExitCode: ${session.exitCode}\n\n${session.outputBuffer}`
    );
  });

  router.get("/kill", async (req, res) => {
    try {
      const pid = Number(req.query.pid);
      const msg = await terminateProcessOrSession(pid);
      sendResponse(req, res, `Kill PID ${pid}`, { success: true, message: msg }, msg);
    } catch (err: any) {
      sendResponse(req, res, "Kill Error", { success: false, error: err.message }, err.message);
    }
  });

  router.get("/input", async (req, res) => {
    try {
      const action = String(req.query.action || "click");
      const out = await performDesktopInput(action, req.query as Record<string, any>);
      sendResponse(
        req,
        res,
        `Desktop Input: ${action}`,
        { success: true, output: out },
        `Acción '${action}' ejecutada correctamente. ${out}`
      );
    } catch (err: any) {
      sendResponse(req, res, "Input Error", { success: false, error: err.message }, err.message);
    }
  });

  router.get("/screen.png", async (_req, res) => {
    try {
      const b64 = await captureScreenBase64();
      const img = Buffer.from(b64, "base64");
      res.type("image/png").send(img);
    } catch (err: any) {
      res.status(500).type("text/plain").send(err.message);
    }
  });

  router.get("/screen", async (req, res) => {
    try {
      const { user, pass, getBaseUrl } = getCredentials();
      const fullBase = `${getBaseUrl(req)}/c/${user}/${pass}`;
      const pngUrl = `${fullBase}/screen.png?_t=${Date.now()}`;
      const b64 = await captureScreenBase64();
      const extraHtml = `<div><h3>Live Desktop Screenshot</h3><img src="data:image/png;base64,${b64}" alt="Desktop Screenshot" style="max-width:100%;border:1px solid #333;" /><p>Direct Image URL: <a href="${pngUrl}">${pngUrl}</a></p></div>`;
      sendResponse(
        req,
        res,
        "Desktop Screenshot",
        { success: true, imageUrl: pngUrl },
        `Captura tomada correctamente (${Math.round(b64.length / 1024)} KB).`,
        extraHtml
      );
    } catch (err: any) {
      sendResponse(req, res, "Screenshot Error", { success: false, error: err.message }, err.message);
    }
  });

  app.use("/c/:user/:pass", router);
}
