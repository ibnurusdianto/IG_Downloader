import { createZipDownloadResponse } from "@/app/lib/instagram/download";
import { toErrorResponse } from "@/app/lib/instagram/errors";
import { loadInstagramConfig } from "@/app/lib/instagram/security";
import {
  parseZipRequestBody,
  readBoundedJsonBody,
} from "@/app/lib/instagram/validation";

export async function POST(request: Request): Promise<Response> {
  try {
    const config = loadInstagramConfig();
    const rawBody = await readBoundedJsonBody(
      request,
      config.maxRequestBodyBytes
    );
    const tokens = parseZipRequestBody(
      rawBody,
      config.maxTokenLength,
      config.zipMaxFiles
    );

    return await createZipDownloadResponse({
      tokens,
      config,
      signal: request.signal,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
