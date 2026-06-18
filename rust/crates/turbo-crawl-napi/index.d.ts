// Type surface of the turbo-crawl native (Rust) addon. JSON-returning functions
// are typed as `string` (the caller `JSON.parse`s); structured types live in the
// JS shim that wraps this addon.

export function version(): string;

/** Fetch a URL → JSON `{ html, finalUrl, status, redirected }`. */
export function fetchHtml(url: string): Promise<string>;

/** Crawl from a JSON options string → JSON array of page records. */
export function crawl(optsJson: string): Promise<string>;

export function markdown(html: string, baseUrl: string): string;
export function text(html: string): string;
export function html(html: string): string;
export function links(html: string, baseUrl: string): string[];

/** JSON-encoded results. */
export function interactiveElements(html: string, baseUrl: string): string;
export function accessibilityTree(html: string): string;
export function ariaSnapshot(html: string): string;
export function hydrationState(html: string): string;
export function detect(html: string): string;
export function query(html: string, selector: string, kind?: string): string;
export function extract(html: string, baseUrl: string, schemaJson: string): string;
