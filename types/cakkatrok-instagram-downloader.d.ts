declare module "cakkatrok-instagram-downloader" {
  interface InstagramDownloaderOptions {
    type?: "story" | "media";
    lang?: string;
    html?: string;
  }

  interface InstagramDownloader {
    (input: string, options?: InstagramDownloaderOptions): Promise<unknown>;
    story(
      usernameOrUrl: string,
      options?: InstagramDownloaderOptions
    ): Promise<unknown>;
    media(
      url: string,
      options?: InstagramDownloaderOptions
    ): Promise<unknown>;
  }

  const instagram: InstagramDownloader;
  export = instagram;
}
