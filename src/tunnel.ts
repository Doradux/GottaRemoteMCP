import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";

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
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
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
  } catch {
    // No está instalado globalmente; descargamos binario autónomo en ~/.cache/gotta-remote-mcp
  }

  const cacheDir = path.join(os.homedir(), ".cache", "gotta-remote-mcp");
  fs.mkdirSync(cacheDir, { recursive: true });
  const binName = os.platform() === "win32" ? "cloudflared.exe" : "cloudflared";
  const binPath = path.join(cacheDir, binName);

  if (fs.existsSync(binPath)) {
    return binPath;
  }

  const downloadUrl = getCloudflaredBinaryUrl();
  if (!downloadUrl) {
    throw new Error(
      "Instala 'cloudflared' manualmente para usar --tunnel en esta plataforma (ej. brew install cloudflared)."
    );
  }

  console.log("Descargando binario de Cloudflare Quick Tunnel (sin cuenta requerida)...");
  await downloadFileFollowRedirects(downloadUrl, binPath);
  if (os.platform() !== "win32") {
    fs.chmodSync(binPath, 0o755);
  }
  return binPath;
}

export async function startQuickTunnel(port: number, authSecret: string): Promise<string> {
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
        const publicUrl = match[0];
        console.log("\n==================================================================");
        console.log("TUNEL PUBLICO ACTIVO (Sin verificacion de cuenta)");
        console.log(`URL Base Publica      : ${publicUrl}`);
        console.log(`OpenAPI (ChatGPT/Gem) : ${publicUrl}/openapi.json`);
        console.log(`MCP SSE Endpoint      : ${publicUrl}/mcp/sse`);
        console.log(`Bearer Token (Header) : ${authSecret}`);
        console.log("==================================================================\n");
        resolve(publicUrl);
      }
    };

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);

    child.on("error", (err) => {
      if (!resolved) reject(err);
    });

    setTimeout(() => {
      if (!resolved) {
        reject(new Error("Tiempo de espera agotado al iniciar Cloudflare Quick Tunnel"));
      }
    }, 25000);
  });
}
