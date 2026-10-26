// Headless browser for maintainer checks: CHROME_PATH if set, else an
// installed Chrome. playwright-core never downloads a browser.
import { chromium } from "playwright-core";

/** @returns {Promise<{ browser: import("playwright-core").Browser|null, reason?: string }>} */
export async function launchBrowser() {
  const opts = process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] }
    : { channel: "chrome" };
  try {
    return { browser: await chromium.launch({ headless: true, ...opts }) };
  } catch (err) {
    return { browser: null, reason: `no browser (${String(err.message).split("\n")[0]}); install Chrome or set CHROME_PATH` };
  }
}
