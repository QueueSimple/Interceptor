export type ViewportOverride = {
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
}

export const viewportOverrides = new Map<number, ViewportOverride>()
// Only tabs whose debugger session was opened for viewport emulation.
export const viewportDebuggerTabs = new Set<number>()

export function clearViewportState(tabId: number): void {
  viewportOverrides.delete(tabId)
  viewportDebuggerTabs.delete(tabId)
}
