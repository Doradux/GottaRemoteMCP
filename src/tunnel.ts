import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";

/**
 * Inicia un túnel HTTPS directo mediante localhost.run (SSH estándar, sin WAF de Cloudflare
 * que bloquee al navegador integrado de ChatGPT Web o Gemini Web).
 */
function startLocalhostRunTunnel(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      [
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ServerAliveInterval=30",
        "-R",
        `80:localhost:${port}`,
        "nokey@localhost.run",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let resolved = false;
    const lhrRegex = /https:\/\/[a-zA-Z0-9-]+\.lhr\.life/;

    const onData = (data: Buffer) => {
      const text = data.toString();
      const match = text.match(lhrRegex);
      if (match && !resolved) {
        resolved = true;
        resolve(match[0]);
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", (err) => {
      if (!resolved) reject(err);
    });

    child.on("close", () => {
      if (!resolved) reject(new Error("SSH localhost.run cerró antes de asignar URL"));
    });

    setTimeout(() => {
      if (!resolved) {
        child.kill();
        reject(new Error("Timeout esperando túnel localhost.run"));
      }
    }, 12000);
  });
}

function getCloudflaredBinaryUrl(): string | null {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === "linux") {
    if (arch === "x64") {
      return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
    }
    if (arch === "arm64") {
      return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64";
    }
  } else if (platform === "win32") {
    return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
  }
  return null;
}

function downloadFileFollowRedirects(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = (currentUrl: string) => {
      https
        .get(currentUrl, (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            return request(res.headers.location);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`Error descargando cloudflared: HTTP ${res.statusCode}`));
          }
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on("finish", () => {
            file.close();
            resolve();
          });
        })
        .on("error", reject);
    };
    request(url);
  });
}

async function ensureCloudflaredBinary(): Promise<string> {
  try {
    execSync(os.platform() === "win32" ? "where cloudflared" : "command -v cloudflared", {
      stdio: "ignore",
    });
    return "cloudflared";
  } catch {}

  const cacheDir = path.join(os.homedir(), ".cache", "gotta-remote-mcp");
  fs.mkdirSync(cacheDir, { recursive: true });
  const binName = os.platform() === "win32" ? "cloudflared.exe" : "cloudflared";
  const binPath = path.join(cacheDir, binName);

  if (fs.existsSync(binPath)) {
    return binPath;
  }

  const downloadUrl = getCloudflaredBinaryUrl();
  if (!downloadUrl) {
    throw new Error("Instala 'cloudflared' o 'ssh' para usar túnel público.");
  }

  await downloadFileFollowRedirects(downloadUrl, binPath);
  if (os.platform() !== "win32") {
    fs.chmodSync(binPath, 0o755);
  }
  return binPath;
}

async function startCloudflaredTunnel(port: number): Promise<string> {
  const bin = await ensureCloudflaredBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["tunnel", "--url", `http://localhost:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;
    const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

    const handleChunk = (data: Buffer) => {
      const text = data.toString();
      const match = text.match(urlRegex);
      if (match && !resolved) {
        resolved = true;
        resolve(match[0]);
      }
    };

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);
    child.on("error", (err) => {
      if (!resolved) reject(err);
    });

    setTimeout(() => {
      if (!resolved) {
        reject(new Error("Timeout al iniciar Cloudflare Quick Tunnel"));
      }
    }, 20000);
  });
}

export async function startQuickTunnel(port: number): Promise<string> {
  if (process.env.TUNNEL_PROVIDER !== "cloudflare") {
    try {
      return await startLocalhostRunTunnel(port);
    } catch {
      // Fallback a cloudflared si SSH no está disponible
    }
  }
  return await startCloudflaredTunnel(port);
}
