import { Hono } from "hono"
import { validator } from "hono-openapi"
import z from "zod"
import { ChatWeb } from "@/chatweb/service"
import { SessionID } from "@/session/schema"

export function ChatWebRoutes() {
  return new Hono()
    .get("/status", async (c) => {
      const status = await ChatWeb.status()
      return c.json({ success: true, status })
    })
    .post(
      "/login",
      validator(
        "json",
        z.object({
          ai: z.string(),
          browser: z.string(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        try {
          const parsed = ChatWeb.parse(body)
          const data = await ChatWeb.startLogin(parsed)
          return c.json({ success: true, ...data })
        } catch (err) {
          return c.json(
            {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            },
            500,
          )
        }
      },
    )
    .put(
      "/login",
      validator(
        "json",
        z.object({
          ai: z.string(),
          browser: z.string(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        try {
          const parsed = ChatWeb.parse(body)
          await ChatWeb.confirmLogin(parsed)
          return c.json({ success: true })
        } catch (err) {
          return c.json(
            {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            },
            500,
          )
        }
      },
    )
    .delete(
      "/login",
      validator(
        "json",
        z.object({
          ai: z.string(),
          browser: z.string(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        try {
          const parsed = ChatWeb.parse(body)
          await ChatWeb.cancelLogin(parsed)
          return c.json({ success: true })
        } catch (err) {
          return c.json(
            {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            },
            500,
          )
        }
      },
    )
    .post(
      "/mode",
      validator(
        "json",
        z.object({
          sessionID: SessionID.zod,
          enabled: z.boolean(),
          ai: z.string(),
          browser: z.string(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const parsed = ChatWeb.parse({ ai: body.ai, browser: body.browser })
        ChatWeb.setMode({
          sessionID: body.sessionID,
          enabled: body.enabled,
          ai: parsed.ai,
          kind: parsed.kind,
        })
        return c.json({ success: true })
      },
    )
}
