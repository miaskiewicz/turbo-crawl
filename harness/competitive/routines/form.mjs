// Routine: multi-field form fill + submit on a real site (httpbin's order form).
// Server-rendered HTML form → works on every engine including turbo-crawl no-JS
// (it synthesizes the POST from the form graph). httpbin echoes the posted fields
// as JSON, which we read back to confirm the submission round-tripped.

const FORM = "https://httpbin.org/forms/post";

export default {
  name: "form",
  requiresJs: false,
  async run(page) {
    const obs = [];
    await page.goto(FORM);
    obs.push({
      step: "loaded",
      hasForm: await page.evaluate(() => !!document.querySelector("form")),
    });

    await page.fill("input[name=custname]", "Turbo Crawl");
    await page.fill("input[name=custtel]", "555-0100");
    await page.fill("input[name=custemail]", "bot@turbo.test");
    await page.fill("textarea[name=comments]", "competitive harness");

    // Submit the form (the only submit control on the page).
    await page.click("form button");
    obs.push({ step: "submitted", path: pathOf(page.url()) });

    // httpbin /post echoes the form data as JSON in the body.
    const body = await page.evaluate(() => document.body.textContent || "");
    obs.push({ step: "echoedName", value: body.includes("Turbo Crawl") });
    obs.push({ step: "echoedEmail", value: body.includes("bot@turbo.test") });
    return obs;
  },
  compareSteps: ["loaded", "submitted", "echoedName", "echoedEmail"],
};

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
