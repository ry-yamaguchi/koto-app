import { useEffect, useState } from 'react'
import { storageNeedFor, shouldOfferStorage, STORAGE_PORTABLE_NOTE, type PublishTarget, type StorageNeed } from '../../shared/storageNeed'
import {
  askAiRewritePlan, rewriteCheckLine, storageNoticeHeadline, describeWriteSite,
  storagePreparedText, STORAGE_REWRITE_REMAINING,
} from '../../shared/storageNoticeText'
import type { FileWriteSite } from '../../shared/objectStorage'
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

// AIに頼む文面と、**そもそも送ってよいか**の判断は `askAiRewritePlan`
// （src/shared/storageNoticeText.ts）が持つ。
// **Koto が見つけた場所（どのファイルの何行目か）を必ず入れる**（2026-09-23）。
// ここに文面を書き戻さないこと——画面と依頼文で言うことがずれる。

type Placement = { bucket: string; prefix: string; shared: boolean }

/** 「新しく作る」を表す選択肢。既存の名前と区別する。 */
const NEW_BUCKET = '\u0000new'

export default function StorageNotice({ projectDir, target, onAskAi }: { projectDir: string | null; target: PublishTarget; onAskAi?: () => void }) {
  const [need, setNeed] = useState<StorageNeed | null>(null)
  /** ファイルに書き込んでいる場所。**画面にも AI への依頼文にも、ここから出す。** */
  const [files, setFiles] = useState<FileWriteSite[]>([])
  /** 「書き直せたか確かめる」の結果（1行）。**押すまでは何も出さない。** */
  const [checkLine, setCheckLine] = useState('')
  const [checking, setChecking] = useState(false)
  /** 「AIに書き直してもらう」を押してから、文面を送るまで。 */
  const [asking, setAsking] = useState(false)
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
      setFiles(scan.writesFiles)
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
      // 文面は純関数に任せる。**ファイル名を画面に書き写さない**
      // （require のアプリでは koto-data.cjs が置かれる・2026-09-23 検分）
      setDone(storagePreparedText(r.placement.bucket, r.dataLayerPlaced === true, r.dataLayerFile))
    } finally { setBusy(false) }
  }

  /**
   * 「書き直せたか確かめる」。**押した瞬間に1回だけ調べ直す。**
   *
   * ── なぜ要るか（2026-09-23 実機）──────────────────────────────────
   * これが無いと、AI の「完了しました」と画面の「まだです」の間で利用者が
   * 立ち往生する（画面を閉じて開き直すまで調べ直されなかった）。
   * **調べ直したのに画面が古いままでは意味がない**ので、`need` と `files` も
   * 新しい結果で更新する。
   */
  const recheck = async () => {
    if (!projectDir || checking) return
    setChecking(true)
    try {
      const scan = await window.electronAPI.storage.scan(projectDir)
      if (!scan.ok || !Array.isArray(scan.writesFiles)) {
        // **「済んだ」にも「まだ」にも倒さない。** 調べられなかっただけである
        setCheckLine(rewriteCheckLine(null))
        return
      }
      setFiles(scan.writesFiles)
      setNeed(storageNeedFor({ usesDataLayer: scan.usesDataLayer, writesFiles: scan.writesFiles.length > 0, target }))
      // **打ち切りの有無も渡す。** 渡さないと「調べていない」が「済んだ」になる
      setCheckLine(rewriteCheckLine({
        usesDataLayer: scan.usesDataLayer,
        writesFiles: scan.writesFiles,
        truncated: scan.truncated === true,
      }))
    } catch {
      setCheckLine(rewriteCheckLine(null))
    } finally { setChecking(false) }
  }

  /**
   * 「AIに書き直してもらう」。**文面を送る前に、読み込み先を必ず用意する。**
   *
   * ── なぜ先に用意するのか（2026-09-23 実機・アプリが起動しなくなった）──────
   * これが無いと、koto-data のファイルが**存在しないまま**「このファイルから
   * 読み込む形に書き直して」と頼むことになる。AI は完了できず、3回にわたって
   * 「完了しました」と答え、実物は変わらなかった。しかも読み込めるようにしようと
   * package.json を書き換え、**アプリが起動しなくなった**。
   *
   * **用意できなければ、文面は送らない。** 送れば必ず失敗する頼みごとになる。
   * 送る・送らないの判断は `askAiRewritePlan`（純関数）に集めてある。
   */
  const askAi = async () => {
    if (!projectDir || asking) return
    setAsking(true)
    setError('')
    try {
      let layer: Awaited<ReturnType<typeof window.electronAPI.storage.ensureLayer>> | null = null
      try { layer = await window.electronAPI.storage.ensureLayer(projectDir) } catch { layer = null }
      const plan = askAiRewritePlan(files, layer)
      if (!plan.send) { setError(plan.error); return }
      // **Koto が見つけた場所と、実際に置いたファイルに合わせた書き方を渡す。**
      // 渡さないと AI は自分の記憶で答え、「完了しました」と言い切る
      window.dispatchEvent(new CustomEvent('sakura:ask-ai', { detail: { text: plan.text } }))
      onAskAi?.()
    } finally { setAsking(false) }
  }

  // 記録にある保存場所が、実際に存在するか（一覧が取れているときだけ判断する）
  const missing = !!placement && buckets.length > 0 && !buckets.includes(placement.bucket)

  if (!need || need.kind === 'none') {
    // 「書き直せたか確かめる」を押した直後に問題が消えることがある。
    // **結果だけは残して見せる**（枠ごと消えると、押した人には何も伝わらない）
    return checkLine ? (
      <div className="rounded-xl border border-line bg-surface p-3">
        <p className="text-xs text-ink-secondary leading-relaxed select-text">{checkLine}</p>
      </div>
    ) : null
  }

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
        {storageNoticeHeadline({ hasPlacement: !!placement, warn })}
      </p>
      {/* **保存場所はできたが、書き直しが残っている。** 残りの作業を1行で示す */}
      {placement && warn && (
        <p className="text-xs text-ink leading-relaxed select-text">{STORAGE_REWRITE_REMAINING}</p>
      )}
      <p className="text-xs text-ink-secondary leading-relaxed select-text">{need.note}</p>

      {warn && files.length > 0 && (
        <p className="text-[11px] text-ink-muted leading-relaxed select-text">
          ファイルに書き込んでいる箇所: {files.slice(0, 3).map(describeWriteSite).join('、')}
          {files.length > 3 ? `、ほか${files.length - 3}件` : ''}
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
          <div className="flex gap-2">
            <button
              onClick={() => { void askAi() }}
              disabled={asking}
              className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-40"
            >{asking ? '準備しています…' : 'AIに書き直してもらう'}</button>
            {/* **押した瞬間に1回だけ調べ直す。** AI の「完了しました」を確かめる手段 */}
            <button
              onClick={() => { void recheck() }}
              disabled={checking}
              className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura hover:text-sakura disabled:opacity-40"
            >{checking ? '確かめています…' : '🔎 書き直せたか確かめる'}</button>
          </div>
          <p className="text-[11px] text-ink-muted leading-relaxed">
            チャットに文面が入ります。内容を確かめてから送信してください。
            書き直してもらったあとは「🔎 書き直せたか確かめる」で、実際に直ったかを調べられます。
          </p>
        </div>
      )}

      {/* 調べ直した結果。**warn が消えたあとも残す**（押した人に結果が届くように） */}
      {checkLine && (
        <p className="text-[11px] text-ink-secondary leading-relaxed select-text">{checkLine}</p>
      )}
    </div>
  )
}
