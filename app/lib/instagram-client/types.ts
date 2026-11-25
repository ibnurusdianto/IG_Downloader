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

export type InstagramMediaItem = {
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
  media: InstagramMediaItem[];
};

export type InstagramApiError = {
  code: string;
  message: string;
};

export type ClientFetchValidationResult =
  | {
      ok: true;
      input: string;
      kind: "username" | "profile_url" | "story_url" | "media_url";
      initialCategory?: CategoryFilter;
    }
  | {
      ok: false;
      message: string;
    };

export type FetchMediaResult =
  | {
      ok: true;
      data: InstagramFetchData;
    }
  | {
      ok: false;
      kind: "aborted";
    }
  | {
      ok: false;
      kind: "backend" | "network" | "invalid_response";
      message: string;
      code?: string;
      status?: number;
      isExpiredToken?: boolean;
      isNotFound?: boolean;
    };

export type DownloadProgress = {
  loadedBytes: number;
  totalBytes: number | null;
};

export type DownloadFileResult =
  | {
      ok: true;
      filename: string;
      bytesReceived: number;
    }
  | {
      ok: false;
      kind: "aborted";
    }
  | {
      ok: false;
      kind: "backend" | "network" | "invalid_response";
      message: string;
      code?: string;
      status?: number;
      isExpiredToken?: boolean;
    };

export type CardDownloadState =
  | { status: "idle" }
  | { status: "downloading"; loadedBytes: number; totalBytes: number | null }
  | { status: "ready"; message: string }
  | { status: "error"; message: string; isExpiredToken: boolean };

export type ZipDownloadState =
  | { status: "idle" }
  | { status: "downloading"; loadedBytes: number; totalBytes: number | null }
  | { status: "ready"; message: string }
  | { status: "error"; message: string; isExpiredToken: boolean };
