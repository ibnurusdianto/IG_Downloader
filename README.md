# Instagram Downloader

Aplikasi web berbasis Next.js App Router untuk mengambil, mempratinjau, dan mengunduh media Instagram yang bersifat publik (Reels, Post, carousel, Stories aktif, serta deteksi konten dengan tag, mention, dan hashtag) melalui antarmuka web dan endpoint API yang dilindungi validasi input, token bertanda tangan HMAC-SHA256, serta perlindungan SSRF.

## Daftar Isi

1. [Fitur dan Batasan yang Diketahui](#fitur-dan-batasan-yang-diketahui)
2. [Tech Stack](#tech-stack)
3. [Persyaratan Sistem](#persyaratan-sistem)
4. [Struktur Folder](#struktur-folder)
5. [Instalasi dan Konfigurasi Environment](#instalasi-dan-konfigurasi-environment)
6. [Penjelasan Variabel Environment (.env.example)](#penjelasan-variabel-environment-envexample)
7. [Perintah Pengembangan dan Build](#perintah-pengembangan-dan-build)
8. [Dokumentasi Endpoint API](#dokumentasi-endpoint-api)
9. [Alur Penggunaan Frontend](#alur-penggunaan-frontend)
10. [Keamanan](#keamanan)
11. [Panduan Deployment](#panduan-deployment)
12. [Pemecahan Masalah](#pemecahan-masalah)
13. [Batasan Hukum dan Penggunaan Wajar](#batasan-hukum-dan-penggunaan-wajar)

## Fitur dan Batasan yang Diketahui

### Fitur yang Tersedia

- **Tiga mode pengambilan media**:
  - **Auto (Profil Lengkap)** (`mode: "auto"`): menerima username (`@username` atau `username`), URL profil (`https://www.instagram.com/<username>/`, termasuk `/reels/`, `/tagged/`, dan `/channel/`), URL Stories, maupun URL Reels/Post. Untuk username atau URL profil, server menjalankan mesin otonom (`fetchInstagramProfileAutonomous`) yang mengambil ringkasan profil, Post, Reels, status tab Tagged, dan Stories publik aktif secara paralel, lalu memperkaya detail shortcode untuk slide carousel, resolusi penuh foto/video, caption, jumlah suka/putar/komentar, tagged users, mentions, dan hashtags.
  - **Stories** (`mode: "story"`): menerima username, URL profil, atau URL Stories (`/stories/<username>/` atau `/stories/<username>/<storyId>/`) melalui paket `cakkatrok-instagram-downloader`.
  - **Reels/Post** (`mode: "media"`): menerima URL HTTPS Reels (`/reel/<shortcode>/` atau `/reels/<shortcode>/`) atau postingan (`/p/<shortcode>/`). Server mencoba mengambil detail via halaman SSR/embed Instagram terlebih dahulu (untuk mendukung carousel penuh dan tag) lalu otomatis melakukan fallback ke `cakkatrok-instagram-downloader`.
- **Pratinjau media via proxy aman**: foto, thumbnail video, avatar profil, dan pemutaran video (inline pada kartu maupun modal perbesar) dialirkan melalui `GET /api/instagram/preview` dengan dukungan HTTP `Range` (`206 Partial Content`) untuk video.
- **Kategorisasi, filter, dan paginasi**: pengelompokan media ke tab `Semua`, `Reels`, `Post`, `Stories`, dan `Tags`, filter cepat berdasarkan `@usertag`, `@mention`, atau `#hashtag` pada tab `Tags`, panel diagnostik status sumber per kategori, serta paginasi dengan pilihan `12`, `24`, atau `36` item per halaman.
- **Unduhan tunggal dan arsip ZIP**:
  - Unduhan file individual via `POST /api/instagram/download` dengan pelacakan progres byte, pembatalan unduhan (`AbortController`), dan sanitasi nama file.
  - Unduhan massal sebagai arsip `.zip` tanpa kompresi ulang (`ZipArchive({ store: true })`) via `POST /api/instagram/zip` dengan tombol pilih per halaman, pilih per kategori, hapus pilihan, deduplikasi URL, penamaan file unik di dalam arsip, pelacakan progres, dan pembatalan proses ZIP.
- **Penanganan token kedaluwarsa**: saat token bertanda tangan kedaluwarsa (`TOKEN_EXPIRED`), antarmuka menyediakan tombol untuk mengambil ulang media dan memperbarui token.

### Batasan yang Diketahui

- **Hanya akun dan konten publik**: akun privat terdeteksi dan ditolak dengan kode error `PRIVATE_ACCOUNT` (`403`).
- **Tab Tagged eksternal memerlukan login**: Instagram membatasi halaman `/<username>/tagged/` tanpa autentikasi. Saat berstatus `login_required`, tab `Tags` tetap menampilkan postingan/Reels profil yang terdeteksi memiliki `@usertag`, kolaborator, `@mention`, atau `#hashtag`.
- **Batas penemuan shortcode profil**: mesin profil membatasi pengayaan detail maksimal `24` shortcode (`MAX_PROFILE_SHORTCODES = 24`) dengan konkurensi `5` dan batas waktu `6500 ms` per postingan. Apabila halaman profil dibatasi oleh Instagram tanpa login, server mengembalikan `INSTAGRAM_LOGIN_REQUIRED` (`502`).
- **Ketergantungan upstream**: pengambilan Stories dan fallback media bergantung pada pihak ketiga melalui `cakkatrok-instagram-downloader` serta struktur HTML/Relay Instagram yang dapat berubah atau dibatasi sementara oleh upstream.
- **Catatan konfigurasi `INSTAGRAM_ZIP_MAX_FILES`**: pada `app/lib/instagram/security.ts`, pembacaan `INSTAGRAM_ZIP_MAX_FILES` saat ini menetapkan nilai default `1000000000` dengan rentang validasi `1000000000..1000000000`. Jika `.env.local` mengisi `INSTAGRAM_ZIP_MAX_FILES=50` seperti di `.env.example`, server akan mengembalikan `500 SERVER_CONFIG_ERROR` hingga nilai di `.env.local` dikosongkan atau disesuaikan dengan batas pada `security.ts`.
- **Belum ada test suite dan rate limiting bawaan**: `package.json` belum memiliki script pengujian otomatis dan API belum memiliki pembatasan laju permintaan per IP.

## Tech Stack

Versi dependensi di bawah ini sesuai dengan `my-project/package.json`:

| Komponen | Paket | Versi |
| --- | --- | --- |
| Framework & Runtime Web | `next` | `16.4.6` |
| Library UI | `react`, `react-dom` | `19.3.0` |
| Bahasa Pemrograman | `typescript` | `^5` |
| Styling | `tailwindcss` | `^4.3.3` |
| PostCSS & Turbopack CSS | `@tailwindcss/postcss`, `@tailwindcss/turbopack`, `postcss` | `^4.3.5`, `4.3.3`, `^8.5.33` |
| Pengambil Media Instagram | `cakkatrok-instagram-downloader` | `^2.0.2` |
| Pembuat Arsip ZIP | `archiver` (`@types/archiver`) | `^8.0.0` (`^8.0.0`) |
| Pembatas Konkurensi | `p-limit` | `^7.3.3` |
| Linter | `eslint`, `eslint-config-next` | `^9`, `16.4.6` |
| Definisi Tipe | `@types/node`, `@types/react`, `@types/react-dom` | `^20`, `^19`, `^19` |

Konfigurasi Next.js pada `next.config.ts` mengaktifkan `cacheComponents: true`, `partialPrefetching: true`, dan loader CSS Turbopack `@tailwindcss/turbopack`. Font `Geist` dan `Geist_Mono` dimuat melalui `next/font/google`.

## Persyaratan Sistem

- **Node.js**: versi `>= 20.9.0` (mengikuti persyaratan mesin pada `next@16.4.6`).
- **npm**: versi yang mendukung `package-lock.json` lockfile v3 (diverifikasi lokal dengan Node.js `v26.13.0` dan npm `11.20.0`).
- **Konektivitas jaringan**: server membutuhkan akses keluar HTTPS ke `instagram.com`, `www.instagram.com`, `m.instagram.com`, serta host CDN pada `INSTAGRAM_MEDIA_ALLOWED_DOMAINS`. Proses `next build` juga memerlukan akses ke Google Fonts untuk `Geist` dan `Geist_Mono`.

## Struktur Folder

Struktur direktori proyek di dalam folder `my-project/`:

```text
my-project/
├── app/
│   ├── api/
│   │   └── instagram/
│   │       ├── download/
│   │       │   └── route.ts        # POST endpoint unduhan file tunggal
│   │       ├── fetch/
│   │       │   └── route.ts        # POST endpoint pengambilan metadata dan token media
│   │       ├── preview/
│   │       │   └── route.ts        # GET/OPTIONS endpoint proxy pratinjau media
│   │       └── zip/
│   │           └── route.ts        # POST endpoint streaming arsip ZIP
│   ├── components/
│   │   ├── instagram/
│   │   │   ├── media-card.tsx      # Kartu media, pratinjau, video inline, dan progres unduhan
│   │   │   └── media-grid.tsx      # Ringkasan profil, tab kategori, filter tag, paginasi, modal pratinjau, dan kontrol ZIP
│   │   ├── main.tsx                # Komponen utama form input, mode, state fetch/unduh, dan penanganan error
│   │   └── navbar.tsx              # Header dan navigasi utama
│   ├── lib/
│   │   ├── instagram/              # Logika server-side (hanya Node.js)
│   │   │   ├── adapter.ts          # Pembungkus cakkatrok-instagram-downloader dan ekstraktor thumbnail SnapVideo
│   │   │   ├── download.ts         # Streaming proxy HTTPS, validasi redirect, dan pembuat arsip ZIP
│   │   │   ├── errors.ts           # Kelas error terstruktur dan formatter respons JSON
│   │   │   ├── normalize.ts        # Normalisasi hasil paket dan penandatanganan token media
│   │   │   ├── profile-engine.ts   # Mesin penemuan profil otonom dan enrichment shortcode
│   │   │   ├── security.ts         # Loader env config, validator secret, allowlist domain, DNS pinning SSRF, sanitasi nama file
│   │   │   ├── tokens.ts           # Penandatanganan dan verifikasi token HMAC-SHA256
│   │   │   ├── types.ts            # Definisi tipe backend
│   │   │   └── validation.ts       # Pembaca JSON berbatas byte dan validator input API
│   │   └── instagram-client/       # Utilitas client-side
│   │       ├── api.ts              # Klien fetch API dan parser amplop respons
│   │       ├── download.ts         # Pengunduh blob berprogres dan parser Content-Disposition
│   │       ├── format.ts           # Pemformat ukuran byte, angka ringkas, dan label kategori
│   │       ├── types.ts            # Definisi tipe frontend
│   │       └── validation.ts       # Validasi input form sebelum mengirim permintaan
│   ├── favicon.ico
│   ├── globals.css                 # Konfigurasi Tailwind CSS v4
│   ├── layout.tsx                  # Root layout, font Geist, dan metadata halaman
│   └── page.tsx                    # Halaman beranda
├── public/                         # Aset SVG statis
├── types/
│   └── cakkatrok-instagram-downloader.d.ts
├── .env.example                    # Contoh template konfigurasi environment
├── .gitignore
├── eslint.config.mjs
├── next.config.ts
├── package.json
├── package-lock.json
├── postcss.config.mjs
└── tsconfig.json
```

## Instalasi dan Konfigurasi Environment

1. Masuk ke direktori proyek Next.js:

   ```bash
   cd my-project
   ```

2. Pasang seluruh dependensi:

   ```bash
   npm install
   ```

3. Salin file `.env.example` menjadi `.env.local`:

   ```bash
   cp .env.example .env.local
   ```

   Pada Windows PowerShell:

   ```powershell
   Copy-Item .env.example .env.local
   ```

4. Buat nilai acak yang kuat untuk `INSTAGRAM_TOKEN_SECRET` (minimal 32 byte):

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

5. Tempelkan hasil string acak tersebut ke `INSTAGRAM_TOKEN_SECRET=` pada `.env.local`, dan sesuaikan variabel lain bila diperlukan. Jangan pernah menuliskan secret asli ke `.env.example` atau mengirim `.env.local` ke repository Git.

   Catatan penting: sesuai implementasi `loadInstagramConfig()` di `app/lib/instagram/security.ts`, hapus atau kosongkan baris `INSTAGRAM_ZIP_MAX_FILES` di `.env.local` (atau pastikan nilainya memenuhi batas `1000000000`) agar inisialisasi konfigurasi server tidak melempar `SERVER_CONFIG_ERROR`.

## Penjelasan Variabel Environment (.env.example)

Semua variabel environment berikut dibaca oleh `loadInstagramConfig()` di `app/lib/instagram/security.ts`. Nilai selain secret memiliki batas minimum dan maksimum yang divalidasi ketat sebagai bilangan bulat.

| Variabel | Wajib | Nilai di `.env.example` | Rentang / Aturan Validasi | Fungsi |
| --- | --- | --- | --- | --- |
| `INSTAGRAM_TOKEN_SECRET` | Ya | Kosong (`""`) | Min. `32` byte UTF-8, min. `8` karakter unik, dilarang memakai pola lemah (`replace-with`, `changeme`, `your-secret`, `example`, `default`, `test-secret`, `instagram-secret`) | Kunci HMAC-SHA256 untuk menandatangani dan memverifikasi token pratinjau serta unduhan media. |
| `INSTAGRAM_TOKEN_TTL_SECONDS` | Tidak | `600` | `30` hingga `86400` (default `600`) | Masa berlaku token unduhan dan pratinjau dalam detik. |
| `INSTAGRAM_MEDIA_ALLOWED_DOMAINS` | Ya | `dl.snapcdn.app,i.snapcdn.app,cdninstagram.com,fbcdn.net` | Daftar domain dipisah koma, tanpa wildcard (`*`), tanpa alamat IP, tanpa `localhost`, dan tanpa sufiks lokal (`.local`, `.internal`, `.arpa`, `.localdomain`, `.localhost`) | Daftar domain (termasuk subdomainnya) yang diizinkan sebagai sumber URL media upstream untuk mencegah SSRF. |
| `INSTAGRAM_FETCH_TIMEOUT_MS` | Tidak | `45000` | `1000` hingga `120000` (default `45000`) | Batas waktu tunggu pengambilan data media dan profil dalam milidetik. |
| `INSTAGRAM_DOWNLOAD_TIMEOUT_MS` | Tidak | `30000` | `1000` hingga `300000` (default `30000`) | Batas waktu tunggu header dan idle stream per permintaan unduhan atau pratinjau media dalam milidetik. |
| `INSTAGRAM_ZIP_TIMEOUT_MS` | Tidak | `120000` | `5000` hingga `600000` (default `120000`) | Batas waktu total pembuatan dan pengiriman arsip ZIP dalam milidetik. |
| `INSTAGRAM_MAX_REQUEST_BODY_BYTES` | Tidak | `262144` | `512` hingga `2097152` (default `262144` / 256 KiB) | Batas ukuran maksimum body JSON permintaan ke endpoint API. |
| `INSTAGRAM_MAX_INPUT_LENGTH` | Tidak | `512` | `30` hingga `2048` (default `512`) | Batas panjang maksimum string `input` pada `POST /api/instagram/fetch`. |
| `INSTAGRAM_MAX_TOKEN_LENGTH` | Tidak | `8192` | `128` hingga `16384` (default `8192`) | Batas panjang maksimum karakter untuk satu token bertanda tangan. |
| `INSTAGRAM_MAX_FILE_BYTES` | Tidak | `52428800` | `1024` hingga `524288000` (default `52428800` / 50 MiB) | Batas ukuran maksimum per file media saat pratinjau, unduhan tunggal, maupun entri ZIP. |
| `INSTAGRAM_ZIP_MAX_FILES` | Tidak | `50` | Pada `security.ts` saat ini dibatasi `1000000000` hingga `1000000000` (default `1000000000`) | Batas jumlah maksimum file unik dalam satu arsip ZIP di backend (nilai pada `.env.example` lebih kecil dari rentang `security.ts`; kosongkan di `.env.local` jika memakai batas kode saat ini). |
| `INSTAGRAM_ZIP_MAX_TOTAL_BYTES` | Tidak | `209715200` | `1024` hingga `1073741824` (default `209715200` / 200 MiB) | Batas akumulasi total ukuran media sebelum pengarsipan dalam satu permintaan ZIP. |
| `INSTAGRAM_ZIP_CONCURRENCY` | Tidak | `3` | `1` hingga `10` (default `3`) | Jumlah unduhan upstream bersamaan saat menyusun arsip ZIP. |

## Perintah Pengembangan dan Build

Jalankan perintah berikut dari dalam direktori `my-project/`:

- **Menjalankan server pengembangan**:

  ```bash
  npm run dev
  ```

- **Menjalankan pemeriksaan lint (ESLint)**:

  ```bash
  npm run lint
  ```

- **Menjalankan pemeriksaan tipe TypeScript**:

  ```bash
  npx tsc --noEmit
  ```

- **Membuat build produksi**:

  ```bash
  npm run build
  ```

  Jika Turbopack mengalami kendala pembuatan proses pekerja pada lingkungan tertentu, build dapat dijalankan dengan mode Webpack:

  ```bash
  npx next build --webpack
  ```

- **Menjalankan server produksi (setelah `npm run build`)**:

  ```bash
  npm run start
  ```

## Dokumentasi Endpoint API

Seluruh endpoint JSON mengembalikan header `Cache-Control: no-store` dan format amplop respons standar:

- Sukses JSON: `{ "success": true, "data": ... }`
- Error JSON: `{ "success": false, "error": { "code": "...", "message": "..." } }`

### 1. `POST /api/instagram/fetch`

Mengambil metadata profil, daftar media publik, dan menerbitkan `downloadToken` serta URL proxy pratinjau bertanda tangan.

- **Header**: `Content-Type: application/json`
- **Request Body**:

  ```json
  {
    "input": "@instagram",
    "mode": "auto"
  }
  ```

  - `input` (`string`, wajib): username (`@username` / `username`) atau URL HTTPS dari domain `instagram.com`, `www.instagram.com`, atau `m.instagram.com` (`/username/`, `/stories/username/`, `/reel/shortcode/`, `/p/shortcode/`).
  - `mode` (`"auto" | "story" | "media"`, opsional, default `"auto"`).

- **Respons Sukses (`200 OK`)**:

  ```json
  {
    "success": true,
    "data": {
      "mode": "auto",
      "input": "instagram",
      "inputKind": "profile",
      "initialCategory": "all",
      "profile": {
        "username": "instagram",
        "fullName": "Instagram",
        "biography": "...",
        "avatarPreviewUrl": "/api/instagram/preview?token=...",
        "isVerified": true,
        "isPrivate": false,
        "followerCount": 0,
        "followingCount": 0,
        "postsCount": 0,
        "hasActiveStories": false
      },
      "categoryDiagnostics": {
        "reels": { "status": "ok", "total": 1 },
        "post": { "status": "ok", "total": 1 },
        "stories": { "status": "empty", "total": 0, "message": "..." },
        "tags": {
          "status": "login_required",
          "total": 0,
          "message": "...",
          "discoveredUsertags": [],
          "discoveredHashtags": []
        }
      },
      "zipMaxFiles": 1000000000,
      "count": 2,
      "media": [
        {
          "id": "media_0123456789abcdef",
          "type": "image",
          "previewUrl": "/api/instagram/preview?token=...",
          "videoPreviewUrl": null,
          "filename": "instagram-post-ABC123.jpg",
          "downloadToken": "<signed-token>",
          "category": "post",
          "categories": ["post"],
          "shortcode": "ABC123",
          "caption": "...",
          "likeCount": 100,
          "commentCount": 10,
          "playCount": null,
          "takenAt": 1700000000,
          "taggedUsers": [],
          "hashtags": [],
          "mentions": []
        }
      ]
    }
  }
  ```

- **Respons Error dan Status HTTP**:
  - `400 Bad Request`: `INVALID_CONTENT_TYPE`, `INVALID_CONTENT_LENGTH`, `INVALID_JSON`, `INVALID_MODE`, `INVALID_INPUT`, `INPUT_TOO_LONG`, `INVALID_USERNAME`, `UNSUPPORTED_PROTOCOL`, `INVALID_URL_CREDENTIALS`, `UNSUPPORTED_PORT`, `UNSUPPORTED_HOST`, `INVALID_URL_PATH`, `UNSUPPORTED_PATH`, `INVALID_MODE_INPUT`.
  - `403 Forbidden`: `PRIVATE_ACCOUNT`, `MEDIA_IP_BLOCKED`.
  - `404 Not Found`: `MEDIA_NOT_FOUND`.
  - `413 Payload Too Large`: `PAYLOAD_TOO_LARGE`.
  - `499 Client Closed Request`: `REQUEST_ABORTED`.
  - `500 Internal Server Error`: `SERVER_CONFIG_ERROR`, `INTERNAL_ERROR`.
  - `502 Bad Gateway`: `INSTAGRAM_LOGIN_REQUIRED`, `UPSTREAM_ERROR`, `UPSTREAM_INVALID_RESPONSE`, `UPSTREAM_UNTRUSTED_MEDIA`, `UPSTREAM_TOO_MANY_REDIRECTS`, `UPSTREAM_DNS_ERROR`.
  - `504 Gateway Timeout`: `UPSTREAM_TIMEOUT`.

### 2. `GET /api/instagram/preview` (dan `OPTIONS`)

Mengalirkan pratinjau gambar atau video melalui server menggunakan token bertanda tangan.

- **Query Parameter**:
  - `token` (`string`, wajib): token bertanda tangan dari `/api/instagram/fetch`.
- **Header Opsional**:
  - `Range`: `bytes=<start>-<end?>` (didukung untuk streaming parsial video).
- **Respons Sukses (`200 OK` atau `206 Partial Content`)**:
  - Stream biner media dengan header:
    - `Content-Type`: salah satu tipe MIME media aman (`image/jpeg`, `image/png`, `image/webp`, `image/gif`, `video/mp4`, `video/webm`, `video/quicktime`, atau `application/octet-stream`).
    - `Content-Disposition: inline; filename="<nama-file-aman>"`
    - `Cache-Control: private, max-age=300`
    - `X-Content-Type-Options: nosniff`
    - `Content-Length`, `Content-Range`, dan `Accept-Ranges` bila tersedia.
- **Preflight (`OPTIONS`)**: mengembalikan `204 No Content`.
- **Respons Error dan Status HTTP**:
  - `400 Bad Request`: `INVALID_TOKEN` (jika parameter `token` kosong atau melebihi `INSTAGRAM_MAX_TOKEN_LENGTH`).
  - `401 Unauthorized`: `INVALID_TOKEN`, `TOKEN_EXPIRED`.
  - `403 Forbidden`: `MEDIA_URL_NOT_ALLOWED`, `MEDIA_IP_BLOCKED`, `MEDIA_HOST_MISMATCH`.
  - `404 Not Found`: `MEDIA_NOT_FOUND`.
  - `413 Payload Too Large`: `FILE_SIZE_LIMIT_EXCEEDED`.
  - `499`, `500`, `502`, `504`: sesuai error upstream, konfigurasi server, atau pembatalan klien.

### 3. `POST /api/instagram/download`

Mengunduh satu file media melalui proxy server dengan `Content-Disposition: attachment`.

- **Header**: `Content-Type: application/json`
- **Request Body**:

  ```json
  {
    "token": "<signed-download-token>"
  }
  ```

- **Respons Sukses (`200 OK`)**:
  - Stream biner file dengan `Content-Type` media aman, `Content-Disposition: attachment; filename="<nama-file-aman>"`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, dan `Content-Length` bila tersedia.
- **Respons Error dan Status HTTP**:
  - `400 Bad Request`: `INVALID_CONTENT_TYPE`, `INVALID_CONTENT_LENGTH`, `INVALID_JSON`, `INVALID_INPUT`, `INVALID_TOKEN`.
  - `401 Unauthorized`: `INVALID_TOKEN`, `TOKEN_EXPIRED`.
  - `403 Forbidden`: `MEDIA_URL_NOT_ALLOWED`, `MEDIA_IP_BLOCKED`, `MEDIA_HOST_MISMATCH`.
  - `404 Not Found`: `MEDIA_NOT_FOUND`.
  - `413 Payload Too Large`: `PAYLOAD_TOO_LARGE`, `FILE_SIZE_LIMIT_EXCEEDED`.
  - `499`, `500`, `502`, `504`: `REQUEST_ABORTED`, `SERVER_CONFIG_ERROR`, `UPSTREAM_*`, `INTERNAL_ERROR`.

### 4. `POST /api/instagram/zip`

Mengunduh beberapa media sekaligus dalam satu arsip `.zip` yang di-stream langsung ke klien.

- **Header**: `Content-Type: application/json`
- **Request Body**:

  ```json
  {
    "tokens": ["<token-1>", "<token-2>"]
  }
  ```

  - `tokens`: array string non-kosong. Panjang array mentah dibatasi `Math.max(zipMaxFiles * 4, 100)`, sedangkan jumlah URL unik yang diproses dibatasi oleh `zipMaxFiles`.

- **Respons Sukses (`200 OK`)**:
  - Stream arsip ZIP dengan header:
    - `Content-Type: application/zip`
    - `Content-Disposition: attachment; filename="instagram-media-<timestamp>.zip"`
    - `Cache-Control: no-store`
    - `X-Content-Type-Options: nosniff`
- **Respons Error dan Status HTTP**:
  - `400 Bad Request`: `INVALID_CONTENT_TYPE`, `INVALID_CONTENT_LENGTH`, `INVALID_JSON`, `INVALID_INPUT`, `INVALID_TOKEN`.
  - `401 Unauthorized`: `INVALID_TOKEN`, `TOKEN_EXPIRED`.
  - `403 Forbidden`: `MEDIA_URL_NOT_ALLOWED`, `MEDIA_IP_BLOCKED`, `MEDIA_HOST_MISMATCH`.
  - `404 Not Found`: `MEDIA_NOT_FOUND`.
  - `413 Payload Too Large`: `PAYLOAD_TOO_LARGE`, `ZIP_FILE_LIMIT_EXCEEDED`, `ZIP_SIZE_LIMIT_EXCEEDED`, `FILE_SIZE_LIMIT_EXCEEDED`.
  - `499`, `500`, `502`, `504`: `REQUEST_ABORTED`, `SERVER_CONFIG_ERROR`, `UPSTREAM_*`, `ZIP_STREAM_ABORTED`, `ZIP_ARCHIVE_ERROR`, `INTERNAL_ERROR`.

## Alur Penggunaan Frontend

1. Pengguna membuka halaman utama (`app/page.tsx`) yang menampilkan `Navbar` dan komponen `Main` (`app/components/main.tsx`).
2. Pengguna memilih salah satu mode pengambilan media: `Auto (Profil Lengkap)`, `Stories`, atau `Reels/Post`.
3. Pengguna memasukkan `@username`, `username`, atau URL HTTPS Instagram ke kolom input dan menekan tombol `Fetch Now`.
4. Validasi awal berjalan di browser (`validateClientFetchInput`) untuk menolak input kosong, karakter kontrol/backslash, protokol selain HTTPS, URL beranda, atau format path yang tidak cocok dengan mode yang dipilih.
5. Jika valid, klien mengirim permintaan ke `POST /api/instagram/fetch`. Pengguna dapat membatalkan proses kapan saja melalui tombol `Batalkan` atau mengosongkan seluruh state dengan tombol `Reset`.
6. Ketika data diterima, `MediaGrid` (`app/components/instagram/media-grid.tsx`) menampilkan:
   - Ringkasan profil publik (avatar, nama lengkap, bio, badge terverifikasi/stories aktif, serta statistik postingan, pengikut, dan mengikuti) bila input berupa profil.
   - Tab kategori (`Semua`, `Reels`, `Post`, `Stories`, `Tags`), diagnostik kategori, filter tag pada tab `Tags`, serta kontrol jumlah item per halaman (`12`, `24`, `36`) dan paginasi.
   - Daftar `MediaCard` (`app/components/instagram/media-card.tsx`) dengan pratinjau gambar/video via `/api/instagram/preview`, tombol `Putar` video inline, tombol `Perbesar` (modal pratinjau dengan tombol `Escape` untuk menutup), serta tombol `Unduh` per item dengan progres byte dan tombol `Batalkan Unduhan`.
7. Untuk unduhan massal, pengguna mencentang media secara manual atau lewat tombol `Pilih Halaman Ini` / `Pilih Kategori`, lalu menekan `Unduh ZIP` untuk memanggil `POST /api/instagram/zip` dan menyimpan file `.zip` secara otomatis via Blob URL.
8. Jika terjadi `TOKEN_EXPIRED`, kartu atau panel ZIP menampilkan tombol `Ambil Ulang Media` untuk menyegarkan daftar token.

## Keamanan

- **Validasi Input Berlapis**:
  - Sisi klien (`app/lib/instagram-client/validation.ts`) dan sisi server (`app/lib/instagram/validation.ts`) memvalidasi tipe JSON, panjang input (`INSTAGRAM_MAX_INPUT_LENGTH`), panjang token (`INSTAGRAM_MAX_TOKEN_LENGTH`), karakter kontrol/backslash, kredensial URL (`username`/`password`), port non-standar, skema `https:`, path ter-encode `%2f`/`%5c`, serta whitelist hostname Instagram (`instagram.com`, `www.instagram.com`, `m.instagram.com`).
  - `readBoundedJsonBody` memverifikasi header `Content-Type`, memvalidasi `Content-Length`, membaca body stream secara bertahap dengan batas `INSTAGRAM_MAX_REQUEST_BODY_BYTES`, dan mendekode UTF-8 secara ketat (`fatal: true`).
- **Token Bertanda Tangan (HMAC-SHA256)**:
  - URL media asli tidak diterima langsung dari klien pada endpoint proxy/unduh. Setiap item media dibungkus token berformat `<base64url(payload)>.<base64url(signature)>` berisi versi (`v: 1`), URL kanonik (`u`), nama file (`f`), tipe media (`t`), waktu terbit (`iat`), waktu kedaluwarsa (`exp`), dan ID acak (`jti` 12-byte hex).
  - Verifikasi di `tokens.ts` menggunakan `crypto.timingSafeEqual`, memeriksa `iat` dan `exp`, serta memvalidasi ulang domain URL dan nama file.
- **Perlindungan SSRF dan DNS Pinning**:
  - `validateMediaUrl` hanya mengizinkan protokol `https:`, tanpa kredensial, tanpa port khusus, dan hanya untuk host yang cocok persis atau menjadi subdomain dari `INSTAGRAM_MEDIA_ALLOWED_DOMAINS`. Host berupa IP literal, wildcard, trailing dot, `localhost`, maupun domain lokal (`.local`, `.internal`, `.arpa`, `.localdomain`, `.localhost`) ditolak.
  - `createPinnedLookup` di `app/lib/instagram/security.ts` melakukan resolusi DNS secara eksplisit (`all: true, verbatim: true`), memblokir seluruh rentang IP privat, loopback, link-local, CGNAT, dokumentasi, multicast, dan reserved IPv4/IPv6 (termasuk IPv4-mapped IPv6, NAT64, Teredo, ULA), lalu memeriksa ulang `socket.remoteAddress` pada saat koneksi socket tersambung untuk mencegah serangan DNS rebinding.
  - Redirect dibatasi maksimal `3` hop pada unduhan/pratinjau media (`MAX_REDIRECT_HOPS = 3`) dan `2` hop pada pengambilan halaman (`MAX_PAGE_REDIRECTS = 2`), dengan validasi ulang URL dan DNS pinning di setiap hop.
  - Respons upstream dengan `Content-Type` `text/html`, `application/xhtml+xml`, atau `text/plain` ditolak sebagai file media, dan seluruh respons file menyertakan `X-Content-Type-Options: nosniff` serta nama file hasil sanitasi (`sanitizeFilename`, `createUniqueArchiveFilename`).
- **Batas Ukuran**:
  - Request JSON dibatasi `INSTAGRAM_MAX_REQUEST_BODY_BYTES` (default `262144` byte).
  - HTML halaman Instagram dibatasi `8 MB` (`8 * 1024 * 1024` byte) pada `decodeContentStream`.
  - Ukuran per file media dibatasi `INSTAGRAM_MAX_FILE_BYTES` (default `52428800` byte), diperiksa baik dari header `Content-Length` maupun total byte aktual yang mengalir di stream.
  - Total ukuran media sebelum arsip ZIP dibatasi `INSTAGRAM_ZIP_MAX_TOTAL_BYTES` (default `209715200` byte), dan jumlah file unik dibatasi `zipMaxFiles`.
- **Batas Konkurensi dan Timeout**:
  - Pembuatan ZIP membatasi koneksi upstream paralel melalui `p-limit` sesuai `INSTAGRAM_ZIP_CONCURRENCY` (`1..10`, default `3`).
  - Pengayaan shortcode profil membatasi proses hingga `24` item dengan konkurensi `5` (`ENRICH_CONCURRENCY = 5`) dan timeout per post `6500 ms`.
  - Timeout terpisah diterapkan untuk fetch (`INSTAGRAM_FETCH_TIMEOUT_MS`), download (`INSTAGRAM_DOWNLOAD_TIMEOUT_MS`), dan ZIP (`INSTAGRAM_ZIP_TIMEOUT_MS`), seluruhnya mendukung pembatalan klien melalui `AbortSignal`.

## Panduan Deployment

1. **Pilih runtime Node.js**: seluruh route handler di `app/api/instagram/*` bergantung pada modul standar Node.js (`node:https`, `node:dns`, `node:net`, `node:crypto`, `node:module`, `node:stream`, `node:zlib`) dan tidak kompatibel dengan Edge Runtime.
2. **Konfigurasi variabel environment produksi**:
   - Atur `INSTAGRAM_TOKEN_SECRET` ke nilai acak kriptografis minimal 32 byte yang berbeda di setiap environment.
   - Atur `INSTAGRAM_MEDIA_ALLOWED_DOMAINS` sesuai domain CDN yang diperlukan (default contoh: `dl.snapcdn.app,i.snapcdn.app,cdninstagram.com,fbcdn.net`).
   - Pastikan nilai `INSTAGRAM_ZIP_MAX_FILES` tidak memicu error konfigurasi di `app/lib/instagram/security.ts`.
3. **Pertimbangkan batas waktu dan memori platform**:
   - Pada platform serverless (misalnya Vercel), atur durasi timeout fungsi yang memadai karena pengambilan profil lengkap (`INSTAGRAM_FETCH_TIMEOUT_MS` default `45000 ms`) dan pengaliran ZIP (`INSTAGRAM_ZIP_TIMEOUT_MS` default `120000 ms`) dapat berlangsung puluhan detik.
   - Untuk unduhan ZIP berkapasitas besar atau beban tinggi, disarankan menjalankan server Node.js persisten (VM/VPS/container) di balik reverse proxy (seperti Nginx) dengan timeout proxy yang lebih besar daripada `INSTAGRAM_ZIP_TIMEOUT_MS`.
4. **Build dan jalankan**:

   ```bash
   cd my-project
   npm ci
   npm run build
   npm run start
   ```

## Pemecahan Masalah

- **Error `500 SERVER_CONFIG_ERROR` saat memanggil API**:
  - Pastikan `.env.local` (atau environment server) mendefinisikan `INSTAGRAM_TOKEN_SECRET` minimal 32 byte dengan minimal 8 karakter unik dan tidak memakai teks placeholder.
  - Pastikan `INSTAGRAM_MEDIA_ALLOWED_DOMAINS` terisi domain valid tanpa wildcard atau IP.
  - Periksa apakah `INSTAGRAM_ZIP_MAX_FILES` di `.env.local` bernilai di luar rentang validasi pada `app/lib/instagram/security.ts`.
- **Error `401 TOKEN_EXPIRED` saat pratinjau atau unduhan**:
  - Token sudah melewati `INSTAGRAM_TOKEN_TTL_SECONDS` (default 600 detik). Tekan tombol `Ambil Ulang Media` di UI atau panggil ulang `POST /api/instagram/fetch`.
- **Error `403 PRIVATE_ACCOUNT` atau `502 INSTAGRAM_LOGIN_REQUIRED`**:
  - Akun target bersifat privat atau Instagram memberlakukan pembatasan login pada halaman profil. Aplikasi hanya mendukung akun publik; coba tunggu beberapa saat atau gunakan URL langsung Reels/Post/Stories publik.
- **Error `403 MEDIA_URL_NOT_ALLOWED` atau `MEDIA_IP_BLOCKED`**:
  - Domain CDN upstream tidak tercantum di `INSTAGRAM_MEDIA_ALLOWED_DOMAINS` atau hasil resolusi DNS mengarah ke alamat IP terlarang/privat.
- **`npm run build` (Turbopack) gagal di Windows dengan error `Failed to write app endpoint /page` atau `node process exited before we could connect to it`**:
  - Hapus folder `.next` yang tersisa dari sesi `next dev` sebelumnya lalu jalankan ulang `npm run build`, atau jalankan `npx next build --webpack` sebagai alternatif.

## Batasan Hukum dan Penggunaan Wajar

- Aplikasi ini dibuat semata-mata untuk mengambil dan mengunduh media dari akun Instagram yang bersifat **publik**.
- Dilarang menggunakan aplikasi ini untuk mengakses, mengupayakan bypass, atau mengambil konten dari akun **privat**, konten berbatas autentikasi, atau melakukan pengumpulan data otomatis berskala besar yang melanggar Ketentuan Layanan Instagram maupun hukum yang berlaku.
- Seluruh hak cipta dan kepemilikan konten tetap berada pada pembuat konten atau pemegang hak cipta asli. Pengguna bertanggung jawab penuh atas penggunaan media yang diunduh, termasuk memperoleh izin dari pemilik hak apabila digunakan di luar batas penggunaan wajar (*fair use*) atau arsip pribadi yang sah.
