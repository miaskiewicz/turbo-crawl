// turbo-crawl — public API barrel.
// Native-speed, browserless crawler for AI agents, built on turbo-dom.
// See SPEC.md for the full design and phase plan (§12).

export const version = "0.1.0";

export { Page } from "./page.mjs";
export { fetchHtml, HttpError } from "./net.mjs";
export { CookieJar } from "./cookies.mjs";
export { RobotsCache, parseRobots } from "./robots.mjs";
export { interactiveElements, links } from "./extract.mjs";
export { isVisible } from "./visible.mjs";
export { markdown } from "./markdown.mjs";
export { text } from "./text.mjs";
export { accessibilityTree } from "./ax.mjs";
export { buildSubmission, serializeForm, fillValue } from "./actions.mjs";
export { resolve, isHttpUrl, canonicalize } from "./url.mjs";
export { Crawler } from "./crawl.mjs";
export { Frontier } from "./frontier.mjs";
export { extractSchema } from "./schema.mjs";
export { detectJsRequired } from "./detect.mjs";
export { query } from "./query.mjs";
export { evaluateXPath } from "./xpath.mjs";
export { extractHydrationState } from "./hydration.mjs";
export { Locator } from "./locator.mjs";
export { jsRenderer } from "./render/index.mjs";
