const { chromium } = require("playwright")
const { existsSync } = require("fs")

const target = {
  chatgpt: {
    url: "https://chatgpt.com/",
    input: ["textarea", "#prompt-textarea"],
    output: ["[data-message-author-role='assistant']", "article[data-testid='conversation-turn']"],
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

const run = async () => {
  const raw = await read()
  const data = JSON.parse(raw || "{}")
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
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  })
  const page = await ctx.newPage()
  await page.goto(url, { waitUntil: "domcontentloaded", timeout })
  const input = await find(page, inputs, timeout)
  if (!input) {
    await ctx.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
    return { ok: false, error: "node-driver input selector missing." }
  }
  await page.locator(input).fill(data.prompt || "")
  await page.keyboard.press("Enter")
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
