"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { fetchInstagramMedia } from "../lib/instagram-client/api";
import {
  downloadSingleInstagramMedia,
  downloadZipInstagramMedia,
} from "../lib/instagram-client/download";
import type {
  CardDownloadState,
  InstagramFetchData,
  InstagramFetchMode,
  InstagramMediaItem,
  ZipDownloadState,
} from "../lib/instagram-client/types";
import { validateClientFetchInput } from "../lib/instagram-client/validation";
import MediaGrid from "./instagram/media-grid";

type ModeOption = {
  value: InstagramFetchMode;
  label: string;
  description: string;
  inputLabel: string;
  placeholder: string;
  helperText: string;
};

const MODE_OPTIONS: readonly ModeOption[] = [
  {
    value: "auto",
    label: "Auto (Profil Lengkap)",
    description: "Reels, Post, Stories, & Tags",
    inputLabel: "Username (@username / username) atau URL Instagram",
    placeholder:
      "Contoh: @instagram, instagram, atau https://www.instagram.com/instagram/",
    helperText:
      "Masukkan username (dengan atau tanpa @) atau URL profil untuk mengambil Reels, Post, Stories (jika ada), dan Tags secara otomatis.",
  },
  {
    value: "story",
    label: "Stories",
    description: "Username atau URL Stories",
    inputLabel: "Username atau URL Stories Instagram",
    placeholder:
      "Contoh: @instagram atau https://www.instagram.com/stories/instagram/",
    helperText:
      "Masukkan username Instagram (dengan atau tanpa @), URL profil, atau URL Stories (/stories/username/).",
  },
  {
    value: "media",
    label: "Reels/Post",
    description: "Khusus URL Reels atau Post",
    inputLabel: "URL Reels atau postingan Instagram",
    placeholder: "Contoh: https://www.instagram.com/reel/... atau .../p/...",
    helperText:
      "Masukkan URL HTTPS Reels (/reel/shortcode/) atau postingan (/p/shortcode/). Gunakan mode Auto untuk mengambil seluruh isi profil.",
  },
];

const SUPPORTED_CONTENT_TYPES = [
  "Profil Lengkap",
  "Reels",
  "Post",
  "Stories",
  "Tags",
] as const;

type FetchStatus = "idle" | "loading" | "success" | "empty" | "error";

type FetchErrorState = {
  code?: string;
  message: string;
  isExpiredToken?: boolean;
};

export default function Main() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<InstagramFetchMode>("auto");
  const [inputError, setInputError] = useState<string | null>(null);
  const [fetchStatus, setFetchStatus] = useState<FetchStatus>("idle");
  const [fetchResult, setFetchResult] = useState<InstagramFetchData | null>(
    null
  );
  const [fetchError, setFetchError] = useState<FetchErrorState | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [singleDownloads, setSingleDownloads] = useState<
    Record<string, CardDownloadState>
  >({});
  const [zipDownload, setZipDownload] = useState<ZipDownloadState>({
    status: "idle",
  });
  const [statusAnnouncement, setStatusAnnouncement] = useState("");

  const fetchAbortRef = useRef<AbortController | null>(null);
  const fetchRequestIdRef = useRef(0);
  const inFlightQueryRef = useRef<{
    input: string;
    mode: InstagramFetchMode;
  } | null>(null);
  const resultGenerationRef = useRef(0);
  const singleDownloadControllersRef = useRef<Map<string, AbortController>>(
    new Map()
  );
  const zipAbortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const activeModeConfig =
    MODE_OPTIONS.find((option) => option.value === mode) ?? MODE_OPTIONS[0];

  function abortActiveDownloads() {
    for (const controller of singleDownloadControllersRef.current.values()) {
      controller.abort();
    }
    singleDownloadControllersRef.current.clear();

    if (zipAbortRef.current) {
      zipAbortRef.current.abort();
      zipAbortRef.current = null;
    }

    setSingleDownloads({});
    setZipDownload({ status: "idle" });
  }

  useEffect(() => {
    const singleControllers = singleDownloadControllersRef.current;
    return () => {
      fetchRequestIdRef.current += 1;
      resultGenerationRef.current += 1;
      if (fetchAbortRef.current) {
        fetchAbortRef.current.abort();
        fetchAbortRef.current = null;
      }
      inFlightQueryRef.current = null;

      for (const controller of singleControllers.values()) {
        controller.abort();
      }
      singleControllers.clear();

      if (zipAbortRef.current) {
        zipAbortRef.current.abort();
        zipAbortRef.current = null;
      }
    };
  }, []);

  async function startFetch(
    rawInputValue: string,
    targetMode: InstagramFetchMode
  ) {
    const validation = validateClientFetchInput(rawInputValue, targetMode);
    if (!validation.ok) {
      setInputError(validation.message);
      setStatusAnnouncement(validation.message);
      inputRef.current?.focus();
      return;
    }

    if (
      fetchAbortRef.current &&
      inFlightQueryRef.current &&
      inFlightQueryRef.current.input === validation.input &&
      inFlightQueryRef.current.mode === targetMode
    ) {
      return;
    }

    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
      fetchAbortRef.current = null;
    }

    fetchRequestIdRef.current += 1;
    const requestId = fetchRequestIdRef.current;

    resultGenerationRef.current += 1;
    abortActiveDownloads();

    setInputError(null);
    setFetchError(null);
    setFetchResult(null);
    setSelectedIds([]);
    setFetchStatus("loading");
    setStatusAnnouncement(
      validation.kind === "username" || validation.kind === "profile_url"
        ? "Mengambil profil, Reels, Post, Stories, dan Tags dari Instagram..."
        : "Mengambil data media Instagram..."
    );

    const controller = new AbortController();
    fetchAbortRef.current = controller;
    inFlightQueryRef.current = {
      input: validation.input,
      mode: targetMode,
    };

    const result = await fetchInstagramMedia({
      input: validation.input,
      mode: targetMode,
      signal: controller.signal,
    });

    if (fetchRequestIdRef.current !== requestId) {
      return;
    }

    fetchAbortRef.current = null;
    inFlightQueryRef.current = null;

    if (!result.ok) {
      if (result.kind === "aborted") {
        setFetchStatus("idle");
        setStatusAnnouncement("Pengambilan media dibatalkan.");
        return;
      }

      if (result.isNotFound) {
        setFetchStatus("empty");
        setFetchError({
          code: result.code,
          message: result.message,
        });
        setStatusAnnouncement(result.message);
        return;
      }

      setFetchStatus("error");
      setFetchError({
        code: result.code,
        message: result.message,
        isExpiredToken: result.isExpiredToken,
      });
      setStatusAnnouncement(result.message);
      return;
    }

    resultGenerationRef.current += 1;

    if (result.data.media.length === 0) {
      setFetchStatus("empty");
      setFetchResult(result.data);
      setStatusAnnouncement(
        "Tidak ada media yang tersedia untuk input tersebut."
      );
      return;
    }

    setFetchStatus("success");
    setFetchResult(result.data);
    setSelectedIds([]);
    setStatusAnnouncement(
      `Berhasil memuat ${result.data.media.length} media.`
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void startFetch(input, mode);
  }

  function handleModeChange(nextMode: InstagramFetchMode) {
    setMode(nextMode);
    setInputError(null);
  }

  function handleCancelFetch() {
    if (!fetchAbortRef.current) {
      return;
    }
    fetchRequestIdRef.current += 1;
    fetchAbortRef.current.abort();
    fetchAbortRef.current = null;
    inFlightQueryRef.current = null;
    setFetchStatus("idle");
    setStatusAnnouncement("Pengambilan media dibatalkan.");
  }

  function handleResetAll() {
    fetchRequestIdRef.current += 1;
    resultGenerationRef.current += 1;
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
      fetchAbortRef.current = null;
    }
    inFlightQueryRef.current = null;
    abortActiveDownloads();

    setInput("");
    setInputError(null);
    setFetchStatus("idle");
    setFetchResult(null);
    setFetchError(null);
    setSelectedIds([]);
    setStatusAnnouncement(
      "Semua data telah dikosongkan. Silakan masukkan username atau URL profil baru."
    );

    window.scrollTo({ top: 0, behavior: "smooth" });
    window.setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  }

  function handleToggleSelect(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }

  function handleSelectItems(ids: string[]) {
    setSelectedIds(ids);
    setStatusAnnouncement(`${ids.length} media dipilih.`);
  }

  function handleClearSelection() {
    setSelectedIds([]);
    setStatusAnnouncement("Pilihan media dihapus.");
  }

  async function handleSingleDownload(item: InstagramMediaItem) {
    const generation = resultGenerationRef.current;

    const existingController = singleDownloadControllersRef.current.get(
      item.id
    );
    if (existingController) {
      existingController.abort();
    }

    const controller = new AbortController();
    singleDownloadControllersRef.current.set(item.id, controller);

    setSingleDownloads((prev) => ({
      ...prev,
      [item.id]: {
        status: "downloading",
        loadedBytes: 0,
        totalBytes: null,
      },
    }));
    setStatusAnnouncement(`Menyiapkan unduhan untuk ${item.filename}.`);

    const res = await downloadSingleInstagramMedia({
      token: item.downloadToken,
      fallbackFilename: item.filename,
      signal: controller.signal,
      onProgress: (progress) => {
        if (
          resultGenerationRef.current !== generation ||
          controller.signal.aborted
        ) {
          return;
        }
        setSingleDownloads((prev) => ({
          ...prev,
          [item.id]: {
            status: "downloading",
            loadedBytes: progress.loadedBytes,
            totalBytes: progress.totalBytes,
          },
        }));
      },
    });

    if (singleDownloadControllersRef.current.get(item.id) === controller) {
      singleDownloadControllersRef.current.delete(item.id);
    }

    if (resultGenerationRef.current !== generation) {
      return;
    }

    if (!res.ok) {
      if (res.kind === "aborted") {
        setSingleDownloads((prev) => ({
          ...prev,
          [item.id]: { status: "idle" },
        }));
        setStatusAnnouncement(`Unduhan ${item.filename} dibatalkan.`);
        return;
      }

      setSingleDownloads((prev) => ({
        ...prev,
        [item.id]: {
          status: "error",
          message: res.message,
          isExpiredToken: Boolean(res.isExpiredToken),
        },
      }));
      setStatusAnnouncement(res.message);
      return;
    }

    setSingleDownloads((prev) => ({
      ...prev,
      [item.id]: {
        status: "ready",
        message: "File siap diunduh",
      },
    }));
    setStatusAnnouncement(`File ${res.filename} siap diunduh.`);
  }

  function handleCancelSingleDownload(id: string) {
    const controller = singleDownloadControllersRef.current.get(id);
    if (controller) {
      controller.abort();
      singleDownloadControllersRef.current.delete(id);
    }
    setSingleDownloads((prev) => ({
      ...prev,
      [id]: { status: "idle" },
    }));
    setStatusAnnouncement("Unduhan media dibatalkan.");
  }

  async function handleZipDownload() {
    if (!fetchResult || zipAbortRef.current) {
      return;
    }

    const selectedSet = new Set(selectedIds);
    const tokens = Array.from(
      new Set(
        fetchResult.media
          .filter((item) => selectedSet.has(item.id))
          .map((item) => item.downloadToken)
      )
    );

    if (tokens.length === 0) {
      return;
    }

    const generation = resultGenerationRef.current;
    const controller = new AbortController();
    zipAbortRef.current = controller;

    setZipDownload({
      status: "downloading",
      loadedBytes: 0,
      totalBytes: null,
    });
    setStatusAnnouncement(
      `Menyiapkan arsip ZIP untuk ${tokens.length} media terpilih.`
    );

    const res = await downloadZipInstagramMedia({
      tokens,
      signal: controller.signal,
      onProgress: (progress) => {
        if (
          resultGenerationRef.current !== generation ||
          controller.signal.aborted
        ) {
          return;
        }
        setZipDownload({
          status: "downloading",
          loadedBytes: progress.loadedBytes,
          totalBytes: progress.totalBytes,
        });
      },
    });

    if (zipAbortRef.current === controller) {
      zipAbortRef.current = null;
    }

    if (resultGenerationRef.current !== generation) {
      return;
    }

    if (!res.ok) {
      if (res.kind === "aborted") {
        setZipDownload({ status: "idle" });
        setStatusAnnouncement("Pembuatan arsip ZIP dibatalkan.");
        return;
      }

      setZipDownload({
        status: "error",
        message: res.message,
        isExpiredToken: Boolean(res.isExpiredToken),
      });
      setStatusAnnouncement(res.message);
      return;
    }

    setZipDownload({
      status: "ready",
      message: "Arsip ZIP siap diunduh",
    });
    setStatusAnnouncement(`Arsip ZIP ${res.filename} siap diunduh.`);
  }

  function handleCancelZipDownload() {
    if (!zipAbortRef.current) {
      return;
    }
    zipAbortRef.current.abort();
    zipAbortRef.current = null;
    setZipDownload({ status: "idle" });
    setStatusAnnouncement("Pembuatan arsip ZIP dibatalkan.");
  }

  function handleRefetchExpired() {
    const targetInput = fetchResult?.input ?? input;
    const targetMode = fetchResult?.mode ?? mode;
    setInput(targetInput);
    setMode(targetMode);
    void startFetch(targetInput, targetMode);
  }

  const isLoading = fetchStatus === "loading";
  const hasResettableState =
    input.length > 0 ||
    fetchResult !== null ||
    fetchError !== null ||
    inputError !== null ||
    isLoading;

  const describedByIds = [
    "instagram-input-help",
    "instagram-input-note",
    inputError ? "instagram-input-error" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <main
      id="main-content"
      className={`relative isolate flex flex-1 overflow-hidden ${fetchStatus === "idle" && !fetchResult ? "items-center" : "items-start"
        }`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-96 bg-gradient-to-b from-lime-100/70 to-transparent dark:from-lime-950/30"
      />

      <section
        aria-labelledby="downloader-title"
        className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-16 lg:px-8 lg:py-20"
      >
        <div className="mx-auto max-w-2xl text-center">
          <h1
            id="downloader-title"
            className="text-4xl font-bold tracking-tight text-neutral-900 sm:text-5xl lg:text-6xl dark:text-white"
          >
            IG{" "}
            <span className="text-lime-700 dark:text-lime-300">
              Downloader
            </span>
          </h1>

          <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-neutral-600 sm:mt-5 sm:text-base dark:text-neutral-400">
            Masukkan username (dengan atau tanpa @) atau URL profil publik untuk
            mengambil Reels, Post, Stories, dan Tags secara otomatis.
          </p>
        </div>

        <div className="mx-auto mt-8 max-w-2xl rounded-2xl border border-neutral-200 bg-white p-5 shadow-xl shadow-neutral-900/5 sm:mt-10 sm:rounded-3xl sm:p-8 dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-black/20">
          <form onSubmit={handleSubmit} noValidate className="space-y-6">
            <fieldset className="space-y-2.5">
              <legend className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                Mode pengambilan media
              </legend>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {MODE_OPTIONS.map((option) => {
                  const isChecked = mode === option.value;
                  return (
                    <label
                      key={option.value}
                      className={`relative flex min-h-12 cursor-pointer flex-col justify-center rounded-xl border px-3.5 py-2.5 transition-colors focus-within:ring-2 focus-within:ring-lime-600 focus-within:ring-offset-2 motion-reduce:transition-none dark:focus-within:ring-lime-300 dark:focus-within:ring-offset-neutral-900 ${isChecked
                        ? "border-lime-600 bg-lime-50 text-lime-950 dark:border-lime-400 dark:bg-lime-950/50 dark:text-lime-100"
                        : "border-neutral-200 bg-neutral-50 text-neutral-700 hover:border-lime-300 hover:bg-lime-50/50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:border-lime-800 dark:hover:bg-lime-950/30"
                        }`}
                    >
                      <input
                        type="radio"
                        name="fetch-mode"
                        value={option.value}
                        checked={isChecked}
                        onChange={() => handleModeChange(option.value)}
                        className="sr-only"
                      />
                      <span className="flex items-center justify-between gap-2 text-sm font-semibold">
                        <span>{option.label}</span>
                        {isChecked && (
                          <span
                            aria-hidden="true"
                            className="inline-block h-2 w-2 rounded-full bg-lime-700 dark:bg-lime-300"
                          />
                        )}
                      </span>
                      <span className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                        {option.description}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="space-y-3">
              <div>
                <label
                  htmlFor="instagram-input"
                  className="block text-sm font-semibold text-neutral-900 dark:text-neutral-100"
                >
                  {activeModeConfig.inputLabel}
                </label>

                <p
                  id="instagram-input-help"
                  className="mt-1.5 text-xs leading-5 text-neutral-500 sm:text-sm dark:text-neutral-400"
                >
                  {activeModeConfig.helperText}
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <input
                    ref={inputRef}
                    id="instagram-input"
                    name="instagramInput"
                    type="text"
                    value={input}
                    onChange={(event) => {
                      setInput(event.target.value);
                      if (inputError) {
                        setInputError(null);
                      }
                    }}
                    placeholder={activeModeConfig.placeholder}
                    aria-describedby={describedByIds}
                    aria-invalid={Boolean(inputError)}
                    aria-required="true"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className={`min-h-12 w-full rounded-xl border bg-neutral-50 px-4 py-3 text-base text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:ring-2 motion-reduce:transition-none dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500 ${inputError
                      ? "border-red-500 focus:border-red-600 focus:ring-red-600/20 dark:border-red-500 dark:focus:border-red-400 dark:focus:ring-red-400/20"
                      : "border-neutral-300 focus:border-lime-600 focus:ring-lime-600/20 dark:border-neutral-700 dark:focus:border-lime-400 dark:focus:ring-lime-400/20"
                      }`}
                  />
                </div>

                <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                  <button
                    type="submit"
                    className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-lime-700 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-lime-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 motion-reduce:transition-none sm:w-auto dark:bg-lime-300 dark:text-neutral-950 dark:hover:bg-lime-400 dark:focus-visible:ring-lime-300 dark:focus-visible:ring-offset-neutral-900"
                  >
                    <span>{isLoading ? "Memproses..." : "Fetch Now"}</span>
                    <svg
                      aria-hidden="true"
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                  </button>

                  {isLoading && (
                    <button
                      type="button"
                      onClick={handleCancelFetch}
                      className="inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm font-semibold text-neutral-800 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 motion-reduce:transition-none sm:w-auto dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:focus-visible:ring-lime-300 dark:focus-visible:ring-offset-neutral-900"
                    >
                      Batalkan
                    </button>
                  )}

                  {hasResettableState && !isLoading && (
                    <button
                      type="button"
                      onClick={handleResetAll}
                      aria-label="Reset semua data dan masukkan ulang"
                      className="inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm font-semibold text-neutral-800 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 motion-reduce:transition-none sm:w-auto dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:border-red-800 dark:hover:bg-red-950/50 dark:hover:text-red-200"
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
                        <polyline points="1 4 1 10 7 10" />
                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                      </svg>
                      <span>Reset</span>
                    </button>
                  )}
                </div>
              </div>

              {inputError && (
                <p
                  id="instagram-input-error"
                  role="alert"
                  className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs leading-5 text-red-900 sm:text-sm dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
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
                    className="mt-0.5 shrink-0"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span>{inputError}</span>
                </p>
              )}

              <p
                id="instagram-input-note"
                className="text-xs leading-5 text-neutral-500 dark:text-neutral-400"
              >
                Hanya Bisa untuk akun publik via username (@user / user) maupun URL
                profil. Akun privat tidak bisa.
              </p>
            </div>

            <div className="sr-only" aria-live="polite" aria-atomic="true">
              {statusAnnouncement}
            </div>

            {isLoading && (
              <div
                role="status"
                className="flex items-center gap-3 rounded-xl border border-lime-200 bg-lime-50/80 px-4 py-3 text-sm text-lime-950 dark:border-lime-900/60 dark:bg-lime-950/30 dark:text-lime-200"
              >
                <span
                  aria-hidden="true"
                  className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-lime-700 border-t-transparent motion-reduce:animate-none dark:border-lime-300 dark:border-t-transparent"
                />
                <span>
                  Sedang mengambil profil, Reels, Post, Stories, dan Tags dari
                  Instagram...
                </span>
              </div>
            )}
          </form>

          <div className="mt-6 border-t border-neutral-100 pt-5 dark:border-neutral-800">
            <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
              Kategori media yang bisa di ambil
            </p>

            <ul
              aria-label="Cakupan media Instagram yang didukung"
              className="mt-3 flex flex-wrap gap-2"
            >
              {SUPPORTED_CONTENT_TYPES.map((content) => (
                <li
                  key={content}
                  className="rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                >
                  {content}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {fetchStatus === "error" && fetchError && (
          <div
            role="alert"
            className="mx-auto mt-6 flex max-w-2xl items-start justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
          >
            <div className="flex items-start gap-3">
              <svg
                aria-hidden="true"
                width="18"
                height="18"
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
              <div className="space-y-1">
                <p className="font-semibold">Pengambilan media gagal</p>
                <p className="leading-6">{fetchError.message}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleResetAll}
              className="inline-flex min-h-9 shrink-0 items-center justify-center rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-900 hover:bg-red-100 dark:border-red-800 dark:bg-neutral-900 dark:text-red-200"
            >
              Reset
            </button>
          </div>
        )}

        {fetchStatus === "empty" && (
          <div
            role="status"
            className="mx-auto mt-6 max-w-2xl rounded-2xl border border-neutral-200 bg-white p-6 text-center shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
          >
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              Media tidak ditemukan
            </p>
            <p className="mt-1.5 text-xs leading-5 text-neutral-600 sm:text-sm dark:text-neutral-400">
              {fetchError?.message ??
                "Tidak ada media publik yang ditemukan untuk input tersebut."}
            </p>
            <button
              type="button"
              onClick={handleResetAll}
              className="mt-4 inline-flex min-h-10 items-center justify-center rounded-xl border border-neutral-300 bg-white px-4 py-2 text-xs font-semibold text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              Reset &amp; Coba Akun Lain
            </button>
          </div>
        )}

        {fetchStatus === "success" &&
          fetchResult &&
          fetchResult.media.length > 0 && (
            <MediaGrid
              key={`${fetchResult.input}:${fetchResult.mode}:${fetchResult.count}`}
              result={fetchResult}
              selectedIds={selectedIds}
              singleDownloads={singleDownloads}
              zipDownload={zipDownload}
              isFetching={isLoading}
              onToggleSelect={handleToggleSelect}
              onSelectItems={handleSelectItems}
              onClearSelection={handleClearSelection}
              onDownloadSingle={(item) => {
                void handleSingleDownload(item);
              }}
              onCancelSingleDownload={handleCancelSingleDownload}
              onDownloadZip={() => {
                void handleZipDownload();
              }}
              onCancelZipDownload={handleCancelZipDownload}
              onRefetchExpired={handleRefetchExpired}
              onReset={handleResetAll}
            />
          )}
      </section>
    </main>
  );
}
