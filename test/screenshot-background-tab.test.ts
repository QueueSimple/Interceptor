/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { handleScreenshotActions, withCaptureVisibleTabFocus } from "../extension/src/background/capabilities/screenshot"

// Record the window at activation time: checking only the final tab location
// would miss activating in the user's window before moving to the agent window.
const AGENT_WINDOW = 9
const USER_WINDOW = 1
const TARGET = 200
const GROUP = 42
const PAYLOAD = "data:image/png;base64,cGl4ZWxz"
type FakeTab = { id: number; active: boolean; windowId: number; groupId: number }

const originalChrome = globalThis.chrome
const originalCanvas = globalThis.OffscreenCanvas
const originalBitmap = globalThis.createImageBitmap
let tabs: FakeTab[]
let stored: Record<string, unknown>
let activations: Array<{ tabId: number; windowId: number }>
let moves: Array<{ groupId?: number; tabId?: number; windowId: number }>
let captures: number[]
let creates: chrome.windows.CreateData[]
let messages: Array<{ type: string; windowId: number; y?: number }>
let captureError: boolean
let createFails: boolean
let moveFails: boolean
let agentMinimized: boolean

beforeEach(() => {
  tabs = [
    { id: 100, active: true, windowId: USER_WINDOW, groupId: -1 },
    { id: TARGET, active: false, windowId: USER_WINDOW, groupId: GROUP },
    { id: 201, active: false, windowId: USER_WINDOW, groupId: GROUP },
    { id: 300, active: true, windowId: 2, groupId: -1 },
  ]
  stored = {}
  activations = []
  moves = []
  captures = []
  creates = []
  messages = []
  captureError = createFails = moveFails = agentMinimized = false
  const area = {
    get: async () => stored,
    set: async (values: Record<string, unknown>) => { Object.assign(stored, values) },
  }
  globalThis.chrome = {
    storage: { session: area },
    runtime: {},
    windows: {
      create: async (props: chrome.windows.CreateData) => {
        creates.push(props)
        if (createFails) throw new Error("window creation failed")
        return { id: AGENT_WINDOW, type: "normal" }
      },
      get: async (id: number) => {
        if (id === 99) throw new Error("window closed")
        return { id, type: "normal", state: id === AGENT_WINDOW && agentMinimized ? "minimized" : "normal" }
      },
    },
    tabGroups: {
      move: async (groupId: number, props: chrome.tabGroups.MoveProperties) => {
        if (moveFails) throw new Error("group move failed")
        moves.push({ groupId, windowId: props.windowId! })
        for (const tab of tabs.filter(t => t.groupId === groupId)) tab.windowId = props.windowId!
      },
    },
    tabs: {
      get: async (id: number) => {
        const tab = tabs.find(t => t.id === id)
        if (!tab) throw new Error("tab vanished")
        return { ...tab }
      },
      move: async (id: number, props: chrome.tabs.MoveProperties) => {
        moves.push({ tabId: id, windowId: props.windowId! })
        tabs.find(t => t.id === id)!.windowId = props.windowId!
      },
      update: async (id: number, props: chrome.tabs.UpdateProperties) => {
        const target = tabs.find(t => t.id === id)!
        if (props.active) {
          activations.push({ tabId: id, windowId: target.windowId })
          for (const tab of tabs.filter(t => t.windowId === target.windowId)) tab.active = tab.id === id
        }
        return { ...target }
      },
      captureVisibleTab: async (windowId: number) => {
        captures.push(windowId)
        expect(tabs.find(t => t.windowId === windowId && t.active)?.id).toBe(TARGET)
        if (captureError) throw new Error("capture failed")
        return PAYLOAD
      },
      sendMessage: (id: number, msg: { action: { type: string; y?: number } }, _opts: unknown, cb: (r: unknown) => void) => {
        const action = msg.action
        const windowId = tabs.find(t => t.id === id)!.windowId
        messages.push({ type: action.type, windowId, y: action.y })
        if (action.type === "dom_screenshot") cb({ success: false, error: "image load failed" })
        else if (action.type === "get_page_dimensions") cb({
          success: true,
          data: { scrollHeight: 20, scrollWidth: 10, viewportHeight: 10, viewportWidth: 10, scrollY: 3, devicePixelRatio: 1 },
        })
        else cb({ success: true })
      },
    },
    declarativeNetRequest: {
      updateSessionRules: async () => {},
      getSessionRules: async () => [],
    },
  } as unknown as typeof chrome
  globalThis.OffscreenCanvas = class {
    getContext() { return { drawImage() {} } }
    async convertToBlob() { return new Blob(["pixels"], { type: "image/png" }) }
  } as unknown as typeof OffscreenCanvas
  globalThis.createImageBitmap = (async () => ({ width: 10, height: 10, close() {} })) as unknown as typeof createImageBitmap
})

afterEach(() => {
  globalThis.chrome = originalChrome
  globalThis.OffscreenCanvas = originalCanvas
  globalThis.createImageBitmap = originalBitmap
})

function expectSafeActivation() {
  expect(activations).toEqual([{ tabId: TARGET, windowId: AGENT_WINDOW }])
  expect(tabs.find(t => t.id === 100)?.active).toBe(true)
  expect(tabs.find(t => t.id === 300)?.active).toBe(true)
  expect(tabs.find(t => t.id === TARGET)?.windowId).toBe(AGENT_WINDOW)
  expect(captures.every(w => w === AGENT_WINDOW)).toBe(true)
}

describe("pixel capture in the unfocused agent window", () => {
  test("moves the whole group before activation and passes the agent window id to capture", async () => {
    const result = await withCaptureVisibleTabFocus(TARGET, id => chrome.tabs.captureVisibleTab(id))
    expect(result).toBe(PAYLOAD)
    expect(creates).toEqual([{ url: "about:blank", focused: false }])
    expect(moves).toEqual([{ groupId: GROUP, windowId: AGENT_WINDOW }])
    expect(captures).toEqual([AGENT_WINDOW])
    expectSafeActivation()
    expect(tabs.find(t => t.id === 201)).toMatchObject({ windowId: AGENT_WINDOW, groupId: GROUP })
  })

  test("leaves the group in the agent window when capture throws, without restoring user tabs", async () => {
    captureError = true
    await expect(withCaptureVisibleTabFocus(TARGET, id => chrome.tabs.captureVisibleTab(id))).rejects.toThrow("capture failed")
    expectSafeActivation()
    expect(moves).toHaveLength(1)
  })

  test("reuses a stored agent window when the target is already there", async () => {
    stored.agentWindowId = AGENT_WINDOW
    tabs.find(t => t.id === TARGET)!.windowId = AGENT_WINDOW
    await withCaptureVisibleTabFocus(TARGET, id => chrome.tabs.captureVisibleTab(id))
    expect(creates).toEqual([])
    expect(moves).toEqual([])
    expect(captures).toEqual([AGENT_WINDOW])
    expectSafeActivation()
  })

  test("recreates a closed agent window", async () => {
    stored.agentWindowId = 99
    await withCaptureVisibleTabFocus(TARGET, id => chrome.tabs.captureVisibleTab(id))
    expect(creates).toHaveLength(1)
    expect(stored.agentWindowId).toBe(AGENT_WINDOW)
    expectSafeActivation()
  })

  test("moves an ungrouped tab before activation", async () => {
    tabs.find(t => t.id === TARGET)!.groupId = -1
    await withCaptureVisibleTabFocus(TARGET, id => chrome.tabs.captureVisibleTab(id))
    expect(moves).toEqual([{ tabId: TARGET, windowId: AGENT_WINDOW }])
    expectSafeActivation()
  })

  test("a target already active is captured in place, never pulled out of its window", async () => {
    tabs[0]!.active = false
    const target = tabs.find(t => t.id === TARGET)!
    target.active = true
    await withCaptureVisibleTabFocus(TARGET, id => chrome.tabs.captureVisibleTab(id))
    expect(moves).toEqual([])
    expect(activations).toEqual([])
    expect(captures).toEqual([target.windowId])
  })

  test("window creation failure never activates or captures in the user's window", async () => {
    createFails = true
    await expect(withCaptureVisibleTabFocus(TARGET, id => chrome.tabs.captureVisibleTab(id))).rejects.toThrow("window creation failed")
    expect(activations).toEqual([])
    expect(captures).toEqual([])
  })

  test("MV2/Electron (no windows.create) activates in place: no separate user window exists", async () => {
    delete (chrome.windows as Partial<typeof chrome.windows>).create
    await withCaptureVisibleTabFocus(TARGET, id => chrome.tabs.captureVisibleTab(id))
    expect(moves).toEqual([])
    expect(activations.map(a => a.tabId)).toEqual([TARGET])
  })

  test("group move failure never activates or captures in the user's window", async () => {
    moveFails = true
    await expect(withCaptureVisibleTabFocus(TARGET, id => chrome.tabs.captureVisibleTab(id))).rejects.toThrow("group move failed")
    expect(activations).toEqual([])
    expect(captures).toEqual([])
  })

  test("missing group move API fails without detaching the target from its group", async () => {
    delete (chrome.tabGroups as Partial<typeof chrome.tabGroups>).move
    await expect(withCaptureVisibleTabFocus(TARGET, id => chrome.tabs.captureVisibleTab(id))).rejects.toThrow("cannot move tab group")
    expect(moves).toEqual([])
    expect(activations).toEqual([])
    expect(captures).toEqual([])
  })

  test("explicit --pixel viewport capture uses the agent window id", async () => {
    const result = await handleScreenshotActions({ type: "screenshot", pixel: true, format: "png" }, TARGET)
    expect(result.success).toBe(true)
    expect(captures).toEqual([AGENT_WINDOW])
    expectSafeActivation()
  })

  test("explicit full-page capture measures and captures every strip in the agent window", async () => {
    const result = await handleScreenshotActions({ type: "screenshot", pixel: true, full: true, format: "png" }, TARGET)
    expect(result.success).toBe(true)
    expect(captures).toEqual([AGENT_WINDOW, AGENT_WINDOW])
    expect(messages.every(m => m.windowId === AGENT_WINDOW)).toBe(true)
    expect(messages.at(-1)).toMatchObject({ type: "scroll_absolute", y: 3 })
    expectSafeActivation()
  })

  test("automatic DOM-render fallback captures every strip in the agent window", async () => {
    const result = await handleScreenshotActions({ type: "screenshot" }, TARGET)
    expect(result.success).toBe(true)
    expect(captures).toEqual([AGENT_WINDOW, AGENT_WINDOW])
    expect(messages[0]).toMatchObject({ type: "dom_screenshot", windowId: USER_WINDOW })
    expect(messages.slice(1).every(m => m.windowId === AGENT_WINDOW)).toBe(true)
    expect(result.data).toMatchObject({ fallback: expect.stringContaining("unfocused agent window") })
    expectSafeActivation()
  })

  test("a failed full-page capture restores scroll but leaves the group in the agent window", async () => {
    captureError = true
    const result = await handleScreenshotActions({ type: "screenshot", pixel: true, full: true }, TARGET)
    expect(result.success).toBe(false)
    expect(result.error).toContain("capture failed")
    expect(messages.at(-1)).toMatchObject({ type: "scroll_absolute", y: 3 })
    expectSafeActivation()
  })

  test("--no-fallback returns the DOM error without moving or activating tabs", async () => {
    const result = await handleScreenshotActions({ type: "screenshot", no_fallback: true }, TARGET)
    expect(result.success).toBe(false)
    expect(result.error).toContain("image load failed")
    expect(moves).toEqual([])
    expect(activations).toEqual([])
    expect(captures).toEqual([])
  })

  test("a minimized agent window fails preflight without capturing or touching user tabs", async () => {
    agentMinimized = true
    const result = await handleScreenshotActions({ type: "screenshot", pixel: true }, TARGET)
    expect(result.success).toBe(false)
    expect(result.error).toContain("agent window 9 is minimized")
    expect(captures).toEqual([])
    expectSafeActivation()
  })
})
