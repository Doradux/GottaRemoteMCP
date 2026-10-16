import fs from "fs/promises";
import path from "path";
import { Client as SSHClient } from "ssh2";
import { resolveSSHCredentials, runRemoteOrLocalCommand, SSHCredentials } from "./ssh.js";

export async function readRemoteOrLocalFile(
  filePath: string,
  creds?: SSHCredentials
): Promise<string> {
  const resolved = resolveSSHCredentials(creds);
  if (!resolved.isRemote) {
    return await fs.readFile(filePath, "utf8");
  }

  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    conn
      .on("ready", () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          sftp.readFile(filePath, "utf8", (readErr, data) => {
            conn.end();
            if (readErr) return reject(readErr);
            resolve(data.toString());
          });
        });
      })
      .on("error", reject)
      .connect({
        host: resolved.host,
        port: resolved.port,
        username: resolved.username,
        password: resolved.password,
        privateKey: resolved.privateKey,
      });
  });
}

export async function writeRemoteOrLocalFile(
  filePath: string,
  content: string,
  creds?: SSHCredentials
): Promise<string> {
  const resolved = resolveSSHCredentials(creds);
  if (!resolved.isRemote) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
    return `Archivo guardado en ${filePath} (${Buffer.byteLength(content)} bytes)`;
  }

  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    conn
      .on("ready", () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          sftp.writeFile(filePath, Buffer.from(content, "utf8"), (writeErr) => {
            conn.end();
            if (writeErr) return reject(writeErr);
            resolve(`Archivo remoto guardado en ${filePath} (${Buffer.byteLength(content)} bytes)`);
          });
        });
      })
      .on("error", reject)
      .connect({
        host: resolved.host,
        port: resolved.port,
        username: resolved.username,
        password: resolved.password,
        privateKey: resolved.privateKey,
      });
  });
}

export async function listRemoteOrLocalDirectory(
  dirPath: string,
  creds?: SSHCredentials
): Promise<Array<{ name: string; type: string; size: number }>> {
  const resolved = resolveSSHCredentials(creds);
  if (!resolved.isRemote) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const results = await Promise.all(
      entries.map(async (entry) => {
        try {
          const stat = await fs.stat(path.join(dirPath, entry.name));
          return {
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
            size: stat.size,
          };
        } catch {
          return {
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
            size: 0,
          };
        }
      })
    );
    return results;
  }

  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    conn
      .on("ready", () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          sftp.readdir(dirPath, (readErr, list) => {
            conn.end();
            if (readErr) return reject(readErr);
            resolve(
              list.map((item) => ({
                name: item.filename,
                type: item.longname.startsWith("d") ? "directory" : "file",
                size: item.attrs.size,
              }))
            );
          });
        });
      })
      .on("error", reject)
      .connect({
        host: resolved.host,
        port: resolved.port,
        username: resolved.username,
        password: resolved.password,
        privateKey: resolved.privateKey,
      });
  });
}

export async function listProcesses(creds?: SSHCredentials): Promise<string> {
  return await runRemoteOrLocalCommand(
    "ps aux --sort=-%cpu | head -n 25 2>/dev/null || tasklist",
    creds
  );
}
