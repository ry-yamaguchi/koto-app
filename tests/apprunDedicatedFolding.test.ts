import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  computeDedicatedFormErrors,
  visibleFormErrors,
  type DedicatedFormErrors,
  type DedicatedFormTouched,
} from '../src/renderer/components/AppRunDedicatedPanel'

// 委譲仕様 UX-D・判断7: 専有型 AppRunDedicatedPanel.tsx を初心者向けに畳む。
// ②サービスプリンシパルの手順を「詳しい手順を見る」に畳み、⑤の詳細設定
// （ポート・ノード数・Let's Encrypt メール）を「詳細設定（ふつうは変えなくてよい）」に畳む。
// formError（1本の早期return文字列。初期状態からいきなり出る・欄側の警告と二重に出る）を
// computeDedicatedFormErrors（欄ごとの判定）＋ visibleFormErrors（touched/submitted による
// 表示可否）に分けた。

const VALID_INPUT = {
  clusterName: 'myapp',
  resourceId: '123456789012',
  ports: [{ port: 80, protocol: 'http' as const }, { port: 443, protocol: 'https' as const }],
  zone: 'tk1a',
  selectedWorkerPath: 'cloud/apprun/dedicated/worker/1vcpu_2gb',
  selectedLbPath: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1',
  minNodes: 1,
  maxNodes: 1,
}

describe('computeDedicatedFormErrors: 欄ごとに独立して判定する', () => {
  it('すべて有効なら、エラーは無い', () => {
    expect(computeDedicatedFormErrors(VALID_INPUT)).toEqual({})
  })

  it('クラスタ名が空、または形式違反なら clusterName にエラー', () => {
    expect(computeDedicatedFormErrors({ ...VALID_INPUT, clusterName: '' }).clusterName).toBe('クラスタ名を入力してください')
    expect(computeDedicatedFormErrors({ ...VALID_INPUT, clusterName: '!!!' }).clusterName)
      .toBe('クラスタ名は1〜20文字の英数字・_・- で入力してください')
  })

  it('サービスプリンシパルIDが空なら resourceId にエラー', () => {
    expect(computeDedicatedFormErrors({ ...VALID_INPUT, resourceId: '' }).resourceId)
      .toBe('②でサービスプリンシパルIDを入力してください')
  })

  it('ポート0件・範囲外・予約ポートで ports にエラー', () => {
    expect(computeDedicatedFormErrors({ ...VALID_INPUT, ports: [] }).ports).toBe('公開ポートを1つ以上指定してください')
    expect(computeDedicatedFormErrors({ ...VALID_INPUT, ports: [{ port: 0, protocol: 'http' }] }).ports)
      .toBe('ポート番号は1〜65535で指定してください')
    expect(computeDedicatedFormErrors({ ...VALID_INPUT, ports: [{ port: 5950, protocol: 'http' }] }).ports)
      .toContain('は予約されており使えません')
  })

  it('ゾーン未入力で zone にエラー', () => {
    expect(computeDedicatedFormErrors({ ...VALID_INPUT, zone: '  ' }).zone).toBe('ゾーンを入力してください')
  })

  it('プラン未選択で workerPlan / lbPlan にエラー', () => {
    expect(computeDedicatedFormErrors({ ...VALID_INPUT, selectedWorkerPath: null }).workerPlan).toContain('ワーカプランを選んでください')
    expect(computeDedicatedFormErrors({ ...VALID_INPUT, selectedLbPath: null }).lbPlan).toContain('ロードバランサプランを選んでください')
  })

  it('ノード数が範囲外・min>maxで nodes にエラー', () => {
    expect(computeDedicatedFormErrors({ ...VALID_INPUT, minNodes: 0 }).nodes).toContain('ノード数（min）')
    expect(computeDedicatedFormErrors({ ...VALID_INPUT, maxNodes: 11 }).nodes).toContain('ノード数（max）')
    expect(computeDedicatedFormErrors({ ...VALID_INPUT, minNodes: 5, maxNodes: 2 }).nodes).toContain('min ≦ max')
  })

  it('複数の欄が同時に不正なら、それぞれ独立してエラーを持つ（1本の早期returnに戻していない）', () => {
    const errors = computeDedicatedFormErrors({ ...VALID_INPUT, clusterName: '', zone: '' })
    expect(errors.clusterName).toBeTruthy()
    expect(errors.zone).toBeTruthy()
  })
})

describe('visibleFormErrors: 初期状態→空／触った後→その項目だけ／送信後→全部', () => {
  const errors: DedicatedFormErrors = { clusterName: 'クラスタ名を入力してください', zone: 'ゾーンを入力してください' }

  it('初期状態（touched が空・submitted===false）では、何も出さない', () => {
    expect(visibleFormErrors(errors, {}, false)).toEqual({})
  })

  it('触った欄があれば、その欄の分だけ出す（他の未入力欄はまだ黙っている）', () => {
    const touched: DedicatedFormTouched = { clusterName: true }
    expect(visibleFormErrors(errors, touched, false)).toEqual({ clusterName: 'クラスタ名を入力してください' })
  })

  it('「作成」を押した後（submitted）は、触っていない欄も含めて全部出す', () => {
    expect(visibleFormErrors(errors, {}, true)).toEqual(errors)
  })

  it('送信後は、触った欄が一部でも全部を返す（touched の内容に関係ない）', () => {
    const touched: DedicatedFormTouched = { clusterName: true }
    expect(visibleFormErrors(errors, touched, true)).toEqual(errors)
  })

  it('エラーが無ければ、touched/submitted に関係なく空', () => {
    expect(visibleFormErrors({}, { clusterName: true }, true)).toEqual({})
  })
})

// ── 配線（ソースを読んで固定）──────────────────────────────────────────
// electron に依存するため import できず、ソースを読んで確かめる
// （tests/apprunDedicatedWiring.test.ts と同じ流儀）。
const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf-8')

describe('②: サービスプリンシパルの手順を「詳しい手順を見る」の <details> に畳む', () => {
  it('既定で見えるのは入力欄と1行の説明だけ。手順A/Bは <details> の中', () => {
    const sectionAt = panel.indexOf('{/* ② サービスプリンシパルの用意')
    expect(sectionAt).toBeGreaterThan(0)
    const sectionEnd = panel.indexOf('{/* ③ 使えるプランと制限', sectionAt)
    expect(sectionEnd).toBeGreaterThan(sectionAt)
    const block = panel.slice(sectionAt, sectionEnd)

    const labelAt = block.indexOf('サービスプリンシパルのリソースID（12桁）')
    const detailsAt = block.indexOf('<details')
    // 直前の説明コメントにも「詳しい手順を見る」の語が出るため、<details> より後の
    // 出現（実際の <summary> 要素）を探す。
    const summaryAt = block.indexOf('詳しい手順を見る', detailsAt)
    const stepAAt = block.indexOf('手順A: サービスプリンシパルを作る', summaryAt)
    const stepBAt = block.indexOf('手順B: そのサービスプリンシパルにロールを付ける', stepAAt)

    expect(labelAt).toBeGreaterThan(-1)
    expect(detailsAt).toBeGreaterThan(labelAt) // 入力欄が <details> より先（常時表示）
    expect(summaryAt).toBeGreaterThan(detailsAt)
    expect(stepAAt).toBeGreaterThan(summaryAt) // 手順A/Bは <details> の中
    expect(stepBAt).toBeGreaterThan(stepAAt)

    // 既定で見える1行の説明。
    expect(block).toContain('コントロールパネルで一度だけ作ります。作り方は「詳しい手順を見る」。')
  })

  it('既存の内容（コントロールパネルのリンク・ロール欄のコピーボタン・実在確認できない旨）は残っている', () => {
    expect(panel).toContain('href={CONTROL_PANEL_URL}')
    expect(panel).toContain('<CopyButton text={ROLE_TEXT}')
    expect(panel).toContain('実在するかどうかはここでは確認できません')
  })
})

describe('⑤: 詳細設定（ポート・ノード数・Let\'s Encrypt メール）を <details> に畳む', () => {
  it('既定で見えるのはクラスタ名・ゾーン・ワーカプラン・ロードバランサプラン・構成図・作成ボタン', () => {
    const at = panel.indexOf('{/* ⑤ クラスタを作る */}')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('{/* ⑥ 作ったものを壊す')
    const block = panel.slice(at, end)

    const clusterNameAt = block.indexOf('クラスタ名（1〜20文字')
    const detailsAt = block.indexOf('<details')
    // 直前の説明コメントにも「詳細設定」「ゾーン・ワーカプラン・ロードバランサプラン」等の
    // 語が出るため、<details> より後の出現（実際のJSX）だけを見る。
    const summaryAt = block.indexOf('詳細設定（ふつうは変えなくてよい）', detailsAt)
    const portAt = block.indexOf('<label className="text-[11px] font-medium text-ink-secondary">公開ポート</label>', summaryAt)
    const nodesAt = block.indexOf('ノード数 min', summaryAt)
    const letsEncryptAt = block.indexOf('Let&apos;s Encrypt 用メール', summaryAt)
    const detailsCloseAt = block.indexOf('</details>', letsEncryptAt)
    const zoneAt = block.indexOf('>ゾーン<', detailsCloseAt)
    const workerAt = block.indexOf('ワーカプラン', zoneAt)
    const lbAt = block.indexOf('ロードバランサプラン', workerAt)
    const diagramAt = block.indexOf('{diagram.lines.join')
    const buttonAt = block.indexOf("'クラスタを作成する'}</button>")

    expect(clusterNameAt).toBeGreaterThan(-1)
    expect(detailsAt).toBeGreaterThan(clusterNameAt)
    expect(summaryAt).toBeGreaterThan(detailsAt)
    // ポート・ノード数・Let's Encrypt メールは <details> の中（summary より後）にある。
    expect(portAt).toBeGreaterThan(summaryAt)
    expect(nodesAt).toBeGreaterThan(summaryAt)
    expect(letsEncryptAt).toBeGreaterThan(summaryAt)
    // ゾーン・ワーカプラン・ロードバランサプラン・構成図・作成ボタンは、それらより後（常時表示側）にある。
    expect(zoneAt).toBeGreaterThan(letsEncryptAt)
    expect(workerAt).toBeGreaterThan(zoneAt)
    expect(lbAt).toBeGreaterThan(workerAt)
    expect(diagramAt).toBeGreaterThan(lbAt)
    expect(buttonAt).toBeGreaterThan(diagramAt)

    // 折りたたみの見出し直下の1文。
    expect(block).toContain('既定のままで作れます。ポートは 80/443、ノード数は最小1・最大1。')
  })

  it('Let\'s Encrypt メール欄に「将来の独自ドメイン公開用。いまは空欄でよい」の一言がある', () => {
    expect(panel).toContain('将来の独自ドメイン公開用。いまは空欄でよい。')
  })

  it('ポート・ノード数・Let\'s Encrypt メールの入力欄は1か所ずつだけ（旧: ワーカプラン欄の下にも重複していた）', () => {
    expect((panel.match(/<label className="text-\[11px\] font-medium text-ink-secondary">公開ポート<\/label>/g) ?? []).length).toBe(1)
    expect((panel.match(/ノード数 min/g) ?? []).length).toBe(1)
    expect((panel.match(/Let&apos;s Encrypt 用メール/g) ?? []).length).toBe(1)
  })
})

describe('④formErrorの二重表示: ワーカ/ロードバランサプランの警告は欄側だけに出し、全体側からは外す', () => {
  it('generalErrors の描画は workerPlan / lbPlan を除外している', () => {
    const at = panel.indexOf('generalErrors.map(')
    expect(at).toBeGreaterThan(0)
    const defAt = panel.indexOf('const generalErrors =')
    expect(defAt).toBeGreaterThan(0)
    const defEnd = panel.indexOf('\n  const touch =', defAt)
    const defBlock = panel.slice(defAt, defEnd)
    expect(defBlock).toContain("k !== 'workerPlan' && k !== 'lbPlan'")
  })
})

describe('パネル冒頭の注意文（UX-C で一本化したもの）は残っている', () => {
  it('cheapestMonthlyText と「常時課金です」が引き続き冒頭にある', () => {
    const at = panel.indexOf('📦 さくらのAppRun 専有型')
    expect(at).toBeGreaterThan(0)
    // UX-E（判断8）: ①は AccessKeySection.tsx に一元化され、'① APIキー' という
    // 文字列は（コメントを除けば）panel.tsx の JSX には直接出てこなくなった。
    // <AccessKeySection の出現位置を境界にする。
    const end = panel.indexOf('<AccessKeySection', at)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain('cheapestMonthlyText({ workerPlans, lbPlans })')
    expect(block).toContain('常時課金です')
  })
})
