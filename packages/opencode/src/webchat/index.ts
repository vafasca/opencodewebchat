import { Log } from "@/util/log"
import type { Browser, BrowserContext, Page } from "playwright"
import { existsSync } from "fs"
import { fileURLToPath } from "url"
import { mkdir } from "fs/promises"
import pathUtil from "path"
import os from "os"

export namespace Webchat {
  const log = Log.create({ service: "webchat" })
  const login = new Map<string, { browser: Browser; context: BrowserContext }>()

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

  export type LoginInput = {
    browser: "chrome" | "edge"
    target: "chatgpt" | "claude"
  }

  export const loginOpen = async (input: LoginInput) => {
    const key = `${input.target}:${input.browser}`
    const old = login.get(key)
    if (old) {
      await old.browser.close().catch(() => undefined)
      login.delete(key)
    }
    const playwright = await import("playwright").catch(() => undefined)
    if (!playwright) return false
    const channel = input.browser === "edge" ? "msedge" : "chrome"
    const opts = {
      headless: false,
      args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
    }
    let browser = await playwright.chromium.launch({ channel, ...opts }).catch(() => undefined)
    if (!browser) browser = await playwright.chromium.launch(opts).catch(() => undefined)
    if (!browser) {
      const bin = pickPath(input.browser)
      if (bin) browser = await playwright.chromium.launch({ executablePath: bin, ...opts }).catch(() => undefined)
    }
    if (!browser) return false
    const file = storageFile(input)
    const context = await browser.newContext({
      viewport: null,
      ...(existsSync(file) ? { storageState: file } : {}),
    })
    const page = await context.newPage()
    await page.goto(target[input.target].url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined)
    login.set(key, { browser, context })
    log.info("webchat.login.open", { key, file })
    return true
  }

  export const loginConfirm = async (input: LoginInput) => {
    const key = `${input.target}:${input.browser}`
    const item = login.get(key)
    if (!item) return false
    const file = storageFile(input)
    await mkdir(pathUtil.dirname(file), { recursive: true })
    await item.context.storageState({ path: file }).catch(() => undefined)
    await item.browser.close().catch(() => undefined)
    login.delete(key)
    log.info("webchat.login.confirm", { key, file })
    return true
  }

  export const loginStatus = async (input: LoginInput) => {
    const key = `${input.target}:${input.browser}`
    const file = storageFile(input)
    return {
      active: login.has(key),
      saved: existsSync(file),
    }
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
        storage: storageFile({ target: mode, browser: input.browser }),
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
        storage: storageFile({ target: mode, browser: input.browser }),
      })
      if (node?.ok && node.text) return node.text
      return [
        "No se pudo abrir el navegador con Playwright.",
        "Se intentó channel (chrome/msedge), fallback chromium y driver Node.",
        `Detalle: ${node?.error ?? "sin detalle"}`,
      ].join(" ")
    }
    const file = storageFile({ target: mode, browser: input.browser })
    const ctx = await browser.newContext({
      ...(existsSync(file) ? { storageState: file } : {}),
    })
    const page = await ctx.newPage()
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout,
    })
    const gate = await loginRequired(page, mode)
    if (gate) {
      await ctx.close().catch(() => undefined)
      await browser.close().catch(() => undefined)
      return gate
    }
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
    await send(page, inputSel, input.prompt, mode)
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

  const send = async (page: Page, input: string, txt: string, mode: "chatgpt" | "claude") => {
    await page.locator(input).fill(txt)
    await page.locator(input).click().catch(() => undefined)
    await page.locator(input).press("Enter").catch(() => page.keyboard.press("Enter"))
    await page.waitForTimeout(700)
    const stuck = await page
      .locator(input)
      .evaluate((el, expected) => {
        if (el instanceof HTMLTextAreaElement) return el.value.includes(expected)
        const val = el.textContent ?? ""
        return val.includes(expected)
      }, txt)
      .catch(() => false)
    if (!stuck) return
    const list =
      mode === "chatgpt"
        ? [
            "button[data-testid='send-button']",
            "button[aria-label*='Send']",
            "button[aria-label*='Enviar']",
            "button[aria-label*='mensaje']",
            "form button[type='submit']",
          ]
        : ["button[aria-label*='Send']", "button[aria-label*='Enviar']", "form button[type='submit']"]
    for (const item of list) {
      const ok = await page
        .locator(item)
        .first()
        .click({ timeout: 1500 })
        .then(() => true)
        .catch(() => false)
      if (!ok) continue
      log.warn("webchat.run.send_click_fallback", { selector: item })
      return
    }
    log.warn("webchat.run.send_fallback_failed")
  }

  const loginRequired = async (page: Page, mode: "chatgpt" | "claude") => {
    const keys =
      mode === "chatgpt"
        ? ["button:has-text('Iniciar sesión')", "button:has-text('Log in')"]
        : ["button:has-text('Log in')", "button:has-text('Sign in')"]
    for (const item of keys) {
      const ok = await page
        .locator(item)
        .first()
        .isVisible()
        .catch(() => false)
      if (!ok) continue
      log.warn("webchat.run.login_required", { selector: item })
      return "Debes iniciar sesión en el chat objetivo para permitir envío automático."
    }
  }

  const pickPath = (input: "chrome" | "edge") => {
    for (const item of path[input]) {
      if (existsSync(item)) return item
    }
  }

  const storageFile = (input: LoginInput) =>
    pathUtil.join(os.homedir(), ".opencode", "webchat", `${input.target}-${input.browser}.json`)

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
    storage: string
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
