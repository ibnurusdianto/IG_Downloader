import type {
  CategoryDiagnosticEntry,
  CategoryDiagnostics,
  CategoryFilter,
  CategorySourceStatus,
  FetchMediaResult,
  InstagramApiError,
  InstagramFetchData,
  InstagramFetchMode,
  InstagramMediaItem,
  MediaCategory,
  NormalizedMediaType,
  ProfileSummary,
} from "./types";

const FETCH_ENDPOINT = "/api/instagram/fetch";
const PREVIEW_PROXY_PREFIX = "/api/instagram/preview?token=";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractMediaType(contentType: string | null): string {
  if (!contentType) {
    return "";
  }
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isJsonContentType(contentType: string | null): boolean {
  const mediaType = extractMediaType(contentType);
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}

function isNormalizedMediaType(value: unknown): value is NormalizedMediaType {
  return value === "image" || value === "video" || value === "unknown";
}

function isInstagramFetchMode(value: unknown): value is InstagramFetchMode {
  return value === "auto" || value === "story" || value === "media";
}

function isMediaCategory(value: unknown): value is MediaCategory {
  return (
    value === "reels" ||
    value === "post" ||
    value === "stories" ||
    value === "tags"
  );
}

function isCategoryFilter(value: unknown): value is CategoryFilter {
  return value === "all" || isMediaCategory(value);
}

function isCategorySourceStatus(value: unknown): value is CategorySourceStatus {
  return (
    value === "ok" ||
    value === "empty" ||
    value === "login_required" ||
    value === "unavailable"
  );
}

function isSafePreviewUrl(value: string): boolean {
  if (value.startsWith(PREVIEW_PROXY_PREFIX) && value.length > PREVIEW_PROXY_PREFIX.length) {
    return true;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function parseOptionalPreviewUrl(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string" && isSafePreviewUrl(value.trim())) {
    return value.trim();
  }
  return undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const clean = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return clean;
}

function parseMediaItem(value: unknown): InstagramMediaItem | null {
  if (!isPlainRecord(value)) {
    return null;
  }

  if (
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    !isNormalizedMediaType(value.type) ||
    typeof value.filename !== "string" ||
    value.filename.trim().length === 0 ||
    typeof value.downloadToken !== "string" ||
    value.downloadToken.trim().length === 0
  ) {
    return null;
  }

  let previewUrl: string | null = null;
  if (value.previewUrl === null) {
    previewUrl = null;
  } else if (
    typeof value.previewUrl === "string" &&
    isSafePreviewUrl(value.previewUrl.trim())
  ) {
    previewUrl = value.previewUrl.trim();
  } else {
    return null;
  }

  const videoPreviewUrl = parseOptionalPreviewUrl(value.videoPreviewUrl) ?? null;

  const category: MediaCategory = isMediaCategory(value.category)
    ? value.category
    : "post";

  const categories: MediaCategory[] = Array.isArray(value.categories)
    ? value.categories.filter(isMediaCategory)
    : [category];

  return {
    id: value.id,
    type: value.type,
    previewUrl,
    videoPreviewUrl,
    filename: value.filename,
    downloadToken: value.downloadToken,
    category,
    categories: categories.length > 0 ? categories : [category],
    shortcode: typeof value.shortcode === "string" ? value.shortcode : undefined,
    caption: typeof value.caption === "string" ? value.caption : null,
    carouselIndex:
      typeof value.carouselIndex === "number" ? value.carouselIndex : undefined,
    carouselTotal:
      typeof value.carouselTotal === "number" ? value.carouselTotal : undefined,
    likeCount: typeof value.likeCount === "number" ? value.likeCount : null,
    commentCount:
      typeof value.commentCount === "number" ? value.commentCount : null,
    playCount: typeof value.playCount === "number" ? value.playCount : null,
    takenAt: typeof value.takenAt === "number" ? value.takenAt : null,
    taggedUsers: parseStringArray(value.taggedUsers),
    hashtags: parseStringArray(value.hashtags),
    mentions: parseStringArray(value.mentions),
  };
}

function parseProfileSummary(value: unknown): ProfileSummary | null {
  if (!isPlainRecord(value) || typeof value.username !== "string") {
    return null;
  }

  return {
    username: value.username,
    fullName: typeof value.fullName === "string" ? value.fullName : null,
    biography: typeof value.biography === "string" ? value.biography : null,
    avatarPreviewUrl: parseOptionalPreviewUrl(value.avatarPreviewUrl) ?? null,
    isVerified: value.isVerified === true,
    isPrivate: value.isPrivate === true,
    followerCount:
      typeof value.followerCount === "number" ? value.followerCount : null,
    followingCount:
      typeof value.followingCount === "number" ? value.followingCount : null,
    postsCount: typeof value.postsCount === "number" ? value.postsCount : null,
    hasActiveStories: value.hasActiveStories === true,
  };
}

function parseDiagnosticEntry(value: unknown): CategoryDiagnosticEntry | null {
  if (!isPlainRecord(value) || !isCategorySourceStatus(value.status)) {
    return null;
  }
  return {
    status: value.status,
    total: typeof value.total === "number" ? value.total : 0,
    message: typeof value.message === "string" ? value.message : undefined,
  };
}

function parseCategoryDiagnostics(value: unknown): CategoryDiagnostics | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  const reels = parseDiagnosticEntry(value.reels);
  const post = parseDiagnosticEntry(value.post);
  const stories = parseDiagnosticEntry(value.stories);
  const tagsBase = parseDiagnosticEntry(value.tags);

  if (!reels || !post || !stories || !tagsBase || !isPlainRecord(value.tags)) {
    return undefined;
  }

  return {
    reels,
    post,
    stories,
    tags: {
      ...tagsBase,
      discoveredUsertags: parseStringArray(value.tags.discoveredUsertags) ?? [],
      discoveredHashtags: parseStringArray(value.tags.discoveredHashtags) ?? [],
    },
  };
}

export function parseBackendErrorEnvelope(
  raw: unknown
): InstagramApiError | null {
  if (!isPlainRecord(raw) || raw.success !== false) {
    return null;
  }

  if (!isPlainRecord(raw.error)) {
    return null;
  }

  if (
    typeof raw.error.code !== "string" ||
    raw.error.code.trim().length === 0 ||
    typeof raw.error.message !== "string" ||
    raw.error.message.trim().length === 0
  ) {
    return null;
  }

  return {
    code: raw.error.code.trim(),
    message: raw.error.message.trim(),
  };
}

function parseFetchSuccessEnvelope(raw: unknown): InstagramFetchData | null {
  if (!isPlainRecord(raw) || raw.success !== true) {
    return null;
  }

  if (!isPlainRecord(raw.data)) {
    return null;
  }

  const data = raw.data;
  if (
    !isInstagramFetchMode(data.mode) ||
    typeof data.input !== "string" ||
    typeof data.count !== "number" ||
    !Number.isInteger(data.count) ||
    data.count < 0 ||
    !Array.isArray(data.media)
  ) {
    return null;
  }

  const media: InstagramMediaItem[] = [];
  for (const item of data.media) {
    const parsedItem = parseMediaItem(item);
    if (!parsedItem) {
      return null;
    }
    media.push(parsedItem);
  }

  const inputKind =
    data.inputKind === "profile" ||
    data.inputKind === "story" ||
    data.inputKind === "media"
      ? data.inputKind
      : "media";

  return {
    mode: data.mode,
    input: data.input,
    inputKind,
    initialCategory: isCategoryFilter(data.initialCategory)
      ? data.initialCategory
      : "all",
    profile: parseProfileSummary(data.profile),
    categoryDiagnostics: parseCategoryDiagnostics(data.categoryDiagnostics),
    zipMaxFiles:
      typeof data.zipMaxFiles === "number" ? data.zipMaxFiles : undefined,
    count: data.count,
    media,
  };
}

export function getFallbackHttpErrorMessage(
  status: number,
  context: "fetch" | "download"
): string {
  if (status === 404) {
    return context === "fetch"
      ? "Media tidak ditemukan atau endpoint tidak tersedia."
      : "File media tidak ditemukan atau tautan sumber sudah tidak berlaku.";
  }
  if (status === 413) {
    return "Ukuran permintaan atau media melebihi batas maksimum server.";
  }
  if (status === 429) {
    return "Terlalu banyak permintaan ke server. Silakan tunggu beberapa saat lalu coba lagi.";
  }
  if (status === 502 || status === 503 || status === 504) {
    return "Layanan server atau upstream sedang tidak tersedia atau melebihi batas waktu. Silakan coba lagi.";
  }
  return "Server mengembalikan respons yang tidak dapat diproses.";
}

export type ParsedHttpError = {
  kind: "backend" | "invalid_response";
  code?: string;
  message: string;
  status: number;
  isExpiredToken?: boolean;
  isNotFound?: boolean;
};

export async function readErrorFromResponse(
  response: Response,
  context: "fetch" | "download",
  signal?: AbortSignal
): Promise<ParsedHttpError> {
  const contentType = response.headers.get("content-type");
  if (!isJsonContentType(contentType)) {
    return {
      kind: "invalid_response",
      message: getFallbackHttpErrorMessage(response.status, context),
      status: response.status,
    };
  }

  let rawText: string;
  try {
    rawText = await response.text();
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    return {
      kind: "invalid_response",
      message: getFallbackHttpErrorMessage(response.status, context),
      status: response.status,
    };
  }

  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText) as unknown;
  } catch {
    return {
      kind: "invalid_response",
      message: "Server mengembalikan respons JSON yang tidak valid.",
      status: response.status,
    };
  }

  const backendError = parseBackendErrorEnvelope(parsedJson);
  if (!backendError) {
    return {
      kind: "invalid_response",
      message: getFallbackHttpErrorMessage(response.status, context),
      status: response.status,
    };
  }

  return {
    kind: "backend",
    code: backendError.code,
    message: backendError.message,
    status: response.status,
    isExpiredToken: backendError.code === "TOKEN_EXPIRED",
    isNotFound: backendError.code === "MEDIA_NOT_FOUND",
  };
}

export async function fetchInstagramMedia(params: {
  input: string;
  mode: InstagramFetchMode;
  signal: AbortSignal;
}): Promise<FetchMediaResult> {
  if (params.signal.aborted) {
    return { ok: false, kind: "aborted" };
  }

  let response: Response;
  try {
    response = await fetch(FETCH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        input: params.input,
        mode: params.mode,
      }),
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
        "Gagal terhubung ke server. Periksa koneksi jaringan Anda lalu coba lagi.",
    };
  }

  if (params.signal.aborted) {
    return { ok: false, kind: "aborted" };
  }

  if (!response.ok) {
    try {
      const errorInfo = await readErrorFromResponse(
        response,
        "fetch",
        params.signal
      );
      return {
        ok: false,
        kind: errorInfo.kind,
        code: errorInfo.code,
        message: errorInfo.message,
        status: errorInfo.status,
        isExpiredToken: errorInfo.isExpiredToken,
        isNotFound: errorInfo.isNotFound,
      };
    } catch (error) {
      if (isAbortError(error, params.signal)) {
        return { ok: false, kind: "aborted" };
      }
      return {
        ok: false,
        kind: "invalid_response",
        message: "Gagal membaca respons error dari server.",
        status: response.status,
      };
    }
  }

  if (!isJsonContentType(response.headers.get("content-type"))) {
    return {
      ok: false,
      kind: "invalid_response",
      message: "Respons server tidak berformat JSON.",
      status: response.status,
    };
  }

  let rawText: string;
  try {
    rawText = await response.text();
  } catch (error) {
    if (isAbortError(error, params.signal)) {
      return { ok: false, kind: "aborted" };
    }
    return {
      ok: false,
      kind: "network",
      message: "Gagal membaca respons dari server.",
      status: response.status,
    };
  }

  if (params.signal.aborted) {
    return { ok: false, kind: "aborted" };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText) as unknown;
  } catch {
    return {
      ok: false,
      kind: "invalid_response",
      message: "Respons JSON dari server rusak atau tidak dapat diurai.",
      status: response.status,
    };
  }

  const successData = parseFetchSuccessEnvelope(parsedJson);
  if (successData) {
    return { ok: true, data: successData };
  }

  const backendError = parseBackendErrorEnvelope(parsedJson);
  if (backendError) {
    return {
      ok: false,
      kind: "backend",
      code: backendError.code,
      message: backendError.message,
      status: response.status,
      isExpiredToken: backendError.code === "TOKEN_EXPIRED",
      isNotFound: backendError.code === "MEDIA_NOT_FOUND",
    };
  }

  return {
    ok: false,
    kind: "invalid_response",
    message: "Struktur respons media dari server tidak dikenali.",
    status: response.status,
  };
}
