// buildContext.ts — ビルドコンテキストの解決と、起動のしかた（runtime）の判定。
//
// 2026-09-12（専有型 D-2a）に ipc/cloud.ts から**純粋移動**した。cloud/imagePublish.ts からも使うため
// cloud 層に置く（cloud → ipc の import＝循環を作らない）。中身は移動前と同じ。
import * as path from 'path'
import * as fs from 'fs'
import { detectRuntime, type RuntimeChoice } from '../../shared/runtimeDetect'

/**
 * dockerfile ソースのビルドコンテキスト絶対パスを、プロジェクト内に閉じ込めて解決する。
 * context が絶対パスや .. でプロジェクト外を指す場合は throw（confineToProject 相当）。
 * cloud/imagePublish.ts からも使う（複製しない・掟10）。
 */
export function resolveBuildContext(projectDir: string, context: string): string {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) {
    throw new Error('プロジェクトフォルダのパスが不正です')
  }
  if (typeof context !== 'string' || context.length === 0) {
    throw new Error('ビルドコンテキストが不正です')
  }
  if (path.isAbsolute(context)) {
    throw new Error('ビルドコンテキストに絶対パスは指定できません')
  }
  const full = path.normalize(path.join(projectDir, context))
  if (full !== projectDir && !full.startsWith(projectDir + path.sep)) {
    throw new Error('不正なビルドコンテキストです（プロジェクトの外は指定できません）')
  }
  return full
}

/**
 * プロジェクトを見て、何で動かすかを決める（IO はここだけ。判断は shared）。
 * package.json が壊れていても落ちない（読めなければ「無い」として扱う）。
 * cloud/imagePublish.ts からも使う（複製しない・掟10）。
 */
export function detectRuntimeFor(contextAbs: string): RuntimeChoice {
  let packageJson: unknown = null
  try {
    const p = path.join(contextAbs, 'package.json')
    if (fs.existsSync(p)) packageJson = JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    // 壊れた package.json は「無い」とはしない。**静的だと決めつけると
    // ソースが丸見えになる**ので、直してもらうよう伝える
    return { kind: 'unsupported', reason: 'package.json を読み取れませんでした。書式（JSON）が正しいか確認してください。' }
  }
  let fileNames: string[] = []
  try {
    fileNames = fs.readdirSync(contextAbs, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name)
  } catch { fileNames = [] }
  return detectRuntime({ packageJson, fileNames })
}
