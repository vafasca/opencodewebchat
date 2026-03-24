import { Log } from "@/util/log"
import type { Page } from "playwright"
import { existsSync } from "fs"
import { fileURLToPath } from "url"

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

  const path = {
    chrome: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
    edge: [
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
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

    if (process.platform === "win32") {
      log.warn("webchat.run.win32.node_driver", {
        note: "using node driver as primary path on windows",
      })
      const node = await nodeRun({
        browser: input.browser,
        target: mode,
        prompt: input.prompt,
        timeout,
        settle,
        url,
        input: input.input,
        response: input.response,
        headless: input.headless ?? false,
      })
      if (node?.ok && node.text) return node.text
      return `No se pudo abrir navegador en Windows driver. Detalle: ${node?.error ?? "sin detalle"}`
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
      .catch(async (err) => {
        const txt = err instanceof Error ? err.message : String(err)
        log.error("webchat.run.launch_failed", { error: txt, channel })
        log.warn("webchat.run.launch_fallback", {
          note: "retrying with bundled chromium executable and no channel",
        })
        const retry = await playwright.chromium
          .launch({
            headless: input.headless ?? false,
          })
          .catch((retryErr) => {
            const retryTxt = retryErr instanceof Error ? retryErr.message : String(retryErr)
            log.error("webchat.run.launch_fallback_failed", { error: retryTxt })
            return undefined
          })
        if (retry) return retry
        const bin = pickPath(input.browser)
        if (!bin) return undefined
        log.warn("webchat.run.launch_executable_path", { bin })
        const last = await playwright.chromium
          .launch({
            executablePath: bin,
            headless: input.headless ?? false,
          })
          .catch((lastErr) => {
            const lastTxt = lastErr instanceof Error ? lastErr.message : String(lastErr)
            log.error("webchat.run.launch_executable_failed", { error: lastTxt, bin })
            return undefined
          })
        return last
      })
    if (!browser) {
      const node = await nodeRun({
        browser: input.browser,
        target: mode,
        prompt: input.prompt,
        timeout,
        settle,
        url,
        input: input.input,
        response: input.response,
        headless: input.headless ?? false,
      })
      if (node?.ok && node.text) return node.text
      return [
        "No se pudo abrir el navegador con Playwright.",
        "Se intentó channel (chrome/msedge), fallback chromium y driver Node.",
        `Detalle: ${node?.error ?? "sin detalle"}`,
      ].join(" ")
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

  const pickPath = (input: "chrome" | "edge") => {
    for (const item of path[input]) {
      if (existsSync(item)) return item
    }
  }

  const nodeRun = async (input: {
    browser: "chrome" | "edge"
    target: "chatgpt" | "claude"
    prompt: string
    timeout: number
    settle: number
    url: string
    input?: string
    response?: string
    headless: boolean
  }) => {
    const file = fileURLToPath(new URL("./driver.cjs", import.meta.url))
    log.warn("webchat.run.node_driver.start", {
      file,
      browser: input.browser,
      target: input.target,
    })
    const proc = Bun.spawn(["node", file], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    proc.stdin.write(JSON.stringify(input))
    proc.stdin.end()
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    if (code !== 0) {
      log.error("webchat.run.node_driver.exit", { code, err })
      return
    }
    if (err.trim()) log.warn("webchat.run.node_driver.stderr", { err })
    const data = await Promise.resolve(JSON.parse(out || "{}"))
      .then((x) => x as { ok?: boolean; text?: string; error?: string })
      .catch((parseErr) => {
        const txt = parseErr instanceof Error ? parseErr.message : String(parseErr)
        log.error("webchat.run.node_driver.parse_failed", { txt, out })
        return { ok: false, error: txt }
      })
    log.info("webchat.run.node_driver.done", { ok: data.ok === true, error: data.error })
    return data
  }
}
