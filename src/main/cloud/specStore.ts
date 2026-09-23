// specStore.ts — env.json / state.json（プロジェクト内 .sakura-cloud/）の読み書き。
//
// 2026-09-12（専有型 D-2a）に ipc/cloud.ts から**純粋移動**した。cloud/imagePublish.ts からも使うため、
// ipc 層ではなく cloud 層に置く（cloud → ipc の import＝循環を作らない）。中身は移動前と同じ。
import * as path from 'path'
import * as fs from 'fs'
import { validateSpec, type EnvSpec } from './spec'
import { emptyState, type EnvState } from './state'

// env.json / state.json は プロジェクト内 `.sakura-cloud/` に置く。
// state.json はユーザー非編集（IDEが作成済みリソースを記録する内部ファイル）。
export const CLOUD_DIR = '.sakura-cloud'
export const CLOUD_ENV_FILE = 'env.json'
export const CLOUD_STATE_FILE = 'state.json'

/** projectDir 内の .sakura-cloud/<file> の絶対パスを返す（プロジェクト外への脱出を防ぐ）。 */
export function cloudFilePath(projectDir: string, file: string): string {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) {
    throw new Error('プロジェクトフォルダのパスが不正です')
  }
  const full = path.normalize(path.join(projectDir, CLOUD_DIR, file))
  const base = path.normalize(path.join(projectDir, CLOUD_DIR))
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('不正なパスです（プロジェクトの外は操作できません）')
  }
  return full
}

/** projectDir の state.json を読む（無ければ空state）。env.json の name/backend を既定に使う。 */
export function loadCloudState(projectDir: string, spec: EnvSpec): EnvState {
  const stateFile = cloudFilePath(projectDir, CLOUD_STATE_FILE)
  if (!fs.existsSync(stateFile)) return emptyState(spec.name, spec.backend)
  const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
  return {
    name: typeof parsed?.name === 'string' ? parsed.name : spec.name,
    backend: typeof parsed?.backend === 'string' ? parsed.backend : spec.backend,
    resources: Array.isArray(parsed?.resources) ? parsed.resources : [],
    ...(parsed?.meta && typeof parsed.meta === 'object' ? { meta: parsed.meta } : {}),
  }
}

/** state.json を書き込む（.sakura-cloud を作成）。cloud/imagePublish.ts からも使う（複製しない・掟10）。 */
export function saveCloudState(projectDir: string, state: EnvState): void {
  const stateFile = cloudFilePath(projectDir, CLOUD_STATE_FILE)
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

/** env.json を読んで検証済み spec を返す（無ければ null・不正なら throw）。 */
export function loadCloudSpec(projectDir: string): EnvSpec | null {
  const envFile = cloudFilePath(projectDir, CLOUD_ENV_FILE)
  if (!fs.existsSync(envFile)) return null
  const result = validateSpec(JSON.parse(fs.readFileSync(envFile, 'utf-8')))
  if (!result.ok) throw new Error(result.errors.join(' / '))
  return result.spec
}
