import { useEffect, useState } from 'react'
import { storageNeedFor, shouldOfferStorage, STORAGE_PORTABLE_NOTE, type PublishTarget, type StorageNeed } from '../../shared/storageNeed'
import { BUCKET_MONTHLY_YEN } from '../../shared/cloudCost'
import { getStorageMode } from './StorageSettings'

// StorageNotice — ③公開で、公開先を選んだときに「データの保存」について知らせる。
//
// ── なぜ公開先の選択と一緒なのか（2026-08-13 Ryosuke 提案）──────────────
// 永続データが要るかは**作っている間に決まる**ので、設定画面で申告させない。
// 書かれたコードから検出し、**公開先を選ぶ瞬間**に伝える。そこで初めて
// 「データが残るかどうか」が決まるため（レンタルサーバなら残る＝費用も要らない）。
//
// **いちばん大事なのは will-lose-data の場合。** AI が自分でファイルに書く
// コードを作ると、コンテナでは書けてしまうので動作確認では正常に見え、
// 再起動や再公開で消える。ここで知らせないと、誰も気づけない。
//
// ── 「用意する」ボタンについて（2026-08-14）────────────────────────────
// ここが**課金の始まる唯一の入口**。押すと(1)サイトの利用開始 (2)バケット作成
// (3)env.json への記録 が一度に起きる。だから**金額を見せてから二度押させる**。
// 記録には `consentedAt` が入り、これが無いバケットは公開時に用意されない
// （src/shared/objectStorage.ts の `consentedBuckets`）。

/** AIに頼む文面。**利用者が読んでから送れるように、入力欄に入れるだけにする。** */
const ASK_AI_TEXT =
  'データの保存を koto-data に切り替えてください。'
  + 'いまファイルに直接書き込んでいる箇所を、import { list, get, save, remove } from \'./koto-data.js\' を使う形に書き直してください。'

type Placement = { bucket: string; prefix: string; shared: boolean }

/** 「新しく作る」を表す選択肢。既存の名前と区別する。 */
const NEW_BUCKET = '\u0000new'

export default function StorageNotice({ projectDir, target, onAskAi }: { projectDir: string | null; target: PublishTarget; onAskAi?: () => void }) {
  const [need, setNeed] = useState<StorageNeed | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  /** いまある保存場所の名前。**すでにあるものを選べば費用は増えない。** */
  const [buckets, setBuckets] = useState<string[]>([])
  const [chosen, setChosen] = useState<string>(NEW_BUCKET)

  useEffect(() => {
    let alive = true
    if (!projectDir) { setNeed(null); return }
    void (async () => {
      const [scan, place] = await Promise.all([
        window.electronAPI.storage.scan(projectDir),
        window.electronAPI.storage.placement(projectDir),
      ])
      if (!alive) return
      if (place.ok) setPlacement(place.placement)
      // 保存場所の一覧も取る。**用意済みの保存場所が実際には無い**ことがあり
      // （名前を消した直後は作り直せない）、そのときは選び直してもらう（2026-08-14）
      try {
        const st = await window.electronAPI.storage.status()
        if (alive && st.ok) {
          const names = st.buckets.map(b => b.name)
          setBuckets(names)
          const current = place.ok && place.placement ? place.placement.bucket : ''
          setChosen(names.includes(current) ? current : (names[0] ?? NEW_BUCKET))
        }
      } catch { /* 取れなくても用意はできる（新しく作る側に倒れる） */ }
      if (!scan.ok) return
      setFiles(scan.writesFiles.slice(0, 3))
      setNeed(storageNeedFor({ usesDataLayer: scan.usesDataLayer, writesFiles: scan.writesFiles.length > 0, target }))
    })()
    return () => { alive = false }
  }, [projectDir, target])

  const prepare = async () => {
    if (!projectDir) return
    setError('')
    setBusy(true)
    try {
      const r = await window.electronAPI.storage.prepare(projectDir, {
        mode: getStorageMode(),
        // 既存を選んでいればそれを使う（**費用は増えない**）。新しく作るときは渡さない
        ...(chosen !== NEW_BUCKET ? { bucket: chosen } : {}),
      })
      if (!r.ok || !r.placement) { setError(r.message ?? '用意できませんでした'); return }
      setPlacement(r.placement)
      setConfirming(false)
      // 同じ③公開の中にある公開パネルへ知らせる。**あちらは画面を開いた時点の
      // 写しで動いている**ので、放っておくと費用の表示も破棄の案内も古いまま
      window.dispatchEvent(new CustomEvent('sakura:storage-prepared'))
      setDone(
        `保存場所『${r.placement.bucket}』を用意しました。`
        + (r.dataLayerPlaced ? 'koto-data.js もプロジェクトに置きました。' : '')
        + '次に公開すると、アプリから読み書きできるようになります。',
      )
    } finally { setBusy(false) }
  }

  // 記録にある保存場所が、実際に存在するか（一覧が取れているときだけ判断する）
  const missing = !!placement && buckets.length > 0 && !buckets.includes(placement.bucket)

  if (!need || need.kind === 'none') return null

  // 追加費用の要らない公開先では、安心材料として軽く出すだけにする
  if (need.kind === 'target-provides') {
    return (
      <div className="rounded-xl border border-line bg-surface p-3">
        <p className="text-xs text-ink-secondary leading-relaxed">💾 {need.note}</p>
      </div>
    )
  }

  const warn = need.kind === 'will-lose-data'
  return (
    <div className={`rounded-xl border p-4 space-y-2 ${warn && !placement ? 'border-brand-yellow/70 bg-surface' : 'border-line bg-surface'}`}>
      <p className="text-sm font-semibold text-ink">
        {placement ? '💾 データの保存（用意済み）' : warn ? '⚠️ データが消えてしまいます' : '💾 データの保存について'}
      </p>
      <p className="text-xs text-ink-secondary leading-relaxed select-text">{need.note}</p>

      {warn && files.length > 0 && (
        <p className="text-[11px] text-ink-muted leading-relaxed select-text">
          ファイルに書き込んでいる箇所: {files.join('、')}
        </p>
      )}

      {/* 用意済み: いまどこに保存されるのかを示す。**費用は増えない**ことも伝える */}
      {placement ? (
        <div className={`rounded-lg border p-3 space-y-1 ${missing ? 'border-brand-yellow/70' : 'border-line'}`}>
          <p className="text-xs text-ink leading-relaxed select-text">
            保存場所: <span className="font-semibold">{placement.bucket}</span>
            <span className="text-ink-muted">　{placement.shared ? '（ほかのプロジェクトと共有）' : '（このプロジェクト専用）'}</span>
          </p>
          {/* **記録はあるが実在しない**ことがある（削除した名前は作り直せない） */}
          {missing && (
            <p className="text-[11px] text-brand-yellow leading-relaxed select-text">
              ⚠️ この保存場所は見つかりません。削除した直後は、同じ名前で作り直せないことがあります。
              下から選び直してください。
            </p>
          )}
          <p className="text-[11px] text-ink-muted leading-relaxed select-text">
            このプロジェクトのデータは {placement.prefix} の下に入ります。公開しても追加の費用はかかりません。
          </p>
          <p className="text-[11px] text-ink-muted leading-relaxed">{STORAGE_PORTABLE_NOTE}</p>
        </div>
      ) : (
        <div className="rounded-lg border border-line p-3 space-y-1">
          <p className="text-xs text-ink leading-relaxed">
            保存場所を用意すると、公開したあともデータが残ります。
            <span className="font-semibold">月額{BUCKET_MONTHLY_YEN}円（税込）</span>がかかります。
          </p>
          <p className="text-[11px] text-ink-muted leading-relaxed">
            すでに保存場所がある場合、追加の費用はかかりません（ほかのプロジェクトと共有します）。
          </p>
          <p className="text-[11px] text-ink-muted leading-relaxed">{STORAGE_PORTABLE_NOTE}</p>
        </div>
      )}

      {/* 用意する。**課金の始まる操作なので、金額を見せてから二度押させる** */}
      {(!placement || missing) && shouldOfferStorage(need) && (
        confirming ? (
          <div className="rounded-lg border border-brand-yellow/70 p-3 space-y-2">
            <p className="text-xs text-ink leading-relaxed">
              保存場所を用意します。すでにある場合はそれを使うので費用は増えません。
              新しく作る場合は<span className="font-semibold">月額{BUCKET_MONTHLY_YEN}円（税込）</span>がかかります（日割はありません）。
            </p>
            {/* **すでにある保存場所を選べば費用は増えない。** 既定でそちらを選んでおく */}
            {buckets.length > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] font-semibold text-ink-secondary">どこに保存しますか</p>
                {buckets.map(b => (
                  <label key={b} className="flex items-center gap-2 text-xs text-ink cursor-pointer">
                    <input type="radio" name="koto-bucket" checked={chosen === b} onChange={() => setChosen(b)} />
                    <span className="font-mono">{b}</span>
                    <span className="text-[11px] text-ink-muted">すでにあります（費用は増えません）</span>
                  </label>
                ))}
                <label className="flex items-center gap-2 text-xs text-ink cursor-pointer">
                  <input type="radio" name="koto-bucket" checked={chosen === NEW_BUCKET} onChange={() => setChosen(NEW_BUCKET)} />
                  <span>新しく作る</span>
                  <span className="text-[11px] text-brand-yellow">月額{BUCKET_MONTHLY_YEN}円が増えます</span>
                </label>
              </div>
            )}
            <p className="text-[11px] text-ink-muted leading-relaxed">
              共有／専用の既定は「設定 → データの保存」で変えられます（いまは
              {getStorageMode() === 'dedicated' ? 'プロジェクトごとに分ける' : 'まとめて保存'}）。
            </p>
            <div className="flex gap-2">
              <button
                onClick={prepare}
                disabled={busy}
                className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-40"
              >{busy ? '用意しています…' : '用意する（費用に同意）'}</button>
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura disabled:opacity-40"
              >やめる</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => { setError(''); setConfirming(true) }}
            className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura hover:text-sakura"
          >{missing ? '保存場所を選び直す…' : '保存場所を用意する…'}</button>
        )
      )}

      {done && <p className="text-[11px] text-ink-secondary leading-relaxed select-text">✅ {done}</p>}
      {error && <p className="text-[11px] text-brand-red leading-relaxed select-text">⚠️ {error}</p>}

      {warn && (
        <div className="space-y-1">
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('sakura:ask-ai', { detail: { text: ASK_AI_TEXT } }))
              onAskAi?.()
            }}
            className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90"
          >AIに書き直してもらう</button>
          <p className="text-[11px] text-ink-muted leading-relaxed">
            チャットに文面が入ります。内容を確かめてから送信してください。
          </p>
        </div>
      )}
    </div>
  )
}
