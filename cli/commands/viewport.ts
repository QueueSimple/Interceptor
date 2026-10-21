type Action = { type: string; [key: string]: unknown }

function positiveInteger(label: string, raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return Number(raw)
}

/** Parse the arguments after `viewport`, without CLI or browser side effects. */
export function buildViewportAction(argv: string[]): Action {
  const positional: string[] = []
  let tabId: number | undefined
  let mobile = false
  let deviceScaleFactor = 1
  let hasOptions = false

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    switch (token) {
      case "--tab":
        tabId = positiveInteger("--tab", argv[++i])
        break
      case "--mobile":
        mobile = true
        hasOptions = true
        break
      case "--dpr": {
        const raw = argv[++i]
        if (!raw || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) <= 0) {
          throw new Error("--dpr must be a positive number")
        }
        deviceScaleFactor = Number(raw)
        hasOptions = true
        break
      }
      default:
        if (token.startsWith("--")) throw new Error(`unknown viewport flag: ${token}`)
        positional.push(token)
    }
  }

  const target = tabId === undefined ? {} : { tabId }
  if (positional.length === 0 || positional[0] === "reset") {
    if (hasOptions || positional.length > 1) {
      throw new Error("viewport get/reset only accepts --tab")
    }
    return { type: positional.length === 0 ? "viewport_get" : "viewport_reset", ...target }
  }
  if (positional.length > 2) throw new Error("usage: interceptor viewport <width> [height] [--mobile] [--dpr <n>]")
  return {
    type: "viewport_set",
    width: positiveInteger("width", positional[0]),
    height: positional.length === 1 ? 800 : positiveInteger("height", positional[1]),
    deviceScaleFactor,
    mobile,
    ...target,
  }
}
