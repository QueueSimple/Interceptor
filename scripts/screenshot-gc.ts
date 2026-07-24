#!/usr/bin/env bun
/**
 * screenshot-gc.ts — retention for the Interceptor screenshot home.
 *
 * Layout it manages:
 *   $INTERCEPTOR_SCREENSHOT_DIR/            (default ~/.claude/PAI/MEMORY/SCREENSHOTS)
 *     YYYY-MM-DD/ ...images...              live day dirs (written by `interceptor screenshot --save`)
 *     _archive/YYYY-MM-DD.tar.gz            archived day dirs
 *
 * Policy (defaults; override via flags or env):
 *   - day dirs older than ARCHIVE_AFTER_DAYS (14, env INTERCEPTOR_SS_ARCHIVE_DAYS) → tar.gz into _archive/, then remove dir
 *   - archives older than DELETE_AFTER_DAYS (90, env INTERCEPTOR_SS_DELETE_DAYS) → deleted
 *   - today's dir is never touched; a dir is only removed after its tarball is verified readable
 *
 * Usage: bun run scripts/screenshot-gc.ts [--dry-run] [--archive-days N] [--delete-days N]
 */

import { readdirSync, statSync, existsSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const HOME = process.env.HOME || "/root"
const BASE = process.env.INTERCEPTOR_SCREENSHOT_DIR || join(HOME, ".claude/PAI/MEMORY/SCREENSHOTS")
const ARCHIVE_DIR = join(BASE, "_archive")

const args = process.argv.slice(2)
const DRY = args.includes("--dry-run")
const flagNum = (name: string, fallback: number) => {
  const i = args.indexOf(name)
  if (i !== -1 && args[i + 1]) { const n = parseInt(args[i + 1]); if (Number.isFinite(n) && n > 0) return n }
  return fallback
}
const ARCHIVE_AFTER_DAYS = flagNum("--archive-days", parseInt(process.env.INTERCEPTOR_SS_ARCHIVE_DAYS || "14") || 14)
const DELETE_AFTER_DAYS = flagNum("--delete-days", parseInt(process.env.INTERCEPTOR_SS_DELETE_DAYS || "90") || 90)

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const MS_PER_DAY = 86_400_000

function dayDirAgeDays(name: string): number {
  // age from the day the dir REPRESENTS, not fs mtime (mtime lies after copies/migrations)
  const t = new Date(`${name}T23:59:59`).getTime()
  return (Date.now() - t) / MS_PER_DAY
}

async function run(cmd: string[]): Promise<number> {
  const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" })
  await p.exited
  return p.exitCode ?? 1
}

if (!existsSync(BASE)) {
  console.log(`screenshot-gc: base ${BASE} does not exist; nothing to do`)
  process.exit(0)
}
mkdirSync(ARCHIVE_DIR, { recursive: true })

// single-runner lock (stale after 6h — a hung yesterday-run must not block forever)
const LOCK = join(BASE, ".gc.lock")
if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < 6 * 3_600_000) {
  console.log("screenshot-gc: another run holds the lock; exiting")
  process.exit(0)
}
if (!DRY) await Bun.write(LOCK, `${process.pid}\n`)
process.on("exit", () => { try { rmSync(LOCK) } catch {} })

let archived = 0, deleted = 0, kept = 0
const today = (() => { const n = new Date(), p = (x: number) => String(x).padStart(2, "0"); return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}` })()

// Phase 1: archive old day dirs
for (const name of readdirSync(BASE).sort()) {
  const full = join(BASE, name)
  if (!DAY_RE.test(name) || !statSync(full).isDirectory()) continue
  if (name === today) { kept++; continue }
  const age = dayDirAgeDays(name)
  if (age < ARCHIVE_AFTER_DAYS) { kept++; continue }

  const tarball = join(ARCHIVE_DIR, `${name}.tar.gz`)
  if (DRY) { console.log(`[dry-run] would archive ${name}/ -> _archive/${name}.tar.gz`); archived++; continue }

  // atomic: tar to a temp name, verify it lists cleanly, rename into place, then remove the dir
  const tmpTar = `${tarball}.tmp`
  const mk = await run(["tar", "-czf", tmpTar, "-C", BASE, name])
  if (mk !== 0) { console.error(`screenshot-gc: tar failed for ${name}, dir kept`); try { rmSync(tmpTar) } catch {}; continue }
  const ok = await run(["tar", "-tzf", tmpTar])
  if (ok !== 0) { console.error(`screenshot-gc: tarball verify failed for ${name}, dir kept`); try { rmSync(tmpTar) } catch {}; continue }
  const mv = await run(["mv", tmpTar, tarball])
  if (mv !== 0) { console.error(`screenshot-gc: rename failed for ${name}, dir kept`); continue }
  rmSync(full, { recursive: true })
  archived++
  console.log(`archived ${name}/ -> _archive/${name}.tar.gz`)
}

// Phase 2: delete ancient archives — aged by tarball mtime (time since archived),
// NOT by the day the dir represents. Otherwise a first gc run on old data would
// archive a day and delete the fresh tarball in the same pass.
for (const name of readdirSync(ARCHIVE_DIR).sort()) {
  if (!name.endsWith(".tar.gz")) continue
  const day = name.replace(/\.tar\.gz$/, "")
  if (!DAY_RE.test(day)) continue
  const archiveAge = (Date.now() - statSync(join(ARCHIVE_DIR, name)).mtimeMs) / MS_PER_DAY
  if (archiveAge < DELETE_AFTER_DAYS) continue
  if (DRY) { console.log(`[dry-run] would delete _archive/${name}`); deleted++; continue }
  rmSync(join(ARCHIVE_DIR, name))
  deleted++
  console.log(`deleted _archive/${name}`)
}

console.log(`screenshot-gc done${DRY ? " (dry-run)" : ""}: ${archived} archived, ${deleted} deleted, ${kept} live day-dirs kept (archive>${ARCHIVE_AFTER_DAYS}d, delete>${DELETE_AFTER_DAYS}d)`)
