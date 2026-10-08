# Unified Book Registry

A personal library and reader for books, comics and manga, with multiple catalogs rather than a Gutenberg-only bookshelf.

| Section | Catalogs |
| --- | --- |
| Books | Imported Anna’s Archive metadata, Project Gutenberg, your files |
| Comics | Imported Anna’s Archive comic metadata, Internet Archive, your files |
| Manga | MangaDex chapters, MangaUpdates scanlation releases, your files |

Catalog entries can be saved alongside imported files in your Library. MangaDex chapters open in the built-in reader with source and scanlation-group credits. MangaUpdates provides release tracking and group links, not chapter files. Each section remembers your selected catalog.

## Run locally

Requires Node.js 24 or newer. There are no npm packages to install.

```sh
cd /Users/jsp/code/unified-book-registry
npm start
```

Open <http://127.0.0.1:8787>. This serves both the app and its local catalog API. The service is required for Anna’s Archive searches, MangaDex and MangaUpdates; it keeps Anna’s metadata in `data/anna.sqlite` and forwards the manga providers’ JSON API requests. MangaDex page images load from its image servers.

If you serve the app separately, set **Settings → Catalog service URL** to the running service’s address. The static app and imported-file readers still work without the companion service. The service binds to loopback by default and has no authentication; do not expose it publicly.

## Import Anna’s Archive metadata

The full Anna’s Archive database and book files are **not bundled or automatically downloaded**. See the [official datasets page](https://annas-archive.pk/datasets) for metadata sources. The [official FAQ](https://annas-archive.pk/faq) describes local metadata databases for custom search; this app does not depend on a scraping endpoint or private download API.

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
```

The browser smoke test uses a detected Chromium browser (or `UBR_BROWSER_PATH`), an isolated browser profile, temporary data and mocked manga APIs. It covers catalog browsing, chapter reading, scanlation credits, metadata upload, library backup/restore and the offline app shell. It does not change your library or catalog.
