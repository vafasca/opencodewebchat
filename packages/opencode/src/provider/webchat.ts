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

const normRole = (role: unknown) => {
  if (role === "system") return "System"
  if (role === "assistant") return "Assistant"
  if (role === "tool") return "Tool"
  return "User"
}

const pick = (msg: Parameters<LanguageModelV2["doGenerate"]>[0]["prompt"][number]) => {
  if (Array.isArray(msg.content)) {
    return msg.content.map((part) => pickText(part) || pickFile(part)).filter(Boolean)
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

const protocol = () =>
  [
    "",
    "TOOLS PROTOCOL (MANDATORY):",
    "- If the task needs actions in filesystem/terminal, respond ONLY with a single ```opencode-actions block.",
    "- The block MUST be valid JSON with shape: {\"actions\":[...]}.",
    "- Use native tools: bash, write, edit, read, glob, grep, apply_patch, webfetch, todowrite, todoread.",
    "- Do not include explanations outside the block when using tools.",
    "- Example:",
    "```opencode-actions",
    '{"actions":[{"tool":"bash","cmd":"npm create ..."},{"tool":"write","file":"src/app/app.component.ts","content":"..."}]}',
    "```",
  ].join("\n")


const format = (
  prompt: Parameters<LanguageModelV2["doGenerate"]>[0]["prompt"],
  system?: string,
  tools?: unknown,
) => {
  const out: string[] = []
  if (system?.trim()) out.push(`System:\n${system.trim()}`)
  for (const msg of prompt) {
    const role = normRole(msg.role)
    const chunks = pick(msg)
    if (!chunks.length) continue
    out.push(`${role}:\n${chunks.join("\n")}`)
  }
  const body = out.join("\n\n")
  if (!hasTools(tools)) return body
  return `${body}\n\n${protocol()}`
}

const parse = (raw: string) => {
  const body = [...raw.matchAll(/```opencode-actions\s*\n([\s\S]*?)```/gi)].map((item) => item[1] ?? "")
  const list = body.length ? body : [raw]
  const out: { tool: string; input: Record<string, unknown> }[] = []
  for (const item of list) {
    const txt = item.trim()
    if (!txt) continue
    try {
      const data = JSON.parse(txt)
      if (!data || typeof data !== "object" || !("actions" in data) || !Array.isArray(data.actions)) continue
      for (const row of data.actions) {
        if (!row || typeof row !== "object" || !("tool" in row) || typeof row.tool !== "string") continue
        const input: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(row)) {
          if (k === "tool") continue
          input[k] = v
        }
        out.push({ tool: row.tool, input })
      }
    } catch {
      continue
    }
  }
  return out
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
    const raw = await Webchat.run({
      prompt,
      browser: model.browser,
      target: model.target,
      url: cfg.webchat?.url,
      timeout: cfg.webchat?.timeout,
      input: cfg.webchat?.input_selector,
      response: cfg.webchat?.response_selector,
      settle: cfg.webchat?.settle,
      headless: cfg.webchat?.headless,
      sessionID: pickSession(options.headers),
    })
    const calls = parse(raw)
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
    const raw = await Webchat.run({
      prompt,
      browser: model.browser,
      target: model.target,
      url: cfg.webchat?.url,
      timeout: cfg.webchat?.timeout,
      input: cfg.webchat?.input_selector,
      response: cfg.webchat?.response_selector,
      settle: cfg.webchat?.settle,
      headless: cfg.webchat?.headless,
      sessionID: pickSession(options.headers),
    })
    const calls = parse(raw)
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
