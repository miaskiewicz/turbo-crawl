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
  discovered?: string[];
  /** true when the server answered 304 and the cached body was reused. */
  notModified?: boolean;
}
export interface FetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  signal?: AbortSignal;
  jar?: CookieJar;
  cache?: ResponseCache;
  /** undici Agent (HTTP/2 + DNS cache) used as the fetch dispatcher. */
  dispatcher?: unknown;
  maxBytes?: number;
  maxRedirects?: number;
  allowNonHtml?: boolean;
  fetch?: typeof fetch;
}
export declare function fetchHtml(url: string, opts?: FetchOptions): Promise<FetchResult>;
export declare class HttpError extends Error {
  code: string;
}

/** Conditional-request cache: stores ETag/Last-Modified + body for 304 revalidation. */
export declare class ResponseCache {
  validators(url: string): Record<string, string>;
  store(url: string, headers: Headers, html: string, status: number): void;
  body(url: string): string;
  readonly size: number;
}

/** A dns.lookup-compatible function with a per-host TTL cache. */
export declare function cachedLookup(opts?: {
  ttlMs?: number;
  now?: () => number;
  base?: (...args: unknown[]) => void;
}): (hostname: string, options: unknown, callback: (...args: unknown[]) => void) => void;
/** An undici Agent with HTTP/2 + a DNS cache, for use as a fetch `dispatcher`. */
export declare function createDispatcher(opts?: { allowH2?: boolean; dnsTtlMs?: number }): unknown;

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
  ref: WeakRef<object>;
}
export declare function interactiveElements(
  document: object,
  baseUrl?: string,
  window?: object,
): InteractiveElement[];
export declare function links(document: object, baseUrl?: string): string[];

export interface QueryResult {
  node: object | null;
  html: string | null;
  text: string;
  value?: string;
}
export interface QueryOptions {
  type?: "auto" | "css" | "xpath";
  first?: boolean;
}
export declare function query(
  root: object,
  selector: string,
  opts?: QueryOptions,
): QueryResult[] | QueryResult | null;
export declare function evaluateXPath(
  root: object,
  expr: string,
): { nodes: object[] } | { values: string[] };
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
export declare function ariaSnapshot(root: object): string;
export declare function matchesAriaSnapshot(root: object, expected: string): boolean;

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

export interface HydrationState {
  next: object | null;
  jsonLd: object[];
  json: Record<string, object>;
  states: Record<string, object>;
}
export declare function extractHydrationState(document: object): HydrationState;

export interface JsRendererOptions {
  /** "secure" (isolated-vm + WASM; open-web/hostile) | "fast" (in-proc vm; local/trusted). */
  mode?: "secure" | "fast";
  fetchHtml?: typeof fetchHtml;
  timeoutMs?: number;
  settleMs?: number;
  settleRounds?: number;
  /** Wall-clock cap on the post-script settle/hydration phase (ms, default 5000). */
  renderDeadlineMs?: number;
  memoryLimit?: number;
  onRequest?: (url: string) => void;
}
export interface JsRenderer {
  fetchHtml: typeof fetchHtml;
  /** Re-enter the live render heap; appends the post-eval DOM to history. */
  eval(code: string, ...args: unknown[]): Promise<unknown>;
  /** Most recent DOM snapshot (per nav + per mutating eval). */
  latestDom(): Promise<string>;
  /** All DOM snapshots in order. */
  domHistory(): Promise<string[]>;
  close(): Promise<void>;
}
export declare function jsRenderer(opts?: JsRendererOptions): JsRenderer;

// --- batch -------------------------------------------------------------------
export type BatchMode = "no-js" | "fast" | "secure";
export type BatchView = "markdown" | "text" | "html" | "links" | "interactive" | "ax" | "hydration";
export interface BatchOptions {
  /** "no-js" (Lane A static, default) | "fast" (in-proc JS) | "secure" (isolate JS). */
  mode?: BatchMode;
  /** Per-URL view to return as `data` (default "markdown"). */
  view?: BatchView;
  /** Parallelism — honored only for "no-js" (JS modes run sequentially). */
  concurrency?: number;
  /** Underlying network fetcher (injectable for tests / Lane B). */
  fetchHtml?: typeof fetchHtml;
}
export interface BatchResult {
  url: string;
  ok: boolean;
  status?: number;
  finalUrl?: string;
  title?: string;
  data?: unknown;
  error?: string;
}
export declare function batch(urls: string[], opts?: BatchOptions): Promise<BatchResult[]>;

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

export interface ByOptions {
  name?: string | RegExp;
  exact?: boolean;
}
export declare class Locator {
  elements(): object[];
  count(): number;
  first(): Locator;
  last(): Locator;
  nth(n: number): Locator;
  filter(opts?: { hasText?: string }): Locator;
  locator(selector: string): Locator;
  textContent(): string;
  innerText(): string;
  innerHTML(): string;
  getAttribute(name: string): string | null;
  inputValue(): string;
  isVisible(): boolean;
  isEnabled(): boolean;
  isChecked(): boolean;
  isEditable(): boolean;
  isEmpty(): boolean;
  isFocused(): boolean;
  ariaRole(): string;
  accessibleName(): string;
  accessibleDescription(): string;
  accessibleErrorMessage(): string;
  selectedValues(): string[];
  jsProperty(name: string): unknown;
  cssValue(name: string): string;
  viewportRatio(): number;
  allTextContents(): string[];
  click(opts?: FetchOptions): Promise<NavResult>;
  fill(value: unknown): this;
  type(value: unknown): this;
  check(): this;
  uncheck(): this;
  selectOption(value: string): this;
  press(): Promise<NavResult>;
  waitFor(opts?: {
    state?: "attached" | "detached" | "visible" | "hidden";
    timeout?: number;
  }): Promise<void>;
}
export interface NavigatorOverrides {
  userAgent?: string;
  platform?: string;
  vendor?: string;
  language?: string;
  languages?: string[];
  [key: string]: unknown;
}
export interface PageOptions {
  fetchHtml?: typeof fetchHtml;
  jar?: CookieJar;
  cache?: ResponseCache;
  dispatcher?: unknown;
  userAgent?: string;
  navigator?: NavigatorOverrides;
}
export declare class Page {
  constructor(opts?: PageOptions);
  readonly url: string | null;
  readonly status: number;
  readonly document: object;
  readonly window: object;
  readonly navigator: object;
  readonly cookies: CookieJar;
  setNavigator(props: NavigatorOverrides): this;
  setUserAgent(userAgent: string): this;
  setExtraHeaders(headers: Record<string, string>): this;
  get fetchHtml(): typeof fetchHtml;
  setFetchHtml(fn: typeof fetchHtml): this;
  setRenderer(renderer: JsRenderer | null): this;
  evalJs(code: string, ...args: unknown[]): unknown;
  injectJs(code: string): { ok: true } | Promise<{ ok: true }>;
  latestDom(): string | Promise<string>;
  domHistory(): string[] | Promise<string[]>;
  goto(url: string, opts?: FetchOptions): Promise<NavResult>;
  follow(href: string, opts?: FetchOptions): Promise<NavResult>;
  reload(opts?: FetchOptions): Promise<NavResult>;
  goBack(opts?: FetchOptions): Promise<NavResult | null>;
  goForward(opts?: FetchOptions): Promise<NavResult | null>;
  locator(selector: string): Locator;
  getByRole(role: string, opts?: ByOptions): Locator;
  getByText(text: string | RegExp, opts?: ByOptions): Locator;
  getByLabel(text: string | RegExp, opts?: ByOptions): Locator;
  getByPlaceholder(text: string | RegExp, opts?: ByOptions): Locator;
  getByTestId(testId: string): Locator;
  getByAltText(text: string | RegExp, opts?: ByOptions): Locator;
  getByTitle(text: string | RegExp, opts?: ByOptions): Locator;
  clickElement(el: object, opts?: FetchOptions): Promise<NavResult>;
  submitFromElement(el: object, opts?: FetchOptions): Promise<NavResult>;
  title(): string;
  interactiveElements(): InteractiveElement[];
  links(): string[];
  requests(): string[];
  markdown(): string;
  html(): string;
  text(): string;
  accessibilityTree(): AxNode;
  ariaSnapshot(): string;
  extract(schema: Schema): object;
  hydrationState(): HydrationState;
  evaluate(pageFunction: Function | string, ...args: unknown[]): unknown;
  $eval(selector: string, fn: Function, ...args: unknown[]): unknown;
  $$eval(selector: string, fn: Function, ...args: unknown[]): unknown;
  query(selector: string, opts?: QueryOptions): QueryResult[] | QueryResult | null;
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
  httpUserAgent?: string;
  navigator?: NavigatorOverrides;
  robots?: RobotsCache;
  schema?: Schema;
  markdown?: boolean;
  /** Opt-in agent view. true = interactiveElements (cascade visibility); "fast" = skip the getComputedStyle visibility pass. */
  view?: boolean | "fast";
  allow?: (url: string) => boolean;
  fetchHtml?: typeof fetchHtml;
  fallback?: typeof fetchHtml;
  followRequests?: boolean;
  jar?: CookieJar;
  cache?: ResponseCache;
  /** undici Agent for fetch, or `false` to use Node's global dispatcher. Default: a fresh HTTP/2 + DNS-cache Agent. */
  dispatcher?: unknown;
  signal?: AbortSignal;
}
export declare class Crawler {
  constructor(options?: CrawlerOptions);
  options: CrawlerOptions;
  [Symbol.asyncIterator](): AsyncIterator<CrawlRecord>;
}
export interface CrawlSiteOptions {
  url?: string | string[];
  start?: string | string[];
  maxPages?: number;
  maxDepth?: number;
  sameHost?: boolean;
  allow?: string;
  deny?: string;
  mode?: BatchMode;
  view?: boolean | "fast";
  markdown?: boolean;
  robots?: boolean;
  fetchHtml?: typeof fetchHtml;
}
export declare function crawlSite(opts?: CrawlSiteOptions): Promise<CrawlRecord[]>;
