import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import os from "os";
import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { Client as SSHClient } from "ssh2";
import screenshot from "screenshot-desktop";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

dotenv.config();
const execAsync = promisify(exec);

const AUTH_SECRET = process.env.AUTH_SECRET || "admin123";
const PORT = parseInt(process.env.PORT || "3000", 10);

export interface SSHCredentials {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
}

// Ejecutor híbrido: corre en local o por SSH pasando credenciales directas sin verificación de cuenta
export async function runRemoteOrLocalCommand(command: string, creds?: SSHCredentials): Promise<string> {
  const host = creds?.host || process.env.SSH_HOST;
  const username = creds?.username || process.env.SSH_USER;
  const password = creds?.password || process.env.SSH_PASSWORD;
  const privateKeyPath = process.env.SSH_PRIVATE_KEY_PATH;
  const privateKey =
    creds?.privateKey ||
    (privateKeyPath && fs.existsSync(privateKeyPath)
      ? fs.readFileSync(privateKeyPath, "utf8")
      : undefined);
  const port = creds?.port || parseInt(process.env.SSH_PORT || "22", 10);

  if (host && username && (password || privateKey)) {
    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      let output = "";
      conn
        .on("ready", () => {
          conn.exec(command, (err, stream) => {
            if (err) {
              conn.end();
              return reject(err);
            }
            stream
              .on("close", () => {
                conn.end();
                resolve(output.trim());
              })
              .on("data", (data: Buffer) => {
                output += data.toString();
              })
              .stderr.on("data", (data: Buffer) => {
                output += `[STDERR] ${data.toString()}`;
              });
          });
        })
        .on("error", (err) => reject(err))
        .connect({ host, port, username, password, privateKey });
    });
  }

  const { stdout, stderr } = await execAsync(command);
  return (stdout || stderr).trim();
}

// Captura de pantalla en Base64
export async function captureScreenBase64(): Promise<string> {
  const imgBuffer = await screenshot({ format: "png" });
  return imgBuffer.toString("base64");
}

// Control de ratón y teclado
export async function performDesktopInput(
  action: string,
  params: Record<string, any>,
  creds?: SSHCredentials
): Promise<string> {
  let cmd = "";
  if (action === "click") {
    const { x, y, button = 1 } = params;
    cmd =
      x !== undefined && y !== undefined
        ? `xdotool mousemove ${Number(x)} ${Number(y)} click ${Number(button)}`
        : `xdotool click ${Number(button)}`;
  } else if (action === "move") {
    const { x, y } = params;
    cmd = `xdotool mousemove ${Number(x)} ${Number(y)}`;
  } else if (action === "type") {
    const { text } = params;
    const safeText = String(text ?? "").replace(/"/g, '\\"');
    cmd = `xdotool type -- "${safeText}"`;
  } else if (action === "key") {
    const { key } = params;
    cmd = `xdotool key ${String(key ?? "")}`;
  } else {
    throw new Error(`Acción no soportada: ${action}`);
  }
  return await runRemoteOrLocalCommand(cmd, creds);
}

// Estado del sistema (local o remoto vía SSH)
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
    { name: "gotta-remote-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "execute_command",
        description:
          "Ejecuta un comando de terminal en el ordenador remoto (local o vía credenciales SSH directas).",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Comando bash/shell/powershell a ejecutar" },
            host: { type: "string", description: "IP/Host SSH opcional" },
            port: { type: "number", description: "Puerto SSH opcional (por defecto 22)" },
            username: { type: "string", description: "Usuario SSH opcional" },
            password: { type: "string", description: "Contraseña SSH opcional" },
            privateKey: { type: "string", description: "Clave privada SSH en PEM opcional" },
          },
          required: ["command"],
        },
      },
      {
        name: "take_screenshot",
        description:
          "Toma una captura de pantalla del escritorio remoto y devuelve la imagen en Base64.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "input_action",
        description:
          "Simula clics de ratón, movimiento de cursor y pulsaciones de teclado (click, move, type, key).",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["click", "move", "type", "key"] },
            x: { type: "number", description: "Coordenada X de pantalla" },
            y: { type: "number", description: "Coordenada Y de pantalla" },
            button: { type: "number", description: "Botón del ratón (1=izq, 2=medio, 3=der)" },
            text: { type: "string", description: "Texto a escribir cuando action='type'" },
            key: { type: "string", description: "Tecla o combinación cuando action='key' (ej. Return, ctrl+c)" },
            host: { type: "string" },
            port: { type: "number" },
            username: { type: "string" },
            password: { type: "string" },
          },
          required: ["action"],
        },
      },
      {
        name: "system_status",
        description:
          "Devuelve uso de CPU, RAM, SO y red para dar contexto rápido al agente sobre el ordenador remoto.",
        inputSchema: {
          type: "object",
          properties: {
            host: { type: "string" },
            port: { type: "number" },
            username: { type: "string" },
            password: { type: "string" },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const creds: SSHCredentials = {
      host: args.host as string | undefined,
      port: args.port as number | undefined,
      username: args.username as string | undefined,
      password: args.password as string | undefined,
      privateKey: args.privateKey as string | undefined,
    };

    if (name === "execute_command") {
      const output = await runRemoteOrLocalCommand(String(args.command), creds);
      return { content: [{ type: "text", text: output || "Comando ejecutado sin salida." }] };
    }

    if (name === "take_screenshot") {
      const b64 = await captureScreenBase64();
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
// 2. SERVIDOR HTTP + SSE MCP + OPENAPI 3.1 (Para ChatGPT Actions y Gemini)
// ============================================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

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

// Endpoints REST para ChatGPT Actions y Gemini Function Calling
app.post("/api/execute", async (req, res) => {
  try {
    const { command, host, port, username, password, privateKey } = req.body;
    const output = await runRemoteOrLocalCommand(command, {
      host,
      port,
      username,
      password,
      privateKey,
    });
    res.json({ success: true, output });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/input", async (req, res) => {
  try {
    const { action, host, port, username, password, privateKey, ...params } = req.body;
    const output = await performDesktopInput(action, params, {
      host,
      port,
      username,
      password,
      privateKey,
    });
    res.json({ success: true, output });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/screenshot", async (_req, res) => {
  try {
    const base64 = await captureScreenBase64();
    res.json({ success: true, mimeType: "image/png", base64 });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/status", async (req, res) => {
  try {
    const status = await getSystemStatus({
      host: req.query.host as string | undefined,
      username: req.query.username as string | undefined,
      password: req.query.password as string | undefined,
    });
    res.json({ success: true, status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Transporte MCP sobre SSE para conexiones remotas directas sin verificación de cuenta
const sseTransports = new Map<string, SSEServerTransport>();

app.get("/mcp/sse", verifyAuth, async (req, res) => {
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
  const serverUrl = `${proto}://${req.get("host")}`;
  res.json({
    openapi: "3.1.0",
    info: {
      title: "GottaRemoteMCP Commander API",
      version: "0.1.0",
      description:
        "Control remoto de escritorio y terminal para agentes Gemini y ChatGPT sin verificación de cuenta.",
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
                    host: { type: "string", description: "Host SSH opcional" },
                    port: { type: "number", description: "Puerto SSH opcional" },
                    username: { type: "string", description: "Usuario SSH opcional" },
                    password: { type: "string", description: "Contraseña SSH opcional" },
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
          summary: "Simula clics de ratón, movimiento de cursor y pulsaciones de teclado",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["action"],
                  properties: {
                    action: { type: "string", enum: ["click", "move", "type", "key"] },
                    x: { type: "number" },
                    y: { type: "number" },
                    button: { type: "number" },
                    text: { type: "string" },
                    key: { type: "string" },
                    host: { type: "string" },
                    username: { type: "string" },
                    password: { type: "string" },
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
  } else {
    app.listen(PORT, () => {
      console.log(`GottaRemoteMCP HTTP/OpenAPI Server activo en http://localhost:${PORT}`);
      console.log(`OpenAPI Spec (ChatGPT / Gemini): http://localhost:${PORT}/openapi.json`);
      console.log(`MCP SSE Endpoint: http://localhost:${PORT}/mcp/sse`);
    });
  }
}

main().catch(console.error);
