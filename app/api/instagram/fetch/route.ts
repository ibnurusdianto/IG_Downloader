import { fetchFromInstagramPackage } from "@/app/lib/instagram/adapter";
import { toErrorResponse, toSuccessResponse } from "@/app/lib/instagram/errors";
import { normalizePackageResult } from "@/app/lib/instagram/normalize";
import {
  fetchInstagramProfileAutonomous,
  fetchSingleMediaWithFallback,
} from "@/app/lib/instagram/profile-engine";
import { loadInstagramConfig } from "@/app/lib/instagram/security";
import {
  parseFetchRequestBody,
  readBoundedJsonBody,
  validateAndNormalizeFetchInput,
} from "@/app/lib/instagram/validation";

export async function POST(request: Request): Promise<Response> {
  try {
    const config = loadInstagramConfig();
    const rawBody = await readBoundedJsonBody(
      request,
      config.maxRequestBodyBytes
    );
    const { input, mode } = parseFetchRequestBody(
      rawBody,
      config.maxInputLength
    );
    const validated = validateAndNormalizeFetchInput(input, mode);

    if (
      mode === "auto" &&
      (validated.kind === "username" || validated.kind === "profile_url") &&
      validated.username
    ) {
      const profileResult = await fetchInstagramProfileAutonomous({
        username: validated.username,
        mode,
        originalInput: validated.normalizedInput,
        initialCategory: validated.initialCategory,
        config,
        signal: request.signal,
      });

      return toSuccessResponse(profileResult);
    }

    if (validated.kind === "media_url") {
      const ssrMediaResult = await fetchSingleMediaWithFallback({
        url: validated.normalizedInput,
        mode,
        config,
        signal: request.signal,
      });
      if (ssrMediaResult) {
        return toSuccessResponse(ssrMediaResult);
      }
    }

    const packageInput =
      validated.kind === "profile_url" && validated.username
        ? validated.username
        : validated.normalizedInput;

    const rawResult = await fetchFromInstagramPackage({
      mode,
      normalizedInput: packageInput,
      timeoutMs: config.fetchTimeoutMs,
      signal: request.signal,
    });

    const normalized = normalizePackageResult({
      rawResult,
      mode,
      input: validated.normalizedInput,
      config,
    });

    return toSuccessResponse(normalized);
  } catch (error) {
    return toErrorResponse(error);
  }
}
