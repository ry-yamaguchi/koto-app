import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseSourceMeta, judgeFreshness, daysBetween, checkSourceChanged,
  bodyWithoutHeader, sourcesDueForCheck, normalizeForCompare, AGING_DAYS, STALE_DAYS,
  fingerprint, judgeUpdate,
} from '../src/shared/freshness'

// ── なぜ要るか（2026-08-15 Ryosuke 提案）──────────────────────────────
// RAG の資料は取り込んだ時点のコピーなのに、一覧では
// **3か月前のページも今日のページも同じ顔**をしていた。
// AI はどちらも「いまの情報」として読む。＝古い情報を最新のつもりで使わせていた。

// コレクターが実際に作る形（renderer/ragContext.ts buildWebPageMarkdown）
const collected = `# さくらのAppRun マニュアル

- 出典URL: https://manual.sakura.ad.jp/cloud/apprun/
- 取得日時: 2026-05-20 10:31（Koto で取得）

---

AppRun はコンテナを動かすサービスです。
`

describe('資料の出どころを、本文から読み取る', () => {
  it('コレクターが作った資料から、URLと取り込み日時が読める', () => {
    expect(parseSourceMeta(collected)).toEqual({
      url: 'https://manual.sakura.ad.jp/cloud/apprun/',
      fetchedAt: '2026-05-20 10:31',
    })
  })

  it('手で書いた資料には無い。**無いことは失敗ではない**', () => {
    expect(parseSourceMeta('# 社内ルール\n\n毎朝9時に朝礼。')).toEqual({ url: null, fetchedAt: null })
    expect(parseSourceMeta(null)).toEqual({ url: null, fetchedAt: null })
  })

  it('URLでないものをURLとして拾わない', () => {
    expect(parseSourceMeta('- 出典URL: 社内wiki').url).toBeNull()
  })

  // ── 読み戻すと形が変わっていた（2026-08-15 実機）────────────────────
  // 書き込みは `- 出典URL: …` だが、さくらの AI Engine から読み戻した本文では
  // 見つからなかった。箇条書きが落ちる・改行が詰まる等を許して読む。
  it('★ 箇条書きの記号が落ちていても読める', () => {
    expect(parseSourceMeta('出典URL: https://example.com/a\n').url).toBe('https://example.com/a')
  })

  it('★ 1行に詰まっていても読める', () => {
    const flat = '# タイトル 出典URL: https://example.com/b 取得日時: 2026-05-20 10:31（Koto で取得） --- 本文'
    expect(parseSourceMeta(flat)).toEqual({ url: 'https://example.com/b', fetchedAt: '2026-05-20 10:31' })
  })

  it('全角コロンや余分な空白でも読める', () => {
    expect(parseSourceMeta('・出典 URL ： https://example.com/c').url).toBe('https://example.com/c')
  })

  it('URLの後ろの句読点や括弧を巻き込まない', () => {
    expect(parseSourceMeta('出典URL: https://example.com/d）ほか').url).toBe('https://example.com/d')
  })
})

describe('鮮度を判断する', () => {
  const now = new Date('2026-08-15T12:00:00Z')

  it('今日・昨日・◯日前を言い分ける', () => {
    expect(judgeFreshness({ fetchedAt: '2026-08-15 09:00', now }).label).toBe('今日に取り込み')
    expect(judgeFreshness({ fetchedAt: '2026-08-14 09:00', now }).label).toBe('昨日に取り込み')
    expect(judgeFreshness({ fetchedAt: '2026-08-10 09:00', now }).label).toBe('5日前に取り込み')
  })

  it(`★ ${STALE_DAYS}日を超えたものは stale として印を付けられる`, () => {
    const old = judgeFreshness({ fetchedAt: '2026-05-01 10:00', now })
    expect(old.level).toBe('stale')
    expect(old.days).toBeGreaterThanOrEqual(STALE_DAYS)
  })

  it(`${AGING_DAYS}日〜は aging、それ未満は fresh`, () => {
    expect(judgeFreshness({ fetchedAt: '2026-07-10 10:00', now }).level).toBe('aging')
    expect(judgeFreshness({ fetchedAt: '2026-08-01 10:00', now }).level).toBe('fresh')
  })

  it('★ 分からないときは「古い」とも「新しい」とも言わない', () => {
    const u = judgeFreshness({ fetchedAt: null, now })
    expect(u.level).toBe('unknown')
    expect(u.days).toBeNull()
    expect(u.label).toContain('分かりません')
  })

  it('壊れた日付でも落ちない', () => {
    expect(daysBetween('きのう', now)).toBeNull()
    expect(judgeFreshness({ fetchedAt: 'きのう', now }).level).toBe('unknown')
  })
})

describe('取り込み時のヘッダを外す', () => {
  // ── 実機のバグ（2026-08-15）─────────────────────────────────────
  // 読み戻した本文では**改行が失われる**ため `\n---\n` が見つからず、
  // ヘッダごと比べていた。ヘッダには**取得日時**が入っているので毎回変わり、
  // **何度取り直しても「更新されています」**になり続けた。
  it('★ 改行が失われていてもヘッダを外せる（これが「毎回更新扱い」の原因だった）', () => {
    const flat = '# タイトル - 出典URL: https://example.com/a - 取得日時: 2026-08-18 09:05（Koto で取得） --- 本文です'
    expect(bodyWithoutHeader(flat)).toBe('本文です')
  })

  it('通常の改行つきでも外せる', () => {
    expect(bodyWithoutHeader(collected).trim()).toBe('AppRun はコンテナを動かすサービスです。')
  })

  it('★ 取り込みのヘッダが無い資料は、何も削らない', () => {
    const own = '# 社内ルール\n\n---\n\n毎朝9時に朝礼。'
    expect(bodyWithoutHeader(own)).toBe(own)
  })

  it('★ 取り直しても「更新されています」にならない（実機の症状）', () => {
    const body = '本文の中身は同じです'
    const stored = `# タイトル - 出典URL: https://example.com/x - 取得日時: 2026-08-18 09:05（Koto で取得） --- ${body}`
    expect(checkSourceChanged({ stored: bodyWithoutHeader(stored), fetched: body })).toBe('same')
  })
})

describe('元のページが変わったかを見る', () => {
  it('★ 取り込み時のヘッダを外してから比べる（外さないと必ず「変わった」になる）', () => {
    // 取得日時がヘッダに入っているので、ヘッダごと比べると毎回違う
    const again = collected.replace('2026-05-20 10:31', '2026-08-15 12:00')
    expect(checkSourceChanged({ stored: collected, fetched: again })).toBe('changed')
    expect(checkSourceChanged({
      stored: bodyWithoutHeader(collected),
      fetched: bodyWithoutHeader(again),
    })).toBe('same')
  })

  it('★ 空白や改行の違いで「変わった」と言わない', () => {
    expect(checkSourceChanged({ stored: 'あ  い\n\n\nう', fetched: 'あ い\nう' })).toBe('same')
    expect(normalizeForCompare('a  b\r\n\r\nc')).toBe('a b c')
  })

  // ── 実機（2026-08-15）: 10日前に取り込んだ資料が3件とも「更新されています」に
  // なった。さくらの AI Engine から読み戻した本文は**改行の入り方が変わっている**
  // ため、改行を残して比べると必ず違う文字列になっていた。
  it('★ 改行がすべて失われていても、中身が同じなら「同じ」', () => {
    const stored = '# 見出し 本文の一行目 本文の二行目'         // 読み戻すと平らになる
    const fetched = '# 見出し\n\n本文の一行目\n本文の二行目'      // 取りに行くと改行がある
    expect(checkSourceChanged({ stored, fetched })).toBe('same')
  })

  it('★ 途中で切れているだけなら「変わった」と言わない', () => {
    const full = 'あいうえお かきくけこ さしすせそ'
    expect(checkSourceChanged({ stored: 'あいうえお かきくけこ', fetched: full })).toBe('same')
    expect(checkSourceChanged({ stored: full, fetched: 'あいうえお かきくけこ' })).toBe('same')
  })

  it('書き出しが同じでも、途中から違えば「変わった」', () => {
    expect(checkSourceChanged({ stored: '料金は495円です 以上', fetched: '料金は550円です 以上' })).toBe('changed')
  })

  it('本当に中身が変わったときは changed', () => {
    expect(checkSourceChanged({ stored: '料金は495円です', fetched: '料金は550円です' })).toBe('changed')
  })

  it('片方が取れなければ unknown（変わったとは言わない）', () => {
    expect(checkSourceChanged({ stored: '中身', fetched: '' })).toBe('unknown')
    expect(checkSourceChanged({ stored: null, fetched: '中身' })).toBe('unknown')
  })
})

describe('確認しに行く相手を選ぶ', () => {
  const now = new Date('2026-08-15T12:00:00Z')
  const docs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('★ 開くたびに全部を取りに行かない（相手のサイトに負担をかけない）', () => {
    const last = { a: '2026-08-15T11:00:00Z', b: '2026-08-15T11:30:00Z' }
    expect(sourcesDueForCheck({ docs, lastCheckedAt: last, now }).map(d => d.id)).toEqual(['c'])
  })

  it('一定時間が経てば、また確認する', () => {
    const last = { a: '2026-08-14T00:00:00Z', b: '2026-08-15T11:30:00Z', c: '2026-08-14T00:00:00Z' }
    expect(sourcesDueForCheck({ docs, lastCheckedAt: last, now }).map(d => d.id)).toEqual(['a', 'c'])
  })

  it('一度にまとめて叩かない（上限がある）', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `d${i}` }))
    expect(sourcesDueForCheck({ docs: many, lastCheckedAt: {}, now }).length).toBe(5)
  })
})

// ── 画面まで届いているか（判断だけ正しくても利用者は救われない）────────────
describe('鮮度が画面に届いている', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')
  const modal = read('src/renderer/components/KnowledgeModal.tsx')

  it('資料一覧に、いつ取り込んだかを出す', () => {
    expect(modal).toContain('judgeFreshness')
    expect(modal).toContain('内容が古いかもしれません')
  })

  it('★ 押さなくても確かめる（ただし開くたびに全部は叩かない）', () => {
    expect(modal).toContain('sourcesDueForCheck')
  })

  it('★ 「更新を確認」を押したときは、間隔を待たず全部確かめる', () => {
    // 押したのに何も起きないのはおかしい（2026-08-15 Ryosuke 指摘）
    expect(modal).toContain('forceCheckRef')
    expect(modal).toMatch(/const forced = forceCheckRef\.current[\s\S]{0,200}forced\s*\n?\s*\?\s*web/)
  })

  it('★ 更新があるときだけ「更新」を出す', () => {
    expect(modal).toMatch(/st === 'changed' && \([\s\S]{0,600}更新/)
  })

  it('★ 全体と個別で役割が分かれている（同じ名前を2箇所に置かない）', () => {
    // 全体＝確認と一括更新／個別＝その資料の更新（2026-08-18 Ryosuke 指摘）
    expect(modal).toContain('全体を更新')
    expect(modal).toContain('refreshAll')
    // 個別の行に「更新を確認」は無い
    expect(modal).not.toMatch(/>更新を確認<\/button>\s*\n\s*\{\/\* \*\*更新があるときだけ/)
  })

  it('★ 比べるのは Koto が取ってきたページどうし（保存の往復を挟まない）', () => {
    // 保存して読み戻すと形が変わるため、その比較は当てにならなかった
    expect(modal).toContain('judgeUpdate')
    expect(modal).toContain('setBaseline')
    expect(modal).not.toContain('checkSourceChanged')
  })

  it('★ 取り込みの入口すべてで基準を控える（漏らすと「分かりません」が続く）', () => {
    expect(read('src/renderer/components/KnowledgeCollectorTab.tsx')).toContain('setBaseline')
    expect(read('src/renderer/components/KnowledgePacksTab.tsx')).toContain('setBaseline')
  })

  it('★ 勝手に差し替えない（取り直しは押してから）', () => {
    // 自動チェックの中で refreshDoc を呼んでいないこと
    expect(modal).not.toMatch(/sourcesDueForCheck[\s\S]{0,600}refreshDoc\(/)
  })

  it('★ どこで詰まったかを分けて言う（「確認できませんでした」だけでは直せない）', () => {
    for (const reason of ['no-baseline', 'no-url', 'fetch-failed']) {
      expect(modal).toContain(`'${reason}'`)
    }
    expect(modal).toContain('出典URLが記録されていない')
    expect(modal).toContain('元のページに届きませんでした')
    // 控えが無いときは「変わった」と言わず、そう言う
    expect(modal).toContain('更新の有無は分かりません')
  })

  it('★ 新しいものを入れてから、古いものを消す（順番）', () => {
    // upload → delete の順（逆にすると失敗時に資料が消えたまま残る）
    const i = modal.indexOf('const refreshDoc')
    const seg = modal.slice(i, i + 2000)
    expect(seg.indexOf('rag.upload')).toBeGreaterThan(-1)
    expect(seg.indexOf('rag.upload')).toBeLessThan(seg.indexOf('rag.delete'))
  })
})

// ── 比べ方を変えた（2026-08-18 実機）──────────────────────────────────
// 「保存された本文」と「いまのページ」を比べていたが、保存して読み戻すと
// 形が変わるため当てにならなかった（同じ資料が「最新です」にも
// 「更新されています」にもなった）。**取り込んだときのページ**と
// **いまのページ**を比べる形に変える。
describe('取り込んだときと、いまを比べる', () => {
  it('同じ内容なら同じ指紋になる（空白の違いは無視）', () => {
    expect(fingerprint('あ い う')).toBe(fingerprint('あ\n\nい\tう'))
  })

  it('中身が変われば指紋も変わる', () => {
    expect(fingerprint('料金は495円')).not.toBe(fingerprint('料金は550円'))
  })

  it('★ 取り込んだときと同じなら「同じ」', () => {
    const at = '2026-08-18T09:05:00Z'
    const base = { hash: fingerprint('本文です'), at }
    expect(judgeUpdate({ baseline: base, nowText: '本文です' })).toBe('same')
    expect(judgeUpdate({ baseline: base, nowText: '本文が変わりました' })).toBe('changed')
  })

  it('★ 控えが無ければ「変わった」とは言わない（根拠のない断定をしない）', () => {
    expect(judgeUpdate({ baseline: null, nowText: '本文です' })).toBe('no-baseline')
    expect(judgeUpdate({ baseline: { hash: '', at: '' }, nowText: '本文です' })).toBe('no-baseline')
  })
})
