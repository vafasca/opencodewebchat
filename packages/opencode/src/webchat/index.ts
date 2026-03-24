import { Log } from "@/util/log"
import { Process } from "@/util/process"

export namespace Webchat {
  const log = Log.create({ service: "webchat" })

  export const DEFAULT_URL = "https://chat.openai.com/"

  export type Input = {
    prompt: string
    browser: "chrome" | "edge"
    url?: string
    timeout?: number
    input?: string
    response?: string
    settle?: number
  }

  export const run = async (input: Input) => {
    const timeout = input.timeout ?? 180000
    const inputSelector = input.input ?? "textarea"
    const responseSelector = input.response ?? "[data-message-author-role='assistant']"
    const settle = input.settle ?? 1500
    const url = input.url ?? DEFAULT_URL
    const channel = input.browser === "edge" ? "msedge" : "chrome"
    log.info("webchat.run.start", {
      browser: input.browser,
      channel,
      timeout,
      url,
      inputSelector,
      responseSelector,
    })

    if (!input.prompt.trim()) {
      log.warn("webchat.run.empty")
      return ""
    }

    const playwright = await import("playwright")
    const browser = await playwright.chromium.launch({
      channel,
      headless: Process.isCI ? true : false,
    })
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout,
    })
    log.info("webchat.run.ready")
    await page.waitForSelector(inputSelector, { timeout })
    await page.fill(inputSelector, input.prompt)
    await page.keyboard.press("Enter")
    log.info("webchat.run.sent")
    await page.waitForSelector(responseSelector, { timeout })

    let text = ""
    let same = 0
    for (let i = 0; i < 120; i++) {
      const val = await page
        .locator(responseSelector)
        .last()
        .innerText({ timeout: 5000 })
        .catch(() => "")
      if (!val.trim()) {
        await page.waitForTimeout(500)
        continue
      }
      if (val === text) {
        same += 1
      }
      if (val !== text) {
        text = val
        same = 0
      }
      if (same >= Math.max(1, Math.floor(settle / 500))) break
      await page.waitForTimeout(500)
    }

    await ctx.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
    log.info("webchat.run.done", {
      size: text.length,
    })
    return text
  }
}
