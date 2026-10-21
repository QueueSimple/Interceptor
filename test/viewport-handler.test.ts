import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { handleViewportActions } from "../extension/src/background/capabilities/viewport"
import { cdpCommand, debuggerAttached, registerCdpListeners } from "../extension/src/background/cdp"
import {
  enableNetworkCapture, fetchInterceptionEnabled, networkCaptureConfigs, networkOverrideConfigs,
} from "../extension/src/background/network-capture"
import { clearViewportState, viewportDebuggerTabs, viewportOverrides } from "../extension/src/background/viewport-state"

const originalChrome = globalThis.chrome
const tabId = 42
const override = { width: 320, height: 800, deviceScaleFactor: 1, mobile: false }
let detachListener: (source: { tabId: number }, reason: string) => void
let attach: ReturnType<typeof mock>
let detach: ReturnType<typeof mock>
let sendCommand: ReturnType<typeof mock>

beforeEach(() => {
  attach = mock(async () => {})
  detach = mock(async () => { detachListener({ tabId }, "target_closed") })
  sendCommand = mock(async () => ({}))
  globalThis.chrome = {
    debugger: {
      attach, detach, sendCommand,
      onEvent: { addListener: () => {} },
      onDetach: { addListener: (listener: typeof detachListener) => { detachListener = listener } },
    },
  } as unknown as typeof chrome
  registerCdpListeners()
})

afterEach(() => {
  globalThis.chrome = originalChrome
  debuggerAttached.clear()
  clearViewportState(tabId)
  networkCaptureConfigs.clear()
  networkOverrideConfigs.clear()
  fetchInterceptionEnabled.clear()
})

const setViewport = () => handleViewportActions({ type: "viewport_set", ...override }, tabId)
const resetViewport = () => handleViewportActions({ type: "viewport_reset" }, tabId)

describe("viewport debugger lifetime", () => {
  test("persists after set and unrelated CDP commands; reset clears before detaching", async () => {
    expect(await setViewport()).toEqual({ success: true, data: override })
    expect(debuggerAttached.has(tabId)).toBe(true)
    expect(viewportDebuggerTabs.has(tabId)).toBe(true)
    expect(detach).not.toHaveBeenCalled()
    await cdpCommand(tabId, "Runtime.evaluate", { expression: "innerWidth" })
    expect(detach).not.toHaveBeenCalled()
    expect(await handleViewportActions({ type: "viewport_get" }, tabId)).toEqual({ success: true, data: override })
    await setViewport()
    expect(attach).toHaveBeenCalledTimes(1)
    await resetViewport()
    expect(sendCommand.mock.calls.at(-1)).toEqual([{ tabId }, "Emulation.clearDeviceMetricsOverride", undefined])
    expect(detach).toHaveBeenCalledTimes(1)
    expect(debuggerAttached.has(tabId)).toBe(false)
    expect(await handleViewportActions({ type: "viewport_get" }, tabId)).toEqual({ success: true, data: null })
  })

  test("reset preserves a debugger originally attached for network capture", async () => {
    await enableNetworkCapture(tabId, [])
    await setViewport()
    await resetViewport()
    expect(detach).not.toHaveBeenCalled()
    expect(debuggerAttached.has(tabId)).toBe(true)
    expect(networkCaptureConfigs.get(tabId)?.enabled).toBe(true)
  })

  test("reset preserves capture enabled after viewport attached", async () => {
    await setViewport()
    await enableNetworkCapture(tabId, [])
    await resetViewport()
    expect(detach).not.toHaveBeenCalled()
    expect(debuggerAttached.has(tabId)).toBe(true)
    expect(networkCaptureConfigs.get(tabId)?.enabled).toBe(true)
  })

  test("reset preserves request interception", async () => {
    await setViewport()
    networkOverrideConfigs.set(tabId, [{ urlPattern: "*", setHeaders: { accept: "text/html" } }])
    fetchInterceptionEnabled.add(tabId)
    await resetViewport()
    expect(detach).not.toHaveBeenCalled()
    expect(fetchInterceptionEnabled.has(tabId)).toBe(true)
  })

  test("external detach clears viewport state and allows a fresh session", async () => {
    await setViewport()
    detachListener({ tabId }, "target_closed")
    expect(viewportOverrides.has(tabId)).toBe(false)
    expect(viewportDebuggerTabs.has(tabId)).toBe(false)
    await setViewport()
    expect(attach).toHaveBeenCalledTimes(2)
  })

  test("failed emulation releases a newly attached session without reporting an override", async () => {
    sendCommand.mockImplementationOnce(async () => { throw new Error("metrics rejected") })
    await expect(setViewport()).rejects.toThrow("metrics rejected")
    expect(viewportOverrides.has(tabId)).toBe(false)
    expect(detach).toHaveBeenCalledTimes(1)
  })

  test("reset with no override sends clear and leaves no debugger attached", async () => {
    await resetViewport()
    expect(sendCommand).toHaveBeenCalledWith({ tabId }, "Emulation.clearDeviceMetricsOverride", undefined)
    expect(debuggerAttached.has(tabId)).toBe(false)
  })
})
