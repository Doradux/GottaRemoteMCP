#!/usr/bin/env node
import express from "express";
import cors from "cors";
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
  readRemoteOrLocalFile,
  writeRemoteOrLocalFile,
} from "./files.js";
import { startQuickTunnel } from "./tunnel.js";

dotenv.config();

const AUTH_SECRET = process.env.AUTH_SECRET || "admin123";
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
    return { mode: "ssh", host, rawStatus: raw };
  }

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    mode: "local",
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
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
// 1. SERVIDOR MCP (Para Gemini CLI / Antigravity / ChatGPT Desktop / Clientes MCP)
// ============================================================================
function createMcpServer(): Server {
  const server = new Server(
    { name: "gotta-remote-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "execute_command",
        description:
          "Ejecuta un comando shell/bash/powershell en el ordenador remoto (local o vía credenciales SSH directas).",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Comando bash/shell/powershell a ejecutar" },
            ...sshCredentialProperties,
          },
          required: ["command"],
        },
      },
      {
        name: "take_screenshot",
        description:
          "Toma una captura de pantalla del escritorio remoto (Linux X11/Wayland, Windows o macOS) y devuelve la imagen en Base64.",
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
          "Simula clics de ratón, doble clic, clic derecho, arrastrar, scroll, movimiento de cursor y teclado en Linux/Windows/macOS.",
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
            x: { type: "number", description: "Coordenada X de pantalla" },
            y: { type: "number", description: "Coordenada Y de pantalla" },
            toX: { type: "number", description: "Coordenada X destino para drag" },
            toY: { type: "number", description: "Coordenada Y destino para drag" },
            button: { type: "number", description: "Botón del ratón (1=izq, 2=medio, 3=der)" },
            scrollAmount: { type: "number", description: "Pasos de scroll (positivo=abajo, negativo=arriba)" },
            text: { type: "string", description: "Texto a escribir cuando action='type'" },
            key: { type: "string", description: "Tecla o combinación cuando action='key' (ej. Return, ctrl+c)" },
            ...sshCredentialProperties,
          },
          required: ["action"],
        },
      },
      {
        name: "read_file",
        description: "Lee el contenido de un archivo en el ordenador local o remoto (SFTP/SSH).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Ruta del archivo a leer" },
            ...sshCredentialProperties,
          },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Escribe o sobrescribe un archivo en el ordenador local o remoto (SFTP/SSH).",
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
        name: "list_directory",
        description: "Lista los archivos y carpetas de un directorio local o remoto (SFTP/SSH).",
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
        description: "Lista los procesos en ejecución con mayor uso de CPU/memoria.",
        inputSchema: {
          type: "object",
          properties: {
            ...sshCredentialProperties,
          },
        },
      },
      {
        name: "system_status",
        description:
          "Devuelve uso de CPU, RAM, SO y red para dar contexto rápido al agente sobre el ordenador remoto.",
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
      const output = await runRemoteOrLocalCommand(String(args.command), creds);
      return { content: [{ type: "text", text: output || "Comando ejecutado sin salida." }] };
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

    if (name === "read_file") {
      const content = await readRemoteOrLocalFile(String(args.path), creds);
      return { content: [{ type: "text", text: content }] };
    }

    if (name === "write_file") {
      const result = await writeRemoteOrLocalFile(String(args.path), String(args.content), creds);
      return { content: [{ type: "text", text: result }] };
    }

    if (name === "list_directory") {
      const entries = await listRemoteOrLocalDirectory(String(args.path), creds);
      return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
    }

    if (name === "list_processes") {
      const procs = await listProcesses(creds);
      return { content: [{ type: "text", text: procs }] };
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
// 2. SERVIDOR HTTP + SSE MCP + OPENAPI 3.1 (Para ChatGPT Actions y Gemini)
// ============================================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

let publicTunnelUrl: string | null = null;

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
      error: "Credenciales inválidas. Pasa Authorization: Bearer <AUTH_SECRET>, X-API-Key o auth_secret.",
    });
  }
  next();
}

app.use("/api", verifyAuth);

app.post("/api/execute", async (req, res) => {
  try {
    const creds = extractCreds(req.body);
    const output = await runRemoteOrLocalCommand(String(req.body.command), creds);
    res.json({ success: true, output });
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

app.post("/api/files/read", async (req, res) => {
  try {
    const creds = extractCreds(req.body);
    const content = await readRemoteOrLocalFile(String(req.body.path), creds);
    res.json({ success: true, content });
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
    res.json({ success: true, processes });
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

// Transporte MCP sobre SSE para conexiones remotas directas sin verificación de cuenta
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

// Esquema OpenAPI 3.1 autogenerado para importar en ChatGPT / Gemini con 1 clic
app.get("/openapi.json", (req, res) => {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const serverUrl = publicTunnelUrl || `${proto}://${req.get("host")}`;
  res.json({
    openapi: "3.1.0",
    info: {
      title: "GottaRemoteMCP Commander API",
      version: "0.2.0",
      description:
        "Control remoto completo de escritorio, archivos y terminal para agentes Gemini y ChatGPT sin verificación de cuenta.",
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        BearerAuth: { type: "http", scheme: "bearer" },
      },
    },
    security: [{ BearerAuth: [] }],
    paths: {
      "/api/execute": {
        post: {
          operationId: "executeCommand",
          summary: "Ejecuta un comando shell/bash/powershell en el ordenador remoto",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["command"],
                  properties: {
                    command: { type: "string", description: "Comando a ejecutar" },
                    ...sshCredentialProperties,
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Resultado del comando" } },
        },
      },
      "/api/input": {
        post: {
          operationId: "inputAction",
          summary: "Simula clics de ratón, arrastrar, scroll, movimiento de cursor y teclado",
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
                    ...sshCredentialProperties,
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Acción ejecutada" } },
        },
      },
      "/api/screenshot": {
        get: {
          operationId: "takeScreenshot",
          summary: "Obtiene una captura de pantalla del escritorio remoto en Base64",
          responses: { "200": { description: "Imagen en Base64" } },
        },
      },
      "/api/files/read": {
        post: {
          operationId: "readFile",
          summary: "Lee el contenido de un archivo local o remoto por SFTP/SSH",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["path"],
                  properties: {
                    path: { type: "string" },
                    ...sshCredentialProperties,
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Contenido del archivo" } },
        },
      },
      "/api/files/write": {
        post: {
          operationId: "writeFile",
          summary: "Escribe contenido en un archivo local o remoto por SFTP/SSH",
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
                    ...sshCredentialProperties,
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Confirmación de escritura" } },
        },
      },
      "/api/files/list": {
        post: {
          operationId: "listDirectory",
          summary: "Lista archivos y carpetas de un directorio local o remoto",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["path"],
                  properties: {
                    path: { type: "string" },
                    ...sshCredentialProperties,
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Listado de archivos" } },
        },
      },
      "/api/processes": {
        get: {
          operationId: "listProcesses",
          summary: "Lista los procesos activos con mayor consumo de CPU",
          responses: { "200": { description: "Listado de procesos" } },
        },
      },
      "/api/status": {
        get: {
          operationId: "systemStatus",
          summary: "Devuelve el uso de CPU, RAM, SO y estado del sistema remoto",
          responses: { "200": { description: "Estado del sistema" } },
        },
      },
    },
  });
});

async function main() {
  if (process.argv.includes("--stdio")) {
    const mcpServer = createMcpServer();
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    return;
  }

  app.listen(PORT, async () => {
    console.log(`GottaRemoteMCP v0.2.0 activo en http://localhost:${PORT}`);
    console.log(`OpenAPI Spec (ChatGPT / Gemini): http://localhost:${PORT}/openapi.json`);
    console.log(`MCP SSE Endpoint: http://localhost:${PORT}/mcp/sse`);

    if (process.argv.includes("--tunnel") || process.env.ENABLE_TUNNEL === "true") {
      try {
        publicTunnelUrl = await startQuickTunnel(PORT, AUTH_SECRET);
      } catch (err: any) {
        console.error(`Aviso: No se pudo iniciar el túnel automático: ${err.message}`);
      }
    }
  });
}

main().catch(console.error);
