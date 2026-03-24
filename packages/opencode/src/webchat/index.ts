import { Log } from "@/util/log"
import type { Page } from "playwright"

export namespace Webchat {
  const log = Log.create({ service: "webchat" })

  export const DEFAULT_URL = "https://chatgpt.com/"

  const target = {
    chatgpt: {
      url: "https://chatgpt.com/",
      input: ["textarea", "#prompt-textarea"],
      response: [
        "[data-message-author-role='assistant']",
        "article[data-testid='conversation-turn']",
      ],
    },
    claude: {
      url: "https://claude.ai/new",
      input: ["div[contenteditable='true']", "textarea"],
      response: ["div[data-is-streaming]", "div.font-claude-message", "div[data-testid='message-content']"],
    },
  } as const

  export type Input = {
    prompt: string
    browser: "chrome" | "edge"
    target?: "chatgpt" | "claude"
    url?: string
    timeout?: number
    input?: string
    response?: string
    settle?: number
    headless?: boolean
  }

  export const run = async (input: Input) => {
    const mode = input.target ?? "chatgpt"
    const cfg = target[mode]
    const timeout = input.timeout ?? 60000
    const inputs = input.input ? [input.input] : cfg.input
    const outputs = input.response ? [input.response] : cfg.response
    const settle = input.settle ?? 1500
    const url = input.url ?? cfg.url ?? DEFAULT_URL
    const channel = input.browser === "edge" ? "msedge" : "chrome"
    log.info("webchat.run.start", {
      target: mode,
      browser: input.browser,
      channel,
      timeout,
      url,
      inputs,
      outputs,
      headless: input.headless ?? false,
    })

    if (!input.prompt.trim()) {
      log.warn("webchat.run.empty")
      return ""
    }

    const playwright = await import("playwright").catch((err) => {
      const txt = err instanceof Error ? err.message : String(err)
      log.error("webchat.run.playwright_import_failed", { error: txt })
      return undefined
    })
    if (!playwright) {
      return "No se pudo cargar Playwright. Instala dependencias y ejecuta: bunx playwright install"
    }
    const browser = await playwright.chromium
      .launch({
        channel,
        headless: input.headless ?? false,
      })
      .catch((err) => {
        const txt = err instanceof Error ? err.message : String(err)
        log.error("webchat.run.launch_failed", { error: txt, channel })
        return undefined
      })
    if (!browser) {
      return "No se pudo abrir el navegador con Playwright. Revisa instalación y channel (chrome/msedge)."
    }
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout,
    })
    log.info("webchat.run.ready")
    const inputSel = await findInput(page, inputs, timeout)
    if (!inputSel) {
      const msg = "No se encontró el input del chat. Verifica login, target y selector."
      log.error("webchat.run.input_missing", { target: mode, inputs })
      await ctx.close().catch(() => undefined)
      await browser.close().catch(() => undefined)
      return msg
    }
    log.info("webchat.run.input_found", { input: inputSel })
    await page.locator(inputSel).fill(input.prompt)
    await page.keyboard.press("Enter")
    log.info("webchat.run.sent")
    const responseSel = await findOutput(page, outputs, timeout)
    if (!responseSel) {
      const msg = "No se detectó respuesta del chat. Revisa autenticación y selectores."
      log.error("webchat.run.output_missing", { target: mode, outputs })
      await ctx.close().catch(() => undefined)
      await browser.close().catch(() => undefined)
      return msg
    }
    log.info("webchat.run.output_found", { output: responseSel })

    let text = ""
    let same = 0
    for (let i = 0; i < 120; i++) {
      const val = await page
        .locator(responseSel)
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

  const findInput = async (page: Page, list: string[], timeout: number) => {
    for (const item of list) {
      const ok = await page
        .waitForSelector(item, { timeout: Math.floor(timeout / Math.max(1, list.length)) })
        .then(() => true)
        .catch(() => false)
      if (ok) return item
    }
  }

  const findOutput = async (page: Page, list: string[], timeout: number) => {
    for (const item of list) {
      const ok = await page
        .waitForSelector(item, { timeout: Math.floor(timeout / Math.max(1, list.length)) })
        .then(() => true)
        .catch(() => false)
      if (ok) return item
    }
  }
}
