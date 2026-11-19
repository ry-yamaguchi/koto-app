import { describe, it, expect } from 'vitest'
import {
  OSV_SECTION_TITLE, OSV_BUTTON_LABEL, OSV_BUTTON_BUSY_LABEL, OSV_DESCRIPTION, OSV_CONFIRM_TITLE, OSV_CONFIRM_OK, OSV_CONFIRM_CANCEL,
  osvConfirmBody, osvViewOfPreview, osvViewOfReply, osvViewText, type OsvView,
} from '../src/renderer/osvCheckWords'
import { splitFailureDetail } from '../src/shared/failureDetail'
import { OSV_SEND_NOTE } from '../src/shared/dataDestinationNotes'
import type { OsvCheckReply, OsvDone, OsvFinding, OsvPreview } from '../src/shared/osvTypes'

const NO_SKIP = { dev: 0, notPublic: 0, badShape: 0 }
const done = (over: Partial<OsvDone> = {}): OsvDone => ({ kind: 'done', total: 3, sent: 3, checked: 3, findings: [], withdrawn: 0, stop: null, ...over })
const reply = (over: Partial<OsvDone> = {}, extra: { skipped?: typeof NO_SKIP; manifest?: 'match' | 'mismatch' | 'unreadable' } = {}): OsvCheckReply =>
  ({ state: 'done', result: done(over), skipped: extra.skipped ?? NO_SKIP, manifest: extra.manifest ?? 'match' })
const texts = (v: OsvView) => v.lines.map(l => l.text)
const finding = (over: Partial<OsvFinding> = {}): OsvFinding => ({
  name: 'lodash', version: '4.17.0', fixedAll: '4.17.21',
  vulns: [{ id: 'GHSA-aaaa', link: 'https://osv.dev/vulnerability/GHSA-aaaa', fixed: '4.17.21', severityLabel: null, detail: 'ok' }],
  ...over,
})

describe('通信が届かなかった回と、途中で止まった回の弱点', () => {
  it('sent 0 の offline は「送りました」を出さない', () => {
    const v = osvViewOfReply(reply({ sent: 0, checked: 0, stop: { reason: 'offline', detail: 'fetch failed' } }))
    expect(texts(v).join('\n')).not.toContain('送りました')
  })
  it('checked 0 で止まっても、見つかった ID は出す', () => {
    const v = osvViewOfReply(reply({ total: 5, sent: 5, checked: 0, findings: [finding()], stop: { reason: 'timeout', detail: 'x' } }))
    const t = texts(v).join('\n')
    expect(t).toContain('GHSA-aaaa')
    expect(t).toContain('OSV.dev から応答がありませんでした')
    expect(t).not.toContain('✅')
    expect(v.verdict).toBe('warn')
    // 見出しは「0件だけ調べられました」と言わない。弱点の一覧を出した回なので、出典を添える
    expect(texts(v)[0]).toBe('⚠️ 5件を、最後まで調べられませんでした。')
    expect(t).not.toContain('0件')
    expect(texts(v)[texts(v).length - 1]).toBe('出典: OSV.dev')
  })
})

describe('固定の文', () => {
  it('見出し・ボタン・説明・確認の題とボタン', () => {
    expect(OSV_SECTION_TITLE).toBe('ライブラリの脆弱性')
    expect(OSV_BUTTON_LABEL).toBe('ライブラリの脆弱性を調べる')
    expect(OSV_BUTTON_BUSY_LABEL).toBe('調べています…')
    expect(OSV_DESCRIPTION).toBe('使っているライブラリに、既知の脆弱性が無いかを調べます。ライブラリの名前とバージョンが、脆弱性データベース OSV.dev に送られます。AI は使いません。')
    expect(OSV_DESCRIPTION).toContain(OSV_SEND_NOTE)
    expect(OSV_CONFIRM_TITLE).toBe('ライブラリの脆弱性を調べますか')
    expect(OSV_CONFIRM_OK).toBe('送って調べる')
    expect(OSV_CONFIRM_CANCEL).toBe('やめる')
  })
})

describe('確認の本文', () => {
  const tailText = '\n\nソースコード・ファイルの中身・プロジェクト名は送りません。送信元の IP アドレスは OSV.dev に伝わります。\n\nこの確認は初回だけです。設定から取り消せます。'
  it('例が2件以上なら先頭の2件', () => {
    expect(osvConfirmBody(12, ['lodash 4.17.21', 'react 18.2.0', 'vue 3.0.0'])).toBe(
      '本番で使うライブラリ12件の名前とバージョンを、脆弱性データベース OSV.dev に送ります。\n例: lodash 4.17.21、react 18.2.0' + tailText)
  })
  it('例が1件', () => {
    expect(osvConfirmBody(1, ['lodash 4.17.21'])).toBe(
      '本番で使うライブラリ1件の名前とバージョンを、脆弱性データベース OSV.dev に送ります。\n例: lodash 4.17.21' + tailText)
  })
  it('例が0件なら例の行ごと出さない', () => {
    const b = osvConfirmBody(5, [])
    expect(b).toBe('本番で使うライブラリ5件の名前とバージョンを、脆弱性データベース OSV.dev に送ります。' + tailText)
    expect(b).not.toContain('例:')
  })
})

describe('✅ になる回', () => {
  it('全部そろった回だけ ✅', () => {
    const v = osvViewOfReply(reply())
    expect(v.verdict).toBe('ok')
    expect(v.lines).toEqual([
      { kind: 'head', text: '✅ 調べた3件に、OSV.dev に登録された既知の脆弱性は見つかりませんでした。' },
      { kind: 'text', text: '見つからないことは、安全の保証ではありません。' },
      { kind: 'note', text: '3件の名前とバージョンを OSV.dev に送りました。' },
    ])
    expect(osvViewText(v)).not.toContain('出典')
  })

  it('manifest が mismatch・unreadable なら ✅ を付けず、lockfile の注意を出す', () => {
    const m = osvViewOfReply(reply({}, { manifest: 'mismatch' }))
    expect(m.verdict).toBe('warn')
    expect(texts(m)).toEqual([
      '調べた3件に、OSV.dev に登録された既知の脆弱性は見つかりませんでした。',
      '見つからないことは、安全の保証ではありません。',
      '⚠️ package-lock.json が package.json と合っていません。公開するときに入るライブラリのバージョンが、調べたものと違うかもしれません。',
      '3件の名前とバージョンを OSV.dev に送りました。',
    ])
    const u = osvViewOfReply(reply({}, { manifest: 'unreadable' }))
    expect(u.verdict).toBe('warn')
    expect(texts(u)[2]).toBe('⚠️ package-lock.json が package.json と合っているか、確かめられませんでした。')
  })

  const breakers: Array<[string, OsvCheckReply]> = [
    ['stop あり', reply({ stop: { reason: 'timeout', detail: 'x' } })],
    ['checked < total', reply({ checked: 2 })],
    ['total > sent', reply({ sent: 2 })],
    ['弱点あり', reply({ findings: [finding()] })],
    ["manifest 'mismatch'", reply({}, { manifest: 'mismatch' })],
    ["manifest 'unreadable'", reply({}, { manifest: 'unreadable' })],
  ]
  for (const [name, r] of breakers) {
    it(`条件を崩すと ✅ が消える: ${name}`, () => {
      const v = osvViewOfReply(r)
      expect(v.verdict).not.toBe('ok')
      expect(osvViewText(v)).not.toContain('✅')
    })
  }
})

describe('弱点あり', () => {
  it('ライブラリごとの行と弱点ごとの行', () => {
    const v = osvViewOfReply(reply({
      findings: [
        finding(),
        finding({
          name: 'minimist', version: '1.0.0', fixedAll: null,
          vulns: [
            { id: 'GHSA-bbbb', link: null, fixed: null, severityLabel: 'HIGH', detail: 'ok' },
            { id: 'GHSA-cccc', link: 'https://osv.dev/vulnerability/GHSA-cccc', fixed: '1.2.6', severityLabel: 'CRITICAL', detail: 'ok' },
            { id: 'GHSA-dddd', link: 'https://osv.dev/vulnerability/GHSA-dddd', fixed: null, severityLabel: null, detail: 'not-fetched' },
            { id: 'GHSA-eeee', link: null, fixed: null, severityLabel: null, detail: 'unreadable' },
          ],
        }),
      ],
    }))
    expect(v.verdict).toBe('warn')
    expect(v.lines).toEqual([
      { kind: 'head', text: '⚠️ 2件のライブラリに、既知の脆弱性が見つかりました。' },
      { kind: 'lib', text: 'lodash 4.17.0 に、既知の脆弱性が1件あります（直ったバージョン: 4.17.21）。' },
      { kind: 'vuln', text: '・GHSA-aaaa（直ったバージョン: 4.17.21）', link: 'https://osv.dev/vulnerability/GHSA-aaaa', linkText: 'GHSA-aaaa' },
      { kind: 'lib', text: 'minimist 1.0.0 に、既知の脆弱性が4件あります。' },
      { kind: 'vuln', text: '・GHSA-bbbb（直ったバージョンの記載なし・重さの記載: HIGH）' },
      { kind: 'vuln', text: '・GHSA-cccc（直ったバージョン: 1.2.6・重さの記載: CRITICAL）', link: 'https://osv.dev/vulnerability/GHSA-cccc', linkText: 'GHSA-cccc' },
      { kind: 'vuln', text: '・GHSA-dddd（詳細は取得していません）', link: 'https://osv.dev/vulnerability/GHSA-dddd', linkText: 'GHSA-dddd' },
      { kind: 'vuln', text: '・GHSA-eeee（詳細を読み取れませんでした）' },
      { kind: 'note', text: '3件の名前とバージョンを OSV.dev に送りました。' },
      { kind: 'note', text: '出典: OSV.dev' },
    ])
    expect(Object.prototype.hasOwnProperty.call(v.lines[4], 'link')).toBe(false)
  })

  it('弱点の行の link は入力のまま（組み立て直さない）', () => {
    const odd = 'https://osv.dev/vulnerability/x%2Fy'
    const v = osvViewOfReply(reply({ findings: [finding({ vulns: [{ id: 'X', link: odd, fixed: null, severityLabel: null, detail: 'ok' }] })] }))
    expect(v.lines.find(l => l.kind === 'vuln')!.link).toBe(odd)
  })
})

describe('一部だけ', () => {
  it('stop あり・弱点0件: 一部だけの文・弱点なしの文・失敗の文（原文つき）', () => {
    const v = osvViewOfReply(reply({ checked: 2, stop: { reason: 'timeout', detail: 'AbortError' } }))
    expect(v.verdict).toBe('warn')
    expect(texts(v)).toEqual([
      '⚠️ 3件のうち2件だけ調べられました。残りは確認できていません。',
      '調べられた2件には、既知の脆弱性は見つかりませんでした。',
      '見つからないことは、安全の保証ではありません。',
      '⏭ OSV.dev から応答がありませんでした。しばらくしてからもう一度お試しください。\n詳細: AbortError',
      '3件の名前とバージョンを OSV.dev に送りました。',
    ])
    expect(v.lines[3].kind).toBe('failure')
  })
  it('stop なしで続きが残っただけ', () => {
    const v = osvViewOfReply(reply({ checked: 1 }))
    expect(texts(v).slice(0, 2)).toEqual([
      '⚠️ 3件のうち1件だけ調べられました。残りは確認できていません。',
      '調べられた1件には、既知の脆弱性は見つかりませんでした。',
    ])
    expect(v.lines.some(l => l.kind === 'failure')).toBe(false)
  })
  it('弱点ありの一部だけ', () => {
    const v = osvViewOfReply(reply({ checked: 2, findings: [finding()], stop: { reason: 'http', detail: '503' } }))
    expect(texts(v)[0]).toBe('⚠️ 3件のうち2件だけ調べられました。残りは確認できていません。')
    expect(texts(v)[1]).toBe('⚠️ 1件のライブラリに、既知の脆弱性が見つかりました。')
    expect(osvViewText(v)).not.toContain('調べられた2件には')
  })
})

describe('一部だけ（件数の取り違え・調べた件数が0）', () => {
  it('見出しの件数は total（sent ではない）', () => {
    const v = osvViewOfReply(reply({ total: 5, sent: 3, checked: 2 }))
    expect(texts(v)[0]).toBe('⚠️ 5件のうち2件だけ調べられました。残りは確認できていません。')
    expect(texts(v)[1]).toBe('調べられた2件には、既知の脆弱性は見つかりませんでした。')
    expect(texts(v)).toContain('3件の名前とバージョンを OSV.dev に送りました。')
  })
  it('stop なしで1件も調べていない回は「0件には見つからなかった」と言わず、lockfile の注意も出さない', () => {
    const v = osvViewOfReply(reply({ checked: 0 }, { manifest: 'mismatch' }))
    expect(v.verdict).toBe('warn')
    expect(texts(v)).toEqual([
      '⚠️ 3件を、最後まで調べられませんでした。',
      '3件の名前とバージョンを OSV.dev に送りました。',
    ])
    expect(osvViewText(v)).not.toContain('0件')
    expect(osvViewText(v)).not.toContain('見つかりませんでした')
    expect(osvViewText(v)).not.toContain('✅')
  })
  it('total 0・checked 0・stop なしは ℹ️', () => {
    const v = osvViewOfReply(reply({ total: 0, sent: 0, checked: 0 }, { skipped: { dev: 2, notPublic: 0, badShape: 0 } }))
    expect(v.verdict).toBe('info')
    expect(texts(v)).toEqual(['ℹ️ 調べられるライブラリがありません。', '開発用のライブラリは調べていません（2件）。'])
  })
})

describe('1件も調べられない', () => {
  const cases: Array<[OsvDone['stop'] & object, string]> = [
    [{ reason: 'offline', detail: 'ENOTFOUND' }, '⏭ 調べられませんでした。インターネットに接続できているか確認して、もう一度お試しください。'],
    [{ reason: 'timeout', detail: 'ETIMEDOUT' }, '⏭ OSV.dev から応答がありませんでした。しばらくしてからもう一度お試しください。'],
    [{ reason: 'http', detail: 'HTTP 500' }, '⏭ OSV.dev が照会を受け付けませんでした。'],
    [{ reason: 'shape', detail: 'bad json' }, '⏭ OSV.dev の返事を読み取れませんでした。'],
    [{ reason: 'too-large', detail: '9999999' }, '⏭ OSV.dev の返事を読み取れませんでした。'],
  ]
  for (const [stop, sentence] of cases) {
    it(`${stop.reason}`, () => {
      const v = osvViewOfReply(reply({ checked: 0, stop }, { manifest: 'mismatch' }))
      expect(v.verdict).toBe('skip')
      expect(v.lines[0]).toEqual({ kind: 'failure', text: `${sentence}\n詳細: ${stop.detail}` })
      expect(splitFailureDetail(v.lines[0].text)).toEqual({ text: sentence, detail: stop.detail })
      // lockfile の注意と出典は、1件も調べられなかった回には出さない
      expect(osvViewText(v)).not.toContain('package-lock.json')
      expect(osvViewText(v)).not.toContain('出典')
      expect(texts(v)[1]).toBe('3件の名前とバージョンを OSV.dev に送りました。')
    })
  }
})

describe('調べられない（通信していない）', () => {
  const cases: Array<[Parameters<typeof osvViewOfReply>[0], string, string]> = [
    [{ state: 'no-manifest' }, 'ℹ️ 調べるライブラリがありません（「公開されるもの」に package.json がありません）。', 'info'],
    [{ state: 'no-deps' }, 'ℹ️ 使っているライブラリはありません。', 'info'],
    [{ state: 'no-lockfile' }, 'ℹ️ package-lock.json が無いため、バージョンが分からず調べられません。', 'info'],
    [{ state: 'unsupported' }, 'ℹ️ この形式の package-lock.json には対応していないため、調べられません。', 'info'],
    [{ state: 'unreadable' }, '⏭ package-lock.json を読み取れないため、調べられません。', 'skip'],
    [{ state: 'bad-dir' }, '⏭ プロジェクトのフォルダを読めないため、調べられません。', 'skip'],
    [{ state: 'not-consented' }, '⏭ 送信に同意していないため、調べていません。', 'skip'],
  ]
  for (const [r, sentence, verdict] of cases) {
    it(r.state, () => {
      expect(osvViewOfReply(r)).toEqual({ verdict, lines: [{ kind: 'text', text: sentence }] })
    })
  }

  it('failed: message をそのまま failure の行に（頭に ⏭）', () => {
    const v = osvViewOfReply({ state: 'failed', message: '読み取れませんでした。\n詳細: EACCES' })
    expect(v).toEqual({ verdict: 'skip', lines: [{ kind: 'failure', text: '⏭ 読み取れませんでした。\n詳細: EACCES' }] })
  })

  it('nothing-to-send と、preview が ok で sendCount 0: 添える行つき', () => {
    const skipped = { dev: 4, notPublic: 2, badShape: 1 }
    const expected = {
      verdict: 'info',
      lines: [
        { kind: 'text', text: 'ℹ️ 調べられるライブラリがありません。' },
        { kind: 'note', text: '開発用のライブラリは調べていません（4件）。' },
        { kind: 'note', text: '公開されているライブラリと確かめられないため、調べていません（2件）。' },
        { kind: 'note', text: '名前かバージョンを読み取れないため、調べていません（1件）。' },
      ],
    }
    expect(osvViewOfReply({ state: 'nothing-to-send', skipped, manifest: 'match' })).toEqual(expected)
    expect(osvViewOfPreview({ state: 'ok', sendCount: 0, total: 7, examples: [], skipped, manifest: 'match' })).toEqual(expected)
  })
})

describe('osvViewOfPreview', () => {
  it('確認へ進める回は null', () => {
    const p: OsvPreview = { state: 'ok', sendCount: 3, total: 3, examples: ['a 1.0.0'], skipped: NO_SKIP, manifest: 'match' }
    expect(osvViewOfPreview(p)).toBeNull()
  })
  it('調べられない回はその場の画面', () => {
    expect(osvViewOfPreview({ state: 'no-lockfile' })).toEqual({ verdict: 'info', lines: [{ kind: 'text', text: 'ℹ️ package-lock.json が無いため、バージョンが分からず調べられません。' }] })
  })
})

describe('件数の取り違えが無い', () => {
  it('確認の本文の件数は sendCount で、skipped の件数ではない', () => {
    const body = osvConfirmBody(3, ['a 1.0.0'])
    expect(body).toContain('ライブラリ3件の')
    expect(body).not.toContain('99')
  })
  it('添える行の件数はそれぞれの skipped', () => {
    const v = osvViewOfReply(reply({ withdrawn: 5 }, { skipped: { dev: 11, notPublic: 22, badShape: 33 } }))
    expect(texts(v)).toEqual(expect.arrayContaining([
      '開発用のライブラリは調べていません（11件）。',
      '公開されているライブラリと確かめられないため、調べていません（22件）。',
      '名前かバージョンを読み取れないため、調べていません（33件）。',
      '取り下げられた記録は数えていません（5件）。',
    ]))
  })
  it('数に桁区切りを入れない', () => {
    const v = osvViewOfReply(reply({ total: 1234, sent: 1234, checked: 1234 }))
    expect(texts(v)[0]).toBe('✅ 調べた1234件に、OSV.dev に登録された既知の脆弱性は見つかりませんでした。')
  })
})

describe('osvViewText', () => {
  it('全部の行を含み、禁じる語を含まない', () => {
    const v = osvViewOfReply(reply({ findings: [finding()], checked: 2, stop: { reason: 'offline', detail: 'ENOTFOUND' } }, { manifest: 'mismatch' }))
    const t = osvViewText(v)
    for (const l of v.lines) expect(t).toContain(l.text)
    expect(t.split('\n').length).toBeGreaterThanOrEqual(v.lines.length)
    expect(t).toContain('詳細: ENOTFOUND')
    expect(t).not.toMatch(/Claude Code|無償|無料|[①-⑳㉑-㊿]/)
  })
})
