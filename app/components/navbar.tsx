import Link from "next/link";

type NavbarProps = {
    supportUrl?: string;
};

export default function Navbar({ supportUrl }: NavbarProps) {
    return (
        <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/95 backdrop-blur-md dark:border-neutral-800 dark:bg-neutral-950/95">
            <a
                href="#main-content"
                className="sr-only rounded-lg bg-lime-700 px-4 py-3 text-sm font-medium text-white focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:outline-none focus:ring-2 focus:ring-lime-500 focus:ring-offset-2"
            >
                Lewati ke konten utama
            </a>

            <nav
                aria-label="Navigasi utama"
                className="mx-auto flex min-h-16 w-full max-w-6xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 sm:min-h-20 sm:px-6 lg:px-8"
            >
                <Link
                    href="/"
                    aria-label="IG Downloader, beranda"
                    className="inline-flex min-h-11 items-center rounded-lg text-lg tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-4 sm:text-xl dark:focus-visible:ring-lime-300 dark:focus-visible:ring-offset-neutral-950"
                >
                    <span className="font-bold text-neutral-900 dark:text-white">
                        Instagram Downloader
                    </span>
                </Link>

                {supportUrl && (
                    <a
                        href={supportUrl}
                        className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl border border-neutral-200 bg-white px-3 py-2 text-xs font-semibold text-neutral-700 transition-colors hover:border-lime-300 hover:bg-lime-50 hover:text-lime-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 motion-reduce:transition-none sm:px-4 sm:text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-lime-800 dark:hover:bg-lime-950 dark:hover:text-lime-300 dark:focus-visible:ring-lime-300 dark:focus-visible:ring-offset-neutral-950"
                    >
                        Support Me
                    </a>
                )}
            </nav>
        </header>
    );
}