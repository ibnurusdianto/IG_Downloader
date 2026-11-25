import crypto from "node:crypto";
import { TokenAuthError } from "./errors";
import { sanitizeFilename, validateMediaUrl } from "./security";
import type {
  InstagramRuntimeConfig,
  NormalizedMediaType,
  SignedDownloadTokenPayload,
} from "./types";

const TOKEN_FORMAT_REGEX = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JTI_REGEX = /^[0-9a-f]{24}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNormalizedMediaType(value: unknown): value is NormalizedMediaType {
  return value === "image" || value === "video" || value === "unknown";
}

function isTokenPayloadShape(
  value: unknown
): value is SignedDownloadTokenPayload {
  if (!isPlainRecord(value)) {
    return false;
  }

  return (
    value.v === 1 &&
    typeof value.u === "string" &&
    value.u.length > 0 &&
    value.u.length <= 8192 &&
    typeof value.f === "string" &&
    value.f.length > 0 &&
    value.f.length <= 255 &&
    isNormalizedMediaType(value.t) &&
    typeof value.iat === "number" &&
    Number.isInteger(value.iat) &&
    value.iat > 0 &&
    typeof value.exp === "number" &&
    Number.isInteger(value.exp) &&
    value.exp > value.iat &&
    typeof value.jti === "string" &&
    JTI_REGEX.test(value.jti)
  );
}

export function signDownloadToken(
  params: {
    url: string;
    filename: string;
    type: NormalizedMediaType;
  },
  config: InstagramRuntimeConfig
): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: SignedDownloadTokenPayload = {
    v: 1,
    u: params.url,
    f: params.filename,
    t: params.type,
    iat: issuedAt,
    exp: issuedAt + config.tokenTtlSeconds,
    jti: crypto.randomBytes(12).toString("hex"),
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  const signature = crypto
    .createHmac("sha256", config.tokenSecret)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

export function verifyDownloadToken(
  token: string,
  config: InstagramRuntimeConfig
): SignedDownloadTokenPayload {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > config.maxTokenLength ||
    !TOKEN_FORMAT_REGEX.test(token)
  ) {
    throw new TokenAuthError(
      "INVALID_TOKEN",
      "Token unduhan tidak valid."
    );
  }

  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0 || dotIndex >= token.length - 1) {
    throw new TokenAuthError(
      "INVALID_TOKEN",
      "Format token unduhan tidak valid."
    );
  }

  const encodedPayload = token.slice(0, dotIndex);
  const encodedSignature = token.slice(dotIndex + 1);

  const expectedSignature = crypto
    .createHmac("sha256", config.tokenSecret)
    .update(encodedPayload)
    .digest();
  const actualSignature = Buffer.from(encodedSignature, "base64url");

  if (
    actualSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new TokenAuthError(
      "INVALID_TOKEN",
      "Tanda tangan token unduhan tidak valid."
    );
  }

  let parsedJson: unknown;
  try {
    const rawPayload = Buffer.from(encodedPayload, "base64url").toString("utf8");
    parsedJson = JSON.parse(rawPayload);
  } catch {
    throw new TokenAuthError(
      "INVALID_TOKEN",
      "Payload token unduhan tidak dapat dibaca."
    );
  }

  if (!isTokenPayloadShape(parsedJson)) {
    throw new TokenAuthError(
      "INVALID_TOKEN",
      "Struktur payload token unduhan tidak valid."
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (parsedJson.iat > nowSeconds + 60) {
    throw new TokenAuthError(
      "INVALID_TOKEN",
      "Waktu penerbitan token tidak valid."
    );
  }

  if (nowSeconds >= parsedJson.exp) {
    throw new TokenAuthError(
      "TOKEN_EXPIRED",
      "Token unduhan telah kedaluwarsa. Silakan ambil ulang data media."
    );
  }

  const validatedUrl = validateMediaUrl(
    parsedJson.u,
    config.mediaAllowedDomains,
    "download"
  );
  const safeFilename = sanitizeFilename(parsedJson.f, parsedJson.t, 0);

  return {
    ...parsedJson,
    u: validatedUrl.toString(),
    f: safeFilename,
  };
}
