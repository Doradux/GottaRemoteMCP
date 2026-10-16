import { spawn, ChildProcess } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { resolveSSHCredentials, runRemoteOrLocalCommand, SSHCredentials } from "./ssh.js";
import { readRemoteOrLocalFile, writeRemoteOrLocalFile } from "./files.js";

export interface ActiveSession {
  pid: number;
  command: string;
  cwd: string;
  startedAt: string;
  status: "running" | "exited";
  exitCode: number | null;
  outputBuffer: string;
  process?: ChildProcess;
}

const activeSessions = new Map<number, ActiveSession>();
let currentLocalCwd = os.homedir();
let currentRemoteCwd = "~";

export function getCurrentCwd(creds?: SSHCredentials): string {
  const resolved = resolveSSHCredentials(creds);
  return resolved.isRemote ? currentRemoteCwd : currentLocalCwd;
}

export function setCurrentCwd(newCwd: string, creds?: SSHCredentials): string {
  const resolved = resolveSSHCredentials(creds);
  if (resolved.isRemote) {
    currentRemoteCwd = newCwd;
    return currentRemoteCwd;
  }
  currentLocalCwd = path.resolve(currentLocalCwd, newCwd);
  return currentLocalCwd;
}

/**
 * Ejecuta un comando manteniendo el directorio de trabajo (cwd) entre llamadas
 * y soportando procesos de larga duración en segundo plano sin bloquear el chat.
 */
export async function executeCommander(
  command: string,
  options: {
    cwd?: string;
    timeoutMs?: number;
    creds?: SSHCredentials;
  } = {}
): Promise<{
  cwd: string;
  pid?: number;
  status: "completed" | "running_in_background" | "error";
  exitCode: number | null;
  output: string;
}> {
  const resolved = resolveSSHCredentials(options.creds);
  const timeoutMs = options.timeoutMs ?? 8000;

  if (resolved.isRemote) {
    const targetCwd = options.cwd || currentRemoteCwd;
    const wrappedCmd = `cd ${targetCwd} 2>/dev/null || true; ${command}; echo ""; echo "__GOTTA_CWD__:$(pwd)"`;
    try {
      const rawOutput = await runRemoteOrLocalCommand(wrappedCmd, options.creds);
      const cwdMatch = rawOutput.match(/__GOTTA_CWD__:([^\r\n]+)/);
      if (cwdMatch) {
        currentRemoteCwd = cwdMatch[1].trim();
      }
      const cleanOutput = rawOutput.replace(/\n?__GOTTA_CWD__:[^\r\n]+/, "").trim();
      return {
        cwd: currentRemoteCwd,
        status: "completed",
        exitCode: 0,
        output: cleanOutput || "(Comando completado sin salida)",
      };
    } catch (err: any) {
      return {
        cwd: currentRemoteCwd,
        status: "error",
        exitCode: 1,
        output: err.message,
      };
    }
  }

  // Modo Local con soporte de sesiones interactivas/background y persistencia de CWD
  const startCwd = options.cwd ? path.resolve(currentLocalCwd, options.cwd) : currentLocalCwd;
  const wrappedLocalCmd = `${command}\n__EC=$?; pwd > /tmp/.gotta_cwd_$$; exit $__EC`;

  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", wrappedLocalCmd], {
      cwd: startCwd,
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ":0",
        PAGER: "cat",
        DEBIAN_FRONTEND: "noninteractive",
      },
    });

    const pid = child.pid || Math.floor(Math.random() * 90000 + 10000);
    const session: ActiveSession = {
      pid,
      command,
      cwd: startCwd,
      startedAt: new Date().toISOString(),
      status: "running",
      exitCode: null,
      outputBuffer: "",
      process: child,
    };

    activeSessions.set(pid, session);
    let finished = false;

    const appendOutput = (chunk: Buffer) => {
      session.outputBuffer += chunk.toString();
      if (session.outputBuffer.length > 200_000) {
        session.outputBuffer = session.outputBuffer.slice(-200_000);
      }
    };

    child.stdout.on("data", appendOutput);
    child.stderr.on("data", (chunk: Buffer) => {
      appendOutput(Buffer.from(`[STDERR] ${chunk.toString()}`));
    });

    const finalizeSession = async (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      session.status = "exited";
      session.exitCode = code;

      try {
        const cwdFile = `/tmp/.gotta_cwd_${child.pid}`;
        const updatedCwd = (await fs.readFile(cwdFile, "utf8")).trim();
        if (updatedCwd) {
          currentLocalCwd = updatedCwd;
          session.cwd = updatedCwd;
        }
        await fs.unlink(cwdFile).catch(() => {});
      } catch {
        // Ignorar si el comando no actualizó cwd
      }

      resolve({
        cwd: currentLocalCwd,
        pid,
        status: "completed",
        exitCode: code,
        output: session.outputBuffer.trim() || "(Comando completado sin salida)",
      });
    };

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        resolve({
          cwd: currentLocalCwd,
          pid,
          status: "running_in_background",
          exitCode: null,
          output:
            (session.outputBuffer.trim() || "(Proceso iniciado en segundo plano)") +
            `\n[INFO] El comando sigue ejecutándose en segundo plano con PID ${pid}. Usa session-output?pid=${pid} para leer más salida o kill?pid=${pid} para detenerlo.`,
        });
      }
    }, timeoutMs);

    child.on("exit", (code) => {
      // Pequeño margen de 80ms para vaciar buffers stdout/stderr incluso si un subproceso GUI en background hereda descriptores
      setTimeout(() => finalizeSession(code), 80);
    });

    child.on("close", (code) => {
      finalizeSession(code);
    });

    child.on("error", (err) => {
      session.status = "exited";
      session.exitCode = 1;
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({
          cwd: currentLocalCwd,
          pid,
          status: "error",
          exitCode: 1,
          output: err.message,
        });
      }
    });
  });
}

export function listActiveSessions(): Array<Omit<ActiveSession, "process">> {
  return Array.from(activeSessions.values()).map(({ process: _p, ...rest }) => rest);
}

export function getSessionOutput(pid: number): Omit<ActiveSession, "process"> | null {
  const s = activeSessions.get(pid);
  if (!s) return null;
  const { process: _p, ...rest } = s;
  return rest;
}

export async function terminateProcessOrSession(
  pid: number,
  creds?: SSHCredentials
): Promise<string> {
  const session = activeSessions.get(pid);
  if (session && session.process) {
    session.process.kill("SIGTERM");
    session.status = "exited";
    return `Sesión PID ${pid} (${session.command}) terminada.`;
  }
  const out = await runRemoteOrLocalCommand(`kill -9 ${Number(pid)} 2>&1 || taskkill /F /PID ${Number(pid)}`, creds);
  return `Proceso ${pid} terminado. ${out}`.trim();
}

/**
 * Edición quirúrgica de bloques de texto (como edit_block de Desktop Commander)
 */
export async function editFileBlock(
  filePath: string,
  search: string,
  replace: string,
  creds?: SSHCredentials
): Promise<string> {
  const resolved = resolveSSHCredentials(creds);
  const targetPath = resolved.isRemote ? filePath : path.resolve(currentLocalCwd, filePath);
  const content = await readRemoteOrLocalFile(targetPath, creds);

  if (!content.includes(search)) {
    throw new Error(
      `No se encontró el bloque exacto a reemplazar en ${targetPath}. Verifica las líneas con read_file.`
    );
  }

  const updated = content.replace(search, replace);
  await writeRemoteOrLocalFile(targetPath, updated, creds);
  return `Bloque reemplazado correctamente en ${targetPath}`;
}

/**
 * Lectura de archivos con soporte de rango de líneas (offset / limit)
 */
export async function readFileLines(
  filePath: string,
  startLine?: number,
  endLine?: number,
  creds?: SSHCredentials
): Promise<{ path: string; totalLines: number; content: string }> {
  const resolved = resolveSSHCredentials(creds);
  const targetPath = resolved.isRemote ? filePath : path.resolve(currentLocalCwd, filePath);
  const raw = await readRemoteOrLocalFile(targetPath, creds);
  const lines = raw.split(/\r?\n/);

  const start = startLine ? Math.max(1, startLine) : 1;
  const end = endLine ? Math.min(lines.length, endLine) : lines.length;
  const sliced = lines
    .slice(start - 1, end)
    .map((line, idx) => `${start + idx}: ${line}`)
    .join("\n");

  return {
    path: targetPath,
    totalLines: lines.length,
    content: sliced,
  };
}

/**
 * Búsqueda rápida de código o archivos (ripgrep / grep)
 */
export async function searchInCode(
  query: string,
  searchPath?: string,
  creds?: SSHCredentials
): Promise<string> {
  const resolved = resolveSSHCredentials(creds);
  const dir = searchPath || (resolved.isRemote ? currentRemoteCwd : currentLocalCwd);
  const safeQuery = query.replace(/"/g, '\\"');
  const safeDir = dir.replace(/"/g, '\\"');
  const cmd = `(rg -n --max-count 50 "${safeQuery}" "${safeDir}" 2>/dev/null || grep -rnI --max-count=50 "${safeQuery}" "${safeDir}" 2>/dev/null) | head -n 120`;
  const out = await runRemoteOrLocalCommand(cmd, creds);
  return out || "Sin coincidencias.";
}
