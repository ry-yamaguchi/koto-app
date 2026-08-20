// preflight.ts — 「いま公開したら、本当に通るか」を先に確かめる（純ロジック）。
//
// ── なぜ要るか（2026-08-14 の実機検証）────────────────────────────────
// この日、公開は10回以上失敗した。そのうち**4件は押す前に分かったはず**のものだった:
//
//   ・レジストリが消えているのに「登録済み ✓」と出ていた（手元の認証情報だけを見ていた）
//   ・保存場所が作られていないのに「ある」と誤読していた（409 を成功と読んだ）
//   ・公開名が、記録に無い孤児のアプリと衝突していた
//   ・Node で動かせない作り（依存ライブラリ）だった
//
// どれも「押す → 数分待つ → 分からないエラー」という形で返ってきた。
// **押す前に、まとめて確かめて、まとめて伝える。**
//
// ここは判断だけを持つ。実際に問い合わせるのは main 側（IO）。

/** 1件の確認結果。 */
export type PreflightCheck = {
  /** 内部の識別子（画面には出さない）。 */
  id: string
  /** 利用者に見せる項目名（「イメージの置き場」など）。 */
  label: string
  status: 'ok' | 'warn' | 'ng'
  /** 何が分かったか。**ng のときは「どうすればよいか」まで書く。** */
  note: string
  /**
   * その場で直せるなら、その手段（2026-08-14 Ryosuke 指摘）。
   *
   * **直し方が分かっているのに、わざと失敗させてから出すのは筋が通らない。**
   * 回復のボタンを「公開の失敗」に紐づけていたため、確認で分かっていても
   * 一度公開を押させる形になっていた。確認の結果にも同じ手段を出す。
   */
  fix?: 'reset-registry' | 'ask-ai' | 'ai-fix'
  /**
   * `ai-fix` のときに AI へ渡す指示（2026-08-19 Ryosuke 指定）。
   *
   * 「AIに修正させるボタンを作って、押すと修正指示までできるように」。
   * `ask-ai`（入力欄に文を入れるだけ）と違い、**押したら直しにいく**。
   * どこを・どう直すかまで書いた文をここに入れる。
   */
  fixPrompt?: string
  /**
   * Koto 自身が片づけられるファイル（プロジェクト相対・2026-08-19 Ryosuke 指示）。
   *
   * どこからも使われていない画像など、**AI では直せないが Koto なら消せる**もの。
   * 押せるものが何も無いと行き止まりになるため、ここに入れて画面にボタンを出す。
   * 消すのはゴミ箱へ（完全削除ではない＝戻せる）。
   */
  unusedFiles?: string[]
}

export type PreflightResult = {
  /** 公開してよいか（`ng` が1つも無い）。 */
  canPublish: boolean
  /** 見出しに出す一言。 */
  summary: string
  checks: PreflightCheck[]
}

/**
 * 確認結果をまとめる（純関数）。
 *
 * **`warn` では止めない。** 止めるのは「確実に失敗する」と分かったときだけ。
 * 迷ったら通す側に倒す——確かめられなかっただけで公開できないのは、
 * 利用者にとって「壊れている」のと同じである。
 */
export function summarizePreflight(checks: readonly PreflightCheck[]): PreflightResult {
  const list = [...(checks ?? [])]
  const ng = list.filter(c => c.status === 'ng')
  const warn = list.filter(c => c.status === 'warn')

  if (ng.length > 0) {
    return {
      canPublish: false,
      summary: ng.length === 1
        ? `このままでは公開できません（${ng[0].label}）`
        : `このままでは公開できません（${ng.length}件）`,
      checks: list,
    }
  }
  if (warn.length > 0) {
    return {
      canPublish: true,
      summary: `公開できます（気になる点が${warn.length}件あります）`,
      checks: list,
    }
  }
  return { canPublish: true, summary: '公開できます', checks: list }
}

/** 並べる順（利用者が直しやすい順＝手前のものから）。 */
const ORDER = ['key', 'spec', 'runtime', 'registry', 'name', 'storage'] as const

/** 画面に出す順に並べ替える（純関数）。 */
export function sortChecks(checks: readonly PreflightCheck[]): PreflightCheck[] {
  const rank = (id: string) => {
    const i = (ORDER as readonly string[]).indexOf(id)
    return i === -1 ? ORDER.length : i
  }
  return [...(checks ?? [])].sort((a, b) => rank(a.id) - rank(b.id))
}

/**
 * 確認で見つかった問題を、AIに相談するための文面（**秘密は含めない**）。
 *
 * 入力欄に入れるだけで送信はしない（ほかの「AIに〜」と同じ形）。
 */
export function askAiAboutCheck(check: Pick<PreflightCheck, 'label' | 'note'>): string {
  return [
    '公開する前の確認で、次の問題が見つかりました。直してください。',
    `${check.label}: ${check.note}`,
    'アプリのコードを変えれば直せる場合は、直したうえで何を変えたか教えてください。',
  ].join('\n')
}
