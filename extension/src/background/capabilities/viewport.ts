import { cdpCommand, debuggerAttached } from "../cdp"
import {
  ensureDebuggerSession, fetchInterceptionEnabled, networkCaptureConfigs, networkOverrideConfigs,
} from "../network-capture"
import { viewportOverrides, viewportDebuggerTabs, type ViewportOverride } from "../viewport-state"

function networkHoldsDebugger(tabId: number): boolean {
  return networkCaptureConfigs.get(tabId)?.enabled === true
    || (networkOverrideConfigs.get(tabId)?.length || 0) > 0
    || fetchInterceptionEnabled.has(tabId)
}

async function releaseViewportDebugger(tabId: number): Promise<void> {
  if (!viewportDebuggerTabs.has(tabId)) return
  if (!networkHoldsDebugger(tabId) && debuggerAttached.has(tabId)) {
    await chrome.debugger.detach({ tabId })
    debuggerAttached.delete(tabId)
  }
  viewportDebuggerTabs.delete(tabId)
}

export async function handleViewportActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  switch (action.type) {
    case "viewport_get":
      return { success: true, data: viewportOverrides.get(tabId) ?? null }
    case "viewport_set": {
      const { width, height, deviceScaleFactor, mobile } = action
      // Raw/MCP actions must obey the same contract as the CLI parser.
      if (typeof width !== "number" || !Number.isSafeInteger(width) || width <= 0
        || typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0
        || typeof deviceScaleFactor !== "number" || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0
        || typeof mobile !== "boolean") {
        return { success: false, error: "viewport requires positive integer width/height, positive dpr, and boolean mobile" }
      }
      const override: ViewportOverride = { width, height, deviceScaleFactor, mobile }
      const openedForViewport = !debuggerAttached.has(tabId)
      await ensureDebuggerSession(tabId)
      if (openedForViewport) viewportDebuggerTabs.add(tabId)
      try {
        // Keep the debugger attached: detaching discards Emulation overrides.
        await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", override)
        viewportOverrides.set(tabId, override)
      } catch (err) {
        if (openedForViewport) await releaseViewportDebugger(tabId)
        throw err
      }
      return { success: true, data: override }
    }
    case "viewport_reset":
      await cdpCommand(tabId, "Emulation.clearDeviceMetricsOverride")
      viewportOverrides.delete(tabId)
      await releaseViewportDebugger(tabId)
      return { success: true, data: null }
    default:
      return { success: false, error: `unknown viewport action: ${action.type}` }
  }
}
