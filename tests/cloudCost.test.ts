import { describe, it, expect } from 'vitest'
import {
  REGISTRY_MONTHLY_YEN, REGISTRY_INCLUDED_STORAGE_GIB,
  registryCostNotice, ongoingCostNotice, registryDeleteLabel, registryDeleteHelp,
  registryUnknownNotice, urlChangesOnTeardownNotice,
  teardownTargets, remainingCostWarning, BUCKET_MONTHLY_YEN,
} from '../src/shared/cloudCost'

// 2026-08-06 ユーザー指摘: AppRunアプリを削除しても、コンテナレジストリが残ると月額課金が続く。
// 公式情報で裏取り済み（AppRun共用型=時間額・削除で停止／コンテナレジストリ=月額220円固定）。
// ここで守るのは「金額が画面に出ること」と「残す選択をしたら課金が続くと必ず伝えること」。

describe('料金の定義', () => {
  it('月額と含まれるストレージが公表値と一致する', () => {
    expect(REGISTRY_MONTHLY_YEN).toBe(220)
    expect(REGISTRY_INCLUDED_STORAGE_GIB).toBe(5)
  })
})

describe('公開直後の案内', () => {
  it('金額と、アプリを消すだけでは止まらないことを必ず伝える', () => {
    const msg = registryCostNotice('myapp')
    expect(msg).toContain('220')
    expect(msg).toContain('myapp')
    expect(msg).toContain('AppRunアプリを消すだけでは止まりません')
  })

  it('レジストリ名が不明でも文言が壊れない', () => {
    const msg = registryCostNotice(null)
    expect(msg).toContain('220')
    expect(msg).not.toContain('『』')
  })
})

describe('破棄時のレジストリ削除の選択', () => {
  it('チェックの見出しにレジストリ名が入る', () => {
    expect(registryDeleteLabel('myapp')).toContain('myapp')
    expect(registryDeleteLabel(null)).toContain('コンテナレジストリ')
  })

  it('削除するときは「課金が止まる」と「イメージも消える」を両方伝える', () => {
    const h = registryDeleteHelp(true)
    expect(h).toContain('220')
    expect(h).toContain('止まります')
    expect(h).toContain('イメージも消えます')
  })

  // ここが要。残す選択をしたのに費用の話が出ないと、黙って課金され続ける
  it('残すときは「課金が続く」と必ず伝える', () => {
    const h = registryDeleteHelp(false)
    expect(h).toContain('220')
    expect(h).toContain('続きます')
  })
})

describe('破棄で消えるものの一覧', () => {
  it('レジストリを消すときは一覧に載り、名前も出る', () => {
    const t = teardownTargets({ hasBucket: true, deleteRegistry: true, registryName: 'myapp' })
    expect(t.join('')).toContain('AppRun アプリ')
    expect(t.join('')).toContain('myapp')
    expect(t.join('')).toContain('バケット')
  })

  it('レジストリを残すときは一覧から消える（消えないものを消えると書かない）', () => {
    const t = teardownTargets({ hasBucket: true, deleteRegistry: false, registryName: 'myapp' })
    expect(t.join('')).not.toContain('コンテナレジストリ')
    expect(t.join('')).toContain('AppRun アプリ')
  })

  it('バケットが無ければ載せない', () => {
    const t = teardownTargets({ hasBucket: false, deleteRegistry: true, registryName: 'x' })
    expect(t.join('')).not.toContain('バケット')
  })
})

// 2026-08-09 ユーザー指摘（AppRun 検証の手順1）: 画面に「**月額220円…**」と記号がそのまま出ていた。
// ここが返す文字列は素のテキストとして描画され、破棄の結果メッセージにはそのまま連結されるため、
// Markdown として解釈されることはない。強調は呼び出し側の CSS で行う決まりを、ここで固定する。
describe('画面文言に Markdown 記法を混ぜない', () => {
  const texts: string[] = [
    registryCostNotice('myapp'),
    registryCostNotice(null),
    registryDeleteLabel('myapp'),
    registryDeleteLabel(null),
    registryDeleteHelp(true),
    registryDeleteHelp(false),
    registryUnknownNotice(),
    urlChangesOnTeardownNotice(),
    ...teardownTargets({ hasBucket: true, deleteRegistry: true, registryName: 'myapp' }),
    remainingCostWarning({ deleteRegistry: false, registryName: 'myapp' })!,
  ]

  it.each(texts)('記法がそのまま画面に出ない: %s', (text) => {
    expect(text).not.toMatch(/\*\*|__|`|\[[^\]]+\]\([^)]+\)/)
  })
})

// 2026-08-09 の実機検証（手順7'）で発覚。記録が無いプロジェクトでは、チェックを入れても
// 実際には削除されないのに「コンテナレジストリも削除する」と押せてしまっていた。
describe('記録が無いときの案内', () => {
  it('Koto からは削除できないことと、放置すると課金が続くことを両方伝える', () => {
    const n = registryUnknownNotice()
    expect(n).toContain('記録がない')
    expect(n).toContain('削除できません')
    expect(n).toContain('220')
    expect(n).toContain('コントロールパネル')
  })
})

// 2026-08-09 Ryosuke の指定。AppRun の公開URLはアプリIDから作られるため、破棄して
// 公開し直すと別のURLになる。URLそのものは長くて読み取れないので出さず、事実だけ伝える。
describe('破棄でURLが変わる案内', () => {
  it('元に戻せないことと、伝えた相手に届かなくなることを伝える', () => {
    const n = urlChangesOnTeardownNotice()
    expect(n).toContain('元に戻せません')
    expect(n).toContain('別のURL')
  })

  it('URLそのものは出さない（長すぎて読めないため）', () => {
    expect(urlChangesOnTeardownNotice()).not.toMatch(/https?:\/\//)
  })
})

describe('破棄後に残る費用の警告', () => {
  it('レジストリを残したときだけ警告する', () => {
    const w = remainingCostWarning({ deleteRegistry: false, registryName: 'myapp' })
    expect(w).not.toBeNull()
    expect(w).toContain('220')
    expect(w).toContain('myapp')
  })

  it('全部消したなら警告しない（不要な不安を与えない）', () => {
    expect(remainingCostWarning({ deleteRegistry: true, registryName: 'myapp' })).toBeNull()
  })
})

// ── 費用が見えること（2026-08-14 Ryosuke「費用は見える必要がある」）─────────
// 保存場所を数えていなかったため、**合計を実際より495円少なく見せていた**。
// 足し忘れは、書いていないのと同じくらい悪い。
describe('止まらない費用の見せ方', () => {
  it('保存場所が無ければ、レジストリの分だけ', () => {
    const msg = ongoingCostNotice({ registryName: 'myapp', bucket: null })
    expect(msg).toContain(`月額${REGISTRY_MONTHLY_YEN}円`)
    expect(msg).not.toContain(`${BUCKET_MONTHLY_YEN}円`)
  })

  // ★ Ryosuke 指摘（2026-08-14）。3つのプロジェクトが1つの保存場所を共有していると、
  //   それぞれで＋495円と出せば合計1,485円に見える。実際は495円。**足すと嘘になる。**
  it('共有の保存場所は、合計に足さない（割れないため）', () => {
    const msg = ongoingCostNotice({ registryName: 'myapp', bucket: { name: 'koto-data-x', shared: true } })
    expect(msg).toContain(`月額${REGISTRY_MONTHLY_YEN}円`)
    expect(msg).not.toContain(`月額${REGISTRY_MONTHLY_YEN + BUCKET_MONTHLY_YEN}円`)
  })

  it('共有でも、存在と単価は必ず伝える（黙ると消し忘れる）', () => {
    const msg = ongoingCostNotice({ registryName: 'myapp', bucket: { name: 'koto-data-x', shared: true } })
    expect(msg).toContain('koto-data-x')
    expect(msg).toContain('共有')
    expect(msg).toContain(`${BUCKET_MONTHLY_YEN}円`)
  })

  it('専用の保存場所は、このプロジェクトのものなので合計に足す', () => {
    const msg = ongoingCostNotice({ registryName: 'myapp', bucket: { name: 'koto-myapp', shared: false } })
    expect(msg).toContain(`月額${REGISTRY_MONTHLY_YEN + BUCKET_MONTHLY_YEN}円`)
    expect(msg).toContain('koto-myapp')
    expect(msg).not.toContain('共有')
  })

  // 495円に含まれるのは 100GiB・10万リクエスト・転送10GiB まで。超えれば増える
  it('実額はコントロールパネルで確かめてもらう（月額は固定ではない）', () => {
    for (const bucket of [null, { name: 'b', shared: true }, { name: 'b', shared: false }]) {
      expect(ongoingCostNotice({ registryName: 'a', bucket })).toContain('コントロールパネル')
    }
  })

  it('金額を文頭に置く（小さな文字なので読み飛ばされる）', () => {
    expect(ongoingCostNotice({ registryName: 'a', bucket: { name: 'b', shared: true } }).startsWith('月額')).toBe(true)
  })

  it('止め方を必ず添える（放置すると課金が続く）', () => {
    expect(ongoingCostNotice({ registryName: 'a', bucket: null })).toContain('破棄する')
  })

  it('画面文言に Markdown 記法を混ぜない', () => {
    expect(ongoingCostNotice({ registryName: 'a', bucket: { name: 'b', shared: true } })).not.toMatch(/\*\*|`/)
  })
})

describe('破棄しても止まらない費用', () => {
  it('どちらも消えるなら、警告は出さない', () => {
    expect(remainingCostWarning({ deleteRegistry: true, registryName: 'myapp', keptBucketName: null })).toBeNull()
  })

  // ★ 3段構えで保存場所が残るのは**正常な結果**。黙っていると請求書に出続ける
  it('保存場所が残ったら、レジストリを消していても警告する', () => {
    const w = remainingCostWarning({ deleteRegistry: true, registryName: 'myapp', keptBucketName: 'koto-data-x' })
    expect(w).not.toBeNull()
    expect(w!).toContain(`月額${BUCKET_MONTHLY_YEN}円`)
    expect(w!).toContain('koto-data-x')
    expect(w!).not.toContain('コンテナレジストリ')
  })

  it('両方残ったら、合計で警告する', () => {
    const w = remainingCostWarning({ deleteRegistry: false, registryName: 'myapp', keptBucketName: 'koto-data-x' })!
    expect(w).toContain(`月額${REGISTRY_MONTHLY_YEN + BUCKET_MONTHLY_YEN}円`)
  })

  it('keptBucketName を渡さない既存の呼び出しは、これまでどおり', () => {
    expect(remainingCostWarning({ deleteRegistry: true, registryName: 'myapp' })).toBeNull()
    expect(remainingCostWarning({ deleteRegistry: false, registryName: 'myapp' })!).toContain(`月額${REGISTRY_MONTHLY_YEN}円`)
  })
})
