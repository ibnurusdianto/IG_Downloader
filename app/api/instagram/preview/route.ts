import { NextResponse } from "next/server";
import { BadRequestError, toErrorResponse } from "@/app/lib/instagram/errors";
import { createPreviewResponse } from "@/app/lib/instagram/download";
import { loadInstagramConfig } from "@/app/lib/instagram/security";

export async function GET(request: Request): Promise<Response> {
  try {
    const config = loadInstagramConfig();
    const requestUrl = new URL(request.url);
    const rawToken = requestUrl.searchParams.get("token");

    if (typeof rawToken !== "string" || rawToken.trim().length === 0) {
      throw new BadRequestError(
        "INVALID_TOKEN",
        "Token preview media wajib disertakan."
      );
    }

    const token = rawToken.trim();
    if (token.length > config.maxTokenLength) {
      throw new BadRequestError(
        "INVALID_TOKEN",
        "Ukuran token preview media melebihi batas yang diizinkan."
      );
    }

    const rangeHeader = request.headers.get("range") ?? undefined;

    return await createPreviewResponse({
      token,
      config,
      signal: request.signal,
      rangeHeader,
    });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    return toErrorResponse(error);
  }
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204 });
}
