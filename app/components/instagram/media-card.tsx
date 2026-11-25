"use client";

import Image from "next/image";
import { useId, useState } from "react";
import {
  formatBytes,
  formatCompactNumber,
  getCategoryBadgeClass,
  getCategoryLabel,
  getMediaTypeLabel,
} from "../../lib/instagram-client/format";
import type {
  CardDownloadState,
  InstagramMediaItem,
} from "../../lib/instagram-client/types";

type MediaCardProps = {
  item: InstagramMediaItem;
  index: number;
  selected: boolean;
  downloadState: CardDownloadState;
  onToggleSelect: (id: string) => void;
  onDownload: (item: InstagramMediaItem) => void;
  onCancelDownload: (id: string) => void;
  onRefetchExpired: () => void;
  onOpenPreview: (item: InstagramMediaItem) => void;
};

function MediaTypeIcon({ type }: { type: InstagramMediaItem["type"] }) {
  if (type === "image") {
    return (
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    );
  }

  if (type === "video") {
    return (
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="23 7 16 12 23 17 23 7" />
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function PreviewPlaceholder({
  type,
  failed,
}: {
  type: InstagramMediaItem["type"];
  failed: boolean;
}) {
  let title = "Preview tidak tersedia";
  let subtitle = "Gunakan tombol unduh untuk menyimpan file";

  if (type === "unknown") {
    title = "Format media belum dikenali";
    subtitle = "Preview dinonaktifkan, tetap dapat diunduh";
  } else if (failed) {
    title = "Preview gagal dimuat";
    subtitle = "File media tetap dapat diunduh";
  } else if (type === "video") {
    title = "Thumbnail video tidak tersedia";
    subtitle = "Video tetap dapat diputar atau diunduh";
  } else if (type === "image") {
    title = "Preview foto tidak tersedia";
    subtitle = "Foto siap diunduh melalui tombol di bawah";
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center text-neutral-500 dark:text-neutral-400">
      <div className="flex h-11 w-11 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
        <MediaTypeIcon type={type} />
      </div>
      <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">
        {title}
      </p>
      <p className="text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
        {subtitle}
      </p>
    </div>
  );
}

export default function MediaCard({
  item,
  index,
  selected,
  downloadState,
  onToggleSelect,
  onDownload,
  onCancelDownload,
  onRefetchExpired,
  onOpenPreview,
}: MediaCardProps) {
  const checkboxId = useId();
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  const [inlineVideoActive, setInlineVideoActive] = useState(false);

  const hasPreviewError =
    item.previewUrl !== null && failedPreviewUrl === item.previewUrl;
  const canRenderPreview = item.previewUrl !== null && !hasPreviewError;
  const canPlayVideo =
    item.type === "video" && Boolean(item.videoPreviewUrl);
  const mediaLabel = getMediaTypeLabel(item.type);
  const isDownloading = downloadState.status === "downloading";

  const progressPercentage =
    isDownloading &&
    downloadState.totalBytes !== null &&
    downloadState.totalBytes > 0
      ? Math.min(
          100,
          Math.round(
            (downloadState.loadedBytes / downloadState.totalBytes) * 100
          )
        )
      : null;

  const combinedTags = [
    ...(item.taggedUsers ?? []),
    ...(item.mentions ?? []),
    ...(item.hashtags ?? []),
  ].slice(0, 4);

  return (
    <article className="flex h-full flex-col rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm transition-colors dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-3 flex items-center justify-between gap-2">
        <label
          htmlFor={checkboxId}
          className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg pr-2 text-xs font-medium text-neutral-700 select-none dark:text-neutral-200"
        >
          <input
            id={checkboxId}
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(item.id)}
            className="h-4 w-4 rounded border-neutral-300 accent-lime-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 dark:border-neutral-600 dark:accent-lime-300 dark:focus-visible:ring-lime-300 dark:focus-visible:ring-offset-neutral-900"
          />
          <span>Pilih</span>
          <span className="sr-only">{item.filename}</span>
        </label>

        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <span
            className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${getCategoryBadgeClass(
              item.category
            )}`}
          >
            {getCategoryLabel(item.category)}
          </span>
          <span className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-700 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200">
            <MediaTypeIcon type={item.type} />
            <span>{mediaLabel}</span>
          </span>
        </div>
      </div>

      <div className="group relative aspect-[4/5] w-full overflow-hidden rounded-xl border border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-950">
        {item.type === "unknown" ? (
          <PreviewPlaceholder type="unknown" failed={false} />
        ) : item.type === "image" ? (
          canRenderPreview && item.previewUrl ? (
            <>
              <Image
                src={item.previewUrl}
                alt={`Preview foto ${item.filename}`}
                fill
                unoptimized
                loading="lazy"
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                onError={() => setFailedPreviewUrl(item.previewUrl)}
              />
              <button
                type="button"
                onClick={() => onOpenPreview(item)}
                aria-label={`Perbesar preview ${item.filename}`}
                className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-lg bg-neutral-950/75 px-2.5 py-1.5 text-[11px] font-semibold text-white backdrop-blur-sm transition-colors hover:bg-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-400"
              >
                <svg
                  aria-hidden="true"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
                <span>Perbesar</span>
              </button>
            </>
          ) : (
            <PreviewPlaceholder type="image" failed={hasPreviewError} />
          )
        ) : inlineVideoActive && item.videoPreviewUrl ? (
          <video
            src={item.videoPreviewUrl}
            poster={canRenderPreview && item.previewUrl ? item.previewUrl : undefined}
            controls
            autoPlay
            playsInline
            aria-label={`Preview video ${item.filename}`}
            className="h-full w-full bg-black object-contain"
            onError={() => setInlineVideoActive(false)}
          />
        ) : canRenderPreview && item.previewUrl ? (
          <>
            <Image
              src={item.previewUrl}
              alt={`Thumbnail video ${item.filename}`}
              fill
              unoptimized
              loading="lazy"
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
              className="object-cover"
              onError={() => setFailedPreviewUrl(item.previewUrl)}
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent" />
            {canPlayVideo && (
              <div className="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setInlineVideoActive(true)}
                  aria-label={`Putar video ${item.filename}`}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-950/80 px-2.5 py-1.5 text-[11px] font-semibold text-white backdrop-blur-sm transition-colors hover:bg-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-400"
                >
                  <svg
                    aria-hidden="true"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  <span>Putar</span>
                </button>
                <button
                  type="button"
                  onClick={() => onOpenPreview(item)}
                  aria-label={`Buka modal preview ${item.filename}`}
                  className="inline-flex items-center gap-1 rounded-lg bg-neutral-950/75 px-2.5 py-1.5 text-[11px] font-semibold text-white backdrop-blur-sm transition-colors hover:bg-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-400"
                >
                  <span>Perbesar</span>
                </button>
              </div>
            )}
          </>
        ) : canPlayVideo && item.videoPreviewUrl ? (
          <video
            src={item.videoPreviewUrl}
            controls
            preload="metadata"
            playsInline
            aria-label={`Preview video ${item.filename}`}
            className="h-full w-full bg-black object-contain"
          />
        ) : (
          <PreviewPlaceholder type="video" failed={hasPreviewError} />
        )}

        {typeof item.carouselIndex === "number" &&
          typeof item.carouselTotal === "number" && (
            <span className="pointer-events-none absolute top-2 right-2 rounded-md bg-neutral-950/80 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur-sm">
              Slide {item.carouselIndex}/{item.carouselTotal}
            </span>
          )}
      </div>

      <div className="mt-3 flex flex-1 flex-col justify-between gap-3">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">
            <span>Item #{index + 1}</span>
            {(typeof item.playCount === "number" ||
              typeof item.likeCount === "number") && (
              <span className="truncate text-[11px]">
                {typeof item.playCount === "number"
                  ? `${formatCompactNumber(item.playCount)} putar`
                  : `${formatCompactNumber(item.likeCount)} suka`}
              </span>
            )}
          </div>

          <p
            title={item.filename}
            className="break-words text-sm font-semibold leading-5 text-neutral-900 [overflow-wrap:anywhere] dark:text-neutral-100"
          >
            {item.filename}
          </p>

          {item.caption && (
            <p className="line-clamp-2 text-xs leading-4 text-neutral-600 dark:text-neutral-400">
              {item.caption}
            </p>
          )}

          {combinedTags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {combinedTags.map((tag) => (
                <span
                  key={tag}
                  className="max-w-full truncate rounded-md bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2.5">
          {isDownloading ? (
            <div className="space-y-2 rounded-xl border border-lime-200 bg-lime-50/80 p-3 dark:border-lime-900/60 dark:bg-lime-950/30">
              <div className="flex items-center justify-between gap-2 text-xs font-medium text-lime-900 dark:text-lime-200">
                <span>
                  {progressPercentage !== null
                    ? `Mengunduh (${progressPercentage}%)`
                    : downloadState.loadedBytes > 0
                      ? `Menyiapkan (${formatBytes(downloadState.loadedBytes)})`
                      : "Menyiapkan unduhan..."}
                </span>
              </div>

              {progressPercentage !== null &&
              downloadState.totalBytes !== null ? (
                <div
                  role="progressbar"
                  aria-label={`Progres unduhan ${item.filename}`}
                  aria-valuemin={0}
                  aria-valuemax={downloadState.totalBytes}
                  aria-valuenow={downloadState.loadedBytes}
                  className="h-2 w-full overflow-hidden rounded-full bg-lime-200 dark:bg-lime-950"
                >
                  <div
                    className="h-full bg-lime-700 transition-all motion-reduce:transition-none dark:bg-lime-400"
                    style={{ width: `${progressPercentage}%` }}
                  />
                </div>
              ) : (
                <div
                  role="progressbar"
                  aria-label={`Menyiapkan unduhan ${item.filename}`}
                  aria-valuetext="Sedang memproses unduhan"
                  className="h-2 w-full overflow-hidden rounded-full bg-lime-200 dark:bg-lime-950"
                >
                  <div className="h-full w-2/5 animate-pulse rounded-full bg-lime-700 motion-reduce:w-full motion-reduce:animate-none dark:bg-lime-400" />
                </div>
              )}

              <button
                type="button"
                onClick={() => onCancelDownload(item.id)}
                aria-label={`Batalkan unduhan ${item.filename}`}
                className="inline-flex min-h-10 w-full items-center justify-center rounded-lg border border-neutral-300 bg-white px-3 py-2 text-xs font-semibold text-neutral-800 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 motion-reduce:transition-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:focus-visible:ring-lime-300 dark:focus-visible:ring-offset-neutral-900"
              >
                Batalkan Unduhan
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onDownload(item)}
              aria-label={`Unduh ${item.filename}`}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-lime-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-lime-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 motion-reduce:transition-none dark:bg-lime-300 dark:text-neutral-950 dark:hover:bg-lime-400 dark:focus-visible:ring-lime-300 dark:focus-visible:ring-offset-neutral-900"
            >
              <svg
                aria-hidden="true"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>Unduh</span>
            </button>
          )}

          {downloadState.status === "ready" && (
            <p className="flex items-center gap-1.5 rounded-lg border border-lime-200 bg-lime-50 px-3 py-2 text-xs font-medium text-lime-900 dark:border-lime-900/60 dark:bg-lime-950/30 dark:text-lime-200">
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>{downloadState.message}</span>
            </p>
          )}

          {downloadState.status === "error" && (
            <div
              role="alert"
              className="space-y-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
            >
              <div className="flex items-start gap-1.5">
                <svg
                  aria-hidden="true"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="mt-0.5 shrink-0"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <p className="leading-4">{downloadState.message}</p>
              </div>
              {downloadState.isExpiredToken && (
                <button
                  type="button"
                  onClick={onRefetchExpired}
                  className="inline-flex min-h-9 w-full items-center justify-center rounded-md border border-red-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-red-900 transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-1 motion-reduce:transition-none dark:border-red-800 dark:bg-neutral-900 dark:text-red-200 dark:hover:bg-red-950/60"
                >
                  Ambil Ulang Media
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
