import https from "node:https";
import zlib from "node:zlib";
import pLimit from "p-limit";
import { extractSnapVideoThumbnails, fetchFromInstagramPackage } from "./adapter";
import {
  ForbiddenMediaError,
  InstagramAppError,
  MediaNotFoundError,
  RequestAbortedError,
  UpstreamServiceError,
} from "./errors";
import { buildMediaId, buildPreviewProxyUrl } from "./normalize";
import {
  createPinnedLookup,
  isBlockedIpAddress,
  sanitizeFilename,
  validateMediaUrl,
} from "./security";
import { signDownloadToken } from "./tokens";
import type {
  CategoryDiagnostics,
  CategoryFilter,
  CategorySourceStatus,
  InstagramFetchData,
  InstagramFetchMode,
  InstagramRuntimeConfig,
  MediaCategory,
  NormalizedMedia,
  NormalizedMediaType,
  ProfileSummary,
} from "./types";

const ALLOWED_PAGE_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
]);

const MAX_PAGE_REDIRECTS = 2;
const MAX_PROFILE_SHORTCODES = 24;
const ENRICH_CONCURRENCY = 5;
const PER_POST_TIMEOUT_MS = 6500;

const NAV_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "accept-encoding": "gzip, deflate, br",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

type FetchedPageResult = {
  statusCode: number;
  location: string | null;
  loginRequired: boolean;
  html: string;
};

type RelayPreloaderEntry = {
  key: string;
  payload: Record<string, unknown>;
};

type RawFeedSeed = {
  code: string;
  pk: string | null;
  typename: string | null;
  productType: string | null;
  displayUri: string | null;
  caption: string | null;
  likeCount: number | null;
  commentCount: number | null;
  playCount: number | null;
  takenAt: number | null;
  inPosts: boolean;
  inReels: boolean;
  inTaggedTab: boolean;
};

type ResolvedCarouselChild = {
  type: NormalizedMediaType;
  downloadUrl: string;
  previewUrl: string | null;
  taggedUsers: string[];
};

type ResolvedShortcodeMedia = {
  code: string;
  caption: string | null;
  likeCount: number | null;
  commentCount: number | null;
  playCount: number | null;
  takenAt: number | null;
  productType: string | null;
  taggedUsers: string[];
  hashtags: string[];
  mentions: string[];
  items: ResolvedCarouselChild[];
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function decodeContentStream(
  res: NodeJS.ReadableStream,
  encodingHeader: string | string[] | undefined
): Promise<Buffer> {
  const encoding = (
    Array.isArray(encodingHeader) ? encodingHeader[0] : encodingHeader ?? ""
  )
    .trim()
    .toLowerCase();

  let stream: NodeJS.ReadableStream = res;
  if (encoding === "gzip") {
    stream = res.pipe(zlib.createGunzip());
  } else if (encoding === "deflate") {
    stream = res.pipe(zlib.createInflate());
  } else if (encoding === "br") {
    stream = res.pipe(zlib.createBrotliDecompress());
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const maxHtmlBytes = 8 * 1024 * 1024;

    stream.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxHtmlBytes) {
        reject(new UpstreamServiceError("UPSTREAM_ERROR", "Respons halaman Instagram melebihi batas ukuran."));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (err) => reject(err));
  });
}

function isLoginRedirect(location: string | null): boolean {
  if (!location) {
    return false;
  }
  return /\/accounts\/login/i.test(location);
}

async function fetchInstagramPage(params: {
  url: string;
  timeoutMs: number;
  signal: AbortSignal;
  followNonLoginRedirects?: boolean;
}): Promise<FetchedPageResult> {
  let currentUrl = params.url;
  const followRedirects = params.followNonLoginRedirects ?? true;

  for (let hop = 0; hop <= MAX_PAGE_REDIRECTS; hop += 1) {
    if (params.signal.aborted) {
      throw new RequestAbortedError();
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(currentUrl);
    } catch {
      throw new UpstreamServiceError(
        "UPSTREAM_ERROR",
        "URL tujuan halaman Instagram tidak valid."
      );
    }

    if (
      parsedUrl.protocol !== "https:" ||
      !ALLOWED_PAGE_HOSTS.has(parsedUrl.hostname.toLowerCase())
    ) {
      throw new UpstreamServiceError(
        "UPSTREAM_UNTRUSTED_MEDIA",
        "Host tujuan halaman Instagram tidak diizinkan."
      );
    }

    const verifiedIps = new Set<string>();
    const result = await new Promise<
      | { kind: "done"; page: FetchedPageResult }
      | { kind: "redirect"; location: string }
    >((resolve, reject) => {
      let settled = false;

      const finishReject = (err: Error, activeTimer?: ReturnType<typeof setTimeout>) => {
        if (settled) return;
        settled = true;
        if (activeTimer !== undefined) clearTimeout(activeTimer);
        params.signal.removeEventListener("abort", onAbort);
        if (!req.destroyed) req.destroy();
        reject(err);
      };

      const onAbort = () => finishReject(new RequestAbortedError(), timer);

      const req = https.request(
        parsedUrl,
        {
          method: "GET",
          agent: false,
          lookup: createPinnedLookup(parsedUrl.hostname, verifiedIps),
          headers: NAV_HEADERS,
        },
        (res) => {
          const statusCode = res.statusCode ?? 0;
          const rawLoc = res.headers.location;
          const location = Array.isArray(rawLoc) ? rawLoc[0] ?? null : rawLoc ?? null;

          if (
            statusCode >= 300 &&
            statusCode < 400 &&
            location
          ) {
            res.resume();
            if (isLoginRedirect(location)) {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              params.signal.removeEventListener("abort", onAbort);
              resolve({
                kind: "done",
                page: {
                  statusCode,
                  location,
                  loginRequired: true,
                  html: "",
                },
              });
              return;
            }

            if (followRedirects && hop < MAX_PAGE_REDIRECTS) {
              try {
                const resolvedLoc = new URL(location, parsedUrl).toString();
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                params.signal.removeEventListener("abort", onAbort);
                resolve({ kind: "redirect", location: resolvedLoc });
                return;
              } catch {
              }
            }

            if (settled) return;
            settled = true;
            clearTimeout(timer);
            params.signal.removeEventListener("abort", onAbort);
            resolve({
              kind: "done",
              page: {
                statusCode,
                location,
                loginRequired: false,
                html: "",
              },
            });
            return;
          }

          decodeContentStream(res, res.headers["content-encoding"])
            .then((buf) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              params.signal.removeEventListener("abort", onAbort);
              const html = buf.toString("utf8");
              resolve({
                kind: "done",
                page: {
                  statusCode,
                  location,
                  loginRequired:
                    statusCode === 401 ||
                    (statusCode === 200 &&
                      /<title>\s*Login\b/i.test(html) &&
                      !html.includes("RelayPrefetchedStreamCache")),
                  html,
                },
              });
            })
            .catch((err) => {
              finishReject(
                err instanceof InstagramAppError
                  ? err
                  : new UpstreamServiceError(
                      "UPSTREAM_ERROR",
                      "Gagal membaca respons halaman Instagram."
                    ),
                timer
              );
            });
        }
      );

      const timer = setTimeout(() => {
        finishReject(
          new UpstreamServiceError(
            "UPSTREAM_TIMEOUT",
            "Batas waktu tunggu permintaan halaman Instagram terlampaui."
          ),
          timer
        );
      }, params.timeoutMs);

      params.signal.addEventListener("abort", onAbort, { once: true });

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
                "Koneksi ke host yang tidak terverifikasi ditolak."
              )
            );
          }
        });
      });

      req.on("error", (err) => {
        finishReject(
          err instanceof InstagramAppError
            ? err
            : new UpstreamServiceError(
                "UPSTREAM_ERROR",
                "Gagal terhubung ke Instagram."
              ),
          timer
        );
      });

      req.end();
    });

    if (result.kind === "done") {
      return result.page;
    }

    currentUrl = result.location;
  }

  throw new UpstreamServiceError(
    "UPSTREAM_TOO_MANY_REDIRECTS",
    "Terlalu banyak redirect saat mengakses Instagram."
  );
}

async function fetchPageWithRetry(params: {
  url: string;
  timeoutMs: number;
  signal: AbortSignal;
  followNonLoginRedirects?: boolean;
}): Promise<FetchedPageResult> {
  const page = await fetchInstagramPage(params);
  if (page.statusCode === 429 || page.statusCode >= 500) {
    if (params.signal.aborted) {
      throw new RequestAbortedError();
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 450);
      params.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true }
      );
    });
    if (params.signal.aborted) {
      throw new RequestAbortedError();
    }
    return fetchInstagramPage(params);
  }
  return page;
}

export function extractRelayPreloaders(html: string): RelayPreloaderEntry[] {
  const results: RelayPreloaderEntry[] = [];
  const scriptRegex =
    /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    const content = match[1];
    if (!content.includes("RelayPrefetchedStreamCache")) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      continue;
    }

    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        if (
          node[0] === "RelayPrefetchedStreamCache" &&
          Array.isArray(node[3]) &&
          typeof node[3][0] === "string" &&
          isPlainRecord(node[3][1])
        ) {
          results.push({
            key: node[3][0],
            payload: node[3][1],
          });
          return;
        }
        for (const child of node) {
          walk(child);
        }
      } else if (isPlainRecord(node)) {
        for (const value of Object.values(node)) {
          walk(value);
        }
      }
    };

    walk(parsed);
  }

  return results;
}

function getRelayData(entry: RelayPreloaderEntry): Record<string, unknown> | null {
  const bbox = isPlainRecord(entry.payload.__bbox) ? entry.payload.__bbox : null;
  const result = bbox && isPlainRecord(bbox.result) ? bbox.result : null;
  const data = result && isPlainRecord(result.data) ? result.data : null;
  return data;
}

function extractTextTags(caption: string | null): {
  hashtags: string[];
  mentions: string[];
} {
  if (!caption) {
    return { hashtags: [], mentions: [] };
  }

  const hashtags = Array.from(
    new Set(
      Array.from(caption.matchAll(/#([A-Za-z0-9_\u00C0-\u024F]{1,64})/g)).map(
        (m) => `#${m[1]}`
      )
    )
  );

  const mentions = Array.from(
    new Set(
      Array.from(caption.matchAll(/(?:^|[^A-Za-z0-9._])@([A-Za-z0-9._]{1,30})/g)).map(
        (m) => `@${m[1]}`
      )
    )
  );

  return { hashtags, mentions };
}

function extractUsertagsFromNode(node: Record<string, unknown>): string[] {
  const tagged = new Set<string>();

  const usertags = isPlainRecord(node.usertags) ? node.usertags : null;
  const entries = usertags && Array.isArray(usertags.in) ? usertags.in : [];
  for (const entry of entries) {
    if (!isPlainRecord(entry)) continue;
    const user = isPlainRecord(entry.user) ? entry.user : null;
    const uname = user ? asString(user.username) : null;
    if (uname) {
      tagged.add(`@${uname}`);
    }
  }

  const coauthors = Array.isArray(node.coauthor_producers)
    ? node.coauthor_producers
    : [];
  for (const coauthor of coauthors) {
    if (!isPlainRecord(coauthor)) continue;
    const uname = asString(coauthor.username);
    if (uname) {
      tagged.add(`@${uname}`);
    }
  }

  return Array.from(tagged);
}

function selectBestImageCandidate(
  node: Record<string, unknown>,
  allowedDomains: readonly string[]
): string | null {
  const imgV2 = isPlainRecord(node.image_versions2) ? node.image_versions2 : null;
  const candidates = imgV2 && Array.isArray(imgV2.candidates) ? imgV2.candidates : [];

  let bestUrl: string | null = null;
  let bestPixels = -1;

  for (const cand of candidates) {
    if (!isPlainRecord(cand)) continue;
    const rawUrl = asString(cand.url);
    if (!rawUrl) continue;
    try {
      const validated = validateMediaUrl(rawUrl, allowedDomains, "upstream");
      const width = asNumber(cand.width) ?? 0;
      const height = asNumber(cand.height) ?? 0;
      const pixels = width * height;
      if (bestUrl === null || pixels > bestPixels) {
        bestUrl = validated.toString();
        bestPixels = pixels;
      }
    } catch {
      continue;
    }
  }

  if (bestUrl) {
    return bestUrl;
  }

  const displayCandidates = [
    asString(node.display_url),
    asString(node.display_uri),
  ];
  for (const rawUrl of displayCandidates) {
    if (!rawUrl) continue;
    try {
      return validateMediaUrl(rawUrl, allowedDomains, "upstream").toString();
    } catch {
      continue;
    }
  }

  return null;
}

function selectBestVideoCandidate(
  node: Record<string, unknown>,
  allowedDomains: readonly string[]
): string | null {
  const versions = Array.isArray(node.video_versions) ? node.video_versions : [];

  let bestUrl: string | null = null;
  let bestScore = -1;

  for (const version of versions) {
    if (!isPlainRecord(version)) continue;
    const rawUrl = asString(version.url);
    if (!rawUrl) continue;
    try {
      const validated = validateMediaUrl(rawUrl, allowedDomains, "upstream");
      const width = asNumber(version.width) ?? 0;
      const height = asNumber(version.height) ?? 0;
      const typeWeight = asNumber(version.type) ?? 0;
      const score = width * height || typeWeight;
      if (bestUrl === null || score > bestScore) {
        bestUrl = validated.toString();
        bestScore = score;
      }
    } catch {
      continue;
    }
  }

  if (bestUrl) {
    return bestUrl;
  }

  const directVideoUrl = asString(node.video_url);
  if (directVideoUrl) {
    try {
      return validateMediaUrl(directVideoUrl, allowedDomains, "upstream").toString();
    } catch {
      return null;
    }
  }

  return null;
}

function parseMediaObjectToResolved(
  mediaNode: Record<string, unknown>,
  code: string,
  allowedDomains: readonly string[]
): ResolvedShortcodeMedia | null {
  const captionObj = isPlainRecord(mediaNode.caption) ? mediaNode.caption : null;
  const caption =
    (captionObj ? asString(captionObj.text) : null) ??
    asString(mediaNode.accessibility_caption);

  const likeCount = asNumber(mediaNode.like_count);
  const commentCount = asNumber(mediaNode.comment_count);
  const playCount = asNumber(mediaNode.play_count);
  const takenAt = asNumber(mediaNode.taken_at);
  const productType = asString(mediaNode.product_type);

  const rootUsertags = extractUsertagsFromNode(mediaNode);
  const { hashtags, mentions } = extractTextTags(caption);

  const items: ResolvedCarouselChild[] = [];
  const allUsertags = new Set<string>(rootUsertags);

  const carousel = Array.isArray(mediaNode.carousel_media)
    ? mediaNode.carousel_media
    : null;

  if (carousel && carousel.length > 0) {
    for (const slide of carousel) {
      if (!isPlainRecord(slide)) continue;
      const slideTags = extractUsertagsFromNode(slide);
      for (const tag of slideTags) allUsertags.add(tag);

      const videoUrl = selectBestVideoCandidate(slide, allowedDomains);
      const imageUrl = selectBestImageCandidate(slide, allowedDomains);

      if (videoUrl) {
        items.push({
          type: "video",
          downloadUrl: videoUrl,
          previewUrl: imageUrl,
          taggedUsers: slideTags,
        });
      } else if (imageUrl) {
        items.push({
          type: "image",
          downloadUrl: imageUrl,
          previewUrl: imageUrl,
          taggedUsers: slideTags,
        });
      }
    }
  } else {
    const videoUrl = selectBestVideoCandidate(mediaNode, allowedDomains);
    const imageUrl = selectBestImageCandidate(mediaNode, allowedDomains);

    if (videoUrl) {
      items.push({
        type: "video",
        downloadUrl: videoUrl,
        previewUrl: imageUrl,
        taggedUsers: rootUsertags,
      });
    } else if (imageUrl) {
      items.push({
        type: "image",
        downloadUrl: imageUrl,
        previewUrl: imageUrl,
        taggedUsers: rootUsertags,
      });
    }
  }

  if (items.length === 0) {
    return null;
  }

  return {
    code,
    caption,
    likeCount,
    commentCount,
    playCount,
    takenAt,
    productType,
    taggedUsers: Array.from(allUsertags),
    hashtags,
    mentions,
    items,
  };
}

function extractShortcodeMediaFromHtml(
  html: string,
  code: string,
  allowedDomains: readonly string[]
): ResolvedShortcodeMedia | null {
  const preloaders = extractRelayPreloaders(html);
  for (const preloader of preloaders) {
    const data = getRelayData(preloader);
    if (!data) continue;

    const polarisMedia = isPlainRecord(data.xig_polaris_media)
      ? data.xig_polaris_media
      : null;
    const gated =
      polarisMedia && isPlainRecord(polarisMedia.if_not_gated_logged_out)
        ? polarisMedia.if_not_gated_logged_out
        : null;

    if (gated) {
      const resolved = parseMediaObjectToResolved(gated, code, allowedDomains);
      if (resolved) {
        return resolved;
      }
    }
  }
  return null;
}

function extractEmbedMediaFromHtml(
  html: string,
  code: string,
  allowedDomains: readonly string[]
): ResolvedShortcodeMedia | null {
  const gqlMatch = html.match(/"gql_data":(\{[\s\S]*?\})\s*,\s*"[a-z_]+":/);
  if (gqlMatch?.[1]) {
    try {
      const parsed = JSON.parse(gqlMatch[1]) as unknown;
      if (isPlainRecord(parsed) && isPlainRecord(parsed.shortcode_media)) {
        const sm = parsed.shortcode_media;
        const captionEdges = isPlainRecord(sm.edge_media_to_caption) &&
          Array.isArray(sm.edge_media_to_caption.edges)
          ? sm.edge_media_to_caption.edges
          : [];
        const firstCaptionNode =
          isPlainRecord(captionEdges[0]) && isPlainRecord(captionEdges[0].node)
            ? captionEdges[0].node
            : null;
        const caption = firstCaptionNode ? asString(firstCaptionNode.text) : null;
        const { hashtags, mentions } = extractTextTags(caption);

        const items: ResolvedCarouselChild[] = [];
        const sidecar =
          isPlainRecord(sm.edge_sidecar_to_children) &&
          Array.isArray(sm.edge_sidecar_to_children.edges)
            ? sm.edge_sidecar_to_children.edges
            : null;

        const nodesToProcess: Record<string, unknown>[] = sidecar
          ? sidecar
              .map((edge) =>
                isPlainRecord(edge) && isPlainRecord(edge.node) ? edge.node : null
              )
              .filter((n): n is Record<string, unknown> => n !== null)
          : [sm];

        for (const n of nodesToProcess) {
          const isVideo = asBoolean(n.is_video);
          const videoUrl = asString(n.video_url);
          const displayUrl = asString(n.display_url);

          if (isVideo && videoUrl) {
            try {
              const validVid = validateMediaUrl(videoUrl, allowedDomains, "upstream").toString();
              let validImg: string | null = null;
              if (displayUrl) {
                try {
                  validImg = validateMediaUrl(displayUrl, allowedDomains, "upstream").toString();
                } catch {}
              }
              items.push({
                type: "video",
                downloadUrl: validVid,
                previewUrl: validImg,
                taggedUsers: [],
              });
            } catch {}
          } else if (displayUrl) {
            try {
              const validImg = validateMediaUrl(displayUrl, allowedDomains, "upstream").toString();
              items.push({
                type: "image",
                downloadUrl: validImg,
                previewUrl: validImg,
                taggedUsers: [],
              });
            } catch {}
          }
        }

        if (items.length > 0) {
          return {
            code,
            caption,
            likeCount: null,
            commentCount: null,
            playCount: null,
            takenAt: asNumber(sm.taken_at_timestamp),
            productType: asString(sm.product_type),
            taggedUsers: [],
            hashtags,
            mentions,
            items,
          };
        }
      }
    } catch {
    }
  }

  const imgMatch = html.match(
    /<img[^>]*class=["'][^"']*EmbeddedMediaImage[^"']*["'][^>]*src=["']([^"']+)["']/i
  );
  if (imgMatch?.[1]) {
    const cleanUrl = imgMatch[1].replace(/&amp;/g, "&").trim();
    try {
      const validUrl = validateMediaUrl(cleanUrl, allowedDomains, "upstream").toString();
      return {
        code,
        caption: null,
        likeCount: null,
        commentCount: null,
        playCount: null,
        takenAt: null,
        productType: null,
        taggedUsers: [],
        hashtags: [],
        mentions: [],
        items: [
          {
            type: "image",
            downloadUrl: validUrl,
            previewUrl: validUrl,
            taggedUsers: [],
          },
        ],
      };
    } catch {
      return null;
    }
  }

  return null;
}

async function enrichSingleShortcode(params: {
  seed: RawFeedSeed;
  config: InstagramRuntimeConfig;
  signal: AbortSignal;
}): Promise<ResolvedShortcodeMedia | null> {
  const { seed, config, signal } = params;
  const routeKind = seed.inReels && !seed.inPosts ? "reel" : "p";

  try {
    const page = await fetchPageWithRetry({
      url: `https://www.instagram.com/${routeKind}/${seed.code}/`,
      timeoutMs: PER_POST_TIMEOUT_MS,
      signal,
    });
    if (page.statusCode === 200 && !page.loginRequired && page.html) {
      const resolved = extractShortcodeMediaFromHtml(
        page.html,
        seed.code,
        config.mediaAllowedDomains
      );
      if (resolved) {
        return resolved;
      }
    }
  } catch (err) {
    if (err instanceof RequestAbortedError) {
      throw err;
    }
  }

  if (signal.aborted) {
    throw new RequestAbortedError();
  }

  try {
    const embedPage = await fetchInstagramPage({
      url: `https://www.instagram.com/p/${seed.code}/embed/captioned/`,
      timeoutMs: PER_POST_TIMEOUT_MS,
      signal,
    });
    if (embedPage.statusCode === 200 && embedPage.html) {
      const embedResolved = extractEmbedMediaFromHtml(
        embedPage.html,
        seed.code,
        config.mediaAllowedDomains
      );
      if (embedResolved) {
        return embedResolved;
      }
    }
  } catch (err) {
    if (err instanceof RequestAbortedError) {
      throw err;
    }
  }

  return null;
}

function parseProfileAndFeedFromHtml(params: {
  html: string;
  username: string;
  config: InstagramRuntimeConfig;
}): {
  userFound: boolean;
  profile: ProfileSummary | null;
  postSeeds: RawFeedSeed[];
  reelSeeds: RawFeedSeed[];
  taggedSeeds: RawFeedSeed[];
} {
  const preloaders = extractRelayPreloaders(params.html);
  let userFound = false;
  let profileData: Record<string, unknown> | null = null;
  const postSeeds: RawFeedSeed[] = [];
  const reelSeeds: RawFeedSeed[] = [];
  const taggedSeeds: RawFeedSeed[] = [];

  for (const preloader of preloaders) {
    const data = getRelayData(preloader);
    if (!data) continue;
    const user = isPlainRecord(data.xig_user_by_username)
      ? data.xig_user_by_username
      : null;
    if (!user) continue;

    userFound = true;

    if (asString(user.username) || asString(user.pk)) {
      profileData = { ...(profileData ?? {}), ...user };
    }

    const extractEdges = (
      conn: unknown,
      flags: { inPosts?: boolean; inReels?: boolean; inTaggedTab?: boolean }
    ): RawFeedSeed[] => {
      if (!isPlainRecord(conn) || !Array.isArray(conn.edges)) {
        return [];
      }
      const seeds: RawFeedSeed[] = [];
      for (const edge of conn.edges) {
        if (!isPlainRecord(edge) || !isPlainRecord(edge.node)) continue;
        const node = edge.node;
        const code = asString(node.code);
        if (!code) continue;

        const captionObj = isPlainRecord(node.caption) ? node.caption : null;
        const caption =
          (captionObj ? asString(captionObj.text) : null) ??
          asString(node.accessibility_caption);

        seeds.push({
          code,
          pk: asString(node.pk),
          typename: asString(node.__typename),
          productType: asString(node.product_type),
          displayUri: asString(node.display_uri),
          caption,
          likeCount: asNumber(node.like_count),
          commentCount: asNumber(node.comment_count),
          playCount: asNumber(node.play_count),
          takenAt: asNumber(node.taken_at),
          inPosts: Boolean(flags.inPosts),
          inReels: Boolean(flags.inReels),
          inTaggedTab: Boolean(flags.inTaggedTab),
        });
      }
      return seeds;
    };

    if (user.polaris_ordered_timeline_connection) {
      postSeeds.push(
        ...extractEdges(user.polaris_ordered_timeline_connection, { inPosts: true })
      );
    }
    if (user.polaris_clips_connection) {
      reelSeeds.push(
        ...extractEdges(user.polaris_clips_connection, { inReels: true })
      );
    }
    if (user.polaris_tagged_connection) {
      taggedSeeds.push(
        ...extractEdges(user.polaris_tagged_connection, { inTaggedTab: true })
      );
    }
  }

  let profile: ProfileSummary | null = null;
  if (profileData) {
    let avatarPreviewUrl: string | null = null;
    const rawAvatar = asString(profileData.profile_pic_url);
    if (rawAvatar) {
      try {
        const validatedAvatar = validateMediaUrl(
          rawAvatar,
          params.config.mediaAllowedDomains,
          "upstream"
        ).toString();
        const avatarToken = signDownloadToken(
          {
            url: validatedAvatar,
            filename: `${params.username}-avatar.jpg`,
            type: "image",
          },
          params.config
        );
        avatarPreviewUrl = buildPreviewProxyUrl(avatarToken);
      } catch {
        avatarPreviewUrl = null;
      }
    }

    profile = {
      username: asString(profileData.username) ?? params.username,
      fullName: asString(profileData.full_name),
      biography: asString(profileData.biography),
      avatarPreviewUrl,
      isVerified: asBoolean(profileData.is_verified),
      isPrivate: asBoolean(profileData.is_private),
      followerCount: asNumber(profileData.follower_count),
      followingCount: asNumber(profileData.following_count),
      postsCount: asNumber(profileData.all_media_count),
      hasActiveStories: Boolean(asNumber(profileData.latest_reel_media)),
    };
  }

  return {
    userFound,
    profile,
    postSeeds,
    reelSeeds,
    taggedSeeds,
  };
}

function buildSignedMediaEntry(params: {
  downloadUrl: string;
  previewSourceUrl: string | null;
  type: NormalizedMediaType;
  filename: string;
  category: MediaCategory;
  categories: MediaCategory[];
  shortcode?: string;
  caption?: string | null;
  carouselIndex?: number;
  carouselTotal?: number;
  likeCount?: number | null;
  commentCount?: number | null;
  playCount?: number | null;
  takenAt?: number | null;
  taggedUsers?: string[];
  hashtags?: string[];
  mentions?: string[];
  index: number;
  usedFilenames: Set<string>;
  config: InstagramRuntimeConfig;
}): NormalizedMedia | null {
  let canonicalDownloadUrl: string;
  try {
    canonicalDownloadUrl = validateMediaUrl(
      params.downloadUrl,
      params.config.mediaAllowedDomains,
      "upstream"
    ).toString();
  } catch {
    return null;
  }

  let filename = sanitizeFilename(
    params.filename,
    params.type,
    params.index
  );
  if (params.usedFilenames.has(filename.toLowerCase())) {
    const dotIdx = filename.lastIndexOf(".");
    const stem = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
    const ext = dotIdx > 0 ? filename.slice(dotIdx) : "";
    let suffix = 2;
    while (params.usedFilenames.has(`${stem}-${suffix}${ext}`.toLowerCase())) {
      suffix += 1;
    }
    filename = `${stem.slice(0, 105)}-${suffix}${ext}`;
  }
  params.usedFilenames.add(filename.toLowerCase());

  const downloadToken = signDownloadToken(
    {
      url: canonicalDownloadUrl,
      filename,
      type: params.type,
    },
    params.config
  );

  let validPreviewSource: string | null = null;
  if (params.previewSourceUrl) {
    try {
      validPreviewSource = validateMediaUrl(
        params.previewSourceUrl,
        params.config.mediaAllowedDomains,
        "upstream"
      ).toString();
    } catch {
      validPreviewSource = null;
    }
  }
  if (!validPreviewSource && params.type === "image") {
    validPreviewSource = canonicalDownloadUrl;
  }

  let previewUrl: string | null = null;
  if (validPreviewSource) {
    if (validPreviewSource === canonicalDownloadUrl && params.type === "image") {
      previewUrl = buildPreviewProxyUrl(downloadToken);
    } else {
      const previewToken = signDownloadToken(
        {
          url: validPreviewSource,
          filename: sanitizeFilename(`preview-${filename}`, "image", params.index),
          type: "image",
        },
        params.config
      );
      previewUrl = buildPreviewProxyUrl(previewToken);
    }
  }

  const videoPreviewUrl =
    params.type === "video" ? buildPreviewProxyUrl(downloadToken) : null;

  return {
    id: buildMediaId(params.index, `${params.category}:${canonicalDownloadUrl}`),
    type: params.type,
    previewUrl,
    videoPreviewUrl,
    filename,
    downloadToken,
    category: params.category,
    categories: params.categories,
    shortcode: params.shortcode,
    caption: params.caption ?? null,
    carouselIndex: params.carouselIndex,
    carouselTotal: params.carouselTotal,
    likeCount: params.likeCount ?? null,
    commentCount: params.commentCount ?? null,
    playCount: params.playCount ?? null,
    takenAt: params.takenAt ?? null,
    taggedUsers: params.taggedUsers,
    hashtags: params.hashtags,
    mentions: params.mentions,
  };
}

async function fetchStoriesGracefully(params: {
  username: string;
  timeoutMs: number;
  signal: AbortSignal;
  config: InstagramRuntimeConfig;
  usedFilenames: Set<string>;
  startIndex: number;
}): Promise<{
  status: CategorySourceStatus;
  items: NormalizedMedia[];
  message?: string;
}> {
  try {
    const raw = await fetchFromInstagramPackage({
      mode: "story",
      normalizedInput: `https://www.instagram.com/stories/${params.username}/`,
      timeoutMs: Math.min(params.timeoutMs, 15000),
      signal: params.signal,
    });

    const enriched = extractSnapVideoThumbnails(raw);
    if (!isPlainRecord(enriched) || !Array.isArray(enriched.media)) {
      return {
        status: "unavailable",
        items: [],
        message: "Respons stories dari layanan upstream tidak dikenali.",
      };
    }

    if (enriched.media.length === 0) {
      return {
        status: "empty",
        items: [],
        message: `Tidak ada stories publik aktif saat ini untuk @${params.username}.`,
      };
    }

    const items: NormalizedMedia[] = [];
    const seenUrls = new Set<string>();

    for (let i = 0; i < enriched.media.length; i += 1) {
      const rawItem = enriched.media[i];
      if (!isPlainRecord(rawItem)) continue;

      const url = asString(rawItem.url);
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);

      const rawType = asString(rawItem.type)?.toLowerCase() ?? "unknown";
      const mediaType: NormalizedMediaType =
        rawType === "photo" || rawType === "image"
          ? "image"
          : rawType === "video"
            ? "video"
            : "unknown";

      const thumbUrl =
        asString(rawItem.thumbnailUrl) ??
        asString(rawItem.previewUrl) ??
        asString(rawItem.thumbnail);

      const ext = mediaType === "image" ? "jpg" : mediaType === "video" ? "mp4" : "bin";
      const fallbackName = `${params.username}-story-${items.length + 1}.${ext}`;
      const rawFilename = asString(rawItem.filename) ?? fallbackName;

      const built = buildSignedMediaEntry({
        downloadUrl: url,
        previewSourceUrl: thumbUrl,
        type: mediaType,
        filename: rawFilename,
        category: "stories",
        categories: ["stories"],
        index: params.startIndex + items.length,
        usedFilenames: params.usedFilenames,
        config: params.config,
      });

      if (built) {
        items.push(built);
      }
    }

    if (items.length === 0) {
      return {
        status: "empty",
        items: [],
        message: `Tidak ada stories publik aktif saat ini untuk @${params.username}.`,
      };
    }

    return {
      status: "ok",
      items,
    };
  } catch (err) {
    if (err instanceof RequestAbortedError) {
      throw err;
    }
    return {
      status: "unavailable",
      items: [],
      message:
        "Stories tidak tersedia atau layanan pengambil stories sedang dibatasi sementara.",
    };
  }
}

export async function fetchInstagramProfileAutonomous(params: {
  username: string;
  mode: InstagramFetchMode;
  originalInput: string;
  initialCategory?: CategoryFilter;
  config: InstagramRuntimeConfig;
  signal: AbortSignal;
}): Promise<InstagramFetchData> {
  const { username, mode, originalInput, config, signal } = params;
  const startedAt = Date.now();
  const remainingMs = () =>
    Math.max(2000, config.fetchTimeoutMs - (Date.now() - startedAt));

  const usedFilenames = new Set<string>();

  const [profilePageRes, reelsPageRes, taggedPageRes, storiesRes] =
    await Promise.allSettled([
      fetchPageWithRetry({
        url: `https://www.instagram.com/${username}/`,
        timeoutMs: Math.min(12000, remainingMs()),
        signal,
      }),
      fetchPageWithRetry({
        url: `https://www.instagram.com/${username}/reels/`,
        timeoutMs: Math.min(12000, remainingMs()),
        signal,
      }),
      fetchInstagramPage({
        url: `https://www.instagram.com/${username}/tagged/`,
        timeoutMs: Math.min(8000, remainingMs()),
        signal,
        followNonLoginRedirects: false,
      }),
      fetchStoriesGracefully({
        username,
        timeoutMs: Math.min(14000, remainingMs()),
        signal,
        config,
        usedFilenames,
        startIndex: 0,
      }),
    ]);

  if (signal.aborted) {
    throw new RequestAbortedError();
  }

  let profile: ProfileSummary | null = null;
  let userFound = false;
  let profileLoginRequired = false;
  let profileFetchError: unknown = null;
  const seedMap = new Map<string, RawFeedSeed>();

  const mergeSeed = (seed: RawFeedSeed) => {
    const existing = seedMap.get(seed.code);
    if (!existing) {
      seedMap.set(seed.code, seed);
      return;
    }
    seedMap.set(seed.code, {
      ...existing,
      pk: existing.pk ?? seed.pk,
      typename: existing.typename ?? seed.typename,
      productType: existing.productType ?? seed.productType,
      displayUri: existing.displayUri ?? seed.displayUri,
      caption: existing.caption ?? seed.caption,
      likeCount: existing.likeCount ?? seed.likeCount,
      commentCount: existing.commentCount ?? seed.commentCount,
      playCount: existing.playCount ?? seed.playCount,
      takenAt: existing.takenAt ?? seed.takenAt,
      inPosts: existing.inPosts || seed.inPosts,
      inReels: existing.inReels || seed.inReels,
      inTaggedTab: existing.inTaggedTab || seed.inTaggedTab,
    });
  };

  if (profilePageRes.status === "fulfilled") {
    const page = profilePageRes.value;
    if (page.statusCode === 404) {
      throw new MediaNotFoundError(
        `Profil Instagram @${username} tidak ditemukan.`
      );
    }
    if (page.loginRequired) {
      profileLoginRequired = true;
    }
    if (page.statusCode === 200 && page.html) {
      const parsed = parseProfileAndFeedFromHtml({
        html: page.html,
        username,
        config,
      });
      userFound = parsed.userFound;
      if (parsed.profile) {
        profile = parsed.profile;
      }
      for (const s of parsed.postSeeds) mergeSeed(s);
    }
  } else {
    if (profilePageRes.reason instanceof RequestAbortedError) {
      throw profilePageRes.reason;
    }
    profileFetchError = profilePageRes.reason;
  }

  if (reelsPageRes.status === "fulfilled") {
    const page = reelsPageRes.value;
    if (page.statusCode === 200 && page.html) {
      const parsed = parseProfileAndFeedFromHtml({
        html: page.html,
        username,
        config,
      });
      if (parsed.userFound) userFound = true;
      if (!profile && parsed.profile) profile = parsed.profile;
      for (const s of parsed.reelSeeds) mergeSeed(s);
    }
  } else if (reelsPageRes.reason instanceof RequestAbortedError) {
    throw reelsPageRes.reason;
  }

  let taggedTabStatus: CategorySourceStatus = "empty";
  let taggedTabMessage =
    "Tab Tagged eksternal memerlukan login Instagram; menampilkan media profil yang memiliki tag akun (@usertag), kolaborator, dan hashtag (#tag).";

  if (taggedPageRes.status === "fulfilled") {
    const page = taggedPageRes.value;
    if (page.loginRequired || page.statusCode === 302 || page.statusCode === 401) {
      taggedTabStatus = "login_required";
    } else if (page.statusCode === 200 && page.html) {
      const parsed = parseProfileAndFeedFromHtml({
        html: page.html,
        username,
        config,
      });
      if (parsed.taggedSeeds.length > 0) {
        taggedTabStatus = "ok";
        taggedTabMessage =
          "Menampilkan postingan yang menandai akun ini beserta tag akun dan hashtag dari konten profil.";
        for (const s of parsed.taggedSeeds) mergeSeed(s);
      }
    }
  } else if (taggedPageRes.reason instanceof RequestAbortedError) {
    throw taggedPageRes.reason;
  }

  const storiesOutcome =
    storiesRes.status === "fulfilled"
      ? storiesRes.value
      : {
          status: "unavailable" as CategorySourceStatus,
          items: [] as NormalizedMedia[],
          message: "Gagal mengambil stories publik.",
        };

  if (
    profilePageRes.status === "fulfilled" &&
    profilePageRes.value.statusCode === 200 &&
    !profilePageRes.value.loginRequired &&
    !userFound &&
    storiesOutcome.items.length === 0
  ) {
    throw new MediaNotFoundError(
      `Profil Instagram @${username} tidak ditemukan.`
    );
  }

  if (profile?.isPrivate) {
    throw new ForbiddenMediaError(
      "PRIVATE_ACCOUNT",
      `Akun @${username} bersifat privat sehingga konten publik tidak dapat diambil.`
    );
  }

  const allSeeds = Array.from(seedMap.values()).slice(0, MAX_PROFILE_SHORTCODES);
  const enrichController = new AbortController();
  const onParentAbort = () => enrichController.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });

  const softBudgetMs = Math.max(3000, remainingMs() - 1500);
  const enrichTimer = setTimeout(() => {
    enrichController.abort();
  }, softBudgetMs);

  const enrichedMap = new Map<string, ResolvedShortcodeMedia | null>();
  const limit = pLimit(ENRICH_CONCURRENCY);

  try {
    await Promise.all(
      allSeeds.map((seed) =>
        limit(async () => {
          if (enrichController.signal.aborted) {
            return;
          }
          try {
            const resolved = await enrichSingleShortcode({
              seed,
              config,
              signal: enrichController.signal,
            });
            enrichedMap.set(seed.code, resolved);
          } catch {
          }
        })
      )
    );
  } finally {
    clearTimeout(enrichTimer);
    signal.removeEventListener("abort", onParentAbort);
  }

  if (signal.aborted) {
    throw new RequestAbortedError();
  }

  const mediaItems: NormalizedMedia[] = [...storiesOutcome.items];
  const discoveredUsertagsSet = new Set<string>();
  const discoveredHashtagsSet = new Set<string>();

  for (const seed of allSeeds) {
    const resolved = enrichedMap.get(seed.code);
    const caption = resolved?.caption ?? seed.caption ?? null;
    const textTags = extractTextTags(caption);
    const taggedUsers = Array.from(new Set(resolved?.taggedUsers ?? []));
    const hashtags = Array.from(
      new Set([...(resolved?.hashtags ?? []), ...textTags.hashtags])
    );
    const mentions = Array.from(
      new Set([...(resolved?.mentions ?? []), ...textTags.mentions])
    );

    for (const u of taggedUsers) discoveredUsertagsSet.add(u);
    for (const m of mentions) discoveredUsertagsSet.add(m);
    for (const h of hashtags) discoveredHashtagsSet.add(h);

    const isReel =
      seed.inReels ||
      resolved?.productType === "clips" ||
      seed.productType === "clips";
    const isPost = seed.inPosts || (!isReel && !seed.inTaggedTab);
    const hasTags =
      seed.inTaggedTab ||
      taggedUsers.length > 0 ||
      mentions.length > 0 ||
      hashtags.length > 0;

    const categoriesSet = new Set<MediaCategory>();
    if (isReel) categoriesSet.add("reels");
    if (isPost) categoriesSet.add("post");
    if (hasTags) categoriesSet.add("tags");

    const categories = Array.from(categoriesSet);
    const primaryCategory: MediaCategory = isReel
      ? "reels"
      : seed.inTaggedTab && !seed.inPosts
        ? "tags"
        : "post";

    const likeCount = resolved?.likeCount ?? seed.likeCount;
    const commentCount = resolved?.commentCount ?? seed.commentCount;
    const playCount = resolved?.playCount ?? seed.playCount;
    const takenAt = resolved?.takenAt ?? seed.takenAt;

    if (resolved && resolved.items.length > 0) {
      const totalSlides = resolved.items.length;
      resolved.items.forEach((child, slideIdx) => {
        const ext = child.type === "video" ? "mp4" : "jpg";
        const suffix = totalSlides > 1 ? `-${slideIdx + 1}` : "";
        const prefix = primaryCategory === "reels" ? "reel" : "post";
        const filename = `${username}-${prefix}-${seed.code}${suffix}.${ext}`;

        const built = buildSignedMediaEntry({
          downloadUrl: child.downloadUrl,
          previewSourceUrl: child.previewUrl ?? seed.displayUri,
          type: child.type,
          filename,
          category: primaryCategory,
          categories,
          shortcode: seed.code,
          caption,
          carouselIndex: totalSlides > 1 ? slideIdx + 1 : undefined,
          carouselTotal: totalSlides > 1 ? totalSlides : undefined,
          likeCount,
          commentCount,
          playCount,
          takenAt,
          taggedUsers:
            child.taggedUsers.length > 0 ? child.taggedUsers : taggedUsers,
          hashtags,
          mentions,
          index: mediaItems.length,
          usedFilenames,
          config,
        });

        if (built) {
          mediaItems.push(built);
        }
      });
    } else if (seed.displayUri) {
      const prefix = primaryCategory === "reels" ? "reel" : "post";
      const built = buildSignedMediaEntry({
        downloadUrl: seed.displayUri,
        previewSourceUrl: seed.displayUri,
        type: "image",
        filename: `${username}-${prefix}-${seed.code}-preview.jpg`,
        category: primaryCategory,
        categories,
        shortcode: seed.code,
        caption,
        likeCount,
        commentCount,
        playCount,
        takenAt,
        taggedUsers,
        hashtags,
        mentions,
        index: mediaItems.length,
        usedFilenames,
        config,
      });

      if (built) {
        mediaItems.push(built);
      }
    }
  }

  if (mediaItems.length === 0) {
    if (profileLoginRequired) {
      throw new UpstreamServiceError(
        "INSTAGRAM_LOGIN_REQUIRED",
        "Instagram membatasi akses profil ini tanpa login. Coba lagi sesaat lagi atau gunakan URL Reels/Post/Stories langsung."
      );
    }
    if (profileFetchError instanceof InstagramAppError) {
      throw profileFetchError;
    }
    if (profileFetchError) {
      throw new UpstreamServiceError(
        "UPSTREAM_ERROR",
        "Gagal mengambil data profil dari Instagram. Periksa koneksi jaringan atau coba lagi beberapa saat lagi."
      );
    }
    throw new MediaNotFoundError(
      `Tidak ada media publik yang tersedia untuk profil @${username}.`
    );
  }

  const reelsCount = mediaItems.filter((item) =>
    item.categories.includes("reels")
  ).length;
  const postCount = mediaItems.filter((item) =>
    item.categories.includes("post")
  ).length;
  const storiesCount = mediaItems.filter((item) =>
    item.categories.includes("stories")
  ).length;
  const tagsCount = mediaItems.filter((item) =>
    item.categories.includes("tags")
  ).length;

  const categoryDiagnostics: CategoryDiagnostics = {
    reels: {
      status: reelsCount > 0 ? "ok" : "empty",
      total: reelsCount,
      message:
        reelsCount === 0
          ? `Belum ada Reels publik yang ditemukan untuk @${username}.`
          : undefined,
    },
    post: {
      status: postCount > 0 ? "ok" : "empty",
      total: postCount,
      message:
        postCount === 0
          ? `Belum ada Post publik yang ditemukan untuk @${username}.`
          : undefined,
    },
    stories: {
      status: storiesOutcome.status,
      total: storiesCount,
      message: storiesOutcome.message,
    },
    tags: {
      status:
        taggedTabStatus === "ok" || tagsCount > 0
          ? "ok"
          : taggedTabStatus === "login_required"
            ? "login_required"
            : "empty",
      total: tagsCount,
      message: taggedTabMessage,
      discoveredUsertags: Array.from(discoveredUsertagsSet),
      discoveredHashtags: Array.from(discoveredHashtagsSet),
    },
  };

  return {
    mode,
    input: originalInput,
    inputKind: "profile",
    initialCategory: params.initialCategory ?? "all",
    profile,
    categoryDiagnostics,
    zipMaxFiles: config.zipMaxFiles,
    count: mediaItems.length,
    media: mediaItems,
  };
}

export async function fetchSingleMediaWithFallback(params: {
  url: string;
  mode: InstagramFetchMode;
  config: InstagramRuntimeConfig;
  signal: AbortSignal;
}): Promise<InstagramFetchData | null> {
  const match = params.url.match(/\/(p|reel|reels)\/([A-Za-z0-9_-]+)/i);
  if (!match) {
    return null;
  }

  const kindSegment = match[1].toLowerCase();
  const shortcode = match[2];
  const category: MediaCategory =
    kindSegment === "reel" || kindSegment === "reels" ? "reels" : "post";

  const seed: RawFeedSeed = {
    code: shortcode,
    pk: null,
    typename: null,
    productType: category === "reels" ? "clips" : null,
    displayUri: null,
    caption: null,
    likeCount: null,
    commentCount: null,
    playCount: null,
    takenAt: null,
    inPosts: category === "post",
    inReels: category === "reels",
    inTaggedTab: false,
  };

  const resolved = await enrichSingleShortcode({
    seed,
    config: params.config,
    signal: params.signal,
  });

  if (!resolved || resolved.items.length === 0) {
    return null;
  }

  const usedFilenames = new Set<string>();
  const mediaItems: NormalizedMedia[] = [];
  const hasTags =
    resolved.taggedUsers.length > 0 ||
    resolved.mentions.length > 0 ||
    resolved.hashtags.length > 0;
  const categories: MediaCategory[] = hasTags ? [category, "tags"] : [category];

  resolved.items.forEach((child, idx) => {
    const ext = child.type === "video" ? "mp4" : "jpg";
    const suffix = resolved.items.length > 1 ? `-${idx + 1}` : "";
    const filename = `instagram-${category}-${shortcode}${suffix}.${ext}`;

    const built = buildSignedMediaEntry({
      downloadUrl: child.downloadUrl,
      previewSourceUrl: child.previewUrl,
      type: child.type,
      filename,
      category,
      categories,
      shortcode,
      caption: resolved.caption,
      carouselIndex: resolved.items.length > 1 ? idx + 1 : undefined,
      carouselTotal:
        resolved.items.length > 1 ? resolved.items.length : undefined,
      likeCount: resolved.likeCount,
      commentCount: resolved.commentCount,
      playCount: resolved.playCount,
      takenAt: resolved.takenAt,
      taggedUsers:
        child.taggedUsers.length > 0
          ? child.taggedUsers
          : resolved.taggedUsers,
      hashtags: resolved.hashtags,
      mentions: resolved.mentions,
      index: mediaItems.length,
      usedFilenames,
      config: params.config,
    });

    if (built) {
      mediaItems.push(built);
    }
  });

  if (mediaItems.length === 0) {
    return null;
  }

  return {
    mode: params.mode,
    input: params.url,
    inputKind: "media",
    zipMaxFiles: params.config.zipMaxFiles,
    count: mediaItems.length,
    media: mediaItems,
  };
}
