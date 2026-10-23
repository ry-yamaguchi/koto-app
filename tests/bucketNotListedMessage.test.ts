import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { bucketNotListedMessage, BUCKET_NAME_REUSE_RULE } from '../src/shared/objectStorage'

// ── なぜこのテストが要るか（2026-10-19）────────────────────────────────────
// 保存場所（バケット）を作ろうとして一覧に現れなかったとき、Koto は
// 「削除した直後で名前が解放されていない。しばらく待ってからお試しください」と言っていた。
// 実機（0.6.22-rc.3）で、10/1 に削除した名前を 18 日後に作ろうとしても HTTP 409 のまま作れなかった。
// さくらの FAQ（https://manual.sakura.ad.jp/cloud/objectstorage/faq.html）が言うとおり、
// **同じ月のうちは、削除した名前を作り直せない**。待っても直らないのに「待って」と案内していた。
// 2026-10-19 検分: 規則の文に「翌月」と書くと「翌月いっぱい作れない」とも読めるので、
// 原本に沿って「削除した月のうちは作り直せません」にした。
//
// 説明の文は 3つの入口（保存場所の用意・設定の「新しく作る」・公開の apply）と画面の黄色い文で
// 同じことを言う。**1か所の関数（bucketNotListedMessage）と定数（BUCKET_NAME_REUSE_RULE）に集め**、
// 入口がそれを使っていることを、ここで固定する。

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

const NEXT = '別の名前でお試しください。'

describe('bucketNotListedMessage（作成を頼んだのに一覧に無かったときの説明）', () => {
  it('★★★ 409 は「作れませんでした」と言い、削除した月のうちは作り直せないことと次の操作と応答を言う', () => {
    const m = bucketNotListedMessage({ bucket: 'koto-data-x', status: 409, responseText: 'Conflict', nextStep: NEXT })
    expect(m).toBe(
      '保存場所『koto-data-x』を作れませんでした。この名前は、ほかで使われているか、今月削除した名前です。'
      + `${BUCKET_NAME_REUSE_RULE}${NEXT}（作成の応答: HTTP 409 Conflict）`,
    )
    expect(m).toContain('削除した月のうちは作り直せません')
  })

  it('★★★ 409 の文に、古い理解（「直後」「しばらく待って」「名前が解放」）が含まれない', () => {
    const m = bucketNotListedMessage({ bucket: 'koto-data-x', status: 409, responseText: '', nextStep: NEXT })
    expect(m).not.toContain('直後')
    expect(m).not.toContain('しばらく待って')
    expect(m).not.toContain('解放')
  })

  it('★★ 200 など 2xx は「一覧にまだ出ていません」と言い、しばらく待つよう案内する（nextStep は使わない）', () => {
    const m = bucketNotListedMessage({ bucket: 'koto-data-x', status: 200, responseText: '', nextStep: NEXT })
    expect(m).toBe(
      '保存場所『koto-data-x』を作成しましたが、一覧にまだ出ていません。しばらく待ってからお試しください。'
      + '（作成の応答: HTTP 200）',
    )
    expect(m).not.toContain(NEXT)
  })

  it('★★★ 200 の文に規則の文が含まれない（作成できているのに「作り直せません」と言わない）', () => {
    for (const status of [200, 201, 204]) {
      const m = bucketNotListedMessage({ bucket: 'koto-data-x', status, responseText: 'ok', nextStep: NEXT })
      expect(m, `HTTP ${status}`).not.toContain('削除した月のうち')
      expect(m, `HTTP ${status}`).not.toContain('作り直せません')
      expect(m, `HTTP ${status}`).toContain(`HTTP ${status} ok`)
    }
  })

  it('★★★ omitHead の 409: 書き出しの「保存場所『X』を作れませんでした。」を省き、あとは同じ', () => {
    const extra = 'いまある保存場所: なし'
    const m = bucketNotListedMessage({ bucket: 'koto-data-x', status: 409, responseText: 'Conflict', nextStep: NEXT, extra, omitHead: true })
    expect(m).toBe(
      'この名前は、ほかで使われているか、今月削除した名前です。'
      + `${BUCKET_NAME_REUSE_RULE}${NEXT}（作成の応答: HTTP 409 Conflict／${extra}）`,
    )
    expect(m.startsWith('保存場所『')).toBe(false)
    expect(m).not.toContain('koto-data-x')
  })

  it('★★★ omitHead の 2xx: 「保存場所『X』を作成しましたが、」を「作成を頼みましたが、」にし、あとは同じ', () => {
    const m = bucketNotListedMessage({ bucket: 'koto-data-x', status: 200, responseText: '', nextStep: NEXT, omitHead: true })
    expect(m).toBe('作成を頼みましたが、一覧にまだ出ていません。しばらく待ってからお試しください。（作成の応答: HTTP 200）')
    expect(m.startsWith('保存場所『')).toBe(false)
    expect(m).not.toContain('koto-data-x')
    expect(m).not.toContain(NEXT)
  })

  it('★★ omitHead が false／省略なら、書き出しに保存場所の名前を言う（いまのまま）', () => {
    for (const opts of [{}, { omitHead: false }]) {
      const m409 = bucketNotListedMessage({ bucket: 'koto-data-x', status: 409, responseText: '', nextStep: NEXT, ...opts })
      expect(m409.startsWith('保存場所『koto-data-x』を作れませんでした。この名前は、')).toBe(true)
      const m200 = bucketNotListedMessage({ bucket: 'koto-data-x', status: 200, responseText: '', nextStep: NEXT, ...opts })
      expect(m200.startsWith('保存場所『koto-data-x』を作成しましたが、一覧にまだ出ていません。')).toBe(true)
    }
  })

  it('★★ nextStep は 409 の文に入る（入口ごとの次の操作）', () => {
    const a = bucketNotListedMessage({ bucket: 'b', status: 409, responseText: '', nextStep: '操作A。' })
    const b = bucketNotListedMessage({ bucket: 'b', status: 409, responseText: '', nextStep: '操作B。' })
    expect(a).toContain('操作A。')
    expect(a).not.toContain('操作B。')
    expect(b).toContain('操作B。')
    // 規則の文のあとに続く（規則 → 次の操作 → 応答の括弧）
    expect(a.indexOf(BUCKET_NAME_REUSE_RULE)).toBeLessThan(a.indexOf('操作A。'))
    expect(a.indexOf('操作A。')).toBeLessThan(a.indexOf('（作成の応答'))
  })

  it('★★ extra は応答の括弧の中に「／」で続く（409 も 2xx も）', () => {
    const extra = 'いまある保存場所: koto-data-a、 koto-data-b'
    const m409 = bucketNotListedMessage({ bucket: 'b', status: 409, responseText: 'Conflict', nextStep: NEXT, extra })
    expect(m409.endsWith(`（作成の応答: HTTP 409 Conflict／${extra}）`)).toBe(true)
    const m200 = bucketNotListedMessage({ bucket: 'b', status: 200, responseText: '', nextStep: NEXT, extra })
    expect(m200.endsWith(`（作成の応答: HTTP 200／${extra}）`)).toBe(true)
    // extra が無ければ「／」は出ない
    const none = bucketNotListedMessage({ bucket: 'b', status: 409, responseText: 'Conflict', nextStep: NEXT })
    expect(none).not.toContain('／')
  })

  it('★ 応答の本文が空のときは、HTTP の番号だけを括弧に入れる（余計な空白を出さない）', () => {
    const m = bucketNotListedMessage({ bucket: 'b', status: 409, responseText: '', nextStep: NEXT })
    expect(m.endsWith('（作成の応答: HTTP 409）')).toBe(true)
  })

  it('★ 括弧は1文に1つ（掟5）: 文の中の「（」は応答の括弧の1つだけ', () => {
    for (const status of [409, 200]) {
      const m = bucketNotListedMessage({ bucket: 'b', status, responseText: 'x', nextStep: NEXT, extra: 'y' })
      expect((m.match(/（/g) ?? []).length, `HTTP ${status}`).toBe(1)
    }
  })

  it('★ BUCKET_NAME_REUSE_RULE は「削除した月のうちは」と言い、「翌月」「直後」「しばらく」を含まない', () => {
    expect(BUCKET_NAME_REUSE_RULE).toBe('さくらでは、削除した保存場所と同じ名前は、削除した月のうちは作り直せません。')
    expect(BUCKET_NAME_REUSE_RULE).not.toContain('翌月')
    expect(BUCKET_NAME_REUSE_RULE).not.toContain('直後')
    expect(BUCKET_NAME_REUSE_RULE).not.toContain('しばらく')
  })
})

describe('入口が、この関数・定数を使っている（形）', () => {
  const cloud = read('src/main/ipc/cloud.ts')
  const adapter = read('src/main/cloud/storageAdapter.ts')
  const notice = read('src/renderer/components/StorageNotice.tsx')

  it('★★ cloud.ts は 2 か所（保存場所の用意・新しく作る）で bucketNotListedMessage を呼び、文を持たない', () => {
    expect(cloud.match(/bucketNotListedMessage\(\{/g)?.length).toBe(2)
    // 文字列を cloud.ts に残さない（組み立ては shared の関数へ出した）
    expect(cloud).not.toContain('作成の応答')
    expect(cloud).not.toContain('一覧にまだ出ていません')
    // cloud.ts の2入口は前置きをしない（書き出しに名前を言う）
    expect(cloud).not.toContain('omitHead')
    expect(cloud).not.toContain('削除した月のうち')
  })

  it('★★ storageAdapter.ts は ensureBucket で throw する文を bucketNotListedMessage で作る（文を持たない）', () => {
    expect(adapter.match(/bucketNotListedMessage\(\{/g)?.length).toBe(1)
    expect(adapter).toMatch(/throw new Error\(bucketNotListedMessage\(\{/)
    // apply が「保存場所『X』を用意できませんでした: 」と前置きするので、名前と失敗を2回言わない
    expect(adapter).toMatch(/omitHead: true/)
    expect(adapter).not.toContain('作成の応答')
    expect(adapter).not.toContain('一覧にまだ出ていません')
    expect(adapter).not.toContain('名前が解放')
  })

  it('★★★ StorageNotice の黄色の文は BUCKET_NAME_REUSE_RULE を呼んで出し、旧文を持たない', () => {
    // import している
    expect(notice).toMatch(/import \{[^}]*\bBUCKET_NAME_REUSE_RULE\b[^}]*\} from '\.\.\/\.\.\/shared\/objectStorage'/)
    // 「見つかりません。」→ {BUCKET_NAME_REUSE_RULE} →「下から選び直してください。」の順に、1つの文として並ぶ
    const start = notice.indexOf('⚠️ この保存場所は見つかりません。')
    expect(start, '黄色の文が無い').toBeGreaterThan(-1)
    const block = notice.slice(start, start + 200)
    expect(block).toMatch(/^⚠️ この保存場所は見つかりません。\{BUCKET_NAME_REUSE_RULE\}\s*下から選び直してください。/)
    // 旧文（手で複製した文）が残っていない
    expect(notice).not.toContain('削除した直後は、同じ名前で作り直せないことがあります')
    expect(notice).not.toContain('削除した月のうちは作り直せません') // 文は定数だけが持つ（複製しない）
  })
})
