import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import net from "node:net";
import type { LookupAddress } from "node:dns";
import {
  ForbiddenMediaError,
  ServerConfigError,
  UpstreamServiceError,
} from "./errors";
import type { InstagramRuntimeConfig, NormalizedMediaType } from "./types";

const WEAK_SECRET_PATTERNS = [
  "replace-with",
  "changeme",
  "your-secret",
  "example",
  "default",
  "test-secret",
  "instagram-secret",
];

const RESERVED_LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".arpa",
  ".localdomain",
];

const DOMAIN_LABEL_REGEX =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function parseBoundedIntEnv(
  envName: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ServerConfigError(
      `Konfigurasi ${envName} harus berupa bilangan bulat yang valid.`
    );
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ServerConfigError(
      `Konfigurasi ${envName} berada di luar batas yang diizinkan (${min}..${max}).`
    );
  }

  return parsed;
}

function validateTokenSecret(rawSecret: string | undefined): string {
  const secret = (rawSecret ?? "").trim();
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new ServerConfigError(
      "Konfigurasi secret token tidak valid atau belum diatur (minimal 32 byte)."
    );
  }

  const lower = secret.toLowerCase();
  if (WEAK_SECRET_PATTERNS.some((pattern) => lower.includes(pattern))) {
    throw new ServerConfigError(
      "Konfigurasi secret token menggunakan nilai contoh atau placeholder yang tidak aman."
    );
  }

  const uniqueChars = new Set(secret);
  if (uniqueChars.size < 8) {
    throw new ServerConfigError(
      "Konfigurasi secret token memiliki entropi terlalu rendah."
    );
  }

  return secret;
}

export function isValidAllowlistDomain(domain: string): boolean {
  if (!domain || domain.includes("*") || domain.endsWith(".") || domain.startsWith(".")) {
    return false;
  }
  if (net.isIP(domain) !== 0) {
    return false;
  }
  if (
    domain === "localhost" ||
    RESERVED_LOCAL_SUFFIXES.some((suffix) => domain.endsWith(suffix))
  ) {
    return false;
  }
  return DOMAIN_LABEL_REGEX.test(domain) && domain.length <= 253;
}

function parseMediaAllowedDomains(rawDomains: string | undefined): readonly string[] {
  const raw = (rawDomains ?? "").trim();
  if (!raw) {
    throw new ServerConfigError(
      "Konfigurasi allowlist domain media belum diatur di server."
    );
  }

  const entries = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

  if (entries.length === 0) {
    throw new ServerConfigError(
      "Konfigurasi allowlist domain media tidak boleh kosong."
    );
  }

  const uniqueDomains: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!isValidAllowlistDomain(entry)) {
      throw new ServerConfigError(
        "Konfigurasi allowlist domain media mengandung entri tidak valid atau wildcard."
      );
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      uniqueDomains.push(entry);
    }
  }

  return uniqueDomains;
}

export function loadInstagramConfig(): InstagramRuntimeConfig {
  const tokenSecret = validateTokenSecret(process.env.INSTAGRAM_TOKEN_SECRET);
  const mediaAllowedDomains = parseMediaAllowedDomains(
    process.env.INSTAGRAM_MEDIA_ALLOWED_DOMAINS
  );

  return {
    tokenSecret,
    tokenTtlSeconds: parseBoundedIntEnv(
      "INSTAGRAM_TOKEN_TTL_SECONDS",
      600,
      30,
      86400
    ),
    mediaAllowedDomains,
    fetchTimeoutMs: parseBoundedIntEnv(
      "INSTAGRAM_FETCH_TIMEOUT_MS",
      45000,
      1000,
      120000
    ),
    downloadTimeoutMs: parseBoundedIntEnv(
      "INSTAGRAM_DOWNLOAD_TIMEOUT_MS",
      30000,
      1000,
      300000
    ),
    zipTimeoutMs: parseBoundedIntEnv(
      "INSTAGRAM_ZIP_TIMEOUT_MS",
      120000,
      5000,
      600000
    ),
    maxRequestBodyBytes: parseBoundedIntEnv(
      "INSTAGRAM_MAX_REQUEST_BODY_BYTES",
      262144,
      512,
      2097152
    ),
    maxInputLength: parseBoundedIntEnv(
      "INSTAGRAM_MAX_INPUT_LENGTH",
      512,
      30,
      2048
    ),
    maxTokenLength: parseBoundedIntEnv(
      "INSTAGRAM_MAX_TOKEN_LENGTH",
      8192,
      128,
      16384
    ),
    maxFileBytes: parseBoundedIntEnv(
      "INSTAGRAM_MAX_FILE_BYTES",
      52428800,
      1024,
      524288000
    ),
    zipMaxFiles: parseBoundedIntEnv("INSTAGRAM_ZIP_MAX_FILES", 1000000000, 1000000000, 1000000000),
    zipMaxTotalBytes: parseBoundedIntEnv(
      "INSTAGRAM_ZIP_MAX_TOTAL_BYTES",
      209715200,
      1024,
      1073741824
    ),
    zipConcurrency: parseBoundedIntEnv("INSTAGRAM_ZIP_CONCURRENCY", 3, 1, 10),
  };
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) {
      return null;
    }
    const num = Number(part);
    if (num < 0 || num > 255) {
      return null;
    }
    octets.push(num);
  }

  return [octets[0], octets[1], octets[2], octets[3]];
}

function isBlockedIpv4Octets(a: number, b: number, c: number): boolean {
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv6Groups(rawIp: string): number[] | null {
  if (!rawIp || rawIp.includes("%")) {
    return null;
  }

  const lower = rawIp.toLowerCase();
  const doubleColonParts = lower.split("::");
  if (doubleColonParts.length > 2) {
    return null;
  }

  const parseSegmentList = (segment: string): number[] | null => {
    if (!segment) {
      return [];
    }
    const tokens = segment.split(":");
    const groups: number[] = [];

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!token) {
        return null;
      }
      if (token.includes(".")) {
        if (i !== tokens.length - 1) {
          return null;
        }
        const octets = parseIpv4Octets(token);
        if (!octets) {
          return null;
        }
        groups.push((octets[0] << 8) | octets[1]);
        groups.push((octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(token)) {
          return null;
        }
        groups.push(Number.parseInt(token, 16));
      }
    }

    return groups;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseSegmentList(doubleColonParts[0]);
    if (!groups || groups.length !== 8) {
      return null;
    }
    return groups;
  }

  const head = parseSegmentList(doubleColonParts[0]);
  const tail = parseSegmentList(doubleColonParts[1]);
  if (!head || !tail) {
    return null;
  }

  const missing = 8 - (head.length + tail.length);
  if (missing < 1) {
    return null;
  }

  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

function isBlockedIpv6Groups(groups: number[]): boolean {
  const allZeroPrefix6 =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0;

  if (allZeroPrefix6 && groups[5] === 0 && groups[6] === 0 && groups[7] === 0) {
    return true;
  }
  if (allZeroPrefix6 && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) {
    return true;
  }
  if (allZeroPrefix6 && groups[5] === 0) {
    return true;
  }
  if (allZeroPrefix6 && groups[5] === 0xffff) {
    const a = (groups[6] >> 8) & 0xff;
    const b = groups[6] & 0xff;
    const c = (groups[7] >> 8) & 0xff;
    return isBlockedIpv4Octets(a, b, c);
  }
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    const a = (groups[6] >> 8) & 0xff;
    const b = groups[6] & 0xff;
    const c = (groups[7] >> 8) & 0xff;
    return isBlockedIpv4Octets(a, b, c);
  }
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001) {
    return true;
  }
  if (
    groups[0] === 0x0100 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0
  ) {
    return true;
  }
  if (groups[0] === 0x2001 && groups[1] === 0x0000) {
    return true;
  }
  if (groups[0] === 0x2001 && groups[1] === 0x0002 && groups[2] === 0x0000) {
    return true;
  }
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) {
    return true;
  }
  if (groups[0] === 0x2002) {
    return true;
  }
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return true;
  }
  if ((groups[0] & 0xffc0) === 0xfe80) {
    return true;
  }
  if ((groups[0] & 0xffc0) === 0xfec0) {
    return true;
  }
  if ((groups[0] & 0xff00) === 0xff00) {
    return true;
  }

  return false;
}

export function isBlockedIpAddress(rawIp: string): boolean {
  const ip = rawIp.trim();
  const ipVersion = net.isIP(ip);

  if (ipVersion === 4) {
    const octets = parseIpv4Octets(ip);
    if (!octets) {
      return true;
    }
    return isBlockedIpv4Octets(octets[0], octets[1], octets[2]);
  }

  if (ipVersion === 6) {
    const groups = parseIpv6Groups(ip);
    if (!groups) {
      return true;
    }
    return isBlockedIpv6Groups(groups);
  }

  return true;
}

export function isHostnameInAllowlist(
  rawHostname: string,
  allowlist: readonly string[]
): boolean {
  const hostname = rawHostname.toLowerCase();
  if (!isValidAllowlistDomain(hostname)) {
    return false;
  }

  for (const allowedDomain of allowlist) {
    if (
      hostname === allowedDomain ||
      hostname.endsWith(`.${allowedDomain}`)
    ) {
      return true;
    }
  }

  return false;
}

export function validateMediaUrl(
  rawUrl: string,
  allowlist: readonly string[],
  context: "upstream" | "download" = "download"
): URL {
  if (allowlist.length === 0) {
    throw new ServerConfigError(
      "Konfigurasi allowlist domain media belum diatur di server."
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    if (context === "upstream") {
      throw new UpstreamServiceError(
        "UPSTREAM_UNTRUSTED_MEDIA",
        "URL media dari layanan upstream tidak valid."
      );
    }
    throw new ForbiddenMediaError(
      "MEDIA_URL_NOT_ALLOWED",
      "URL media tidak valid."
    );
  }

  if (parsed.protocol !== "https:") {
    if (context === "upstream") {
      throw new UpstreamServiceError(
        "UPSTREAM_UNTRUSTED_MEDIA",
        "URL media dari layanan upstream wajib menggunakan HTTPS."
      );
    }
    throw new ForbiddenMediaError(
      "MEDIA_URL_NOT_ALLOWED",
      "Hanya URL media HTTPS yang diizinkan."
    );
  }

  if (parsed.username !== "" || parsed.password !== "") {
    if (context === "upstream") {
      throw new UpstreamServiceError(
        "UPSTREAM_UNTRUSTED_MEDIA",
        "URL media tidak boleh mengandung kredensial."
      );
    }
    throw new ForbiddenMediaError(
      "MEDIA_URL_NOT_ALLOWED",
      "URL media tidak boleh mengandung kredensial."
    );
  }

  if (parsed.port !== "") {
    if (context === "upstream") {
      throw new UpstreamServiceError(
        "UPSTREAM_UNTRUSTED_MEDIA",
        "URL media menggunakan port non-standar yang tidak diizinkan."
      );
    }
    throw new ForbiddenMediaError(
      "MEDIA_URL_NOT_ALLOWED",
      "Port non-standar tidak diizinkan untuk URL media."
    );
  }

  if (!isHostnameInAllowlist(parsed.hostname, allowlist)) {
    if (context === "upstream") {
      throw new UpstreamServiceError(
        "UPSTREAM_UNTRUSTED_MEDIA",
        "Domain media dari layanan upstream tidak termasuk dalam allowlist yang dikonfigurasi."
      );
    }
    throw new ForbiddenMediaError(
      "MEDIA_URL_NOT_ALLOWED",
      "Domain media tidak diizinkan oleh kebijakan keamanan server."
    );
  }

  return parsed;
}

export function createPinnedLookup(
  expectedHostname: string,
  verifiedIps: Set<string>
): net.LookupFunction {
  const expectedLower = expectedHostname.toLowerCase();

  return (
    hostname: string,
    options: dns.LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number
    ) => void
  ) => {
    if (hostname.toLowerCase() !== expectedLower) {
      callback(
        new ForbiddenMediaError(
          "MEDIA_HOST_MISMATCH",
          "Hostname resolusi DNS tidak cocok dengan host tujuan."
        ),
        ""
      );
      return;
    }

    dnsPromises
      .lookup(hostname, { all: true, verbatim: true })
      .then((records) => {
        if (!Array.isArray(records) || records.length === 0) {
          callback(
            new UpstreamServiceError(
              "UPSTREAM_DNS_ERROR",
              "Gagal menyelesaikan alamat host media."
            ),
            ""
          );
          return;
        }

        for (const record of records) {
          if (isBlockedIpAddress(record.address)) {
            callback(
              new ForbiddenMediaError(
                "MEDIA_IP_BLOCKED",
                "Alamat tujuan media mengarah ke jaringan internal atau terlarang."
              ),
              ""
            );
            return;
          }
        }

        const requestedFamily = options.family;
        const filtered =
          requestedFamily === 4 || requestedFamily === 6
            ? records.filter((record) => record.family === requestedFamily)
            : records;

        if (filtered.length === 0) {
          callback(
            new UpstreamServiceError(
              "UPSTREAM_DNS_ERROR",
              "Tidak ada alamat IP yang kompatibel untuk host media."
            ),
            ""
          );
          return;
        }

        for (const record of filtered) {
          verifiedIps.add(record.address);
        }

        if (options.all) {
          callback(null, filtered);
          return;
        }

        callback(null, filtered[0].address, filtered[0].family);
      })
      .catch(() => {
        callback(
          new UpstreamServiceError(
            "UPSTREAM_DNS_ERROR",
            "Resolusi DNS untuk host media gagal."
          ),
          ""
        );
      });
  };
}

export function defaultExtensionForType(type: NormalizedMediaType): string {
  if (type === "image") return "jpg";
  if (type === "video") return "mp4";
  return "bin";
}

export function sanitizeFilename(
  rawFilename: string | undefined,
  mediaType: NormalizedMediaType,
  fallbackIndex: number
): string {
  const fallbackExt = defaultExtensionForType(mediaType);
  const fallbackName = `instagram-media-${fallbackIndex + 1}.${fallbackExt}`;

  if (!rawFilename || typeof rawFilename !== "string") {
    return fallbackName;
  }

  const normalizedSlashes = rawFilename.replace(/\\/g, "/");
  const segments = normalizedSlashes.split("/").filter(Boolean);
  const lastSegment = segments.length > 0 ? segments[segments.length - 1] : "";

  const cleaned = lastSegment
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\.\.+/g, ".")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[._-]+/, "");

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return fallbackName;
  }

  const extMatch = cleaned.match(/^(.+?)(\.[A-Za-z0-9]{1,8})$/);
  if (!extMatch) {
    const stem = cleaned.slice(0, 100).replace(/[._-]+$/, "") || `instagram-media-${fallbackIndex + 1}`;
    return `${stem}.${fallbackExt}`;
  }

  const rawStem = extMatch[1].replace(/[._-]+$/, "");
  const ext = extMatch[2].toLowerCase();
  const safeStem = rawStem.slice(0, 100) || `instagram-media-${fallbackIndex + 1}`;
  return `${safeStem}${ext}`;
}

export function createUniqueArchiveFilename(
  rawFilename: string,
  mediaType: NormalizedMediaType,
  index: number,
  usedNamesLowercase: Set<string>
): string {
  const baseSafe = sanitizeFilename(rawFilename, mediaType, index);
  const lower = baseSafe.toLowerCase();

  if (!usedNamesLowercase.has(lower)) {
    usedNamesLowercase.add(lower);
    return baseSafe;
  }

  const dotIdx = baseSafe.lastIndexOf(".");
  const stem = dotIdx > 0 ? baseSafe.slice(0, dotIdx) : baseSafe;
  const ext = dotIdx > 0 ? baseSafe.slice(dotIdx) : "";

  let counter = 2;
  while (counter < 10000) {
    const candidate = `${stem.slice(0, 105)}-(${counter})${ext}`;
    const candidateLower = candidate.toLowerCase();
    if (!usedNamesLowercase.has(candidateLower)) {
      usedNamesLowercase.add(candidateLower);
      return candidate;
    }
    counter += 1;
  }

  const emergency = `instagram-media-${index + 1}-${Date.now()}${ext}`;
  usedNamesLowercase.add(emergency.toLowerCase());
  return emergency;
}
