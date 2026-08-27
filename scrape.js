#!/usr/bin/env bun

import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

const BASE = "https://cses.fi";
const INDEX_URL = `${BASE}/problemset/`;

const args = parseArgs(Bun.argv.slice(2));

const OUT = args.out ?? "cses-statements";
const DELAY_MS = Number(args.delay ?? 300);
const TIMEOUT_MS = Number(args.timeout ?? 20_000);
const RETRIES = Number(args.retries ?? 5);
const LIMIT = args.limit == null ? Infinity : Number(args.limit);
const REFRESH = Boolean(args.refresh);
const SAVE_SOURCE = Boolean(args["save-source"]);
const DOWNLOAD_ASSETS = !args["no-assets"];

const ONLY_IDS = args.ids
  ? new Set(
      String(args.ids)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    )
  : null;

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0 Safari/537.36 CSES-Statement-Archiver/1.0";

let lastRequestAt = 0;

await main();

async function main() {
  await mkdir(OUT, { recursive: true });

  console.log("Fetching CSES problem index...");

  const indexHtml = await fetchText(INDEX_URL);
  const discovered = discoverProblems(indexHtml);

  if (discovered.length < 250) {
    throw new Error(
      `Only discovered ${discovered.length} tasks. ` +
        "Refusing to continue because the CSES markup may have changed.",
    );
  }

  let problems = discovered;

  if (ONLY_IDS) {
    problems = problems.filter((p) => ONLY_IDS.has(p.id));
  }

  problems = problems.slice(0, LIMIT);

  if (ONLY_IDS) {
    const found = new Set(problems.map((p) => p.id));
    const missing = [...ONLY_IDS].filter((id) => !found.has(id));

    if (missing.length) {
      throw new Error(
        `Task IDs not found in CSES index: ${missing.join(", ")}`,
      );
    }
  }

  console.log(
    `Discovered ${discovered.length} tasks; scraping ${problems.length}.`,
  );

  const results = [];
  const failures = [];

  for (let i = 0; i < problems.length; i++) {
    const problem = problems[i];

    const prefix =
      `[${String(i + 1).padStart(String(problems.length).length)}` +
      `/${problems.length}]`;

    try {
      const result = await scrapeProblem(problem, prefix);
      results.push(result);
    } catch (err) {
      const failure = {
        id: problem.id,
        title: problem.title,
        category: problem.category,
        url: problem.url,
        error: err instanceof Error ? err.stack ?? err.message : String(err),
      };

      failures.push(failure);

      console.error(
        `${prefix} FAILED ${problem.id} ${problem.title}: ` +
          failure.error.split("\n")[0],
      );
    }
  }

  await writeJson(join(OUT, "_index.json"), {
    generatedAt: new Date().toISOString(),
    source: INDEX_URL,
    discoveredCount: discovered.length,
    requestedCount: problems.length,
    successCount: results.length,
    failureCount: failures.length,
    problems: results,
  });

  await writeJson(join(OUT, "_failures.json"), failures);
  await writeReadme(results, failures);

  console.log();
  console.log(
    `Done: ${results.length} succeeded, ${failures.length} failed.`,
  );
  console.log(`Output: ${OUT}`);

  if (failures.length) {
    process.exitCode = 1;
  }
}

function discoverProblems(html) {
  const $ = cheerio.load(html);

  const problems = [];
  const seen = new Set();

  let category = "Uncategorized";

  $("h2, a[href*='/problemset/task/']").each((_, el) => {
    if (el.tagName === "h2") {
      category = cleanText($(el).text()) || category;
      return;
    }

    const href = $(el).attr("href");

    if (!href) {
      return;
    }

    const match = href.match(/\/problemset\/task\/(\d+)\/?$/);

    if (!match) {
      return;
    }

    const id = match[1];

    if (seen.has(id)) {
      return;
    }

    const title = cleanText($(el).text());

    if (!title) {
      return;
    }

    seen.add(id);

    problems.push({
      id,
      title,
      category,
      url: new URL(href, BASE).href,
    });
  });

  return problems;
}

async function scrapeProblem(problem, prefix) {
  const categorySlug = slug(problem.category);
  const titleSlug = slug(problem.title);

  const stem = `${problem.id}-${titleSlug}`;
  const dir = join(OUT, categorySlug);

  const mdPath = join(dir, `${stem}.md`);
  const htmlPath = join(dir, `${stem}.html`);
  const jsonPath = join(dir, `${stem}.json`);
  const sourcePath = join(dir, `${stem}.source.html`);

  await mkdir(dir, { recursive: true });

  if (
    !REFRESH &&
    (await exists(mdPath)) &&
    (await exists(jsonPath))
  ) {
    const metadata = JSON.parse(await readFile(jsonPath, "utf8"));

    console.log(
      `${prefix} cached ${problem.id} ${problem.title}`,
    );

    return metadata;
  }

  console.log(
    `${prefix} fetch  ${problem.id} ${problem.title}`,
  );

  const sourceHtml = await fetchText(problem.url);

  if (SAVE_SOURCE) {
    await writeFile(sourcePath, sourceHtml, "utf8");
  }

  const parsed = extractStatement(sourceHtml, problem);

  if (!parsed.title || parsed.title.length < 2) {
    throw new Error("Could not extract a plausible problem title.");
  }

  if (
    !parsed.statementHtml ||
    cleanText(
      cheerio.load(parsed.statementHtml).text(),
    ).length < 30
  ) {
    throw new Error("Extracted statement is suspiciously short.");
  }

  let statementHtml = parsed.statementHtml;

  if (DOWNLOAD_ASSETS) {
    statementHtml = await localizeImages(
      statementHtml,
      problem,
      dir,
    );
  } else {
    statementHtml = absolutizeLinks(
      statementHtml,
      problem.url,
    );
  }

  const markdownBody = htmlToMarkdown(statementHtml);

  const markdown = buildMarkdown({
    problem,
    parsed,
    markdownBody,
  });

  const metadata = {
    id: problem.id,
    title: parsed.title,
    category: problem.category,
    url: problem.url,
    timeLimit: parsed.timeLimit,
    memoryLimit: parsed.memoryLimit,
    markdown: posix(relative(OUT, mdPath)),
    html: posix(relative(OUT, htmlPath)),
    sourceHtml: SAVE_SOURCE
      ? posix(relative(OUT, sourcePath))
      : null,
    sha256: sha256(markdown),
    scrapedAt: new Date().toISOString(),
  };

  await writeFile(mdPath, markdown, "utf8");

  await writeFile(
    htmlPath,
    formatStandaloneHtml(parsed.title, statementHtml),
    "utf8",
  );

  await writeJson(jsonPath, metadata);

  return metadata;
}

function extractStatement(sourceHtml, problem) {
  const $ = cheerio.load(sourceHtml);

  const content =
    $(".content").first().length
      ? $(".content").first()
      : $("main").first().length
        ? $("main").first()
        : $("body").first();

  if (!content.length) {
    throw new Error("Could not find page content.");
  }

  const title =
    cleanText(content.find("h1").first().text()) ||
    cleanText($("h1").first().text()) ||
    problem.title;

  const allText = cleanText(content.text());

  const timeLimit =
    matchFirst(
      allText,
      /Time\s*limit:\s*([0-9.]+\s*(?:s|sec|seconds?))/i,
    ) ??
    matchFirst(
      allText,
      /Time\s*limit:\s*([^|]+?)(?=Memory\s*limit:|$)/i,
    );

  const memoryLimit =
    matchFirst(
      allText,
      /Memory\s*limit:\s*([0-9.]+\s*(?:MB|MiB|GB|GiB))/i,
    ) ??
    matchFirst(
      allText,
      /Memory\s*limit:\s*([^|]+?)(?=\s{2,}|$)/i,
    );

  const root = content.clone();

  root
    .find(
      [
        "script:not([type^='math/tex'])",
        "style",
        "noscript",
        "form",
        "button",
        ".nav",
        ".navigation",
        ".task-nav",
        ".tabs",
        ".sidebar",
        ".footer",
        ".footer-links",
        ".account",
        ".menu",
      ].join(","),
    )
    .remove();

  root.find("h1").first().remove();

  root.find("ul, ol, div").each((_, el) => {
    const txt = cleanText($(el).text());
    const links = $(el).find("a");

    if (
      links.length >= 2 &&
      /^Task\s+Statistics$/i.test(txt)
    ) {
      $(el).remove();
    }
  });

  const tailHeading = root
    .find("h4")
    .filter((_, el) => {
      const txt = cleanText($(el).text());

      return (
        txt === problem.category ||
        /Problems$/i.test(txt) ||
        /Techniques$/i.test(txt)
      );
    })
    .first();

  if (tailHeading.length) {
    tailHeading.nextAll().remove();
    tailHeading.remove();
  }

  let statementNodes = null;

  const limitNode = findLimitContainer(root, $);

  if (limitNode?.length) {
    statementNodes = limitNode.nextAll().toArray();
  }

  let statementHtml;

  if (statementNodes?.length) {
    statementHtml = statementNodes
      .map((el) => $.html(el))
      .join("\n");
  } else {
    statementHtml = root.html() ?? "";
  }

  {
    const $$ = cheerio.load(
      `<div id="statement-root">${statementHtml}</div>`,
    );

    const r = $$("#statement-root");

    r.find("li, p, div").each((_, el) => {
      const txt = cleanText($$(el).text());

      if (
        /^Time\s*limit:/i.test(txt) ||
        /^Memory\s*limit:/i.test(txt)
      ) {
        const childBlockText = $$(el)
          .children()
          .map((__, child) =>
            cleanText($$(child).text()),
          )
          .get();

        if (
          $$(el).is("li") ||
          childBlockText.every((t) =>
            /^Time\s*limit:|^Memory\s*limit:/i.test(t),
          )
        ) {
          $$(el).remove();
        }
      }
    });

    statementHtml = r.html() ?? statementHtml;
  }

  statementHtml = statementHtml.trim();

  return {
    title,
    timeLimit: timeLimit
      ? cleanText(timeLimit)
      : null,
    memoryLimit: memoryLimit
      ? cleanText(memoryLimit)
      : null,
    statementHtml,
  };
}

function findLimitContainer(root, $) {
  let timeEl = null;
  let memoryEl = null;

  root.find("*").each((_, el) => {
    const own = ownText($, el);

    if (
      !timeEl &&
      /^Time\s*limit:/i.test(own)
    ) {
      timeEl = $(el);
    }

    if (
      !memoryEl &&
      /^Memory\s*limit:/i.test(own)
    ) {
      memoryEl = $(el);
    }
  });

  if (!timeEl || !memoryEl) {
    return null;
  }

  const timeNode = timeEl[0];
  const memNode = memoryEl[0];

  let cur = timeNode;

  while (cur?.parent) {
    const parent = cur.parent;

    if (parent.type !== "tag") {
      break;
    }

    if (containsNode(parent, memNode)) {
      const wrapped = $(parent);

      if (
        !wrapped.is(".content, main, body, html")
      ) {
        return wrapped;
      }

      break;
    }

    cur = parent;
  }

  if (
    timeEl.parent().length &&
    timeEl.parent()[0] === memoryEl.parent()[0]
  ) {
    return timeEl.parent();
  }

  return null;
}

function containsNode(root, target) {
  if (root === target) {
    return true;
  }

  for (const child of root.children ?? []) {
    if (containsNode(child, target)) {
      return true;
    }
  }

  return false;
}

function ownText($, el) {
  return cleanText(
    $(el)
      .contents()
      .filter((_, n) => n.type === "text")
      .map((_, n) => n.data ?? "")
      .get()
      .join(" "),
  );
}

async function localizeImages(
  html,
  problem,
  problemDir,
) {
  const $ = cheerio.load(
    `<div id="statement-root">${html}</div>`,
    null,
    false,
  );

  const root = $("#statement-root");

  const assetDir = join(
    problemDir,
    "assets",
    problem.id,
  );

  let madeAssetDir = false;

  const images = root.find("img").toArray();

  for (let i = 0; i < images.length; i++) {
    const img = $(images[i]);

    const rawSrc = img.attr("src");

    if (!rawSrc) {
      continue;
    }

    const url = new URL(
      rawSrc,
      problem.url,
    );

    const name = safeAssetName(url, i);

    if (!madeAssetDir) {
      await mkdir(assetDir, {
        recursive: true,
      });

      madeAssetDir = true;
    }

    const diskPath = join(
      assetDir,
      name,
    );

    try {
      const bytes = await fetchBytes(
        url.href,
      );

      await writeFile(
        diskPath,
        bytes,
      );

      img.attr(
        "src",
        `assets/${problem.id}/${name}`,
      );
    } catch (err) {
      console.warn(
        `  warning: image ${url.href} not downloaded: ` +
          (err instanceof Error
            ? err.message
            : String(err)),
      );

      img.attr(
        "src",
        url.href,
      );
    }

    if (img.attr("srcset")) {
      img.removeAttr("srcset");
    }
  }

  root.find("a[href]").each((_, el) => {
    const a = $(el);
    const href = a.attr("href");

    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("mailto:")
    ) {
      return;
    }

    try {
      a.attr(
        "href",
        new URL(
          href,
          problem.url,
        ).href,
      );
    } catch {}
  });

  return root.html() ?? html;
}

function absolutizeLinks(
  html,
  baseUrl,
) {
  const $ = cheerio.load(
    `<div id="statement-root">${html}</div>`,
    null,
    false,
  );

  const root = $("#statement-root");

  root.find("a[href]").each((_, el) => {
    const a = $(el);
    const href = a.attr("href");

    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("mailto:")
    ) {
      return;
    }

    try {
      a.attr(
        "href",
        new URL(
          href,
          baseUrl,
        ).href,
      );
    } catch {}
  });

  root.find("img[src]").each((_, el) => {
    const img = $(el);

    try {
      img.attr(
        "src",
        new URL(
          img.attr("src"),
          baseUrl,
        ).href,
      );
    } catch {}
  });

  return root.html() ?? html;
}

function htmlToMarkdown(html) {
  const $ = cheerio.load(
    `<div id="statement-root">${html}</div>`,
    null,
    false,
  );

  const root = $("#statement-root");

  const tex = new Map();

  let texId = 0;

  function protect(value) {
    const token =
      `CSESXTEXXTOKENX${texId++}X`;

    tex.set(token, value);

    return token;
  }

  root
    .find("script[type^='math/tex']")
    .each((_, el) => {
      const script = $(el);

      const raw =
        script.html() ?? "";

      const display =
        /mode\s*=\s*display/i.test(
          script.attr("type") ?? "",
        );

      script.replaceWith(
        protect(
          display
            ? `$$${raw}$$`
            : `$${raw}$`,
        ),
      );
    });

  root
    .find(".math, .MathJax_Preview")
    .each((_, el) => {
      const node = $(el);

      const raw =
        node.attr("data-tex") ??
        node.attr("data-latex") ??
        node.text();

      if (!raw.trim()) {
        return;
      }

      const value = normalizeTex(
        raw,
        node.hasClass("display"),
      );

      node.replaceWith(
        protect(value),
      );
    });

  root
    .find("*")
    .addBack()
    .contents()
    .each((_, node) => {
      if (
        node.type !== "text" ||
        !node.data
      ) {
        return;
      }

      let s = node.data;

      s = s.replace(
        /\\\[([\s\S]*?)\\\]/g,
        (m) => protect(m),
      );

      s = s.replace(
        /\\\(([\s\S]*?)\\\)/g,
        (m) => protect(m),
      );

      s = s.replace(
        /\$\$([\s\S]*?)\$\$/g,
        (m) => protect(m),
      );

      s = s.replace(
        /(^|[\s(])\$([^$\n]+?)\$(?=$|[\s).,;:!?])/g,
        (_, pre, body) =>
          `${pre}${protect(`$${body}$`)}`,
      );

      node.data = s;
    });

  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
  });

  td.use(gfm);

  td.addRule("exact-pre", {
    filter: (node) =>
      node.nodeName === "PRE",

    replacement(_content, node) {
      const text = node.textContent
        .replace(/\r\n?/g, "\n")
        .replace(/^\n/, "")
        .replace(/\n$/, "");

      let fence = "```";

      while (text.includes(fence)) {
        fence += "`";
      }

      return (
        `\n\n${fence}\n` +
        `${text}\n` +
        `${fence}\n\n`
      );
    },
  });

  td.addRule("line-break", {
    filter: "br",
    replacement: () => "  \n",
  });

  td.addRule("remove-empty-ui", {
    filter(node) {
      return (
        node.nodeType === 1 &&
        ["BUTTON", "FORM"].includes(
          node.nodeName,
        )
      );
    },

    replacement: () => "",
  });

  let md = td.turndown(
    root.html() ?? "",
  );

  for (const [token, value] of tex) {
    md = md
      .split(token)
      .join(value);
  }

  return normalizeMarkdown(md);
}

function normalizeTex(
  raw,
  forceDisplay = false,
) {
  const s = raw.trim();

  if (
    (
      s.startsWith("\\(") &&
      s.endsWith("\\)")
    ) ||
    (
      s.startsWith("\\[") &&
      s.endsWith("\\]")
    ) ||
    (
      s.startsWith("$") &&
      s.endsWith("$")
    )
  ) {
    return s;
  }

  return forceDisplay
    ? `$$${s}$$`
    : `$${s}$`;
}

function buildMarkdown({
  problem,
  parsed,
  markdownBody,
}) {
  const frontmatter = [
    "---",
    `cses_id: ${problem.id}`,
    `title: ${yamlString(parsed.title)}`,
    `category: ${yamlString(problem.category)}`,
    `url: ${yamlString(problem.url)}`,
    parsed.timeLimit
      ? `time_limit: ${yamlString(parsed.timeLimit)}`
      : null,
    parsed.memoryLimit
      ? `memory_limit: ${yamlString(parsed.memoryLimit)}`
      : null,
    "---",
    "",
  ]
    .filter((x) => x != null)
    .join("\n");

  const limits = [];

  if (parsed.timeLimit) {
    limits.push(
      `**Time limit:** ${parsed.timeLimit}`,
    );
  }

  if (parsed.memoryLimit) {
    limits.push(
      `**Memory limit:** ${parsed.memoryLimit}`,
    );
  }

  return [
    frontmatter,
    `# ${parsed.title}`,
    "",
    limits.length
      ? limits.join("  \n")
      : "",
    limits.length ? "" : "",
    markdownBody,
    "",
  ]
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trimEnd() + "\n";
}

function formatStandaloneHtml(
  title,
  body,
) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>

<style>
body {
  max-width: 900px;
  margin: 3rem auto;
  padding: 0 1rem;
  font: 16px/1.55 system-ui, sans-serif;
}

pre {
  overflow-x: auto;
  padding: 1rem;
  background: #f5f5f5;
}

code {
  font-family:
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
}

img {
  max-width: 100%;
  height: auto;
}

table {
  border-collapse: collapse;
}

td,
th {
  border: 1px solid #bbb;
  padding: .35rem .55rem;
}
</style>

<script>
window.MathJax = {
  tex: {
    inlineMath: [
      ["$", "$"],
      ["\\\\(", "\\\\)"]
    ],
    displayMath: [
      ["$$", "$$"],
      ["\\\\[", "\\\\]"]
    ]
  }
};
</script>

<script
  defer
  src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"
></script>
</head>

<body>
<h1>${escapeHtml(title)}</h1>

${body}
</body>
</html>
`;
}

async function writeReadme(
  results,
  failures,
) {
  const grouped = new Map();

  for (const p of results) {
    if (!grouped.has(p.category)) {
      grouped.set(
        p.category,
        [],
      );
    }

    grouped
      .get(p.category)
      .push(p);
  }

  const out = [
    "# CSES Problem Statements",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `Successfully archived **${results.length}** problems.`,
  ];

  if (failures.length) {
    out.push(
      `Failed: **${failures.length}** ` +
        "(see `_failures.json`).",
    );
  }

  out.push(
    "",
    "The Markdown files preserve TeX source so they can be rendered with a MathJax/KaTeX-capable Markdown renderer.",
    "",
  );

  for (const [category, items] of grouped) {
    out.push(
      `## ${category}`,
      "",
    );

    for (const p of items) {
      out.push(
        `- [${p.id} — ${p.title}](${encodeURI(p.markdown)})`,
      );
    }

    out.push("");
  }

  await writeFile(
    join(OUT, "README.md"),
    out.join("\n") + "\n",
    "utf8",
  );
}

async function fetchText(url) {
  const bytes = await request(url);

  return new TextDecoder(
    "utf-8",
  ).decode(bytes);
}

async function fetchBytes(url) {
  return await request(url);
}

async function request(url) {
  let lastError;

  for (
    let attempt = 0;
    attempt <= RETRIES;
    attempt++
  ) {
    try {
      await throttle();

      const controller =
        new AbortController();

      const timer = setTimeout(
        () => controller.abort(),
        TIMEOUT_MS,
      );

      let res;

      try {
        res = await fetch(url, {
          headers: {
            "User-Agent":
              USER_AGENT,

            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

            "Accept-Language":
              "en-US,en;q=0.9",
          },

          redirect: "follow",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        return new Uint8Array(
          await res.arrayBuffer(),
        );
      }

      const retryable =
        res.status === 429 ||
        res.status >= 500;

      if (!retryable) {
        throw new Error(
          `HTTP ${res.status} ${res.statusText} for ${url}`,
        );
      }

      const retryAfter =
        parseRetryAfter(
          res.headers.get(
            "retry-after",
          ),
        );

      throw new RetryableHttpError(
        `HTTP ${res.status} ${res.statusText} for ${url}`,
        retryAfter,
      );
    } catch (err) {
      lastError = err;

      if (attempt === RETRIES) {
        break;
      }

      const retryAfter =
        err instanceof RetryableHttpError
          ? err.retryAfterMs
          : null;

      const backoff =
        retryAfter ??
        Math.min(
          30_000,
          800 * 2 ** attempt,
        ) +
          Math.floor(
            Math.random() * 300,
          );

      console.warn(
        `  retry ${attempt + 1}/${RETRIES} after ${backoff}ms: ` +
          (err instanceof Error
            ? err.message
            : String(err)),
      );

      await sleep(backoff);
    }
  }

  throw (
    lastError ??
    new Error(
      `Failed to fetch ${url}`,
    )
  );
}

class RetryableHttpError extends Error {
  constructor(
    message,
    retryAfterMs = null,
  ) {
    super(message);

    this.retryAfterMs =
      retryAfterMs;
  }
}

async function throttle() {
  const now = Date.now();

  const wait = Math.max(
    0,
    DELAY_MS -
      (now - lastRequestAt),
  );

  if (wait) {
    await sleep(wait);
  }

  lastRequestAt = Date.now();
}

function parseRetryAfter(value) {
  if (!value) {
    return null;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds)) {
    return Math.max(
      0,
      seconds * 1000,
    );
  }

  const date = Date.parse(value);

  if (Number.isFinite(date)) {
    return Math.max(
      0,
      date - Date.now(),
    );
  }

  return null;
}

function parseArgs(argv) {
  const out = {};

  for (
    let i = 0;
    i < argv.length;
    i++
  ) {
    const arg = argv[i];

    if (!arg.startsWith("--")) {
      continue;
    }

    const eq = arg.indexOf("=");

    if (eq !== -1) {
      out[arg.slice(2, eq)] =
        arg.slice(eq + 1);

      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];

    if (
      next != null &&
      !next.startsWith("--")
    ) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }

  return out;
}

function safeAssetName(
  url,
  index,
) {
  let name = basename(
    url.pathname,
  );

  if (
    !name ||
    name === "/"
  ) {
    name =
      `image-${index + 1}`;
  }

  name = name
    .replace(
      /[^a-zA-Z0-9._-]+/g,
      "-",
    )
    .replace(
      /^-+|-+$/g,
      "",
    );

  if (!extname(name)) {
    const hinted =
      url.searchParams.get(
        "format",
      );

    if (
      hinted &&
      /^[a-zA-Z0-9]+$/.test(
        hinted,
      )
    ) {
      name += `.${hinted}`;
    }
  }

  if (!name) {
    name =
      `image-${index + 1}`;
  }

  return (
    `${String(index + 1).padStart(2, "0")}-` +
    name
  );
}

function slug(s) {
  return (
    cleanText(s)
      .normalize("NFKD")
      .replace(
        /[\u0300-\u036f]/g,
        "",
      )
      .toLowerCase()
      .replace(
        /&/g,
        " and ",
      )
      .replace(
        /[^a-z0-9]+/g,
        "-",
      )
      .replace(
        /^-|-$/g,
        "",
      ) ||
    "uncategorized"
  );
}

function cleanText(s) {
  return String(s ?? "")
    .replace(
      /\u00a0/g,
      " ",
    )
    .replace(
      /\s+/g,
      " ",
    )
    .trim();
}

function matchFirst(s, re) {
  return (
    s.match(re)?.[1]?.trim() ??
    null
  );
}

function normalizeMarkdown(s) {
  return s
    .replace(
      /\r\n?/g,
      "\n",
    )
    .replace(
      /[ \t]+\n/g,
      "\n",
    )
    .replace(
      /\n{4,}/g,
      "\n\n\n",
    )
    .trim();
}

function yamlString(s) {
  return JSON.stringify(
    String(s),
  );
}

function sha256(s) {
  return createHash(
    "sha256",
  )
    .update(s)
    .digest("hex");
}

function posix(s) {
  return s
    .split("\\")
    .join("/");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll(
      "&",
      "&amp;",
    )
    .replaceAll(
      "<",
      "&lt;",
    )
    .replaceAll(
      ">",
      "&gt;",
    )
    .replaceAll(
      '"',
      "&quot;",
    );
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(
  path,
  value,
) {
  await writeFile(
    path,
    JSON.stringify(
      value,
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms),
  );
}
