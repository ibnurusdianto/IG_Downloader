import https from "node:https";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { ZipArchive } from "archiver";
import pLimit from "p-limit";
import {
  ForbiddenMediaError,
  InstagramAppError,
  MediaNotFoundError,
  PayloadTooLargeError,
  RequestAbortedError,
  UpstreamServiceError,
  UpstreamTimeoutError,
} from "./errors";
import {
  createPinnedLookup,
  createUniqueArchiveFilename,
  isBlockedIpAddress,
  sanitizeFilename,
  validateMediaUrl,
} from "./security";
import { verifyDownloadToken } from "./tokens";
import type {
  InstagramRuntimeConfig,
  NormalizedMediaType,
  SignedDownloadTokenPayload,
} from "./types";

const MAX_REDIRECT_HOPS = 3;

const SAFE_MEDIA_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/octet-stream",
]);

function resolveSafeContentType(
  rawHeader: string | string[] | undefined,
  mediaType: NormalizedMediaType
): string {
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const mime = headerValue?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (SAFE_MEDIA_MIME_TYPES.has(mime)) {
    return mime === "image/jpg" ? "image/jpeg" : mime;
  }
  if (mediaType === "image") return "image/jpeg";
  if (mediaType === "video") return "video/mp4";
  return "application/octet-stream";
}

function parseContentLengthHeader(
  rawHeader: string | string[] | undefined
): number | null {
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!headerValue) {
    return null;
  }
  const trimmed = headerValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

type OpenedMediaStream = {
  responseStream: IncomingMessage;
  statusCode: number;
  contentType: string;
  contentLength: number | null;
  contentRange: string | null;
  acceptRanges: string | null;
  cleanup: () => void;
};

async function openValidatedMediaStream(params: {
  url: string;
  mediaType: NormalizedMediaType;
  config: InstagramRuntimeConfig;
  signal: AbortSignal;
  maxFileBytes: number;
  headerTimeoutMs: number;
  rangeHeader?: string;
}): Promise<OpenedMediaStream> {
  let currentUrl = params.url;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    if (params.signal.aborted) {
      throw new RequestAbortedError();
    }

    const validatedUrl = validateMediaUrl(
      currentUrl,
      params.config.mediaAllowedDomains,
      "download"
    );

    const verifiedIps = new Set<string>();
    const requestHeaders: Record<string, string> = {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      accept: "*/*",
      "accept-encoding": "identity",
    };
    if (
      params.rangeHeader &&
      /^bytes=\d+-\d*$/.test(params.rangeHeader.trim())
    ) {
      requestHeaders.range = params.rangeHeader.trim();
    }

    const attemptResult = await new Promise<
      | { kind: "stream"; opened: OpenedMediaStream }
      | { kind: "redirect"; location: string }
    >((resolve, reject) => {
      let settled = false;
      let headerTimer: ReturnType<typeof setTimeout> | undefined;

      const req = https.request(
        validatedUrl,
        {
          method: "GET",
          agent: false,
          lookup: createPinnedLookup(validatedUrl.hostname, verifiedIps),
          headers: requestHeaders,
        },
        (res) => {
          if (headerTimer !== undefined) {
            clearTimeout(headerTimer);
            headerTimer = undefined;
          }

          if (settled) {
            res.destroy();
            return;
          }

          const statusCode = res.statusCode ?? 0;
          if (
            statusCode === 301 ||
            statusCode === 302 ||
            statusCode === 303 ||
            statusCode === 307 ||
            statusCode === 308
          ) {
            const locationHeader = res.headers.location;
            res.destroy();
            req.destroy();
            params.signal.removeEventListener("abort", onAbort);
            settled = true;

            if (typeof locationHeader !== "string" || !locationHeader.trim()) {
              reject(
                new UpstreamServiceError(
                  "UPSTREAM_INVALID_RESPONSE",
                  "Respons redirect dari server media tidak memiliki header Location."
                )
              );
              return;
            }

            if (hop >= MAX_REDIRECT_HOPS) {
              reject(
                new UpstreamServiceError(
                  "UPSTREAM_TOO_MANY_REDIRECTS",
                  "Jumlah redirect dari server media melampaui batas maksimum."
                )
              );
              return;
            }

            try {
              const nextUrl = new URL(locationHeader, validatedUrl).toString();
              resolve({ kind: "redirect", location: nextUrl });
            } catch {
              reject(
                new UpstreamServiceError(
                  "UPSTREAM_INVALID_RESPONSE",
                  "URL redirect dari server media tidak valid."
                )
              );
            }
            return;
          }

          const isAcceptedStatus =
            statusCode === 200 ||
            (Boolean(requestHeaders.range) && statusCode === 206);

          if (!isAcceptedStatus) {
            res.destroy();
            req.destroy();
            params.signal.removeEventListener("abort", onAbort);
            settled = true;

            if (statusCode === 404 || statusCode === 410) {
              reject(
                new MediaNotFoundError(
                  "File media tidak ditemukan atau tautan dari sumber sudah tidak berlaku."
                )
              );
              return;
            }

            reject(
              new UpstreamServiceError(
                "UPSTREAM_ERROR",
                "Server media upstream gagal melayani permintaan unduhan."
              )
            );
            return;
          }

          const rawContentTypeHeader = res.headers["content-type"];
          const rawMime =
            (Array.isArray(rawContentTypeHeader)
              ? rawContentTypeHeader[0]
              : rawContentTypeHeader
            )
              ?.split(";")[0]
              ?.trim()
              .toLowerCase() ?? "";
          if (
            rawMime === "text/html" ||
            rawMime === "application/xhtml+xml" ||
            rawMime === "text/plain"
          ) {
            res.destroy();
            req.destroy();
            params.signal.removeEventListener("abort", onAbort);
            settled = true;
            reject(
              new UpstreamServiceError(
                "UPSTREAM_INVALID_RESPONSE",
                "Server media upstream mengembalikan respons teks atau HTML, bukan file media."
              )
            );
            return;
          }

          const contentLength = parseContentLengthHeader(
            res.headers["content-length"]
          );
          if (contentLength !== null && contentLength > params.maxFileBytes) {
            res.destroy();
            req.destroy();
            params.signal.removeEventListener("abort", onAbort);
            settled = true;
            reject(
              new PayloadTooLargeError(
                "FILE_SIZE_LIMIT_EXCEEDED",
                "Ukuran file media melebihi batas maksimum yang diizinkan."
              )
            );
            return;
          }

          settled = true;
          params.signal.removeEventListener("abort", onAbort);

          const cleanup = () => {
            if (!res.destroyed) {
              res.destroy();
            }
            if (!req.destroyed) {
              req.destroy();
            }
          };

          const rawRangeHeader = res.headers["content-range"];
          const contentRange = Array.isArray(rawRangeHeader)
            ? rawRangeHeader[0] ?? null
            : rawRangeHeader ?? null;
          const rawAcceptRanges = res.headers["accept-ranges"];
          const acceptRanges = Array.isArray(rawAcceptRanges)
            ? rawAcceptRanges[0] ?? null
            : rawAcceptRanges ?? null;

          resolve({
            kind: "stream",
            opened: {
              responseStream: res,
              statusCode,
              contentType: resolveSafeContentType(
                res.headers["content-type"],
                params.mediaType
              ),
              contentLength,
              contentRange,
              acceptRanges,
              cleanup,
            },
          });
        }
      );

      const failAttempt = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (headerTimer !== undefined) {
          clearTimeout(headerTimer);
          headerTimer = undefined;
        }
        params.signal.removeEventListener("abort", onAbort);
        if (!req.destroyed) {
          req.destroy();
        }
        if (error instanceof InstagramAppError) {
          reject(error);
          return;
        }
        reject(
          new UpstreamServiceError(
            "UPSTREAM_ERROR",
            "Gagal terhubung ke server media upstream."
          )
        );
      };

      const onAbort = () => {
        failAttempt(new RequestAbortedError());
      };

      params.signal.addEventListener("abort", onAbort, { once: true });

      headerTimer = setTimeout(() => {
        failAttempt(
          new UpstreamTimeoutError(
            "Server media upstream tidak merespons dalam batas waktu."
          )
        );
      }, params.headerTimeoutMs);

      req.on("socket", (socket) => {
        socket.on("connect", () => {
          const remoteAddress = socket.remoteAddress;
          if (
            !remoteAddress ||
            !verifiedIps.has(remoteAddress) ||
            isBlockedIpAddress(remoteAddress)
          ) {
            socket.destroy(
              new ForbiddenMediaError(
                "MEDIA_IP_BLOCKED",
                "Koneksi ke alamat tujuan yang tidak terverifikasi ditolak."
              )
            );
          }
        });
      });

      req.on("error", (error) => {
        failAttempt(error);
      });

      req.end();
    });

    if (attemptResult.kind === "stream") {
      return attemptResult.opened;
    }

    currentUrl = attemptResult.location;
  }

  throw new UpstreamServiceError(
    "UPSTREAM_TOO_MANY_REDIRECTS",
    "Jumlah redirect dari server media melampaui batas maksimum."
  );
}

function buildAttachmentDisposition(filename: string): string {
  return `attachment; filename="${filename}"`;
}

function buildInlineDisposition(filename: string): string {
  return `inline; filename="${filename}"`;
}

function buildMediaReadableStream(params: {
  opened: OpenedMediaStream;
  config: InstagramRuntimeConfig;
  signal: AbortSignal;
}): ReadableStream<Uint8Array> {
  const { opened, config, signal } = params;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let settled = false;
      let actualBytes = 0;
      let streamCompletedCleanly = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const clearResources = () => {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
        signal.removeEventListener("abort", onClientAbort);
        opened.cleanup();
      };

      const failStream = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearResources();
        try {
          controller.error(error);
        } catch {}
      };

      const finishStream = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearResources();
        try {
          controller.close();
        } catch {}
      };

      const resetIdleTimer = () => {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => {
          failStream(
            new UpstreamTimeoutError(
              "Streaming media melebihi batas waktu."
            )
          );
        }, config.downloadTimeoutMs);
      };

      const onClientAbort = () => {
        failStream(new RequestAbortedError());
      };

      if (signal.aborted) {
        failStream(new RequestAbortedError());
        return;
      }

      signal.addEventListener("abort", onClientAbort, { once: true });
      resetIdleTimer();

      opened.responseStream.on("data", (chunk: Buffer) => {
        if (settled) {
          return;
        }
        resetIdleTimer();
        actualBytes += chunk.byteLength;
        if (actualBytes > config.maxFileBytes) {
          failStream(
            new PayloadTooLargeError(
              "FILE_SIZE_LIMIT_EXCEEDED",
              "Ukuran file media aktual melebihi batas maksimum."
            )
          );
          return;
        }

        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch (enqueueError) {
          failStream(
            enqueueError instanceof Error
              ? enqueueError
              : new Error("Stream enqueue failed")
          );
          return;
        }

        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          opened.responseStream.pause();
        }
      });

      opened.responseStream.on("end", () => {
        streamCompletedCleanly = opened.responseStream.complete;
        if (!streamCompletedCleanly) {
          failStream(
            new UpstreamServiceError(
              "UPSTREAM_STREAM_TRUNCATED",
              "Aliran data media dari server upstream terputus."
            )
          );
          return;
        }
        finishStream();
      });

      opened.responseStream.on("aborted", () => {
        failStream(
          new UpstreamServiceError(
            "UPSTREAM_STREAM_ABORTED",
            "Koneksi server upstream terputus saat mengambil media."
          )
        );
      });

      opened.responseStream.on("error", (error) => {
        failStream(error);
      });

      opened.responseStream.on("close", () => {
        if (!settled && !streamCompletedCleanly) {
          failStream(
            new UpstreamServiceError(
              "UPSTREAM_STREAM_TRUNCATED",
              "Aliran data media upstream ditutup sebelum selesai."
            )
          );
        }
      });
    },
    pull() {
      if (!opened.responseStream.destroyed) {
        opened.responseStream.resume();
      }
    },
    cancel() {
      opened.cleanup();
    },
  });
}

export async function createSingleDownloadResponse(params: {
  token: string;
  config: InstagramRuntimeConfig;
  signal: AbortSignal;
}): Promise<Response> {
  const payload = verifyDownloadToken(params.token, params.config);
  const safeFilename = sanitizeFilename(payload.f, payload.t, 0);

  const opened = await openValidatedMediaStream({
    url: payload.u,
    mediaType: payload.t,
    config: params.config,
    signal: params.signal,
    maxFileBytes: params.config.maxFileBytes,
    headerTimeoutMs: params.config.downloadTimeoutMs,
  });

  const bodyStream = buildMediaReadableStream({
    opened,
    config: params.config,
    signal: params.signal,
  });

  const headers: Record<string, string> = {
    "Content-Type": opened.contentType,
    "Content-Disposition": buildAttachmentDisposition(safeFilename),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (opened.contentLength !== null) {
    headers["Content-Length"] = String(opened.contentLength);
  }

  return new Response(bodyStream, {
    status: 200,
    headers,
  });
}

export async function createPreviewResponse(params: {
  token: string;
  config: InstagramRuntimeConfig;
  signal: AbortSignal;
  rangeHeader?: string;
}): Promise<Response> {
  const payload = verifyDownloadToken(params.token, params.config);
  const safeFilename = sanitizeFilename(payload.f, payload.t, 0);

  const opened = await openValidatedMediaStream({
    url: payload.u,
    mediaType: payload.t,
    config: params.config,
    signal: params.signal,
    maxFileBytes: params.config.maxFileBytes,
    headerTimeoutMs: params.config.downloadTimeoutMs,
    rangeHeader: params.rangeHeader,
  });

  const bodyStream = buildMediaReadableStream({
    opened,
    config: params.config,
    signal: params.signal,
  });

  const headers: Record<string, string> = {
    "Content-Type": opened.contentType,
    "Content-Disposition": buildInlineDisposition(safeFilename),
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
  };
  if (opened.contentLength !== null) {
    headers["Content-Length"] = String(opened.contentLength);
  }
  if (opened.contentRange) {
    headers["Content-Range"] = opened.contentRange;
  }
  if (opened.acceptRanges) {
    headers["Accept-Ranges"] = opened.acceptRanges;
  } else if (opened.contentType.startsWith("video/")) {
    headers["Accept-Ranges"] = "bytes";
  }

  return new Response(bodyStream, {
    status: opened.statusCode === 206 ? 206 : 200,
    headers,
  });
}

type PreparedZipEntry = {
  url: string;
  mediaType: NormalizedMediaType;
  archiveFilename: string;
};

function prepareZipEntries(
  tokens: string[],
  config: InstagramRuntimeConfig
): PreparedZipEntry[] {
  const verifiedPayloads: SignedDownloadTokenPayload[] = tokens.map((token) =>
    verifyDownloadToken(token, config)
  );

  const seenUrls = new Set<string>();
  const usedNamesLower = new Set<string>();
  const entries: PreparedZipEntry[] = [];

  for (const payload of verifiedPayloads) {
    if (seenUrls.has(payload.u)) {
      continue;
    }
    seenUrls.add(payload.u);

    if (entries.length >= config.zipMaxFiles) {
      throw new PayloadTooLargeError(
        "ZIP_FILE_LIMIT_EXCEEDED",
        `Jumlah file unik untuk arsip ZIP melebihi batas maksimum (${config.zipMaxFiles} file).`
      );
    }

    const archiveFilename = createUniqueArchiveFilename(
      payload.f,
      payload.t,
      entries.length,
      usedNamesLower
    );

    entries.push({
      url: payload.u,
      mediaType: payload.t,
      archiveFilename,
    });
  }

  return entries;
}

function streamEntryToArchive(params: {
  opened: OpenedMediaStream;
  archiveFilename: string;
  archive: ZipArchive;
  config: InstagramRuntimeConfig;
  signal: AbortSignal;
  addBytesAndCheckTotal: (delta: number) => void;
  activeCleanups: Set<() => void>;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const {
      opened,
      archiveFilename,
      archive,
      config,
      signal,
      addBytesAndCheckTotal,
      activeCleanups,
    } = params;

    const entryStream = new PassThrough({
      highWaterMark: 16 * 1024,
    });

    let settled = false;
    let entryBytes = 0;
    let upstreamEndedCleanly = false;
    let isConsuming = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;

    const clearStallTimer = () => {
      if (stallTimer !== undefined) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
    };

    const resetStallTimer = () => {
      clearStallTimer();
      if (!isConsuming || settled) {
        return;
      }
      stallTimer = setTimeout(() => {
        failEntry(
          new UpstreamTimeoutError(
            "Pengunduhan entri media untuk arsip ZIP melebihi batas waktu."
          )
        );
      }, config.downloadTimeoutMs);
    };

    const cleanupEntry = () => {
      clearStallTimer();
      activeCleanups.delete(cleanupEntry);
      signal.removeEventListener("abort", onAbort);
      opened.cleanup();
      if (!entryStream.destroyed) {
        entryStream.destroy();
      }
    };

    const failEntry = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupEntry();
      reject(error);
    };

    const completeEntry = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearStallTimer();
      activeCleanups.delete(cleanupEntry);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    const onAbort = () => {
      failEntry(new RequestAbortedError());
    };

    if (signal.aborted) {
      cleanupEntry();
      reject(new RequestAbortedError());
      return;
    }

    activeCleanups.add(cleanupEntry);
    signal.addEventListener("abort", onAbort, { once: true });

    entryStream.on("error", (error) => {
      failEntry(error);
    });

    entryStream.on("resume", () => {
      isConsuming = true;
      resetStallTimer();
    });

    entryStream.on("data", () => {
      isConsuming = true;
      resetStallTimer();
    });

    entryStream.on("drain", () => {
      isConsuming = true;
      resetStallTimer();
      if (!opened.responseStream.destroyed) {
        opened.responseStream.resume();
      }
    });

    entryStream.on("end", () => {
      if (upstreamEndedCleanly) {
        completeEntry();
      }
    });

    entryStream.on("close", () => {
      if (!settled) {
        if (upstreamEndedCleanly) {
          completeEntry();
        } else {
          failEntry(
            new UpstreamServiceError(
              "UPSTREAM_STREAM_TRUNCATED",
              "Stream entri ZIP ditutup sebelum selesai."
            )
          );
        }
      }
    });

    opened.responseStream.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      if (isConsuming) {
        resetStallTimer();
      }

      entryBytes += chunk.byteLength;
      if (entryBytes > config.maxFileBytes) {
        failEntry(
          new PayloadTooLargeError(
            "FILE_SIZE_LIMIT_EXCEEDED",
            "Ukuran salah satu file melebihi batas maksimum."
          )
        );
        return;
      }

      try {
        addBytesAndCheckTotal(chunk.byteLength);
      } catch (limitError) {
        failEntry(
          limitError instanceof Error
            ? limitError
            : new PayloadTooLargeError(
                "ZIP_SIZE_LIMIT_EXCEEDED",
                "Total ukuran media untuk ZIP melebihi batas maksimum."
              )
        );
        return;
      }

      const canContinue = entryStream.write(chunk);
      if (!canContinue && !opened.responseStream.destroyed) {
        opened.responseStream.pause();
      }
    });

    opened.responseStream.on("end", () => {
      upstreamEndedCleanly = opened.responseStream.complete;
      if (!upstreamEndedCleanly) {
        failEntry(
          new UpstreamServiceError(
            "UPSTREAM_STREAM_TRUNCATED",
            "Data media dari upstream terputus sebelum selesai."
          )
        );
        return;
      }
      entryStream.end();
    });

    opened.responseStream.on("aborted", () => {
      failEntry(
        new UpstreamServiceError(
          "UPSTREAM_STREAM_ABORTED",
          "Koneksi upstream terputus saat membuat arsip ZIP."
        )
      );
    });

    opened.responseStream.on("error", (error) => {
      failEntry(error);
    });

    opened.responseStream.on("close", () => {
      if (!settled && !upstreamEndedCleanly) {
        failEntry(
          new UpstreamServiceError(
            "UPSTREAM_STREAM_TRUNCATED",
            "Koneksi upstream ditutup sebelum pengiriman media selesai."
          )
        );
      }
    });

    archive.append(entryStream, { name: archiveFilename });
  });
}

export async function createZipDownloadResponse(params: {
  tokens: string[];
  config: InstagramRuntimeConfig;
  signal: AbortSignal;
}): Promise<Response> {
  const entries = prepareZipEntries(params.tokens, params.config);

  const zipController = new AbortController();
  const archive = new ZipArchive({
    store: true,
  });
  const limit = pLimit({
    concurrency: params.config.zipConcurrency,
    rejectOnClear: true,
  });
  const activeCleanups = new Set<() => void>();

  let totalActualBytes = 0;
  let aborted = false;
  let streamSettled = false;
  let zipTimer: ReturnType<typeof setTimeout> | undefined;

  const addBytesAndCheckTotal = (delta: number) => {
    totalActualBytes += delta;
    if (totalActualBytes > params.config.zipMaxTotalBytes) {
      throw new PayloadTooLargeError(
        "ZIP_SIZE_LIMIT_EXCEEDED",
        "Total ukuran file media melebihi batas maksimum arsip ZIP."
      );
    }
  };

  const zipStream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanupMaster = () => {
        if (zipTimer !== undefined) {
          clearTimeout(zipTimer);
          zipTimer = undefined;
        }
        params.signal.removeEventListener("abort", onClientAbort);
      };

      const abortAll = (reason: Error) => {
        if (aborted) {
          return;
        }
        aborted = true;
        cleanupMaster();
        zipController.abort(reason);
        limit.clearQueue();

        for (const cleanup of Array.from(activeCleanups)) {
          try {
            cleanup();
          } catch {}
        }
        activeCleanups.clear();

        try {
          archive.abort();
        } catch {}
        try {
          archive.destroy(reason);
        } catch {}

        if (!streamSettled) {
          streamSettled = true;
          try {
            controller.error(reason);
          } catch {}
        }
      };

      const onClientAbort = () => {
        abortAll(new RequestAbortedError());
      };

      if (params.signal.aborted) {
        abortAll(new RequestAbortedError());
        return;
      }

      params.signal.addEventListener("abort", onClientAbort, { once: true });

      zipTimer = setTimeout(() => {
        abortAll(
          new UpstreamTimeoutError(
            "Proses pembuatan arsip ZIP melebihi batas waktu maksimum."
          )
        );
      }, params.config.zipTimeoutMs);

      archive.on("data", (chunk: Buffer) => {
        if (aborted || streamSettled) {
          return;
        }
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch (enqueueError) {
          abortAll(
            enqueueError instanceof Error
              ? enqueueError
              : new Error("ZIP stream enqueue failed")
          );
          return;
        }
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          archive.pause();
        }
      });

      archive.on("end", () => {
        if (aborted || streamSettled) {
          return;
        }
        streamSettled = true;
        cleanupMaster();
        try {
          controller.close();
        } catch {}
      });

      archive.on("close", () => {
        if (!aborted && !streamSettled) {
          abortAll(
            new UpstreamServiceError(
              "ZIP_STREAM_ABORTED",
              "Stream arsip ZIP berakhir secara tidak terduga."
            )
          );
        }
      });

      archive.on("warning", (warning) => {
        abortAll(warning);
      });

      archive.on("error", (error) => {
        abortAll(error);
      });

      void (async () => {
        try {
          await Promise.all(
            entries.map((entry) =>
              limit(async () => {
                if (zipController.signal.aborted) {
                  throw new RequestAbortedError();
                }

                const opened = await openValidatedMediaStream({
                  url: entry.url,
                  mediaType: entry.mediaType,
                  config: params.config,
                  signal: zipController.signal,
                  maxFileBytes: params.config.maxFileBytes,
                  headerTimeoutMs: params.config.downloadTimeoutMs,
                });

                if (zipController.signal.aborted) {
                  opened.cleanup();
                  throw new RequestAbortedError();
                }

                await streamEntryToArchive({
                  opened,
                  archiveFilename: entry.archiveFilename,
                  archive,
                  config: params.config,
                  signal: zipController.signal,
                  addBytesAndCheckTotal,
                  activeCleanups,
                });
              })
            )
          );

          if (!aborted && !zipController.signal.aborted) {
            await archive.finalize();
          }
        } catch (error) {
          abortAll(
            error instanceof Error
              ? error
              : new UpstreamServiceError(
                  "ZIP_ARCHIVE_ERROR",
                  "Gagal membuat arsip ZIP."
                )
          );
        }
      })();
    },
    pull() {
      if (!aborted && !archive.destroyed) {
        archive.resume();
      }
    },
    cancel() {
      if (!aborted) {
        aborted = true;
        if (zipTimer !== undefined) {
          clearTimeout(zipTimer);
          zipTimer = undefined;
        }
        zipController.abort(new RequestAbortedError());
        limit.clearQueue();
        for (const cleanup of Array.from(activeCleanups)) {
          try {
            cleanup();
          } catch {}
        }
        activeCleanups.clear();
        try {
          archive.abort();
        } catch {}
        try {
          archive.destroy();
        } catch {}
      }
    },
  });

  const zipFilename = `instagram-media-${Date.now()}.zip`;

  return new Response(zipStream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": buildAttachmentDisposition(zipFilename),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
