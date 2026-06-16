// Public type surface for turbo-crawl. Tracks SPEC.md; pragmatic (DOM nodes are
// opaque `object` — turbo-dom owns those types).

export declare const version: string;

// --- net ---------------------------------------------------------------------
export interface FetchResult {
  html: string;
  finalUrl: string;
  status: number;
  headers: Headers;
  redirected: boolean;
}
export interface FetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  signal?: AbortSignal;
  jar?: CookieJar;
  maxBytes?: number;
  allowNonHtml?: boolean;
  fetch?: typeof fetch;
}
export declare function fetchHtml(url: string, opts?: FetchOptions): Promise<FetchResult>;
export declare class HttpError extends Error {
  code: string;
}

// --- cookies / robots --------------------------------------------------------
export declare class CookieJar {
  setFromResponse(url: string, setCookieLines: string[], now?: number): void;
  cookieHeader(url: string, now?: number): string;
  cookiesFor(url: string, now?: number): object[];
  readonly size: number;
}
export declare function parseRobots(text: string): object[];
export declare class RobotsCache {
  constructor(opts?: {
    fetchText?: (url: string) => Promise<{ status: number; text: string }>;
    ttlMs?: number;
  });
  allowed(url: string, ua?: string, now?: number): Promise<boolean>;
  crawlDelay(origin: string, ua?: string, now?: number): Promise<number | undefined>;
}

// --- extraction --------------------------------------------------------------
export interface InteractiveElement {
  i: number;
  tag: string;
  role: string;
  name: string;
  value?: string;
  href?: string;
  type?: string;
  visible: boolean;
  jsHandler: boolean;
  ref: object;
}
export declare function interactiveElements(
  document: object,
  baseUrl?: string,
  window?: object,
): InteractiveElement[];
export declare function links(document: object, baseUrl?: string): string[];
export declare function isVisible(el: object, window: object): boolean;
export declare function markdown(document: object, baseUrl?: string): string;
export declare function text(root: object): string;
export interface AxNode {
  role: string;
  name?: string;
  value?: string;
  children?: AxNode[];
}
export declare function accessibilityTree(document: object): AxNode;

export interface FieldSpec {
  selector?: string;
  attr?: "text" | "html" | string;
  type?: "string" | "number" | "boolean";
  list?: boolean;
  fields?: Record<string, FieldSpec>;
  transform?: (value: unknown) => unknown;
}
export type Schema = Record<string, FieldSpec> | { fields: Record<string, FieldSpec> };
export declare function extractSchema(document: object, schema: Schema, baseUrl?: string): object;

// --- actions -----------------------------------------------------------------
export declare function fillValue(el: object, value: unknown): void;
export declare function serializeForm(form: object, submitter?: object): [string, string][];
export declare function buildSubmission(
  form: object,
  baseUrl?: string,
  submitter?: object,
): { method: "GET" | "POST"; url: string; body?: string; contentType?: string };

// --- url ---------------------------------------------------------------------
export declare function resolve(base: string, href: string): string | null;
export declare function isHttpUrl(url: string): boolean;
export declare function canonicalize(url: string): string | null;

// --- detection ---------------------------------------------------------------
export declare function detectJsRequired(
  document: object,
  opts?: { minTextLength?: number; minScripts?: number },
): { jsRequired: boolean; textLength: number; scripts: number; reason: string };

// --- Page --------------------------------------------------------------------
export interface NavResult {
  status: number;
  url: string;
  title: string;
}
export declare class Page {
  constructor(opts?: { fetchHtml?: typeof fetchHtml; jar?: CookieJar });
  readonly url: string | null;
  readonly status: number;
  readonly document: object;
  readonly window: object;
  readonly cookies: CookieJar;
  goto(url: string, opts?: FetchOptions): Promise<NavResult>;
  follow(href: string, opts?: FetchOptions): Promise<NavResult>;
  title(): string;
  interactiveElements(): InteractiveElement[];
  links(): string[];
  markdown(): string;
  html(): string;
  text(): string;
  accessibilityTree(): AxNode;
  extract(schema: Schema): object;
  click(i: number, opts?: FetchOptions): Promise<NavResult>;
  fill(i: number, value: unknown): { ok: true };
  submit(i?: number, opts?: FetchOptions): Promise<NavResult>;
}

// --- Frontier / Crawler ------------------------------------------------------
export declare class Frontier {
  add(url: string, depth?: number): boolean;
  requeue(item: { url: string; depth: number }): void;
  next(): { url: string; canon: string; depth: number } | undefined;
  seen(url: string): boolean;
  readonly pending: number;
  readonly size: number;
}

export interface CrawlRecord {
  url: string;
  status: number;
  depth: number;
  lane?: "A" | "B";
  title?: string;
  links?: string[];
  view?: { interactiveElements: InteractiveElement[]; markdown?: string };
  extracted?: object;
  error?: string;
}
export interface CrawlerOptions {
  start?: string | string[];
  maxPages?: number;
  maxDepth?: number;
  concurrency?: number;
  perHostConcurrency?: number;
  politenessMs?: number;
  sameHostOnly?: boolean;
  userAgent?: string;
  retryBudget?: number;
  backoffMs?: number;
  robots?: RobotsCache;
  schema?: Schema;
  markdown?: boolean;
  view?: boolean;
  allow?: (url: string) => boolean;
  fetchHtml?: typeof fetchHtml;
  fallback?: typeof fetchHtml;
  jar?: CookieJar;
  signal?: AbortSignal;
}
export declare class Crawler {
  constructor(options?: CrawlerOptions);
  options: CrawlerOptions;
  [Symbol.asyncIterator](): AsyncIterator<CrawlRecord>;
}
