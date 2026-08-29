import { describe, it, expect } from 'vitest'
import { planMigrate, alreadyMigrated, needsMigration, shouldOfferMigration, migrateNotice, migrateDone, migrateFailed , skipMigrationForTarget } from '../src/shared/migratePlan'
import { PUBLISH_DIR, placeInProject, topSegment } from '../src/shared/publishRoot'
import { isPublished, MATERIALS_DIR } from '../src/shared/publishExclude'

const P = (name: string, isDir = false) => ({ name, isDir })
const judge = (name: string, isDir: boolean) => isPublished(name, isDir)

describe('planMigrate（何を移すか）', () => {
  const entries = [
    P('index.html'), P('style.css'), P('images', true), P('package.json'),
    P('Dockerfile'), P('README.md'), P(MATERIALS_DIR, true), P('.sakuraide', true), P('node_modules', true),
  ]

  it('公開されるものだけを移す', () => {
    const { move } = planMigrate(entries, judge)
    expect(move).toEqual(['index.html', 'style.css', 'images', 'package.json', 'Dockerfile', 'README.md'])
  })

  it('素材・Koto の内部・重いフォルダは直下に残す', () => {
    const { keep } = planMigrate(entries, judge)
    expect(keep).toContain(MATERIALS_DIR)
    expect(keep).toContain('.sakuraide')
    expect(keep).toContain('node_modules')
  })

  it('判断は publishExclude に任せている（独自の名簿を持たない）', () => {
    // 判定関数を差し替えれば結果も変わる＝自前で決めていない証拠。
    const { move } = planMigrate([P('なんでも.html')], () => false)
    expect(move).toEqual([])
  })

  it('自分自身は移さない（自分の中に入れない）', () => {
    expect(planMigrate([P(PUBLISH_DIR, true)], () => true).move).toEqual([])
  })

  it('空・欠けた形でも壊れない', () => {
    expect(planMigrate([], judge)).toEqual({ move: [], keep: [] })
    expect(planMigrate([null as any, P('a.html')], judge).move).toEqual(['a.html'])
  })
})

describe('いつ移行するか', () => {
  it('すでにフォルダがあれば、もうしない', () => {
    expect(alreadyMigrated([P(PUBLISH_DIR, true)])).toBe(true)
    expect(needsMigration([P(PUBLISH_DIR, true), P('index.html')])).toBe(false)
  })

  it('同じ名前でもファイルなら「移行済み」ではない', () => {
    expect(alreadyMigrated([P(PUBLISH_DIR, false)])).toBe(false)
  })

  it('空のプロジェクトでは案内を出さない（空のフォルダだけ作らない）', () => {
    expect(needsMigration([])).toBe(false)
  })

  it('中身があれば案内を出す', () => {
    expect(needsMigration([P('index.html')])).toBe(true)
  })
})

// ── 改善1-3（2026-08-29）: 移すものが0件なら、案内そのものを出さない ──────────────
// needsMigration は「プロジェクト直下に何か（件数）があるか」しか見ないため、
// .sakuraide.json のような隠しメタしか無い新規プロジェクトでも true を返してしまう。
// このとき実際に移すもの（plan.move）は0件なのに、案内が「0件をその中へ移します」と
// 出てしまっていた（0.3.52 の実機確認）。shouldOfferMigration は plan まで見て、この
// 空振りを止める最終判定（仕様書のテスト2・ミューテーション試験対象）。
describe('shouldOfferMigration（移すもの0件なら案内しない）', () => {
  it('move が空なら出さない（.sakuraide.json だけの新規プロジェクト相当）', () => {
    expect(shouldOfferMigration({ move: [], keep: ['.sakuraide.json'] })).toBe(false)
  })

  it('keep が空でも move が空なら出さない', () => {
    expect(shouldOfferMigration({ move: [], keep: [] })).toBe(false)
  })

  it('move が1件でもあれば出す', () => {
    expect(shouldOfferMigration({ move: ['index.html'], keep: [] })).toBe(true)
  })

  it('実際の判定（planMigrate）と組み合わせても同じ結果になる', () => {
    // .sakuraide.json 相当（公開対象ではない名前）しか無いプロジェクト
    const metaOnly = planMigrate([P('.sakuraide.json')], judge)
    expect(shouldOfferMigration(metaOnly)).toBe(false)
    // 公開されるものが1件でもあれば出す
    const withContent = planMigrate([P('.sakuraide.json'), P('index.html')], judge)
    expect(shouldOfferMigration(withContent)).toBe(true)
  })
})

describe('伝える文面', () => {
  const plan = planMigrate([P('index.html'), P(MATERIALS_DIR, true)], judge)

  it('案内は「何が起きるか」を書く（拒否できないので選ばせない）', () => {
    const n = migrateNotice(plan)
    expect(n).toContain(PUBLISH_DIR)
    expect(n).toContain('index.html')
    expect(n).toContain(MATERIALS_DIR)
    expect(n).toContain('🕘 履歴')
    // 「よろしいですか」「キャンセル」のような、選ばせる言い方をしない
    expect(n).not.toContain('よろしいですか')
    expect(n).not.toContain('キャンセル')
  })

  it('終わったら、何をどこへ移したかを伝える（黙って終わらせない）', () => {
    const d = migrateDone(plan)
    expect(d).toContain('index.html')
    expect(d).toContain('🕘 履歴')
  })

  it('移すものが無いときも、フォルダを作ったことは伝える', () => {
    expect(migrateDone({ move: [], keep: [] })).toContain(PUBLISH_DIR)
  })

  it('失敗したら、戻したかどうかを必ず言う', () => {
    expect(migrateFailed('権限がありません', true)).toContain('元へ戻しました')
    const bad = migrateFailed('権限がありません', false)
    expect(bad).toContain('元へ戻せませんでした')
    expect(bad).toContain('🕘 履歴')
  })
})

describe('新規作成と移行が同じ判断を使う', () => {
  it('新しく作るファイルも、移行と同じ場所へ行く', () => {
    // ここがずれると「新しく作ったプロジェクトだけ形が違う」ことになる。
    for (const rel of ['index.html', 'images/a.png', 'assets/app.js']) {
      const top = topSegment(rel)
      expect(placeInProject(rel, isPublished(top, rel.includes('/')))).toBe(`${PUBLISH_DIR}/${rel}`)
    }
  })

  it('すでに public/ の中を指しているものは、二重にしない', () => {
    // レンタルサーバ向けの雛形は元から `public/` に置く作りだった。
    // フォルダ名を `public` にしたことで、**そのまま噛み合う**（2026-08-20）。
    const rel = `${PUBLISH_DIR}/index.html`
    expect(placeInProject(rel, isPublished(topSegment(rel), true))).toBe(rel)
  })

  it('公開されないものは、新規作成でも直下に置く', () => {
    for (const rel of [`${MATERIALS_DIR}/note.md`, '.sakuraide/chat.json']) {
      const top = topSegment(rel)
      expect(placeInProject(rel, isPublished(top, true))).toBe(rel)
    }
  })

  it('先頭の ./ は落とす', () => {
    expect(placeInProject('./index.html', true)).toBe(`${PUBLISH_DIR}/index.html`)
  })
})

// ── 公開しないプロジェクトには案内しない（2026-08-24 Ryosuke 指摘）─────────
// `public/` は「サーバーへ置かれるもの」の場所。ローカルで動かすだけのもの
// （ゲーム・手元の道具）には置く先が無い。実機では Unreal Engine のゲームで
// `Source/` や `.uproject` まで移そうとしていた。**害のほうが大きい。**
describe('公開しないプロジェクトでは移行を案内しない', () => {
  const entries = [{ name: 'Source', isDir: true }, { name: 'game.uproject', isDir: false }]

  it('ローカルのみ・公開しないなら案内しない', () => {
    expect(skipMigrationForTarget('local')).toBe(true)
    expect(skipMigrationForTarget('other')).toBe(true)
    expect(needsMigration(entries, 'local')).toBe(false)
    expect(needsMigration(entries, 'other')).toBe(false)
  })

  it('公開先が決まっていれば、これまでどおり案内する', () => {
    for (const t of ['vercel', 'sakura-apprun', 'sakura-rental', 'hanamii']) {
      expect(skipMigrationForTarget(t)).toBe(false)
      expect(needsMigration(entries, t)).toBe(true)
    }
  })

  // メタが読めない（既存フォルダを開いた等）ときに黙って案内をやめない
  it('公開先が分からないときは、これまでどおり案内する', () => {
    expect(needsMigration(entries, null)).toBe(true)
    expect(needsMigration(entries, undefined)).toBe(true)
    expect(needsMigration(entries)).toBe(true)
  })

  it('すでに public があれば、公開先によらず案内しない', () => {
    expect(needsMigration([...entries, { name: 'public', isDir: true }], 'vercel')).toBe(false)
  })
})
