import type { CategoryFilter, ClientFetchValidationResult, InstagramFetchMode } from "./types";

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

export function validateClientFetchInput(
  rawInput: string,
  mode: InstagramFetchMode
): ClientFetchValidationResult {
  const trimmed = rawInput.trim();

  if (trimmed.length === 0) {
    if (mode === "media") {
      return {
        ok: false,
        message: "Masukkan URL Reels atau postingan Instagram terlebih dahulu.",
      };
    }
    if (mode === "story") {
      return {
        ok: false,
        message: "Masukkan username atau URL Stories Instagram terlebih dahulu.",
      };
    }
    return {
      ok: false,
      message: "Masukkan username (@username / username) atau URL profil Instagram terlebih dahulu.",
    };
  }

  if (CONTROL_CHAR_REGEX.test(trimmed) || trimmed.includes("\\")) {
    return {
      ok: false,
      message: "Input mengandung karakter yang tidak diizinkan.",
    };
  }

  const parsedUrl = tryParseUrl(trimmed);
  if (parsedUrl) {
    if (parsedUrl.protocol !== "https:") {
      return {
        ok: false,
        message: "Hanya URL Instagram dengan protokol HTTPS yang diterima.",
      };
    }

    if (parsedUrl.username !== "" || parsedUrl.password !== "") {
      return {
        ok: false,
        message: "URL tidak boleh mengandung username atau password.",
      };
    }

    if (parsedUrl.port !== "") {
      return {
        ok: false,
        message: "Port non-standar pada URL Instagram tidak diizinkan.",
      };
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    if (
      parsedUrl.hostname.endsWith(".") ||
      !ALLOWED_INSTAGRAM_HOSTNAMES.has(hostname)
    ) {
      return {
        ok: false,
        message:
          "Domain URL harus berupa instagram.com, www.instagram.com, atau m.instagram.com.",
      };
    }

    if (/%2f|%5c/i.test(parsedUrl.pathname)) {
      return {
        ok: false,
        message: "Path URL Instagram mengandung karakter encoded yang tidak valid.",
      };
    }

    const segments = parsedUrl.pathname.split("/").filter(Boolean);
    if (segments.length === 0) {
      return {
        ok: false,
        message:
          "URL beranda Instagram tidak didukung. Gunakan username, URL profil (/username/), URL Stories (/stories/username/), URL Reels (/reel/shortcode/), atau URL postingan (/p/shortcode/).",
      };
    }

    const first = segments[0].toLowerCase();

    if (first === "stories") {
      if (segments.length < 2 || segments.length > 3) {
        return {
          ok: false,
          message: "Path URL Stories Instagram tidak didukung.",
        };
      }

      const username = segments[1];
      if (
        username.toLowerCase() === "highlights" ||
        !isValidInstagramUsername(username)
      ) {
        return {
          ok: false,
          message:
            "URL Stories Instagram harus mencantumkan username yang valid (/stories/username/).",
        };
      }

      if (segments.length === 3 && !INSTAGRAM_STORY_ID_REGEX.test(segments[2])) {
        return {
          ok: false,
          message: "ID Stories pada URL Instagram tidak valid.",
        };
      }

      if (mode === "media") {
        return {
          ok: false,
          message:
            "Mode Reels/Post hanya menerima URL Reels (/reel/...) atau postingan (/p/...), bukan URL Stories.",
        };
      }

      const normalizedStoryUrl =
        segments.length === 3
          ? `https://www.instagram.com/stories/${username}/${segments[2]}/`
          : `https://www.instagram.com/stories/${username}/`;

      return {
        ok: true,
        input: normalizedStoryUrl,
        kind: "story_url",
      };
    }

    if ((first === "reel" || first === "reels") && segments.length === 2) {
      const shortcode = segments[1];
      if (!INSTAGRAM_SHORTCODE_REGEX.test(shortcode)) {
        return {
          ok: false,
          message: "Shortcode URL Reels Instagram tidak valid.",
        };
      }

      if (mode === "story") {
        return {
          ok: false,
          message:
            "Mode Stories hanya menerima username, URL profil, atau URL Stories Instagram.",
        };
      }

      return {
        ok: true,
        input: `https://www.instagram.com/reel/${shortcode}/`,
        kind: "media_url",
      };
    }

    if (first === "p" && segments.length === 2) {
      const shortcode = segments[1];
      if (!INSTAGRAM_SHORTCODE_REGEX.test(shortcode)) {
        return {
          ok: false,
          message: "Shortcode URL postingan Instagram tidak valid.",
        };
      }

      if (mode === "story") {
        return {
          ok: false,
          message:
            "Mode Stories hanya menerima username, URL profil, atau URL Stories Instagram.",
        };
      }

      return {
        ok: true,
        input: `https://www.instagram.com/p/${shortcode}/`,
        kind: "media_url",
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
        return {
          ok: false,
          message:
            "Mode Reels/Post hanya menerima URL Reels (/reel/...) atau postingan (/p/...). Pindah ke mode Auto untuk mengambil seluruh isi profil.",
        };
      }

      return {
        ok: true,
        input: `https://www.instagram.com/${profileUsername}/`,
        kind: "profile_url",
        initialCategory:
          secondSegment && PROFILE_TAB_CATEGORY_MAP[secondSegment]
            ? PROFILE_TAB_CATEGORY_MAP[secondSegment]
            : "all",
      };
    }

    return {
      ok: false,
      message:
        "Path URL Instagram tidak didukung. Gunakan URL profil (/username/), Stories (/stories/username/), Reels (/reel/shortcode/), atau postingan (/p/shortcode/).",
    };
  }

  if (
    trimmed.includes("/") ||
    trimmed.includes(":") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    /\s/.test(trimmed)
  ) {
    return {
      ok: false,
      message:
        "Format input tidak valid. Gunakan username Instagram (@username / username) atau URL HTTPS Instagram yang lengkap.",
    };
  }

  const username = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!isValidInstagramUsername(username)) {
    return {
      ok: false,
      message:
        "Username Instagram tidak valid. Gunakan 1-30 karakter huruf, angka, titik, atau garis bawah.",
    };
  }

  if (mode === "media") {
    return {
      ok: false,
      message:
        "Mode Reels/Post hanya menerima URL Reels atau postingan Instagram, bukan username. Pindah ke mode Auto untuk mengambil seluruh isi profil.",
    };
  }

  return {
    ok: true,
    input: username,
    kind: "username",
    initialCategory: "all",
  };
}
