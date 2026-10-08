import { useEffect, useState } from 'react'
import { storageNeedForScan, memorySitesFor, memorySitesNotWarned, shouldOfferStorage, STORAGE_PORTABLE_NOTE, type PublishTarget, type StorageNeed } from '../../shared/storageNeed'
import {
  askAiRewritePlan, rewriteCheckLine, rewriteCheckDone, storageNoticeHeadline, describeWriteSite,
  storagePreparedText, dataLayerUpdateLine, STORAGE_REWRITE_REMAINING, STORAGE_REWRITE_MAYBE_REMAINING,
} from '../../shared/storageNoticeText'
import {
  shouldAskLeftoverData, shouldLookForLeftoverData, askAiMoveDataPlan, leftoverScanLine,
  leftoverDataAnsweredKey,
  LEFTOVER_DATA_HEADING, LEFTOVER_DATA_MOVE_LABEL, LEFTOVER_DATA_MOVE_NOTE,
  LEFTOVER_DATA_SKIP_LABEL, LEFTOVER_DATA_SKIP_NOTE,
  LEFTOVER_DATA_ASK_AI_NOTE, LEFTOVER_DATA_SKIP_LATER_NOTE, type LeftoverDataFile,
} from '../../shared/leftoverData'
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

// 「💾 いま入っているデータをどうしますか」に答えたかどうかを覚えておく（プロジェクトごと）。
// **選んだあとは出し直さない**（毎回聞かれると鬱陶しい）。覚えられなくても動きは同じで、
// もう一度聞かれるだけなので、読み書きは失敗しても黙って続ける。
function readLeftoverAnswered(projectDir: string | null): boolean {
  if (!projectDir) return false
  try { return localStorage.getItem(leftoverDataAnsweredKey(projectDir)) === '1' } catch { return false }
}
function rememberLeftoverAnswered(projectDir: string | null): void {
  if (!projectDir) return
  try { localStorage.setItem(leftoverDataAnsweredKey(projectDir), '1') } catch { /* 覚えられなくても困らない */ }
}

// ── koto-data の版についての1行を、画面が閉じても残す（2026-09-25 検分の指摘15）──────
//
// 「AIに書き直してもらう」は、押すと `onAskAi` で**③公開のモーダルごと閉じる**
// （PublishModal が onClose を渡している）。そのため `setCheckLine(updateLine)` に入れた
// 「🔄 差し替えました／ℹ️ そのままにしました」は、**描き直される前に画面が消え**、
// state はモーダルの作り直しで空に戻る——利用者は一度も読めない。
// 「Koto は触っていません」と伝える唯一の口が塞がっていると、
// 「直したのに直っていない」が原因の分からない形で残る。
//
// そこでプロジェクトごとに覚えて、**次に③公開を開いたときに出す**。
// 覚えられなくても動きは同じ（その回に出ないだけ）なので、読み書きは失敗しても黙って続ける。
//
// ── ⚠️ 覚えた1行には「いつの話か」を必ず付ける（2026-09-25 検分の指摘17）──────────
// この1行は過去形の記録に見えて、末尾は「入れ替えてよいか分からないときは、Koto に
// 相談してください」という**いま何をすべきかの指示**である。ところが koto-data を
// 差し替えるのは③公開の画面だけではない——⑤公開の途中で main も差し替える
// （src/main/ipc/apprunDedicated.ts・src/main/ipc/vercel.ts）。時点も期限も持たずに
// 覚えたままだと、**もう当てはまらないことを画面が断定し続ける**。
//
// そこで ①覚えるときに時点も一緒に持ち ②出すときに「いつ調べた話か」を添え
// ③古くなったら黙る（DATA_LAYER_LINE_MAX_AGE_MS）。あわせて ensureLayer を呼ぶ経路は
// **通るたびに上書きする**（rememberLayerLine）ので、その場で分かった分は必ず新しくなる。

/** 「koto-data を差し替えた／触れなかった」の1行を覚えておくキー（プロジェクトごと）。 */
export function dataLayerLineKey(projectDir: string): string {
  return `koto_data_layer_line:${projectDir}`
}

/** 覚えてある1行と、それが分かった時点。**時点の無い記録は出さない。** */
export type DataLayerNote = { line: string; at: number }

/**
 * 覚えた1行を出してよい期間（1日）。
 *
 * 時点を添えても、**古い指示が出続けること自体**は止まらない。公開のたびに main が
 * koto-data を差し替えることがあるので、1日たった記録に「いま何をすべきか」を言う
 * 資格は無いと見なして黙る。知りたければ「AIに書き直してもらう」「一緒に移してもらう」で
 * もう一度 ensureLayer を通り、そのときの結果で上書きされる。
 */
export const DATA_LAYER_LINE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * 覚えてある1行を読む。**時点が無いもの・古すぎるものは返さない**（いつの話か言えない）。
 *
 * 時点を持たない古い形（1行をそのまま入れていた版）は、いつの話か分からないので捨てる。
 */
export function readDataLayerNote(projectDir: string | null, now: number = Date.now()): DataLayerNote | null {
  if (!projectDir) return null
  let raw: string | null = null
  try { raw = localStorage.getItem(dataLayerLineKey(projectDir)) } catch { return null }
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const line = (parsed as { line?: unknown }).line
  const at = Number((parsed as { at?: unknown }).at)
  if (typeof line !== 'string' || line.length === 0) return null
  if (!Number.isFinite(at)) return null
  if (now - at > DATA_LAYER_LINE_MAX_AGE_MS) return null
  return { line, at }
}

/** 「9月25日 14:30」の形（**素のテキスト**・掟5）。 */
function dataLayerNoteWhen(at: number): string {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${two(d.getHours())}:${two(d.getMinutes())}`
}

/**
 * 覚えてある1行を、画面に出す形にする（純関数）。**いつ調べた話かを必ず添える。**
 *
 * 添えないと「いま koto-data がどうなっているか」の断定に読める（指摘17）。
 * そのあと公開すれば main が差し替えることがある、というところまで書く。
 */
export function dataLayerNoteText(note: DataLayerNote | null | undefined): string {
  if (!note || typeof note.line !== 'string' || note.line.length === 0) return ''
  if (!Number.isFinite(note.at)) return ''
  return `${note.line}（${dataLayerNoteWhen(note.at)} に調べたときの記録です。`
    + 'そのあとに公開すると、Koto が新しい版へ差し替えることがあります。）'
}

/** 覚えてある1行を、そのまま画面に出せる形で読む（時点つき。無ければ空文字）。 */
export function readDataLayerLine(projectDir: string | null, now: number = Date.now()): string {
  return dataLayerNoteText(readDataLayerNote(projectDir, now))
}

/** 空文字を渡すと消す（次に頼んだときは、そのときの結果で上書きする）。 */
export function rememberDataLayerLine(projectDir: string | null, line: string, at: number = Date.now()): void {
  if (!projectDir) return
  try {
    if (line) localStorage.setItem(dataLayerLineKey(projectDir), JSON.stringify({ line, at }))
    else localStorage.removeItem(dataLayerLineKey(projectDir))
  } catch { /* 覚えられなくても、その回に出ないだけ */ }
}

/**
 * 「用意する（費用に同意）」の戻りを、画面に出す行へ直す（純関数・掟10でここ1か所）。
 *
 * ── なぜ純関数にするか（2026-09-25 検分の指摘9・14）────────────────────
 * main は目印（.koto-keep）を置けなかったときに `markerNote` を返していたのに、
 * **画面がそれを一度も読んでいなかった**。目印が無いと、用意しただけでまだ何も
 * 保存していないプロジェクトはバケットの一覧に現れず、同じ保存場所を共有する別の
 * プロジェクトを⑥で破棄したときに `teardownPlanFor` が「ほかに使っている人はいない」と
 * 判断して**バケットごと消す**。「✅ 用意しました」だけ出して警告を捨てる形は、
 * 事故のあとに手がかりを1つも残さない。**落とさないことをテストで固定できる形**にする。
 */
export type StoragePrepareLines = { error: string; done: string; warn: string }

export function storagePrepareLines(r: {
  ok?: boolean
  placement?: { bucket: string; prefix: string; shared: boolean } | null
  dataLayerPlaced?: boolean
  dataLayerFile?: string | null
  markerNote?: string
  message?: string
} | null | undefined): StoragePrepareLines {
  if (!r || r.ok !== true || !r.placement) {
    const message = r && typeof r.message === 'string' && r.message.length > 0 ? r.message : '用意できませんでした'
    return { error: message, done: '', warn: '' }
  }
  return {
    error: '',
    done: storagePreparedText(r.placement.bucket, r.dataLayerPlaced === true, r.dataLayerFile),
    // **目印を置けなかったという知らせを、ここで落とさない。**
    warn: typeof r.markerNote === 'string' ? r.markerNote : '',
  }
}

/** `storage:ensureLayer` の戻り（**画面の3か所で同じ型を使う**）。 */
type DataLayerResult = Awaited<ReturnType<typeof window.electronAPI.storage.ensureLayer>>

/**
 * **`storage:ensureLayer` を呼んだら、必ずここを通す**（2026-09-25 検分の指摘16・17）。
 * 覚えたうえで、画面に出す1行（時点つき）を返す。
 *
 * ── なぜ1か所にまとめるのか ──────────────────────────────────────────
 * ensureLayer は「読み込み先を用意する」だけの口ではない。**古い koto-data を新しい版へ
 * 置き替える唯一の自動経路**でもあり、`replaced` / `needsUpdate` を返す。呼ぶのは
 * 「AIに書き直してもらう」と「一緒に移してもらう」の2か所なのに、覚えて見せていたのは
 * 書き直しの側だけだった。「一緒に移してもらう」を押した人には、Koto が差し替えたことも・
 * 触れなかったことも**一度も伝わらなかった**（しかも直後の `onAskAi?.()` で③公開ごと
 * 閉じるので、画面の state に入れるだけでは読まれる前に消える）。
 *
 * **通るたびに上書きする。** 書き直しで「そのままにしました」を覚えたあと、移すほうで
 * 実際に差し替わったら、古い断定はその場で書き換わる（言うことが無ければ消える）。
 */
export function rememberLayerLine(projectDir: string | null, layer: DataLayerResult | null): string {
  const updateLine = dataLayerUpdateLine(layer)
  rememberDataLayerLine(projectDir, updateLine)
  // 覚えたものをそのまま出す（**画面と記憶で言うことをずらさない**）。覚えられなかった
  // ときだけ、その場の時点で組み立てて出す（その回に出るだけで、次には残らない）
  return readDataLayerLine(projectDir) || dataLayerNoteText(updateLine ? { line: updateLine, at: Date.now() } : null)
}

/**
 * **枠が変わっても消してはいけない行**（2026-09-25 検分の指摘36）。
 *
 * ⚠️ 目印を置けなかった警告は**お金と破棄に関わる**（目印が無いと、同じ保存場所を
 * 共有するほかのプロジェクトを⑥で破棄したときに巻き込まれうる）。ところが出していたのは
 * `will-lose-data` / `declared` の枠だけで、「🔎 書き直せたか確かめる」を押して need が
 * none や target-provides に転ぶと、**枠ごと黄色い⚠️が消えていた**。
 * koto-data の1行・確かめた結果も同じ扱いにすべきものなので、**3つの枠が同じものを
 * 同じ順で出す**ように、ここ1か所にまとめる（掟10。片方だけ直して食い違う、を防ぐ）。
 *
 * **素のテキストで出す**（掟5。Markdown 記法は使わない）。
 */
export function KeptLines({ markerNote, dataLayerLine, checkLine }: { markerNote: string; dataLayerLine: string; checkLine: string }) {
  return (
    <>
      {markerNote && <p className="text-[11px] text-brand-yellow leading-relaxed select-text">⚠️ {markerNote}</p>}
      {dataLayerLine && <p className="text-[11px] text-ink-secondary leading-relaxed select-text">{dataLayerLine}</p>}
      {checkLine && <p className="text-[11px] text-ink-secondary leading-relaxed select-text">{checkLine}</p>}
    </>
  )
}

export default function StorageNotice({ projectDir, target, onAskAi }: { projectDir: string | null; target: PublishTarget; onAskAi?: () => void }) {
  const [need, setNeed] = useState<StorageNeed | null>(null)
  /** ファイルに書き込んでいる場所。**画面にも AI への依頼文にも、ここから出す。** */
  const [files, setFiles] = useState<FileWriteSite[]>([])
  /**
   * 入力されたデータを**メモリ（変数・配列）だけに持っている**場所（2026-10-01）。
   * **警告の理由に数えるものだけ**が入る（`memorySitesFor`）。見せ方も依頼文も `files` と同じ形。
   */
  const [memoryFiles, setMemoryFiles] = useState<FileWriteSite[]>([])
  /** 「書き直せたか確かめる」の結果（1行）。**押すまでは何も出さない。** */
  const [checkLine, setCheckLine] = useState('')
  const [checking, setChecking] = useState(false)
  /** 「🔎 書き直せたか確かめる」が ✅ を返したか。**文面からは判断しない**（掟10）。 */
  const [rewriteDone, setRewriteDone] = useState(false)
  /** 書き直したあとに残った「中身のある古いデータ」。**画面にファイル名は出さない。** */
  const [leftover, setLeftover] = useState<LeftoverDataFile[]>([])
  /** もう選んだか。**選んだあとは出し直さない**（毎回聞かれると鬱陶しい）。 */
  const [leftoverAnswered, setLeftoverAnswered] = useState(false)
  /** 古いデータを探した結果について知らせる1行（調べられなかった・全部は見ていない）。 */
  const [leftoverNote, setLeftoverNote] = useState('')
  /** 「AIに書き直してもらう」を押してから、文面を送るまで。 */
  const [asking, setAsking] = useState(false)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  /** 用意はできたが目印を置けなかった、という警告（markerNote）。**黙らない。** */
  const [markerNote, setMarkerNote] = useState('')
  /**
   * koto-data を差し替えた／触れなかったの1行。**画面を閉じても残す**（覚えてある分を出す）。
   * 初期値をここで読むので、③公開を開き直した最初の描画から出る。
   */
  const [dataLayerLine, setDataLayerLine] = useState(() => readDataLayerLine(projectDir))
  /** いまある保存場所の名前。**すでにあるものを選べば費用は増えない。** */
  const [buckets, setBuckets] = useState<string[]>([])
  const [chosen, setChosen] = useState<string>(NEW_BUCKET)

  /**
   * 古いデータを探して、問いの材料を作る。**探しに行くのはここ1か所だけ。**
   *
   * ── なぜ「🔎 を押したとき」だけではいけないか（2026-09-24 検分）─────────────
   * 書き直しが成功すると `storageNeedFor` は 'declared' を返す（warn が下りる）。
   * すると 🔎 ボタンごと消え、③公開のモーダルは閉じるたびに作り直されて状態も捨てる。
   * つまり「AI に書き直してもらう → モーダルが閉じる → AI が直す → ③公開を開き直す」
   * という**いちばん自然な流れ**では、問いが一度も出なかった。**開いた時点でも探す。**
   *
   * 出す・出さないの判断は純関数（shouldLookForLeftoverData）に任せる（掟10）。
   * 調べられなかったとき・全部は見られなかったときは、**黙って「無かった」に倒さず**
   * 1行で知らせる（leftoverScanLine）。
   */
  const lookForLeftover = async (
    scan: { usesDataLayer: boolean; writesFiles: readonly FileWriteSite[]; keepsInMemory?: readonly FileWriteSite[]; truncated?: boolean },
    answered: boolean,
  ): Promise<{ files: LeftoverDataFile[]; note: string }> => {
    if (!projectDir || !shouldLookForLeftoverData(scan, answered)) return { files: [], note: '' }
    try {
      const r = await window.electronAPI.storage.leftoverData(projectDir)
      return { files: r.ok && Array.isArray(r.files) ? r.files : [], note: leftoverScanLine(r) }
    } catch (e: any) {
      return { files: [], note: leftoverScanLine({ ok: false, message: e?.message ?? String(e) }) }
    }
  }

  useEffect(() => {
    let alive = true
    // プロジェクトが変われば、問いの状態も持ち越さない（前のプロジェクトの答えで黙らない）
    setRewriteDone(false)
    setLeftover([])
    setLeftoverNote('')
    // **別のプロジェクトの結果を持ち越さない**（2026-09-25 検分の指摘36）。
    // ⚠️ 目印を置けなかった警告は「いまのプロジェクトの保存場所」の話なので、
    // 持ち越すと**関係のないプロジェクトに警告を出す**（「✅ 用意しました」も同じ）
    setMarkerNote('')
    setDone('')
    setCheckLine('')
    setError('')
    // 覚えてある「koto-data を差し替えた／触れなかった」の1行を出し直す（指摘15）
    setDataLayerLine(readDataLayerLine(projectDir))
    const answered = readLeftoverAnswered(projectDir)
    setLeftoverAnswered(answered)
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
      const memory = memorySitesFor(scan, target)
      setMemoryFiles(memory)
      // 判断は純関数1本（開いたときと「確かめる」で同じ道を通す・掟10）
      setNeed(storageNeedForScan(scan, target))
      // **開き直しただけでも、書き直し済みなら問いを復元する。**
      // ここが無いと、書き直したあとに ③公開 を開き直した人には二度と聞かれない
      const result = {
        usesDataLayer: scan.usesDataLayer,
        writesFiles: scan.writesFiles,
        keepsInMemory: memory,
        truncated: scan.truncated === true,
      }
      setRewriteDone(rewriteCheckDone(result))
      const found = await lookForLeftover(result, answered)
      if (!alive) return
      setLeftover(found.files)
      setLeftoverNote(found.note)
    })()
    return () => { alive = false }
  }, [projectDir, target])

  const prepare = async () => {
    if (!projectDir) return
    setError('')
    setMarkerNote('')
    setBusy(true)
    try {
      const r = await window.electronAPI.storage.prepare(projectDir, {
        mode: getStorageMode(),
        // 既存を選んでいればそれを使う（**費用は増えない**）。新しく作るときは渡さない
        ...(chosen !== NEW_BUCKET ? { bucket: chosen } : {}),
      })
      // 戻り値を画面の行へ直すのは純関数1か所（掟10）。**markerNote をここで落とさない**
      const lines = storagePrepareLines(r)
      if (!r.ok || !r.placement) { setError(lines.error); return }
      setPlacement(r.placement)
      setConfirming(false)
      // 同じ③公開の中にある公開パネルへ知らせる。**あちらは画面を開いた時点の
      // 写しで動いている**ので、放っておくと費用の表示も破棄の案内も古いまま
      window.dispatchEvent(new CustomEvent('sakura:storage-prepared'))
      // 文面は純関数に任せる。**ファイル名を画面に書き写さない**
      // （require のアプリでは koto-data.cjs が置かれる・2026-09-23 検分）
      setDone(lines.done)
      // **目印を置けなかったときは、その場で警告を出す。** 出さないと、同じ保存場所を
      // 共有するプロジェクトを破棄したときに巻き込まれることを誰も知らないまま進む
      setMarkerNote(lines.warn)
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
        setRewriteDone(false)
        return
      }
      setFiles(scan.writesFiles)
      const memory = memorySitesFor(scan, target)
      setMemoryFiles(memory)
      setNeed(storageNeedForScan(scan, target))
      // **打ち切りの有無も渡す。** 渡さないと「調べていない」が「済んだ」になる
      const result = {
        usesDataLayer: scan.usesDataLayer,
        writesFiles: scan.writesFiles,
        keepsInMemory: memory,
        // koto-data を使っていて警告にはしないメモリの場所。✅ の文が「ただし、ここに残っています」と
        // 名指しする（AI が import を1行足しただけでも ✅ になるのを、黙らない・2026-10-01 検分）
        memoryNotWarned: memorySitesNotWarned(scan, target),
        truncated: scan.truncated === true,
      }
      setCheckLine(rewriteCheckLine(result))
      setRewriteDone(rewriteCheckDone(result))
      // **書き直せたときだけ、古いデータを探す。** まだ書き直せていない段階では
      // 「参照されていない」が正しく出ないし、そもそも書き直しが先である（2026-09-24）。
      // 判断も探しに行く先も、開いた直後（useEffect）とまったく同じ道を通す
      const found = await lookForLeftover(result, leftoverAnswered)
      setLeftover(found.files)
      setLeftoverNote(found.note)
    } catch {
      setCheckLine(rewriteCheckLine(null))
      setRewriteDone(false)
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
      let layer: DataLayerResult | null = null
      try { layer = await window.electronAPI.storage.ensureLayer(projectDir) } catch { layer = null }
      // **古い koto-data を差し替えたか・触れなかったかを、覚えてから進む**（指摘15・16・17）。
      // 見せないと「直したのに直っていない」が、原因の分からない形で残る。
      // 覚える口は rememberLayerLine ただ1つ（ensureLayer を呼ぶ2経路が同じ扱いになる）
      setDataLayerLine(rememberLayerLine(projectDir, layer))
      // **メモリだけに持っている場所も渡す**（2026-10-01）。ファイルへの書き込みと同じく、
      // Koto が見つけた場所をそのまま入れる（渡さないと AI は自分の記憶で答える）
      const plan = askAiRewritePlan(files, layer, memoryFiles)
      if (!plan.send) { setError(plan.error); return }
      // **Koto が見つけた場所と、実際に置いたファイルに合わせた書き方を渡す。**
      // 渡さないと AI は自分の記憶で答え、「完了しました」と言い切る
      window.dispatchEvent(new CustomEvent('sakura:ask-ai', { detail: { text: plan.text } }))
      onAskAi?.()
    } finally { setAsking(false) }
  }

  /**
   * 「一緒に移してもらう」。**移すのは AI にやらせる。**
   *
   * Koto が古い保存の形を当てて移すと、当てそこねたときに**黙ってデータを壊す**。
   * 既にある「AIに書き直してもらう」とまったく同じ仕組み（sakura:ask-ai）を使い、
   * チャットの実行ループには触らない（掟7）。
   * **Koto が見つけた場所（ファイル名と件数）を必ず渡す**——渡さないと AI は
   * 自分の記憶で答え、「完了しました」と言い切る（2026-09-23 の教訓）。
   *
   * ── なぜ ensureLayer を通すのか（2026-09-24 検分）──────────────────────
   * 依頼文には**実際に置いたファイルに合わせた読み込み方**（import / require）と
   * 「package.json の type を変えない」が要る。書き直しの依頼文には必ず入っているのに
   * こちらには無く、require で動くアプリでは AI が koto-data.js を import しようとして
   * 読み込めず、package.json を直しにいく余地が残っていた（それをやると**アプリが
   * 起動しなくなる**。しかもデータを移している最中なので被害が重なる）。
   * 送る・送らないの判断は askAiRewritePlan と同じく純関数（askAiMoveDataPlan）へ寄せる。
   *
   * ── なぜ「答えた」を覚えないのか（2026-09-24 検分）─────────────────────
   * `sakura:ask-ai` は**チャットの入力欄に文面を入れるだけで、送信はしない**
   * （送るのは利用者・ChatPanel）。押した時点で覚えてしまうと、文面を読んで迷った人・
   * 別のことを打ち込んで消した人にも問いが二度と出ず、古いデータは手つかずのまま
   * 気づく手がかりも無くなる。**押しただけでは完了ではない**ので、ここでは覚えない。
   * 覚えるのは「移さない」＝利用者がはっきり決めたときだけ（skipMoveData）。
   */
  const moveDataWithAi = async () => {
    if (!projectDir || asking) return
    setAsking(true)
    setError('')
    try {
      let layer: DataLayerResult | null = null
      try { layer = await window.electronAPI.storage.ensureLayer(projectDir) } catch { layer = null }
      // **書き直しの側とまったく同じ扱いにする**（2026-09-25 検分の指摘16）。
      // ここも ensureLayer を通る＝古い koto-data が差し替わりうる経路なので、黙らない
      setDataLayerLine(rememberLayerLine(projectDir, layer))
      const plan = askAiMoveDataPlan(leftover, layer)
      if (!plan.send) { setError(plan.error); return }
      window.dispatchEvent(new CustomEvent('sakura:ask-ai', { detail: { text: plan.text } }))
      onAskAi?.()
    } finally { setAsking(false) }
  }

  /**
   * 「移さない」。**何もしない。古いファイルは消さない。**
   *
   * Koto の片づけは全部「移動・戻せる」で統一されており、削除の処理は1行も無い。
   * ここで消すと、その唯一の例外になる（しかも取り消せない）。
   *
   * **覚えるのはこちらだけ**（2026-09-24 検分）。利用者がはっきり「移さない」と決めた
   * ときだけ、プロジェクトごとに覚えて出し直さない。気が変わったときのために、
   * 画面には LEFTOVER_DATA_SKIP_LATER_NOTE（あとでチャットから頼める）を添えてある
   * ——古いファイルは消していないので、実際にあとから頼める。
   */
  const skipMoveData = () => {
    setLeftoverAnswered(true)
    rememberLeftoverAnswered(projectDir)
  }

  // 記録にある保存場所が、実際に存在するか（一覧が取れているときだけ判断する）
  const missing = !!placement && buckets.length > 0 && !buckets.includes(placement.bucket)

  if (!need || need.kind === 'none') {
    // 「書き直せたか確かめる」を押した直後に問題が消えることがある。
    // **結果だけは残して見せる**（枠ごと消えると、押した人には何も伝わらない）。
    // koto-data の版についての1行も、**書き直しが済んだあとの画面にこそ要る**
    // （「AIに書き直してもらう」で閉じたあと、開き直すとここへ来る・指摘15）。
    // ⚠️ 目印を置けなかった警告も同じ枠に出す（**お金と破棄に関わる**・指摘36）
    return (markerNote || checkLine || dataLayerLine) ? (
      <div className="rounded-xl border border-line bg-surface p-3 space-y-1">
        <KeptLines markerNote={markerNote} dataLayerLine={dataLayerLine} checkLine={checkLine} />
      </div>
    ) : null
  }

  // 追加費用の要らない公開先では、安心材料として軽く出すだけにする
  if (need.kind === 'target-provides') {
    return (
      <div className="rounded-xl border border-line bg-surface p-3 space-y-1">
        <p className="text-xs text-ink-secondary leading-relaxed">💾 {need.note}</p>
        {/* **ここでも消さない。** 公開先を選び直しただけで警告が消えては、置けなかった
            目印の話が誰にも届かない（3つの枠で同じものを出す・指摘36） */}
        <KeptLines markerNote={markerNote} dataLayerLine={dataLayerLine} checkLine={checkLine} />
      </div>
    )
  }

  const warn = need.kind === 'will-lose-data'
  // 理由が「メモリだけに持っていそう」という推定だけのときは、見出しもその下の1行も断定しない
  const guess = need.kind === 'will-lose-data' && need.memoryOnly === true
  return (
    <div className={`rounded-xl border p-4 space-y-2 ${warn && !placement ? 'border-brand-yellow/70 bg-surface' : 'border-line bg-surface'}`}>
      <p className="text-sm font-semibold text-ink">
        {storageNoticeHeadline({
          hasPlacement: !!placement,
          warn,
          guess,
        })}
      </p>
      {/* **保存場所はできたが、書き直しが残っている。** 残りの作業を1行で示す */}
      {placement && warn && (
        <p className="text-xs text-ink leading-relaxed select-text">{guess ? STORAGE_REWRITE_MAYBE_REMAINING : STORAGE_REWRITE_REMAINING}</p>
      )}
      <p className="text-xs text-ink-secondary leading-relaxed select-text">{need.note}</p>

      {warn && files.length > 0 && (
        <p className="text-[11px] text-ink-muted leading-relaxed select-text">
          ファイルに書き込んでいる箇所: {files.slice(0, 3).map(describeWriteSite).join('、')}
          {files.length > 3 ? `、ほか${files.length - 3}件` : ''}
        </p>
      )}
      {/* メモリだけに持っている場所も、**ファイルに書き込んでいる箇所と同じ見せ方**で出す
          （ファイル名と行番号。新しい見せ方を作らない・2026-10-01）。
          警告の理由に数える場合だけ memoryFiles に入っている */}
      {warn && memoryFiles.length > 0 && (
        <p className="text-[11px] text-ink-muted leading-relaxed select-text">
          メモリだけにデータを持っている箇所: {memoryFiles.slice(0, 3).map(describeWriteSite).join('、')}
          {memoryFiles.length > 3 ? `、ほか${memoryFiles.length - 3}件` : ''}
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
      {/* **どの枠でも消えない3行**（指摘36）:
          ・⚠️ 用意はできたが目印を置けなかった（黙ると、あとで巻き込まれて消えたときに
            手がかりが1つも残らない・指摘9・14）
          ・koto-data を差し替えたか・触れなかったか（閉じても残る・指摘15）
          ・🔎 調べ直した結果（warn が消えたあとも残す） */}
      <KeptLines markerNote={markerNote} dataLayerLine={dataLayerLine} checkLine={checkLine} />

      {/*
        書き直しの導線（2026-09-24 検分で並びを変えた）。
        **「🔎 書き直せたか確かめる」は warn の外に置く。** 書き直しが成功すると warn が
        下りるので、中に置いたままだと**押せる導線ごと消える**。書き直し済み（declared）
        でも押せることが、古いデータの問いへ戻る唯一の道になる。
      */}
      <div className="space-y-1">
        <div className="flex gap-2">
          {warn && (
            <button
              onClick={() => { void askAi() }}
              disabled={asking}
              className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-40"
            >{asking ? '準備しています…' : 'AIに書き直してもらう'}</button>
          )}
          {/* **押した瞬間に1回だけ調べ直す。** AI の「完了しました」を確かめる手段 */}
          <button
            onClick={() => { void recheck() }}
            disabled={checking}
            className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura hover:text-sakura disabled:opacity-40"
          >{checking ? '確かめています…' : '🔎 書き直せたか確かめる'}</button>
        </div>
        <p className="text-[11px] text-ink-muted leading-relaxed">
          {warn ? 'チャットに AI へのお願いが入ります（中身は AI 向けの指示です）。送信すると AI が作業を始めます。' : ''}
          書き直してもらったあとは「🔎 書き直せたか確かめる」で、実際に直ったかを調べられます。
        </p>
      </div>

      {/*
        💾 いま入っているデータをどうしますか（2026-09-24 Ryosuke さん決定）。
        書き直せた（✅）とき、**中身のある古いデータが実在するときだけ**出す。
        **ファイル名は出さない**（利用者はファイルを意識していない・作者の指摘）。
        文面は作者が2回直して確定したもの——shared/leftoverData.ts の定数をそのまま出す。
      */}
      {/* 古いデータを探した結果のうち、**黙ってはいけないこと**だけを1行で出す */}
      {leftoverNote && (
        <p className="text-[11px] text-ink-secondary leading-relaxed select-text">{leftoverNote}</p>
      )}

      {shouldAskLeftoverData({ rewritten: rewriteDone, files: leftover, answered: leftoverAnswered }) && (
        <div className="rounded-lg border border-line p-3 space-y-2">
          <p className="text-xs font-semibold text-ink leading-relaxed select-text">{LEFTOVER_DATA_HEADING}</p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { void moveDataWithAi() }}
              disabled={asking}
              className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-40"
            >{asking ? '準備しています…' : LEFTOVER_DATA_MOVE_LABEL}</button>
            <span className="text-[11px] text-ink-muted leading-relaxed select-text">… {LEFTOVER_DATA_MOVE_NOTE}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={skipMoveData}
              className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura hover:text-sakura"
            >{LEFTOVER_DATA_SKIP_LABEL}</button>
            <span className="text-[11px] text-ink-muted leading-relaxed select-text">… {LEFTOVER_DATA_SKIP_NOTE}</span>
          </div>
          {/* **押すと何が起きるか**を、この枠の中にも置く（書き直しの枠と同じ言い回し） */}
          <p className="text-[11px] text-ink-muted leading-relaxed select-text">
            {LEFTOVER_DATA_ASK_AI_NOTE}{LEFTOVER_DATA_SKIP_LATER_NOTE}
          </p>
        </div>
      )}
    </div>
  )
}
