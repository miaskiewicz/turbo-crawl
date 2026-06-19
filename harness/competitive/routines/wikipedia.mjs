// Routine: Wikipedia click-through. Visits 3+ articles by following the first
// real in-article link each hop, then exercises goBack and a scroll. Navigation is
// href-driven so every engine takes the SAME path → outputs are directly
// comparable (titles + paths). Uses only the Playwright Page API.

const START = "https://en.wikipedia.org/wiki/Web_crawler";
const ORIGIN = "https://en.wikipedia.org";

// First non-namespaced /wiki/ article link in the body (stable across engines).
function firstArticleHref() {
  const links = [...document.querySelectorAll("#bodyContent a[href^='/wiki/']")];
  const a = links.find((el) => !el.getAttribute("href").includes(":"));
  return a ? a.getAttribute("href") : null;
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export default {
  name: "wikipedia",
  async run(page) {
    const obs = [];
    let url = START;
    for (let i = 0; i < 3; i++) {
      await page.goto(url);
      obs.push({ step: `page${i}`, title: await page.title(), path: pathOf(page.url()) });
      const href = await page.evaluate(firstArticleHref);
      if (!href) break;
      url = new URL(href, ORIGIN).href;
    }
    await page.goBack();
    obs.push({ step: "goBack", path: pathOf(page.url()) });
    // scroll: a no-op on turbo-surf (no layout), real on Chromium — recorded, not compared.
    await page.evaluate(() => (typeof scrollTo === "function" ? scrollTo(0, 2000) : 0));
    obs.push({ step: "scrolled", ok: true });
    return obs;
  },
  // Steps compared for parity (scroll excluded — it has no DOM-observable effect here).
  compareSteps: ["page0", "page1", "page2", "goBack"],
};
