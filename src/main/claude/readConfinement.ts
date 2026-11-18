// readConfinement.ts — Claude の読み取り（Read・Glob・Grep）を、プロジェクトの中に閉じ込める判定（P42-5）。
//
// Read・Glob・Grep を allowedTools の名前だけで許可すると、SDK は canUseTool を呼ばずに、プロジェクトの外の
// 絶対パスも読ませる（手元の偽 API と同梱の実行体で確かめた）。そこで allowedTools から外し、SDK が「作業フォルダ
// （cwd）と additionalDirectories の外」と見たときだけ canUseTool へ回す形にする。ここは Koto 自身の二重の点検:
// 道具の入力のパスを realpath で解き（外を指すリンクも外になる）、プロジェクトのフォルダの中かを見る。
// どちらかが外なら断る（利用者には聞かない）。

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** 読み取りの道具の名前（SDK 内蔵）。 */
export const CONFINED_READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep'])

/** 存在する一番近い祖先を realpath で解き、残りを足す（まだ無いパスでも、途中のリンクを解いた絶対パスを返す）。 */
function realpathLoose(abs: string): string {
  let current = abs
  const rest: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync(current)
      return rest.length > 0 ? path.join(real, ...rest.reverse()) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return abs
      rest.push(path.basename(current))
      current = parent
    }
  }
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

/** Glob の pattern のうち、* ? [ { より前の固定の部分。 */
function staticPrefix(pattern: string): string {
  const i = pattern.search(/[*?[{]/)
  return i < 0 ? pattern : pattern.slice(0, i)
}

/** 読もうとしているパスの候補（絶対パス化の前の文字列）。pattern の解けない形は、外として扱う印（null）を返す。 */
function candidatePaths(toolName: string, input: Record<string, unknown>): { paths: string[]; unresolvable: string | null } {
  const paths: string[] = []
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
  if (toolName === 'Read') {
    const p = str(input.file_path)
    if (p) paths.push(p)
  } else {
    const p = str(input.path)
    if (p) paths.push(p)
    if (toolName === 'Glob') {
      const pattern = str(input.pattern)
      if (pattern) {
        const prefix = staticPrefix(pattern)
        const remainder = pattern.slice(prefix.length)
        if (prefix) paths.push(prefix)
        // 固定の部分のあとに書かれた「.. の段」や、{a,/etc/x} のような枝の中の絶対パスは、静的に解けないので外として断る。
        if (remainder.split(/[{},/]/).map(t => t.trim()).includes('..')) return { paths, unresolvable: pattern }
        // 枝（{ と } のあいだを , で分けた選択肢）の先頭が絶対パス・~ のものも断る。枝の外の「/」始まり（/**/*.ts など）は絶対パスではない。
        for (const m of remainder.matchAll(/\{([^{}]*)\}/g)) {
          for (const alt of m[1].split(',')) {
            const t = alt.trim()
            if (t.startsWith('/') || t.startsWith('~')) return { paths, unresolvable: pattern }
          }
        }
      }
    }
  }
  return { paths, unresolvable: null }
}

/**
 * Read・Glob・Grep の呼び出しが、プロジェクトの外を指すか。外なら、そのパス（断る文に入れる）を返す。中なら null。
 * @param scopeDir プロジェクトのフォルダ（絶対パス）。
 * @param cwd Claude の作業フォルダ（相対パスの基準）。
 */
export function readTargetOutsideProject(toolName: string, input: unknown, scopeDir: string, cwd: string): string | null {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const root = realpathLoose(path.resolve(scopeDir))
  const { paths, unresolvable } = candidatePaths(toolName, obj)
  if (unresolvable !== null) return unresolvable
  // パスが無い Read は、何を読むか分からないので外扱い。Glob・Grep は path 無し＝作業フォルダ。
  if (toolName === 'Read' && paths.length === 0) return '(不明なパス)'
  const targets = paths.length > 0 ? paths : [cwd]
  for (const raw of targets) {
    const abs = path.resolve(cwd, expandHome(raw))
    if (!isInside(root, realpathLoose(abs))) return abs
  }
  // Glob は path と pattern の両方が基準なので、作業フォルダ自身も中かを見る（path だけ・pattern だけの場合の取りこぼし防止）。
  if (!isInside(root, realpathLoose(path.resolve(cwd)))) return path.resolve(cwd)
  return null
}

/** 断るときに Claude へ返す文。 */
export function readOutsideDenialMessage(p: string): string {
  return `プロジェクトの外のファイル（${p}）は読めません。Koto は、Claude の読み取りをプロジェクトの中に限っています。必要なファイルは、ユーザーにプロジェクトの中へ置いてもらってください。`
}
