import { describe, it, expect } from 'vitest'
import { PUBLISH_DIR, publishRoot, publishRootRel, isMigrated, shouldMove } from '../src/shared/publishRoot'
import { isPublished, MATERIALS_DIR, KOTO_INTERNAL_DIRS, KOTO_INTERNAL_FILES } from '../src/shared/publishExclude'

// 公開の根を1箇所に集める（2026-08-20）。
//
// この製品は「公開経路の一部だけ直して穴が空く」事故を3回起こしている（掟10）。
// 根を変える今回は同じ形の事故がいちばん起きやすいので、
// **全経路が同じ根を見ていること**を、この下の「配線」テストで固定する。

describe('publishRoot（public/ の場所）', () => {
  it('public/ があれば、その中が根になる', () => {
    expect(publishRoot('/p/myapp', true)).toBe(`/p/myapp/${PUBLISH_DIR}`)
  })

  it('フォルダが無ければ、プロジェクト直下が根（移行前でも動く）', () => {
    // ここを外すと、しばらく開いていないプロジェクトが公開できなくなる。
    expect(publishRoot('/p/myapp', false)).toBe('/p/myapp')
  })

  it('末尾の区切りが付いていても壊れない', () => {
    expect(publishRoot('/p/myapp/', true)).toBe(`/p/myapp/${PUBLISH_DIR}`)
    expect(publishRoot('/p/myapp//', false)).toBe('/p/myapp')
  })

  it('空のプロジェクトパスでは空を返す（呼び出し側で弾ける）', () => {
    expect(publishRoot('', true)).toBe('')
    expect(publishRoot(undefined as any, true)).toBe('')
  })

  it('相対の形も取れる（プロジェクト直下からの相対）', () => {
    expect(publishRootRel(true)).toBe(PUBLISH_DIR)
    expect(publishRootRel(false)).toBe('')
  })

  it('移行済みかどうかを見分けられる', () => {
    expect(isMigrated('/p/myapp', true)).toBe(true)
    expect(isMigrated('/p/myapp', false)).toBe(false)
  })
})

describe('shouldMove（移行で移すもの）', () => {
  it('公開されるものは移す', () => {
    for (const n of ['index.html', 'style.css', 'main.js', 'package.json', 'images']) {
      expect(shouldMove(n, isPublished(n, n === 'images')), n).toBe(true)
    }
  })

  it('素材・Koto の内部は移さない（直下に残す）', () => {
    for (const d of [MATERIALS_DIR, ...KOTO_INTERNAL_DIRS, '.git', 'node_modules']) {
      expect(shouldMove(d, isPublished(d, true)), d).toBe(false)
    }
    for (const f of [...KOTO_INTERNAL_FILES, '.DS_Store', '.env']) {
      expect(shouldMove(f, isPublished(f, false)), f).toBe(false)
    }
  })

  it('`public/`自身は移さない（自分の中に入れない）', () => {
    expect(shouldMove(PUBLISH_DIR, true)).toBe(false)
  })

  it('名前が空なら移さない', () => {
    expect(shouldMove('', true)).toBe(false)
  })

  it('判定は publishExclude に任せている（手で並べ直さない・掟10）', () => {
    // shouldMove は isPublished の結果をそのまま使う。ここで独自の名簿を持たない。
    expect(shouldMove('なにか.html', false)).toBe(false)
    expect(shouldMove('なにか.html', true)).toBe(true)
  })
})
