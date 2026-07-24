import { addTabToInterceptorGroup, ensureInterceptorGroup, interceptorGroupId } from "../tab-group"
import { waitForTabLoad } from "../content-bridge"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleTabActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "tab_create": {
      const targetUrl = (action.url as string) || "about:blank"
      // When `reuse` is set, navigate the most recently created tab inside
      // the Interceptor group instead of opening a new one. Long-running
      // automations would otherwise leave a dead tab behind on every call
      // (dora-cc#5). Falls back to creating a new tab if the group is empty
      // or the candidate tab disappeared between query and update.
      if (action.reuse) {
        const groupId = await ensureInterceptorGroup()
        if (groupId !== -1) {
          const groupTabs = await chrome.tabs.query({ groupId })
          if (groupTabs.length > 0) {
            const sorted = groupTabs
              .filter(t => typeof t.id === "number")
              .sort((a, b) => (b.id as number) - (a.id as number))
            const candidate = sorted[0]
            if (candidate?.id !== undefined) {
              try {
                // Reuse path: preserve the candidate tab's current
                // active/inactive state by default — navigating a background
                // tab keeps it in the background, a foreground tab stays
                // foreground. Only pass `active: true` when the caller
                // explicitly asked for activation via `action.active`, so
                // `interceptor open <url> --reuse --activate` foregrounds
                // the reused tab on demand without disturbing the user's
                // focus on every routine reuse call.
                const reuseActivate = (action.active as boolean | undefined) === true
                const updateProps: chrome.tabs.UpdateProperties = { url: targetUrl }
                if (reuseActivate) updateProps.active = true
                const updated = await chrome.tabs.update(candidate.id, updateProps)
                await waitForTabLoad(candidate.id)
                // Pin the reused tab as the auto-target for subsequent commands.
                // Mirrors the new-tab path below: every successful tab_create
                // — whether new or reused — must update activeTabId so a fresh
                // CLI invocation (no --tab) routes here instead of a stale id
                // or the user's foreground tab.
                await chrome.storage.session.set({ activeTabId: candidate.id })
                return {
                  success: true,
                  data: { tabId: candidate.id, url: updated?.url ?? targetUrl, groupId, reused: true }
                }
              } catch {
                // Tab vanished between query and update — fall through to create.
              }
            }
          }
        }
      }
      // Background-by-default: chrome.tabs.create defaults `active` to true,
      // which steals focus from the user's current tab. Interceptor's surface
      // contract is background-first (mirrors the macOS surface: `open
      // --activate` is the explicit opt-in). Callers pass `action.active:
      // true` only when the new tab is genuinely meant to be foregrounded.
      const shouldActivate = (action.active as boolean | undefined) === true
      const newTab = await chrome.tabs.create({ url: targetUrl, active: shouldActivate })
      if (newTab.id) {
        const groupId = await addTabToInterceptorGroup(newTab.id)
        // Pin the newly-created tab as the auto-target for subsequent commands
        // so a fresh CLI invocation (no --tab) routes to this tab instead of a
        // stale activeTabId or whatever Chrome reports as "active in currentWindow"
        // (which may be the user's foreground tab, not the one we just opened).
        await chrome.storage.session.set({ activeTabId: newTab.id })
        return { success: true, data: { tabId: newTab.id, url: newTab.url, groupId, reused: false } }
      }
      return { success: true, data: { tabId: newTab.id, url: newTab.url, reused: false } }
    }

    case "tab_close": {
      const closedId = (action.tabId as number) || tabId
      await chrome.tabs.remove(closedId)
      // If the closed tab was the auto-target, clear it so the next call
      // re-resolves via chrome.tabs.query rather than targeting a dead tab.
      const stored = await chrome.storage.session.get("activeTabId") as { activeTabId?: number }
      if (stored.activeTabId === closedId) await chrome.storage.session.remove("activeTabId")
      return { success: true }
    }

    case "tab_sweep": {
      // Close every tab in the Interceptor group in one call. User tabs are
      // spared by definition — they are never in the group. No-op (success,
      // count 0) when the group doesn't exist.
      const groupId = await ensureInterceptorGroup()
      if (groupId === -1) return { success: true, data: { closed: [], count: 0 } }
      const groupTabs = await chrome.tabs.query({ groupId })
      const ids = groupTabs.map(t => t.id).filter((id): id is number => typeof id === "number")
      if (ids.length > 0) await chrome.tabs.remove(ids)
      const stored = await chrome.storage.session.get("activeTabId") as { activeTabId?: number }
      if (stored.activeTabId !== undefined && ids.includes(stored.activeTabId)) {
        await chrome.storage.session.remove("activeTabId")
      }
      return { success: true, data: { closed: ids, count: ids.length } }
    }

    case "tab_switch": {
      await chrome.tabs.update(action.tabId as number, { active: true })
      await chrome.storage.session.set({ activeTabId: action.tabId as number })
      return { success: true }
    }

    case "tab_list": {
      const tabs = await chrome.tabs.query({})
      await ensureInterceptorGroup()
      const tabData = tabs.map(t => ({
        id: t.id, url: t.url, title: t.title, active: t.active,
        windowId: t.windowId, muted: t.mutedInfo?.muted, pinned: t.pinned,
        groupId: t.groupId,
        managed: interceptorGroupId !== null && t.groupId === interceptorGroupId
      }))
      return { success: true, data: tabData }
    }

    case "tab_duplicate": {
      const dup = await chrome.tabs.duplicate(tabId)
      return { success: true, data: { tabId: dup?.id } }
    }

    case "tab_reload":
      await chrome.tabs.reload(tabId, { bypassCache: !!action.bypassCache })
      await waitForTabLoad(tabId)
      return { success: true }

    case "tab_mute":
      await chrome.tabs.update(tabId, { muted: !!(action.muted ?? true) })
      return { success: true }

    case "tab_pin":
      await chrome.tabs.update(tabId, { pinned: !!(action.pinned ?? true) })
      return { success: true }

    case "tab_zoom_get": {
      const zoom = await chrome.tabs.getZoom(tabId)
      return { success: true, data: { zoom } }
    }

    case "tab_zoom_set":
      await chrome.tabs.setZoom(tabId, action.zoom as number)
      return { success: true }

    case "tab_group": {
      const groupId = await chrome.tabs.group({
        tabIds: tabId,
        groupId: action.groupId as number | undefined
      })
      if (action.title || action.color) {
        await chrome.tabGroups.update(groupId, {
          title: action.title as string | undefined,
          color: action.color as chrome.tabGroups.UpdateProperties["color"]
        })
      }
      return { success: true, data: { groupId } }
    }

    case "tab_ungroup":
      await chrome.tabs.ungroup(tabId)
      return { success: true }

    case "tab_move":
      await chrome.tabs.move(tabId, {
        windowId: action.windowId as number | undefined,
        index: (action.index as number) ?? -1
      })
      return { success: true }

    case "tab_discard":
      await chrome.tabs.discard(tabId)
      return { success: true }
  }
  return { success: false, error: `unknown tab action: ${action.type}` }
}
