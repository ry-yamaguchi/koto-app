// osvProjectRead.ts — ライブラリの脆弱性の照会で送る一覧を、ディスクから決める（通信はしない）。
// 読むのは公開の根の package.json と package-lock.json の2つだけ。戻り値に rootDeps・パス・中身は入れない。

import {
  lockfileDeps, manifestDeps, manifestMatch, hasProductionDeps, exampleDeps,
  type LockDep, type LockSkipped, type ManifestMatch,
} from '../shared/lockfileDeps'
import { LOCKFILE_READ_LIMIT_BYTES, MANIFEST_READ_LIMIT_BYTES, OSV_EXAMPLE_COUNT } from '../shared/osvLimits'
import { resolvePublishRoot } from './publishRootFs'
import { readTextInsideDirFs } from './readInsideDirFs'

export type OsvPlan =
  | { state: 'ok'; deps: LockDep[]; skipped: LockSkipped; manifest: ManifestMatch; examples: string[] }
  | { state: 'no-manifest' | 'no-deps' | 'no-lockfile' | 'unsupported' | 'unreadable' }

export function readOsvPlanFs(projectDir: string): OsvPlan {
  try {
    const root = resolvePublishRoot(projectDir)
    if (!root) return { state: 'unreadable' }
    const pkg = readTextInsideDirFs(root, 'package.json', MANIFEST_READ_LIMIT_BYTES)
    const lock = readTextInsideDirFs(root, 'package-lock.json', LOCKFILE_READ_LIMIT_BYTES)
    if (lock.state === 'unreadable') return { state: 'unreadable' }
    const own = pkg.state === 'text' ? manifestDeps(pkg.content) : null
    if (lock.state === 'missing') {
      if (pkg.state === 'missing') return { state: 'no-manifest' }
      if (own !== null && !hasProductionDeps(own)) return { state: 'no-deps' }
      return { state: 'no-lockfile' }
    }
    const plan = lockfileDeps(lock.content)
    if (plan.state !== 'ok') return { state: plan.state }
    const { deps, skipped, rootDeps } = plan
    // ライブラリが空（package.json が読めればそれ、読めなければ lockfile の根）で、送る一覧も 0 件。
    // どちらも読めない回は「ライブラリが無い」と言い切らない（送る一覧が 0 件の ok を返す）。
    const listed = own ?? rootDeps
    if (deps.length === 0 && listed !== null && !hasProductionDeps(listed)) return { state: 'no-deps' }
    return {
      state: 'ok',
      deps,
      skipped,
      manifest: manifestMatch(rootDeps, own),
      examples: exampleDeps(deps, rootDeps, OSV_EXAMPLE_COUNT),
    }
  } catch {
    return { state: 'unreadable' }
  }
}
