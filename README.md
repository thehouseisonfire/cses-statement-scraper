# cses-statement-scraper

Archives every problem statement from [CSES Problem Set](https://cses.fi/problemset/) to clean Markdown + HTML, preserving LaTeX and localizing images.

Built with Bun, `cheerio` and `turndown`. Be polite to CSES — default 300 ms between requests with retries and backoff.

## Requirements

- [Bun](https://bun.sh/) ≥ 1.0

## Install

```bash
bun install
```

## Usage

```bash
# scrape all ~300 problems to ./cses-statements
bun run scrape

# via direct run
bun run scrape.js -- --limit 10 --out ./out --delay 500
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--out <dir>` | `cses-statements` | Output directory |
| `--delay <ms>` | `300` | Delay between requests |
| `--timeout <ms>` | `20000` | Fetch timeout |
| `--retries <n>` | `5` | Retries on 429/5xx with backoff |
| `--limit <n>` | all | Scrape only first *n* problems |
| `--ids <a,b,c>` | — | Only scrape given task IDs (e.g. `1068,1069`) |
| `--refresh` | off | Re-fetch even if `md`+`json` already exist |
| `--save-source` | off | Also save raw `.source.html` |
| `--no-assets` | off | Don't download images; absolutize URLs instead |

Examples:

```bash
bun run scrape.js -- --ids 1068,1083 --save-source
bun run scrape.js -- --limit 5 --no-assets --delay 1000
```

## Output

```
cses-statements/
├── _index.json      # index of all scraped problems
├── _failures.json   # failures, if any
├── README.md        # auto-generated index by category
└── <category-slug>/
    ├── 1068-weird-algorithm.md
    ├── 1068-weird-algorithm.html
    ├── 1068-weird-algorithm.json
    └── assets/1068/01-*.png  # when --no-assets not set
```

Each `.md` has YAML frontmatter (`cses_id`, `title`, `category`, `url`, `time_limit`, `memory_limit`) and preserves TeX (`$...$`, `$$...$$`, `\(...\)`) for MathJax/KaTeX. Standalone `.html` includes MathJax.

## Notes

- Rethrows if the index yields < 250 problems (markup change guard).
- Cached runs skip existing `md`+`json` unless `--refresh` is set.
- Output dir (`cses-statements/`) is git-ignored; commit it only if you want a snapshot.

## License

Licensed under either of

- Apache License, Version 2.0 ([`LICENSE-APACHE`](LICENSE-APACHE))
- MIT license ([`LICENSE-MIT`](LICENSE-MIT))

at your option.
