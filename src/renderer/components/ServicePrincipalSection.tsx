import { useEffect, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react'
import CopyButton from './CopyButton'
import ServicePrincipalPicker from './ServicePrincipalPicker'
import { resourceIdFormatOk, type ServicePrincipalCandidate } from '../../shared/servicePrincipalCandidates'
import { resolveServicePrincipalPrefill } from '../servicePrincipalCandidates'
import { saveAndReport } from '../../shared/saveIfChanged'

// AppRun 専有型 手順2「サービスプリンシパルの用意」の節（AppRunDedicatedPanel.tsx から切り出した・2026-10-07）。
//
// AppRunDedicatedPanel.tsx は 3,000 行を超える巨大ファイルなので、触った節は 400 行以下のモジュールへ切り出す
// （CLAUDE.md「調査のしかた」・2026-09-30 作者決定）。この節の見出し・入力欄・詳しい手順（A/B）・説明の JSX と、
// この節だけが使う状態・ハンドラ（欄の値・保存・候補・保存失敗の知らせ）はここにある。
//
// ── 値の持ち主は `useServicePrincipal` の1つだけ（掟10: 同じ値を2か所で持たない）─────────────
// 欄の値（resourceId）は、この節のほかに、パネルの入力の検査（computeDedicatedFormErrors）・手順5の作成（spec）・
// 手順5の表示「サービスプリンシパルID」・手順5の作成の入口の保存、が使う。そこで状態はこのフックが持ち、
// パネルは**フックを1回呼んで**、その結果（`sp`）を (1)この節（`<ServicePrincipalSection sp={sp} />`）と
// (2)自分の使う分（resourceId・saveResourceId・idSaveWarning）へ配る。パネルに写しを持たない。
//
// ── 保存の入口は3つだけ（どれも saveResourceId を通す）────────────────────────────────────
// 欄を離れたとき（欄の onBlur）・候補を選んだとき（pickServicePrincipal）・手順5でクラスタを作るとき
// （パネルの doCreate の create）。**開いただけ（初期化の useEffect）では何も書かない**
// （開いただけで書くと 'sakura-meta-changed' → 状態の取り直しが走る・2026-09-23 検分の指摘6）。
// tests/servicePrincipalPanelWiring.test.ts が、呼び出し元がこの3つだけであること・
// どの useEffect からも書く道具を呼ばないことを構文木で固定している。

/** 手順2で選ぶロール名（コピーできる形で出す）。手順2でしか使わないので、ここに置く。 */
const ROLE_TEXT = 'さくらのクラウド > 作成・削除'
/** さくらのクラウドのコントロールパネル。手順2の「コントロールパネルを開く」と、パネルの手順6・8の同じリンクが共有する（唯一の定義）。 */
export const CONTROL_PANEL_URL = 'https://secure.sakura.ad.jp/cloud/'

/** 記録へ書く道具（パネルの saveMeta）。手順2が書いてよいのはサービスプリンシパルIDだけ。 */
type SaveServicePrincipalMeta = (patch: { servicePrincipalId: string }) => Promise<unknown>

/** パネルが `useServicePrincipal` から受け取り、そのまま節へ渡す状態とハンドラ。 */
export interface ServicePrincipalState {
  /** 欄にいま入っている値（記録から読んだ・候補から入れた・打った、のどれも）。 */
  resourceId: string
  setResourceId: Dispatch<SetStateAction<string>>
  /** 記録へ保存する（欄を離れたとき・候補を選んだとき・手順5で作るとき）。失敗は投げず、idSaveWarning に出す。 */
  saveResourceId: (v: string) => Promise<void>
  /** 保存に失敗したときの知らせ（手順2の欄の下と、手順5の作成ボタンの下に出す）。失敗していなければ null。 */
  idSaveWarning: ReactNode
  /** 前のプロジェクトで使った ID の候補（記録に ID が無いときだけ入る）。 */
  spCandidates: ServicePrincipalCandidate[]
  resourceInputRef: RefObject<HTMLInputElement>
  pickServicePrincipal: (id: string) => Promise<void>
  pickManualServicePrincipal: () => void
}

export function useServicePrincipal(
  projectDir: string,
  readMeta: () => Promise<any>,
  saveMeta: SaveServicePrincipalMeta,
): ServicePrincipalState {
  const [resourceId, setResourceId] = useState('')
  // 最後にディスクへ書いた（か、ディスクから読んだ）値。手順2の欄は onBlur で保存するので、
  // これが無いと「クリックして何も直さずに外へ出ただけ」でファイル書き込み →
  // 'sakura-meta-changed' → refreshAppStatus → GET /clusters/{id} が1本飛び、
  // 手順8「公開中: …」が触っていないのに一瞬消えて出し直される（2026-09-23 検分の指摘6）。
  const savedResourceIdRef = useRef('')
  // いま開いているプロジェクト。保存の結果が戻ってきたとき、それを始めたプロジェクトのままかを見分ける
  // （切り替えたあとに、前のプロジェクトの保存の失敗を新しいプロジェクトの画面に出さない・掟11）。
  const projectDirRef = useRef(projectDir)
  projectDirRef.current = projectDir
  // 保存に失敗したときの知らせ（手順2の欄の下と、手順5の作成ボタンの下に出す）。null＝失敗していない。
  const [idSaveError, setIdSaveError] = useState<string | null>(null)
  // 書く・書かない・失敗したら戻す・別のプロジェクトへ移っていたら何もしない、の判断は saveAndReport
  // （src/shared/saveIfChanged.ts・振る舞いのテストあり）。
  //   ・値が変わっていなければ書かない（クラウドGETも起こさない・指摘6）
  //   ・書けなかったら「保存済み」の印を元へ戻す（戻さないと、以後の保存が「変わっていない」として書かれず、
  //     自動で入れた ID が作成のあとも記録に残らない・2026-10-06 検分の指摘）。次の保存でもう一度書こうとする。
  //   ・**保存を始めたプロジェクトから離れていたら**、知らせも印も触らない（2026-10-07 検分の指摘・掟11）。
  // 失敗は**ここで受け止めて画面に出す**（投げ直さない）。欄を離れる・候補を選ぶ・手順5で作る、のどの入口も
  // 保存の失敗で止まらない（ID の記録は便宜で、作る条件ではない）が、失敗したことは黙らない。
  const saveResourceId = async (v: string) => {
    const startedIn = projectDir // この保存を始めたプロジェクト
    const r = await saveAndReport(
      savedResourceIdRef, v, id => saveMeta({ servicePrincipalId: id }),
      () => projectDirRef.current !== startedIn,
    )
    if (!r.stale) setIdSaveError(r.error)
  }
  const idSaveWarning = idSaveError ? (
    <p className="text-[11px] text-brand-yellow leading-relaxed select-text">
      ⚠️ このサービスプリンシパルIDを Koto の記録に残せませんでした（{idSaveError}）。クラスタの作成はそのまま進められます。
      次のプロジェクトで自動で入れるには、欄から一度離れるか、候補を選び直してください。
    </p>
  ) : null
  // 前のプロジェクトで使った ID の候補（2026-10-06・作者の決定）。**このプロジェクトの記録に ID が無いときだけ**
  // 初期化（下の useEffect）が入れる。候補を欄へ自動で入れても**ファイルへは書かない**（上の「保存の入口は3つだけ」）。
  const [spCandidates, setSpCandidates] = useState<ServicePrincipalCandidate[]>([])
  const resourceInputRef = useRef<HTMLInputElement>(null)
  const pickServicePrincipal = async (id: string) => {
    setResourceId(id)
    await saveResourceId(id)
  }
  const pickManualServicePrincipal = () => {
    setResourceId('')
    resourceInputRef.current?.focus()
  }

  // 初期化（プロジェクトが切り替わったときも走る）
  useEffect(() => {
    // 前のプロジェクトの候補を持ち越さない（掟11。読み終えるまでは「候補なし」）。保存失敗の知らせも持ち越さない。
    setSpCandidates([])
    setIdSaveError(null)
    // プロジェクトが切り替わったあとに、前のプロジェクトの読み取りが戻ってきて欄を上書きしない。
    let cancelled = false
    ;(async () => {
      const m = await readMeta()
      if (cancelled) return
      const v = m.publish?.apprunDedicated
      const savedId = typeof v?.servicePrincipalId === 'string' ? v.servicePrincipalId : ''
      setResourceId(savedId)
      savedResourceIdRef.current = savedId // ディスクの値＝「書いたのと同じ」として覚えておく（指摘6）
      // このプロジェクトの記録に ID が無いときだけ、前のプロジェクトで使った ID を探す（読むだけ・書かない。
      // 記録に ID があれば、ほかの記録は読みにも行かず、候補は空のまま）。
      const plan = await resolveServicePrincipalPrefill(projectDir, savedId)
      if (cancelled) return
      setSpCandidates(plan.candidates)
      // 読んでいる間に利用者が打ち始めていたら、その入力を消さない（空のときだけ入れる）。
      const fillId = plan.fillId
      if (fillId) setResourceId(cur => (cur.trim() ? cur : fillId))
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir])

  return {
    resourceId, setResourceId, saveResourceId, idSaveWarning,
    spCandidates, resourceInputRef, pickServicePrincipal, pickManualServicePrincipal,
  }
}

interface Props {
  sp: ServicePrincipalState
  /** 欄を打ったとき（パネルの「触った」印 touch('resourceId')。手順5の「足りないもの」の出し方に使う）。 */
  onEdit: () => void
}

export default function ServicePrincipalSection({ sp, onEdit }: Props) {
  const {
    resourceId, setResourceId, saveResourceId, idSaveWarning,
    spCandidates, resourceInputRef, pickServicePrincipal, pickManualServicePrincipal,
  } = sp
  const idFormat = resourceIdFormatOk(resourceId)
  // 手順2 サービスプリンシパルの用意（最初の一度だけ・手作業）
  return (
    <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
      <p className="text-sm font-semibold text-ink">手順2 サービスプリンシパルの用意（最初の一度だけ手作業）</p>

      {/* 既定で見えるのは入力欄と1行の説明だけ（判断7・利用者目線レビュー・2026-09-11）。
          (A)/(B)（5ステップ）は初心者には情報量が多いので「詳しい手順を見る」で畳む。 */}
      <div className="space-y-1">
        <label className="text-[11px] font-medium text-ink-secondary">サービスプリンシパルのリソースID（12桁）</label>
        <input
          ref={resourceInputRef}
          value={resourceId}
          onChange={e => { setResourceId(e.target.value); onEdit() }}
          onBlur={() => saveResourceId(resourceId.trim())}
          placeholder="例: 111111111111"
          className="w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink font-mono outline-none focus:border-sakura"
        />
        {idFormat === true && <p className="text-[11px] text-brand-green font-semibold">✓ 形は合っています（12桁の数字）</p>}
        {idFormat === false && <p className="text-[11px] text-brand-yellow font-semibold">⚠️ 違うようです（12桁の数字ではありません）</p>}
        {/* 前のプロジェクトで使った ID（記録に ID が無いときだけ候補が入る）と「新しく作る」リンク */}
        <ServicePrincipalPicker
          candidates={spCandidates}
          value={resourceId}
          onPick={pickServicePrincipal}
          onPickManual={pickManualServicePrincipal}
        />
        {idSaveWarning}
        <p className="text-[11px] text-ink-muted leading-relaxed">
          コントロールパネルで一度だけ作ります。作り方は「詳しい手順を見る」。
        </p>
      </div>

      <details className="rounded-lg border border-line bg-overlay p-3 space-y-3">
        <summary className="cursor-pointer select-none text-xs font-semibold text-ink-secondary hover:text-ink">詳しい手順を見る</summary>
        <div className="mt-2 space-y-3">
          <p className="text-xs text-ink-secondary leading-relaxed">
            専有型のクラスタを作るには「サービスプリンシパル」が要りますが、<b className="text-ink">これは Koto からは作れません</b>。
            作成に使う IAM API は、通常のAPIキーでは使えない設計のためです（実測で権限エラー）。
            さくら側のサービスプリンシパルは使い回せます（さくらのクラウドの「プロジェクト」のリソースで、Koto のプロジェクトとは別のものです。
            同じものでクラスタを2回作れたことを確かめています）。
            前のプロジェクトで使った ID があれば、ここに入れておきます。
          </p>
          <a
            href={CONTROL_PANEL_URL}
            className="inline-block bg-overlay text-ink border border-line rounded-lg px-3 py-2 text-sm font-medium hover:border-sakura"
          >🔧 コントロールパネルを開く</a>

          <div className="space-y-1">
            <p className="text-[11px] font-semibold text-ink-secondary">(A) サービスプリンシパルを作る</p>
            <ol className="list-decimal pl-4 space-y-1 text-xs text-ink-secondary leading-relaxed">
              <li>コントロールパネルの左メニュー「サービスプリンシパル」を開く</li>
              <li>「サービスプリンシパルの作成」→ 名前と説明を入れて作成</li>
              <li>作成後に表示される「リソースID」を控える（これを下に貼る）</li>
            </ol>
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-semibold text-ink-secondary">(B) そのサービスプリンシパルにロールを付ける</p>
            {/* 2026-09-07 Ryosuke さん指摘で削った2行:
                「リソース階層名」「リソース階層タイプ」を"確かめる"手順を入れていたが、
                この2つは**入力欄ではなく、選んだプロジェクトが表示されるだけの読み取り専用**。
                操作できないものを手順に立てるのは、ただの水増しだった。
                検分が「4欄すべてを名指ししていない」と指摘したのを、
                **その欄が操作できるものかを確かめずに**受け入れたのが原因。
                入力するのは「プリンシパル」と「ロール」の2つだけ。 */}
            <ol start={4} className="list-decimal pl-4 space-y-1 text-xs text-ink-secondary leading-relaxed">
              <li>左メニュー「IAMポリシー」を開き、画面右上で対象のプロジェクトを選ぶ</li>
              <li>右上の「アクセス権の付与」を押す</li>
              <li>「プリンシパル」欄で、(A)で作ったサービスプリンシパルを選ぶ</li>
              <li>「ロール」欄で「{ROLE_TEXT}」を選ぶ</li>
              <li>「作成」を押す（反映まで最大3分）</li>
            </ol>
            <p className="text-[11px] text-ink-muted leading-relaxed">
              ※「リソース階層名」「リソース階層タイプ」は、選んだプロジェクトが表示されるだけの欄です（ここでは変更しません）。
              組織やフォルダ単位でも付けられますが、<b className="text-ink-secondary">サービスプリンシパルにはプロジェクト単位で付けるのが確実</b>です
              （上位で付けた権限は、サービスプリンシパルの制約で効かないことがあると公式に明記されています）。
            </p>
          </div>

          <div className="rounded-lg border border-brand-yellow/70 bg-overlay p-3 space-y-1">
            <p className="text-[11px] font-semibold text-brand-yellow leading-relaxed">
              ⚠️ プリンシパル欄に「ロール名」を入れないでください。
            </p>
            <p className="text-[11px] text-ink-secondary leading-relaxed">
              プリンシパル欄で選ぶのは、(A)で作った<b className="text-ink">サービスプリンシパル</b>です。
              「{ROLE_TEXT}」は<b className="text-ink">ロールの名前</b>で、<b className="text-ink">ロール欄</b>で選びます。
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-medium text-ink-secondary">ロール欄で選ぶもの</p>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-overlay px-3 py-2">
              <code className="flex-1 text-xs text-ink font-mono select-text">{ROLE_TEXT}</code>
              <CopyButton text={ROLE_TEXT} title="ロール名をコピー（プリンシパル欄ではなくロール欄で使います）" />
            </div>
          </div>

          <p className="text-[11px] text-ink-muted leading-relaxed">
            ※ 確認できるのは文字数の形式だけです。存在するかどうかはここでは確認できません（IAM APIが使えないため）。実際にクラスタを作る段階になって初めて分かります。
          </p>
        </div>
      </details>
    </section>
  )
}
