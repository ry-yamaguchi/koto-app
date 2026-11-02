import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  GREET_ON_OPEN_KEY, GREET_ON_OPEN_LABEL, isGreetOnOpenEnabled, setGreetOnOpen,
} from '../src/renderer/greetSetting'

// ── 設定「プロジェクトを開いたとき AI があいさつする」（U3・T-5c・T-5d の設定画面側・T-5e）────────────────────────────
// 'off' が保存されているときだけオフ。未設定・ほかの値・localStorage の失敗はオン（既定）。
// 書き込み口は setGreetOnOpen の1つだけ。設定の表示名は定数1つで、設定画面・README・使い方ガイドがその文字列を指す。
// vitest の環境は node で localStorage が無いので、claudeAgent.test.ts と同じ作法で最小のインメモリ実装を差し込む。

type FakeStorage = {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
  removeItem: (k: string) => void
}

const memoryStorage = (initial: Record<string, string> = {}): FakeStorage & { dump: () => Record<string, string> } => {
  const store: Record<string, string> = { ...initial }
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: k => { delete store[k] },
    dump: () => ({ ...store }),
  }
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const install = (value: unknown): void => {
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true })
}
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original)
  else delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('T-5c: 読み出し（isGreetOnOpenEnabled）は、\'off\' のときだけオフ', () => {
  beforeEach(() => install(memoryStorage()))

  it('★★ キーの名前は sakura_greet_on_open（保存先を黙って変えない）', () => {
    expect(GREET_ON_OPEN_KEY).toBe('sakura_greet_on_open')
  })

  it('★★★ 未設定 → オン（既定）', () => {
    install(memoryStorage())
    expect(isGreetOnOpenEnabled()).toBe(true)
  })

  it('★★★ \'on\' → オン', () => {
    install(memoryStorage({ [GREET_ON_OPEN_KEY]: 'on' }))
    expect(isGreetOnOpenEnabled()).toBe(true)
  })

  it('★★★ \'off\' → オフ（これだけがオフ）', () => {
    install(memoryStorage({ [GREET_ON_OPEN_KEY]: 'off' }))
    expect(isGreetOnOpenEnabled()).toBe(false)
  })

  it.each(['', '0', '1', 'false', 'true', 'no', 'OFF', 'Off', ' off', 'off ', 'disabled', 'null', 'undefined', '{"off":true}'])(
    '★★★ 不明な値 %j → オン（不明をオフに倒さない）',
    value => {
      install(memoryStorage({ [GREET_ON_OPEN_KEY]: value }))
      expect(isGreetOnOpenEnabled()).toBe(true)
    },
  )

  it('★★★ localStorage.getItem が throw → オン', () => {
    install({
      ...memoryStorage(),
      getItem: () => { throw new Error('storage unavailable') },
    })
    expect(isGreetOnOpenEnabled()).toBe(true)
  })

  it('★★ localStorage の参照そのものが throw → オン', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      get() { throw new Error('storage blocked') },
      configurable: true,
    })
    expect(isGreetOnOpenEnabled()).toBe(true)
  })

  it('★★ localStorage が無い環境 → オン', () => {
    install(undefined)
    expect(isGreetOnOpenEnabled()).toBe(true)
  })
})

describe('T-5c: 書き込み（setGreetOnOpen）と往復', () => {
  it('★★★ false → \'off\' を保存してオフ、true → \'on\' を保存してオン。何度往復しても同じ', () => {
    const s = memoryStorage()
    install(s)
    for (let i = 0; i < 3; i++) {
      expect(setGreetOnOpen(false)).toBe(true)
      expect(s.dump()).toEqual({ [GREET_ON_OPEN_KEY]: 'off' })
      expect(isGreetOnOpenEnabled()).toBe(false)
      expect(setGreetOnOpen(true)).toBe(true)
      expect(s.dump()).toEqual({ [GREET_ON_OPEN_KEY]: 'on' })
      expect(isGreetOnOpenEnabled()).toBe(true)
    }
  })

  it('★★★ 書き込みに失敗したら false を返し、設定は変わらない（オフにしたつもりにさせない）', () => {
    const s = memoryStorage()
    install({ ...s, setItem: () => { throw new Error('quota exceeded') } })
    expect(setGreetOnOpen(false)).toBe(false)
    expect(isGreetOnOpenEnabled()).toBe(true)
  })

  it('★★ 書き込みに失敗しても、すでに保存されているオフは壊れない', () => {
    install({
      ...memoryStorage({ [GREET_ON_OPEN_KEY]: 'off' }),
      setItem: () => { throw new Error('quota exceeded') },
    })
    expect(setGreetOnOpen(true)).toBe(false)
    expect(isGreetOnOpenEnabled()).toBe(false)
  })

  it('★★ localStorage が無い環境でも throw せず false を返す', () => {
    install(undefined)
    expect(() => setGreetOnOpen(false)).not.toThrow()
    expect(setGreetOnOpen(false)).toBe(false)
  })
})

// ── 書き込み口は1つ ────────────────────────────────────────────────────────────────────────────────────────────
const ROOT = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}
const SRC_FILES = walk(join(ROOT, 'src')).map(p => relative(ROOT, p))
const OTHERS = SRC_FILES.filter(f => f !== 'src/renderer/greetSetting.ts')

describe('T-5c: 同じキーへの書き込み口は setGreetOnOpen の1つだけ', () => {
  it('★ src の木を読めている（空の走査で通さない）', () => {
    expect(SRC_FILES.length).toBeGreaterThan(100)
    expect(SRC_FILES).toContain('src/renderer/greetSetting.ts')
    expect(SRC_FILES).toContain('src/renderer/components/SettingsModal.tsx')
  })

  it('★★★ greetSetting.ts の中の localStorage への書き込みは、setGreetOnOpen の setItem 1回だけ（removeItem も無い）', () => {
    const src = read('src/renderer/greetSetting.ts')
    expect(src.match(/localStorage\.setItem\(/g) ?? []).toHaveLength(1)
    expect(src).toContain('localStorage.setItem(GREET_ON_OPEN_KEY, on ? \'on\' : \'off\')')
    expect(src).not.toMatch(/localStorage\.removeItem\(/)
    expect(src).not.toMatch(/localStorage\.clear\(/)
    // その setItem は setGreetOnOpen の中にある
    const fnStart = src.indexOf('export function setGreetOnOpen(')
    expect(fnStart).toBeGreaterThan(-1)
    expect(src.indexOf('localStorage.setItem(')).toBeGreaterThan(fnStart)
  })

  it('★★★ キーの文字列と定数は、greetSetting.ts 以外の src に出てこない（直に書く口を作らせない）', () => {
    const offenders = OTHERS.filter(f => {
      const s = read(f)
      return s.includes('sakura_greet_on_open') || s.includes('GREET_ON_OPEN_KEY')
    })
    expect(offenders).toEqual([])
  })

  it('★★ IPC・main・preload は変えない: main 側と preload は greetSetting を知らない', () => {
    const mainSide = SRC_FILES.filter(f => f.startsWith('src/main/') || f === 'src/preload.ts' || f.startsWith('src/preload/'))
    expect(mainSide.length).toBeGreaterThan(20)
    expect(mainSide.filter(f => /greetSetting|GREET_ON_OPEN|greet_on_open/.test(read(f)))).toEqual([])
  })
})

// ── 設定画面（T-5d の設定画面側）────────────────────────────────────────────────────────────────────────────────
describe('設定画面: SettingsModal は表示名の定数を出し、書き込みは setGreetOnOpen の1か所だけ', () => {
  const modal = read('src/renderer/components/SettingsModal.tsx')

  it('★★★ setGreetOnOpen( を呼ぶのは1か所だけ（チェックボックスの onChange）', () => {
    expect(modal.match(/\bsetGreetOnOpen\(/g) ?? []).toHaveLength(1)
    const start = modal.indexOf('checked={greetOnOpen}')
    const end = modal.indexOf('{GREET_ON_OPEN_LABEL}')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = modal.slice(start, end)
    expect(block).toContain('onChange={e => {')
    expect(block).toContain('setGreetOnOpen(e.target.checked)')
    // 保存できなかったときも、画面は実際の設定の値に戻る（保存に失敗してもチェックだけ付いた形にしない）
    expect(block).toContain('setGreetOnOpenState(isGreetOnOpenEnabled())')
    expect(block).not.toMatch(/localStorage/)
  })

  it('★★★ 初期値は保存された設定（既定オン）から読む', () => {
    expect(modal).toContain('useState<boolean>(isGreetOnOpenEnabled())')
  })

  it('★★★ 表示名は定数で出す。画面の側に文字列を直に書かない', () => {
    expect(modal).toContain("import { GREET_ON_OPEN_LABEL, isGreetOnOpenEnabled, setGreetOnOpen } from '../greetSetting'")
    expect(modal.match(/\{GREET_ON_OPEN_LABEL\}/g) ?? []).toHaveLength(1)
    expect(modal).not.toContain(GREET_ON_OPEN_LABEL)
  })

  it('★★ カードの見出しと説明は仕様どおり（見出し「最初のあいさつ」・説明は1文ずつ）', () => {
    expect(modal).toContain('<div className="text-xs font-semibold text-ink-secondary mb-2">最初のあいさつ</div>')
    expect(modal).toContain('会話が空のプロジェクトを開くと、さくらのAI Engine が要約と質問を返し、その利用量を使います。Claude だけを使っているときは、決まった一言だけです。')
  })

  it('★★ カードは思考カードのあとにある', () => {
    const thinking = modal.indexOf('AIの思考の表示')
    const greet = modal.indexOf('checked={greetOnOpen}')
    expect(thinking).toBeGreaterThan(-1)
    expect(greet).toBeGreaterThan(thinking)
  })
})

// ── T-5e: 文書の突き合わせ（掟9）─────────────────────────────────────────────────────────────────────────────────
describe('T-5e: 設定の表示名は、設定画面・README・使い方ガイドの3か所で同じ文字列', () => {
  const readme = read('README.md')
  const guide = read('docs/usage-guide.html')

  it('★ 表示名は決まった文字列（変えるなら文書も一緒に変える）', () => {
    expect(GREET_ON_OPEN_LABEL).toBe('プロジェクトを開いたとき AI があいさつする')
  })

  it('★★★ README が、表示名を「」で引いている', () => {
    expect(readme).toContain(`「${GREET_ON_OPEN_LABEL}」`)
  })

  it('★★★ 使い方ガイドが、表示名を「」で引いている', () => {
    expect(guide).toContain(`「${GREET_ON_OPEN_LABEL}」`)
  })

  it('★★ README の1行は、オフにできる設定を指し、利用量を使うことを言っている', () => {
    const line = readme.split('\n').find(l => l.includes(`「${GREET_ON_OPEN_LABEL}」`)) ?? ''
    expect(line).toContain('**最初のあいさつ**')
    expect(line).toContain('さくらのAI Engine が要約と質問を返し、その利用量を使います。Claude だけを使っているときは、決まった一言だけです。')
    expect(line).toContain('でオフにできます')
  })

  it('★★ 使い方ガイドの「最初のあいさつ」の行は、旧い「（1回）」でなく設定で切れることを言う', () => {
    const line = guide.split('\n').find(l => l.includes('<b>最初のあいさつ</b>：')) ?? ''
    expect(line).toContain(`「${GREET_ON_OPEN_LABEL}」で切れます`)
    expect(line).not.toContain('（1回）')
  })
})
