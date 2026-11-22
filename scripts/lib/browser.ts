// Headless browsers for maintainer checks: CHROME_PATH if set, else an installed
// Chrome; Firefox from FIREFOX_PATH or `npx playwright-core install firefox`.
// playwright-core never downloads a browser on its own.
import { chromium, firefox } from "playwright-core";
import type { Browser } from "playwright-core";

export async function launchBrowser(): Promise<{ browser: Browser | null; reason?: string }> {
  const opts = process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] }
    : { channel: "chrome" };
  try {
    return { browser: await chromium.launch({ headless: true, ...opts }) };
  } catch (err) {
    return {
      browser: null,
      reason: `no browser (${String((err as Error).message).split("\n")[0]}); install Chrome or set CHROME_PATH`,
    };
  }
}

/**
 * Headless Firefox, for checks that differ by engine (SVG measuring): FIREFOX_PATH if set,
 * else the one `npx playwright-core install firefox` downloaded.
 */
export async function launchFirefox(): Promise<{ browser: Browser | null; reason?: string }> {
  const opts = process.env.FIREFOX_PATH ? { executablePath: process.env.FIREFOX_PATH } : {};
  try {
    return { browser: await firefox.launch({ headless: true, ...opts }) };
  } catch (err) {
    return {
      browser: null,
      reason: `no Firefox (${String((err as Error).message).split("\n")[0]}); run npx playwright-core install firefox or set FIREFOX_PATH`,
    };
  }
}
