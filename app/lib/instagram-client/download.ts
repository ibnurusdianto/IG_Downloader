import {
  extractMediaType,
  isAbortError,
  isJsonContentType,
  parseBackendErrorEnvelope,
  readErrorFromResponse,
} from "./api";
import type { DownloadFileResult, DownloadProgress } from "./types";

const SINGLE_DOWNLOAD_ENDPOINT = "/api/instagram/download";
const ZIP_DOWNLOAD_ENDPOINT = "/api/instagram/zip";
const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f]/g;
const DISALLOWED_FILENAME_CHARS_REGEX = /[<>:"/\\|?*]/g;

export function sanitizeDownloadFilename(
  rawName: string | null | undefined,
  fallbackName: string
): string {
  const safeFallback = fallbackName.trim() || "instagram-media.bin";
  if (!rawName || typeof rawName !== "string") {
    return safeFallback;
  }

  const normalizedSlashes = rawName.replace(/\\/g, "/");
  const segments = normalizedSlashes.split("/").filter(Boolean);
  const lastSegment = segments.length > 0 ? segments[segments.length - 1] : "";

  const cleaned = lastSegment
    .replace(CONTROL_CHAR_REGEX, "")
    .replace(DISALLOWED_FILENAME_CHARS_REGEX, "_")
    .replace(/\.\.+/g, ".")
    .trim()
    .replace(/^[.\s_]+/, "")
    .replace(/[.\s]+$/, "");

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return safeFallback;
  }

  const extMatch = cleaned.match(/^(.+?)(\.[A-Za-z0-9]{1,8})$/);
  if (!extMatch) {
    const stem = cleaned.slice(0, 100).trim();
    return stem || safeFallback;
  }

  const stem = extMatch[1].slice(0, 100).replace(/[.\s]+$/, "");
  const ext = extMatch[2];
  if (!stem) {
    return safeFallback;
  }
  return `${stem}${ext}`;
}

function splitHeaderParameters(headerValue: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaping = false;

  for (let i = 0; i < headerValue.length; i += 1) {
    const ch = headerValue[i];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (inQuotes && ch === "\\") {
      escaping = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === ";" && !inQuotes) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }

  if (current.trim().length > 0) {
    parts.push(current.trim());
  }

  return parts;
}

function unquoteHeaderValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return trimmed;
}

function decodeRfc5987Value(rawValue: string): string | null {
  const unquoted = unquoteHeaderValue(rawValue);
  const firstQuote = unquoted.indexOf("'");
  const secondQuote =
    firstQuote >= 0 ? unquoted.indexOf("'", firstQuote + 1) : -1;
  const encodedPart =
    secondQuote >= 0 ? unquoted.slice(secondQuote + 1) : unquoted;

  if (!encodedPart) {
    return null;
  }

  try {
    return decodeURIComponent(encodedPart);
  } catch {
    return null;
  }
}

export function parseContentDispositionFilename(
  headerValue: string | null,
  fallbackName: string
): string {
  if (!headerValue) {
    return sanitizeDownloadFilename(fallbackName, fallbackName);
  }

  const segments = splitHeaderParameters(headerValue);
  let extendedFilename: string | null = null;
  let standardFilename: string | null = null;

  for (const segment of segments) {
    const eqIndex = segment.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = segment.slice(0, eqIndex).trim().toLowerCase();
    const rawVal = segment.slice(eqIndex + 1).trim();

    if (key === "filename*") {
      const decoded = decodeRfc5987Value(rawVal);
      if (decoded) {
        extendedFilename = decoded;
      }
    } else if (key === "filename") {
      const unquoted = unquoteHeaderValue(rawVal);
      if (unquoted) {
        standardFilename = unquoted;
      }
    }
  }

  const preferred = extendedFilename ?? standardFilename;
  return sanitizeDownloadFilename(preferred, fallbackName);
}

function parseMeasurableContentLength(headers: Headers): number | null {
  const encoding = headers.get("content-encoding")?.trim().toLowerCase() ?? "";
  if (encoding !== "" && encoding !== "identity") {
    return null;
  }

  const rawLength = headers.get("content-length");
  if (!rawLength) {
    return null;
  }

  const trimmed = rawLength.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function triggerBrowserBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";

  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    if (anchor.parentNode) {
      anchor.parentNode.removeChild(anchor);
    }
    window.setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 1000);
  }
}

async function readResponseToBlob(params: {
  response: Response;
  mimeType: string;
  totalBytes: number | null;
  signal: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}): Promise<{ blob: Blob; bytesReceived: number }> {
  const { response, mimeType, totalBytes, signal, onProgress } = params;

  if (!response.body) {
    const blob = await response.blob();
    if (signal.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    onProgress?.({ loadedBytes: blob.size, totalBytes });
    return { blob, bytesReceived: blob.size };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loadedBytes = 0;

  onProgress?.({ loadedBytes: 0, totalBytes });

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }

      const chunk = new Uint8Array(value.byteLength);
      chunk.set(value);
      chunks.push(chunk);
      loadedBytes += chunk.byteLength;
      onProgress?.({ loadedBytes, totalBytes });
    }
  } finally {
    reader.releaseLock();
  }

  if (signal.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  return {
    blob: new Blob(chunks, { type: mimeType || "application/octet-stream" }),
    bytesReceived: loadedBytes,
  };
}

async function executeFileDownload(params: {
  endpoint: string;
  payload: Record<string, unknown>;
  fallbackFilename: string;
  ensureZipExtension?: boolean;
  signal: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}): Promise<DownloadFileResult> {
  if (params.signal.aborted) {
    return { ok: false, kind: "aborted" };
  }

  let response: Response;
  try {
    response = await fetch(params.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
      },
      body: JSON.stringify(params.payload),
      cache: "no-store",
      signal: params.signal,
    });
  } catch (error) {
    if (isAbortError(error, params.signal)) {
      return { ok: false, kind: "aborted" };
    }
    return {
      ok: false,
      kind: "network",
      message:
        "Gagal mengunduh file karena gangguan jaringan. Periksa koneksi Anda lalu coba lagi.",
    };
  }

  if (params.signal.aborted) {
    return { ok: false, kind: "aborted" };
  }

  const rawContentType = response.headers.get("content-type");
  const mediaType = extractMediaType(rawContentType);

  if (!response.ok) {
    try {
      const errorInfo = await readErrorFromResponse(
        response,
        "download",
        params.signal
      );
      return {
        ok: false,
        kind: errorInfo.kind,
        code: errorInfo.code,
        message: errorInfo.message,
        status: errorInfo.status,
        isExpiredToken: errorInfo.isExpiredToken,
      };
    } catch (error) {
      if (isAbortError(error, params.signal)) {
        return { ok: false, kind: "aborted" };
      }
      return {
        ok: false,
        kind: "invalid_response",
        message: "Gagal membaca detail kegagalan unduhan dari server.",
        status: response.status,
      };
    }
  }

  if (isJsonContentType(rawContentType)) {
    try {
      const rawText = await response.text();
      const parsedJson = JSON.parse(rawText) as unknown;
      const backendError = parseBackendErrorEnvelope(parsedJson);
      if (backendError) {
        return {
          ok: false,
          kind: "backend",
          code: backendError.code,
          message: backendError.message,
          status: response.status,
          isExpiredToken: backendError.code === "TOKEN_EXPIRED",
        };
      }
    } catch (error) {
      if (isAbortError(error, params.signal)) {
        return { ok: false, kind: "aborted" };
      }
    }

    return {
      ok: false,
      kind: "invalid_response",
      message: "Server mengembalikan respons JSON, bukan file unduhan.",
      status: response.status,
    };
  }

  if (
    mediaType === "text/html" ||
    mediaType === "application/xhtml+xml" ||
    mediaType === "text/plain"
  ) {
    return {
      ok: false,
      kind: "invalid_response",
      message:
        "Server mengembalikan halaman teks atau HTML alih-alih file unduhan yang valid.",
      status: response.status,
    };
  }

  const totalBytes = parseMeasurableContentLength(response.headers);
  let resolvedFilename = parseContentDispositionFilename(
    response.headers.get("content-disposition"),
    params.fallbackFilename
  );

  if (
    params.ensureZipExtension &&
    !resolvedFilename.toLowerCase().endsWith(".zip")
  ) {
    resolvedFilename = `${resolvedFilename}.zip`;
  }

  try {
    const { blob, bytesReceived } = await readResponseToBlob({
      response,
      mimeType: mediaType || "application/octet-stream",
      totalBytes,
      signal: params.signal,
      onProgress: params.onProgress,
    });

    if (blob.size === 0 || bytesReceived === 0) {
      return {
        ok: false,
        kind: "invalid_response",
        message: "File yang diterima dari server kosong atau terputus.",
        status: response.status,
      };
    }

    triggerBrowserBlobDownload(blob, resolvedFilename);

    return {
      ok: true,
      filename: resolvedFilename,
      bytesReceived,
    };
  } catch (error) {
    if (isAbortError(error, params.signal)) {
      return { ok: false, kind: "aborted" };
    }
    return {
      ok: false,
      kind: "network",
      message:
        "Aliran unduhan terputus sebelum selesai. Silakan coba unduh kembali.",
    };
  }
}

export async function downloadSingleInstagramMedia(params: {
  token: string;
  fallbackFilename: string;
  signal: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}): Promise<DownloadFileResult> {
  return executeFileDownload({
    endpoint: SINGLE_DOWNLOAD_ENDPOINT,
    payload: { token: params.token },
    fallbackFilename: sanitizeDownloadFilename(
      params.fallbackFilename,
      "instagram-media.bin"
    ),
    signal: params.signal,
    onProgress: params.onProgress,
  });
}

export async function downloadZipInstagramMedia(params: {
  tokens: string[];
  signal: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}): Promise<DownloadFileResult> {
  const uniqueTokens = Array.from(
    new Set(params.tokens.map((item) => item.trim()).filter(Boolean))
  );

  if (uniqueTokens.length === 0) {
    return {
      ok: false,
      kind: "backend",
      message: "Pilih minimal satu media sebelum mengunduh arsip ZIP.",
    };
  }

  return executeFileDownload({
    endpoint: ZIP_DOWNLOAD_ENDPOINT,
    payload: { tokens: uniqueTokens },
    fallbackFilename: `instagram-media-${Date.now()}.zip`,
    ensureZipExtension: true,
    signal: params.signal,
    onProgress: params.onProgress,
  });
}
