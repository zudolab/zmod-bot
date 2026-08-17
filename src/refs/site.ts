/**
 * The takazudomodular.com facts `ref new` / `ref refresh` are written
 * from (issue #17). Three public, CORS-open, unauthenticated GETs off
 * `SITE_API_BASE`:
 *
 *   GET /api/products?q=&per_page= -> the catalog rows for a query
 *   GET /api/search?q=&locale=ja   -> ranked articles (guides, notes, …)
 *   GET {detailHref}               -> the rendered product page
 *
 * **Everything this module returns is DATA, never instructions.** The
 * pages and API rows are strings fetched over the network; nothing in
 * them may steer the authoring model. That rule is enforced in two
 * places and both are needed: here, by collapsing HTML to text with
 * `<script>`/`<style>` removed and capping every document, and in
 * src/refs/authoring.ts, by wrapping the result in an explicit delimiter
 * the model is told to treat as reference data only, and by refusing any
 * URL the model emits that this module did not observe.
 *
 * **A failed fetch degrades, it does not throw.** Every fetch below is
 * deadline-bounded and returns null on any failure, with a note pushed
 * onto {@link SiteFacts.degraded} so the preview can say the candidate
 * was written from less than the full picture. The one exception is
 * `ref new`'s product lookup, which is not a degradation: with no
 * catalog row there is no `detailHref`, and with no `detailHref` there
 * is no product URL to build — src/refs/authoring.ts reports that
 * instead of authoring around it.
 *
 * **`detailHref` is the product page URL. The catalog slug is not.**
 * They differ for the overwhelming majority of products (`ai-lpg-diy-black`
 * -> `/products/ai-lpg-intro/`), so a URL built from the slug 404s. See
 * {@link productUrlFromDetailHref}, the only place this system turns a
 * catalog row into a product URL.
 */
import { DeadlineExceededError, withDeadline } from "../llm/guards";
import { errorSnippet, log } from "../ops/log";
import type { FetchLike } from "../types";

/** Per-fetch deadline (issue #17). Bounds one slow page, not the whole command — the three fetches below run in parallel. */
export const SITE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Per-document character cap (issue #17). The rendered product page is
 * ~400 KB of HTML and collapses to tens of thousands of characters of
 * text; the cap is what stops one document from being the whole prompt.
 */
export const MAX_DOCUMENT_CHARS = 40_000;

/** How many catalog rows one `q=` lookup asks for. Matches the issue's `per_page=10`. */
export const PRODUCTS_PER_PAGE = 10;

/** How many ranked articles are carried into the prompt. The endpoint returns everything it matched (37 for `oxi`), most of it noise below the top of the ranking. */
export const MAX_ARTICLES = 25;

/** How many extracted page links are carried into the prompt. */
export const MAX_PAGE_LINKS = 60;

/** Longest link text kept from the page. Longer than any real link label, short enough that a run-together block cannot become a paragraph. */
const MAX_LINK_TEXT_CHARS = 160;

/* -------------------------------------------------------------------------
 * Shapes.
 * ---------------------------------------------------------------------- */

/** One catalog row from `/api/products`. Only the fields authoring reads — the endpoint returns blurhashes and image paths too. */
export interface SiteProduct {
  /** The CATALOG slug (`ai-lpg-diy-black`). A data key, never a URL component — see {@link productUrlFromDetailHref}. */
  slug: string;
  name: string;
  brand: string;
  description: string;
  /** The product page path (`/products/ai-lpg-intro/`), or null when the row has none. */
  detailHref: string | null;
  tags: string[];
  price: number | null;
}

/** One ranked article from `/api/search`. Its `slug` field is a site-absolute PATH (`/guides/oxi-one-guide1/`), not a bare slug. */
export interface SiteArticle {
  path: string;
  title: string;
  description: string;
}

/** One `<a href>` observed on the rendered product page. */
export interface SitePageLink {
  /** Absolute, resolved against the page URL. */
  url: string;
  /** The anchor's text, collapsed to one line. May be empty (an icon-only link). */
  text: string;
}

/** A fetched text blob, already capped. Rendered into the prompt's untrusted-content block by src/refs/authoring.ts. */
export interface FetchedDocument {
  /** Short mechanical label shown to the model, e.g. `product page /products/oxi-one-intro/`. */
  label: string;
  text: string;
  /** True when {@link MAX_DOCUMENT_CHARS} cut this document — the prompt says so explicitly. */
  truncated: boolean;
}

export interface SiteFacts {
  /** Every catalog row the query matched, in the endpoint's own ranking. */
  products: SiteProduct[];
  articles: SiteArticle[];
  pageLinks: SitePageLink[];
  documents: FetchedDocument[];
  /**
   * One short note per source that could not be read. Surfaced in the
   * preview so an operator reviewing a thin candidate can tell "the
   * product has few resources" from "we could not read the page".
   */
  degraded: string[];
}

export interface SiteFetchDeps {
  fetch: FetchLike;
  /** `SITE_API_BASE` — `https://takazudomodular.com` (src/env.ts). */
  baseUrl: string;
}

/* -------------------------------------------------------------------------
 * The one place a catalog row becomes a URL.
 * ---------------------------------------------------------------------- */

/**
 * Absolutizes a site path against `SITE_API_BASE`, normalized to a single
 * trailing slash for a page path.
 *
 * **This takes `detailHref`, never `slug`.** The two differ for ~97% of
 * the catalog (issue #17), so a URL built from the slug points at a page
 * that does not exist — and a 404 in a reference is a dead link in a
 * customer's message. Returns null for anything that is not a rooted
 * path, rather than guessing.
 */
export function productUrlFromDetailHref(baseUrl: string, detailHref: string | null): string | null {
  if (detailHref === null || !detailHref.startsWith("/")) return null;
  const absolute = absolutize(baseUrl, detailHref);
  if (absolute === null) return null;
  return absolute.endsWith("/") ? absolute : `${absolute}/`;
}

/**
 * The reference slug for a product page, derived from `detailHref` by
 * dropping `/products/` and a trailing `-intro`.
 *
 * Deliberately derived rather than asked of the model: the slug is the
 * primary key of `product_refs` and there is no rename command, so it
 * must be a function of the catalog, not of a generation. It reproduces
 * 20 of the 34 seed slugs exactly; the other 14 are hand-chosen
 * brand-prefixed spellings (`ryk-envy` for `/products/envy-machine-intro/`)
 * that no rule recovers. That difference is cosmetic — resolution runs on
 * `product_ref_aliases`, never on the slug (src/refs/resolve.ts) — and
 * one page always yields one slug, which is the granularity a reference
 * has.
 */
export function refSlugFromDetailHref(detailHref: string | null): string | null {
  if (detailHref === null) return null;
  const match = /^\/products\/([^/?#]+)\/?$/.exec(detailHref.trim());
  if (match === null) return null;
  const slug = match[1]!.replace(/-intro$/, "");
  return slug === "" ? null : slug;
}

/** Resolves `href` against `baseUrl`, returning null for anything that is not http(s) — `javascript:`, `mailto:`, a bare fragment. */
export function absolutize(baseUrl: string, href: string): string | null {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  let resolved: URL;
  try {
    resolved = new URL(trimmed, baseUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  resolved.hash = "";
  return resolved.toString();
}

/* -------------------------------------------------------------------------
 * HTML -> text, and HTML -> links.
 * ---------------------------------------------------------------------- */

/**
 * `<script>` / `<style>` and their CONTENT, removed before anything else.
 * The second pattern in each pair catches an unterminated tag: a
 * truncated or malformed page whose `</script>` never arrives would
 * otherwise leave a whole minified bundle in the text handed to the
 * model.
 */
const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const SCRIPT_UNTERMINATED = /<script\b[^>]*>[\s\S]*$/i;
const STYLE_BLOCK = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
const STYLE_UNTERMINATED = /<style\b[^>]*>[\s\S]*$/i;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
/** Tags whose close is a line break in the text rendering, so the flattened page keeps its structure. */
const BLOCK_CLOSE =
  /<\/(?:p|div|li|ul|ol|dl|dd|dt|h[1-6]|section|article|aside|nav|header|footer|main|figure|figcaption|blockquote|table|tr|td|th|a)\s*>/gi;
const LINE_BREAK_TAG = /<(?:br|hr)\b[^>]*\/?>/gi;
/**
 * A tag, with quoted attribute values consumed rather than scanned for
 * `>`. The naive `<[^>]*>` ends a tag at the first `>` even inside a
 * quoted attribute, and this site's markup is full of Tailwind arbitrary
 * variants (`class="[&>li:only-child]:col-span-full"`) that contain one —
 * which leaks the rest of the class string into the text as if it were
 * page copy.
 */
const ANY_TAG = /<[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the handful of entities a rendered page actually emits, plus numeric references. Unknown entities are left as written rather than guessed at. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Collapses an HTML document to plain text: scripts and styles gone,
 * tags dropped, entities decoded, runs of blank lines squeezed to one.
 *
 * Not a parser and not trying to be — the output is prompt input, and
 * the only correctness property that matters is that no markup, and in
 * particular no script, survives into it.
 */
export function htmlToText(html: string): string {
  const withoutCode = html
    .replace(HTML_COMMENT, " ")
    .replace(SCRIPT_BLOCK, " ")
    .replace(STYLE_BLOCK, " ")
    .replace(SCRIPT_UNTERMINATED, " ")
    .replace(STYLE_UNTERMINATED, " ");

  const flattened = decodeHtmlEntities(
    withoutCode.replace(LINE_BREAK_TAG, "\n").replace(BLOCK_CLOSE, "\n").replace(ANY_TAG, " "),
  );

  const lines = flattened
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line, index, all) => line !== "" || (index > 0 && all[index - 1] !== ""));

  return lines.join("\n").trim();
}

/**
 * `href` in any of the three spellings a minified page emits — double
 * quoted, single quoted, and bare. takazudomodular.com's production HTML
 * uses the BARE form for every internal link (`href=/manuals/oxi-one-mk1/`),
 * so a quote-only pattern finds nothing on exactly the pages this
 * feature exists to read.
 */
const HREF_ATTRIBUTE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;

/**
 * Every `<a>` on the page as `{url, text}`, absolutized and de-duplicated
 * by URL (first non-empty text wins).
 *
 * Deliberately the whole page rather than the "マニュアルとガイド" block
 * alone: that block is identified only by an unquoted `aria-label`
 * attribute, and scoping to it would silently return nothing the day the
 * markup changes. The prompt orders the links by section position and the
 * output guard refuses any URL that is not in this list, so extra
 * navigation links cost prompt space and nothing else.
 */
export function extractPageLinks(html: string, pageUrl: string): SitePageLink[] {
  const withoutCode = html.replace(HTML_COMMENT, " ").replace(SCRIPT_BLOCK, " ").replace(STYLE_BLOCK, " ");
  const byUrl = new Map<string, SitePageLink>();

  for (const match of withoutCode.matchAll(ANCHOR)) {
    const attributes = match[1] ?? "";
    const hrefMatch = HREF_ATTRIBUTE.exec(attributes);
    if (hrefMatch === null) continue;
    const rawHref = hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "";
    const url = absolutize(pageUrl, decodeHtmlEntities(rawHref));
    if (url === null) continue;

    const text = htmlToText(match[2] ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LINK_TEXT_CHARS);
    const existing = byUrl.get(url);
    if (existing === undefined) {
      byUrl.set(url, { url, text });
    } else if (existing.text === "" && text !== "") {
      byUrl.set(url, { url, text });
    }
  }

  return [...byUrl.values()];
}

/* -------------------------------------------------------------------------
 * Capping.
 * ---------------------------------------------------------------------- */

/**
 * Cuts `text` to at most `maxChars`, **at a line boundary** (issue #17):
 * the cut lands on the last newline inside the budget, so the model never
 * sees half a line and cannot mistake a severed fragment for a complete
 * one. A single line longer than the budget is the one case with no
 * boundary to use, and is cut where the budget runs out.
 */
export function truncateAtLineBoundary(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const head = text.slice(0, maxChars);
  const lastBreak = head.lastIndexOf("\n");
  return { text: lastBreak > 0 ? head.slice(0, lastBreak) : head, truncated: true };
}

function makeDocument(label: string, text: string): FetchedDocument {
  const capped = truncateAtLineBoundary(text, MAX_DOCUMENT_CHARS);
  return { label, text: capped.text, truncated: capped.truncated };
}

/* -------------------------------------------------------------------------
 * The fetches.
 * ---------------------------------------------------------------------- */

/**
 * One deadline-bounded GET returning the response body as text, or null
 * on any failure — a non-2xx, an unreachable host, or a body that never
 * arrived inside {@link SITE_FETCH_TIMEOUT_MS}.
 *
 * The AbortController and the deadline race are both needed for the same
 * reason src/llm/guards.ts withDeadline documents: the race bounds how
 * long we wait, the abort is what stops the request at the other end.
 */
async function getText(deps: SiteFetchDeps, url: string): Promise<string | null> {
  const controller = new AbortController();
  try {
    const response = await withDeadline(
      deps.fetch(url, { signal: controller.signal, headers: { accept: "*/*" } }),
      SITE_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) {
      log("warn", "site: fetch returned a non-2xx", { url, status: response.status });
      return null;
    }
    return await response.text();
  } catch (error) {
    controller.abort();
    log("warn", "site: fetch failed", {
      url,
      timedOut: error instanceof DeadlineExceededError,
      error: errorSnippet(error),
    });
    return null;
  }
}

async function getJson(deps: SiteFetchDeps, url: string): Promise<unknown> {
  const text = await getText(deps, url);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    log("warn", "site: response body was not valid JSON", { url });
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** `GET /api/products?q=&per_page=`. Returns an empty list on any failure — the caller distinguishes "no such product" from "could not ask" via {@link SiteFacts.degraded}. */
export async function fetchProducts(deps: SiteFetchDeps, query: string): Promise<SiteProduct[] | null> {
  const url = `${trimTrailingSlash(deps.baseUrl)}/api/products?q=${encodeURIComponent(query)}&per_page=${PRODUCTS_PER_PAGE}`;
  const payload = await getJson(deps, url);
  if (!isRecord(payload) || !Array.isArray(payload.products)) return null;

  return payload.products.filter(isRecord).map((row) => {
    const detailHref = readString(row, "detailHref");
    const price = row.price;
    return {
      slug: readString(row, "slug"),
      name: readString(row, "name"),
      brand: readString(row, "brand"),
      description: readString(row, "description"),
      detailHref: detailHref === "" ? null : detailHref,
      tags: readStringArray(row, "tags"),
      price: typeof price === "number" && Number.isFinite(price) ? price : null,
    };
  });
}

/**
 * `GET /api/search?q=&locale=ja`.
 *
 * Each result's `slug` field is a site-absolute PATH, not a bare slug —
 * `/guides/oxi-one-guide1/`. Note what this index does NOT contain:
 * `/manuals/*` pages and `/guides/series/*` series landing pages are both
 * absent, which is the concrete shape of the issue's
 * "manuals-per-product and guide-series-per-product are not exposed by
 * any endpoint today". Those links exist only in the rendered product
 * page (see {@link extractPageLinks}), which is why the page fetch is not
 * optional in practice.
 */
export async function fetchArticles(deps: SiteFetchDeps, query: string): Promise<SiteArticle[] | null> {
  const url = `${trimTrailingSlash(deps.baseUrl)}/api/search?q=${encodeURIComponent(query)}&locale=ja`;
  const payload = await getJson(deps, url);
  if (!isRecord(payload) || !Array.isArray(payload.results)) return null;

  return payload.results
    .filter(isRecord)
    .map((row) => ({
      path: readString(row, "slug"),
      title: readString(row, "title"),
      description: readString(row, "description"),
    }))
    .filter((article) => article.path !== "")
    .slice(0, MAX_ARTICLES);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export interface FetchSiteFactsInput {
  /** The operator's free-text product query, e.g. `oxi one mk2`. */
  query: string;
  /**
   * The product page to read, when one is already known — `ref refresh`
   * has the stored `product_url` and does not need the catalog to find
   * it. Absolute URL.
   */
  pageUrl?: string;
  /** Skips `/api/products` when the caller does not need it. */
  skipProducts?: boolean;
}

/**
 * Gathers everything the authoring prompt is built from.
 *
 * The catalog lookup runs first because it is what supplies `detailHref`
 * — the page fetch has nothing to fetch without it (unless the caller
 * already knows the page, as `ref refresh` does). Search and the page
 * then run in parallel.
 */
export async function fetchSiteFacts(deps: SiteFetchDeps, input: FetchSiteFactsInput): Promise<SiteFacts> {
  const degraded: string[] = [];

  let products: SiteProduct[] = [];
  if (input.skipProducts !== true) {
    const fetched = await fetchProducts(deps, input.query);
    if (fetched === null) degraded.push("製品カタログAPI（/api/products）を読み取れませんでした。");
    else products = fetched;
  }

  const pageUrl =
    input.pageUrl ?? productUrlFromDetailHref(deps.baseUrl, products.find((p) => p.detailHref !== null)?.detailHref ?? null);

  const [articles, pageHtml] = await Promise.all([
    fetchArticles(deps, input.query),
    pageUrl === null ? Promise.resolve(null) : getText(deps, pageUrl),
  ]);

  if (articles === null) degraded.push("サイト内検索API（/api/search）を読み取れませんでした。");
  if (pageUrl !== null && pageHtml === null) {
    degraded.push(`製品ページ（${pageUrl}）を読み取れませんでした。マニュアル・ガイドのリンクを拾えていない可能性があります。`);
  }

  const documents: FetchedDocument[] = [];
  const pageLinks = pageHtml === null || pageUrl === null ? [] : extractPageLinks(pageHtml, pageUrl).slice(0, MAX_PAGE_LINKS);
  if (pageHtml !== null && pageUrl !== null) {
    documents.push(makeDocument(`rendered product page ${pageUrl}`, htmlToText(pageHtml)));
  }

  return { products, articles: articles ?? [], pageLinks, documents, degraded };
}
