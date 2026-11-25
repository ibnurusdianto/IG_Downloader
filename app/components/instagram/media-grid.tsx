"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatBytes,
  formatCompactNumber,
  getCategoryLabel,
  getModeLabel,
} from "../../lib/instagram-client/format";
import type {
  CardDownloadState,
  CategoryFilter,
  InstagramFetchData,
  InstagramMediaItem,
  MediaCategory,
  ZipDownloadState,
} from "../../lib/instagram-client/types";
import MediaCard from "./media-card";

type MediaGridProps = {
  result: InstagramFetchData;
  selectedIds: string[];
  singleDownloads: Record<string, CardDownloadState>;
  zipDownload: ZipDownloadState;
  isFetching: boolean;
  onToggleSelect: (id: string) => void;
  onSelectItems: (ids: string[]) => void;
  onClearSelection: () => void;
  onDownloadSingle: (item: InstagramMediaItem) => void;
  onCancelSingleDownload: (id: string) => void;
  onDownloadZip: () => void;
  onCancelZipDownload: () => void;
  onRefetchExpired: () => void;
  onReset: () => void;
};

const CATEGORY_TABS: readonly CategoryFilter[] = [
  "all",
  "reels",
  "post",
  "stories",
  "tags",
];

const PAGE_SIZE_OPTIONS = [12, 24, 36] as const;

function buildPaginationPages(
  currentPage: number,
  totalPages: number
): (number | "ellipsis")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, idx) => idx + 1);
  }

  const pages: (number | "ellipsis")[] = [1];
  const left = Math.max(2, currentPage - 1);
  const right = Math.min(totalPages - 1, currentPage + 1);

  if (left > 2) {
    pages.push("ellipsis");
  }
  for (let p = left; p <= right; p += 1) {
    pages.push(p);
  }
  if (right < totalPages - 1) {
    pages.push("ellipsis");
  }
  pages.push(totalPages);
  return pages;
}

export default function MediaGrid({
  result,
  selectedIds,
  singleDownloads,
  zipDownload,
  isFetching,
  onToggleSelect,
  onSelectItems,
  onClearSelection,
  onDownloadSingle,
  onCancelSingleDownload,
  onDownloadZip,
  onCancelZipDownload,
  onRefetchExpired,
  onReset,
}: MediaGridProps) {
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>(
    result.initialCategory ?? "all"
  );
  const [selectedTagFilter, setSelectedTagFilter] = useState<string | null>(
    null
  );
  const [pageSize, setPageSize] = useState<number>(12);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [previewModalItem, setPreviewModalItem] =
    useState<InstagramMediaItem | null>(null);
  const resultsTopRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!previewModalItem) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewModalItem(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewModalItem]);

  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      all: result.media.length,
      reels: 0,
      post: 0,
      stories: 0,
      tags: 0,
    };
    for (const item of result.media) {
      const cats = new Set<MediaCategory>(item.categories);
      if (cats.has("reels")) counts.reels += 1;
      if (cats.has("post")) counts.post += 1;
      if (cats.has("stories")) counts.stories += 1;
      if (cats.has("tags")) counts.tags += 1;
    }
    return counts;
  }, [result.media]);

  const categoryMedia = useMemo(() => {
    const byCategory =
      activeCategory === "all"
        ? result.media
        : result.media.filter((item) =>
            item.categories.includes(activeCategory)
          );

    if (activeCategory === "tags" && selectedTagFilter) {
      return byCategory.filter(
        (item) =>
          item.taggedUsers?.includes(selectedTagFilter) ||
          item.mentions?.includes(selectedTagFilter) ||
          item.hashtags?.includes(selectedTagFilter)
      );
    }

    return byCategory;
  }, [activeCategory, result.media, selectedTagFilter]);

  const totalCategoryCount = categoryMedia.length;
  const totalPages = Math.max(1, Math.ceil(totalCategoryCount / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);

  const pagedMedia = useMemo(() => {
    const startIdx = (safeCurrentPage - 1) * pageSize;
    return categoryMedia.slice(startIdx, startIdx + pageSize);
  }, [categoryMedia, pageSize, safeCurrentPage]);

  const startItemNum =
    totalCategoryCount === 0 ? 0 : (safeCurrentPage - 1) * pageSize + 1;
  const endItemNum = Math.min(safeCurrentPage * pageSize, totalCategoryCount);

  const selectedSet = new Set(selectedIds);
  const selectedCount = result.media.filter((item) =>
    selectedSet.has(item.id)
  ).length;
  const maxZipFiles = result.zipMaxFiles ?? 50;
  const zipLimitExceeded = selectedCount > maxZipFiles;
  const isZipDownloading = zipDownload.status === "downloading";

  const zipProgressPercentage =
    isZipDownloading &&
    zipDownload.totalBytes !== null &&
    zipDownload.totalBytes > 0
      ? Math.min(
          100,
          Math.round((zipDownload.loadedBytes / zipDownload.totalBytes) * 100)
        )
      : null;

  const showCategoryTabs =
    result.inputKind === "profile" ||
    categoryCounts.reels > 0 ||
    categoryCounts.post > 0 ||
    categoryCounts.stories > 0 ||
    categoryCounts.tags > 0;

  const activeDiagnostic =
    activeCategory !== "all" && result.categoryDiagnostics
      ? result.categoryDiagnostics[activeCategory]
      : null;

  function handleCategoryChange(nextCategory: CategoryFilter) {
    setActiveCategory(nextCategory);
    setSelectedTagFilter(null);
    setCurrentPage(1);
  }

  function handlePageChange(nextPage: number) {
    const clamped = Math.max(1, Math.min(totalPages, nextPage));
    setCurrentPage(clamped);
    resultsTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handleSelectCurrentPage() {
    const pageIds = pagedMedia.map((item) => item.id);
    const merged = Array.from(new Set([...selectedIds, ...pageIds]));
    onSelectItems(merged);
  }

  function handleSelectCurrentCategory() {
    const catIds = categoryMedia.slice(0, maxZipFiles).map((item) => item.id);
    onSelectItems(catIds);
  }

  const discoveredTags = useMemo(() => {
    const diag = result.categoryDiagnostics?.tags;
    if (!diag) return [];
    return [
      ...diag.discoveredUsertags.slice(0, 12),
      ...diag.discoveredHashtags.slice(0, 12),
    ];
  }, [result.categoryDiagnostics]);

  return (
    <section
      ref={resultsTopRef}
      aria-labelledby="results-heading"
      className="mx-auto mt-10 w-full max-w-5xl space-y-6"
    >
      {result.profile && (
        <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:rounded-3xl sm:p-6 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-4">
              <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full border border-neutral-200 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800">
                {result.profile.avatarPreviewUrl ? (
                  <Image
                    src={result.profile.avatarPreviewUrl}
                    alt={`Foto profil @${result.profile.username}`}
                    fill
                    unoptimized
                    className="object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-lg font-bold text-neutral-500 dark:text-neutral-300">
                    {result.profile.username.slice(0, 2).toUpperCase()}
                  </div>
                )}
              </div>

              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold text-neutral-900 dark:text-white">
                    {result.profile.fullName || `@${result.profile.username}`}
                  </h2>
                  {result.profile.isVerified && (
                    <span className="inline-flex items-center rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-800 dark:bg-sky-950 dark:text-sky-300">
                      Terverifikasi
                    </span>
                  )}
                  {result.profile.hasActiveStories && (
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-300">
                      Stories Aktif
                    </span>
                  )}
                </div>

                <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  @{result.profile.username}
                </p>

                {result.profile.biography && (
                  <p className="max-w-2xl whitespace-pre-line text-xs leading-5 text-neutral-700 dark:text-neutral-300">
                    {result.profile.biography}
                  </p>
                )}
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap gap-3 sm:justify-end">
              {typeof result.profile.postsCount === "number" && (
                <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-3.5 py-2 text-center dark:border-neutral-800 dark:bg-neutral-950">
                  <p className="text-sm font-bold text-neutral-900 dark:text-white">
                    {formatCompactNumber(result.profile.postsCount)}
                  </p>
                  <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    Postingan
                  </p>
                </div>
              )}
              {typeof result.profile.followerCount === "number" && (
                <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-3.5 py-2 text-center dark:border-neutral-800 dark:bg-neutral-950">
                  <p className="text-sm font-bold text-neutral-900 dark:text-white">
                    {formatCompactNumber(result.profile.followerCount)}
                  </p>
                  <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    Pengikut
                  </p>
                </div>
              )}
              {typeof result.profile.followingCount === "number" && (
                <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-3.5 py-2 text-center dark:border-neutral-800 dark:bg-neutral-950">
                  <p className="text-sm font-bold text-neutral-900 dark:text-white">
                    {formatCompactNumber(result.profile.followingCount)}
                  </p>
                  <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    Mengikuti
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:rounded-3xl sm:p-6 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                id="results-heading"
                className="text-lg font-bold tracking-tight text-neutral-900 sm:text-xl dark:text-white"
              >
                Hasil Media ({result.media.length})
              </h2>
              <span className="rounded-lg bg-lime-100 px-2.5 py-1 text-xs font-semibold text-lime-900 dark:bg-lime-950 dark:text-lime-300">
                Mode {getModeLabel(result.mode)}
              </span>
            </div>
            <p className="break-words text-xs leading-5 text-neutral-600 [overflow-wrap:anywhere] sm:text-sm dark:text-neutral-400">
              Sumber:{" "}
              <span className="font-medium text-neutral-800 dark:text-neutral-200">
                {result.input}
              </span>{" "}
              &middot; {selectedCount} dipilih (maks. {maxZipFiles} untuk ZIP)
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleSelectCurrentPage}
              disabled={pagedMedia.length === 0 || isFetching}
              className="inline-flex min-h-10 items-center justify-center rounded-xl border border-neutral-300 bg-white px-3.5 py-2 text-xs font-semibold text-neutral-800 transition-colors hover:border-lime-300 hover:bg-lime-50 hover:text-lime-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:border-lime-800 dark:hover:bg-lime-950/60"
            >
              Pilih Halaman Ini
            </button>

            <button
              type="button"
              onClick={handleSelectCurrentCategory}
              disabled={totalCategoryCount === 0 || isFetching}
              className="inline-flex min-h-10 items-center justify-center rounded-xl border border-neutral-300 bg-white px-3.5 py-2 text-xs font-semibold text-neutral-800 transition-colors hover:border-lime-300 hover:bg-lime-50 hover:text-lime-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:border-lime-800 dark:hover:bg-lime-950/60"
            >
              Pilih Kategori{totalCategoryCount > maxZipFiles ? ` (${maxZipFiles})` : ""}
            </button>

            <button
              type="button"
              onClick={onClearSelection}
              disabled={selectedCount === 0 || isFetching}
              className="inline-flex min-h-10 items-center justify-center rounded-xl border border-neutral-300 bg-white px-3.5 py-2 text-xs font-semibold text-neutral-800 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              Hapus Pilihan
            </button>

            {isZipDownloading ? (
              <button
                type="button"
                onClick={onCancelZipDownload}
                className="inline-flex min-h-10 items-center justify-center rounded-xl border border-red-300 bg-red-50 px-4 py-2 text-xs font-semibold text-red-900 transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200 dark:hover:bg-red-950"
              >
                Batalkan ZIP
              </button>
            ) : (
              <button
                type="button"
                onClick={onDownloadZip}
                disabled={selectedCount === 0 || zipLimitExceeded || isFetching}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-lime-700 px-4 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-lime-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-lime-300 dark:text-neutral-950 dark:hover:bg-lime-400"
              >
                <svg
                  aria-hidden="true"
                  width="15"
                  height="15"
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
                <span>Unduh ZIP ({selectedCount})</span>
              </button>
            )}

            <button
              type="button"
              onClick={onReset}
              className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-neutral-300 bg-neutral-50 px-3.5 py-2 text-xs font-semibold text-neutral-800 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:border-red-800 dark:hover:bg-red-950/50 dark:hover:text-red-200"
            >
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
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              <span>Reset</span>
            </button>
          </div>
        </div>

        {showCategoryTabs && (
          <div className="mt-5 border-t border-neutral-100 pt-4 dark:border-neutral-800">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div
                role="tablist"
                aria-label="Kategori media Instagram"
                className="flex flex-wrap gap-2"
              >
                {CATEGORY_TABS.map((tab) => {
                  const isActive = activeCategory === tab;
                  const count = categoryCounts[tab];
                  return (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => handleCategoryChange(tab)}
                      className={`inline-flex min-h-10 items-center gap-2 rounded-xl border px-3.5 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 sm:text-sm ${
                        isActive
                          ? "border-lime-600 bg-lime-700 text-white dark:border-lime-400 dark:bg-lime-300 dark:text-neutral-950"
                          : "border-neutral-200 bg-neutral-50 text-neutral-700 hover:border-lime-300 hover:bg-lime-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:border-lime-800 dark:hover:bg-lime-950/30"
                      }`}
                    >
                      <span>{getCategoryLabel(tab)}</span>
                      <span
                        className={`rounded-md px-1.5 py-0.5 text-[11px] ${
                          isActive
                            ? "bg-white/20 text-white dark:bg-neutral-900/20 dark:text-neutral-950"
                            : "bg-neutral-200/80 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                        }`}
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
                <label htmlFor="page-size-select" className="font-medium">
                  Per halaman:
                </label>
                <select
                  id="page-size-select"
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setCurrentPage(1);
                  }}
                  className="min-h-9 rounded-lg border border-neutral-300 bg-white px-2.5 py-1 text-xs font-semibold text-neutral-800 focus:border-lime-600 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200"
                >
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {activeDiagnostic?.message && (
              <p className="mt-3 rounded-xl border border-neutral-200 bg-neutral-50 px-3.5 py-2.5 text-xs leading-5 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
                {activeDiagnostic.message}
              </p>
            )}

            {activeCategory === "tags" && discoveredTags.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedTagFilter(null);
                    setCurrentPage(1);
                  }}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                    selectedTagFilter === null
                      ? "border-lime-600 bg-lime-50 text-lime-900 dark:border-lime-400 dark:bg-lime-950/60 dark:text-lime-200"
                      : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                  }`}
                >
                  Semua Tag
                </button>
                {discoveredTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => {
                      setSelectedTagFilter(tag);
                      setCurrentPage(1);
                    }}
                    className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                      selectedTagFilter === tag
                        ? "border-lime-600 bg-lime-50 text-lime-900 dark:border-lime-400 dark:bg-lime-950/60 dark:text-lime-200"
                        : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {zipLimitExceeded && (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs font-medium text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
          >
            Maksimal {maxZipFiles} file per unduhan ZIP (saat ini {selectedCount}{" "}
            dipilih). Kurangi pilihan atau unduh per halaman.
          </p>
        )}

        {isZipDownloading && (
          <div className="mt-4 space-y-2 rounded-xl border border-lime-200 bg-lime-50/80 p-3.5 dark:border-lime-900/60 dark:bg-lime-950/30">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-lime-900 sm:text-sm dark:text-lime-200">
              <span>
                {zipProgressPercentage !== null
                  ? `Menyiapkan arsip ZIP (${zipProgressPercentage}%)`
                  : zipDownload.loadedBytes > 0
                    ? `Menyiapkan arsip ZIP (${formatBytes(zipDownload.loadedBytes)} diterima)...`
                    : "Mengumpulkan media untuk arsip ZIP..."}
              </span>
            </div>

            {zipProgressPercentage !== null &&
            zipDownload.totalBytes !== null ? (
              <div
                role="progressbar"
                aria-label="Progres unduhan arsip ZIP"
                aria-valuemin={0}
                aria-valuemax={zipDownload.totalBytes}
                aria-valuenow={zipDownload.loadedBytes}
                className="h-2 w-full overflow-hidden rounded-full bg-lime-200 dark:bg-lime-950"
              >
                <div
                  className="h-full bg-lime-700 transition-all motion-reduce:transition-none dark:bg-lime-400"
                  style={{ width: `${zipProgressPercentage}%` }}
                />
              </div>
            ) : (
              <div
                role="progressbar"
                aria-label="Menyiapkan arsip ZIP"
                aria-valuetext="Sedang menyiapkan arsip ZIP"
                className="h-2 w-full overflow-hidden rounded-full bg-lime-200 dark:bg-lime-950"
              >
                <div className="h-full w-2/5 animate-pulse rounded-full bg-lime-700 motion-reduce:w-full motion-reduce:animate-none dark:bg-lime-400" />
              </div>
            )}
          </div>
        )}

        {zipDownload.status === "ready" && (
          <p className="mt-4 flex items-center gap-2 rounded-xl border border-lime-200 bg-lime-50 px-4 py-3 text-xs font-medium text-lime-900 sm:text-sm dark:border-lime-900/60 dark:bg-lime-950/30 dark:text-lime-200">
            <svg
              aria-hidden="true"
              width="16"
              height="16"
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
            <span>{zipDownload.message}</span>
          </p>
        )}

        {zipDownload.status === "error" && (
          <div
            role="alert"
            className="mt-4 flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900 sm:flex-row sm:items-center sm:justify-between sm:text-sm dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
          >
            <div className="flex items-start gap-2">
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
                className="mt-0.5 shrink-0"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <p>{zipDownload.message}</p>
            </div>
            {zipDownload.isExpiredToken && (
              <button
                type="button"
                onClick={onRefetchExpired}
                className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg border border-red-300 bg-white px-3.5 py-2 text-xs font-semibold text-red-900 transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-1 motion-reduce:transition-none dark:border-red-800 dark:bg-neutral-900 dark:text-red-200 dark:hover:bg-red-950/60"
              >
                Ambil Ulang Media
              </button>
            )}
          </div>
        )}
      </div>

      {pagedMedia.length === 0 ? (
        <div
          role="status"
          className="rounded-2xl border border-neutral-200 bg-white p-8 text-center shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
        >
          <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Tidak ada media di kategori {getCategoryLabel(activeCategory)}
          </p>
          <p className="mt-1.5 text-xs leading-5 text-neutral-600 dark:text-neutral-400">
            {activeDiagnostic?.message ??
              "Coba pilih kategori lain atau tekan tombol Semua untuk melihat seluruh hasil."}
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-neutral-600 dark:text-neutral-400">
            <span>
              Menampilkan{" "}
              <strong className="text-neutral-900 dark:text-neutral-100">
                {startItemNum}–{endItemNum}
              </strong>{" "}
              dari{" "}
              <strong className="text-neutral-900 dark:text-neutral-100">
                {totalCategoryCount}
              </strong>{" "}
              media ({getCategoryLabel(activeCategory)})
            </span>
            {totalPages > 1 && (
              <span>
                Halaman {safeCurrentPage} dari {totalPages}
              </span>
            )}
          </div>

          <ul
            aria-label="Daftar media hasil pengambilan"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          >
            {pagedMedia.map((item, idx) => (
              <li key={item.id} className="min-w-0">
                <MediaCard
                  item={item}
                  index={(safeCurrentPage - 1) * pageSize + idx}
                  selected={selectedSet.has(item.id)}
                  downloadState={singleDownloads[item.id] ?? { status: "idle" }}
                  onToggleSelect={onToggleSelect}
                  onDownload={onDownloadSingle}
                  onCancelDownload={onCancelSingleDownload}
                  onRefetchExpired={onRefetchExpired}
                  onOpenPreview={setPreviewModalItem}
                />
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <nav
              aria-label="Navigasi halaman media"
              className="flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
            >
              <button
                type="button"
                onClick={() => handlePageChange(safeCurrentPage - 1)}
                disabled={safeCurrentPage <= 1}
                className="inline-flex min-h-10 items-center justify-center rounded-xl border border-neutral-300 bg-white px-3.5 py-2 text-xs font-semibold text-neutral-800 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-45 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                Sebelumnya
              </button>

              {buildPaginationPages(safeCurrentPage, totalPages).map(
                (entry, idx) =>
                  entry === "ellipsis" ? (
                    <span
                      key={`ellipsis-${idx}`}
                      className="px-2 text-xs font-semibold text-neutral-400"
                    >
                      ...
                    </span>
                  ) : (
                    <button
                      key={entry}
                      type="button"
                      onClick={() => handlePageChange(entry)}
                      aria-current={
                        entry === safeCurrentPage ? "page" : undefined
                      }
                      className={`inline-flex min-h-10 min-w-10 items-center justify-center rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
                        entry === safeCurrentPage
                          ? "border-lime-600 bg-lime-700 text-white dark:border-lime-400 dark:bg-lime-300 dark:text-neutral-950"
                          : "border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-800"
                      }`}
                    >
                      {entry}
                    </button>
                  )
              )}

              <button
                type="button"
                onClick={() => handlePageChange(safeCurrentPage + 1)}
                disabled={safeCurrentPage >= totalPages}
                className="inline-flex min-h-10 items-center justify-center rounded-xl border border-neutral-300 bg-white px-3.5 py-2 text-xs font-semibold text-neutral-800 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-45 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                Berikutnya
              </button>
            </nav>
          )}
        </>
      )}

      {previewModalItem && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Pratinjau ${previewModalItem.filename}`}
          onClick={() => setPreviewModalItem(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-950 text-white shadow-2xl"
          >
            <div className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
              <p className="truncate text-xs font-semibold sm:text-sm">
                {previewModalItem.filename}
              </p>
              <button
                type="button"
                onClick={() => setPreviewModalItem(null)}
                aria-label="Tutup pratinjau"
                className="inline-flex min-h-9 items-center justify-center rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-xs font-semibold text-neutral-200 hover:bg-neutral-800"
              >
                Tutup
              </button>
            </div>

            <div className="relative flex min-h-72 flex-1 items-center justify-center overflow-auto bg-black p-2">
              {previewModalItem.type === "video" &&
              previewModalItem.videoPreviewUrl ? (
                <video
                  src={previewModalItem.videoPreviewUrl}
                  poster={previewModalItem.previewUrl ?? undefined}
                  controls
                  autoPlay
                  playsInline
                  className="max-h-[70vh] w-full object-contain"
                />
              ) : previewModalItem.previewUrl ? (
                <Image
                  src={previewModalItem.previewUrl}
                  alt={previewModalItem.filename}
                  width={1080}
                  height={1350}
                  unoptimized
                  className="max-h-[70vh] w-auto object-contain"
                />
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 px-4 py-3">
              <p className="line-clamp-2 max-w-lg text-xs text-neutral-300">
                {previewModalItem.caption ?? "Siap diunduh"}
              </p>
              <button
                type="button"
                onClick={() => onDownloadSingle(previewModalItem)}
                className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-lime-400 px-4 py-2 text-xs font-bold text-neutral-950 hover:bg-lime-300"
              >
                Unduh File
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
