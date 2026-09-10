import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildRegistryMeta, buildCreateRegistryBody, extractRegistryMetaApplied, type RegistryMeta, type RequestResult } from '../src/main/cloud/client'
import { provisionRegistryWithMeta, type RegistryProvisionClient } from '../src/main/cloud/registryProvision'

// roadmap #36: さくら側で「どれが何か」を分類できるようにする（コンテナレジストリの Description/Tags）。
// 「作るときに設定できるか」は未確認（掟1）なので、この一式は:
//   1. buildRegistryMeta（純関数・中身の組み立てだけ）
//   2. buildCreateRegistryBody（meta を任意で足すだけ）
//   3. provisionRegistryWithMeta（フォールバック・検証込みの一連の流れ。偽クライアントでテスト）
// に分けてある。3 は「呼び出し回数と本文」で判定し、文字列一致には頼らない。

describe('buildRegistryMeta（純関数）', () => {
  it('プロジェクト名から説明とタグを組み立てる', () => {
    const meta = buildRegistryMeta('yamada-shop')
    expect(meta.description).toBe('Koto が作成 / プロジェクト: yamada-shop')
    expect(meta.tags).toEqual(['koto', 'yamada-shop'])
  })

  it('作成日時を混ぜない（同じ名前なら常に同じ結果。呼び出しごとにブレない）', () => {
    const a = buildRegistryMeta('same-project')
    const b = buildRegistryMeta('same-project')
    expect(a).toEqual(b)
  })

  it('変な文字（空白・記号・非ASCII）が混ざったタグは、安全な文字列（英数字とハイフン）に落ちる', () => {
    const meta = buildRegistryMeta('Yamada 商店!! Shop')
    expect(meta.tags[0]).toBe('koto')
    expect(meta.tags[1]).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(meta.tags[1]).toBe('Yamada-Shop')
    // 説明のほうは自由記述なので、元の文字はそのまま残る。
    expect(meta.description).toContain('Yamada 商店!! Shop')
  })

  // 2026-09-09 検分・指摘4: かつては安全な文字が無い名前を一律 'project' に潰していたため、
  // 日本語名の複数プロジェクトが全部同じタグになり、分類にならなかった。名前から決まる
  // 短い識別子（project-<ハッシュ>）を足す。
  it('安全な文字が1つも無い名前（絵文字・日本語のみ）は "project-<識別子>" にフォールバックする（空文字列のタグを送らない）', () => {
    const meta = buildRegistryMeta('山田商店')
    expect(meta.tags[1]).toMatch(/^project-[0-9a-f]{8}$/)
  })

  it('日本語名が違えば、フォールバックのタグも違う（違うプロジェクトが同じタグに潰れない）', () => {
    const a = buildRegistryMeta('山田商店')
    const b = buildRegistryMeta('鈴木商店')
    expect(a.tags[1]).not.toBe(b.tags[1])
  })

  it('同じ日本語名なら、フォールバックのタグも常に同じ（決定的。Math.random/Date.now を使わない）', () => {
    const a = buildRegistryMeta('山田商店')
    const b = buildRegistryMeta('山田商店')
    expect(a.tags[1]).toBe(b.tags[1])
  })

  it('空文字・空白のみの名前でも壊れない', () => {
    const meta = buildRegistryMeta('   ')
    expect(meta.description).toContain('(無題)')
    expect(meta.tags.length).toBe(2)
  })

  it('説明は200文字に収める（極端に長いプロジェクト名でも本文が際限なく伸びない）', () => {
    const meta = buildRegistryMeta('a'.repeat(500))
    expect(meta.description.length).toBeLessThanOrEqual(200)
  })

  // 2026-09-09 検分・指摘5: 旧実装は `.slice(0, 200)`（UTF-16コード単位）で切っていたため、
  // 199文字級＋絵文字の名前だとサロゲートペアの真ん中で切れ、孤立サロゲートで終わる
  // 説明文が作られていた（node で再現済み）。絵文字がちょうど200文字目にまたがるよう
  // 仕込み、孤立サロゲートが残らないことを確かめる。
  it('絵文字で終わる長い名前でも、説明の末尾が壊れない（孤立サロゲートで終わらない）', () => {
    const prefix = 'Koto が作成 / プロジェクト: '
    // prefix + filler がちょうど199文字になるよう仕込む＝絵文字（サロゲートペア）が
    // 旧実装の切り出し境界（200文字目）にまたがる。
    const filler = 'a'.repeat(199 - prefix.length)
    const meta = buildRegistryMeta(filler + '😀')
    const hasLoneSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(meta.description) || // 孤立した上位サロゲート
      /(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(meta.description) // 孤立した下位サロゲート
    expect(hasLoneSurrogate).toBe(false)
  })
})

describe('buildCreateRegistryBody: meta は任意（渡さなければ従来どおり Name のみ）', () => {
  it('meta を渡すと Description/Tags が本文に入る', () => {
    const body = buildCreateRegistryBody({ name: 'a', subdomainLabel: 'a', meta: { description: 'd', tags: ['koto', 'a'] } }) as any
    expect(body.CommonServiceItem.Name).toBe('a')
    expect(body.CommonServiceItem.Description).toBe('d')
    expect(body.CommonServiceItem.Tags).toEqual(['koto', 'a'])
  })

  it('meta を渡さなければ Description/Tags は本文に出ない（既存の挙動を維持）', () => {
    const body = buildCreateRegistryBody({ name: 'a', subdomainLabel: 'a' }) as any
    expect(body.CommonServiceItem.Name).toBe('a')
    expect('Description' in body.CommonServiceItem).toBe(false)
    expect('Tags' in body.CommonServiceItem).toBe(false)
  })
})

// 2026-09-10 検分の直し: 「形が違う」（読めない）ときと「読めて一致しない」ときを区別する。
// 前者は null（分からない。次回また試してよい）、後者は false（未対応と確定）。
describe('extractRegistryMetaApplied: 読み直した応答から、実際に反映されたかを判定する', () => {
  const expected: RegistryMeta = { description: 'Koto が作成 / プロジェクト: x', tags: ['koto', 'x'] }

  it('★ 一致 → true（Description が完全一致・Tags が期待値をすべて含んでいれば true）', () => {
    const data = { CommonServiceItem: { Description: expected.description, Tags: ['koto', 'x', '追加のタグ'] } }
    expect(extractRegistryMetaApplied(data, expected)).toBe(true)
  })

  it('★ 不一致 → false（Description が違う。部分一致では成功扱いにしない）', () => {
    const data = { CommonServiceItem: { Description: '別の説明', Tags: expected.tags } }
    expect(extractRegistryMetaApplied(data, expected)).toBe(false)
  })

  it('★ 不一致 → false（期待したタグの一部が欠けている）', () => {
    const data = { CommonServiceItem: { Description: expected.description, Tags: ['koto'] } }
    expect(extractRegistryMetaApplied(data, expected)).toBe(false)
  })

  // ── ここから「形が違う」→ null（false ではない）の対 ─────────────────────
  it('★ CommonServiceItem に Description/Tags 自体が無い → null（false と決めつけない）', () => {
    const data = { CommonServiceItem: { Name: 'x' } }
    expect(extractRegistryMetaApplied(data, expected)).toBeNull()
  })

  it('★ CommonServiceItem 自体が無い → null（一覧と同じ形とは仮定しない）', () => {
    expect(extractRegistryMetaApplied({}, expected)).toBeNull()
    expect(extractRegistryMetaApplied(null, expected)).toBeNull()
  })

  it('★ 小文字キー（commonserviceitem/description/tags）は「別の形」として null（false にしない）', () => {
    const data = { commonserviceitem: { description: expected.description, tags: expected.tags } }
    expect(extractRegistryMetaApplied(data, expected)).toBeNull()
  })

  it('Description が string でない、Tags が配列でないときも null', () => {
    expect(extractRegistryMetaApplied({ CommonServiceItem: { Description: 123, Tags: expected.tags } }, expected)).toBeNull()
    expect(extractRegistryMetaApplied({ CommonServiceItem: { Description: expected.description, Tags: 'x' } }, expected)).toBeNull()
  })
})

// ── provisionRegistryWithMeta: 偽クライアントで「呼び出し回数と本文」を確かめる ──────────────
// 文字列一致（メッセージの一部を見る等）には頼らない。何回・どんな引数で呼ばれたかで判定する。

type Call =
  | { method: 'create'; opts: { name: string; subdomainLabel: string; meta?: RegistryMeta } }
  | { method: 'get'; id: string }

function ok(data: unknown): RequestResult {
  return { dryRun: false, ok: true, status: 200, data }
}
function fail(status: number, data: unknown): RequestResult {
  return { dryRun: false, ok: false, status, data }
}

/** スクリプトどおりに応答する偽クライアント。呼び出しはすべて calls に記録する。 */
function fakeClient(script: { create: RequestResult[]; get?: RequestResult[] }): { client: RegistryProvisionClient; calls: Call[] } {
  const calls: Call[] = []
  let ci = 0
  let gi = 0
  const client: RegistryProvisionClient = {
    async createContainerRegistry(_zone, opts) {
      calls.push({ method: 'create', opts })
      const r = script.create[Math.min(ci, script.create.length - 1)]
      ci++
      return r
    },
    async getContainerRegistry(_zone, id) {
      calls.push({ method: 'get', id })
      const list = script.get ?? []
      const r = list[Math.min(gi, list.length - 1)]
      gi++
      return r
    },
  }
  return { client, calls }
}

describe('provisionRegistryWithMeta', () => {
  it('分類つきで一発成功 → 読み直して反映を確認し、metaSupported:true を返す', async () => {
    const { client, calls } = fakeClient({
      create: [ok({ CommonServiceItem: { ID: '123' } })],
      get: [ok({ CommonServiceItem: { Description: 'Koto が作成 / プロジェクト: myapp', Tags: ['koto', 'myapp'] } })],
    })
    const res = await provisionRegistryWithMeta(client, 'is1a', 'myapp', 'myapp')
    expect(res).toEqual({ ok: true, id: '123', label: 'myapp', metaSupported: true })
    const creates = calls.filter(c => c.method === 'create')
    const gets = calls.filter(c => c.method === 'get')
    expect(creates.length).toBe(1)
    expect(creates[0].method === 'create' && creates[0].opts.meta).toBeDefined()
    expect(gets.length).toBe(1) // 成功しても、それだけで「付いた」と思わない＝必ず読み直す
  })

  it('分類つきの作成が失敗したら、分類を外して「1回だけ」再試行する（呼び出し回数と本文で判定）', async () => {
    const { client, calls } = fakeClient({
      create: [fail(400, { error: { message: 'Bad Request' } }), ok({ CommonServiceItem: { ID: '999' } })],
    })
    const res = await provisionRegistryWithMeta(client, 'is1a', 'myapp', 'myapp')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.id).toBe('999')
      // 2026-09-09 検分・指摘3で直した点: 分類つきの作成が失敗した理由は分類と無関係
      // （500等）かもしれない。「反映されない」と確認できたわけではないので、
      // false（未対応と判明）ではなく null（不明。次回また試してよい）を返す。
      expect(res.metaSupported).toBeNull()
    }
    const creates = calls.filter(c => c.method === 'create')
    expect(creates.length).toBe(2) // 最初の1回＋分類を外した再試行の1回＝ちょうど2回
    expect(creates[0].method === 'create' && creates[0].opts.meta).toBeDefined()
    expect(creates[1].method === 'create' && creates[1].opts.meta).toBeUndefined()
    // 分類を付けていないので、読み直し（GET）は行わない。
    expect(calls.filter(c => c.method === 'get').length).toBe(0)
  })

  it('分類を外した後の再試行も失敗したら、それ以上は試さない（衝突でなければ、これ以上の回復手段は無い）', async () => {
    const { client, calls } = fakeClient({
      create: [fail(500, { error: { message: 'boom' } }), fail(500, { error: { message: 'boom again' } })],
    })
    const res = await provisionRegistryWithMeta(client, 'is1a', 'myapp', 'myapp')
    expect(res.ok).toBe(false)
    expect(calls.filter(c => c.method === 'create').length).toBe(2)
  })

  // ── 2026-09-09 検分・指摘1: 「衝突の作り直し」と「分類フォールバック」は、
  // どちらが先に起きるか分からない。直す前は「衝突の作り直し」を分類フォールバックより
  // 前の1回きりの分岐にしていたため、①分類つきで400（分類と無関係の理由）→
  // ②分類を外した再試行が**同じ label のまま**行われ、そこで初めて409（名前衝突）が
  // 表面化する、という順で失敗すると回復できず、公開そのものが止まっていた。
  // 呼んだ名前の列（文字列一致ではなく、呼び出しの opts.name の並び）で判定する。
  it('分類つき400 → 分類なし409（同じ名前） → サフィックス付きで成功、の順でも回復する（実害の再現・指摘1）', async () => {
    const { client, calls } = fakeClient({
      create: [
        fail(400, { error: { message: 'Description is not allowed' } }), // ①分類つき・myapp
        fail(409, { error: { message: '名前が既に利用されています' } }), // ②分類なし・myapp（ここで衝突が表面化）
        ok({ CommonServiceItem: { ID: '999' } }), // ③分類なし・myapp-xxxx
      ],
    })
    const res = await provisionRegistryWithMeta(client, 'is1a', 'myapp', 'myapp')
    expect(res.ok).toBe(true)
    const creates = calls.filter(c => c.method === 'create')
    expect(creates.length).toBe(3)
    // 呼んだ名前の列: myapp（分類つき）→ myapp（分類なし）→ myapp-xxxx（分類なし）
    const names = creates.map(c => c.method === 'create' && c.opts.name)
    expect(names[0]).toBe('myapp')
    expect(names[1]).toBe('myapp')
    expect(names[2]).not.toBe('myapp') // サフィックス付きの新しい名前
    expect(names[2]).toMatch(/^myapp-[0-9a-f]+$/)
    expect(creates[0].method === 'create' && creates[0].opts.meta).toBeDefined() // ①は分類つき
    expect(creates[1].method === 'create' && creates[1].opts.meta).toBeUndefined() // ②は分類なし
    expect(creates[2].method === 'create' && creates[2].opts.meta).toBeUndefined() // ③も分類なし
    if (res.ok) {
      expect(res.label).toBe(names[2])
      // 分類つきの作成に失敗して外した＝「反映されない」と確認できたわけではない（指摘3）。
      expect(res.metaSupported).toBeNull()
    }
  })

  it('過去に「反映されない」と分かっていれば（metaKnownUnsupported）、最初から分類を付けずに作成する（毎回は試さない）', async () => {
    const { client, calls } = fakeClient({ create: [ok({ CommonServiceItem: { ID: 'abc' } })] })
    const res = await provisionRegistryWithMeta(client, 'is1a', 'myapp', 'myapp', true)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.metaSupported).toBe(false)
    const creates = calls.filter(c => c.method === 'create')
    expect(creates.length).toBe(1)
    expect(creates[0].method === 'create' && creates[0].opts.meta).toBeUndefined()
    expect(calls.filter(c => c.method === 'get').length).toBe(0) // 試していないので確かめにも行かない
  })

  it('作成が成功しても、読み直しで反映が確認できなければ metaSupported:false を返す（「成功」と読んだ応答を鵜呑みにしない）', async () => {
    const { client } = fakeClient({
      create: [ok({ CommonServiceItem: { ID: '1' } })],
      get: [ok({ CommonServiceItem: { Description: '', Tags: [] } })],
    })
    const res = await provisionRegistryWithMeta(client, 'is1a', 'myapp', 'myapp')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.metaSupported).toBe(false)
  })

  it('読み直し（GET）自体が失敗したときは metaSupported:null（不明）のままにし、false と決めつけない', async () => {
    const { client } = fakeClient({
      create: [ok({ CommonServiceItem: { ID: '1' } })],
      get: [fail(500, {})],
    })
    const res = await provisionRegistryWithMeta(client, 'is1a', 'myapp', 'myapp')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.metaSupported).toBeNull()
  })

  it('名前の予約衝突（作り直せば通る）では、作り直した名前でも分類を引き継ぐ（分類フォールバックとは別の枝）', async () => {
    const { client, calls } = fakeClient({
      create: [fail(409, { error: { message: '名前が既に利用されています' } }), ok({ CommonServiceItem: { ID: '2' } })],
      get: [ok({ CommonServiceItem: { Description: 'x', Tags: [] } })],
    })
    const res = await provisionRegistryWithMeta(client, 'is1a', 'myapp', 'myapp')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.label).not.toBe('myapp') // サフィックスが付いた新しい名前で作られている
    const creates = calls.filter(c => c.method === 'create')
    expect(creates.length).toBe(2)
    expect(creates[0].method === 'create' && creates[0].opts.meta).toBeDefined()
    expect(creates[1].method === 'create' && creates[1].opts.meta).toBeDefined() // 作り直しでも分類は引き継ぐ
  })

  it('作成は成功したが応答からIDを取り出せなければ、その旨のエラーで返す（推測でIDを作らない）', async () => {
    const { client } = fakeClient({ create: [ok({})] })
    const res = await provisionRegistryWithMeta(client, 'is1a', 'myapp', 'myapp')
    expect(res.ok).toBe(false)
  })
})

// ── ipcMain ハンドラ側の配線（cloud:ensureRegistry）が、上の関数を正しく使っていることを固定する ──
// electron に依存する重い統合テストにはせず、既存の wiring テスト群と同じ「ソースを読んで
// 呼び出しの形を一意に指す」作法にする（掟10: 当て先が他の行にも出ないか確認する）。
describe('cloud:ensureRegistry の配線（掟10: 一元化した関数を実際に使っている）', () => {
  const cloudIpc = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')

  it('provisionRegistryWithMeta を registryProvision.ts からインポートして使っている', () => {
    expect(cloudIpc).toContain("import { provisionRegistryWithMeta } from '../cloud/registryProvision'")
    expect(cloudIpc).toContain('await provisionRegistryWithMeta(client, region, label, baseName, metaKnownUnsupported)')
  })

  it('既存レジストリを再利用するとき（登録済みが見つかったとき）は provisionRegistryWithMeta を呼ばない＝後から付けにいかない', () => {
    const at = cloudIpc.indexOf('if (!registryId) {\n        // 無ければ作成。')
    expect(at).toBeGreaterThan(0)
    // provisionRegistryWithMeta の呼び出しは、この「無ければ作成」ブロックの中に閉じている
    // （呼び出しがちょうど1箇所であること＝既存レジストリ発見時の分岐からは呼ばれない）。
    const calls = [...cloudIpc.matchAll(/provisionRegistryWithMeta\(/g)]
    expect(calls.length).toBe(1)
  })

  it('反映が不明（metaSupported:null）のときは記録を上書きしない（分かっていないことを false と書かない）', () => {
    expect(cloudIpc).toContain('registryMetaOutcome !== null ? { registryMetaSupported: registryMetaOutcome } : {}')
  })

  it('過去に「反映されない」と分かっている（registryMetaSupported === false）ことを見てから、次の作成に渡す', () => {
    expect(cloudIpc).toContain("const metaKnownUnsupported = recordedState?.meta?.registryMetaSupported === false")
  })
})
