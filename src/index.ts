#!/usr/bin/env node
import express from "express";
import cors from "cors";
import crypto from "crypto";
import dotenv from "dotenv";
import os from "os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
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
import { startQuickTunnel } from "./tunnel.js";

dotenv.config();

// Credenciales autogeneradas en cada ejecución de bash si no se definen en .env
const CHAT_USER = process.env.CHAT_USER || `cmd_${crypto.randomBytes(3).toString("hex")}`;
const CHAT_PASS =
  process.env.CHAT_PASS ||
  process.env.AUTH_SECRET ||
  `gotta_${crypto.randomBytes(8).toString("hex")}`;
const AUTH_SECRET = CHAT_PASS;
const PORT = parseInt(process.env.PORT || "3000", 10);

const sshCredentialProperties = {
  host: { type: "string", description: "IP/Host SSH opcional (si se omite ejecuta en local o usa .env)" },
  port: { type: "number", description: "Puerto SSH opcional (por defecto 22)" },
  username: { type: "string", description: "Usuario SSH opcional" },
  password: { type: "string", description: "Contraseña SSH opcional" },
  privateKey: { type: "string", description: "Clave privada SSH en PEM opcional" },
};

function extractCreds(obj: Record<string, any> = {}): SSHCredentials {
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

// ============================================================================
// 1. SERVIDOR MCP (@remote desktop commander completo)
// ============================================================================
function createMcpServer(): Server {
  const server = new Server(
    { name: "gotta-remote-mcp", version: "0.3.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "execute_command",
        description:
          "Ejecuta un comando en terminal manteniendo el directorio actual (cwd) y pasando automáticamente a segundo plano si tarda más de timeoutMs.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Comando bash/shell/powershell a ejecutar" },
            cwd: { type: "string", description: "Directorio opcional" },
            timeoutMs: { type: "number", description: "Tiempo máximo en ms antes de pasar a background (defecto 8000)" },
            ...sshCredentialProperties,
          },
          required: ["command"],
        },
      },
      {
        name: "read_session_output",
        description: "Lee la salida acumulada de un comando que quedó ejecutándose en segundo plano por su PID.",
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
        inputSchema: {
          type: "object",
          properties: {
            pid: { type: "number", description: "PID del proceso a terminar" },
            ...sshCredentialProperties,
          },
          required: ["pid"],
        },
      },
      {
        name: "read_file",
        description: "Lee un archivo (con numeración de líneas y rango opcional startLine/endLine).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Ruta del archivo a leer" },
            startLine: { type: "number", description: "Línea inicial opcional (1-indexed)" },
            endLine: { type: "number", description: "Línea final opcional" },
            ...sshCredentialProperties,
          },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Escribe o sobrescribe un archivo en el ordenador local o remoto.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Ruta del archivo a escribir" },
            content: { type: "string", description: "Contenido del archivo" },
            ...sshCredentialProperties,
          },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_block",
        description:
          "Reemplaza un bloque exacto de texto dentro de un archivo sin tener que reescribir el archivo entero (estilo Desktop Commander).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Ruta del archivo" },
            search: { type: "string", description: "Bloque exacto a buscar" },
            replace: { type: "string", description: "Nuevo bloque de reemplazo" },
            ...sshCredentialProperties,
          },
          required: ["path", "search", "replace"],
        },
      },
      {
        name: "search_code",
        description: "Busca texto o patrones regex dentro de archivos de un directorio (ripgrep/grep).",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Texto o expresión regular a buscar" },
            path: { type: "string", description: "Directorio donde buscar (opcional)" },
            ...sshCredentialProperties,
          },
          required: ["query"],
        },
      },
      {
        name: "list_directory",
        description: "Lista los archivos y carpetas de un directorio local o remoto.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Ruta del directorio" },
            ...sshCredentialProperties,
          },
          required: ["path"],
        },
      },
      {
        name: "list_processes",
        description: "Lista las sesiones activas de comandos y los procesos con mayor uso de CPU/memoria.",
        inputSchema: {
          type: "object",
          properties: {
            ...sshCredentialProperties,
          },
        },
      },
      {
        name: "take_screenshot",
        description: "Toma una captura de pantalla del escritorio remoto y devuelve la imagen en Base64.",
        inputSchema: {
          type: "object",
          properties: {
            ...sshCredentialProperties,
          },
        },
      },
      {
        name: "input_action",
        description:
          "Controla el ratón y el teclado en el escritorio (click, double_click, right_click, move, drag, scroll, type, key).",
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
            ...sshCredentialProperties,
          },
          required: ["action"],
        },
      },
      {
        name: "system_status",
        description: "Devuelve uso de CPU, RAM, SO, directorio actual y red del ordenador.",
        inputSchema: {
          type: "object",
          properties: {
            ...sshCredentialProperties,
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const creds = extractCreds(args);

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
            text: `[CWD: ${res.cwd} | Status: ${res.status} | PID: ${res.pid ?? "-"}]\n${res.output}`,
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
      const entries = await listRemoteOrLocalDirectory(String(args.path), creds);
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
      const output = await performDesktopInput(String(args.action), args, creds);
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
// 2. SERVIDOR HTTP + PUENTE DE CHAT NORMAL (SIN API) + SSE MCP
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

// Registrar puente directo para chats normales (/c/:user/:pass/*) sin necesidad de API Keys
registerNormalChatBridge(
  app,
  () => ({
    user: CHAT_USER,
    pass: CHAT_PASS,
    getBaseUrl: getEffectiveBaseUrl,
  }),
  () => getSystemStatus()
);

function verifyAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers["x-api-key"] as string | undefined;
  const token =
    authHeader?.replace(/^Bearer\s+/i, "") ||
    apiKeyHeader ||
    req.body?.auth_secret ||
    (req.query?.auth_secret as string | undefined);

  if (token !== AUTH_SECRET) {
    return res.status(401).json({
      error: "Credenciales inválidas. Usa la URL /c/<user>/<pass> o Authorization: Bearer <PASS>.",
    });
  }
  next();
}

app.use("/api", verifyAuth);

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

const sseTransports = new Map<string, SSEServerTransport>();

app.get("/mcp/sse", verifyAuth, async (_req, res) => {
  const transport = new SSEServerTransport("/mcp/messages", res);
  const server = createMcpServer();
  sseTransports.set(transport.sessionId, transport);
  res.on("close", () => {
    sseTransports.delete(transport.sessionId);
  });
  await server.connect(transport);
});

app.post("/mcp/messages", verifyAuth, async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = sseTransports.get(sessionId);
  if (!transport) {
    return res.status(404).json({ error: "Sesión MCP SSE no encontrada" });
  }
  await transport.handlePostMessage(req, res, req.body);
});

async function main() {
  if (process.argv.includes("--stdio")) {
    const mcpServer = createMcpServer();
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    return;
  }

  app.listen(PORT, async () => {
    const localUrl = `http://localhost:${PORT}`;
    console.log(`GottaRemoteMCP v0.3.0 escuchando localmente en ${localUrl}`);

    const disableTunnel =
      process.argv.includes("--no-tunnel") || process.env.DISABLE_TUNNEL === "true";

    if (!disableTunnel) {
      try {
        console.log("Iniciando túnel público gratuito para conectar desde cualquier chat normal...");
        publicTunnelUrl = await startQuickTunnel(PORT);
      } catch (err: any) {
        console.error(`Aviso: No se pudo iniciar el túnel público (${err.message}). Usando URL local.`);
      }
    }

    const activeUrl = publicTunnelUrl || localUrl;
    console.log(buildChatPromptBlock(activeUrl, CHAT_USER, CHAT_PASS));
  });
}

main().catch(console.error);
