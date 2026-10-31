import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import {
  normalizeTabLifecycle,
  resolveTabLifecycle,
  policyMayDecideReuse,
  selectSweepCandidates,
  boundedDirtyInspection,
  runTabLifecycleSweep,
  registerTabLifecycle,
  recordGroupActivity,
  DEFAULT_TAB_LIFECYCLE,
  type SweepTab,
} from "../extension/src/background/tab-lifecycle"
import { namedGroups, addTabToNamedGroup, addTabToInterceptorGroup, registerTabGroupListeners } from "../extension/src/background/tab-group"
import { buildTabCreateAction } from "../cli/commands/compound"
import { parseTabsCommand } from "../cli/commands/tabs"

// Tab-lifecycle tests use pure helpers and mocked Chrome APIs, including the
// real alarm/sweep path. No running browser or extension reload is needed.

// ── T1: normalizeTabLifecycle never throws, always yields a valid policy ──────

describe("normalizeTabLifecycle (T1)", () => {
  test("null/undefined/garbage yield the defaults", () => {
    expect(normalizeTabLifecycle(null)).toEqual(DEFAULT_TAB_LIFECYCLE)
    expect(normalizeTabLifecycle(undefined)).toEqual(DEFAULT_TAB_LIFECYCLE)
    expect(normalizeTabLifecycle("junk")).toEqual(DEFAULT_TAB_LIFECYCLE)
    expect(normalizeTabLifecycle(42)).toEqual(DEFAULT_TAB_LIFECYCLE)
    expect(normalizeTabLifecycle([])).toEqual(DEFAULT_TAB_LIFECYCLE)
  })

  test("partial objects keep per-field defaults", () => {
    expect(normalizeTabLifecycle({ reuse: false })).toEqual({ reuse: false, idleCloseMinutes: 10 })
    expect(normalizeTabLifecycle({ idleCloseMinutes: 0 })).toEqual({ reuse: true, idleCloseMinutes: 0 })
  })

  test("out-of-range and non-numeric idle values are clamped or defaulted", () => {
    expect(normalizeTabLifecycle({ idleCloseMinutes: -5 }).idleCloseMinutes).toBe(0)
    expect(normalizeTabLifecycle({ idleCloseMinutes: 7.6 }).idleCloseMinutes).toBe(8)
    expect(normalizeTabLifecycle({ idleCloseMinutes: NaN }).idleCloseMinutes).toBe(10)
    expect(normalizeTabLifecycle({ idleCloseMinutes: Infinity }).idleCloseMinutes).toBe(10)
    expect(normalizeTabLifecycle({ idleCloseMinutes: "30" }).idleCloseMinutes).toBe(10)
  })

  test("non-boolean reuse falls back to default true", () => {
    expect(normalizeTabLifecycle({ reuse: "yes" }).reuse).toBe(true)
    expect(normalizeTabLifecycle({ reuse: 0 }).reuse).toBe(true)
  })
})

// ── T2: resolveTabLifecycle precedence managed > local > default ─────────────

type FakeArea = { get: (key: string) => Promise<Record<string, unknown>> }

function chromeWithStorage(areas: { managed?: FakeArea; local?: FakeArea }): unknown {
  return { storage: { ...areas } }
}

describe("resolveTabLifecycle precedence (T2)", () => {
  let originalChrome: unknown

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome
  })
  afterEach(() => {
    ;(globalThis as { chrome?: unknown }).chrome = originalChrome as typeof chrome
  })

  test("managed wins over local", async () => {
    ;(globalThis as { chrome: unknown }).chrome = chromeWithStorage({
      managed: { get: async () => ({ tabLifecycle: { reuse: false, idleCloseMinutes: 99 } }) },
      local: { get: async () => ({ tabLifecycle: { reuse: true, idleCloseMinutes: 1 } }) },
    })
    const { policy, source } = await resolveTabLifecycle()
    expect(source).toBe("managed")
    expect(policy).toEqual({ reuse: false, idleCloseMinutes: 99 })
  })

  test("local used when managed has no key", async () => {
    ;(globalThis as { chrome: unknown }).chrome = chromeWithStorage({
      managed: { get: async () => ({}) },
      local: { get: async () => ({ tabLifecycle: { reuse: false, idleCloseMinutes: 30 } }) },
    })
    const { policy, source } = await resolveTabLifecycle()
    expect(source).toBe("local")
    expect(policy).toEqual({ reuse: false, idleCloseMinutes: 30 })
  })

  test("default when neither area has the key", async () => {
    ;(globalThis as { chrome: unknown }).chrome = chromeWithStorage({
      managed: { get: async () => ({}) },
      local: { get: async () => ({}) },
    })
    const { policy, source } = await resolveTabLifecycle()
    expect(source).toBe("default")
    expect(policy).toEqual(DEFAULT_TAB_LIFECYCLE)
  })

  test("managed present-but-throwing falls through to local (Chromium builds do this)", async () => {
    ;(globalThis as { chrome: unknown }).chrome = chromeWithStorage({
      managed: { get: async () => { throw new Error("managed storage unavailable") } },
      local: { get: async () => ({ tabLifecycle: { idleCloseMinutes: 5 } }) },
    })
    const { policy, source } = await resolveTabLifecycle()
    expect(source).toBe("local")
    expect(policy).toEqual({ reuse: true, idleCloseMinutes: 5 })
  })

  test("managed area entirely absent falls through to local", async () => {
    ;(globalThis as { chrome: unknown }).chrome = chromeWithStorage({
      local: { get: async () => ({ tabLifecycle: { reuse: false } }) },
    })
    const { source } = await resolveTabLifecycle()
    expect(source).toBe("local")
  })
})

// ── T3: sweep guards — each independently vetoes; stale unguarded tabs go ────

function mkTab(over: Partial<SweepTab> & { id: number }): SweepTab {
  return { windowId: 1, active: false, pinned: false, audible: false, ...over }
}

const ctx = (counts: Array<[number, number]>, focused: number | null = 99) => ({
  focusedWindowId: focused,
  windowTabCounts: new Map<number, number>(counts),
})

describe("selectSweepCandidates guards (T3)", () => {
  test("a stale unguarded group is fully selected", () => {
    const tabs = [mkTab({ id: 1 }), mkTab({ id: 2 }), mkTab({ id: 3 })]
    // window 1 holds other (non-group) tabs too, so G5 never bites
    expect(selectSweepCandidates(tabs, ctx([[1, 10]])).sort()).toEqual([1, 2, 3])
  })

  test("G2: active tab of the focused window is never closed", () => {
    const tabs = [mkTab({ id: 1, active: true }), mkTab({ id: 2 })]
    expect(selectSweepCandidates(tabs, ctx([[1, 10]], 1))).toEqual([2])
  })

  test("G2: active tab of an UNfocused window IS closable", () => {
    const tabs = [mkTab({ id: 1, active: true }), mkTab({ id: 2 })]
    expect(selectSweepCandidates(tabs, ctx([[1, 10]], 7)).sort()).toEqual([1, 2])
  })

  test("G2: unknown focus treats every active tab as protected", () => {
    const tabs = [mkTab({ id: 1, active: true }), mkTab({ id: 2 })]
    expect(selectSweepCandidates(tabs, ctx([[1, 10]], null))).toEqual([2])
  })

  test("G3: pinned tabs are never closed", () => {
    const tabs = [mkTab({ id: 1, pinned: true }), mkTab({ id: 2 })]
    expect(selectSweepCandidates(tabs, ctx([[1, 10]]))).toEqual([2])
  })

  test("G4: audible tabs are never closed", () => {
    const tabs = [mkTab({ id: 1, audible: true }), mkTab({ id: 2 })]
    expect(selectSweepCandidates(tabs, ctx([[1, 10]]))).toEqual([2])
  })

  test("G5: never closes the last tab of a window — keeps the most recent", () => {
    // Group tabs ARE the whole window (count 3 = group size 3): one must survive.
    const tabs = [mkTab({ id: 1 }), mkTab({ id: 2 }), mkTab({ id: 3 })]
    expect(selectSweepCandidates(tabs, ctx([[1, 3]])).sort()).toEqual([1, 2])
  })

  test("G5 applies per window when a group spans windows", () => {
    const tabs = [
      mkTab({ id: 1, windowId: 1 }),
      mkTab({ id: 2, windowId: 1 }),
      mkTab({ id: 3, windowId: 2 }),
    ]
    // window 1 is exactly the group's two tabs → keep id 2; window 2 has others → close 3
    expect(selectSweepCandidates(tabs, ctx([[1, 2], [2, 5]])).sort()).toEqual([1, 3])
  })

  test("unknown window count never triggers G5 (treated as not-last)", () => {
    const tabs = [mkTab({ id: 1, windowId: 42 })]
    expect(selectSweepCandidates(tabs, ctx([]))).toEqual([1])
  })
})

// ── T3b: a wedged page inspection cannot stall the whole sweep ──────────────

describe("bounded dirty-page inspection (T3b)", () => {
  test("preserves a tab whose inspection does not settle", async () => {
    const never = new Promise<boolean>(() => {})
    expect(await boundedDirtyInspection(never, 5)).toBe(true)
  })

  test("returns settled dirty and clean results without waiting for the timeout", async () => {
    expect(await boundedDirtyInspection(Promise.resolve(true), 1_000)).toBe(true)
    expect(await boundedDirtyInspection(Promise.resolve(false), 1_000)).toBe(false)
  })

  test("keeps the existing clean-on-inspection-failure behavior", async () => {
    expect(await boundedDirtyInspection(Promise.reject(new Error("unreachable")), 1_000)).toBe(false)
  })
})

// ── T4: reuse gating — parser + policy-gate composition ──────────────────────

describe("reuse gating (T4)", () => {
  test("open without --reuse/--no-reuse marks reuse-undecided (reusePolicy)", () => {
    const a = buildTabCreateAction(["open", "https://x.com"], "https://x.com", { policyDefault: true })
    expect(a.reuse).toBeUndefined()
    expect(a.reusePolicy).toBe(true)
  })

  test("open --reuse is explicit and skips the policy marker", () => {
    const a = buildTabCreateAction(["open", "https://x.com", "--reuse"], "https://x.com", { policyDefault: true })
    expect(a.reuse).toBe(true)
    expect(a.reusePolicy).toBeUndefined()
  })

  test("open --no-reuse pins reuse off, beating any policy", () => {
    const a = buildTabCreateAction(["open", "https://x.com", "--no-reuse"], "https://x.com", { policyDefault: true })
    expect(a.reuse).toBe(false)
    expect(a.reusePolicy).toBeUndefined()
    expect(policyMayDecideReuse({ ...a, group: "ai7" })).toBe(false)
  })

  test("tab new never carries the policy marker (always creates)", async () => {
    const action = await parseTabsCommand(["tab", "new", "https://x.com"])
    expect(action).toMatchObject({ type: "tab_create", url: "https://x.com" })
    expect((action as { reusePolicy?: boolean }).reusePolicy).toBeUndefined()
    expect(policyMayDecideReuse({ ...(action as object), group: "ai7" })).toBe(false)
  })

  test("tab new --reuse now works (was silently ignored — W3)", async () => {
    const action = await parseTabsCommand(["tab", "new", "https://x.com", "--reuse"])
    expect(action).toMatchObject({ type: "tab_create", url: "https://x.com", reuse: true })
  })

  test("conflicting explicit reuse flags fail instead of silently winning", () => {
    const realExit = process.exit
    const realError = console.error
    try {
      process.exit = ((code?: number) => { throw new Error(`__exit_${code}`) }) as never
      console.error = () => {}
      expect(() => buildTabCreateAction(["open", "https://x.com", "--reuse", "--no-reuse"], "https://x.com"))
        .toThrow("__exit_1")
    } finally {
      process.exit = realExit
      console.error = realError
    }
  })

  test("policy may decide ONLY for grouped, reuse-undecided open calls", () => {
    const open = buildTabCreateAction(["open", "u"], "u", { policyDefault: true })
    // grouped → policy decides
    expect(policyMayDecideReuse({ ...open, group: "ai7" })).toBe(true)
    // ungrouped (shared default group) → never
    expect(policyMayDecideReuse(open)).toBe(false)
    expect(policyMayDecideReuse({ ...open, group: "" })).toBe(false)
    // explicit decisions always win
    expect(policyMayDecideReuse({ reuse: true, reusePolicy: true, group: "ai7" })).toBe(false)
    expect(policyMayDecideReuse({ reuse: false, reusePolicy: true, group: "ai7" })).toBe(false)
  })
})

// Exercise the real alarm -> discovery -> stamp -> guard -> removal path.
// Extension reload clears storage.session while tab-strip groups survive.
describe("idle sweep runtime", () => {
  const global = globalThis as unknown as { chrome?: unknown }
  let savedChrome: unknown
  let savedGroups: Map<string, number>
  let clock: ReturnType<typeof spyOn>
  let now: number
  let session: Record<string, unknown>
  let local: Record<string, unknown>
  let groups: Array<{ id: number; title: string }>
  let tabs: Array<SweepTab & { groupId: number; url: string }>
  let removed: number[]
  let alarmListener: (alarm: { name: string }) => void
  let alarm: { name: string } | undefined
  let created: unknown[]
  let groupRemoved: (group: { id: number }) => Promise<void>
  let nextGroupId: number

  beforeEach(() => {
    savedChrome = global.chrome
    savedGroups = new Map(namedGroups)
    namedGroups.clear()
    now = 1_800_000
    clock = spyOn(Date, "now").mockImplementation(() => now)
    session = {}
    local = { "createdTabGroup:10": { label: "s-crashed", createdAt: 1 } }
    nextGroupId = 30
    groups = [{ id: 10, title: "interceptor-s-crashed" }]
    tabs = [
      { ...mkTab({ id: 101 }), groupId: 10, url: "https://example.test/" },
      { ...mkTab({ id: 999, active: true }), groupId: -1, url: "https://personal.test/" },
    ]
    removed = []
    alarm = undefined
    created = []
    const area = (data: Record<string, unknown>) => ({
      get: async (key: string | null) => key === null ? { ...data } : ({ [key]: data[key] }),
      remove: async (key: string | string[]) => { for (const k of [key].flat()) delete data[k] },
      set: async (values: Record<string, unknown>) => { Object.assign(data, values) },
    })
    global.chrome = {
      storage: { session: area(session), local: area(local) },
      tabGroups: {
        query: async () => groups,
        update: async (id: number, values: { title?: string }) => { Object.assign(groups.find((g) => g.id === id)!, values) },
        onRemoved: { addListener: (listener: typeof groupRemoved) => { groupRemoved = listener } },
        get: async (id: number) => {
          const group = groups.find((g) => g.id === id)
          if (!group) throw new Error("no group")
          return group
        },
      },
      windows: { getLastFocused: async () => ({ id: 1, focused: true }) },
      tabs: {
        onRemoved: { addListener: () => {} },
        get: async (id: number) => tabs.find((t) => t.id === id),
        group: async (options: { tabIds: number; groupId?: number }) => {
          const id = options.groupId ?? nextGroupId++
          if (!groups.some((g) => g.id === id)) groups.push({ id, title: "" })
          tabs.find((t) => t.id === options.tabIds)!.groupId = id
          return id
        },
        query: async (query: { groupId?: number }) => tabs.filter((t) => query.groupId === undefined || t.groupId === query.groupId),
        remove: async (ids: number[]) => {
          removed.push(...ids)
          tabs = tabs.filter((t) => !ids.includes(t.id))
        },
      },
      scripting: { executeScript: async () => [{ result: false }] },
      alarms: {
        get: async () => alarm,
        create: async (name: string, options: unknown) => { created.push({ name, options }); alarm = { name } },
        onAlarm: { addListener: (listener: typeof alarmListener) => { alarmListener = listener } },
      },
    }
  })

  afterEach(() => {
    clock.mockRestore()
    global.chrome = savedChrome
    namedGroups.clear()
    for (const [label, id] of savedGroups) namedGroups.set(label, id)
  })

  test("rediscovers a recorded group after reload, grants grace, then closes it", async () => {
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([])
    now += 9 * 60_000
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([])
    now += 60_000
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([101])
    expect(tabs.map((t) => t.id)).toEqual([999])
    expect(local.tabLifecycleSweepLog).toMatchObject([{ group: "s-crashed", idleMinutes: 10, closed: 1 }])
  })

  test("rediscovers an idle group even when another named group is registered", async () => {
    namedGroups.set("other", 20)
    recordGroupActivity("s-crashed")
    await Promise.resolve()
    now += 10 * 60_000
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([101])
  })

  test("rediscovers a previous-brand group but ignores personal and invalid-label groups", async () => {
    session.brandTabGroupPrevTitle = "old-brand"
    groups = [
      { id: 10, title: "old-brand-s-crashed" },
      { id: 11, title: "personal" },
      { id: 12, title: "interceptor-invalid label" },
    ]
    tabs.push(
      { ...mkTab({ id: 102 }), groupId: 11, url: "https://personal.test/" },
      { ...mkTab({ id: 103 }), groupId: 12, url: "https://personal.test/" },
    )
    await runTabLifecycleSweep(now)
    now += 10 * 60_000
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([101])
  })

  test("preserves the last window tab across multiple idle groups", async () => {
    namedGroups.set("a", 10)
    namedGroups.set("b", 11)
    local["createdTabGroup:10"] = { label: "a", createdAt: 1 }
    local["createdTabGroup:11"] = { label: "b", createdAt: 1 }
    session["groupLastSeen:a"] = 1
    session["groupLastSeen:b"] = 1
    groups = [{ id: 10, title: "interceptor-a" }, { id: 11, title: "interceptor-b" }]
    tabs = [
      { ...mkTab({ id: 101, windowId: 2 }), groupId: 10, url: "https://example.test/a" },
      { ...mkTab({ id: 102, windowId: 2 }), groupId: 11, url: "https://example.test/b" },
    ]
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([101])
    expect(tabs.map((t) => t.id)).toEqual([102])
    now += 30 * 60_000
    await runTabLifecycleSweep(now)
    expect(tabs.map((t) => t.id)).toEqual([102])
  })

  test("recreates a missing alarm on worker startup and its tick closes idle tabs", async () => {
    namedGroups.set("s-crashed", 10)
    session["groupLastSeen:s-crashed"] = 1
    registerTabLifecycle()
    // Alarm setup and the event-driven sweep are intentionally fire-and-forget.
    await Bun.sleep(0)
    expect(created).toEqual([{ name: "tabLifecycleSweep", options: { periodInMinutes: 1 } }])
    alarmListener({ name: "unrelated" })
    await Bun.sleep(0)
    expect(removed).toEqual([])
    alarmListener({ name: "tabLifecycleSweep" })
    await Bun.sleep(0)
    expect(removed).toEqual([101])
  })

  test("keeps an existing alarm rather than postponing its next tick", async () => {
    alarm = { name: "tabLifecycleSweep" }
    registerTabLifecycle()
    await Bun.sleep(0)
    expect(created).toEqual([])
  })


  test("never sweeps personal groups with default, named, or free-form brand titles", async () => {
    session.brandTabGroupPrevTitle = "Work"
    groups.push({ id: 11, title: "interceptor-research" }, { id: 12, title: "Work-notes" }, { id: 13, title: "interceptor" })
    for (const id of [11, 12, 13]) tabs.push({ ...mkTab({ id: id * 10 }), groupId: id, url: "https://personal.test/" })
    // Even title-adopted dispatch registries are not proof of creation.
    namedGroups.set("research", 11)
    await runTabLifecycleSweep(now)
    now += 10 * 60_000
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([101])
    expect(tabs.map((t) => t.id)).toEqual([999, 110, 120, 130])
  })

  test("persists ownership only for newly created named and default groups", async () => {
    groups = []
    tabs[0].groupId = -1
    const namedId = await addTabToNamedGroup(101, "fresh")
    const defaultId = await addTabToInterceptorGroup(999)
    expect(local[`createdTabGroup:${namedId}`]).toEqual({ label: "fresh", createdAt: now })
    expect(local[`createdTabGroup:${defaultId}`]).toEqual({ label: "", createdAt: now })
    // Clear session/dispatch state, as an extension reload does. Local proof survives.
    for (const key of Object.keys(session)) delete session[key]
    namedGroups.clear()
    tabs.push({ ...mkTab({ id: 1000, active: true }), groupId: -1, url: "https://personal.test/" })
    tabs.find((t) => t.id === 999)!.active = false
    await runTabLifecycleSweep(now)
    now += 10 * 60_000
    await runTabLifecycleSweep(now)
    expect(removed.sort()).toEqual([101, 999])
  })

  test("removes stamps and creation receipts on group removal, so a restored same-id group is never presumed ours", async () => {
    groups.push({ id: 11, title: "interceptor" })
    local["createdTabGroup:11"] = { label: "", createdAt: 1 }
    tabs.push({ ...mkTab({ id: 102 }), groupId: 11, url: "https://example.test/default" })
    session["groupLastSeen:s-crashed"] = 1
    session["groupLastSeen:"] = 1
    registerTabGroupListeners()
    await groupRemoved({ id: 10 })
    await groupRemoved({ id: 11 })
    expect(session["groupLastSeen:s-crashed"]).toBeUndefined()
    expect(session["groupLastSeen:"]).toBeUndefined()
    expect(local["createdTabGroup:11"]).toBeUndefined()
    // Chrome may restore the same ids; without a receipt the groups are never swept.
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([])
    now += 9 * 60_000
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([])
    now += 60_000
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([])
  })

  test("the sweep prunes receipts whose group no longer exists (lost without onRemoved)", async () => {
    groups = [{ id: 10, title: "interceptor-live" }]
    local["createdTabGroup:10"] = { label: "live", createdAt: 1 }
    local["createdTabGroup:77"] = { label: "gone", createdAt: 1 }
    await runTabLifecycleSweep(now)
    expect(local["createdTabGroup:77"]).toBeUndefined()
    expect(local["createdTabGroup:10"]).toBeDefined()
  })

  test("a receipt whose id now names a personal group never closes it (ids are only unique per browser session)", async () => {
    groups = [{ id: 10, title: "Personal" }]
    local["createdTabGroup:10"] = { label: "s-crashed", createdAt: 1 }
    session["groupLastSeen:s-crashed"] = 1
    await runTabLifecycleSweep(now)
    now += 60 * 60_000
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([])
  })

  test("sweeps every recorded duplicate default-title group in one tick", async () => {
    groups = [{ id: 10, title: "interceptor" }, { id: 11, title: "interceptor" }, { id: 12, title: "interceptor" }]
    local["createdTabGroup:10"] = { label: "", createdAt: 1 }
    local["createdTabGroup:11"] = { label: "", createdAt: 1 }
    session["groupLastSeen:"] = 1
    tabs.push({ ...mkTab({ id: 102 }), groupId: 11, url: "https://example.test/duplicate" })
    tabs.push({ ...mkTab({ id: 103 }), groupId: 12, url: "https://personal.test/duplicate" })
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([101, 102])
    expect(tabs.map((t) => t.id)).toEqual([999, 103])
  })

  test("refreshes window counts after partial removal failure before sweeping the next group", async () => {
    groups = [{ id: 10, title: "interceptor-a" }, { id: 11, title: "interceptor-b" }]
    local["createdTabGroup:10"] = { label: "a", createdAt: 1 }
    local["createdTabGroup:11"] = { label: "b", createdAt: 1 }
    namedGroups.set("a", 10)
    namedGroups.set("b", 11)
    session["groupLastSeen:a"] = session["groupLastSeen:b"] = 1
    tabs = [101, 102, 103].map((id) => ({ ...mkTab({ id, windowId: 2 }), groupId: id === 103 ? 11 : 10, url: "https://example.test/" }))
    const remove = chrome.tabs.remove
    chrome.tabs.remove = (async (ids: number[]) => {
      await remove(ids)
      if (ids.includes(101)) throw new Error("partial remove")
    }) as typeof remove
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([101, 102])
    expect(tabs.map((t) => t.id)).toEqual([103])
  })


  test("title adoption never writes a creation receipt", async () => {
    groups.push({ id: 11, title: "interceptor-personal" })
    await addTabToNamedGroup(101, "personal")
    expect(local["createdTabGroup:11"]).toBeUndefined()
  })

  test("unavailable ownership storage leaves all tabs alone", async () => {
    session["groupLastSeen:s-crashed"] = 1
    const get = chrome.storage.local.get
    chrome.storage.local.get = (async (key: string | null) => {
      if (key === null) throw new Error("ownership storage unavailable")
      return get(key)
    }) as typeof get
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([])
  })

  test("a survivor in one default duplicate does not postpone the other duplicate", async () => {
    groups = [{ id: 10, title: "interceptor" }, { id: 11, title: "interceptor" }]
    local["createdTabGroup:10"] = local["createdTabGroup:11"] = { label: "", createdAt: 1 }
    session["groupLastSeen:"] = 1
    tabs.push({ ...mkTab({ id: 102, pinned: true }), groupId: 10, url: "https://example.test/pinned" })
    tabs.push({ ...mkTab({ id: 103 }), groupId: 11, url: "https://example.test/duplicate" })
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([101, 103])
    expect(tabs.map((t) => t.id)).toEqual([999, 102])
  })

  test("a full sweep does not recreate a stamp cleared by the removal listener", async () => {
    session["groupLastSeen:s-crashed"] = 1
    registerTabGroupListeners()
    const remove = chrome.tabs.remove
    chrome.tabs.remove = (async (ids: number[]) => {
      await remove(ids)
      groups = []
      await groupRemoved({ id: 10 })
    }) as typeof remove
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([101])
    expect(session["groupLastSeen:s-crashed"]).toBeUndefined()
  })

  test("respects a stored disabled policy", async () => {
    namedGroups.set("s-crashed", 10)
    session["groupLastSeen:s-crashed"] = 1
    local.tabLifecycle = { reuse: true, idleCloseMinutes: 0 }
    await runTabLifecycleSweep(now)
    expect(removed).toEqual([])
  })
})
