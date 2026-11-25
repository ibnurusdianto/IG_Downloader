export type InstagramFetchMode = "auto" | "story" | "media";

export type NormalizedMediaType = "image" | "video" | "unknown";

export type MediaCategory = "reels" | "post" | "stories" | "tags";

export type CategoryFilter = "all" | MediaCategory;

export type CategorySourceStatus =
  | "ok"
  | "empty"
  | "login_required"
  | "unavailable";

export type ProfileSummary = {
  username: string;
  fullName: string | null;
  biography: string | null;
  avatarPreviewUrl: string | null;
  isVerified: boolean;
  isPrivate: boolean;
  followerCount: number | null;
  followingCount: number | null;
  postsCount: number | null;
  hasActiveStories: boolean;
};

export type CategoryDiagnosticEntry = {
  status: CategorySourceStatus;
  total: number;
  message?: string;
};

export type CategoryDiagnostics = {
  reels: CategoryDiagnosticEntry;
  post: CategoryDiagnosticEntry;
  stories: CategoryDiagnosticEntry;
  tags: CategoryDiagnosticEntry & {
    discoveredUsertags: string[];
    discoveredHashtags: string[];
  };
};

export type NormalizedMedia = {
  id: string;
  type: NormalizedMediaType;
  previewUrl: string | null;
  videoPreviewUrl?: string | null;
  filename: string;
  downloadToken: string;
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
};

export type InstagramFetchData = {
  mode: InstagramFetchMode;
  input: string;
  inputKind: "profile" | "story" | "media";
  initialCategory?: CategoryFilter;
  profile?: ProfileSummary | null;
  categoryDiagnostics?: CategoryDiagnostics;
  zipMaxFiles?: number;
  count: number;
  media: NormalizedMedia[];
};

export type ApiResponse<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

export type ValidatedInstagramInput = {
  kind: "username" | "profile_url" | "story_url" | "media_url";
  normalizedInput: string;
  username?: string;
  initialCategory?: CategoryFilter;
};

export type SignedDownloadTokenPayload = {
  v: 1;
  u: string;
  f: string;
  t: NormalizedMediaType;
  iat: number;
  exp: number;
  jti: string;
};

export type InstagramRuntimeConfig = {
  tokenSecret: string;
  tokenTtlSeconds: number;
  mediaAllowedDomains: readonly string[];
  fetchTimeoutMs: number;
  downloadTimeoutMs: number;
  zipTimeoutMs: number;
  maxRequestBodyBytes: number;
  maxInputLength: number;
  maxTokenLength: number;
  maxFileBytes: number;
  zipMaxFiles: number;
  zipMaxTotalBytes: number;
  zipConcurrency: number;
};
