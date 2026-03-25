const { chromium } = require("playwright")
const { existsSync } = require("fs")
const { mkdir } = require("fs/promises")
const { writeFile } = require("fs/promises")
const { rm } = require("fs/promises")
const pathUtil = require("path")

const target = {
  chatgpt: {
    url: "https://chatgpt.com/",
    input: ["textarea", "#prompt-textarea", "div#prompt-textarea", "div#prompt-textarea[contenteditable='true']"],
    output: [
      "[data-message-author-role='assistant']",
      "div[data-message-author-role='assistant']",
      "article[data-testid='conversation-turn']",
      "article[data-testid^='conversation-turn-']",
      "div[data-testid='conversation-turn-assistant']",
      "[data-testid^='conversation-turn-'] [data-message-author-role='assistant']",
      "main [data-message-author-role='assistant']",
      "div[data-testid='assistant-turn']",
      "main article",
    ],
  },
  claude: {
    url: "https://claude.ai/new",
    input: ["div[contenteditable='true']", "textarea"],
    output: ["div[data-is-streaming]", "div.font-claude-message", "div[data-testid='message-content']"],
  },
}

const path = {
  chrome: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
  edge: [
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
}

const read = () =>
  new Promise((resolve) => {
    let out = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (x) => {
      out += x
    })
    process.stdin.on("end", () => {
      resolve(out)
    })
  })

const pick = (name) => {
  for (const item of path[name] || []) {
    if (existsSync(item)) return item
  }
}

const find = async (page, list, timeout) => {
  for (const item of list) {
    const ok = await page
      .waitForSelector(item, { timeout: Math.floor(timeout / Math.max(1, list.length)) })
      .then(() => true)
      .catch(() => false)
    if (ok) return item
  }
}

const send = async (page, input, txt, mode) => {
  await page.locator(input).click().catch(() => undefined)
  await page
    .locator(input)
    .evaluate((el, val) => {
      if (!(el instanceof HTMLElement)) return false
      el.focus()
      const dt = new DataTransfer()
      dt.setData("text/plain", val)
      const ev = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
      })
      el.dispatchEvent(ev)
      if (el instanceof HTMLTextAreaElement && !el.value.includes(val)) {
        el.value = val
        el.dispatchEvent(new Event("input", { bubbles: true }))
      }
      return true
    }, txt)
    .catch(() => false)
  await page.locator(input).fill(txt).catch(() => undefined)
  await page.waitForTimeout(600)
  const fast = await page
    .locator(input)
    .first()
    .evaluate((el) => {
      const root = el.closest("form") || document
      const btn = root.querySelector(".composer-submit-button-color")
      if (!(btn instanceof HTMLButtonElement)) return false
      const label = (btn.getAttribute("aria-label") || "").toLowerCase()
      if (label.includes("start voice") || label.includes("iniciar voz")) return false
      if (btn.disabled) return false
      btn.click()
      return true
    })
    .catch(() => false)
  if (fast) {
    await page.waitForTimeout(700)
    const sent = await page
      .locator(input)
      .evaluate((el, expected) => {
        if (el instanceof HTMLTextAreaElement) return !el.value.includes(expected)
        const val = el.textContent || ""
        return !val.includes(expected)
      }, txt)
      .catch(() => false)
    if (sent) return
  }
  await page.locator(input).press("Enter").catch(() => page.keyboard.press("Enter"))
  await page.waitForTimeout(700)
  const stuck = await page
    .locator(input)
    .evaluate((el, expected) => {
      if (el instanceof HTMLTextAreaElement) return el.value.includes(expected)
      const val = el.textContent || ""
      return val.includes(expected)
    }, txt)
    .catch(() => false)
  if (!stuck) return
  await page.keyboard.press("Control+Enter").catch(() => undefined)
  await page.keyboard.press("Meta+Enter").catch(() => undefined)
  await page.waitForTimeout(700)
  const sentByHotkey = await page
    .locator(input)
    .evaluate((el, expected) => {
      if (el instanceof HTMLTextAreaElement) return !el.value.includes(expected)
      const val = el.textContent || ""
      return !val.includes(expected)
    }, txt)
    .catch(() => false)
  if (sentByHotkey) return
  const list =
    mode === "chatgpt"
      ? [
          "#composer-submit-button",
          ".composer-submit-button-color",
          "button.composer-submit-button-color",
          "button[data-testid='composer-send-button']",
          "button[data-testid='composer-submit-button']",
          "button[data-testid='fruitjuice-send-button']",
          "button[data-testid='send-button']",
          "button[data-testid*='send']",
          "button[aria-label*='Submit']",
          "button[aria-label*='Enviar mensaje']",
          "button[aria-label*='Send']",
          "button[aria-label*='Enviar']",
          "button[aria-label*='send']",
          "button[aria-label*='mensaje']",
          "button:has-text('Enviar')",
          "form button[type='submit']",
        ]
      : [
          "#composer-submit-button",
          ".composer-submit-button-color",
          "button.composer-submit-button-color",
          "button[data-testid*='send']",
          "button[data-testid='composer-send-button']",
          "button[aria-label*='Send']",
          "button[aria-label*='Enviar']",
          "button[aria-label*='send']",
          "button:has-text('Enviar')",
          "form button[type='submit']",
        ]
  for (const item of list) {
    const ok = await page
      .locator(input)
      .first()
      .evaluate((el, sel) => {
        const root = el.closest("form") || document
        const pick = root.querySelector(sel)
        if (!(pick instanceof HTMLElement)) return false
        const style = window.getComputedStyle(pick)
        if (style.display === "none" || style.visibility === "hidden") return false
        if (pick instanceof HTMLButtonElement && pick.disabled) return false
        pick.click()
        return true
      }, item)
      .then(() => true)
      .catch(() => false)
    if (!ok) {
      const alt = await page
        .locator(item)
        .first()
        .click({ timeout: 2500 })
        .then(() => true)
        .catch(() => false)
      if (!alt) continue
    }
    await page.waitForTimeout(500)
    const sent = await page
      .locator(input)
      .evaluate((el, expected) => {
        if (el instanceof HTMLTextAreaElement) return !el.value.includes(expected)
        const val = el.textContent || ""
        return !val.includes(expected)
      }, txt)
      .catch(() => false)
    if (sent) return
  }
  const forced = await ensureSend(page, input)
  if (forced) {
    await page.waitForTimeout(700)
    const sent = await page
      .locator(input)
      .evaluate((el, expected) => {
        if (el instanceof HTMLTextAreaElement) return !el.value.includes(expected)
        const val = el.textContent || ""
        return !val.includes(expected)
      }, txt)
      .catch(() => false)
    if (sent) return
  }
  for (const item of outputsFromMode(mode)) {
    const ok = await page
      .waitForSelector(item, { timeout: 1200 })
      .then(() => true)
      .catch(() => false)
    if (ok) return
  }
}

const outputsFromMode = (mode) =>
  mode === "chatgpt"
    ? [
        "[data-message-author-role='assistant']",
        "div[data-message-author-role='assistant']",
        "article[data-testid='conversation-turn']",
        "article[data-testid^='conversation-turn-']",
        "div[data-testid='conversation-turn-assistant']",
        "[data-testid^='conversation-turn-'] [data-message-author-role='assistant']",
        "main [data-message-author-role='assistant']",
      ]
    : ["div[data-is-streaming]", "div.font-claude-message", "div[data-testid='message-content']"]
const ensureSend = async (page, input) => {
  const btn = await page
    .locator(input)
    .first()
    .evaluate((el) => {
      const form = el.closest("form")
      if (!form) return false
      const list = [...form.querySelectorAll("button")]
      const ok = list.filter((item) => {
        if (!(item instanceof HTMLButtonElement)) return false
        if (item.disabled) return false
        const style = window.getComputedStyle(item)
        if (style.display === "none" || style.visibility === "hidden") return false
        const key = [
          item.getAttribute("aria-label") || "",
          item.getAttribute("data-testid") || "",
          item.textContent || "",
        ]
          .join(" ")
          .toLowerCase()
        return key.includes("send") || key.includes("enviar")
      })
      const pick = ok[0] || list.at(-1)
      if (!(pick instanceof HTMLButtonElement)) return false
      pick.click()
      return true
    })
    .catch(() => false)
  if (btn) return true
  const submit = await page
    .locator(input)
    .first()
    .evaluate((el) => {
      const form = el.closest("form")
      if (!form) return false
      if ("requestSubmit" in form) {
        form.requestSubmit()
        return true
      }
      return false
    })
    .catch(() => false)
  return submit
}

const loginRequired = async (page, mode) => {
  const list =
    mode === "chatgpt"
      ? ["button:has-text('Iniciar sesión')", "button:has-text('Log in')"]
      : ["button:has-text('Log in')", "button:has-text('Sign in')"]
  for (const item of list) {
    const ok = await page
      .locator(item)
      .first()
      .isVisible()
      .catch(() => false)
    if (!ok) continue
    return true
  }
  return false
}

const run = async () => {
  const raw = await read()
  const data = JSON.parse(raw || "{}")
  if (data.action === "login_open") {
    const mode = data.target === "claude" ? "claude" : "chatgpt"
    const cfg = target[mode]
    const url = data.url || cfg.url
    const channel = data.browser === "edge" ? "msedge" : "chrome"
    const opts = {
      headless: false,
      args: ["--start-maximized"],
    }
    let browser = await chromium.launch({ channel, ...opts }).catch(() => undefined)
    if (!browser) browser = await chromium.launch({ ...opts }).catch(() => undefined)
    if (!browser) {
      const bin = pick(data.browser)
      if (bin) browser = await chromium.launch({ executablePath: bin, ...opts }).catch(() => undefined)
    }
    if (!browser) return { ok: false, error: "login_open launch failed" }
    const ctx = await browser.newContext({
      viewport: null,
      ...(data.storage && existsSync(data.storage) ? { storageState: data.storage } : {}),
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    })
    const save = async () => {
      if (!data.storage) return
      await mkdir(pathUtil.dirname(data.storage), { recursive: true }).catch(() => undefined)
      await ctx.storageState({ path: data.storage }).catch(() => undefined)
    }
    if (data.pidpath) {
      await mkdir(pathUtil.dirname(data.pidpath), { recursive: true }).catch(() => undefined)
      await writeFile(data.pidpath, String(process.pid)).catch(() => undefined)
    }
    const end = async () => {
      await save()
      if (data.pidpath) await rm(data.pidpath).catch(() => undefined)
      await ctx.close().catch(() => undefined)
      await browser.close().catch(() => undefined)
      process.exit(0)
    }
    process.on("SIGINT", end)
    process.on("SIGTERM", end)
    browser.on("disconnected", () => {
      end()
    })
    const page = await ctx.newPage()
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined)
    setInterval(() => {
      save()
    }, 2000)
    return new Promise(() => {})
  }
  const mode = data.target === "claude" ? "claude" : "chatgpt"
  const cfg = target[mode]
  const timeout = data.timeout || 60000
  const inputs = data.input ? [data.input] : cfg.input
  const outputs = data.response ? [data.response] : cfg.output
  const url = data.url || cfg.url
  const settle = data.settle || 1500
  const headless = !!data.headless
  const channel = data.browser === "edge" ? "msedge" : "chrome"

  const opts = {
    headless,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
  }
  let browser = await chromium.launch({ channel, ...opts }).catch(() => undefined)
  if (!browser) browser = await chromium.launch({ ...opts }).catch(() => undefined)
  if (!browser) {
    const bin = pick(data.browser)
    if (bin) browser = await chromium.launch({ executablePath: bin, ...opts }).catch(() => undefined)
  }
  if (!browser) {
    return { ok: false, error: "node-driver launch failed (channel + fallback + executablePath)." }
  }

  const ctx = await browser.newContext({
    viewport: null,
    ...(data.storage && existsSync(data.storage) ? { storageState: data.storage } : {}),
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  })
  const page = await ctx.newPage()
  await page.goto(url, { waitUntil: "domcontentloaded", timeout })
  if (await loginRequired(page, mode)) {
    await ctx.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
    return { ok: false, error: "login required in target chat." }
  }
  const input = await find(page, inputs, timeout)
  if (!input) {
    await ctx.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
    return { ok: false, error: "node-driver input selector missing." }
  }
  await send(page, input, data.prompt || "", mode)
  const output = await find(page, outputs, timeout)
  if (!output) {
    await ctx.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
    return { ok: false, error: "node-driver output selector missing." }
  }
  let text = ""
  let same = 0
  for (let i = 0; i < 120; i++) {
    const val = await page
      .locator(output)
      .last()
      .innerText({ timeout: 5000 })
      .catch(() => "")
    if (!val.trim()) {
      await page.waitForTimeout(500)
      continue
    }
    if (val === text) same += 1
    if (val !== text) {
      text = val
      same = 0
    }
    if (same >= Math.max(1, Math.floor(settle / 500))) break
    await page.waitForTimeout(500)
  }
  if (data.storage) {
    await mkdir(pathUtil.dirname(data.storage), { recursive: true }).catch(() => undefined)
    await ctx.storageState({ path: data.storage }).catch(() => undefined)
  }
  await ctx.close().catch(() => undefined)
  await browser.close().catch(() => undefined)
  return { ok: true, text }
}

run()
  .then((result) => {
    process.stdout.write(JSON.stringify(result))
    process.exit(0)
  })
  .catch((err) => {
    process.stdout.write(JSON.stringify({ ok: false, error: err?.message || String(err) }))
    process.exit(0)
  })
