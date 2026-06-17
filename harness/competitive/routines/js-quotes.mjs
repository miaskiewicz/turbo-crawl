// Routine: a JavaScript-rendered page (quotes.toscrape.com/js builds its content
// client-side). Demonstrates the JS-render tier: turbo-crawl no-JS sees an empty
// list (so this routine is skipped for it), while turbo-crawl js-fast / js-secure
// and real browsers render the quotes — and should agree.

const URL = "https://quotes.toscrape.com/js/";

export default {
  name: "js-quotes",
  requiresJs: true,
  async run(page) {
    await page.goto(URL);
    const count = await page.evaluate(() => document.querySelectorAll(".quote").length);
    const first = await page.evaluate(() => {
      const q = document.querySelector(".quote .text");
      return q ? q.textContent.slice(0, 40) : null;
    });
    return [
      { step: "quoteCount", value: count },
      { step: "firstQuote", value: first },
    ];
  },
  compareSteps: ["quoteCount", "firstQuote"],
};
