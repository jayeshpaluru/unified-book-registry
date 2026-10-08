# Unified Book Registry

A personal library and reader for books, comics and manga, with multiple catalogs rather than a Gutenberg-only bookshelf.

| Section | Catalogs |
| --- | --- |
| Books | Imported Anna’s Archive metadata, Project Gutenberg, your files |
| Comics | Imported Anna’s Archive comic metadata, Internet Archive, your files |
| Manga | MangaDex, MangaUpdates scanlation releases, Comikey, WEBTOON, TorBox, your files |

Catalog entries can be saved alongside imported files in your Library. Each section remembers your selected catalog. Comikey and WEBTOON open their official readers; chapter access may include free previews and paid unlocks. MangaUpdates tracks releases and credited groups, not chapter files. Batcave is an external link only: automated catalog access is blocked and its backend has not been connected.

## Hosted static app

Site: <https://jayeshpaluru.github.io/unified-book-registry/>

The hosted app does not need a localhost server. GitHub Actions builds browser-searchable public catalog snapshots and deploys an explicitly allowlisted static artifact to Pages. Catalogs refresh daily and on main-branch updates. A checked-in public metadata snapshot provides a fallback if a provider is temporarily unavailable. Coverage and freshness are shown in Settings; these snapshots are not entire provider databases.

Your imported books, reading progress and library live in this browser’s IndexedDB. They are not uploaded to GitHub, TorBox or another server. Metadata backups do not contain imported file blobs, separately imported Anna metadata, OPDS passwords or credential settings.

### Live catalogs and TorBox authentication

`TORBOX_API_KEY` is stored only as a GitHub Actions repository secret, never in the site. TorBox does not currently permit direct browser API calls from this Pages origin. Live MangaDex/MangaUpdates requests and private TorBox operations therefore run as on-demand Actions jobs, without a separately deployed backend.

1. Create a **fine-grained GitHub token** scoped to this repository, with **Actions: read/write** and **Contents: read**.
2. In **Settings → Live catalogs and TorBox**, connect that token as the repository owner. Do not enter the TorBox key in the app.
3. Use the **TorBox** tab in Books, Comics or Manga to load your private files, generate a fresh download link, or import a compatible file into the local reader. Use **Search full provider live** for manga searches beyond the static snapshot.

The GitHub token stays only in memory and is forgotten when the tab reloads. Each request creates a non-exportable RSA-OAEP private key in the browser. Jobs encrypt responses using AES-256-GCM and wrap the AES key with that session’s public key. Only ciphertext is committed to the `runtime-results` branch; no private account responses or download links are logged or published in the site. Generated response files are bounded to 50 and one day of retention; encrypted history can remain in Git. Result contents expire after 45 minutes. Keep repository write access restricted to trusted people.

Expect workflow startup time, usually 20–60 seconds; this is a batch-job runtime, not a low-latency API. Expired file links must be regenerated. Browser imports are capped at 200 MB in the TorBox UI; larger files should be downloaded and imported manually. File-server browser restrictions may also require manual import. CBR/RAR must be converted to CBZ. TorBox cache retention is not permanent storage; use AirLock where available and retain independent backups.

### Download controls and PWA icon

Local library files can be downloaded unchanged from their item menu. MangaDex-hosted chapters can be saved as ordered CBZ archives with source/group credits; external chapters keep their source-reader links. Public, unrestricted Internet Archive PDF, EPUB and CBZ files are offered where available. Publisher catalogs are not treated as universally free downloads.

TorBox files offer a fresh direct link and a bounded browser download. Anna records retain safe torrent mappings when present in the imported metadata. Inspect a mapped torrent before explicitly submitting it to TorBox: **the whole torrent is queued, not just one book**. Packs may contain many files, account limits still apply, and nested archives require manual extraction. Matching existing TorBox files uses a record hash or mapped file path, not guessed titles. Records without torrent mappings still link to their Anna source page. Metadata never guarantees an available book download or bypasses protected endpoints.

The generated black-and-white open-book icon is used for the favicon, Apple touch icon and installable PWA, including an opaque maskable version. The original master and exact built-in image-generation prompt are preserved in [icons/registry-master-v2.png](icons/registry-master-v2.png) and [tools/icon-spec.json](tools/icon-spec.json). Tests verify dimensions and mask-safe padding.

### Anna’s Archive status

The Anna catalog is **not populated with the complete shadow-library database**. The verified TorBox connection contained no combined aarecord metadata files. The full official derived metadata torrent is much larger than a Pages site; Pages can publish at most 1 GB. A complete mirrored search index needs separate storage, rather than hiding a partial mirror behind a claim of full coverage.

The static app supports streaming **local browser imports** of combined aarecord/Elasticsearch JSON, JSONL/NDJSON and gzip. Metadata stays on that device. Official line-delimited `aarecords__N.json.gz` files are recognized despite their `.json` extension. Zstandard and raw SQL/AAC conversion require the local CLI. No Anna search page crawling, protected download endpoints or book-file mirroring is performed.

The explicitly started local acquisition below imports the complete selected combined-record snapshot into SQLite as each shard finishes. This is separate from the hosted Pages catalog: neither the 167 GB source files nor the complete SQLite index is published by the Pages build. The browser now has a range-reading SQLite search path for a finalized index stored in TorBox. The real full index still has to finish importing, be exported, transferred to storage and verified against TorBox's browser/CORS behavior; the current Pages snapshot must not be described as the full shadow library.

### Search a full metadata index without a separately hosted API

Once all 12 shards have finished importing locally:

```sh
npm run export:anna-index
```

This makes a separate, consistent `data/anna-index/<snapshot>-<unique>/anna-index.sqlite` and checksum receipt. It does not upload anything or modify the live source. It refuses incomplete shard checkpoints, verifies SQLite integrity and requires enough disk for another database copy plus a 100 GiB reserve. Interrupted exports leave a partial copy, never a completed receipt. Keep the finalized index immutable. The complete selected snapshot is historical metadata, not a live view of all current Anna records or a guarantee of available book downloads.

After that finalized file has been placed in your TorBox storage, connect the GitHub session and use **Settings → Full Anna metadata index (TorBox storage) → Load Anna index files from TorBox**. Select the SQLite index to connect it for this tab. Books/Comics Anna searches will then query the connected index; disconnecting returns them to the Pages snapshot and browser imports. The UI distinguishes complete selected snapshots from partial indexes.

TorBox is not a general writable object store: its [T3 integration is read-only](https://support.torbox.app/en/articles/15531689-torbox-t3). Ingesting a newly generated index requires an accessible source Web Download or a seeded torrent. The exporter does not open a public file server/tunnel, seed a new torrent or automatically queue the generated file in TorBox. Keep independent backups and check available AirLock space before relying on cache retention.

The browser queries SQLite FTS5 in an isolated worker and reads only requested HTTP byte ranges through a bounded in-memory cache. It does not download the complete database, copy it into IndexedDB, require SharedArrayBuffer/COOP/COEP, or send the TorBox API key to the browser. Temporary index links and page bytes are not persisted in backups or the service-worker cache. Reconnect after reload or file-link expiry. Each query has a 30-second/range-byte budget; broad searches may need more specific terms.

**TorBox file-server compatibility has not yet been verified with a real private index.** The server must return `206`, allow browser CORS range requests, expose `Content-Range` and serve the uncompressed finalized SQLite file. Full-file `200` responses, hidden/malformed range headers, changed files and incomplete bodies are rejected. If that compatibility fails, this specific browser-only search path will not work; it is not silently replaced with a partial catalog or an unapproved API bridge. Uploading/seeding a real generated index and publishing private encrypted runtime results are separate operations, not performed by the exporter or deployment workflow.

The MIT-licensed browser runtime is built from pinned [wa-sqlite](https://github.com/rhashimoto/wa-sqlite) source with FTS5 enabled; [vendor/wa-sqlite/PROVENANCE.json](vendor/wa-sqlite/PROVENANCE.json) records source/compiler pins and asset hashes. The public-source compiler workflow receives no TorBox credentials.

## Run locally

Requires Node.js 24 or newer. There are no npm packages to install.

```sh
cd /Users/jsp/code/unified-book-registry
npm start
```

Open <http://127.0.0.1:8787>. Localhost defaults to the optional companion API, keeping Anna’s metadata in `data/anna.sqlite` and forwarding the manga providers’ JSON API requests. MangaDex page images load from its image servers. To test the hosted mode locally, choose **Static catalog + GitHub Actions** in Settings.

If you serve the app separately, set **Settings → Catalog service URL** to the running service’s address. The static app and imported-file readers still work without the companion service. The service binds to loopback by default and has no authentication; do not expose it publicly.

## Import Anna’s Archive metadata

The full Anna’s Archive database and book files are **not bundled or automatically downloaded**. See the [official datasets page](https://annas-archive.pk/datasets) for metadata sources. The [official FAQ](https://annas-archive.pk/faq) describes local metadata databases for custom search; this app does not depend on a scraping endpoint or private download API.

### Acquire the 167 GB combined-record snapshot locally

Requires `aria2c` (Homebrew path `/opt/homebrew/bin/aria2c`, or set `UBR_ARIA2_PATH`). Inspect the pinned plan first, then explicitly start acquisition:

```sh
npm run acquire:anna -- --plan
npm run acquire:anna
```

This selects only the 12 `aarecords__N.json.gz` shards from the official **20260208** derived metadata torrent: **166,956,687,557 bytes** compressed. The other files in the roughly 1.52 TB bundle are not selected, and no book payloads are acquired. The script verifies the pinned size, safe paths and enough free disk for the compressed data plus a 100 GiB reserve. BitTorrent necessarily communicates with peers; upload is limited to 256 KiB/s.

Downloads and local progress live under `data/anna-metadata/20260208/`; completed shards stream directly into `data/anna.sqlite` without writing decompressed copies. The downloader uses a loopback-only RPC endpoint with an ephemeral credential. A process-checked lock prevents duplicate acquisition. Stop with Ctrl-C and rerun the same command to resume existing pieces and completed-shard checkpoints. Committed import batches survive interruption; an unfinished shard can be reimported safely. A safety stop occurs before consuming the last 100 GiB of disk. Keep the source files and SQLite database out of Git and retain independent backups.

### Import an existing dump

Use **Settings → Import Anna’s Archive metadata**, or the streaming command-line importer:

```sh
npm run import:anna -- /path/to/metadata.jsonl.zst
npm run import:anna -- --db /path/to/anna.sqlite /path/to/metadata.jsonl.gz
```

Supported input:

- Combined aarecord JSON documents containing `id` and `file_unified_data`.
- Elasticsearch/elasticdump documents containing `_id` and `_source`, or a JSON search response containing `hits.hits`.
- JSONL/NDJSON, including Elasticsearch bulk action lines, optionally compressed with gzip (`.gz`) or Zstandard (`.zst`).
- JSON documents or arrays up to 32 MB. Use JSONL for large exports.

Raw collection-specific AAC records, SQL dumps and Elasticsearch snapshot directories require conversion to the combined aarecord format first. Imports deduplicate by record ID; reimporting updates metadata and the search index. Each batch is atomic. If a later batch fails, earlier committed batches remain; rerunning the import is safe.

Search supports title, author and ISBN. Records marked as comics appear in Comics; other records appear in Books. Saving an Anna’s entry saves a catalog reference with an Anna’s Archive link, not the book file. To read a file here, import it through Library.

Identified combined records with no title are retained: an alternate title, original filename basename or clearly marked untitled fallback is used, so their author/ISBN metadata remains searchable. The selected 20260208 dump contains download-availability flags but those flags are not torrent mappings. Only explicit safe `torrent_paths` included in an imported record enable the mapped-torrent controls; missing paths are not guessed from collection names or flags.

The Anna’s SQLite catalog is separate from the browser’s library. Library metadata backups include saved catalog entries, MangaDex chapters, progress and settings, but not imported file blobs or the Anna’s SQLite database. Back up those files separately.

## Configuration

| Environment variable | Default / purpose |
| --- | --- |
| `UBR_ANNA_DB` | Project-relative `data/anna.sqlite`; shared by the service and CLI importer |
| `UBR_CATALOG_PORT` | `8787` |
| `UBR_CATALOG_HOST` | `127.0.0.1` |
| `UBR_ALLOWED_ORIGINS` | Extra comma-separated exact app origins; localhost origins are already allowed |

Change the preferred MangaDex translation language in Settings or the chapter list. MangaDex availability depends on the provider; unavailable chapters are omitted and externally hosted chapters open at their source. Provider errors and rate limits offer an explicit retry instead of automatically repeating failed requests.

## Verify

```sh
npm test
npm run test:browser
npm run sync:catalog
npm run build
npm run test:site
npm run test:index
```

The browser tests use Chromium (or `UBR_BROWSER_PATH`) and isolated profiles. `test:browser` covers the companion mode and reader. `test:site` tests the real static artifact at a nested Pages path, metadata imports, library migration, credential-safe backups, public provider tabs, actual fixture file/CBZ saves, PWA icons and mocked encrypted TorBox jobs. `test:index` uses real WASM SQLite over a disposable cross-origin range server, checks title/author/ISBN and comic searches, exercises mocked TorBox index selection, measures fetched bytes and verifies CORS/whole-file rejection. Downloads go only into disposable test profiles; no private account operation runs. Set `UBR_SITE_URL` to test the actual deployed site. None of these tests changes your personal library or catalog.

Deployment uses `.github/workflows/pages.yml`. The read-only TorBox authentication and official metadata-cache checks are separate manual workflows. The count-only authentication check looks for combined Anna metadata in torrents, Web Downloads and Usenet; inaccessible collections are reported as unchecked, not empty. `node tools/runtime-smoke.mjs` uses authenticated `gh` CLI access to verify an actual encrypted TorBox list round trip without printing private file names or links. `node tools/save-catalog-snapshot.mjs` updates the checked-in public fallback after a successful catalog build.
