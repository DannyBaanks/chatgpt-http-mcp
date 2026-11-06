// doctor-rules.ts — M4: cada codigo de media tiene un remedio accionable.
//
// Determinista y en espanol. No ejecuta nada: solo causa + que hacer + comando
// sugerido + ancla en GUIA.md. El test de cobertura exige 1:1 con el catalogo
// (si aparece un codigo nuevo sin regla, el test falla).
import { MEDIA_ERROR_CODES, type MediaErrorCode } from "./media/error-codes";

export interface DoctorRule {
  cause: string;
  remedy: string;
  command_hint?: string;
  guide_anchor?: string;
}

export const DOCTOR_RULES: Record<MediaErrorCode, DoctorRule> = {
  media_youtube_bot_wall: {
    cause: "YouTube pidio confirmar que no eres un bot en este enlace.",
    remedy: "Espera unos minutos y reintenta; el import ya reintenta con el cliente web incrustado y nunca usa cookies.",
    command_hint: "isymcp media prepare <url>",
    guide_anchor: "GUIA.md#media-youtube",
  },
  media_youtube_login_required: {
    cause: "El video exige sesion iniciada en YouTube.",
    remedy: "Prueba otro enlace publico: el import es sin cookies por politica y no puede iniciar sesion.",
    guide_anchor: "GUIA.md#media-youtube",
  },
  media_rate_limited: {
    cause: "YouTube limito temporalmente las descargas (HTTP 429).",
    remedy: "Espera unos minutos antes de reintentar y evita importaciones en rafaga.",
  },
  media_source_unavailable: {
    cause: "El video es privado, fue borrado o esta restringido.",
    remedy: "Verifica que el enlace siga siendo publico y sea un video o Short individual.",
  },
  media_geo_blocked: {
    cause: "El video no esta disponible en esta region.",
    remedy: "No hay solucion local sin VPN; usa otro enlace.",
  },
  media_format_unavailable: {
    cause: "YouTube no ofrecio un formato descargable compatible.",
    remedy: "Actualiza yt-dlp y reintenta.",
    command_hint: "yt-dlp --version ; yt-dlp -U",
  },
  media_tool_missing: {
    cause: "Falta yt-dlp o ffmpeg en este equipo.",
    remedy: "Instala la herramienta que reporta el doctor y reintenta.",
    command_hint: "isymcp doctor",
  },
  media_network_offline: {
    cause: "Sin conexion de red o fallo de resolucion DNS.",
    remedy: "Revisa la conexion y reintenta.",
    command_hint: "isymcp doctor",
  },
  media_too_large: {
    cause: "El medio excede el limite local de tamano (500 MiB).",
    remedy: "Usa un video mas corto o de menor resolucion.",
  },
  media_too_long: {
    cause: "El medio excede los 30 minutos admitidos.",
    remedy: "Recorta el video o importa uno mas corto.",
  },
  media_identity_mismatch: {
    cause: "La identidad del video descargado no coincide con el enlace pedido.",
    remedy: "Reintenta con el enlace canonico de YouTube (watch?v=...); no se exporto ningun paquete.",
  },
  media_timeout: {
    cause: "La importacion supero el tiempo limite.",
    remedy: "Prueba con un video mas corto o con mejor conexion.",
  },
  media_workspace_error: {
    cause: "El directorio de trabajo o el disco no esta disponible.",
    remedy: "Libera espacio y comprueba permisos del directorio de medios.",
    command_hint: "isymcp doctor",
  },
  media_prepare_failed: {
    cause: "La preparacion del medio fallo (audio o hojas de contacto).",
    remedy: "El origen y los resultados parciales verificados se conservan: reintenta con la misma URL.",
    command_hint: "isymcp media prepare <url>",
  },
  media_catalog_unavailable: {
    cause: "El catalogo de medios no esta disponible o el offset es invalido.",
    remedy: "Comprueba el directorio de medios y usa un offset entero >= 0.",
    command_hint: "isymcp doctor",
  },
  media_invalid_url: {
    cause: "El enlace no es una URL publica HTTPS de un video/Short de YouTube.",
    remedy: "Usa https://www.youtube.com/watch?v=<id> o un enlace de Shorts individual.",
  },
  media_lookup_failed: {
    cause: "La busqueda local no pudo verificar la fuente o su integridad.",
    remedy: "Vuelve a registrar/preparar el medio; si persiste, revisa el catalogo con el doctor.",
    command_hint: "isymcp media list",
  },
  media_asset_changed: {
    cause: "Los bytes registrados cambiaron o el asset fue revocado.",
    remedy: "Vuelve a registrar el archivo antes de analizarlo.",
    command_hint: "isymcp media add <file>",
  },
  media_invalid_request: {
    cause: "Peticion invalida (por ejemplo sheet_index fuera de rango).",
    remedy: "Revisa los parametros de la tool con media_lookup o media_list.",
  },
  media_busy: {
    cause: "Hay otra consulta de medios en curso.",
    remedy: "Espera a que termine la consulta actual y reintenta.",
  },
  media_download_unknown: {
    cause: "La descarga fallo por una causa no clasificada.",
    remedy: "Revisa el code y el detail del ultimo fallo con el doctor y reintenta.",
    command_hint: "isymcp doctor",
  },
  media_unknown: {
    cause: "Fallo de medios sin causa especifica (puede ser anterior a los codigos estables).",
    remedy: "Reintenta la operacion; si vuelve a fallar, revisa el ultimo fallo con isymcp doctor --json.",
    command_hint: "isymcp media prepare <url>",
  },
};

export function ruleFor(code: string | undefined): DoctorRule | undefined {
  return code && code in DOCTOR_RULES ? DOCTOR_RULES[code as MediaErrorCode] : undefined;
}
