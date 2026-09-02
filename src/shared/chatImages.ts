// chatImages.ts — 会話に貼られた画像を「黙って捨てない」ための判断（純粋ロジック）。
//
// ── なぜ要るか（2026-08-20 実測で発見）────────────────────────────────
// 単独チャット（チャットモード）の保存は、こうなっていた:
//
//   保存を試す → 失敗 → **全セッションの画像を全部落として**保存し直す → console.warn だけ
//
// 保存に一度失敗しただけで、これまでの会話の画像がすべて消える。しかも**利用者には
// 何も知らされない**（次に開くと吹き出しから画像が消えているだけ）。
// 手元の実測では chat.json の **99% が画像**（landingTEST は 5.5MB 中 5.5MB）なので、
// 失われるものは小さくない。
//
// 「画像を使う」を押していない画像は、**ここにしか無い**。落とすなら、
//   ① 先にファイルへ書き出して助ける
//   ② 落としたことを画面で伝える
// の両方をしてからにする。
//
// ⚠️ B'-3e-a（単独チャットの保存が「全量書き→追記＋索引」へ変わった）で、この画像レスキュー経路の
// 呼び出し元（renderer/chatStorage.ts の saveAppSessions）は無くなった。追記式（convStore.ts 経由）は
// 1メッセージぶんの chat.json 追記が失敗しても他のメッセージへ波及しない＝「全セッションの画像を
// 全部落として保存し直す」という壊れ方自体が起きない。この純粋関数群は移行では使わない
// （呼び出しゼロ。実装は将来また要るかもしれない判断で残置。tests/chatImages.test.ts はこの
// ファイル自身を直接検証しており、chatStorage.ts の有無に関わらず有効）。
// ここは「何枚あるか」「どんな名前で助けるか」「何と伝えるか」だけを決める。

/** 会話1件のうち、画像を持つものの最小の形。 */
type Msg = { images?: string[] }
type Session = { messages?: Msg[] }

/** 助け出す画像1枚。 */
export type RescueTarget = {
  /** data URL そのもの。 */
  url: string
  /** 書き出すときのファイル名。 */
  name: string
}

/** 2桁ゼロ詰め。 */
const two = (n: number) => String(n).padStart(2, '0')

/**
 * 書き出すファイル名に入れる日時。**手元の時刻**で作る。
 *
 * ⚠️ `toISOString().replace(/[-:T]/g, '')` で作ってはいけない。
 *   ・UTC になるので、利用者の時計とずれた名前になる
 *   ・**`[-:T]` を Tailwind が「クラス名」として拾い**、壊れた CSS（`-: T;`）を吐く
 *     （2026-08-20、ビルドの警告で気づいた）
 */
export function stampOf(now: Date): string {
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}`
}

/** data URL から拡張子を決める（分からなければ png）。 */
export function extOf(dataUrl: string): string {
  const m = /^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl ?? '')
  const raw = (m?.[1] ?? '').toLowerCase()
  if (raw === 'jpeg' || raw === 'jpg') return 'jpg'
  if (raw === 'svg+xml') return 'svg'
  if (/^[a-z0-9]+$/.test(raw)) return raw
  return 'png'
}

/**
 * セッション一覧から、助け出すべき画像を順に並べる。
 * 名前は**並び順で決める**ので、同じ会話なら何度やっても同じ結果になる。
 */
export function rescueTargets(sessions: readonly Session[], stamp: string): RescueTarget[] {
  const out: RescueTarget[] = []
  for (const s of sessions ?? []) {
    for (const m of s?.messages ?? []) {
      for (const url of m?.images ?? []) {
        if (typeof url !== 'string' || !url.startsWith('data:image/')) continue
        const n = String(out.length + 1).padStart(3, '0')
        out.push({ url, name: `会話の画像-${stamp}-${n}.${extOf(url)}` })
      }
    }
  }
  return out
}

/** 画像を落としたセッション一覧を作る（元は書き換えない）。 */
export function withoutImages<T extends Session>(sessions: readonly T[]): T[] {
  return (sessions ?? []).map(s => ({
    ...s,
    messages: Array.isArray(s?.messages)
      ? s.messages.map(m => (m && (m as Msg).images ? { ...m, images: undefined } : m))
      : s?.messages,
  })) as T[]
}

/**
 * 画面に出す知らせ。**何が起きて、どこへ行ったか**を必ず書く。
 * @param saved 助け出せた枚数
 * @param total 落とした枚数
 * @param dir   書き出した場所（プロジェクトからの相対パス。助けられなかったときは空）
 */
export function droppedNote(saved: number, total: number, dir: string): string {
  if (total <= 0) return ''
  const head = `⚠️ 会話を保存できなかったため、画像${total}枚を会話から外しました。`
  if (saved <= 0) {
    return head + '\n画像の書き出しにも失敗したため、この会話を開き直すと画像は表示されません。'
  }
  if (saved < total) {
    return head + `\nうち${saved}枚は「${dir}」へ書き出しました（残り${total - saved}枚は書き出せませんでした）。`
  }
  return head + `\n画像は「${dir}」へ書き出したので、そちらに残っています。`
}
