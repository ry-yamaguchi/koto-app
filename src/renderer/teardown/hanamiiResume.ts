// teardown/hanamiiResume.ts — HANAMII の破棄の「自動の続き」を呼ぶ部品。React に依存しない。**呼ぶ所は3つとも、この1つを通る。**
//
// ── 何のための部品か ─────────────────────────────────────────────────────────
// HANAMII が削除を受け付けた（202）あと、Koto は最長で約5分待つ。待ち切れなかった回・確認が要る回・待っている間に Koto を終えた回は、
// 記録（.sakuraide.json）に「受け付けの印」（publish.hanamii.deletionAccepted）が残る。この部品は、印のあるプロジェクトを探し、
// 記録の tokenId のトークンを読み（D8。teardown/targets/hanamii.ts の loadHanamiiToken と同じ1つ）、1件ずつ順に main の
// hanamii:resumeTeardown を呼ぶ。**利用者に押し直しをさせない。** 確認は最初の破棄で済んでおり、消すのは印の shownPlacements だけ（main が決める）。
//
// ── 呼ぶ所（どれもここの2つの関数のどちらかを通る）─────────────────────────────────
//   1. Koto の起動のあと（作業場所が分かってから・1回）  … resumeHanamiiDeletionsIn(作業場所)   〔App.tsx〕
//   2. 📡 公開したもの一覧を開いたとき                  … resumeHanamiiDeletionsIn(作業場所)   〔PublishedListModal.tsx〕
//   3. 【公開】の HANAMII の画面を開いたとき（そのプロジェクトだけ）… resumeHanamiiDeletionIn(プロジェクト)〔HanamiiPanel.tsx〕
// 結果は main の処理の記録（projectOps）に乗るので、📡・HANAMII の画面・プロジェクトの削除の窓の進み具合の表示がそのまま読む。ここでは結果を読まない。
//
// ── 守り ────────────────────────────────────────────────────────────────────
//   ・印が無い・印の projectId が記録の projectId と違うプロジェクトは呼ばない（main も断るが、外へ出す前にここでも止める）
//   ・同じプロジェクトで続きが走っている間は、二重に呼ばない（3つの呼ぶ所が重なっても1件ずつ）
//   ・トークンが見つからなければ呼ばない。印は残る（次に開いたとき、また試す）。使用中・先頭の登録へは倒さない（D8）。
//     **記録に tokenId が無い旧い記録は、そもそも対象にしない**（loadHanamiiToken は tokenId が無いと使用中・先頭のトークンへ倒れる。
//     自動の続きは確認の窓が無く、別のアカウントのトークンだと「見えない」を「消えた」と読んで保存場所を消してしまう）。
//     旧い記録は、確認つきの 🗑 の押し直しにだけ任せる
//   ・トークンは使う瞬間に読んで引数で渡し、ここでは保存しない（掟4）
//   ・何があっても投げない（起動や画面の表示を止めない）

import { hanamiiDeletionAcceptedOf } from '../../shared/publishMeta'
import { normDir } from '../projectOpsView'
import { metaPath } from '../publishRecord'
import { loadHanamiiToken } from './targets/hanamii'

/** 続きを呼ぶ対象（記録から読んだ、呼ぶのに要る3つだけ）。 */
export type HanamiiResumeCandidate = { projectDir: string; projectId: string; tokenId: string }

/** 口（テストでは偽物を渡す）。 */
export interface HanamiiResumeDeps {
  /** 作業場所の直下のプロジェクトの公開の記録（`.sakuraide.json` の publish）を読む。 */
  readWorkspace(workspaceDir: string): Promise<Array<{ dir: string; publish: unknown }>>
  /** そのプロジェクトの `.sakuraide.json` を、解析して返す。読めなければ null。 */
  readProject(projectDir: string): Promise<unknown>
  /** 記録の tokenId からトークンを読む（見つからなければ null）。 */
  loadToken(tokenId: string): Promise<string | null>
  /** main の hanamii:resumeTeardown を1回。 */
  resume(projectDir: string, auth: { token: string }, opts: { projectId: string }): Promise<unknown>
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

/**
 * 公開の記録（`publish`）から、続きを呼ぶ対象を読む（純関数）。**印があり、印の projectId が記録の projectId と一致するときだけ**。
 * 形が違うもの・印の無いもの・projectId の違うもの・**tokenId の無いもの**は null（呼ばない側に倒す）。
 */
export function hanamiiResumeCandidateOf(projectDir: string, publish: unknown): HanamiiResumeCandidate | null {
  const mark = hanamiiDeletionAcceptedOf({ publish })
  if (!mark) return null
  const h = isObj(publish) && isObj(publish.hanamii) ? publish.hanamii : {}
  const projectId = typeof h.projectId === 'string' && h.projectId !== '' ? h.projectId : null
  if (projectId === null || mark.projectId !== projectId) return null
  // tokenId の無い旧い記録は対象にしない（印は残り、確認つきの押し直しだけが進める）。
  if (typeof h.tokenId !== 'string' || h.tokenId === '') return null
  return { projectDir, projectId, tokenId: h.tokenId }
}

export interface HanamiiResumer {
  /** 作業場所の直下で、印のあるプロジェクトを1件ずつ順に呼ぶ。呼んだプロジェクトの一覧を返す（投げない）。 */
  resumeIn(workspaceDir: string): Promise<string[]>
  /** そのプロジェクトだけ。印があれば呼ぶ。呼んだら true（投げない）。 */
  resumeProject(projectDir: string): Promise<boolean>
}

export function createHanamiiResumer(deps: HanamiiResumeDeps): HanamiiResumer {
  /** 続きが走っているプロジェクト（normDir で揃えた形）。 */
  const running = new Set<string>()

  async function callOne(c: HanamiiResumeCandidate): Promise<boolean> {
    const key = normDir(c.projectDir)
    if (running.has(key)) return false
    running.add(key)
    try {
      const token = await deps.loadToken(c.tokenId)
      if (!token) return false // 印は残る。次に開いたとき、また試す
      await deps.resume(c.projectDir, { token }, { projectId: c.projectId })
      return true
    } catch {
      return false // 結果は処理の記録に乗る。起動や画面の表示は止めない
    } finally {
      running.delete(key)
    }
  }

  return {
    async resumeIn(workspaceDir) {
      const called: string[] = []
      let projects: Array<{ dir: string; publish: unknown }>
      try { projects = await deps.readWorkspace(workspaceDir) } catch { return called }
      for (const p of projects) {
        if (!p || typeof p.dir !== 'string') continue
        const c = hanamiiResumeCandidateOf(p.dir, p.publish)
        if (c && await callOne(c)) called.push(c.projectDir)
      }
      return called
    },
    async resumeProject(projectDir) {
      let meta: unknown
      try { meta = await deps.readProject(projectDir) } catch { return false }
      const c = hanamiiResumeCandidateOf(projectDir, isObj(meta) ? meta.publish : null)
      return c ? callOne(c) : false
    },
  }
}

/** 本物の口。 */
const realDeps: HanamiiResumeDeps = {
  readWorkspace: async workspaceDir => {
    const r = await window.electronAPI.fs.publishedRecords(workspaceDir)
    return r.ok ? r.projects.map(p => ({ dir: p.dir, publish: p.publish })) : []
  },
  readProject: async projectDir => JSON.parse(await window.electronAPI.fs.readFile(metaPath(projectDir))),
  loadToken: loadHanamiiToken,
  resume: (projectDir, auth, opts) => window.electronAPI.hanamii.resumeTeardown(projectDir, auth, opts),
}

const resumer = createHanamiiResumer(realDeps)

/** 呼ぶ所1・2（起動のあと・📡 を開いたとき）。作業場所の直下で、印のあるプロジェクトを順に続ける。 */
export const resumeHanamiiDeletionsIn = (workspaceDir: string): Promise<string[]> => resumer.resumeIn(workspaceDir)

/** 呼ぶ所3（【公開】の HANAMII の画面を開いたとき）。そのプロジェクトだけ。 */
export const resumeHanamiiDeletionIn = (projectDir: string): Promise<boolean> => resumer.resumeProject(projectDir)
