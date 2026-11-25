import { NextResponse } from "next/server";
import type { ApiResponse } from "./types";

export class InstagramAppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "InstagramAppError";
    this.status = status;
    this.code = code;
  }
}

export class BadRequestError extends InstagramAppError {
  constructor(code: string, message: string) {
    super(400, code, message);
    this.name = "BadRequestError";
  }
}

export class TokenAuthError extends InstagramAppError {
  constructor(code: string, message: string) {
    super(401, code, message);
    this.name = "TokenAuthError";
  }
}

export class ForbiddenMediaError extends InstagramAppError {
  constructor(code: string, message: string) {
    super(403, code, message);
    this.name = "ForbiddenMediaError";
  }
}

export class MediaNotFoundError extends InstagramAppError {
  constructor(
    message = "Media tidak tersedia atau tidak ditemukan dari sumber untuk input tersebut."
  ) {
    super(404, "MEDIA_NOT_FOUND", message);
    this.name = "MediaNotFoundError";
  }
}

export class PayloadTooLargeError extends InstagramAppError {
  constructor(code: string, message: string) {
    super(413, code, message);
    this.name = "PayloadTooLargeError";
  }
}

export class ServerConfigError extends InstagramAppError {
  constructor(message: string) {
    super(500, "SERVER_CONFIG_ERROR", message);
    this.name = "ServerConfigError";
  }
}

export class UpstreamServiceError extends InstagramAppError {
  constructor(code: string, message: string) {
    super(502, code, message);
    this.name = "UpstreamServiceError";
  }
}

export class UpstreamTimeoutError extends InstagramAppError {
  constructor(
    message = "Permintaan ke layanan upstream melebihi batas waktu yang ditentukan."
  ) {
    super(504, "UPSTREAM_TIMEOUT", message);
    this.name = "UpstreamTimeoutError";
  }
}

export class RequestAbortedError extends InstagramAppError {
  constructor(message = "Permintaan dibatalkan oleh klien.") {
    super(499, "REQUEST_ABORTED", message);
    this.name = "RequestAbortedError";
  }
}

export function isInstagramAppError(error: unknown): error is InstagramAppError {
  return error instanceof InstagramAppError;
}

export function toSuccessResponse<T>(data: T, status = 200): NextResponse<ApiResponse<T>> {
  return NextResponse.json<ApiResponse<T>>(
    {
      success: true,
      data,
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}

export function toErrorResponse(error: unknown): NextResponse<ApiResponse<never>> {
  if (isInstagramAppError(error)) {
    return NextResponse.json<ApiResponse<never>>(
      {
        success: false,
        error: {
          code: error.code,
          message: error.message,
        },
      },
      {
        status: error.status,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }

  return NextResponse.json<ApiResponse<never>>(
    {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Terjadi kesalahan internal pada server.",
      },
    },
    {
      status: 500,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
