import { describe, expect, test } from "bun:test"
import { buildViewportAction } from "../cli/commands/viewport"
import { parseTabsCommand } from "../cli/commands/tabs"
import { normalizeArgs } from "../cli/normalize"

describe("viewport parser", () => {
  test("defaults to height 800, dpr 1, and desktop emulation", () => {
    for (const width of [320, 390, 1280]) {
      expect(buildViewportAction([String(width)])).toEqual({
        type: "viewport_set", width, height: 800, deviceScaleFactor: 1, mobile: false,
      })
    }
  })

  test("parses explicit height, mobile, fractional dpr, and target tab", () => {
    expect(buildViewportAction(["390", "844", "--mobile", "--dpr", "2.5", "--tab", "42"])).toEqual({
      type: "viewport_set", width: 390, height: 844, deviceScaleFactor: 2.5, mobile: true, tabId: 42,
    })
  })

  test("routes normalized arguments with flags before dimensions", async () => {
    expect(await parseTabsCommand(normalizeArgs(["viewport", "--dpr=3", "--mobile", "390", "844"]))).toEqual({
      type: "viewport_set", width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    })
  })

  test("no dimensions gets the override", async () => {
    expect(buildViewportAction([])).toEqual({ type: "viewport_get" })
    expect(buildViewportAction(["--tab", "42"])).toEqual({ type: "viewport_get", tabId: 42 })
    expect(await parseTabsCommand(["viewport"])).toEqual({ type: "viewport_get" })
  })

  test("reset accepts a target tab", async () => {
    expect(buildViewportAction(["reset"])).toEqual({ type: "viewport_reset" })
    expect(buildViewportAction(["reset", "--tab", "42"])).toEqual({ type: "viewport_reset", tabId: 42 })
    expect(await parseTabsCommand(["viewport", "reset"])).toEqual({ type: "viewport_reset" })
  })

  test("rejects invalid widths and heights strictly", () => {
    for (const bad of ["0", "-1", "1.5", "320px", "3e2", "NaN", "Infinity", "", "9007199254740992"]) {
      expect(() => buildViewportAction([bad])).toThrow("width must be a positive integer")
      expect(() => buildViewportAction(["320", bad])).toThrow("height must be a positive integer")
    }
  })

  test("invalid width exits the CLI with status 1 before contacting the daemon", () => {
    const result = Bun.spawnSync([process.execPath, "run", `${import.meta.dir}/../cli/index.ts`, "viewport", "320px"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("width must be a positive integer")
  })

  test("rejects invalid or missing dpr and tab values", () => {
    for (const bad of ["0", "-1", "NaN", "Infinity", "2x", "0x2", ""]) {
      expect(() => buildViewportAction(["320", "--dpr", bad])).toThrow("--dpr must be a positive number")
    }
    expect(() => buildViewportAction(["320", "--dpr"])).toThrow("--dpr must be a positive number")
    expect(() => buildViewportAction(["320", "--tab", "42oops"])).toThrow("--tab must be a positive integer")
  })

  test("rejects surplus args, unknown flags, and options without dimensions", () => {
    expect(() => buildViewportAction(["320", "800", "900"])).toThrow("usage:")
    expect(() => buildViewportAction(["320", "--bogus"])).toThrow("unknown viewport flag")
    for (const args of [["reset", "320"], ["reset", "--mobile"], ["--mobile"], ["--dpr", "2"]]) {
      expect(() => buildViewportAction(args)).toThrow("viewport get/reset only accepts --tab")
    }
  })
})
