import crypto from "node:crypto";
import { MediaNotFoundError, UpstreamServiceError } from "./errors";
import { sanitizeFilename, validateMediaUrl } from "./security";
import { signDownloadToken } from "./tokens";
import type {
  InstagramFetchData,
  InstagramFetchMode,
  InstagramRuntimeConfig,
  MediaCategory,
  NormalizedMedia,
  NormalizedMediaType,
} from "./types";

const PREVIEW_CANDIDATE_KEYS = [
  "previewUrl",
  "preview",
  "thumbnailUrl",
  "thumbnail",
  "poster",
  "displayUrl",
  "display_uri",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildPreviewProxyUrl(token: string): string {
  return `/api/instagram/preview?token=${encodeURIComponent(token)}`;
}

function normalizeMediaType(rawType: unknown): NormalizedMediaType {
  if (rawType === undefined) {
    return "unknown";
  }

  if (typeof rawType !== "string") {
    throw new UpstreamServiceError(
      "UPSTREAM_INVALID_RESPONSE",
      "Format tipe media dari layanan upstream tidak dikenali."
    );
  }

  const lower = rawType.trim().toLowerCase();
  if (lower === "photo" || lower === "image") {
    return "image";
  }
  if (lower === "video") {
    return "video";
  }
  if (lower === "media" || lower === "unknown") {
    return "unknown";
  }

  return "unknown";
}

function extractValidPreviewSourceUrl(
  item: Record<string, unknown>,
  canonicalUrl: string,
  mediaType: NormalizedMediaType,
  allowedDomains: readonly string[]
): string | null {
  for (const key of PREVIEW_CANDIDATE_KEYS) {
    const candidate = item[key];
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const validated = validateMediaUrl(trimmed, allowedDomains, "upstream");
      return validated.toString();
    } catch {
      continue;
    }
  }

  if (mediaType === "image") {
    return canonicalUrl;
  }

  return null;
}

export function buildMediaId(index: number, canonicalUrl: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${index}:${canonicalUrl}`)
    .digest("hex")
    .slice(0, 16);
  return `media_${digest}`;
}

function inferCategoryFromSingleInput(
  input: string,
  mode: InstagramFetchMode
): MediaCategory {
  if (mode === "story" || /\/stories\//i.test(input)) {
    return "stories";
  }
  if (/\/reels?\//i.test(input)) {
    return "reels";
  }
  if (/\/p\//i.test(input)) {
    return "post";
  }
  return "stories";
}

export function normalizePackageResult(params: {
  rawResult: unknown;
  mode: InstagramFetchMode;
  input: string;
  config: InstagramRuntimeConfig;
  categoryOverride?: MediaCategory;
  inputKind?: "profile" | "story" | "media";
}): InstagramFetchData {
  const { rawResult, mode, input, config } = params;

  if (!isPlainRecord(rawResult) || !("media" in rawResult)) {
    throw new UpstreamServiceError(
      "UPSTREAM_INVALID_RESPONSE",
      "Struktur respons layanan upstream tidak sesuai."
    );
  }

  const rawMediaList: unknown = rawResult.media;
  if (!Array.isArray(rawMediaList)) {
    throw new UpstreamServiceError(
      "UPSTREAM_INVALID_RESPONSE",
      "Daftar media pada respons layanan upstream tidak valid."
    );
  }

  if (rawMediaList.length === 0) {
    throw new MediaNotFoundError(
      "Tidak ada media yang tersedia dari sumber untuk input tersebut."
    );
  }

  const defaultCategory =
    params.categoryOverride ?? inferCategoryFromSingleInput(input, mode);
  const inputKind =
    params.inputKind ??
    (defaultCategory === "stories" ? "story" : "media");

  const seenUrls = new Set<string>();
  const usedFilenames = new Set<string>();
  const normalizedMedia: NormalizedMedia[] = [];

  for (let i = 0; i < rawMediaList.length; i += 1) {
    const item = rawMediaList[i];
    if (!isPlainRecord(item)) {
      throw new UpstreamServiceError(
        "UPSTREAM_INVALID_RESPONSE",
        "Format item media dari layanan upstream tidak dikenali."
      );
    }

    const rawUrl = item.url;
    if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
      throw new UpstreamServiceError(
        "UPSTREAM_INVALID_RESPONSE",
        "Item media dari layanan upstream tidak memiliki URL yang valid."
      );
    }

    const validatedUrl = validateMediaUrl(
      rawUrl.trim(),
      config.mediaAllowedDomains,
      "upstream"
    );
    const canonicalUrl = validatedUrl.toString();

    if (seenUrls.has(canonicalUrl)) {
      continue;
    }
    seenUrls.add(canonicalUrl);

    const mediaType = normalizeMediaType(item.type);

    const rawFilenameValue = item.filename;
    if (rawFilenameValue !== undefined && typeof rawFilenameValue !== "string") {
      throw new UpstreamServiceError(
        "UPSTREAM_INVALID_RESPONSE",
        "Nama file media dari layanan upstream tidak valid."
      );
    }
    const rawFilename: string | undefined =
      typeof rawFilenameValue === "string" ? rawFilenameValue : undefined;

    let filename = sanitizeFilename(
      rawFilename,
      mediaType,
      normalizedMedia.length
    );

    if (usedFilenames.has(filename.toLowerCase())) {
      const dotIdx = filename.lastIndexOf(".");
      const stem = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
      const ext = dotIdx > 0 ? filename.slice(dotIdx) : "";
      let suffix = 2;
      while (usedFilenames.has(`${stem}-${suffix}${ext}`.toLowerCase())) {
        suffix += 1;
      }
      filename = `${stem.slice(0, 105)}-${suffix}${ext}`;
    }
    usedFilenames.add(filename.toLowerCase());

    const downloadToken = signDownloadToken(
      {
        url: canonicalUrl,
        filename,
        type: mediaType,
      },
      config
    );

    const previewSourceUrl = extractValidPreviewSourceUrl(
      item,
      canonicalUrl,
      mediaType,
      config.mediaAllowedDomains
    );

    let previewUrl: string | null = null;
    if (previewSourceUrl) {
      if (previewSourceUrl === canonicalUrl && mediaType === "image") {
        previewUrl = buildPreviewProxyUrl(downloadToken);
      } else {
        const previewFilename = sanitizeFilename(
          `preview-${filename}`,
          "image",
          normalizedMedia.length
        );
        const previewToken = signDownloadToken(
          {
            url: previewSourceUrl,
            filename: previewFilename,
            type: "image",
          },
          config
        );
        previewUrl = buildPreviewProxyUrl(previewToken);
      }
    }

    const videoPreviewUrl =
      mediaType === "video" ? buildPreviewProxyUrl(downloadToken) : null;

    normalizedMedia.push({
      id: buildMediaId(normalizedMedia.length, canonicalUrl),
      type: mediaType,
      previewUrl,
      videoPreviewUrl,
      filename,
      downloadToken,
      category: defaultCategory,
      categories: [defaultCategory],
    });
  }

  if (normalizedMedia.length === 0) {
    throw new MediaNotFoundError(
      "Tidak ada media yang tersedia dari sumber untuk input tersebut."
    );
  }

  return {
    mode,
    input,
    inputKind,
    zipMaxFiles: config.zipMaxFiles,
    count: normalizedMedia.length,
    media: normalizedMedia,
  };
}
