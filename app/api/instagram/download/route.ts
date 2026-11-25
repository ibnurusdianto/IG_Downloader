import { createSingleDownloadResponse } from "@/app/lib/instagram/download";
import { toErrorResponse } from "@/app/lib/instagram/errors";
import { loadInstagramConfig } from "@/app/lib/instagram/security";
import {
  parseDownloadRequestBody,
  readBoundedJsonBody,
} from "@/app/lib/instagram/validation";

export async function POST(request: Request): Promise<Response> {
  try {
    const config = loadInstagramConfig();
    const rawBody = await readBoundedJsonBody(
      request,
      config.maxRequestBodyBytes
    );
    const token = parseDownloadRequestBody(rawBody, config.maxTokenLength);

    return await createSingleDownloadResponse({
      token,
      config,
      signal: request.signal,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
