import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseLocalRecords, buildInventory, sumMonthly, unknownCount, totalNotice, monthlyYenFor, kindLabel, costNote,
} from '../src/shared/inventory'

// ── 改善案 1-3 / 1-4（2026-08-18）────────────────────────────────────
// 2026-08-14、**Koto の記録に無いアプリとレジストリ**が残り、Ryosuke が
// コントロールパネルで消した。非エンジニアにはできない。しかも**放置すると
// 毎月お金がかかる**。実測では合計 935円/月が動いていたのに、
// **Koto の画面のどこにも合計は出ていない。**

const projects = [
  {
    dir: '/w/data-test', name: 'data-test',
    apprunState: {
      resources: [
        { kind: 'apprun-app', id: 'app-1111-aaaa' },
        { kind: 'bucket', id: 'koto-data-sample' },
      ],
      meta: { registryName: 'sample-registry-65f6' },
    },
  },
  { dir: '/w/express', name: 'express', apprunState: { resources: [{ kind: 'apprun-app', id: 'app-2222-bbbb' }], meta: { registryName: 'express' } } },
]

const actual = [
  { kind: 'apprun-app' as const, id: 'app-1111-aaaa', name: 'data-test' },
  { kind: 'apprun-app' as const, id: 'zzzz-9999', name: 'old-experiment' },  // 記録に無い
  { kind: 'registry' as const, id: 'sample-registry-65f6', name: 'sample-registry-65f6' },
  { kind: 'registry' as const, id: 'express', name: 'express' },
  { kind: 'bucket' as const, id: 'koto-data-sample', name: 'koto-data-sample' },
]

describe('手元の記録を読む', () => {
  it('アプリID・レジストリ名・保存場所名を取り出す', () => {
    const r = parseLocalRecords(projects)
    expect(r[0]).toEqual({
      dir: '/w/data-test', projectName: 'data-test',
      appIds: ['app-1111-aaaa'], bucketNames: ['koto-data-sample'], registryNames: ['sample-registry-65f6'],
      // 専有型クラスタのIDは fs（.sakuraide.json）を読む必要があるため、ここ（純関数）では
      // 埋められない。既定は空配列（main/ipc/cloud.ts が readApprunDedicatedFs で読んで足す）。
      clusterIds: [],
    })
  })

  it('壊れた記録が混ざっても落ちない', () => {
    expect(parseLocalRecords([{ dir: 1, name: null, apprunState: 'こわれている' } as any])[0])
      .toEqual({ dir: '', projectName: '', appIds: [], bucketNames: [], registryNames: [], clusterIds: [] })
    expect(parseLocalRecords([])).toEqual([])
  })
})

describe('さくら側の実物と突き合わせる', () => {
  const rows = buildInventory({ actual, records: parseLocalRecords(projects) })

  it('記録にあるものは、どのプロジェクトのものか分かる', () => {
    expect(rows.find(r => r.id === 'app-1111-aaaa')?.project).toBe('data-test')
    expect(rows.find(r => r.id === 'sample-registry-65f6')?.project).toBe('data-test')
    expect(rows.find(r => r.id === 'koto-data-sample')?.dir).toBe('/w/data-test')
  })

  it('★ 心当たりの無いものも必ず出す（出さなければ放置される）', () => {
    const orphan = rows.find(r => r.id === 'zzzz-9999')
    expect(orphan).toBeDefined()
    expect(orphan!.project).toBeNull()
    expect(orphan!.note).toContain('心当たりがありません')
  })

  it('★ 名前が似ているだけで引き取らない（利用者のものを乗っ取らない）', () => {
    const rows2 = buildInventory({
      actual: [{ kind: 'registry', id: 'data-test-old', name: 'data-test-old' }],
      records: parseLocalRecords(projects),  // sample-registry-65f6 は記録にあるが、これは別物
    })
    expect(rows2[0].project).toBeNull()
  })

  it('種類ごとに並べる（アプリ → 置き場 → 保存場所）', () => {
    expect(rows.map(r => r.kind)).toEqual(['apprun-app', 'apprun-app', 'registry', 'registry', 'bucket'])
  })
})

describe('費用', () => {
  const rows = buildInventory({ actual, records: parseLocalRecords(projects) })

  it('額は一元定義から取る', () => {
    expect(monthlyYenFor('registry')).toBe(220)
    expect(monthlyYenFor('bucket')).toBe(495)
    expect(monthlyYenFor('apprun-app')).toBe(0)  // 従量
  })

  it('★ 実測どおりの合計になる（レジストリ2つ＋保存場所1つ＝935円）', () => {
    expect(sumMonthly(rows)).toBe(935)
  })

  it('心当たりの無いものの件数を数える', () => {
    expect(unknownCount(rows)).toBe(1)
  })

  it('★ 実額はコントロールパネルで確かめてもらう（按分できないため）', () => {
    const t = totalNotice(rows)
    expect(t).toContain('935')
    expect(t).toContain('心当たりがありません')
    expect(t).toContain('コントロールパネル')
  })

  it('何も無ければ、そう言う', () => {
    expect(totalNotice([])).toContain('見つかりませんでした')
  })

  it('画面に出す名前は日本語', () => {
    expect(kindLabel('registry')).toBe('イメージの置き場')
    expect(kindLabel('bucket')).toBe('データの保存場所')
  })
})

// ── #31 の検分（2026-09-09）で見つかった【高】────────────────────────────
// 常時起動（min_scale≥1）を選んだアプリでも、この棚卸しは min_scale を一切見ておらず、
// 「かかり続けるものは見つかりませんでした」と断言していた。AppRun は従量課金なので
// monthlyYen=0 になること自体は正しいが、「待機中はほぼゼロ」という注記は min_scale=0
// のときしか当たらない。min_scale が読み取れないときも 0 に倒さない（今日の教訓）。
describe('costNote: apprun-app は金額を書かず、min_scale から状態だけを伝える', () => {
  it('min=0 → 従量（待機中はほぼゼロ）', () => {
    expect(costNote({ kind: 'apprun-app', monthlyYen: 0, scaleMin: 0 })).toBe('従量（待機中はほぼゼロ）')
  })

  it('★ min≥1 → 常時動く設定（料金がかかり続けます）。金額は書かない', () => {
    const note = costNote({ kind: 'apprun-app', monthlyYen: 0, scaleMin: 1 })
    expect(note).toBe('常時動く設定（料金がかかり続けます）')
    expect(note).not.toMatch(/[\d,]+\s*円/)
  })

  it('min=5 でも同じ扱い（1以上はすべて「常時動く」）', () => {
    expect(costNote({ kind: 'apprun-app', monthlyYen: 0, scaleMin: 5 })).toBe('常時動く設定（料金がかかり続けます）')
  })

  it('★ min が読み取れない（null）ときは「不明」。0 に倒さない', () => {
    const note = costNote({ kind: 'apprun-app', monthlyYen: 0, scaleMin: null })
    expect(note).toContain('不明')
    expect(note).not.toBe('従量（待機中はほぼゼロ）')
  })

  it('scaleMin を渡さない（undefined）ときも「不明」扱い（0と決めつけない）', () => {
    expect(costNote({ kind: 'apprun-app', monthlyYen: 0 })).toContain('不明')
  })

  it('registry/bucket は従来どおり金額ベース（apprun-app 専用の分岐に入らない）', () => {
    expect(costNote({ kind: 'registry', monthlyYen: 220, scaleMin: null })).toBe('月額220円')
    expect(costNote({ kind: 'bucket', monthlyYen: 0, scaleMin: null })).toBe('従量')
  })
})

describe('buildInventory: apprun-app の行に scaleMin が乗る', () => {
  const actualWarm = [{ kind: 'apprun-app' as const, id: 'app-1111-aaaa', name: 'data-test', scaleMin: 1 }]
  const actualUnknown = [{ kind: 'apprun-app' as const, id: 'app-1111-aaaa', name: 'data-test', scaleMin: null }]
  const records = parseLocalRecords(projects)

  it('★ min≥1 のアプリの note は「常時動く設定」になる（記録があるプロジェクトでも）', () => {
    const rows = buildInventory({ actual: actualWarm, records })
    const row = rows.find(r => r.id === 'app-1111-aaaa')!
    expect(row.scaleMin).toBe(1)
    expect(row.note).toContain('常時動く設定')
    expect(row.note).toContain('料金がかかり続けます')
    expect(row.note).not.toMatch(/[\d,]+\s*円/)
  })

  it('★ min が不明のアプリは note が「不明」になる。0 に倒さない', () => {
    const rows = buildInventory({ actual: actualUnknown, records })
    const row = rows.find(r => r.id === 'app-1111-aaaa')!
    expect(row.scaleMin).toBeNull()
    expect(row.note).toContain('不明')
    expect(row.note).not.toContain('待機中はほぼゼロ')
  })

  it('registry/bucket の行は scaleMin が null のまま（apprun-app 専用の項目のため）', () => {
    const rows = buildInventory({ actual, records })
    for (const r of rows.filter(r => r.kind !== 'apprun-app')) expect(r.scaleMin).toBeNull()
  })

  // ★ 実際に呼ぶ（IPCモックではなく buildInventory を直接呼び、totalNotice も直接呼ぶ）。
  it('★★ min≥1 のアプリしか無いとき、totalNotice は「かかり続けるものは見つかりませんでした」と言わない', () => {
    const rows = buildInventory({ actual: actualWarm, records: [] })
    expect(sumMonthly(rows)).toBe(0) // 従量なので固定額の合計は0のまま（正しい）
    const notice = totalNotice(rows)
    expect(notice).not.toContain('月額でかかり続けるものは見つかりませんでした')
    expect(notice).toContain('可能性があります')
  })

  it('★ min が不明のアプリしか無いときも、totalNotice は「見つかりませんでした」と言わない', () => {
    const rows = buildInventory({ actual: actualUnknown, records: [] })
    const notice = totalNotice(rows)
    expect(notice).not.toContain('月額でかかり続けるものは見つかりませんでした')
  })

  it('min=0（従来どおりの意味での従量）しか無ければ、これまでどおり「見つかりませんでした」', () => {
    const rows = buildInventory({ actual: [{ kind: 'apprun-app' as const, id: 'a', name: 'a', scaleMin: 0 }], records: [] })
    expect(totalNotice(rows)).toContain('月額でかかり続けるものは見つかりませんでした')
  })
})

// ── 配線（判断だけ正しくても、画面に出なければ意味がない・掟10）──────────
describe('棚卸しが画面まで届いている', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

  // ハンドラ本体だけを切り出す（掟10: 固定の文字数窓は、ハンドラが伸びると当て先が
  // 途中で切れて偽陰性になる／次のハンドラへ食い込んで偽陽性になる。実際の閉じ `  })`
  // まで＝呼び出し側の実態に合わせて境界を取る。tests/appLog.test.ts の handlerBody と同じ作法）。
  function inventoryHandlerBody(): string {
    const src = read('src/main/ipc/cloud.ts')
    const at = src.indexOf("ipcMain.handle('cloud:inventory'")
    expect(at).toBeGreaterThan(-1)
    const closeAt = src.indexOf('\n  })', at)
    expect(closeAt).toBeGreaterThan(at)
    return src.slice(at, closeAt)
  }

  it('main / preload / 型 の3点が揃っている（掟6）', () => {
    expect(read('src/main/ipc/cloud.ts')).toContain("ipcMain.handle('cloud:inventory'")
    expect(read('src/main/preload.ts')).toContain("ipcRenderer.invoke('cloud:inventory'")
    expect(read('src/renderer/global.d.ts')).toContain('inventory(projects: unknown)')
  })

  it('★ 4種類すべてを引く（1つ漏らすと、その分が見えないまま課金される）', () => {
    const body = inventoryHandlerBody()
    // ①公開したアプリ・④専有型のクラスタは electron 非依存の純関数へ切り出してある
    // （偽 client／偽 listClusters での振る舞いは tests/inventoryCollect.test.ts で固定）。
    // ここでは「呼んでいるか」の配線だけを見る。
    expect(body).toContain('collectAppRunApps(client)')
    expect(body).toContain('collectDedicatedClusters(')
    expect(body).toContain('listClusters(creds)')
    expect(body).toContain('listContainerRegistries')
    expect(body).toContain('listBuckets')
  })

  it('★ 引けなかったものを、黙って0件にしない', () => {
    const body = inventoryHandlerBody()
    expect(body).toContain('partial')
    // 4種類（アプリ・イメージの置き場・データの保存場所・専有型のクラスタ）それぞれの
    // 失敗が、それぞれ名指しで failed に積まれること（1つに丸めない）。
    expect(body).toContain("failed.push('公開したアプリ')")
    expect(body).toContain("failed.push('イメージの置き場')")
    expect(body).toContain("failed.push('データの保存場所')")
    expect(body).toContain("failed.push('専有型のクラスタ')")
    expect(read('src/renderer/components/PublishedListModal.tsx')).toContain('この一覧に出ていない')
  })

  it('★ 勝手に通信しない（押したときだけ調べる）', () => {
    const modal = read('src/renderer/components/PublishedListModal.tsx')
    expect(modal).toContain('runInventory')
    // 画面を開いた時点では走らせない
    expect(modal).not.toMatch(/useEffect\([^)]*\{\s*void runInventory\(\)/)
  })

  it('★ 合計を、文章の中に埋めない（いちばん見たい数字）', () => {
    const modal = read('src/renderer/components/PublishedListModal.tsx')
    expect(modal).toMatch(/月額 \{\(inventory\.totalYen \?\? 0\)\.toLocaleString\(\)\}円/)
  })

  it('★ どのキーで調べたかを出す（別のアカウントを見ていないか分かるように）', () => {
    const modal = read('src/renderer/components/PublishedListModal.tsx')
    expect(modal).toContain('調べたキー')
    expect(modal).toContain('getActiveCloudKeyId')
  })

  it('心当たりの無いものは、行き先まで示す', () => {
    const modal = read('src/renderer/components/PublishedListModal.tsx')
    expect(modal).toContain('心当たりがありません')
    expect(modal).toContain('コントロールパネル')
  })

  // ── #31 検分の直し（2026-09-10）: 一覧の a?.min_scale は原本に無いキーで常に null に
  // なっていた。min_scale は詳細（GET /applications/{id}）にしか無いため、収集そのものを
  // electron 非依存の純関数（collectAppRunApps）へ切り出し、偽 client で振る舞いを固定した
  // （tests/inventoryCollect.test.ts）。ここでは呼び出しの配線だけを確かめる。
  it('★ 一覧の a?.min_scale を直読みする形に戻っていない（原本に無いキー）', () => {
    const body = inventoryHandlerBody()
    expect(body).not.toContain('a?.min_scale')
    expect(body).not.toContain('a.min_scale')
  })

  // ── 専有型のクラスタの突き合わせ（手元の .sakuraide.json の clusterID）─────────
  it('専有型のクラスタは readApprunDedicatedFs で読んだ clusterID を使って突き合わせる', () => {
    const body = inventoryHandlerBody()
    expect(body).toContain('readApprunDedicatedFs(')
    expect(body).toContain('clusterIds')
  })

  // ⚠️ 画面（PublishedListModal.tsx）が r.note / costNote(r) を使わず、r.monthlyYen だけを
  // 見て自前で文言を組み立てていると、inventory.ts 側をいくら直しても画面には届かない
  // （2026-09-09 検分時点の実際の形がこれだった）。**呼び出し側**を固定する。
  it('★ 一覧の費用表示は costNote(r) を使う（r.monthlyYen 直読みの複製をしていない）', () => {
    const modal = read('src/renderer/components/PublishedListModal.tsx')
    expect(modal).toContain("import { kindLabel, costNote } from '../../shared/inventory'")
    expect(modal).toContain('{costNote(r)}')
    // 直す前の形（金額の有無だけで「従量（待機中はほぼゼロ）」を出す複製）が残っていないこと
    expect(modal).not.toMatch(/r\.monthlyYen > 0 \? `月額\$\{r\.monthlyYen\}円` : '従量/)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 専有型のクラスタ（roadmap 検分で発見。常時課金＝月2万円超なのに棚卸しに一切出ない穴）。
// ══════════════════════════════════════════════════════════════════════════
describe('専有型のクラスタ（dedicated-cluster）が棚卸しに出る', () => {
  it('画面に出す名前がある', () => {
    expect(kindLabel('dedicated-cluster')).toBe('専有型のクラスタ')
  })

  it('費用は「常時課金」と伝える。0円と決めつけない', () => {
    const note = costNote({ kind: 'dedicated-cluster', monthlyYen: 0, scaleMin: null })
    expect(note).toContain('常時課金')
    expect(note).not.toMatch(/^0円$|^従量$/)
  })

  it('★ kind:\'dedicated-cluster\' の行が rows に出る', () => {
    const rows = buildInventory({
      actual: [{ kind: 'dedicated-cluster', id: 'cluster-aaa', name: 'my-cluster' }],
      records: [],
    })
    expect(rows.length).toBe(1)
    expect(rows[0].kind).toBe('dedicated-cluster')
    expect(rows[0].note).toContain('常時課金')
  })

  // ★ 実害の再現: 専有型のクラスタしか棚卸しに無いとき、totalYen（固定額の合計）は
  //   0 のままでも（実際そのとおり。金額不明のため）、費用の文が「見つかりませんでした」
  //   と言い切ってはいけない（月2万円超が「見つかりませんでした」になっていた穴）。
  it('★★ 専有型のクラスタしか無いとき、totalNotice は「見つかりませんでした」と言わない', () => {
    const rows = buildInventory({ actual: [{ kind: 'dedicated-cluster', id: 'c1', name: 'c1' }], records: [] })
    expect(sumMonthly(rows)).toBe(0) // 金額は不明のまま（0円と決めつけているわけではない）
    const notice = totalNotice(rows)
    expect(notice).not.toContain('月額でかかり続けるものは見つかりませんでした')
  })

  it('手元の記録（clusterIds）と一致すれば、そのプロジェクトのものと分かる', () => {
    const records = [
      { dir: '/w/my-app', projectName: 'my-app', appIds: [], bucketNames: [], registryNames: [], clusterIds: ['cluster-aaa'] },
    ]
    const rows = buildInventory({
      actual: [{ kind: 'dedicated-cluster', id: 'cluster-aaa', name: 'my-cluster' }],
      records,
    })
    expect(rows[0].project).toBe('my-app')
    expect(rows[0].dir).toBe('/w/my-app')
  })

  it('★ 名前が似ているだけ・clusterID が違えば引き取らない（利用者のものを乗っ取らない）', () => {
    const records = [
      { dir: '/w/my-app', projectName: 'my-app', appIds: [], bucketNames: [], registryNames: [], clusterIds: ['cluster-other'] },
    ]
    const rows = buildInventory({
      actual: [{ kind: 'dedicated-cluster', id: 'cluster-aaa', name: 'my-cluster' }],
      records,
    })
    expect(rows[0].project).toBeNull()
    expect(rows[0].note).toContain('心当たりがありません')
  })

  it('種類の並びに dedicated-cluster が入っている（apprun-app → registry → bucket → dedicated-cluster）', () => {
    const rows = buildInventory({
      actual: [
        { kind: 'dedicated-cluster', id: 'c1', name: 'c1' },
        { kind: 'bucket', id: 'b1', name: 'b1' },
        { kind: 'apprun-app', id: 'a1', name: 'a1' },
        { kind: 'registry', id: 'r1', name: 'r1' },
      ],
      records: [],
    })
    expect(rows.map(r => r.kind)).toEqual(['apprun-app', 'registry', 'bucket', 'dedicated-cluster'])
  })
})
