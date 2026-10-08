import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  shouldAutoInvestigate,
  markAutoInvestigated,
  resetAutoInvestigated,
  investigateFailed,
  shouldShowInvestigateButton,
  investigateButtonLabel,
  rememberInvestigateSnapshot,
  recallInvestigateSnapshot,
  forgetInvestigated,
  type InvestigateSnapshot,
} from '../src/renderer/apprunDedicatedAutoFetch'
// 「作る操作は自動にならない」を**振る舞いで**固定するため、⑤⑥の歯止めそのものを呼ぶ（掟10）。
import { runCreate, runTeardown } from '../src/renderer/apprunDedicatedActions'

// C（2026-09-17 Ryosuke さん指摘／2026-09-24 再指摘）:
// 「調べるボタンの機能はkotoが勝手に取得して利用する形にすればよいのではないか？
//  （課金も発生せず、ユーザーに割り当てられた情報を取得しているだけなのでは？）」
//
// ③が取るのは制限値・プラン一覧・既存クラスタの件数だけ（GET のみ・何も作らず何も変えない）。
// 認証情報が揃った時点で自動で取りに行き、**失敗したときだけ**「🔍 調べる」を出す。

const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf-8')

beforeEach(() => { resetAutoInvestigated() })

/** 取得が成功したときの中身（開き直しで戻ってくるもの）。 */
const okSnapshot: InvestigateSnapshot = {
  limits: { maxClusters: 3 }, limitsError: null,
  workerPlans: [{ name: '1vCPU/2GB', nodeCount: null, path: 'worker/1' }], workerError: null,
  lbPlans: [{ name: 'LB 1', nodeCount: 1, path: 'lb/1' }], lbError: null,
  clusterInfo: { count: 1, hasMore: false }, clusterError: null,
  checkError: null,
}
/** 取得が失敗したときの中身。 */
const ngSnapshot: InvestigateSnapshot = {
  limits: null, limitsError: '403 Forbidden',
  workerPlans: null, workerError: '403 Forbidden',
  lbPlans: null, lbError: '403 Forbidden',
  clusterInfo: null, clusterError: '403 Forbidden',
  checkError: null,
}

describe('C: 認証情報が揃ったら、③を押さなくても取りに行く', () => {
  it('★ キーが登録されていれば、押されていなくても自動で取りに行く', () => {
    expect(shouldAutoInvestigate({ hasKey: true, checking: false, keyId: 'key-1', keysReady: true })).toBe(true)
  })

  it('★ 認証情報が無いときは取りに行かない（エラーも出さない＝そもそも投げない）', () => {
    expect(shouldAutoInvestigate({ hasKey: false, checking: false, keyId: null, keysReady: true })).toBe(false)
    // まだ確かめていない（null）ときも投げない——「無い」と決めつけて失敗を見せない
    expect(shouldAutoInvestigate({ hasKey: null, checking: false, keyId: null, keysReady: true })).toBe(false)
  })

  it('★ キーの一覧が確定するまでは投げない（実際に使うキーを覚えそこねない・検分の指摘6/11）', () => {
    // hasKey（cloud.hasKey）だけ先に返ってきた瞬間。keyId はまだ null で、ここで投げると
    // '(既定のキー)' として覚えてしまい、一覧が届いた直後にもう一度4本の GET が飛ぶ。
    expect(shouldAutoInvestigate({ hasKey: true, checking: false, keyId: null, keysReady: false })).toBe(false)
    // 一覧が確定してから投げる
    expect(shouldAutoInvestigate({ hasKey: true, checking: false, keyId: 'key-1', keysReady: true })).toBe(true)
  })

  it('★ 何度も取りに行かない（投げた直後は投げ直さない）', () => {
    expect(shouldAutoInvestigate({ hasKey: true, checking: false, keyId: 'key-1', keysReady: true })).toBe(true)
    markAutoInvestigated('key-1')
    expect(shouldAutoInvestigate({ hasKey: true, checking: false, keyId: 'key-1', keysReady: true })).toBe(false)
  })

  it('★ 開き直しても③は空にならない（中身が記憶から戻り、GET も投げ直さない・検分の指摘1/2/3）', () => {
    // 1回目: 取りに行って、取れた中身を覚える
    markAutoInvestigated('key-1')
    rememberInvestigateSnapshot('key-1', okSnapshot)
    // 公開ダイアログを閉じて開き直す＝パネルは作り直され、画面の state は空になる。
    // それでも**中身は記憶から戻る**（③が空のままにならない＝⑤でプランを選べる）。
    expect(recallInvestigateSnapshot('key-1')).toEqual(okSnapshot)
    // 中身があるので取りに行き直さない（4本の GET は飛ばない）
    expect(shouldAutoInvestigate({ hasKey: true, checking: false, keyId: 'key-1', keysReady: true })).toBe(false)
    // 取れているのだから「🔍 調べる」は出さない（控えめな取り直しだけ残す）
    expect(investigateButtonLabel({ hasKey: true, failed: false, hasSnapshot: true })).toBe('🔄 最新にする')
  })

  it('★ 失敗したまま開き直しても、押し直す手段が残る（失敗も中身として覚える）', () => {
    markAutoInvestigated('key-1')
    rememberInvestigateSnapshot('key-1', ngSnapshot)
    const back = recallInvestigateSnapshot('key-1')
    expect(back).toEqual(ngSnapshot)
    // 復元した中身から失敗と分かる → 「🔍 調べる」が出る
    expect(investigateFailed(back!)).toBe(true)
    expect(shouldShowInvestigateButton({ hasKey: true, failed: true, hasSnapshot: true })).toBe(true)
  })

  it('★ 中身を持っていないマウントでは、行き止まりにしない（ボタンは出る）', () => {
    // 「投げた」とだけ記録が残り、結果を覚えられずに終わった場合（取得中にキーが切り替わった等）
    markAutoInvestigated('key-1')
    expect(recallInvestigateSnapshot('key-1')).toBeNull()
    // 自動では投げ直さないが、押し直す道は必ず残す（③が永久に空にならない）
    expect(shouldShowInvestigateButton({ hasKey: true, failed: false, hasSnapshot: false })).toBe(true)
    expect(investigateButtonLabel({ hasKey: true, failed: false, hasSnapshot: false })).toBe('🔍 調べる')
  })

  it('キーを切り替えたら取り直す（前のキーの一覧は使えない）', () => {
    markAutoInvestigated('key-1')
    rememberInvestigateSnapshot('key-1', okSnapshot)
    expect(shouldAutoInvestigate({ hasKey: true, checking: false, keyId: 'key-2', keysReady: true })).toBe(true)
    expect(recallInvestigateSnapshot('key-2')).toBeNull()
  })

  it('★ キーの中身が差し替わったら記憶ごと捨てる（前のアカウントの数字を残さない・検分の指摘8）', () => {
    markAutoInvestigated('key-1')
    rememberInvestigateSnapshot('key-1', okSnapshot)
    forgetInvestigated() // 'sakura:credentials-changed' を受けた画面が呼ぶ
    expect(recallInvestigateSnapshot('key-1')).toBeNull()
    // 捨てたあとは、同じ id のままでも取り直しに行く
    expect(shouldAutoInvestigate({ hasKey: true, checking: false, keyId: 'key-1', keysReady: true })).toBe(true)
  })

  it('走っている最中は重ねて投げない', () => {
    expect(shouldAutoInvestigate({ hasKey: true, checking: true, keyId: 'key-1', keysReady: true })).toBe(false)
  })

  it('キーの識別子が無くても（既定のキー）1回にまとまる', () => {
    expect(shouldAutoInvestigate({ hasKey: true, checking: false, keyId: null, keysReady: true })).toBe(true)
    markAutoInvestigated(null)
    expect(shouldAutoInvestigate({ hasKey: true, checking: false, keyId: null, keysReady: true })).toBe(false)
  })
})

describe('C: ③のボタンは「押さないと進まない」と読ませない', () => {
  it('★ 取得できていれば「🔍 調べる」は出さない（控えめな取り直しだけ残す・検分の指摘12）', () => {
    expect(investigateButtonLabel({ hasKey: true, failed: false, hasSnapshot: true })).toBe('🔄 最新にする')
  })

  it('★ 取得に失敗したら「🔍 調べる」を出す', () => {
    expect(investigateButtonLabel({ hasKey: true, failed: true, hasSnapshot: true })).toBe('🔍 調べる')
    expect(shouldShowInvestigateButton({ hasKey: true, failed: true, hasSnapshot: true })).toBe(true)
  })

  it('★ まだ中身が無いときも「🔍 調べる」を出す（取り直す手段を消さない）', () => {
    expect(investigateButtonLabel({ hasKey: true, failed: false, hasSnapshot: false })).toBe('🔍 調べる')
  })

  it('認証情報が無いときは出さない（次の一手は①のキー登録）', () => {
    expect(investigateButtonLabel({ hasKey: false, failed: true, hasSnapshot: false })).toBeNull()
    expect(shouldShowInvestigateButton({ hasKey: false, failed: true, hasSnapshot: false })).toBe(false)
    expect(shouldShowInvestigateButton({ hasKey: null, failed: true, hasSnapshot: false })).toBe(false)
  })

  it('失敗の判定は4本のどれか1本でも失敗していれば true（1本ずつ確かめる）', () => {
    expect(investigateFailed({})).toBe(false)
    expect(investigateFailed({ limitsError: null, workerError: null, lbError: null, clusterError: null })).toBe(false)
    expect(investigateFailed({ limitsError: '403' })).toBe(true)
    expect(investigateFailed({ workerError: '403' })).toBe(true)
    expect(investigateFailed({ lbError: '403' })).toBe(true)
    expect(investigateFailed({ clusterError: '403' })).toBe(true)
    expect(investigateFailed({ checkError: 'さくらのクラウドAPIキーが未登録です。①で登録してください。' })).toBe(true)
  })
})

describe('C: 画面の配線（自動で投げる・失敗したときだけボタンを出す）', () => {
  it('★ 自動取得の useEffect が shouldAutoInvestigate を通してから investigate() を呼ぶ', () => {
    expect(panel).toContain('if (!shouldAutoInvestigate({ hasKey, checking, keyId: selectedKeyId, keysReady: keysLoaded })) return')
    expect(panel).toContain('markAutoInvestigated(selectedKeyId) // 投げる前に覚える（同じ描画で二重に投げない）')
    expect(panel).toContain('void investigate()')
  })

  it('★ 開き直したら、まず記憶から復元する（③を空のままにしない・検分の指摘1/2/3）', () => {
    expect(panel).toContain('const remembered = recallInvestigateSnapshot(selectedKeyId)')
    expect(panel).toContain('if (remembered) { applySnapshot(remembered); return }')
    // 取れた中身は**モジュール側に**覚える（この画面の state だけに置かない）
    expect(panel).toContain('rememberInvestigateSnapshot(selectedKeyId, {')
    // キーの一覧が確定するまでは、復元も取得もしない（指摘6/11）
    expect(panel).toContain('if (!keysLoaded) return')
    expect(panel).toContain('setKeysLoaded(true)')
  })

  it('★ キーの中身が差し替わったら、③の表示も記憶も捨てる（検分の指摘8）', () => {
    const at = panel.indexOf("window.addEventListener('sakura:credentials-changed', h)")
    expect(at).toBeGreaterThan(0)
    const handler = panel.slice(panel.lastIndexOf('const h = () => {', at), at)
    expect(handler).toContain('clearInvestigateState()')
    expect(handler).toContain('forgetInvestigated()')
    expect(handler).toContain('setKeysLoaded(false)')
  })

  it('★ 自動で走らせるのは③の取得だけ（作る・壊す・公開するを自動で呼んでいない）', () => {
    const at = panel.indexOf('if (!shouldAutoInvestigate(')
    expect(at).toBeGreaterThan(0)
    const effect = panel.slice(at, panel.indexOf('}, [hasKey, selectedKeyId, keysLoaded])', at))
    expect(effect).toContain('void investigate()')
    for (const forbidden of ['doCreate', 'doTeardown', 'doPublish', 'giveConsent']) {
      expect(effect, `③の自動取得から ${forbidden} を呼んでいる`).not.toContain(forbidden)
    }
  })

  it('★ ボタンは shouldShowInvestigateButton が true のときだけ描く', () => {
    expect(panel).toContain('const showInvestigateButton = shouldShowInvestigateButton({ hasKey, failed: fetchFailed, hasSnapshot: hasInvestigateSnapshot })')
    // 見出しも純関数から引く（画面で文言を組み立てない・掟10）
    expect(panel).toContain('const investigateLabel = investigateButtonLabel({ hasKey, failed: fetchFailed, hasSnapshot: hasInvestigateSnapshot })')
    expect(panel).toContain("{checking ? '調べています…' : investigateLabel}")
    expect(panel).toContain('{showInvestigateButton && (')
    // 直す前の形（常にボタンが出ている）に戻っていないこと
    const at = panel.indexOf("<p className=\"text-sm font-semibold text-ink\">③ 使えるプランと制限</p>")
    expect(at).toBeGreaterThan(0)
    const head = panel.slice(at, panel.indexOf('</div>', at))
    expect(head).toContain('{showInvestigateButton && (')
  })

  it('★ 失敗の判定は investigateFailed（純関数）で立てる。取得の**終わり**で立てる', () => {
    expect(panel).toContain('setFetchFailed(investigateFailed({')
    // 取得の始めに false へ戻していない（押し直している最中にボタンが消えるため）
    expect(panel).not.toContain('setFetchFailed(false); setCheckError(null)')
  })

  it('★ 「③で調べるを押してください」と書いた文言が画面に残っていない', () => {
    for (const gone of [
      '③の「🔍 調べる」を押してプランを取得してください。',
      '自由入力です。③の「🔍 調べる」を押すと一覧から選べるようになります。',
      'ワーカプランを選んでください（③で「調べる」を押していない場合は先に押してください）',
      'ロードバランサプランを選んでください（③で「調べる」を押していない場合は先に押してください）',
      '正確な金額は、③の「🔍 調べる」を押すと出せます。',
      '③の「🔍 調べる」でプランを取得すると出せます。',
    ]) {
      expect(panel, `押させる前提の文言が残っている: ${gone}`).not.toContain(gone)
    }
  })
})

describe('C: 自動にしたのは「何も作らず、何も変えない」取得だけ（課金の歯止めは変えない）', () => {
  it('★ ③の説明は「何も作らず、何も変更しません」のまま（自動になっても意味が変わらない）', () => {
    expect(panel).toContain('制限・プラン・既存クラスタの件数をAPIから取得します（何も作らず、何も変更しません）。')
  })

  it('★ 常時課金の一文・④の同意の記録は変わっていない', () => {
    expect(panel).toContain('⚠️ 最小構成でも${s.amountText}の常時課金です（動いていなくても請求されます）。')
    expect(panel).toContain('共用型（さくらのAppRun）は使った分だけの従量課金ですが、専有型は日額・月額の固定費です。')
    // ④の同意（consentedAt の記録）は自動化の対象外
    expect(panel).toContain('await saveMeta({ consentedAt: iso })')
    expect(panel).toContain('const confirmMessage = `${price.text}\\n\\nこの費用が毎月かかります。よろしいですか？`')
  })

  it('★ 作る操作は自動にならない: 確認が no なら create は一度も呼ばれない（振る舞いで固定）', async () => {
    const calls: string[] = []
    const outcome = await runCreate(
      { confirmMessage: '月額 22,000円', spec: { name: 'c1' } },
      {
        confirm: () => false,
        activity: { begin: () => { calls.push('begin'); return () => calls.push('end') } },
        create: async () => { calls.push('create'); return { ok: true } },
      },
    )
    expect(outcome).toEqual({ cancelled: true })
    expect(calls, '同意していないのに作りに行った').toEqual([])
  })

  it('★ 壊す操作も自動にならない: 確認が no なら teardown は一度も呼ばれない', async () => {
    const calls: string[] = []
    const outcome = await runTeardown(
      { confirmMessage: '次を削除します' },
      {
        confirm: () => false,
        activity: { begin: () => { calls.push('begin'); return () => calls.push('end') } },
        teardown: async () => { calls.push('teardown'); return { ok: true } },
      },
    )
    expect(outcome).toEqual({ cancelled: true })
    expect(calls, '同意していないのに壊しに行った').toEqual([])
  })
})
