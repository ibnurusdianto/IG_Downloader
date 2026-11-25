import { BadRequestError, PayloadTooLargeError } from "./errors";
import type {
  CategoryFilter,
  InstagramFetchMode,
  ValidatedInstagramInput,
} from "./types";

const ALLOWED_INSTAGRAM_HOSTNAMES = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
]);

const RESERVED_PROFILE_SEGMENTS = new Set([
  "p",
  "reel",
  "reels",
  "stories",
  "explore",
  "accounts",
  "direct",
  "tv",
  "ar",
  "oauth",
  "api",
  "graphql",
  "static",
  "about",
  "legal",
  "developer",
  "privacy",
  "terms",
  "challenge",
  "directory",
  "nametag",
]);

const PROFILE_TAB_CATEGORY_MAP: Record<string, CategoryFilter> = {
  reels: "reels",
  tagged: "tags",
};

const INSTAGRAM_USERNAME_REGEX = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._]{1,30}(?<!\.)$/;
const INSTAGRAM_SHORTCODE_REGEX = /^[A-Za-z0-9_-]{3,64}$/;
const INSTAGRAM_STORY_ID_REGEX = /^\d{1,30}$/;
const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f]/;
const BARE_INSTAGRAM_URL_REGEX = /^(?:(?:www|m)\.)?instagram\.com\//i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidInstagramUsername(username: string): boolean {
  if (!INSTAGRAM_USERNAME_REGEX.test(username)) {
    return false;
  }
  const lower = username.toLowerCase();
  if (ALLOWED_INSTAGRAM_HOSTNAMES.has(lower)) {
    return false;
  }
  return !RESERVED_PROFILE_SEGMENTS.has(lower);
}

export async function readBoundedJsonBody(
  request: Request,
  maxBytes: number
): Promise<unknown> {
  const contentType = request.headers.get("content-type");
  if (contentType !== null) {
    const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (
      mediaType !== "" &&
      mediaType !== "application/json" &&
      !mediaType.endsWith("+json")
    ) {
      throw new BadRequestError(
        "INVALID_CONTENT_TYPE",
        "Header Content-Type harus berupa application/json."
      );
    }
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const trimmedLength = contentLengthHeader.trim();
    if (!/^\d+$/.test(trimmedLength)) {
      throw new BadRequestError(
        "INVALID_CONTENT_LENGTH",
        "Header Content-Length tidak valid."
      );
    }
    const declaredLength = Number(trimmedLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      throw new PayloadTooLargeError(
        "PAYLOAD_TOO_LARGE",
        "Ukuran request body melebihi batas maksimum yang diizinkan."
      );
    }
  }

  if (!request.body) {
    throw new BadRequestError(
      "INVALID_JSON",
      "Body request JSON wajib diisi."
    );
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError(
          "PAYLOAD_TOO_LARGE",
          "Ukuran request body melebihi batas maksimum yang diizinkan."
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    throw new BadRequestError(
      "INVALID_JSON",
      "Body request JSON tidak boleh kosong."
    );
  }

  const buffer = Buffer.concat(
    chunks.map((chunk) =>
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    ),
    totalBytes
  );

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new BadRequestError(
      "INVALID_JSON",
      "Encoding body request JSON tidak valid."
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequestError(
      "INVALID_JSON",
      "Format JSON pada request body tidak valid."
    );
  }
}

export function parseFetchRequestBody(
  rawBody: unknown,
  maxInputLength: number
): { input: string; mode: InstagramFetchMode } {
  if (!isPlainRecord(rawBody)) {
    throw new BadRequestError(
      "INVALID_JSON",
      "Request body harus berupa objek JSON."
    );
  }

  let mode: InstagramFetchMode = "auto";
  if (rawBody.mode !== undefined) {
    if (
      rawBody.mode !== "auto" &&
      rawBody.mode !== "story" &&
      rawBody.mode !== "media"
    ) {
      throw new BadRequestError(
        "INVALID_MODE",
        "Nilai mode harus salah satu dari: auto, story, atau media."
      );
    }
    mode = rawBody.mode;
  }

  if (typeof rawBody.input !== "string") {
    throw new BadRequestError(
      "INVALID_INPUT",
      "Field input wajib berupa string."
    );
  }

  const trimmed = rawBody.input.trim();
  if (trimmed.length === 0) {
    throw new BadRequestError(
      "INVALID_INPUT",
      "Input username atau URL Instagram tidak boleh kosong."
    );
  }

  if (trimmed.length > maxInputLength) {
    throw new BadRequestError(
      "INPUT_TOO_LONG",
      "Panjang input melebihi batas maksimum yang diizinkan."
    );
  }

  if (CONTROL_CHAR_REGEX.test(trimmed)) {
    throw new BadRequestError(
      "INVALID_INPUT",
      "Input mengandung karakter kontrol yang tidak diizinkan."
    );
  }

  return { input: trimmed, mode };
}

function tryParseUrl(value: string): URL | null {
  const candidate = BARE_INSTAGRAM_URL_REGEX.test(value)
    ? `https://${value}`
    : value;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

export function validateAndNormalizeFetchInput(
  trimmedInput: string,
  mode: InstagramFetchMode
): ValidatedInstagramInput {
  if (trimmedInput.includes("\\")) {
    throw new BadRequestError(
      "INVALID_INPUT",
      "Input mengandung karakter backslash yang tidak diizinkan."
    );
  }

  const parsedUrl = tryParseUrl(trimmedInput);
  if (parsedUrl) {
    if (parsedUrl.protocol !== "https:") {
      throw new BadRequestError(
        "UNSUPPORTED_PROTOCOL",
        "Hanya URL Instagram dengan protokol HTTPS yang diterima."
      );
    }

    if (parsedUrl.username !== "" || parsedUrl.password !== "") {
      throw new BadRequestError(
        "INVALID_URL_CREDENTIALS",
        "URL tidak boleh mengandung username atau password."
      );
    }

    if (parsedUrl.port !== "") {
      throw new BadRequestError(
        "UNSUPPORTED_PORT",
        "Port non-standar pada URL Instagram tidak diizinkan."
      );
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    if (
      parsedUrl.hostname.endsWith(".") ||
      !ALLOWED_INSTAGRAM_HOSTNAMES.has(hostname)
    ) {
      throw new BadRequestError(
        "UNSUPPORTED_HOST",
        "Hostname URL harus berupa domain Instagram yang didukung (instagram.com, www.instagram.com, atau m.instagram.com)."
      );
    }

    if (/%2f|%5c/i.test(parsedUrl.pathname)) {
      throw new BadRequestError(
        "INVALID_URL_PATH",
        "Path URL Instagram mengandung karakter encoded yang tidak valid."
      );
    }

    const segments = parsedUrl.pathname.split("/").filter(Boolean);
    if (segments.length === 0) {
      throw new BadRequestError(
        "UNSUPPORTED_PATH",
        "URL beranda Instagram tidak didukung. Gunakan username, URL profil (/username/), URL Stories (/stories/username/), URL Reels (/reel/shortcode/), atau URL postingan (/p/shortcode/)."
      );
    }

    const first = segments[0].toLowerCase();

    if (first === "stories") {
      if (segments.length < 2 || segments.length > 3) {
        throw new BadRequestError(
          "UNSUPPORTED_PATH",
          "Path URL Stories Instagram tidak didukung."
        );
      }

      const username = segments[1];
      if (
        username.toLowerCase() === "highlights" ||
        !isValidInstagramUsername(username)
      ) {
        throw new BadRequestError(
          "UNSUPPORTED_PATH",
          "URL Stories Instagram harus mencantumkan username yang valid (/stories/username/)."
        );
      }

      if (segments.length === 3 && !INSTAGRAM_STORY_ID_REGEX.test(segments[2])) {
        throw new BadRequestError(
          "UNSUPPORTED_PATH",
          "ID Stories pada URL Instagram tidak valid."
        );
      }

      if (mode === "media") {
        throw new BadRequestError(
          "INVALID_MODE_INPUT",
          "Mode 'media' hanya menerima URL Reels (/reel/...) atau postingan (/p/...)."
        );
      }

      const normalizedStoryUrl =
        segments.length === 3
          ? `https://www.instagram.com/stories/${username}/${segments[2]}/`
          : `https://www.instagram.com/stories/${username}/`;

      return {
        kind: "story_url",
        normalizedInput: normalizedStoryUrl,
        username,
      };
    }

    if ((first === "reel" || first === "reels") && segments.length === 2) {
      const shortcode = segments[1];
      if (!INSTAGRAM_SHORTCODE_REGEX.test(shortcode)) {
        throw new BadRequestError(
          "UNSUPPORTED_PATH",
          "Shortcode URL Reels Instagram tidak valid."
        );
      }

      if (mode === "story") {
        throw new BadRequestError(
          "INVALID_MODE_INPUT",
          "Mode 'story' hanya menerima username, URL profil, atau URL Stories Instagram."
        );
      }

      return {
        kind: "media_url",
        normalizedInput: `https://www.instagram.com/reel/${shortcode}/`,
      };
    }

    if (first === "p" && segments.length === 2) {
      const shortcode = segments[1];
      if (!INSTAGRAM_SHORTCODE_REGEX.test(shortcode)) {
        throw new BadRequestError(
          "UNSUPPORTED_PATH",
          "Shortcode URL postingan Instagram tidak valid."
        );
      }

      if (mode === "story") {
        throw new BadRequestError(
          "INVALID_MODE_INPUT",
          "Mode 'story' hanya menerima username, URL profil, atau URL Stories Instagram."
        );
      }

      return {
        kind: "media_url",
        normalizedInput: `https://www.instagram.com/p/${shortcode}/`,
      };
    }

    const profileUsername = segments[0].startsWith("@")
      ? segments[0].slice(1)
      : segments[0];
    const secondSegment = segments[1]?.toLowerCase();
    const isProfileTab =
      segments.length === 1 ||
      (segments.length === 2 &&
        secondSegment !== undefined &&
        (secondSegment === "reels" ||
          secondSegment === "tagged" ||
          secondSegment === "channel"));

    if (isProfileTab && isValidInstagramUsername(profileUsername)) {
      if (mode === "media") {
        throw new BadRequestError(
          "INVALID_MODE_INPUT",
          "Mode 'Reels/Post' hanya menerima URL Reels (/reel/...) atau postingan (/p/...). Gunakan mode Auto untuk mengambil seluruh data profil."
        );
      }

      return {
        kind: "profile_url",
        normalizedInput: `https://www.instagram.com/${profileUsername}/`,
        username: profileUsername,
        initialCategory:
          secondSegment && PROFILE_TAB_CATEGORY_MAP[secondSegment]
            ? PROFILE_TAB_CATEGORY_MAP[secondSegment]
            : "all",
      };
    }

    throw new BadRequestError(
      "UNSUPPORTED_PATH",
      "Path URL Instagram tidak didukung. Gunakan URL profil (/username/), Stories (/stories/username/), Reels (/reel/shortcode/), atau postingan (/p/shortcode/)."
    );
  }

  if (
    trimmedInput.includes("/") ||
    trimmedInput.includes(":") ||
    trimmedInput.includes("?") ||
    trimmedInput.includes("#") ||
    /\s/.test(trimmedInput)
  ) {
    throw new BadRequestError(
      "INVALID_INPUT",
      "Format input tidak valid. Gunakan username Instagram (@username atau username) atau URL HTTPS Instagram yang lengkap."
    );
  }

  const username = trimmedInput.startsWith("@")
    ? trimmedInput.slice(1)
    : trimmedInput;

  if (!isValidInstagramUsername(username)) {
    throw new BadRequestError(
      "INVALID_USERNAME",
      "Username Instagram tidak valid. Gunakan 1-30 karakter huruf, angka, titik, atau garis bawah."
    );
  }

  if (mode === "media") {
    throw new BadRequestError(
      "INVALID_MODE_INPUT",
      "Mode 'media' hanya menerima URL Reels atau postingan Instagram, bukan username. Gunakan mode Auto untuk mengambil seluruh isi profil."
    );
  }

  return {
    kind: "username",
    normalizedInput: username,
    username,
    initialCategory: "all",
  };
}

export function parseDownloadRequestBody(
  rawBody: unknown,
  maxTokenLength: number
): string {
  if (!isPlainRecord(rawBody)) {
    throw new BadRequestError(
      "INVALID_JSON",
      "Request body harus berupa objek JSON."
    );
  }

  if (typeof rawBody.token !== "string") {
    throw new BadRequestError(
      "INVALID_INPUT",
      "Field token wajib berupa string."
    );
  }

  const token = rawBody.token.trim();
  if (token.length === 0) {
    throw new BadRequestError(
      "INVALID_INPUT",
      "Token unduhan tidak boleh kosong."
    );
  }

  if (token.length > maxTokenLength) {
    throw new BadRequestError(
      "INVALID_TOKEN",
      "Ukuran token unduhan melebihi batas yang diizinkan."
    );
  }

  return token;
}

export function parseZipRequestBody(
  rawBody: unknown,
  maxTokenLength: number,
  maxFiles: number
): string[] {
  if (!isPlainRecord(rawBody)) {
    throw new BadRequestError(
      "INVALID_JSON",
      "Request body harus berupa objek JSON."
    );
  }

  if (!Array.isArray(rawBody.tokens)) {
    throw new BadRequestError(
      "INVALID_INPUT",
      "Field tokens wajib berupa array string."
    );
  }

  if (rawBody.tokens.length === 0) {
    throw new BadRequestError(
      "INVALID_INPUT",
      "Daftar tokens tidak boleh kosong."
    );
  }

  const maxRawTokens = Math.max(maxFiles * 4, 100);
  if (rawBody.tokens.length > maxRawTokens) {
    throw new PayloadTooLargeError(
      "ZIP_FILE_LIMIT_EXCEEDED",
      "Jumlah token dalam permintaan ZIP melampaui batas maksimum."
    );
  }

  const tokens: string[] = [];
  for (const item of rawBody.tokens) {
    if (typeof item !== "string") {
      throw new BadRequestError(
        "INVALID_INPUT",
        "Setiap elemen tokens harus berupa string."
      );
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      throw new BadRequestError(
        "INVALID_INPUT",
        "Elemen token tidak boleh kosong."
      );
    }
    if (trimmed.length > maxTokenLength) {
      throw new BadRequestError(
        "INVALID_TOKEN",
        "Ukuran salah satu token melebihi batas yang diizinkan."
      );
    }
    tokens.push(trimmed);
  }

  return tokens;
}
