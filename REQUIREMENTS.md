# Requisitos externos de ISyMCP

ISyMCP **no descarga ni empaqueta** programas de terceros: no son nuestro sistema, tienen su propio ciclo de
actualización y su propia licencia. Esta lista dice qué necesita cada función, dónde instalarlo y cómo
comprobarlo. `isymcp doctor` revisa lo esencial y dice qué falta.

```bash
isymcp doctor          # estado de cada requisito
isymcp doctor --json   # lo mismo, para scripts
```

## Esenciales

| Programa | Para qué | Cómo comprobarlo |
|---|---|---|
| [Bun](https://bun.sh) ≥ 1.4.2 | Ejecuta ISyMCP | `bun --version` |
| Google Chrome o Microsoft Edge | Sesión web de ChatGPT, `media login` | `isymcp doctor` → `browser` |
| `bubblewrap` (Linux) | Sandbox de `codex_exec` | `isymcp doctor` → `sandbox` |

## Medios (`media_import`, `isymcp media ...`)

| Programa | Para qué | Cómo comprobarlo |
|---|---|---|
| **yt-dlp, build standalone** | Descargar de YouTube, TikTok, X, Instagram, Vimeo… | `isymcp doctor` → `yt-dlp` y `yt-dlp suplantación` |
| `ffmpeg` y `ffprobe` | Validar, cortar, hojas de contacto, audio | `isymcp doctor` → `ffmpeg`, `ffprobe` |

**Por qué el build standalone de yt-dlp y no el de Python:** TikTok (y otros sitios) bloquean las descargas
que no se hacen pasar por un navegador real. Eso lo hace yt-dlp con `--impersonate`, que necesita
`curl_cffi`. El build standalone (`yt-dlp_linux`) ya lo trae; el zipapp de Python no. Con el zipapp,
TikTok falla con `media_site_blocked`. Medido el 2026-11-12: con 2026.08.19 (zipapp) TikTok fallaba; con
2026.10.26 (standalone) funciona.

Instalación (Linux), fuera del repo, en la carpeta que ISyMCP busca primero:

```bash
mkdir -p ~/.local/share/isymcp/tools && cd "$(mktemp -d)"
curl -fsSLO https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
curl -fsSLO https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS
grep ' yt-dlp_linux$' SHA2-256SUMS | sha256sum -c -     # debe decir "OK" / "La suma coincide"
install -m 755 yt-dlp_linux ~/.local/share/isymcp/tools/yt-dlp
isymcp doctor | grep yt-dlp                              # versión y "chrome disponible"
```

Actualizar: repite lo mismo (no uses `yt-dlp -U` sobre un binario que no verificaste).

`--impersonate chrome` se usa fuera de YouTube cuando el binario lo soporta. `ISYMCP_YTDLP_IMPERSONATE=0` lo
apaga y `=1` lo fuerza.

Orden en que ISyMCP busca yt-dlp: `ISYMCP_YTDLP_BIN` → `~/.local/share/isymcp/tools/yt-dlp` →
`~/.oamaestro/bin/yt-dlp` → `yt-dlp` en el `PATH`.

### Sitios que piden sesión (cookies opcionales)

Instagram, Vimeo y los posts privados piden sesión iniciada. **Por defecto los imports van sin cookies.**
Si quieres permitirlo para un sitio, ISyMCP usa el mismo sistema que con ChatGPT: Chrome normal con un
perfil dedicado a media, inicias sesión tú y luego se exportan solo las cookies de ese sitio.

```bash
isymcp media login instagram           # abre Chrome; inicia sesión y cierra la ventana
isymcp media cookies                   # qué sitios tienen cookies (solo conteos, nunca valores)
isymcp media cookies import vimeo --file ~/cookies-vimeo.txt   # o un cookies.txt exportado a mano
isymcp media cookies forget instagram  # dejar de usarlas
```

Se guardan en `~/.codex-web-http/media-cookies/<sitio>.txt` (0600). yt-dlp solo recibe las cookies del
sitio de la URL, como una copia temporal que se borra al terminar la descarga, aunque falle.
Sitios: instagram, vimeo, tiktok, x, facebook, reddit, youtube.

## Opcionales

| Programa | Para qué |
|---|---|
| `tmux` | Consolas de agentes (`spawn_agent_tui`) y entrega de tareas a la consola |
| `notify-send` | Aviso de escritorio al abrir una consola o pegarle una tarea |
| `gh` | Herramientas de GitHub (`github_exec`) |
| Las TUIs de agentes (agy, claude, opencode, openisy…) | Consolas coordinadas; ver `isymcp tui agents` |
| ComfyUI | Generación de imágenes (`comfyui_*`) |
