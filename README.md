# GottaRemoteMCP

**Remote Desktop Commander sin API Keys**: ejecuta el script en `bash`, copia las credenciales que genera en pantalla y pégalas directamente en **cualquier chat normal de ChatGPT o Gemini** (sin pagar API de OpenAI/Google, sin configurar OAuth ni verificar cuentas).

---

## Cómo funciona (Modo Sin API desde un Chat Normal)

1. Ejecutas en tu terminal Linux/macOS/Windows:
   ```bash
   ./gotta-remote.sh
   ```
2. El programa:
   - Levanta el motor **Desktop Commander** en tu PC (terminal con directorio `cwd` persistente, procesos en segundo plano, lectura/escritura/edición quirúrgica de archivos, búsqueda de código, control de ratón/teclado y capturas de pantalla).
   - Abre automáticamente un túnel HTTPS gratuito (`trycloudflare.com`, sin cuenta).
   - Genera unas credenciales únicas (`Usuario` y `Clave`) y te imprime en la terminal un **bloque listo para copiar y pegar**.
3. Pegas ese bloque en **un chat normal de ChatGPT o Gemini** y el modelo ya puede controlar tu ordenador inmediatamente visitando los enlaces de comando (`/c/<usuario>/<clave>/...`) con su lector web integrado o mediante `curl`/MCP si el entorno tiene terminal.

---

## Capacidades estilo `@remote desktop commander`

| Acción en Chat Normal (`GET` / Navegador del Chat) | Herramienta MCP | Función |
| :--- | :--- | :--- |
| `/c/<user>/<pass>/exec?cmd=...` | `execute_command` | Ejecuta comandos manteniendo `cwd` (`cd` persiste) y pasa procesos largos a segundo plano con su `PID`. |
| `/c/<user>/<pass>/session-output?pid=...` | `read_session_output` | Lee la salida en vivo de un comando o servidor que sigue corriendo en segundo plano. |
| `/c/<user>/<pass>/kill?pid=...` | `kill_process` | Detiene una sesión activa o mata un proceso por `PID`. |
| `/c/<user>/<pass>/read?path=...&start=1&end=200` | `read_file` | Lee archivos numerando las líneas y permitiendo rangos (`start` / `end`). |
| `/c/<user>/<pass>/write?path=...&content=...` | `write_file` | Crea o sobrescribe archivos (soporta texto plano, Base64 `?b64=` y modo `?append=1`). |
| `/c/<user>/<pass>/edit?path=...&search=...&replace=...` | `edit_block` | Edición quirúrgica de un bloque de código sin reescribir el archivo entero. |
| `/c/<user>/<pass>/search?q=...&path=.` | `search_code` | Busca texto o expresiones regulares en el código con `ripgrep` / `grep`. |
| `/c/<user>/<pass>/ls?path=.` | `list_directory` | Lista archivos, carpetas y tamaños. |
| `/c/<user>/<pass>/input?action=click&x=500&y=300` | `input_action` | Ratón y teclado multiplataforma (`click`, `double_click`, `right_click`, `move`, `drag`, `scroll`, `type`, `key`). |
| `/c/<user>/<pass>/screen` | `take_screenshot` | Muestra y devuelve captura de pantalla en tiempo real del escritorio. |

---

## Uso Rápido

```bash
cd ~/GottaRemoteMCP
./gotta-remote.sh
```

Si quieres fijar tú mismo el usuario y contraseña en vez de que se generen aleatoriamente en cada arranque:

```bash
CHAT_USER=marcos CHAT_PASS=mi_clave_1234 ./gotta-remote.sh
```
