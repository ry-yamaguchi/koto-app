// zonesCache.ts — GET /zone（さくらのクラウドのゾーン一覧）を、アプリ起動時に一度だけ取得して
// 使い回すための、renderer 側のキャッシュ（roadmap #28・2026-09-08 Ryosuke さん依頼）。
//
// ── なぜ要るか ───────────────────────────────────────────────────────
// これまでは専有型パネル（AppRunDedicatedPanel.tsx）だけが、③「🔍 調べる」を押した瞬間に
// GET /zone を叩いていた。ゾーンを選べる画面を増やす（専有型のクラスタ・共用型 AppRun の
// region）につれ、画面ごとに叩き直すのは無駄が多い。ここに1箇所だけ「取得中の Promise」と
// 「成功した結果」を持ち、複数の画面が同時に呼んでも実際のAPI呼び出しは1回で済ませる。
//
// 方式B（掟4）: ここにもキーは一切保存しない。呼ばれるたびに cloud.loadKey() で
// 「使用中」のキーを読み、apprunDedicated:zones へ引数で渡すだけ。main には渡した後の
// ものを含め何も残らない。
//
// ── 'sakura:credentials-changed' で必ず捨てる ────────────────────────────
// 2026-09-07 に2度、「キーを切り替えたのに前のキーの結果が画面に残る」事故が起きている
// （①の疎通結果・破棄画面のレジストリ名）。同じ家系の事故をここでも塞ぐ:
// credentials-changed を受けたら、保持している結果を必ず捨てる。
//
// **取得の途中で鍵が変わった場合も塞ぐ。** 世代カウンタ（generation）を持ち、取得を
// 開始した時点の世代と、完了した時点の世代が一致するときだけ結果をキャッシュへ書き込む。
// credentials-changed は世代を1つ進めるので、「古い鍵で取得中だった結果」が、鍵が
// 変わった後に紛れ込んでキャッシュを上書きすることはない。

import { readZones, isZonesShape, type ZoneRow } from '../shared/apprunDedicatedShapes'

export type LoadZonesResult = { ok: boolean; rows: ZoneRow[]; message?: string }

const NO_KEY_MESSAGE = 'さくらのクラウドAPIキーが未登録です。'
// O（2026-09-10 レビューの修理・バッチ3）: 200でも形が想定と違えば「成功・0件」にしない。
// 直す前は readZones が空配列を返すだけで、キャッシュされたうえ画面は無言で自由入力に戻っていた。
const SHAPE_MISMATCH_MESSAGE = 'ゾーン一覧の形が想定と違ったため取得できませんでした（手入力できます）'

let cached: LoadZonesResult | null = null
let inflight: Promise<LoadZonesResult> | null = null
let generation = 0
let primed = false

/** 実際に GET /zone を1回叩く。失敗しても reject しない（呼び出し側を巻き添えにしないため）。 */
async function fetchZones(): Promise<LoadZonesResult> {
  let auth: { token: string; secret: string } | null = null
  try {
    auth = await window.electronAPI.cloud.loadKey()
  } catch {
    auth = null
  }
  // キーが未登録なら、APIを呼ばずにここで返す（依頼文の指示どおり）。
  if (!auth || !auth.token || !auth.secret) {
    return { ok: false, rows: [], message: NO_KEY_MESSAGE }
  }
  try {
    const r = await window.electronAPI.apprunDedicated.zones(auth)
    if (r.ok) {
      if (!isZonesShape(r.data)) return { ok: false, rows: [], message: SHAPE_MISMATCH_MESSAGE }
      return { ok: true, rows: readZones(r.data) }
    }
    return { ok: false, rows: [], message: r.message }
  } catch (e: any) {
    return { ok: false, rows: [], message: e?.message ?? String(e) }
  }
}

/**
 * ゾーン一覧を取得する。
 *
 * - 取得中の Promise があれば、force の有無に関わらずそれを共有する（同時押しの二重打ちを防ぐ。
 *   進行中の取得が一番新しい取得でもある）。
 * - force=false（既定）: 取得中でなく、成功済みの結果があれば即座にそれを返す。まだ無ければ
 *   新しく取りに行く。
 * - force=true: 取得中でなければ、成功済みの結果があっても無視して取り直す
 *   （専有型パネルの③「🔍 調べる」用）。
 *
 * **成功した結果だけをキャッシュへ残す。** 失敗（キー未登録・APIエラーいずれも）は
 * キャッシュを汚さない――次の呼び出し（force を付けなくても）がまた取りに行き、
 * 「鍵をあとから登録したのに、起動直後の失敗を引きずる」ことがないようにする。
 */
export function loadZones(force = false): Promise<LoadZonesResult> {
  if (typeof window === 'undefined' || !window.electronAPI?.cloud || !window.electronAPI?.apprunDedicated) {
    return Promise.resolve({ ok: false, rows: [], message: NO_KEY_MESSAGE })
  }
  if (inflight) return inflight
  if (!force && cached) return Promise.resolve(cached)

  const myGeneration = generation
  const p: Promise<LoadZonesResult> = fetchZones().then(res => {
    // 取得の途中で credentials-changed が来ていたら（generation が進んでいたら）、
    // この結果は「もう捨てられたはずの鍵」のものなのでキャッシュへは書かない。
    if (myGeneration === generation && res.ok) cached = res
    if (inflight === p) inflight = null
    return res
  })
  inflight = p
  return p
}

/**
 * 'sakura:credentials-changed' を受けて呼ぶ。成功済みキャッシュ・取得中の Promise の両方を
 * 捨て、世代を進める（進行中の取得が後から返ってきても書き戻させないため）。
 */
export function clearZonesCache(): void {
  generation++
  cached = null
  inflight = null
}

/**
 * 起動時に1度だけ呼ぶ（App.tsx のマウント時 effect・primeLearningMirror 等と並べて呼ぶ）。
 * credentials-changed の購読を始め、初回の取得を投げる。**結果は待たない**
 * （起動を待たせない。失敗しても他の機能を止めない）。各画面は loadZones() で結果を拾う。
 */
export function primeZonesCache(): void {
  if (typeof window === 'undefined' || !window.electronAPI?.cloud || !window.electronAPI?.apprunDedicated) return
  if (primed) return
  primed = true

  window.addEventListener('sakura:credentials-changed', () => { clearZonesCache() })

  void loadZones()
}

/** テスト用: モジュール内の状態（cached・inflight・generation・primed）をリセットする。 */
export function resetZonesCacheForTest(): void {
  cached = null
  inflight = null
  generation = 0
  primed = false
}
