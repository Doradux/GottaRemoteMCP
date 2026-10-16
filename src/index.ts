#!/usr/bin/env node
import express from "express";
import cors from "cors";
import crypto from "crypto";
import dotenv from "dotenv";
import os from "os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { runRemoteOrLocalCommand, SSHCredentials } from "./ssh.js";
import { captureScreenBase64, performDesktopInput } from "./desktop.js";
import {
  listProcesses,
  listRemoteOrLocalDirectory,
  writeRemoteOrLocalFile,
} from "./files.js";
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
import { buildChatPromptBlock, registerNormalChatBridge } from "./chat-bridge.js";
import { registerUserscriptBridge } from "./browser-bridge.js";
import { startQuickTunnel } from "./tunnel.js";

dotenv.config();

// Credenciales generadas al iniciar en bash (o definidas por variables de entorno)
const CHAT_USER = process.env.CHAT_USER || `cmd_${crypto.randomBytes(3).toString("hex")}`;
const CHAT_PASS =
  process.env.CHAT_PASS ||
  process.env.AUTH_SECRET ||
  `gotta_${crypto.randomBytes(6).toString("hex")}`;
const PORT = parseInt(process.env.PORT || "3000", 10);

// Estado de desbloqueo de sesión cuando el agente llama a connect_pc(username, password) desde cualquier chat
let sessionUnlocked = false;

function checkAndUnlockSession(obj: Record<string, any> = {}, req?: express.Request): boolean {
  const u = (obj.username || obj.user || req?.query?.username || req?.headers["x-gotta-user"]) as
    | string
    | undefined;
  const p = (obj.password ||
    obj.pass ||
    obj.key ||
    obj.auth_secret ||
    req?.query?.password ||
    req?.headers["x-api-key"] ||
    req?.headers.authorization?.replace(/^Bearer\s+/i, "")) as string | undefined;

  if (u === CHAT_USER && p === CHAT_PASS) {
    sessionUnlocked = true;
    return true;
  }
  if (p === CHAT_PASS) {
    sessionUnlocked = true;
    return true;
  }
  return sessionUnlocked;
}

const optionalAuthAndSshProps = {
  username: {
    type: "string",
    description: "Usuario de sesión GottaRemoteMCP (opcional si ya llamaste a connect_pc) o usuario SSH",
  },
  password: {
    type: "string",
    description: "Clave de sesión GottaRemoteMCP (opcional si ya llamaste a connect_pc) o clave SSH",
  },
  host: { type: "string", description: "IP/Host SSH remoto opcional (omitir para controlar este PC)" },
  port: { type: "number", description: "Puerto SSH opcional (defecto 22)" },
};

function extractCreds(obj: Record<string, any> = {}): SSHCredentials {
  // Solo usar como credenciales SSH si se especifica explícitamente un host SSH remoto
  if (!obj.host && !process.env.SSH_HOST) {
    return {};
  }
  return {
    host: obj.host as string | undefined,
    port: obj.port !== undefined ? Number(obj.port) : undefined,
    username: obj.username as string | undefined,
    password: obj.password as string | undefined,
    privateKey: obj.privateKey as string | undefined,
  };
}

export async function getSystemStatus(creds?: SSHCredentials): Promise<Record<string, any>> {
  const host = creds?.host || process.env.SSH_HOST;
  if (host) {
    const raw = await runRemoteOrLocalCommand(
      "uname -a && uptime && free -m 2>/dev/null || systeminfo",
      creds
    );
    return { mode: "ssh", host, cwd: getCurrentCwd(creds), rawStatus: raw };
  }

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    mode: "local",
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cwd: getCurrentCwd(),
    uptimeSeconds: os.uptime(),
    cpuCount: os.cpus().length,
    loadAvg: os.loadavg(),
    memory: {
      totalMB: Math.round(totalMem / 1024 / 1024),
      freeMB: Math.round(freeMem / 1024 / 1024),
      usedPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
    },
  };
}

// Anotaciones MCP para permitir ejecución autónoma continua sin pedir confirmación manual en cada paso
const autonomousAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

// ============================================================================
// 1. SERVIDOR MCP NATIVO (Streamable HTTP /mcp + SSE /mcp/sse + Stdio)
// ============================================================================
function createMcpServer(preUnlocked = false): Server {
  const server = new Server(
    { name: "gotta-remote-mcp", version: "0.4.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "connect_pc",
        description:
          "Autentica y conecta al agente con el ordenador remoto usando el Usuario y Clave generados en bash que el usuario pasa en el chat. Llámala una vez al inicio de la conversación.",
        annotations: autonomousAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            username: { type: "string", description: "Usuario generado por gotta-remote.sh (ej. cmd_...)" },
            password: { type: "string", description: "Clave generada por gotta-remote.sh (ej. gotta_...)" },
          },
          required: ["username", "password"],
        },
      },
      {
        name: "execute_command",
        description:
          "Ejecuta un comando en terminal manteniendo el directorio actual (cwd) y devuelve stdout/stderr directamente al agente.",
        annotations: autonomousAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Comando bash/shell/powershell a ejecutar" },
            cwd: { type: "string", description: "Directorio opcional" },
            timeoutMs: {
              type: "number",
              description: "Tiempo máximo en ms antes de pasar a segundo plano (defecto 8000)",
            },
            ...optionalAuthAndSshProps,
          },
          required: ["command"],
        },
      },
      {
        name: "read_session_output",
        description: "Lee la salida acumulada de un comando en segundo plano por su PID.",
        annotations: autonomousAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            pid: { type: "number", description: "PID de la sesión activa" },
          },
          required: ["pid"],
        },
      },
      {
        name: "kill_process",
        description: "Termina una sesión en segundo plano o un proceso del sistema por su PID.",
        annotations: autonomousAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            pid: { type: "number", description: "PID del proceso a terminar" },
            ...optionalAuthAndSshProps,
          },
          required: ["pid"],
        },
      },
      {
        name: "read_file",
        description: "Lee un archivo numerando sus líneas (permite rango opcional startLine/endLine).",
        annotations: autonomousAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Ruta del archivo a leer" },
            startLine: { type: "number", description: "Línea inicial opcional (1-indexed)" },
            endLine: { type: "number", description: "Línea final opcional" },
            ...optionalAuthAndSshProps,
          },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Crea o sobrescribe un archivo en el ordenador.",
        annotations: autonomousAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Ruta del archivo a escribir" },
            content: { type: "string", description: "Contenido completo del archivo" },
            ...optionalAuthAndSshProps,
          },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_block",
        description:
          "Reemplaza un bloque exacto de texto dentro de un archivo (search & replace quirúrgico estilo Desktop Commander).",
        annotations: autonomousAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Ruta del archivo" },
            search: { type: "string", description: "Bloque exacto a buscar" },
            replace: { type: "string", description: "Nuevo bloque de reemplazo" },
            ...optionalAuthAndSshProps,
          },
          required: ["path", "search", "replace"],
        },
      },
      {
        name: "search_code",
        description: "Busca texto o patrones regex dentro de archivos de un directorio (ripgrep/grep).",
        annotations: autonomousAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Texto o expresión regular a buscar" },
            path: { type: "string", description: "Directorio donde buscar (opcional)" },
            ...optionalAuthAndSshProps,
          },
          required: ["query"],
        },
      },
      {
        name: "list_directory",
        description: "Lista los archivos y carpetas de un directorio.",
        annotations: autonomousAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Ruta del directorio (ej. . o /home/marcos)" },
            ...optionalAuthAndSshProps,
          },
          required: ["path"],
        },
      },
      {
        name: "list_processes",
        description: "Lista las sesiones activas en segundo plano y los procesos del sistema.",
        annotations: autonomousAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            ...optionalAuthAndSshProps,
          },
        },
      },
      {
        name: "take_screenshot",
        description: "Toma una captura de pantalla del escritorio remoto y devuelve la imagen en Base64.",
        annotations: autonomousAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            ...optionalAuthAndSshProps,
          },
        },
      },
      {
        name: "input_action",
        description:
          "Controla el ratón y el teclado en el escritorio (click, double_click, right_click, move, drag, scroll, type, key).",
        annotations: autonomousAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "click",
                "double_click",
                "right_click",
                "move",
                "drag",
                "scroll",
                "type",
                "key",
              ],
            },
            x: { type: "number" },
            y: { type: "number" },
            toX: { type: "number" },
            toY: { type: "number" },
            button: { type: "number" },
            scrollAmount: { type: "number" },
            text: { type: "string" },
            key: { type: "string" },
            ...optionalAuthAndSshProps,
          },
          required: ["action"],
        },
      },
      {
        name: "system_status",
        description: "Devuelve uso de CPU, RAM, SO y directorio actual del ordenador.",
        annotations: autonomousAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            ...optionalAuthAndSshProps,
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    if (name === "connect_pc") {
      const ok = checkAndUnlockSession(args as Record<string, any>);
      if (!ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Credenciales incorrectas. Verifica el Usuario (cmd_...) y Clave (gotta_...) generados en la terminal bash.",
            },
          ],
        };
      }
      const status = await getSystemStatus();
      return {
        content: [
          {
            type: "text",
            text: `Conexión establecida correctamente con ${status.hostname || "el PC"} (CWD: ${status.cwd}). Ya tienes control total para usar execute_command, read_file, write_file, edit_block, list_directory, search_code, input_action y take_screenshot.`,
          },
        ],
      };
    }

    if (!preUnlocked && !checkAndUnlockSession(args as Record<string, any>)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "PC bloqueado. Pide al usuario las credenciales generadas en bash y llama primero a connect_pc(username, password).",
          },
        ],
      };
    }

    const creds = extractCreds(args as Record<string, any>);

    if (name === "execute_command") {
      const res = await executeCommander(String(args.command), {
        cwd: args.cwd as string | undefined,
        timeoutMs: args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined,
        creds,
      });
      return {
        content: [
          {
            type: "text",
            text: `[CWD: ${res.cwd} | Status: ${res.status} | ExitCode: ${res.exitCode ?? 0} | PID: ${res.pid ?? "-"}]\n${res.output}`,
          },
        ],
      };
    }

    if (name === "read_session_output") {
      const session = getSessionOutput(Number(args.pid));
      if (!session) {
        return { content: [{ type: "text", text: `No se encontró sesión con PID ${args.pid}` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(session, null, 2) }] };
    }

    if (name === "kill_process") {
      const out = await terminateProcessOrSession(Number(args.pid), creds);
      return { content: [{ type: "text", text: out }] };
    }

    if (name === "read_file") {
      const res = await readFileLines(
        String(args.path),
        args.startLine !== undefined ? Number(args.startLine) : undefined,
        args.endLine !== undefined ? Number(args.endLine) : undefined,
        creds
      );
      return {
        content: [
          {
            type: "text",
            text: `File: ${res.path} (${res.totalLines} lines)\n\n${res.content}`,
          },
        ],
      };
    }

    if (name === "write_file") {
      const result = await writeRemoteOrLocalFile(String(args.path), String(args.content), creds);
      return { content: [{ type: "text", text: result }] };
    }

    if (name === "edit_block") {
      const result = await editFileBlock(
        String(args.path),
        String(args.search),
        String(args.replace),
        creds
      );
      return { content: [{ type: "text", text: result }] };
    }

    if (name === "search_code") {
      const out = await searchInCode(
        String(args.query),
        args.path ? String(args.path) : undefined,
        creds
      );
      return { content: [{ type: "text", text: out }] };
    }

    if (name === "list_directory") {
      const entries = await listRemoteOrLocalDirectory(String(args.path || "."), creds);
      return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
    }

    if (name === "list_processes") {
      const procs = await listProcesses(creds);
      const sessions = listActiveSessions();
      return {
        content: [
          {
            type: "text",
            text: `Active Background Sessions:\n${JSON.stringify(sessions, null, 2)}\n\nSystem Processes:\n${procs}`,
          },
        ],
      };
    }

    if (name === "take_screenshot") {
      const b64 = await captureScreenBase64(creds);
      return {
        content: [{ type: "image", data: b64, mimeType: "image/png" }],
      };
    }

    if (name === "input_action" || name === "desktop_input") {
      const output = await performDesktopInput(String(args.action), args as Record<string, any>, creds);
      return {
        content: [{ type: "text", text: `Acción ${args.action} completada. ${output}`.trim() }],
      };
    }

    if (name === "system_status") {
      const status = await getSystemStatus(creds);
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    }

    throw new Error(`Herramienta desconocida: ${name}`);
  });

  return server;
}

// ============================================================================
// 2. SERVIDOR HTTP: MCP STREAMABLE HTTP + SSE + OPENAPI 3.1 (ChatGPT / Gemini)
// ============================================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

let publicTunnelUrl: string | null = null;

function getEffectiveBaseUrl(req: express.Request): string {
  if (publicTunnelUrl) return publicTunnelUrl;
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  return `${proto}://${req.get("host")}`;
}

const getBridgeCreds = () => ({
  user: CHAT_USER,
  pass: CHAT_PASS,
  getBaseUrl: getEffectiveBaseUrl,
});

registerUserscriptBridge(app, getBridgeCreds);
registerNormalChatBridge(app, getBridgeCreds, () => getSystemStatus());

// Middleware para los endpoints /api/* (soporta connect_pc en el chat o credenciales directas)
function requireUnlockedOrCreds(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (checkAndUnlockSession(req.body || {}, req)) {
    return next();
  }
  return res.status(401).json({
    success: false,
    error:
      "PC bloqueado. Llama primero a la operación connectPc pasando el username y password que el usuario te dio en el chat.",
  });
}

// Endpoint para autenticar desde cualquier chat nuevo (iOS / Android / Web) pasando usuario y clave en el mensaje
app.post("/api/connect", async (req, res) => {
  try {
    if (!checkAndUnlockSession(req.body || {}, req)) {
      return res.status(401).json({
        success: false,
        error: "Credenciales inválidas. Verifica el Usuario y Clave generados en bash.",
      });
    }
    const status = await getSystemStatus();
    res.json({
      success: true,
      message: `Conectado correctamente a ${status.hostname} (CWD: ${status.cwd}). Ya puedes ejecutar cualquier comando o herramienta.`,
      status,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use("/api", requireUnlockedOrCreds);

app.post("/api/execute", async (req, res) => {
  try {
    const creds = extractCreds(req.body);
    const result = await executeCommander(String(req.body.command), {
      cwd: req.body.cwd,
      timeoutMs: req.body.timeoutMs,
      creds,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/session-output", (req, res) => {
  const pid = Number(req.body?.pid ?? req.query?.pid);
  const session = getSessionOutput(pid);
  if (!session) {
    return res.status(404).json({ success: false, error: `No existe sesión con PID ${pid}` });
  }
  res.json({ success: true, session });
});

app.post("/api/kill", async (req, res) => {
  try {
    const pid = Number(req.body?.pid ?? req.query?.pid);
    const creds = extractCreds(req.body);
    const message = await terminateProcessOrSession(pid, creds);
    res.json({ success: true, message });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/files/read", async (req, res) => {
  try {
    const creds = extractCreds(req.body);
    const result = await readFileLines(
      String(req.body.path),
      req.body.startLine !== undefined ? Number(req.body.startLine) : undefined,
      req.body.endLine !== undefined ? Number(req.body.endLine) : undefined,
      creds
    );
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/files/write", async (req, res) => {
  try {
    const creds = extractCreds(req.body);
    const message = await writeRemoteOrLocalFile(
      String(req.body.path),
      String(req.body.content),
      creds
    );
    res.json({ success: true, message });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/files/edit", async (req, res) => {
  try {
    const creds = extractCreds(req.body);
    const message = await editFileBlock(
      String(req.body.path),
      String(req.body.search),
      String(req.body.replace),
      creds
    );
    res.json({ success: true, message });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/files/search", async (req, res) => {
  try {
    const creds = extractCreds(req.body);
    const output = await searchInCode(
      String(req.body.query),
      req.body.path ? String(req.body.path) : undefined,
      creds
    );
    res.json({ success: true, output });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/files/list", async (req, res) => {
  try {
    const creds = extractCreds(req.body);
    const entries = await listRemoteOrLocalDirectory(String(req.body.path || "."), creds);
    res.json({ success: true, entries });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/processes", async (req, res) => {
  try {
    const creds = extractCreds(req.query as Record<string, any>);
    const processes = await listProcesses(creds);
    const activeSessions = listActiveSessions();
    res.json({ success: true, activeSessions, processes });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/input", async (req, res) => {
  try {
    const creds = extractCreds(req.body);
    const { action, ...params } = req.body;
    const output = await performDesktopInput(String(action), params, creds);
    res.json({ success: true, output });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/screenshot", async (req, res) => {
  try {
    const creds = extractCreds(req.query as Record<string, any>);
    const base64 = await captureScreenBase64(creds);
    res.json({ success: true, mimeType: "image/png", base64 });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/status", async (req, res) => {
  try {
    const creds = extractCreds(req.query as Record<string, any>);
    const status = await getSystemStatus(creds);
    res.json({ success: true, status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// 3. TRANSPORTE MCP STREAMABLE HTTP (/mcp y /mcp/:user/:pass) + SSE (/mcp/sse)
// ============================================================================
const streamableTransports = new Map<string, StreamableHTTPServerTransport>();

async function handleStreamableMcp(
  req: express.Request,
  res: express.Response,
  preUnlocked: boolean
) {
  if (preUnlocked) {
    sessionUnlocked = true;
  }
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && streamableTransports.has(sessionId)) {
    const existing = streamableTransports.get(sessionId)!;
    await existing.handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        streamableTransports.set(sid, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        streamableTransports.delete(transport.sessionId);
      }
    };
    const mcpServer = createMcpServer(preUnlocked);
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // Fallback stateless para clientes MCP sin mcp-session-id
  const statelessTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const mcpServer = createMcpServer(preUnlocked);
  await mcpServer.connect(statelessTransport);
  await statelessTransport.handleRequest(req, res, req.body);
}

app.all("/mcp", async (req, res) => {
  await handleStreamableMcp(req, res, false);
});

app.all("/mcp/:user/:pass", async (req, res) => {
  const valid = req.params.user === CHAT_USER && req.params.pass === CHAT_PASS;
  if (!valid) {
    return res.status(401).json({ error: "Credenciales MCP en URL inválidas" });
  }
  await handleStreamableMcp(req, res, true);
});

const sseTransports = new Map<string, SSEServerTransport>();

app.get("/mcp/sse", async (_req, res) => {
  const transport = new SSEServerTransport("/mcp/messages", res);
  const server = createMcpServer(false);
  sseTransports.set(transport.sessionId, transport);
  res.on("close", () => {
    sseTransports.delete(transport.sessionId);
  });
  await server.connect(transport);
});

app.post("/mcp/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = sseTransports.get(sessionId);
  if (!transport) {
    return res.status(404).json({ error: "Sesión MCP SSE no encontrada" });
  }
  await transport.handlePostMessage(req, res, req.body);
});

// ============================================================================
// 4. ESPECIFICACIÓN OPENAPI 3.1 (Para ChatGPT iOS/Android/Web Actions y Gemini)
// ============================================================================
function buildOpenApiSpec(serverUrl: string) {
  const stdResponse = (desc: string) => ({
    "200": {
      description: desc,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              output: { type: "string" },
              cwd: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "GottaRemoteMCP Desktop Commander",
      version: "0.4.0",
      description:
        "Control remoto autónomo de terminal, archivos y escritorio estilo @remote desktop commander para ChatGPT (iOS/Android/Web) y Gemini pasando las credenciales generadas en bash directamente en el chat.",
    },
    servers: [{ url: serverUrl }],
    paths: {
      "/api/connect": {
        post: {
          operationId: "connectPc",
          summary:
            "Autentica la sesión pasando el Usuario y Clave generados en bash que el usuario indica en el chat",
          "x-openai-isConsequential": false,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["username", "password"],
                  properties: {
                    username: { type: "string", description: "Usuario generado en bash (cmd_...)" },
                    password: { type: "string", description: "Clave generada en bash (gotta_...)" },
                  },
                },
              },
            },
          },
          responses: stdResponse("Conexión autenticada y estado del sistema"),
        },
      },
      "/api/execute": {
        post: {
          operationId: "executeCommand",
          summary:
            "Ejecuta un comando bash/shell manteniendo el directorio actual (cwd) y devuelve la salida al agente",
          "x-openai-isConsequential": false,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["command"],
                  properties: {
                    command: { type: "string", description: "Comando a ejecutar" },
                    cwd: { type: "string", description: "Directorio opcional" },
                    timeoutMs: { type: "number", description: "Timeout opcional en ms" },
                    ...optionalAuthAndSshProps,
                  },
                },
              },
            },
          },
          responses: stdResponse("Salida stdout/stderr del comando y directorio actual"),
        },
      },
      "/api/files/read": {
        post: {
          operationId: "readFile",
          summary: "Lee un archivo con numeración de líneas y rango opcional startLine/endLine",
          "x-openai-isConsequential": false,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["path"],
                  properties: {
                    path: { type: "string" },
                    startLine: { type: "number" },
                    endLine: { type: "number" },
                    ...optionalAuthAndSshProps,
                  },
                },
              },
            },
          },
          responses: stdResponse("Contenido del archivo"),
        },
      },
      "/api/files/write": {
        post: {
          operationId: "writeFile",
          summary: "Crea o sobrescribe un archivo en el ordenador",
          "x-openai-isConsequential": false,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["path", "content"],
                  properties: {
                    path: { type: "string" },
                    content: { type: "string" },
                    ...optionalAuthAndSshProps,
                  },
                },
              },
            },
          },
          responses: stdResponse("Confirmación de escritura"),
        },
      },
      "/api/files/edit": {
        post: {
          operationId: "editBlock",
          summary: "Edita quirúrgicamente un bloque de texto dentro de un archivo (search & replace)",
          "x-openai-isConsequential": false,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["path", "search", "replace"],
                  properties: {
                    path: { type: "string" },
                    search: { type: "string" },
                    replace: { type: "string" },
                    ...optionalAuthAndSshProps,
                  },
                },
              },
            },
          },
          responses: stdResponse("Confirmación de edición"),
        },
      },
      "/api/files/search": {
        post: {
          operationId: "searchCode",
          summary: "Busca texto o expresiones regulares en archivos (ripgrep/grep)",
          "x-openai-isConsequential": false,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["query"],
                  properties: {
                    query: { type: "string" },
                    path: { type: "string" },
                    ...optionalAuthAndSshProps,
                  },
                },
              },
            },
          },
          responses: stdResponse("Resultados de búsqueda"),
        },
      },
      "/api/files/list": {
        post: {
          operationId: "listDirectory",
          summary: "Lista archivos y carpetas de un directorio",
          "x-openai-isConsequential": false,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["path"],
                  properties: {
                    path: { type: "string" },
                    ...optionalAuthAndSshProps,
                  },
                },
              },
            },
          },
          responses: stdResponse("Listado del directorio"),
        },
      },
      "/api/session-output": {
        post: {
          operationId: "readSessionOutput",
          summary: "Lee la salida de un proceso en segundo plano por su PID",
          "x-openai-isConsequential": false,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["pid"],
                  properties: {
                    pid: { type: "number" },
                  },
                },
              },
            },
          },
          responses: stdResponse("Salida del proceso"),
        },
      },
      "/api/kill": {
        post: {
          operationId: "killProcess",
          summary: "Termina un proceso o sesión en segundo plano por su PID",
          "x-openai-isConsequential": false,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["pid"],
                  properties: {
                    pid: { type: "number" },
                  },
                },
              },
            },
          },
          responses: stdResponse("Proceso terminado"),
        },
      },
      "/api/input": {
        post: {
          operationId: "inputAction",
          summary: "Simula clics de ratón, arrastrar, scroll, movimiento de cursor y teclado",
          "x-openai-isConsequential": false,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["action"],
                  properties: {
                    action: {
                      type: "string",
                      enum: [
                        "click",
                        "double_click",
                        "right_click",
                        "move",
                        "drag",
                        "scroll",
                        "type",
                        "key",
                      ],
                    },
                    x: { type: "number" },
                    y: { type: "number" },
                    toX: { type: "number" },
                    toY: { type: "number" },
                    button: { type: "number" },
                    scrollAmount: { type: "number" },
                    text: { type: "string" },
                    key: { type: "string" },
                  },
                },
              },
            },
          },
          responses: stdResponse("Acción de escritorio completada"),
        },
      },
      "/api/processes": {
        get: {
          operationId: "listProcesses",
          summary: "Lista procesos activos y sesiones en segundo plano",
          "x-openai-isConsequential": false,
          responses: stdResponse("Procesos activos"),
        },
      },
      "/api/status": {
        get: {
          operationId: "systemStatus",
          summary: "Devuelve estado de CPU, RAM, SO y directorio actual",
          "x-openai-isConsequential": false,
          responses: stdResponse("Estado del sistema"),
        },
      },
    },
  };
}

app.get("/openapi.json", (req, res) => {
  res.json(buildOpenApiSpec(getEffectiveBaseUrl(req)));
});

app.get("/openapi/:user/:pass.json", (req, res) => {
  if (req.params.user === CHAT_USER && req.params.pass === CHAT_PASS) {
    sessionUnlocked = true;
  }
  res.json(buildOpenApiSpec(getEffectiveBaseUrl(req)));
});

// Esquema nativo de Function Declarations para Google Gemini / Google AI Studio
app.get("/gemini-tools.json", (_req, res) => {
  res.json({
    functionDeclarations: [
      {
        name: "connect_pc",
        description:
          "Autentica la sesión con el ordenador remoto usando el Usuario y Clave generados en bash.",
        parameters: {
          type: "OBJECT",
          properties: {
            username: { type: "STRING", description: "Usuario generado en bash (cmd_...)" },
            password: { type: "STRING", description: "Clave generada en bash (gotta_...)" },
          },
          required: ["username", "password"],
        },
      },
      {
        name: "execute_command",
        description:
          "Ejecuta un comando en la terminal del ordenador remoto manteniendo el directorio actual (cwd).",
        parameters: {
          type: "OBJECT",
          properties: {
            command: { type: "STRING", description: "Comando bash/shell a ejecutar" },
            cwd: { type: "STRING", description: "Directorio opcional" },
          },
          required: ["command"],
        },
      },
      {
        name: "read_file",
        description: "Lee un archivo del ordenador remoto con numeración de líneas.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Ruta del archivo" },
            startLine: { type: "NUMBER", description: "Línea inicial opcional" },
            endLine: { type: "NUMBER", description: "Línea final opcional" },
          },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Crea o sobrescribe un archivo en el ordenador remoto.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Ruta del archivo" },
            content: { type: "STRING", description: "Contenido del archivo" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_block",
        description: "Reemplaza un bloque exacto de texto dentro de un archivo (search & replace).",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Ruta del archivo" },
            search: { type: "STRING", description: "Texto exacto a buscar" },
            replace: { type: "STRING", description: "Texto nuevo de reemplazo" },
          },
          required: ["path", "search", "replace"],
        },
      },
      {
        name: "list_directory",
        description: "Lista los archivos y carpetas de un directorio.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Ruta del directorio" },
          },
          required: ["path"],
        },
      },
      {
        name: "search_code",
        description: "Busca texto o patrones regex dentro de archivos (ripgrep/grep).",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Patrón a buscar" },
            path: { type: "STRING", description: "Directorio opcional" },
          },
          required: ["query"],
        },
      },
      {
        name: "input_action",
        description: "Controla el ratón y el teclado en el escritorio remoto.",
        parameters: {
          type: "OBJECT",
          properties: {
            action: { type: "STRING", description: "click, double_click, right_click, move, drag, scroll, type, key" },
            x: { type: "NUMBER" },
            y: { type: "NUMBER" },
            text: { type: "STRING" },
            key: { type: "STRING" },
          },
          required: ["action"],
        },
      },
    ],
  });
});

async function main() {
  if (process.argv.includes("--stdio")) {
    const mcpServer = createMcpServer(true);
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    return;
  }

  app.listen(PORT, async () => {
    const localUrl = `http://localhost:${PORT}`;
    console.log(`GottaRemoteMCP v0.4.0 escuchando localmente en ${localUrl}`);

    const disableTunnel =
      process.argv.includes("--no-tunnel") || process.env.DISABLE_TUNNEL === "true";

    if (!disableTunnel) {
      try {
        console.log("Iniciando túnel público HTTPS para conexión directa de agentes (iOS/Android/Web)...");
        publicTunnelUrl = await startQuickTunnel(PORT);
      } catch (err: any) {
        console.error(`Aviso: No se pudo iniciar el túnel público (${err.message}). Usando URL local.`);
      }
    }

    const activeUrl = publicTunnelUrl || localUrl;
    console.log(buildChatPromptBlock(activeUrl, localUrl, CHAT_USER, CHAT_PASS));
  });
}

main().catch(console.error);
