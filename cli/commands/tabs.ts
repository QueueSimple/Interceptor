/**
 * cli/commands/tabs.ts — tabs, tab new/close/switch, window, frames, session
 *
 * Returns null for "session" subcommands (handled locally, no daemon needed).
 */

import { unlinkSync } from "node:fs"
import { writeFileSync } from "node:fs"

type Action = { type: string; [key: string]: unknown }

export async function parseTabsCommand(filtered: string[]): Promise<Action | null> {
  const cmd = filtered[0]

  switch (cmd) {
    case "tabs":
      return { type: "tab_list" }

    case "tab":
      switch (filtered[1]) {
        case "new": {
          // Background-first by default; --activate is the opt-in.
          const action: Action = { type: "tab_create", url: filtered[2] }
          if (filtered.includes("--activate")) action.active = true
          return action
        }
        case "close": {
          const idArg = filtered[2] && !filtered[2].startsWith("--") ? filtered[2] : undefined
          const action: Action = idArg
            ? { type: "tab_close", tabId: parseInt(idArg) }
            : { type: "tab_close" }
          // Explicit opt-in to close a tab OUTSIDE the interceptor group
          // (e.g. pre-existing junk tabs). Auditable escape hatch — replaces
          // the old seat-an-about:blank loophole.
          if (filtered.includes("--any")) action.anyTab = true
          return action
        }
        case "switch":
          return { type: "tab_switch", tabId: parseInt(filtered[2]) }
        case "sweep":
          return { type: "tab_sweep" }
        default:
          console.error("error: unknown tab subcommand. Use: new, close, switch, sweep")
          process.exit(1)
      }
      break

    case "window":
      switch (filtered[1]) {
        case "new":
          return { type: "window_create", url: filtered[2], incognito: filtered.includes("--incognito") }
        case "close":
          return { type: "window_close", windowId: parseInt(filtered[2]) }
        case "focus":
          return { type: "window_focus", windowId: parseInt(filtered[2]) }
        case "resize":
          return {
            type: "window_resize",
            windowId: filtered[2] ? parseInt(filtered[2]) : undefined,
            width: parseInt(filtered[3]),
            height: parseInt(filtered[4])
          }
        case "list":
        default:
          return { type: "window_list" }
      }

    case "frames":
      return { type: "frames_list" }

    case "session": {
      const sessionPath = "/tmp/interceptor-session.pid"
      if (filtered[1] === "start") {
        writeFileSync(sessionPath, `${process.pid}\n${Date.now()}`)
        console.log(`session started (pid: ${process.pid})`)
        console.log("session mode: batch commands recommended for best performance")
        return null
      }
      if (filtered[1] === "end") {
        try { unlinkSync(sessionPath) } catch {}
        console.log("session ended")
        return null
      }
      console.error("error: usage: interceptor session start|end")
      process.exit(1)
    }

    default:
      console.error(`error: unknown tabs command '${cmd}'`)
      process.exit(1)
  }
}
