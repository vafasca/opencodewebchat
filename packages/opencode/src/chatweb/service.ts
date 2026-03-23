import fs from "fs/promises"
import path from "path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { Log } from "@/util/log"
import { Global } from "@/global"

export namespace ChatWeb {
  const log = Log.create({ service: "chatweb" })

  export const Ai = ["chatgpt", "claude"] as const
  export const BrowserKind = ["chrome", "edge"] as const
  export type Ai = (typeof Ai)[number]
  export type BrowserKind = (typeof BrowserKind)[number]

  type Login = { browser: Browser; context: BrowserContext; ai: Ai; kind: BrowserKind }
  type Chat = { browser: Browser; context: BrowserContext; page: Page; ai: Ai; kind: BrowserKind; chatID?: string }

  const login = new Map<string, Login>()
  const chat = new Map<string, Chat>()
  const mode = new Map<string, { ai: Ai; kind: BrowserKind }>()

  const urls: Record<Ai, string> = {
    chatgpt: "https://chatgpt.com/",
    claude: "https://claude.ai/",
  }

  function key(input: { ai: Ai; kind: BrowserKind }) {
    return `${input.ai}-${input.kind}`
  }

  function isAi(input: string): input is Ai {
    return (Ai as readonly string[]).includes(input)
  }

  function isKind(input: string): input is BrowserKind {
    return (BrowserKind as readonly string[]).includes(input)
  }

  export function parse(input: { ai: string; browser: string }) {
    if (!isAi(input.ai)) throw new Error(`invalid ai assistant: ${input.ai}`)
    if (!isKind(input.browser)) throw new Error(`invalid browser: ${input.browser}`)
    return { ai: input.ai, kind: input.browser }
  }

  async function storage(input: { ai: Ai; kind: BrowserKind }) {
    const dir = path.join(Global.Path.state, "chatweb", input.ai, input.kind)
    await fs.mkdir(dir, { recursive: true })
    return path.join(dir, "storage-state.json")
  }

  function channel(input: BrowserKind) {
    if (input === "chrome") return "chrome"
    return "msedge"
  }

  async function close(value?: { browser: Browser }) {
    if (!value) return
    await value.browser.close().catch(() => undefined)
  }

  function alive(value?: { browser: Browser; page?: Page }) {
    if (!value) return false
    if (!value.browser.isConnected()) return false
    if (!value.page) return true
    return !value.page.isClosed()
  }

  export async function startLogin(input: { ai: Ai; kind: BrowserKind }) {
    await close(login.get(key(input)))
    login.delete(key(input))

    const browser = await chromium.launch({
      channel: channel(input.kind),
      headless: false,
      args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
    })
    const context = await browser.newContext({
      viewport: null,
      storageState: await storage(input).catch(() => undefined),
    })
    const page = await context.newPage()
    await page.goto(urls[input.ai], { waitUntil: "domcontentloaded", timeout: 30000 })

    login.set(key(input), { browser, context, ai: input.ai, kind: input.kind })
    return { session: key(input) }
  }

  export async function confirmLogin(input: { ai: Ai; kind: BrowserKind }) {
    const item = login.get(key(input))
    if (!item) throw new Error("no active login session")
    await item.context.storageState({ path: await storage(input) })
    await close(item)
    login.delete(key(input))
    return true
  }

  export async function cancelLogin(input: { ai: Ai; kind: BrowserKind }) {
    await close(login.get(key(input)))
    login.delete(key(input))
    return true
  }

  export async function status() {
    const all = await Promise.all(
      Ai.flatMap((ai) => BrowserKind.map(async (kind) => ({ ai, kind, file: await storage({ ai, kind }) }))),
    )

    return all.reduce(
      (acc, item) => {
        acc[`${item.ai}-${item.kind}`] = {
          hasStorage: Bun.file(item.file).size > 0,
          loginOpen: alive(login.get(`${item.ai}-${item.kind}`)),
        }
        return acc
      },
      {} as Record<string, { hasStorage: boolean; loginOpen: boolean }>,
    )
  }

  export function setMode(input: { sessionID: string; ai: Ai; kind: BrowserKind; enabled: boolean }) {
    if (input.enabled) {
      mode.set(input.sessionID, { ai: input.ai, kind: input.kind })
      return true
    }
    mode.delete(input.sessionID)
    return true
  }

  export function getMode(sessionID: string) {
    return mode.get(sessionID)
  }

  async function open(input: { sessionID: string; ai: Ai; kind: BrowserKind; chatID?: string }) {
    const prior = chat.get(input.sessionID)
    if (alive(prior) && prior?.ai === input.ai && prior.kind === input.kind) return prior

    await close(prior)
    chat.delete(input.sessionID)

    const browser = await chromium.launch({
      channel: channel(input.kind),
      headless: false,
      args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
    })
    const context = await browser.newContext({
      viewport: null,
      storageState: await storage({ ai: input.ai, kind: input.kind }),
    })
    const page = await context.newPage()
    const target = input.chatID
      ? input.ai === "chatgpt"
        ? `https://chatgpt.com/c/${input.chatID}`
        : `https://claude.ai/chat/${input.chatID}`
      : urls[input.ai]
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 })
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined)
    await page.waitForTimeout(1500)

    const item: Chat = { browser, context, page, ai: input.ai, kind: input.kind, chatID: input.chatID }
    chat.set(input.sessionID, item)
    return item
  }

  function pull(url: string, ai: Ai) {
    const p = new URL(url).pathname
    if (ai === "chatgpt") return p.match(/\/c\/([a-z0-9-]+)/i)?.[1]
    return p.match(/\/chat\/([a-z0-9-]+)/i)?.[1]
  }

  async function pick(page: Page, ai: Ai) {
    const list =
      ai === "chatgpt"
        ? ["#prompt-textarea", 'textarea[placeholder*="Message"]', 'div[contenteditable="true"]', "textarea"]
        : ['div[contenteditable="true"]', "textarea", "div.ProseMirror"]
    for (const selector of list) {
      const found = await page.locator(selector).first().isVisible().catch(() => false)
      if (found) return selector
    }
    return undefined
  }

  async function wait(page: Page, ai: Ai) {
    const start = Date.now()
    while (Date.now() - start < 180000) {
      const stop = await page
        .locator('button[aria-label="Stop generating"], button[data-testid="stop-button"]')
        .first()
        .isVisible()
        .catch(() => false)
      if (!stop) break
      await page.waitForTimeout(1000)
    }

    const list =
      ai === "chatgpt"
        ? [
            '[data-message-author-role="assistant"]:last-of-type',
            '.markdown:last-of-type',
            '[data-testid="conversation-turn"]:last-child [data-message-author-role="assistant"]',
          ]
        : ['[class*="prose"]:last-of-type', '.font-claude-response:last-of-type', '[data-testid="conversation-turn"]:last-child']

    for (const selector of list) {
      const value = await page.locator(selector).last().textContent({ timeout: 3000 }).catch(() => null)
      if (value?.trim()) return value.trim()
    }
    return undefined
  }

  export async function prompt(input: { sessionID: string; text: string }) {
    const cfg = mode.get(input.sessionID)
    if (!cfg) return

    const item = await open({
      sessionID: input.sessionID,
      ai: cfg.ai,
      kind: cfg.kind,
      chatID: chat.get(input.sessionID)?.chatID,
    })

    const selector = await pick(item.page, item.ai)
    if (!selector) throw new Error("chat input not found")

    const ctrl = process.platform === "darwin" ? "Meta" : "Control"
    await item.page.click(selector)
    await item.page.keyboard.down(ctrl)
    await item.page.keyboard.press("a")
    await item.page.keyboard.up(ctrl)
    await item.page.keyboard.type(input.text)
    await item.page.keyboard.press("Enter")

    const text = await wait(item.page, item.ai)
    item.chatID = pull(item.page.url(), item.ai)
    await item.context.storageState({ path: await storage({ ai: item.ai, kind: item.kind }) })

    log.info("chatweb reply", { sessionID: input.sessionID, ai: item.ai, browser: item.kind, hasText: Boolean(text) })

    return { text, chatID: item.chatID, ai: item.ai, browser: item.kind }
  }
}
