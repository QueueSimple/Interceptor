# Interceptor → Zen Browser Port — Feasibility Scope

> Scoped 2026-06-03. Question: can Interceptor's browser surface drive **Zen Browser**
> (Firefox/Gecko-based, installed as Flatpak `app.zen_browser.zen` 1.20.1b on Fedora)?
> Verdict: **feasible but non-trivial — a maintained Firefox-MV3 fork, ~1–1.5 weeks, with two
> real frictions (AMO signing, partial feature loss).** The CLI + daemon already work as-is.

## TL;DR

| | |
|---|---|
| **Daemon / CLI** | ✅ Done. Built, compiled, on PATH (`interceptor 0.16.2`). Browser-agnostic. No change needed. |
| **Native messaging (Flatpak)** | ✅ Solved problem. Documented recipe (1Password/KeePassXC precedent). ~0.5 day. |
| **Extension API surface** | ⚠️ ~80% portable. Loses CDP-interception, background-tab capture, MHTML, tab groups. |
| **Manifest + background rework** | ⚠️ Moderate. SW→event-page, key→gecko.id, capability-gating. ~2–4 days. |
| **Signing** | ❌ Hard requirement. Zen enforces like Firefox Release; about:config bypass IGNORED. Must AMO-sign unlisted. This is the real friction. |
| **Ongoing cost** | Upstream has zero Firefox support → this is a **fork you maintain**; every upstream release needs re-porting. |

## 1. Extension API surface (repo-grounded, from `extension/src/`)

**Portable to Firefox MV3 (no/low change):** `scripting` (21 hits), `cookies`, `webNavigation`,
`tabs`, `storage`, `sessions`, `downloads`, `history`, `bookmarks`, `browsingData`, `search`,
`notifications`, `alarms`, `clipboardRead/Write`, content scripts including `world: "MAIN"`
(Firefox supports MAIN world since FF 128; Zen is newer). `declarativeNetRequest` (20 hits) and
`userScripts` (5 hits) port with adjustments (FF DNR limits + different userScripts shape).

**Lost or degraded on Firefox (no API equivalent — must gate behind capability checks):**
- `chrome.debugger` / CDP — **12 hits, 2 files** (`background/cdp.ts`, `background/network-capture.ts`). Firefox has **no debugger API**. → Loses the opt-in CDP network interception/override (`interceptor network on`, `network override`). **The default passive net capture survives** — it's content-script main-world fetch/XHR patching (`inject-net.ts`), not CDP. So the *stealth core* is intact; only the explicitly-non-stealth opt-in dies.
- `chrome.offscreen` + `chrome.tabCapture` — used by `background/capabilities/screenshot.ts` for **background-tab** screenshots. Firefox has neither. → Background-tab capture lost. **Visible-tab screenshots survive** via `tabs.captureVisibleTab`.
- `chrome.pageCapture` (saveAsMHTML) — 1 hit. Minor.
- `chrome.tabGroups` — 5 hits. Firefox has no tab-groups WebExtension API. Minor.
- `background.service_worker` — Firefox doesn't support SW background. Convert to event-page `background.scripts`.

**Net functional parity on Zen:** open/navigate, read DOM tree+text, click/type/act, find,
scroll, tabs, cookies, **passive network log (the headline stealth feature)**, visible-tab
screenshots, scene graph (DOM-based), form fill, monitor/record, eval — all work. You lose CDP
interception, background-tab capture, MHTML, tab groups.

## 2. Signing — the real blocker (HIGH confidence, sourced)

Zen is built on the Firefox **release** branch. `xpinstall.signatures.required = false` is
**ignored** — confirmed by Zen Discussion #8961, Issue #2258, and Mozilla policy. There is **no
unbranded/dev Zen build** that disables enforcement. The only permanent install path:

- **AMO unlisted (self-distribution) signing:** `web-ext sign --channel=unlisted` with an AMO
  account + API key/secret. Requires `browser_specific_settings.gecko.id` in the manifest.
  Automated review, usually signed in seconds, produces a signed `.xpi` you self-host/install.
- `about:debugging` temporary load works but is **session-only** (gone every restart) → unusable
  for daily driving.

**Implication for dev loop:** every extension rebuild needs a re-sign round-trip through AMO.
Automatable, but it's friction the Chromium "Load unpacked" flow doesn't have.

Sources: zen-browser/desktop#8961, #2258; support.mozilla.org add-on-signing; Extension Workshop
signing-and-distribution; Bugzilla 1298806.

## 3. Native messaging through the Flatpak sandbox (HIGH confidence, sourced)

Solved, documented pattern (1Password, KeePassXC ship it):

1. Manifest at `~/.var/app/app.zen_browser.zen/.mozilla/native-messaging-hosts/com.interceptor.host.json`
   — filename must equal the `name` field.
2. Firefox manifest format: **`"allowed_extensions": ["interceptor@<domain>"]`** (gecko id) — NOT
   Chrome's `"allowed_origins": ["chrome-extension://…"]`. (One-line transform of the existing template.)
3. `"path"` points to a wrapper script (in-sandbox-reachable), not the daemon directly:
   ```sh
   #!/bin/sh
   exec /usr/bin/flatpak-spawn --host --watch-bus /home/jon/.local/bin/interceptor-daemon "$@"
   ```
4. Grant the sandbox the host-spawn permission:
   ```
   flatpak override --user --talk-name=org.freedesktop.Flatpak app.zen_browser.zen
   ```
   No extra `--filesystem=` needed to read Zen's own app-dir manifest. Zen's current overrides are
   bare (xdg-download, kcm-socket, speech-dispatcher) — this `--talk-name` is the one addition.

Sources: KeePassXC+Firefox-Flatpak (Harald Sitter/KDE), 1Password Flatpak gist, Bugzilla 1621763,
MDN Native messaging / Native manifests.

## 4. Effort estimate

| Work | Estimate |
|---|---|
| Manifest port + SW→event-page background + capability-gating debugger/offscreen/tabCapture | 2–4 days |
| Firefox native-messaging manifest + Flatpak wrapper + override | 0.5 day |
| AMO unlisted signing pipeline (account, creds, gecko id, `web-ext sign` automation) | 0.5 day |
| Testing the degraded surface: MAIN-world injection, DNR differences, captureVisibleTab path | 2–3 days |
| **Total (partial-parity port)** | **~1–1.5 weeks focused** |

Plus an **ongoing maintenance tax**: upstream `Hacker-Valley-Media/slop-browser` has zero Firefox
support, so this is a fork — every upstream release you want needs re-porting/re-signing.

## 5. Recommendation

Three honest paths, cheapest first:

- **A — Dedicated Chromium automation browser (Brave/Chrome).** ~1 min, zero porting, full feature
  set. Cost: it drives *that* browser's sessions, not Zen's — log into target sites there. Best if
  the automation targets are a handful of services you can sign into separately.
- **B — Do the Zen port.** ~1–1.5 weeks + maintenance. You get ~80% of Interceptor driving your
  *actual Zen sessions/tabs*. Worth it only if "must be my real Zen profile" is non-negotiable AND
  you accept the signing/maintenance friction. Recommend a milestone-gated build: (1) sign a hello-
  world extension on Zen to de-risk the signing path FIRST, (2) native-messaging round-trip, (3)
  port commands, (4) gate the lost APIs.
- **C — Hybrid.** Run B's milestone 1 (signing de-risk, ~1 hr). If signing proves painless, commit
  to B. If it's miserable, fall back to A. Lowest-regret way to decide.
