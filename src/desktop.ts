import os from "os";
import screenshot from "screenshot-desktop";
import { runRemoteOrLocalCommand, SSHCredentials } from "./ssh.js";

export type DesktopAction =
  | "click"
  | "double_click"
  | "right_click"
  | "move"
  | "drag"
  | "scroll"
  | "type"
  | "key";

export interface DesktopInputParams {
  action: DesktopAction;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  button?: number;
  scrollAmount?: number;
  text?: string;
  key?: string;
}

async function detectPlatform(creds?: SSHCredentials): Promise<"linux" | "win32" | "darwin"> {
  const isRemote = Boolean(creds?.host || process.env.SSH_HOST);
  if (!isRemote) {
    const p = os.platform();
    if (p === "win32") return "win32";
    if (p === "darwin") return "darwin";
    return "linux";
  }

  try {
    const uname = await runRemoteOrLocalCommand("uname -s 2>/dev/null || ver", creds);
    const lower = uname.toLowerCase();
    if (lower.includes("windows") || lower.includes("microsoft")) return "win32";
    if (lower.includes("darwin")) return "darwin";
    return "linux";
  } catch {
    return "linux";
  }
}

export async function performDesktopInput(
  action: string,
  params: Record<string, any>,
  creds?: SSHCredentials
): Promise<string> {
  const platform = await detectPlatform(creds);

  if (platform === "win32") {
    return performWindowsInput(action, params, creds);
  }
  if (platform === "darwin") {
    return performMacInput(action, params, creds);
  }
  return performLinuxInput(action, params, creds);
}

async function performLinuxInput(
  action: string,
  params: Record<string, any>,
  creds?: SSHCredentials
): Promise<string> {
  const envPrefix = "export DISPLAY=${DISPLAY:-:0}; ";
  const x = params.x !== undefined ? Math.round(Number(params.x)) : undefined;
  const y = params.y !== undefined ? Math.round(Number(params.y)) : undefined;
  const toX = params.toX !== undefined ? Math.round(Number(params.toX)) : undefined;
  const toY = params.toY !== undefined ? Math.round(Number(params.toY)) : undefined;

  let xdoCmd = "";
  let ydoCmd = "";

  if (action === "click" || action === "double_click" || action === "right_click") {
    const btn = action === "right_click" ? 3 : Number(params.button || 1);
    const repeat = action === "double_click" ? "--repeat 2" : "";
    const movePart = x !== undefined && y !== undefined ? `mousemove ${x} ${y} ` : "";
    xdoCmd = `xdotool ${movePart}click ${repeat} ${btn}`.trim();
    const ydoBtn = btn === 3 ? "0xC1" : "0xC0";
    ydoCmd =
      x !== undefined && y !== undefined
        ? `ydotool mousemove --absolute -x ${x} -y ${y} && ydotool click ${ydoBtn}`
        : `ydotool click ${ydoBtn}`;
  } else if (action === "move") {
    if (x === undefined || y === undefined) {
      throw new Error("x e y son requeridos para action='move'");
    }
    xdoCmd = `xdotool mousemove ${x} ${y}`;
    ydoCmd = `ydotool mousemove --absolute -x ${x} -y ${y}`;
  } else if (action === "drag") {
    if (x === undefined || y === undefined || toX === undefined || toY === undefined) {
      throw new Error("x, y, toX y toY son requeridos para action='drag'");
    }
    xdoCmd = `xdotool mousemove ${x} ${y} mousedown 1 mousemove ${toX} ${toY} mouseup 1`;
    ydoCmd = `ydotool mousemove --absolute -x ${x} -y ${y} && ydotool click 0x40 && ydotool mousemove --absolute -x ${toX} -y ${toY} && ydotool click 0x80`;
  } else if (action === "scroll") {
    const amount = Number(params.scrollAmount ?? 3);
    const btn = amount >= 0 ? 5 : 4; // 4=up, 5=down
    const clicks = Math.max(1, Math.abs(Math.round(amount)));
    xdoCmd = `xdotool click --repeat ${clicks} ${btn}`;
    ydoCmd = `ydotool mousemove -w -- 0 ${-amount}`;
  } else if (action === "type") {
    const safeText = String(params.text ?? "").replace(/"/g, '\\"');
    xdoCmd = `xdotool type --delay 12 -- "${safeText}"`;
    ydoCmd = `wtype "${safeText}" 2>/dev/null || ydotool type "${safeText}"`;
  } else if (action === "key") {
    const key = String(params.key ?? "Return");
    xdoCmd = `xdotool key ${key}`;
    ydoCmd = `wtype -k "${key}" 2>/dev/null || xdotool key ${key}`;
  } else {
    throw new Error(`Acción no soportada: ${action}`);
  }

  const combined = `${envPrefix}(${xdoCmd}) 2>/dev/null || (${ydoCmd})`;
  return await runRemoteOrLocalCommand(combined, creds);
}

async function performWindowsInput(
  action: string,
  params: Record<string, any>,
  creds?: SSHCredentials
): Promise<string> {
  const x = params.x !== undefined ? Math.round(Number(params.x)) : undefined;
  const y = params.y !== undefined ? Math.round(Number(params.y)) : undefined;

  let psScript = `Add-Type -AssemblyName System.Windows.Forms; `;

  if (action === "move" || action === "click" || action === "double_click" || action === "right_click") {
    if (x !== undefined && y !== undefined) {
      psScript += `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y}); `;
    }
    if (action !== "move") {
      psScript += `
$sig = '[DllImport("user32.dll",CharSet=CharSet.Auto, CallingConvention=CallingConvention.StdCall)] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);';
$mouse = Add-Type -MemberDefinition $sig -Name "Win32MouseEvent" -Namespace Win32Functions -PassThru;
`;
      if (action === "right_click" || Number(params.button) === 3) {
        psScript += `$mouse::mouse_event(0x0008, 0, 0, 0, 0); $mouse::mouse_event(0x0010, 0, 0, 0, 0);`;
      } else if (action === "double_click") {
        psScript += `$mouse::mouse_event(0x0002, 0, 0, 0, 0); $mouse::mouse_event(0x0004, 0, 0, 0, 0); Start-Sleep -Milliseconds 60; $mouse::mouse_event(0x0002, 0, 0, 0, 0); $mouse::mouse_event(0x0004, 0, 0, 0, 0);`;
      } else {
        psScript += `$mouse::mouse_event(0x0002, 0, 0, 0, 0); $mouse::mouse_event(0x0004, 0, 0, 0, 0);`;
      }
    }
  } else if (action === "type") {
    const escaped = String(params.text ?? "").replace(/'/g, "''");
    psScript += `[System.Windows.Forms.SendKeys]::SendWait('${escaped}');`;
  } else if (action === "key") {
    const escaped = String(params.key ?? "{ENTER}").replace(/'/g, "''");
    psScript += `[System.Windows.Forms.SendKeys]::SendWait('${escaped}');`;
  } else {
    throw new Error(`Acción no soportada en Windows: ${action}`);
  }

  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  return await runRemoteOrLocalCommand(`powershell -NoProfile -EncodedCommand ${encoded}`, creds);
}

async function performMacInput(
  action: string,
  params: Record<string, any>,
  creds?: SSHCredentials
): Promise<string> {
  const x = params.x !== undefined ? Math.round(Number(params.x)) : 0;
  const y = params.y !== undefined ? Math.round(Number(params.y)) : 0;

  if (action === "type") {
    const safeText = String(params.text ?? "").replace(/"/g, '\\"');
    return await runRemoteOrLocalCommand(
      `osascript -e 'tell application "System Events" to keystroke "${safeText}"'`,
      creds
    );
  }
  if (action === "key") {
    const safeKey = String(params.key ?? "return").replace(/"/g, '\\"');
    return await runRemoteOrLocalCommand(
      `osascript -e 'tell application "System Events" to key code "${safeKey}"' 2>/dev/null || cliclick kp:${safeKey}`,
      creds
    );
  }
  if (action === "click" || action === "right_click" || action === "double_click") {
    const flag = action === "right_click" ? "rc" : action === "double_click" ? "dc" : "c";
    return await runRemoteOrLocalCommand(`cliclick ${flag}:${x},${y}`, creds);
  }
  if (action === "move") {
    return await runRemoteOrLocalCommand(`cliclick m:${x},${y}`, creds);
  }
  throw new Error(`Acción no soportada en macOS: ${action}`);
}

export async function captureScreenBase64(creds?: SSHCredentials): Promise<string> {
  const isRemote = Boolean(creds?.host || process.env.SSH_HOST);

  if (!isRemote) {
    try {
      const imgBuffer = await screenshot({ format: "png" });
      return imgBuffer.toString("base64");
    } catch {
      // Fallback a herramientas nativas de CLI si screenshot-desktop falla en Wayland/X11
    }
  }

  const platform = await detectPlatform(creds);
  if (platform === "win32") {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;
$graphics = [System.Drawing.Graphics]::FromImage($bmp);
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);
$ms = New-Object System.IO.MemoryStream;
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);
[Convert]::ToBase64String($ms.ToArray());
`;
    const encoded = Buffer.from(ps, "utf16le").toString("base64");
    const out = await runRemoteOrLocalCommand(
      `powershell -NoProfile -EncodedCommand ${encoded}`,
      creds
    );
    return out.trim();
  }

  if (platform === "darwin") {
    const out = await runRemoteOrLocalCommand(
      `screencapture -x -t png /tmp/gotta_screen.png && base64 < /tmp/gotta_screen.png | tr -d '\\n' && rm -f /tmp/gotta_screen.png`,
      creds
    );
    return out.trim();
  }

  // Linux (X11 / Wayland): prueba grim, scrot, gnome-screenshot o ImageMagick import
  const linuxCmd = `export DISPLAY=\${DISPLAY:-:0}; TMPF=/tmp/gotta_screen_$$.png; (grim "$TMPF" 2>/dev/null || scrot "$TMPF" 2>/dev/null || gnome-screenshot -f "$TMPF" 2>/dev/null || import -window root "$TMPF" 2>/dev/null) && base64 -w0 "$TMPF" && rm -f "$TMPF"`;
  const out = await runRemoteOrLocalCommand(linuxCmd, creds);
  if (!out || out.startsWith("[STDERR]")) {
    throw new Error(
      `No se pudo capturar pantalla. Instala scrot, grim o imagemagick en la máquina objetivo. Detalle: ${out}`
    );
  }
  return out.trim();
}
