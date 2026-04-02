import { Config } from "@/config/config"
import { Webchat } from "@/webchat"
import { generateId } from "ai"
import type {
  LanguageModelV2,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  SharedV2ProviderMetadata,
} from "@ai-sdk/provider"

const pickText = (part: unknown) => {
  if (!part || typeof part !== "object") return ""
  if (!("type" in part) || !("text" in part)) return ""
  if (part.type !== "text" || typeof part.text !== "string") return ""
  return part.text
}

const pickFile = (part: unknown) => {
  if (!part || typeof part !== "object") return ""
  if (!("type" in part) || !("mediaType" in part) || !("filename" in part)) return ""
  if (part.type !== "file") return ""
  const name = typeof part.filename === "string" ? part.filename : "archivo"
  const type = typeof part.mediaType === "string" ? part.mediaType : ""
  return type ? `[file:${name}:${type}]` : `[file:${name}]`
}


const pickTool = (part: unknown) => {
  if (!part || typeof part !== "object") return ""
  if (!("type" in part) || typeof part.type !== "string") return ""
  if (part.type === "tool-call") {
    const name = "toolName" in part && typeof part.toolName === "string" ? part.toolName : "unknown"
    const input = "input" in part ? (typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {})) : "{}"
    return `TOOL_CALL ${name} ${input}`
  }
  if (part.type === "tool-result") {
    const name = "toolName" in part && typeof part.toolName === "string" ? part.toolName : "unknown"
    const raw =
      "output" in part
        ? part.output
        : "result" in part
          ? part.result
          : "content" in part
            ? part.content
            : {}
    const result = typeof raw === "string" ? raw : JSON.stringify(raw ?? {})
    const text = result.length > 3000 ? `${result.slice(0, 3000)}…[truncated]` : result
    return `TOOL_RESULT ${name} ${text}`
  }
  return ""
}

const normRole = (role: unknown) => {
  if (role === "system") return "System"
  if (role === "assistant") return "Assistant"
  if (role === "tool") return "Tool"
  return "User"
}

const pick = (msg: Parameters<LanguageModelV2["doGenerate"]>[0]["prompt"][number]) => {
  if (Array.isArray(msg.content)) {
    return msg.content.map((part) => pickText(part) || pickFile(part) || pickTool(part)).filter(Boolean)
  }
  if (typeof msg.content === "string") {
    const txt = msg.content.trim()
    return txt ? [txt] : []
  }
  if (!msg.content || typeof msg.content !== "object") return []
  if ("text" in msg.content && typeof msg.content.text === "string") {
    const txt = msg.content.text.trim()
    return txt ? [txt] : []
  }
  return []
}


const hasTools = (tools: unknown) => {
  if (Array.isArray(tools)) return tools.length > 0
  if (!tools || typeof tools !== "object") return false
  if ("length" in tools && typeof tools.length === "number") return tools.length > 0
  return Object.keys(tools).length > 0
}

const protocol = (tools?: unknown, bash?: boolean) => {
  const names = Array.from(pickNames(tools)).sort()
  const list = names.length ? names.join(", ") : "bash, read, glob, grep, apply_patch"
  return [
    "",
    "TOOLS PROTOCOL (MANDATORY):",
    "- If the task needs actions in filesystem/terminal, respond ONLY with a single ```opencode-actions block.",
    "- The block MUST be valid JSON with shape: {\"actions\":[...]}",
    "- Return EXACTLY ONE action per assistant response (actions length must be 1).",
    "- Wait for TOOL_RESULT before deciding the next action.",
    "- Prefer reactive flow: inspect -> execute -> inspect result -> next action.",
    "- Use only tools available in this environment.",
    `- Available tools: ${list}.`,
    ...(names.includes("write")
      ? ["- For full file replacement use write; for targeted edits use apply_patch."]
      : names.includes("apply_patch")
        ? ["- write is not available; use apply_patch for file edits."]
        : []),
    ...(bash
      ? [
          "- bash is currently failing with ENOENT/uv_spawn in this environment; do not retry the same bash command.",
          "- If bash is required, use the question tool once to ask the user to fix shell path (eg OPENCODE_GIT_BASH_PATH) before continuing.",
        ]
      : []),
    "- Do not include explanations outside the block when using tools.",
    "- Example:",
    "```opencode-actions",
    '{"actions":[{"tool":"bash","cmd":"npm create ..."}]}',
    "```",
  ].join("\n")
}

const isErr = (txt: string) => /(?:\berror\b|\bfailed\b|\bexception\b|\bnot found\b|\bno such\b)/i.test(txt)
const isBashErr = (txt: string) => /TOOL_RESULT bash .*?(?:ENOENT|uv_spawn)/i.test(txt)

const format = (
  prompt: Parameters<LanguageModelV2["doGenerate"]>[0]["prompt"],
  system?: string,
  tools?: unknown,
) => {
  const out: string[] = []
  const bad = prompt
    .filter((msg) => msg.role === "tool")
    .flatMap((msg) => pick(msg))
    .some((line) => isBashErr(line))
  if (system?.trim()) out.push(`System:\n${system.trim()}`)
  const idx = prompt
    .map((msg, i) => (msg.role === "tool" ? i : -1))
    .filter((i) => i >= 0)
  const keep = new Set(idx.slice(-3))
  for (let i = 0; i < prompt.length; i++) {
    const msg = prompt[i]
    const role = normRole(msg.role)
    let chunks = pick(msg)
    if (msg.role === "assistant") {
      chunks = chunks.filter((line) => line.startsWith("TOOL_CALL "))
    }
    if (msg.role === "tool" && !keep.has(i)) {
      chunks = chunks.filter((line) => !isErr(line))
    }
    if (!chunks.length) continue
    out.push(`${role}:\n${chunks.join("\n")}`)
  }
  const body = out.join("\n\n")
  if (!hasTools(tools)) return body
  return `${body}\n\n${protocol(tools, bad)}`
}

const pickObjects = (txt: string) => {
  const out: string[] = []
  let depth = 0
  let from = -1
  let str = false
  let esc = false
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i]
    if (str) {
      if (esc) {
        esc = false
        continue
      }
      if (ch === "\\") {
        esc = true
        continue
      }
      if (ch === '"') str = false
      continue
    }
    if (ch === '"') {
      str = true
      continue
    }
    if (ch === "{") {
      if (depth === 0) from = i
      depth += 1
      continue
    }
    if (ch !== "}") continue
    if (depth === 0) continue
    depth -= 1
    if (depth !== 0 || from < 0) continue
    out.push(txt.slice(from, i + 1))
    from = -1
  }
  return out
}

const parse = (raw: string) => {
  const groups = [
    ...[...raw.matchAll(/```opencode-actions\s*\n([\s\S]*?)```/gi)].map((item) => item[1] ?? ""),
    ...[...raw.matchAll(/opencode-actions\s*([\s\S]*?)(?=(?:opencode-actions\s*)|$)/gi)].map((item) => item[1] ?? ""),
    raw,
  ]
  const out: { tool: string; input: Record<string, unknown> }[] = []

  const push = (txt: string) => {
    try {
      const data = JSON.parse(txt)
      if (!data || typeof data !== "object" || !("actions" in data) || !Array.isArray(data.actions)) return false
      for (const row of data.actions) {
        if (!row || typeof row !== "object" || !("tool" in row) || typeof row.tool !== "string") continue
        const input: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(row)) {
          if (k === "tool") continue
          input[k] = v
        }
        out.push({ tool: row.tool, input })
      }
      return true
    } catch {
      return false
    }
  }

  for (const item of groups) {
    const txt = item.trim()
    if (!txt) continue
    if (push(txt)) continue

    const first = txt.indexOf("{")
    const last = txt.lastIndexOf("}")
    if (first >= 0 && last > first && push(txt.slice(first, last + 1))) continue

    for (const chunk of pickObjects(txt)) {
      push(chunk)
    }
  }

  return out
}



const pickNames = (tools?: unknown) => {
  if (!tools || typeof tools !== "object") return new Set<string>()
  if (Array.isArray(tools)) {
    return new Set(
      tools
        .flatMap((item) => {
          if (!item || typeof item !== "object") return [] as string[]
          if (!("name" in item) || typeof item.name !== "string") return [] as string[]
          return [item.name]
        })
        .filter(Boolean),
    )
  }
  return new Set(Object.keys(tools as Record<string, unknown>))
}

const pickDesc = (input: Record<string, unknown>) => {
  const cmd = typeof input.command === "string" ? input.command : ""
  if (!cmd.trim()) return "Run shell command"
  const head = cmd.split(/\s+/).slice(0, 8).join(" ").trim()
  return head ? `Run: ${head}` : "Run shell command"
}



const makePatch = (file: string, content: string) => {
  const body = content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((item) => `+${item}`)
    .join("\n")
  return ["*** Begin Patch", `*** Add File: ${file}`, body, "*** End Patch"].join("\n")
}

const rewriteBash = (input: Record<string, unknown>) => {
  const cmd = typeof input.command === "string" ? input.command.trim() : ""
  const m = cmd.match(/^cd\s+([^&;]+?)\s*&&\s*(.+)$/)
  if (!m) return input
  const dir = m[1]?.trim()
  const next = m[2]?.trim()
  if (!dir || !next) return input
  return {
    ...input,
    command: next,
    workdir: typeof input.workdir === "string" && input.workdir.trim() ? input.workdir : dir,
  }
}

const normalizeCall = (call: { tool: string; input: Record<string, unknown> }, tools?: unknown) => {
  const names = pickNames(tools)
  const tool = call.tool === "shell" ? "bash" : call.tool
  const input = { ...call.input }

  if (tool === "apply_patch") {
    if (typeof input.patchText !== "string" && typeof input.patch === "string") input.patchText = input.patch
    delete input.patch
  }

  if (tool === "bash") {
    if (typeof input.command !== "string" && typeof input.cmd === "string") input.command = input.cmd
    delete input.cmd
    const next = rewriteBash(input)
    Object.assign(input, next)
    if (typeof input.description !== "string") input.description = pickDesc(input)
  }

  if (tool === "write") {
    if (typeof input.filePath !== "string" && typeof input.file === "string") input.filePath = input.file
    delete input.file
  }

  if (tool === "read") {
    if (typeof input.filePath !== "string" && typeof input.file === "string") input.filePath = input.file
    if (typeof input.filePath !== "string" && typeof input.path === "string") input.filePath = input.path
    delete input.file
    delete input.path
  }

  if (!names.size || names.has(tool) || tool === "invalid") {
    return { tool, input }
  }

  if (tool === "write" && names.has("apply_patch")) {
    const file = typeof input.filePath === "string" ? input.filePath : typeof call.input.file === "string" ? call.input.file : ""
    if (file && typeof input.content === "string") {
      return {
        tool: "apply_patch",
        input: {
          patchText: makePatch(file, input.content),
        },
      }
    }
  }

  return {
    tool: "invalid",
    input: {
      tool,
      error: `Model tried unavailable tool '${tool}'. Available tools: ${Array.from(names).join(", ")}. Payload: ${JSON.stringify(input)}`
    },
  }
}


const pickDone = (prompt: Parameters<LanguageModelV2["doGenerate"]>[0]["prompt"]) => {
  const set = new Set<string>()
  for (const msg of prompt) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue
      if (!("type" in part) || part.type !== "tool-call") continue
      if (!("toolName" in part) || typeof part.toolName !== "string") continue
      const key = `${part.toolName}:${typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {})}`
      set.add(key)
    }
  }
  return set
}

const pickStep = (
  list: { tool: string; input: Record<string, unknown> }[],
  prompt: Parameters<LanguageModelV2["doGenerate"]>[0]["prompt"],
) => {
  if (list.length <= 1) return list
  const done = pickDone(prompt)
  for (const item of list) {
    const key = `${item.tool}:${JSON.stringify(item.input)}`
    if (!done.has(key)) return [item]
  }
  return [list[0]]
}

const pickCalls = (raw: string, tools?: unknown) => {
  const list = parse(raw).map((item) => normalizeCall(item, tools))
  if (list.length) return list
  if (!hasTools(tools)) return list
  return [
    {
      tool: "invalid",
      input: { tool: "unknown", error: raw.trim() || "No actionable tool block found in webchat response" },
    },
  ]
}



const pickModel = (id: string, cfg: Awaited<ReturnType<typeof Config.get>>) => {
  const part = id.replace(/^webchat-?/, "").split("-").filter(Boolean)
  const target = (part.find((item) => item === "chatgpt" || item === "claude") ?? cfg.webchat?.target ?? "chatgpt") as
    | "chatgpt"
    | "claude"
  const browser = (part.find((item) => item === "chrome" || item === "edge") ?? cfg.webchat?.browser ?? "chrome") as
    | "chrome"
    | "edge"
  return { target, browser }
}

const pickSession = (headers?: Record<string, string | undefined>) => {
  if (!headers) return undefined
  return headers["x-opencode-session"] ?? headers["X-Opencode-Session"] ?? headers["x-opencode-session-id"]
}

const pickOpts = (opts?: Record<string, unknown>) => {
  if (!opts) return {}
  if (!("opencode" in opts)) return {}
  const val = opts["opencode"]
  if (!val || typeof val !== "object") return {}
  return val as Record<string, unknown>
}

const usage = {
  inputTokens: undefined,
  outputTokens: undefined,
  totalTokens: undefined,
  reasoningTokens: undefined,
  cachedInputTokens: undefined,
}

export class WebchatLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const
  readonly provider = "opencode.webchat"
  readonly modelId: string

  constructor(modelId: string) {
    this.modelId = modelId
  }

  async doGenerate(
    options: Parameters<LanguageModelV2["doGenerate"]>[0],
  ): Promise<Awaited<ReturnType<LanguageModelV2["doGenerate"]>>> {
    const cfg = await Config.get()
    const prompt = format(options.prompt, options.system, options.tools)
    const model = pickModel(this.modelId, cfg)
    const opts = pickOpts(options.providerOptions)
    const webchat = (opts.webchat && typeof opts.webchat === "object" ? opts.webchat : {}) as Record<string, unknown>
    const browser = (webchat.browser as "chrome" | "edge" | undefined) ?? model.browser
    const target = (webchat.target as "chatgpt" | "claude" | undefined) ?? model.target
    const raw = await Webchat.run({
      prompt,
      browser,
      target,
      url: (webchat.url as string | undefined) ?? cfg.webchat?.url,
      timeout: (webchat.timeout as number | undefined) ?? cfg.webchat?.timeout,
      input: (webchat.input_selector as string | undefined) ?? cfg.webchat?.input_selector,
      response: (webchat.response_selector as string | undefined) ?? cfg.webchat?.response_selector,
      settle: (webchat.settle as number | undefined) ?? cfg.webchat?.settle,
      headless: (webchat.headless as boolean | undefined) ?? cfg.webchat?.headless,
      sessionID: (opts.sessionID as string | undefined) ?? pickSession(options.headers),
    })
    const calls = pickStep(pickCalls(raw, options.tools), options.prompt)
    const content: LanguageModelV2Content[] = calls.length
      ? calls.map((item) => ({
          type: "tool-call",
          toolCallId: generateId(),
          toolName: item.tool,
          input: JSON.stringify(item.input),
        }))
      : [{ type: "text", text: raw }]

    return {
      content,
      finishReason: calls.length ? "tool-calls" : "stop",
      usage,
      request: { body: JSON.stringify({ model: this.modelId, prompt }) },
      response: {
        id: generateId(),
        modelId: this.modelId,
        body: raw,
      },
      warnings: [],
      providerMetadata: { webchat: { calls: calls.length } },
    }
  }

  async doStream(
    options: Parameters<LanguageModelV2["doStream"]>[0],
  ): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>> {
    const cfg = await Config.get()
    const prompt = format(options.prompt, options.system, options.tools)
    const model = pickModel(this.modelId, cfg)
    const opts = pickOpts(options.providerOptions)
    const webchat = (opts.webchat && typeof opts.webchat === "object" ? opts.webchat : {}) as Record<string, unknown>
    const browser = (webchat.browser as "chrome" | "edge" | undefined) ?? model.browser
    const target = (webchat.target as "chatgpt" | "claude" | undefined) ?? model.target
    const raw = await Webchat.run({
      prompt,
      browser,
      target,
      url: (webchat.url as string | undefined) ?? cfg.webchat?.url,
      timeout: (webchat.timeout as number | undefined) ?? cfg.webchat?.timeout,
      input: (webchat.input_selector as string | undefined) ?? cfg.webchat?.input_selector,
      response: (webchat.response_selector as string | undefined) ?? cfg.webchat?.response_selector,
      settle: (webchat.settle as number | undefined) ?? cfg.webchat?.settle,
      headless: (webchat.headless as boolean | undefined) ?? cfg.webchat?.headless,
      sessionID: (opts.sessionID as string | undefined) ?? pickSession(options.headers),
    })
    const calls = pickStep(pickCalls(raw, options.tools), options.prompt)
    const finishReason: LanguageModelV2FinishReason = calls.length ? "tool-calls" : "stop"
    const providerMetadata: SharedV2ProviderMetadata = { webchat: { calls: calls.length } }

    return {
      stream: new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ type: "response-metadata", id: generateId(), modelId: "webchat" })
          if (!calls.length) {
            controller.enqueue({ type: "text-start", id: "txt-0" })
            controller.enqueue({ type: "text-delta", id: "txt-0", delta: raw })
            controller.enqueue({ type: "text-end", id: "txt-0" })
          }
          calls.forEach((item, i) => {
            const id = `call-${i + 1}`
            const input = JSON.stringify(item.input)
            controller.enqueue({ type: "tool-input-start", id, toolName: item.tool })
            controller.enqueue({ type: "tool-input-delta", id, delta: input })
            controller.enqueue({ type: "tool-input-end", id })
            controller.enqueue({ type: "tool-call", toolCallId: id, toolName: item.tool, input })
          })
          controller.enqueue({ type: "finish", finishReason, usage, providerMetadata })
          controller.close()
        },
      }),
      request: { body: JSON.stringify({ model: this.modelId, prompt }) },
      response: { id: generateId(), modelId: this.modelId },
    }
  }
}
