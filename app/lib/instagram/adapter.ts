import { createRequire } from "node:module";
import type InstagramDownloaderModule from "cakkatrok-instagram-downloader";
import {
  InstagramAppError,
  RequestAbortedError,
  ServerConfigError,
  UpstreamServiceError,
  UpstreamTimeoutError,
} from "./errors";
import type { InstagramFetchMode } from "./types";

type InstagramDownloaderClient = typeof InstagramDownloaderModule;

const requireModule: (id: string) => unknown = createRequire(import.meta.url);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInstagramDownloaderClient(
  value: unknown
): value is InstagramDownloaderClient {
  if (typeof value !== "function") {
    return false;
  }

  const candidate: object = value;
  return (
    "story" in candidate &&
    typeof candidate.story === "function" &&
    "media" in candidate &&
    typeof candidate.media === "function"
  );
}

let cachedClient: InstagramDownloaderClient | null = null;

function getInstagramClient(): InstagramDownloaderClient {
  if (cachedClient) {
    return cachedClient;
  }

  let loaded: unknown;
  try {
    loaded = requireModule("cakkatrok-instagram-downloader");
  } catch {
    throw new ServerConfigError(
      "Modul cakkatrok-instagram-downloader gagal dimuat di server."
    );
  }

  if (!isInstagramDownloaderClient(loaded)) {
    throw new ServerConfigError(
      "Antarmuka modul cakkatrok-instagram-downloader tidak sesuai."
    );
  }

  cachedClient = loaded;
  return cachedClient;
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#039": "'",
  "#39": "'",
};

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&#(\d+);/g, (_m, code: string) =>
      String.fromCharCode(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    .replace(
      /&([a-zA-Z0-9#]+);/g,
      (_m, entity: string) => HTML_ENTITY_MAP[entity] ?? `&${entity};`
    );
}

export function extractSnapVideoThumbnails(rawResult: unknown): unknown {
  if (!isPlainRecord(rawResult) || !Array.isArray(rawResult.media)) {
    return rawResult;
  }

  const rawContainer = isPlainRecord(rawResult.raw) ? rawResult.raw : null;
  const htmlData =
    rawContainer && typeof rawContainer.data === "string"
      ? rawContainer.data
      : "";

  if (!htmlData) {
    return rawResult;
  }

  const urlToThumb = new Map<string, string>();
  const orderedThumbs: string[] = [];

  const listBlocks = htmlData.match(/<li\b[\s\S]*?<\/li>/gi) ?? [];
  const blocks =
    listBlocks.length > 0
      ? listBlocks
      : htmlData.match(/<div[^>]*class=["'][^"']*download-items[^"']*["'][\s\S]*?(?=<div[^>]*class=["'][^"']*download-items|$)/gi) ??
        [htmlData];

  for (const block of blocks) {
    const imgMatch = block.match(
      /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i
    );
    const thumbUrl = imgMatch?.[1] ? decodeHtmlEntities(imgMatch[1].trim()) : "";
    if (!thumbUrl) {
      continue;
    }

    if (/^https?:\/\//i.test(thumbUrl)) {
      orderedThumbs.push(thumbUrl);
    }

    const linkRegex =
      /<(?:a|option)\b[^>]*\b(?:href|value)=["']([^"']+)["'][^>]*>/gi;
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRegex.exec(block)) !== null) {
      const targetUrl = decodeHtmlEntities(linkMatch[1].trim());
      if (/^https?:\/\//i.test(targetUrl) && /^https?:\/\//i.test(thumbUrl)) {
        urlToThumb.set(targetUrl, thumbUrl);
      }
    }
  }

  const rawMediaList = rawResult.media;
  const enrichedMedia = rawMediaList.map((item, idx) => {
    if (!isPlainRecord(item)) {
      return item;
    }
    const existingThumb =
      typeof item.previewUrl === "string"
        ? item.previewUrl
        : typeof item.thumbnail === "string"
          ? item.thumbnail
          : null;
    if (existingThumb) {
      return item;
    }

    const itemUrl = typeof item.url === "string" ? item.url.trim() : "";
    const matchedThumb =
      (itemUrl ? urlToThumb.get(itemUrl) : undefined) ??
      (orderedThumbs.length === rawMediaList.length
        ? orderedThumbs[idx]
        : undefined);

    if (!matchedThumb) {
      return item;
    }

    return {
      ...item,
      thumbnailUrl: matchedThumb,
    };
  });

  return {
    ...rawResult,
    media: enrichedMedia,
  };
}

function invokeByMode(
  client: InstagramDownloaderClient,
  mode: InstagramFetchMode,
  normalizedInput: string
): Promise<unknown> {
  if (mode === "story") {
    return client.story(normalizedInput);
  }
  if (mode === "media") {
    return client.media(normalizedInput);
  }
  return client(normalizedInput);
}

export async function fetchFromInstagramPackage(params: {
  mode: InstagramFetchMode;
  normalizedInput: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<unknown> {
  if (params.signal?.aborted) {
    throw new RequestAbortedError();
  }

  const client = getInstagramClient();

  const packageCall = Promise.resolve()
    .then(() => invokeByMode(client, params.mode, params.normalizedInput))
    .then((result) => extractSnapVideoThumbnails(result));
  packageCall.catch(() => undefined);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const racePromises: Promise<unknown>[] = [packageCall];

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new UpstreamTimeoutError(
          "Batas waktu tunggu pemanggilan layanan pengambil media Instagram terlampaui."
        )
      );
    }, params.timeoutMs);
  });
  racePromises.push(timeoutPromise);

  if (params.signal) {
    const signal = params.signal;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        reject(new RequestAbortedError());
      };
      signal.addEventListener("abort", abortListener, { once: true });
    });
    racePromises.push(abortPromise);
  }

  try {
    return await Promise.race(racePromises);
  } catch (error) {
    if (error instanceof InstagramAppError) {
      throw error;
    }
    throw new UpstreamServiceError(
      "UPSTREAM_ERROR",
      "Gagal mengambil data media dari layanan upstream. Pastikan input valid dan konten bersifat publik."
    );
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    if (params.signal && abortListener) {
      params.signal.removeEventListener("abort", abortListener);
    }
  }
}
