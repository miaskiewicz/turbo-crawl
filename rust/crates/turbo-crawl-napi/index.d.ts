// Type surface of the turbo-crawl native (Rust) addon. JSON-returning functions
// are typed as `string` (the caller `JSON.parse`s); structured types live in the
// JS shim that wraps this addon.

export function version(): string;

/** Fetch a URL → JSON `{ html, finalUrl, status, redirected }`. */
export function fetchHtml(url: string): Promise<string>;

/** Crawl from a JSON options string → JSON array of page records. */
export function crawl(optsJson: string): Promise<string>;

/** Evaluate JS against the page DOM → result as a string (no event loop). */
export function evaluate(html: string, script: string): string;

/** Run the page's own JS (promises/timers/fetch/cookies) → hydrated HTML. */
export function render(html: string, baseUrl: string, script: string): string;

/** Fetch with an explicit method/body (POST form submit). */
export function request(url: string, method: string, body?: string): Promise<string>;

/** Fetch carrying storageState cookies in, updated state out (persistence). */
export function fetchWithCookies(
  url: string,
  cookies: string,
  method?: string,
  body?: string,
): Promise<string>;

// Actions by selector — mutate the DOM and return the new HTML.
export function fill(html: string, selector: string, value: string): string;
export function setChecked(html: string, selector: string, on: boolean): string;
export function selectOption(html: string, selector: string, value: string): string;
/** Click intent → JSON {action:"navigate"|"submit"|"inert", ...}. */
export function click(html: string, selector: string, baseUrl: string): string;

// Actions by node handle (back locator-scoped actions).
export function fillNode(html: string, node: number, value: string): string;
export function setCheckedNode(html: string, node: number, on: boolean): string;
export function selectOptionNode(html: string, node: number, value: string): string;
export function clickNode(html: string, node: number, baseUrl: string): string;

// Per-element accessors by node handle.
export function attrOf(html: string, node: number, name: string): string | null;
export function inputValueOf(html: string, node: number): string;
export function isVisible(html: string, node: number): boolean;
export function isChecked(html: string, node: number): boolean;
export function isEnabled(html: string, node: number): boolean;
export function isEditable(html: string, node: number): boolean;
export function isEmpty(html: string, node: number): boolean;
export function ariaRoleOf(html: string, node: number): string;
export function accessibleNameOf(html: string, node: number): string;
export function accessibleDescriptionOf(html: string, node: number): string;
export function selectedValuesOf(html: string, node: number): string[];
export function cssValueOf(html: string, node: number, name: string): string;
export function matchesAriaSnapshot(html: string, node: number, expected: string): boolean;

export function markdown(html: string, baseUrl: string): string;
export function text(html: string): string;
export function title(html: string): string;
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
