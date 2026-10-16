import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { Client as SSHClient } from "ssh2";

const execAsync = promisify(exec);

export interface SSHCredentials {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
}

export function resolveSSHCredentials(creds?: SSHCredentials): SSHCredentials & { isRemote: boolean } {
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

  const isRemote = Boolean(host && username && (password || privateKey));
  return { host, port, username, password, privateKey, isRemote };
}

export async function runRemoteOrLocalCommand(
  command: string,
  creds?: SSHCredentials
): Promise<string> {
  const resolved = resolveSSHCredentials(creds);

  if (resolved.isRemote) {
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
        .connect({
          host: resolved.host,
          port: resolved.port,
          username: resolved.username,
          password: resolved.password,
          privateKey: resolved.privateKey,
        });
    });
  }

  const { stdout, stderr } = await execAsync(command, { maxBuffer: 15 * 1024 * 1024 });
  return (stdout || stderr).trim();
}
