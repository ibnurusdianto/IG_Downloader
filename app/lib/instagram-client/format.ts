import type {
  CategoryFilter,
  InstagramFetchMode,
  MediaCategory,
  NormalizedMediaType,
} from "./types";

const DIRECT_VIDEO_PREVIEW_EXT_REGEX = /\.(mp4|webm|mov)$/i;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"] as const;
  let unitIndex = 0;
  let value = bytes;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

export function formatCompactNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "0";
  }
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return value.toLocaleString("id-ID");
}

export function getMediaTypeLabel(type: NormalizedMediaType): string {
  if (type === "image") {
    return "Foto";
  }
  if (type === "video") {
    return "Video";
  }
  return "Media";
}

export function getModeLabel(mode: InstagramFetchMode): string {
  if (mode === "story") {
    return "Stories";
  }
  if (mode === "media") {
    return "Reels/Post";
  }
  return "Auto";
}

export function getCategoryLabel(category: CategoryFilter): string {
  switch (category) {
    case "all":
      return "Semua";
    case "reels":
      return "Reels";
    case "post":
      return "Post";
    case "stories":
      return "Stories";
    case "tags":
      return "Tags";
  }
}

export function getCategoryBadgeClass(category: MediaCategory): string {
  switch (category) {
    case "reels":
      return "bg-purple-100 text-purple-900 dark:bg-purple-950/70 dark:text-purple-200";
    case "post":
      return "bg-sky-100 text-sky-900 dark:bg-sky-950/70 dark:text-sky-200";
    case "stories":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950/70 dark:text-amber-200";
    case "tags":
      return "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/70 dark:text-emerald-200";
  }
}

export function isDirectVideoPreviewUrl(url: string): boolean {
  try {
    if (url.startsWith("/api/instagram/preview")) {
      return false;
    }
    const parsed = new URL(url);
    return DIRECT_VIDEO_PREVIEW_EXT_REGEX.test(parsed.pathname);
  } catch {
    return false;
  }
}
