import { describe, it, expect } from 'vitest'
import { decideTabSync, mayWriteTab, type TabSyncInput, type TabSyncVerdict, type WriteVerdict } from '../src/shared/editorSync'

// ── エディタのタブとディスクの食い違いの判断（shared/editorSync.ts）。全分岐を表で固定する ──
// 順序: disk が null → missing ／ disk が baseline と同じ → unchanged ／ disk が content と同じ → adopt ／ 未保存でない → reload ／ それ以外 → conflict
// 順序が答えを変える行（どれかの順を入れ替えると落ちる行）に ★ を付けた。

type Row = { name: string; input: TabSyncInput; want: TabSyncVerdict }

const rows: Row[] = [
  { name: 'ディスクが無い（未保存の編集あり）', input: { baseline: 'a', content: 'b', isDirty: true, disk: null }, want: 'missing' },
  { name: 'ディスクが無い（未保存の編集なし）', input: { baseline: 'a', content: 'a', isDirty: false, disk: null }, want: 'missing' },
  { name: '★ ディスクが無い・基準も中身も空文字（空のファイルと「無い」を取り違えない）', input: { baseline: '', content: '', isDirty: false, disk: null }, want: 'missing' },
  { name: 'ディスクが基準と同じ（編集なし）', input: { baseline: 'a', content: 'a', isDirty: false, disk: 'a' }, want: 'unchanged' },
  { name: 'ディスクが基準と同じ（未保存の編集あり）', input: { baseline: 'a', content: 'b', isDirty: true, disk: 'a' }, want: 'unchanged' },
  { name: '★ 基準・中身・ディスクが全部同じなら adopt ではなく unchanged', input: { baseline: 'a', content: 'a', isDirty: true, disk: 'a' }, want: 'unchanged' },
  { name: '空のファイルどうしも同じ', input: { baseline: '', content: 'x', isDirty: true, disk: '' }, want: 'unchanged' },
  { name: 'ディスクがエディタの中身と同じ（基準とは違う・未保存の編集あり）', input: { baseline: 'a', content: 'b', isDirty: true, disk: 'b' }, want: 'adopt' },
  { name: '★ ディスクが中身と同じなら、未保存でなくても reload ではなく adopt', input: { baseline: 'a', content: 'b', isDirty: false, disk: 'b' }, want: 'adopt' },
  { name: '外で変わった・未保存の編集なし', input: { baseline: 'a', content: 'a', isDirty: false, disk: 'c' }, want: 'reload' },
  { name: '外で変わった・未保存の編集あり', input: { baseline: 'a', content: 'b', isDirty: true, disk: 'c' }, want: 'conflict' },
  { name: '外で空にされた・未保存の編集あり', input: { baseline: 'a', content: 'b', isDirty: true, disk: '' }, want: 'conflict' },
  { name: '外で空にされた・未保存の編集なし', input: { baseline: 'a', content: 'a', isDirty: false, disk: '' }, want: 'reload' },
]

describe('decideTabSync: 全分岐の表', () => {
  for (const r of rows) {
    it(`${r.name} → ${r.want}`, () => {
      expect(decideTabSync(r.input)).toBe(r.want)
    })
  }

  it('5つの答えがすべて表に現れる（分岐の取りこぼしがない）', () => {
    expect(new Set(rows.map(r => r.want))).toEqual(new Set(['missing', 'unchanged', 'adopt', 'reload', 'conflict']))
  })

  it('★ 空文字（空のファイル）は「無い」ではない。null だけが missing', () => {
    expect(decideTabSync({ baseline: 'a', content: 'a', isDirty: false, disk: '' })).not.toBe('missing')
    expect(decideTabSync({ baseline: '', content: '', isDirty: false, disk: '' })).toBe('unchanged')
  })
})

type WRow = { name: string; baseline: string | null; content: string; disk: string | null; want: WriteVerdict }

const writeRows: WRow[] = [
  { name: 'ディスクが基準と同じ → 書く', baseline: 'a', content: 'b', disk: 'a', want: 'write' },
  { name: '★ 基準・中身・ディスクが全部同じ → 書く', baseline: 'a', content: 'a', disk: 'a', want: 'write' },
  { name: 'ディスクがすでに書きたい中身（基準とは違う） → 書かなくてよい', baseline: 'a', content: 'b', disk: 'b', want: 'skip' },
  { name: '外で変わっている → 書かない', baseline: 'a', content: 'b', disk: 'c', want: 'conflict' },
  { name: '外で空にされた → 書かない', baseline: 'a', content: 'b', disk: '', want: 'conflict' },
  { name: '★ ディスクが無い → 書かない（消えたものを黙って作らない）', baseline: 'a', content: 'b', disk: null, want: 'conflict' },
  { name: '基準が空文字でディスクも空 → 書く', baseline: '', content: 'b', disk: '', want: 'write' },
  { name: '無いときだけ作る（baseline が null）: ディスクが無い → 書く', baseline: null, content: 'b', disk: null, want: 'write' },
  { name: '★ 無いときだけ作る: ディスクがある → 書かない', baseline: null, content: 'b', disk: 'c', want: 'conflict' },
  { name: '★ 無いときだけ作る: ディスクが空のファイルでも「ある」 → 書かない', baseline: null, content: 'b', disk: '', want: 'conflict' },
  { name: '★ 無いときだけ作る: ディスクが書きたい中身と同じでも書かない（外で作られた）', baseline: null, content: 'b', disk: 'b', want: 'conflict' },
]

describe('mayWriteTab: 書く前の判断（write | skip | conflict）', () => {
  for (const r of writeRows) {
    it(`${r.name} → ${r.want}`, () => {
      expect(mayWriteTab({ baseline: r.baseline, content: r.content, disk: r.disk })).toBe(r.want)
    })
  }

  it('3つの答えがすべて表に現れる', () => {
    expect(new Set(writeRows.map(r => r.want))).toEqual(new Set(['write', 'skip', 'conflict']))
  })

  it('★ decideTabSync と同じ表から導く: 文字列の基準では、unchanged だけが write・adopt だけが skip・ほかは conflict', () => {
    const disks: (string | null)[] = [null, '', 'a', 'b', 'c']
    for (const baseline of ['', 'a']) {
      for (const content of ['a', 'b']) {
        for (const disk of disks) {
          const v = decideTabSync({ baseline, content, isDirty: true, disk })
          const want: WriteVerdict = v === 'unchanged' ? 'write' : v === 'adopt' ? 'skip' : 'conflict'
          expect(mayWriteTab({ baseline, content, disk }), JSON.stringify({ baseline, content, disk })).toBe(want)
        }
      }
    }
  })
})
