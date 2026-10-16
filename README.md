# GottaRemoteMCP

**Remote Desktop Commander** híbrido (**MCP Stdio / SSE + API REST OpenAPI 3.1**) compatible con **Gemini** y **ChatGPT**, diseñado para funcionar **sin verificación de cuenta ni flujos OAuth**: basta con pasar tu `AUTH_SECRET` estático y/o credenciales SSH directas para que el agente tome control del ordenador remoto.

---

## Características Principales

- **Doble protocolo simultáneo**:
  - **MCP (Model Context Protocol)** por `stdio` y por `HTTP SSE` (`/mcp/sse`) para Gemini CLI, Antigravity, ChatGPT Desktop y clientes MCP.
  - **REST + OpenAPI 3.1 autogenerado** (`/openapi.json`) para conectar en 1 clic con **ChatGPT Custom GPT Actions** o **Gemini Function Calling / Extensions**.
- **Dos modos de operación sin fricción**:
  1. **Modo Agente Local (Daemon)**: Corre directamente en la máquina a controlar.
  2. **Modo Puente SSH / SFTP (Sin instalar nada en el remoto)**: Pasa `host`, `port`, `username` y `password` (o `privateKey`) en `.env` o directamente en cada llamada de herramienta.
- **Control de Escritorio Multiplataforma (Zero-Dependency en Windows)**:
  - **Linux (X11 y Wayland)**: Soporte automático para `xdotool`, `ydotool`, `wtype`, `grim`, `scrot`, `gnome-screenshot` e `import`.
  - **Windows**: Ejecución nativa mediante PowerShell `.NET` (`user32.dll` + `System.Windows.Forms` + `CopyFromScreen`) sin instalar binarios extra.
  - **macOS**: Soporte para `screencapture`, `osascript` y `cliclick`.
- **Túnel Público Instantáneo (`--tunnel`)**:
  - Integra **Cloudflare Quick Tunnels** (`trycloudflare.com`) sin necesidad de cuenta ni abrir puertos en el router. Descarga el binario automáticamente si no está instalado.

---

## Herramientas Disponibles (MCP & OpenAPI)

| Herramienta | Endpoint REST | Descripción |
| :--- | :--- | :--- |
| `execute_command` | `POST /api/execute` | Ejecuta comandos shell/bash/powershell en local o vía SSH directo. |
| `take_screenshot` | `GET /api/screenshot` | Captura la pantalla actual (local o remota por SSH) y la devuelve en Base64. |
| `input_action` | `POST /api/input` | Ratón y teclado: `click`, `double_click`, `right_click`, `move`, `drag`, `scroll`, `type`, `key`. |
| `read_file` | `POST /api/files/read` | Lee archivos locales o remotos vía SFTP/SSH. |
| `write_file` | `POST /api/files/write` | Crea o sobrescribe archivos locales o remotos vía SFTP/SSH. |
| `list_directory` | `POST /api/files/list` | Lista archivos y tamaños de cualquier carpeta local o SFTP/SSH. |
| `list_processes` | `GET /api/processes` | Lista los procesos en ejecución con mayor consumo de CPU/RAM. |
| `system_status` | `GET /api/status` | Devuelve estado de CPU, RAM, SO, carga y uptime. |

---

## Instalación y Uso Rápido

```bash
git clone https://github.com/Doradux/GottaRemoteMCP.git
cd GottaRemoteMCP
npm install
npm run build
```

### 1. Arrancar con Túnel Público Instantáneo (Para ChatGPT Actions y Gemini Web/API)

```bash
AUTH_SECRET=mi-clave-secreta npm run start:tunnel
```

Esto mostrará en consola tu URL pública instantánea:
- **OpenAPI Spec URL**: `https://xxxx.trycloudflare.com/openapi.json`
- **MCP SSE URL**: `https://xxxx.trycloudflare.com/mcp/sse`
- **Bearer Token**: `mi-clave-secreta`

En **ChatGPT (Custom GPT -> Actions)**:
1. Haz clic en **Import from URL** y pega `https://xxxx.trycloudflare.com/openapi.json`.
2. En **Authentication**, elige **API Key** -> **Bearer** y pega `mi-clave-secreta`.

### 2. Conectar en Gemini / Clientes MCP Locales (`stdio`)

Añade a tu configuración de MCP (`settings.json` / `mcp_config.json`):

```json
{
  "mcpServers": {
    "gotta-remote-mcp": {
      "command": "node",
      "args": ["/ruta/absoluta/a/GottaRemoteMCP/dist/index.js", "--stdio"],
      "env": {
        "SSH_HOST": "192.168.1.50",
        "SSH_USER": "ubuntu",
        "SSH_PASSWORD": "tu_password"
      }
    }
  }
}
```
*(Si omites `SSH_HOST`, controlará directamente la máquina donde corre el servidor).*
