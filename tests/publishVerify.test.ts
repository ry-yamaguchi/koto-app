import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MARKER_FILE, markerContent, matchesMarker, markerUrl, canVerify, verifyDelaysMs, verifyMessage,
  dedicatedVerifyMessage, dedicatedVerifyOk, judgeDedicatedProbe,
  dedicatedVerifyMode, dedicatedProbePath, judgeDedicatedRootProbe, judgeDedicatedProbeBy,
  dedicatedVerifySettled, dedicatedVerifyNotServing, probeStatusKind, judgeVerifyProbe,
  judgeDnsMatch, judgeDnsLookupError, judgePeerCertificate, judgeHttpsOpenError, siteCheckLines,
  certNameCovers, certIssuerName,
} from '../src/shared/publishVerify'
import { tagOfRef } from '../src/main/cloud/imageBuild'

// ── 2026-08-19 実機（Ryosuke 報告と提案）────────────────────────────
// 「試すだと画像が表示されるが、公開すると画像が表示されていない」
// 公開は「✅ 完了しました」と出ていたのに、配られていたのは**画像を入れる前の
// 古いページ**だった。**誰も確かめていなかったこと自体**が本当の問題。
//   ・デプロイのAPIが 200 … 反映された証拠にならない
//   ・アプリが起動した   … 中身が新しい証拠にならない
// 配る中身に版の目印を混ぜ、公開のあとに読みに行く。

describe('版の目印', () => {
  it('★ 中身は版の名前だけ', () => {
    expect(markerContent('v20260819-182300')).toBe('v20260819-182300\n')
  })

  it('★★ 前後の空白や改行があっても一致と見る', () => {
    expect(matchesMarker('v20260819-182300\n', 'v20260819-182300')).toBe(true)
    expect(matchesMarker('  v20260819-182300  ', 'v20260819-182300')).toBe(true)
  })

  it('★★ 違う版は一致にしない（ここが緩むと確認の意味が消える）', () => {
    expect(matchesMarker('v20260819-182300', 'v20260819-190000')).toBe(false)
    expect(matchesMarker('', 'v20260819-182300')).toBe(false)
    expect(matchesMarker(null, 'v20260819-182300')).toBe(false)
    // 版が空なら、何が返ってきても一致にしない
    expect(matchesMarker('', '')).toBe(false)
  })

  it('★ 読みに行く先は公開URLの直下（重ね書きの / を作らない）', () => {
    expect(markerUrl('https://example.com')).toBe(`https://example.com/${MARKER_FILE}`)
    expect(markerUrl('https://example.com/')).toBe(`https://example.com/${MARKER_FILE}`)
  })
})

describe('確認できる公開かどうか（共用型 cloud.ts の入口）', () => {
  it('★★ 静的配信のときだけ確かめる', () => {
    expect(canVerify('static', 'https://x.example.com')).toBe(true)
    // Node のアプリは自分で経路を決めるので、目印が読めるとは限らない。
    // **読めないことを失敗と呼ばない**ため、はじめから対象にしない
    expect(canVerify('node', 'https://x.example.com')).toBe(false)
  })

  it('★ URLが無ければ確かめない', () => {
    expect(canVerify('static', null)).toBe(false)
    expect(canVerify('static', 'not-a-url')).toBe(false)
  })
})

describe('待ち方', () => {
  it('★ 短く諦めない（合計60秒以上）／待たせすぎない（3分以内）', () => {
    const total = verifyDelaysMs().reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThanOrEqual(60000)
    expect(total).toBeLessThanOrEqual(180000)
  })

  it('★ だんだん間隔を空ける（最初は素早く確かめる）', () => {
    const d = verifyDelaysMs()
    expect(d[0]).toBeLessThanOrEqual(3000)
    expect(d[d.length - 1]).toBeGreaterThanOrEqual(d[0])
  })
})

describe('画面に出す言葉', () => {
  it('★★ 古いままなら、そう言う（黙って成功に見せない）', () => {
    const m = verifyMessage('stale')
    expect(m).toContain('まだ古い内容')
    expect(m).toContain('公開')
  })

  it('★ 確認できたら、はっきり伝える', () => {
    expect(verifyMessage('ok')).toContain('確認しました')
  })

  it('★★ 確認できなかっただけのときは、失敗と混ぜない', () => {
    const m = verifyMessage('unreachable')
    expect(m).toContain('公開そのものは完了しています')
  })

  // B（D-7b・検分の指摘）: 画面（AppRunDedicatedPanel.tsx 等）は文言を素の <p> に流すだけで
  // Markdown を解釈しない。`**` が混ざると、太字にならず記号がそのまま画面に出る欠陥だった。
  it('★★ 返す文字列に ** を含まない（画面は Markdown を解釈しない）', () => {
    for (const outcome of ['ok', 'stale', 'no-backend', 'error-status', 'unreachable'] as const) {
      expect(verifyMessage(outcome)).not.toContain('**')
    }
  })

  // ── A（2026-09-16 の検分）: 503・502・500 を「接続できなかった」に倒さない ──────────
  // 直す前は、接続は成立していてエラーが返っているのに「接続できなかった」と書いていた
  // （観測していないことを書いていた＝掟1）。ここがいちばんの穴だったので、まず文面で固定する。
  it('★★★ 503（no-backend）の一言は「接続できなかった」とは言わず、503 が返っていることを書く', () => {
    const m = verifyMessage('no-backend')
    expect(m).toContain('503')
    expect(m).not.toContain('接続できなかった')
  })

  it('★★★ エラー応答（error-status）の一言も「接続できなかった」とは言わない。届いた番号を添えられる', () => {
    const m = verifyMessage('error-status', 502)
    expect(m).toContain('エラーを返しました')
    expect(m).toContain('502')
    expect(m).not.toContain('接続できなかった')
    // 番号が分からないときでも壊れない（呼び出し側の都合で省略できる）
    expect(verifyMessage('error-status')).not.toContain('接続できなかった')
  })

  it('★ no-backend・error-status は「完了しました」で終わらせない見た目にはしない（見出しは別・A-4）が、内容断定はしない', () => {
    // 専有型（Traefik）の断定をそのまま流用しない。「かもしれない」程度に留める。
    expect(verifyMessage('no-backend')).toContain('可能性があります')
  })
})

describe('目印に書く版の名前', () => {
  it('★ イメージ参照からタグを取り出す', () => {
    expect(tagOfRef('example.sakuracr.jp/landingtest:v20260819-182300')).toBe('v20260819-182300')
  })

  it('★★ ポート付きのサーバでも間違えない', () => {
    expect(tagOfRef('registry.local:5000/app:v1')).toBe('v1')
    // タグが無い形（最後の : がサーバのポート）は空にする
    expect(tagOfRef('registry.local:5000/app')).toBe('')
  })
})

// 掟10「一元化したことと、全経路が実際にそこを通っていることは別」。
describe('公開の経路が、実際に確認を通っている', () => {
  const cloud = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')
  const build = readFileSync(join(__dirname, '..', 'src/main/cloud/imageBuild.ts'), 'utf-8')

  it('★★ 配る中身に目印を混ぜている', () => {
    expect(build).toContain('markerContent(opts.buildTag)')
    expect(build).toContain('buildTag: tagOfRef(opts.ref)')
  })

  it('★★ 起動を確認したあとに、中身も確かめる', () => {
    expect(cloud).toContain('const v = await verifyPublished(')
    expect(cloud).toContain('canVerify(runtimeKind, publicUrl)')
  })

  it('★★ 確認できたときだけ一言を返す（無言を失敗と混ぜない。E・D-7b: 確認をとばしたときは runtimeSkipNote を代わりに返す。A: error-status の番号も渡す）', () => {
    expect(cloud).toContain('const verifyNote = verified ? verifyMessage(verified, verifiedStatus) : (runtimeSkipNote ?? \'\')')
  })

  it('★ キャッシュに騙されない問い合わせにする', () => {
    const at = cloud.indexOf('async function verifyPublished')
    const block = cloud.slice(at, at + 1400)
    expect(block).toContain('?t=${Date.now()}')
    expect(block).toContain("cache: 'no-store'")
  })
})

// ── A（2026-09-16 の検分）: 共用型の確認の判定 ──────────────────────────────────────
// 直す前は 503・502・500 のようなエラー応答まで `unreachable`（「接続できなかった」）に
// 倒していた。**接続は成立していて、エラーが返っている**のに「接続できなかった」と
// 書いており、観測していないことを書いていた（掟1）。専有型（`judgeDedicatedProbe`）と
// 同じ `probeStatusKind` に通すが、**404 だけは例外**（静的配信では「目印が無い＝古い版」が
// 正しい観測で、専有型のロードバランサが返す 404 とは意味が違う）。
describe('共用型: 1回の問い合わせの判定（A・純関数）', () => {
  const TAG = 'v20260916-083525'

  it('★ 200 かつ目印が一致 → ok', () => {
    expect(judgeVerifyProbe({ reached: true, status: 200, body: `${TAG}\n` }, TAG)).toBe('ok')
  })

  it('★★ 200 だが目印が不一致 → stale（届いているが前の版）', () => {
    expect(judgeVerifyProbe({ reached: true, status: 200, body: 'ふるい\n' }, TAG)).toBe('stale')
  })

  it('★★★ 404 は例外で stale のまま（目印が無い＝古い版という静的配信の正しい観測。ここを壊さない）', () => {
    expect(judgeVerifyProbe({ reached: true, status: 404, body: '' }, TAG)).toBe('stale')
  })

  it('★★★ 503 は no-backend（後ろに応答できるものがいない。今回の穴そのもの）', () => {
    expect(judgeVerifyProbe({ reached: true, status: 503, body: '' }, TAG)).toBe('no-backend')
  })

  it('★★★ 400 以上のそれ以外（500・502・504）は error-status。404 とは区別する', () => {
    for (const status of [500, 502, 504]) {
      expect(judgeVerifyProbe({ reached: true, status, body: '' }, TAG), `status ${status}`).toBe('error-status')
    }
  })

  it('★ 3xx は届いてはいるが目印は読めていない → stale（成功にはしない）', () => {
    expect(judgeVerifyProbe({ reached: true, status: 302, body: '' }, TAG)).toBe('stale')
  })

  it('★★ 接続できない → unreachable（エラー応答と取り違えない）', () => {
    expect(judgeVerifyProbe({ reached: false }, TAG)).toBe('unreachable')
  })

  it('★★ 版が分からない（目印が空）なら、200 が返っても ok にしない', () => {
    expect(judgeVerifyProbe({ reached: true, status: 200, body: '' }, '')).toBe('stale')
  })
})

// 目印そのものが公開から外れていたら、確認は永久に成立しない（掟10）
describe('目印は公開物から外されない', () => {
  it('★★ 秘密ファイル扱いにならない', async () => {
    const { isSecretFile, excludedFileNames } = await import('../src/shared/publishExclude')
    expect(isSecretFile(MARKER_FILE)).toBe(false)
    expect(excludedFileNames().has(MARKER_FILE)).toBe(false)
  })
})

// ── 専有型（AppRun 専有型）の⑧・D-7（2026-09-16 実機・0.6.19-rc.1）────────────
// ⑧でアプリを公開し、Koto は「✅ 公開しました」と出した。だが**観測できたのは、
// ロードバランサが 503 `no available server` を返し続けたことだけ**——コンテナ自体が
// 起動していたかは未確認（同じ日のコンパネは「稼働コンテナ 1・アクティブ」と表示していた。
// docs/apprun-dedicated-plan.md 5-13）。利用者は「公開できた」と信じて DNS を設定しに行くことになる。
// **確かめていないことを「大丈夫」に倒していた。**

describe('専有型の確認の言葉（D-7）', () => {
  it('★ 応答を確認できたら、はっきり伝える', () => {
    expect(dedicatedVerifyMessage('ok')).toBe('✅ アプリが応答することを確認しました')
  })

  it('★★ 503（後ろに健全なコンテナがいない）は、はっきり「応答していない」と言い、ログの場所まで案内する', () => {
    const m = dedicatedVerifyMessage('no-backend')
    expect(m).toContain('アプリがまだ応答していません')
    expect(m).toContain('503')
    expect(m).toContain('ランタイムログ')
    // 「公開しました」で終わらせない（2026-09-16 の事故そのもの）
    expect(m).not.toContain('公開しました')
  })

  it('★★ 古い内容のままなら、そう言う（黙って成功に見せない）', () => {
    const m = dedicatedVerifyMessage('stale')
    expect(m).toContain('古い内容のまま')
    expect(m).toContain('⑧')
  })

  it('★★ 確かめられなかっただけのときは、失敗と混ぜない', () => {
    const m = dedicatedVerifyMessage('unreachable')
    expect(m).toContain('確かめられませんでした')
    expect(m).toContain('公開の手続き自体は通っています')
  })

  it('★★ 「中身が新しいことまで確かめられた」と言ってよいのは ok だけ（ここが緩むと事故が戻る）', () => {
    expect(dedicatedVerifyOk('ok')).toBe(true)
    expect(dedicatedVerifyOk('stale')).toBe(false)
    expect(dedicatedVerifyOk('no-backend')).toBe(false)
    expect(dedicatedVerifyOk('unreachable')).toBe(false)
    // D-19: responding は「応答はあった」だけ。**中身が新しいかは確かめていない**ので false に倒す
    // （この関数を「成功か」の判断に使われたとき、確かめていないことを大丈夫に倒さないため）。
    expect(dedicatedVerifyOk('responding')).toBe(false)
    // D-19b（検分）: 失敗応答も当然 false
    expect(dedicatedVerifyOk('error-status')).toBe(false)
  })

  // B（D-7b・検分の指摘）: 同上。dedicatedVerifyMessage も素の <p> に流れるだけ。
  it('★★ 返す文字列に ** を含まない（画面は Markdown を解釈しない）', () => {
    for (const outcome of ['ok', 'stale', 'responding', 'error-status', 'no-backend', 'unreachable'] as const) {
      expect(dedicatedVerifyMessage(outcome)).not.toContain('**')
    }
  })

  // ── D-19b（2026-09-16 の検分）: 失敗応答の一文 ──────────────────────────────────
  it('★★ error-status は「応答することを確認しました」と言わず、エラーが返ったことを書く', () => {
    const m = dedicatedVerifyMessage('error-status')
    expect(m).toContain('エラーを返しました')
    expect(m).toContain('404')
    // 成功の一文と取り違えない（ここが緩むと、開けないページに「✅」が戻る）
    expect(m).not.toContain('✅')
    expect(m).not.toContain('応答することを確認しました')
    expect(m).not.toBe(dedicatedVerifyMessage('responding'))
    // 次に見る場所まで案内する（直し方のある失敗を、直し方の分からない失敗として見せない）
    expect(m).toContain('ランタイムログ')
  })

  // ── D-19（2026-09-16）: Node アプリの結果 `responding` ───────────────────────────
  it('★★ responding は「応答した」と言い切り、**中身が新しいかは確かめていない**と断る', () => {
    const m = dedicatedVerifyMessage('responding')
    expect(m).toContain('応答することを確認しました')
    expect(m).toContain('中身が新しいかまでは確かめていません')
    // ok の一文（言い切り）と同じ文字列にしない——同じなら、確かめていないことを確かめたことにする
    expect(m).not.toBe(dedicatedVerifyMessage('ok'))
  })
})

// ── D-19（2026-09-16）: 応答の確認を Node アプリにも効かせる ─────────────────────────
//
// 今日の一連の修理の出発点は「**アプリが動いていないのに『✅ 公開しました』と出た**」ことで、
// そのアプリは **Node アプリ**（`public/server.js`）だった。ところが確認は
// `canVerify`（＝静的配信だけ）に縛られており、**Node アプリでは確認そのものをとばしていた**
// ——**守りたかった場面を守れていなかった**。実機の画面にもそう出ていた:
//   「・このアプリは応答の確認の対象外のため、確認をとばしました」

describe('専有型: 確かめ方の選び方（D-19・純関数）', () => {
  it('★★ 静的配信で版が分かるときだけ、目印（.koto-build）で中身の新しさまで見る', () => {
    expect(dedicatedVerifyMode('static', 'v20260916-083525')).toBe('marker')
  })

  it('★★ Node の像は目印を配るとは限らない → 根（/）へ当てる。**とばさない**（今日の事故そのもの）', () => {
    expect(dedicatedVerifyMode('node', 'v20260916-083525')).toBe('root')
  })

  it('★★ 静的配信でも版が分からなければ、目印と比べようが無いので根へ当てる（推測で一致にしない）', () => {
    expect(dedicatedVerifyMode('static', null)).toBe('root')
    expect(dedicatedVerifyMode('static', '')).toBe('root')
    expect(dedicatedVerifyMode('static', '   ')).toBe('root')
  })

  it('★★ 像の種類が分からないときも根へ当てる（「分からない」を「確認しない」に倒さない）', () => {
    expect(dedicatedVerifyMode(null, 'v1')).toBe('root')
    expect(dedicatedVerifyMode(undefined, undefined)).toBe('root')
  })
})

describe('専有型: 問い合わせ先のパス（D-19・純関数）', () => {
  it('★ marker は目印のファイル、root は根。どちらもキャッシュ避けの ?t= を付ける', () => {
    expect(dedicatedProbePath('marker', 12345)).toBe(`/${MARKER_FILE}?t=12345`)
    expect(dedicatedProbePath('root', 12345)).toBe('/?t=12345')
  })
})

describe('専有型: 根（/）への1回の問い合わせの判定（D-19・純関数）', () => {
  it('★★ 503（Traefik の no available server）→ no-backend（今日の失敗そのもの）', () => {
    expect(judgeDedicatedRootProbe({ reached: true, status: 503, body: 'no available server' })).toBe('no-backend')
  })

  it('★★ 200・3xx は「応答している」＝ responding。**ok とは呼ばない**', () => {
    expect(judgeDedicatedRootProbe({ reached: true, status: 200, body: '<html>' })).toBe('responding')
    expect(judgeDedicatedRootProbe({ reached: true, status: 204, body: '' })).toBe('responding')
    expect(judgeDedicatedRootProbe({ reached: true, status: 302, body: '' })).toBe('responding')
  })

  // ── D-19b（2026-09-16 の検分）: 失敗応答を「応答している」に倒していた ───────────────
  // 直す前は「503 以外はすべて responding」だったため、**404・502・504 でも
  // 「✅ アプリが応答することを確認しました」を出していた**。しかも responding は取り直しを
  // 止めてよい結果なので、**1回目の 404 でループを打ち切って取り直しもしなかった**。
  // 専有型の LB は、ホスト名の振り分けが効かないと `404 page not found` を返す
  // （2026-09-16 実機・docs/apprun-dedicated-plan.md）——利用者から見てページは開けない。
  it('★★ LB がホスト名を振り分けられないときの 404（実機で観測した応答）を responding に倒さない', () => {
    expect(judgeDedicatedRootProbe({ reached: true, status: 404, body: '404 page not found' })).toBe('error-status')
  })

  it('★★ 400 以上の失敗応答（400・401・404・500・502・504）は error-status。成功の名前を与えない', () => {
    for (const status of [400, 401, 404, 500, 502, 504]) {
      const outcome = judgeDedicatedRootProbe({ reached: true, status, body: 'x' })
      expect(outcome, `status ${status}`).toBe('error-status')
      expect(outcome, `status ${status}`).not.toBe('responding')
    }
  })

  it('★★ 失敗応答では取り直しを止めない（公開直後は入れ替わっている最中でありうる）', () => {
    expect(dedicatedVerifySettled(judgeDedicatedRootProbe({ reached: true, status: 404, body: '' }))).toBe(false)
    expect(dedicatedVerifySettled(judgeDedicatedRootProbe({ reached: true, status: 502, body: '' }))).toBe(false)
    expect(dedicatedVerifySettled(judgeDedicatedRootProbe({ reached: true, status: 504, body: '' }))).toBe(false)
  })

  it('★★ 根に当てた結果を ok にしない（中身が新しいかは確かめていない）', () => {
    for (const status of [200, 204, 301, 400, 404, 500]) {
      expect(judgeDedicatedRootProbe({ reached: true, status, body: 'x' })).not.toBe('ok')
    }
  })

  it('★★ 接続できない → unreachable（「動いていない」の証明にはしない）', () => {
    expect(judgeDedicatedRootProbe({ reached: false })).toBe('unreachable')
  })
})

describe('専有型: 確かめ方に応じた判定の振り分け（D-19・純関数）', () => {
  const TAG = 'v20260916-083525'

  it('★★ marker のときは目印と突き合わせる（200＋一致は ok・不一致は stale）', () => {
    expect(judgeDedicatedProbeBy('marker', { reached: true, status: 200, body: `${TAG}\n` }, TAG)).toBe('ok')
    expect(judgeDedicatedProbeBy('marker', { reached: true, status: 200, body: 'ふるい\n' }, TAG)).toBe('stale')
  })

  it('★★ root のときは目印を見ない（同じ 200 でも responding。版が渡っていても ok にしない）', () => {
    expect(judgeDedicatedProbeBy('root', { reached: true, status: 200, body: `${TAG}\n` }, TAG)).toBe('responding')
  })

  it('★★ 503 はどちらの確かめ方でも no-backend（ここが緩むと 2026-09-16 の事故が戻る）', () => {
    expect(judgeDedicatedProbeBy('marker', { reached: true, status: 503, body: '' }, TAG)).toBe('no-backend')
    expect(judgeDedicatedProbeBy('root', { reached: true, status: 503, body: '' }, TAG)).toBe('no-backend')
  })

  // ── D-19b（検分・2026-09-16）: **確かめ方が違うだけで、同じ観測の意味が変わってはいけない** ──
  // 直す前は、同じ 404 を marker 経路は警告（stale）に・root 経路は成功（responding）に倒していた。
  it('★★ 同じ失敗応答は、どちらの確かめ方でも同じ結果になる（経路で判定が食い違わない）', () => {
    for (const status of [404, 500, 502, 504]) {
      const marker = judgeDedicatedProbeBy('marker', { reached: true, status, body: '404 page not found' }, TAG)
      const root = judgeDedicatedProbeBy('root', { reached: true, status, body: '404 page not found' }, TAG)
      expect(marker, `status ${status}`).toBe('error-status')
      expect(root, `status ${status}`).toBe(marker)
    }
  })
})

// ── D-19b（2026-09-16 の検分）: 応答の番号の物差しは1つ ───────────────────────────────
describe('専有型: 応答の番号だけで分かること（D-19b・純関数）', () => {
  it('★★ 503 だけが no-backend（Traefik の no available server）', () => {
    expect(probeStatusKind(503)).toBe('no-backend')
  })

  it('★★ 400 以上のそれ以外は error（届いてはいるが、利用者から見てページは開けない）', () => {
    for (const status of [400, 401, 403, 404, 500, 502, 504]) expect(probeStatusKind(status), `status ${status}`).toBe('error')
  })

  it('★★ 2xx・3xx は served（何かが配られた）', () => {
    for (const status of [200, 204, 301, 302, 399]) expect(probeStatusKind(status), `status ${status}`).toBe('served')
  })
})

describe('専有型: 取り直しを止めてよい結果（D-19・純関数）', () => {
  it('★★ 確かめたいことが確かめられたときだけ止める（marker は ok・root は responding）', () => {
    expect(dedicatedVerifySettled('ok')).toBe(true)
    expect(dedicatedVerifySettled('responding')).toBe(true)
  })

  it('★★ まだ入れ替わっている途中かもしれないものは、短く諦めない', () => {
    expect(dedicatedVerifySettled('no-backend')).toBe(false)
    expect(dedicatedVerifySettled('stale')).toBe(false)
    expect(dedicatedVerifySettled('unreachable')).toBe(false)
    // D-19b（検分）: 失敗応答（404・502・504 …）も止める理由にしない。直す前はこれが
    // responding だったため、**1回目の失敗応答でループを打ち切って取り直しもしなかった**。
    expect(dedicatedVerifySettled('error-status')).toBe(false)
  })
})

// ── D-19b（2026-09-16 の検分）: 「いま公開先が開けない」結果の線引きを1か所に置く ──────────
describe('専有型: 公開先がまともに開けない結果か（D-19b・純関数）', () => {
  it('★★ 503（no-backend）と失敗応答（error-status）が true', () => {
    expect(dedicatedVerifyNotServing('no-backend')).toBe(true)
    expect(dedicatedVerifyNotServing('error-status')).toBe(true)
  })

  it('★★ 開ける・確かめられなかっただけのものは false（警告を出しすぎない）', () => {
    expect(dedicatedVerifyNotServing('ok')).toBe(false)
    expect(dedicatedVerifyNotServing('responding')).toBe(false)
    expect(dedicatedVerifyNotServing('stale')).toBe(false)
    expect(dedicatedVerifyNotServing('unreachable')).toBe(false)
    // 確認をとばしたとき（verify が付かない）も false——確かめていないことを失敗に倒さない
    expect(dedicatedVerifyNotServing(undefined)).toBe(false)
    expect(dedicatedVerifyNotServing(null)).toBe(false)
  })
})

describe('専有型の確認の判定（D-7・純関数）', () => {
  const TAG = 'v20260916-083525'

  it('★ 200 かつ目印が一致 → ok', () => {
    expect(judgeDedicatedProbe({ reached: true, status: 200, body: `${TAG}\n` }, TAG)).toBe('ok')
  })

  it('★★ 200 だが目印が古い → stale（一致していないものを ok にしない）', () => {
    expect(judgeDedicatedProbe({ reached: true, status: 200, body: 'v20260916-070000\n' }, TAG)).toBe('stale')
  })

  it('★★ 503（Traefik の no available server）→ no-backend。**ok にも stale にもしない**', () => {
    expect(judgeDedicatedProbe({ reached: true, status: 503, body: 'no available server' }, TAG)).toBe('no-backend')
  })

  // D-19b（2026-09-16 の検分）: ここは直す前 `stale`＝「古い内容のまま」と言っていた。だが
  // 404・500 では**目印を1文字も読めていない**のだから、「古い」は確かめていないことの言い切りである
  // （root 経路が同じ 404 を responding に倒していたのと、食い違ってもいた）。
  // エラーが返ったという観測だけを名前にする。
  it('★★ 400 以上の失敗応答（404・500・502）は error-status（読めていない中身を「古い」と言わない）', () => {
    expect(judgeDedicatedProbe({ reached: true, status: 404, body: '404 page not found' }, TAG)).toBe('error-status')
    expect(judgeDedicatedProbe({ reached: true, status: 500, body: '' }, TAG)).toBe('error-status')
    expect(judgeDedicatedProbe({ reached: true, status: 502, body: '' }, TAG)).toBe('error-status')
  })

  it('★ 3xx は届いてはいるが目印は読めていない → stale（成功にはしない）', () => {
    expect(judgeDedicatedProbe({ reached: true, status: 302, body: '' }, TAG)).toBe('stale')
  })

  it('★★ 接続できない → unreachable（「動いていない」の証明にはしない）', () => {
    expect(judgeDedicatedProbe({ reached: false }, TAG)).toBe('unreachable')
  })

  it('★★ 版が分からない（目印が空）なら、200 が返っても ok にしない', () => {
    expect(judgeDedicatedProbe({ reached: true, status: 200, body: '' }, '')).toBe('stale')
  })
})

// ── O-1（2026-09-17）: 「🔎 公開先と https を確かめる」の判定 ──────────────────────
//
// 2026-09-16〜17 の観測: 専有型で公開したが、証明書が一度も発行されていなかった
// （公開された証明書の記録＝CT ログに0件。実際に返るのは `CN=TRAEFIK DEFAULT CERT` の
// 仮証明書）。ブラウザでは「この接続は安全ではありません」が出る。
// **それでも Koto は「✅ 公開しました」と出していた。証明書を一度も見ていなかった。**
//
// ⑧の公開直後の確認（verify）は **DNS を向ける前**に走るので、そこに証明書の検査を
// 足すのは誤り（その時点では仮証明書しか存在し得ない＝時間軸が違う）。押したときに
// 1回だけ調べる別の口にした。ここはその判定（純関数）を固定する。

describe('O-1 judgeDnsMatch: ドメインがロードバランサを向いているか', () => {
  const REC = ['203.0.113.10', '203.0.113.11']

  it('記録と1つでも一致すれば match', () => {
    expect(judgeDnsMatch(['203.0.113.10'], REC)).toBe('match')
    expect(judgeDnsMatch(['198.51.100.7', '203.0.113.11'], REC)).toBe('match')
  })

  it('どれとも一致しなければ mismatch', () => {
    expect(judgeDnsMatch(['198.51.100.7'], REC)).toBe('mismatch')
  })

  it('引けなかった（null）なら unknown、0件なら not-found（この2つは別物）', () => {
    expect(judgeDnsMatch(null, REC)).toBe('unknown')
    expect(judgeDnsMatch([], REC)).toBe('not-found')
  })

  it('★★ 記録が空なら no-record（mismatch へも、引けなかった unknown へも倒さない）', () => {
    // 検分（2026-09-17）: 「比べる相手が無い」と「引けなかった」は原因が違う＝次の一手も違う。
    // 混ぜると「この端末から調べられませんでした」と、誤った原因を断定することになる。
    expect(judgeDnsMatch(['203.0.113.10'], [])).toBe('no-record')
    expect(judgeDnsMatch([], [])).toBe('no-record')
    expect(judgeDnsMatch(null, [])).toBe('no-record')
    // 記録があって引けなかったときだけ unknown
    expect(judgeDnsMatch(null, REC)).toBe('unknown')
  })
})

describe('O-1 judgeDnsLookupError: 断られた理由が「A レコードが無い」か（検分・2026-09-17）', () => {
  it('★★ その名前に A レコードが無いと DNS が答えた → not-found（本物の resolve4 は0件でも断る）', () => {
    for (const c of ['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'NOTFOUND', 'enotfound']) {
      expect(judgeDnsLookupError(c), c).toBe('not-found')
    }
  })

  it('★★ 答えが得られなかっただけなら unknown（「向き先が無い」と断定しない）', () => {
    for (const c of ['ESERVFAIL', 'EAI_AGAIN', 'ETIMEOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'EREFUSED', '', null, undefined]) {
      expect(judgeDnsLookupError(c), String(c)).toBe('unknown')
    }
  })
})

describe('O-1 judgePeerCertificate: 相手の証明書の状態', () => {
  const HOST = 'app.example.com'
  const NOW = Date.parse('2026-09-17T00:00:00Z')
  const OK_CERT = {
    subject: { CN: 'app.example.com' },
    issuer: { CN: 'R11', O: "Let's Encrypt", C: 'US' },
    subjectaltname: 'DNS:app.example.com',
    valid_from: 'Sep  1 00:00:00 2026 GMT',
    valid_to: 'Dec  1 00:00:00 2026 GMT',
  }

  it('★★ ロードバランサの既定の証明書（CN=TRAEFIK DEFAULT CERT）→ not-issued（2026-09-16 に実際に返ってきた形）', () => {
    expect(judgePeerCertificate({
      subject: { CN: 'TRAEFIK DEFAULT CERT' },
      issuer: { CN: 'TRAEFIK DEFAULT CERT' },
      valid_from: 'Sep 16 00:00:00 2026 GMT',
      valid_to: 'Sep 16 00:00:00 2027 GMT',
    }, HOST, NOW)).toBe('not-issued')
  })

  it('★★ 発行者と持ち主が同じ（自分で自分に出した証明書）→ not-issued', () => {
    expect(judgePeerCertificate({
      subject: { CN: 'app.example.com', O: 'Acme' },
      issuer: { CN: 'app.example.com', O: 'Acme' },
      subjectaltname: 'DNS:app.example.com',
      valid_from: 'Sep  1 00:00:00 2026 GMT',
      valid_to: 'Dec  1 00:00:00 2026 GMT',
    }, HOST, NOW)).toBe('not-issued')
  })

  it('★★ 期限切れ → expired', () => {
    expect(judgePeerCertificate({ ...OK_CERT, valid_to: 'Sep  2 00:00:00 2026 GMT' }, HOST, NOW)).toBe('expired')
  })

  it('★★ まだ有効期間に入っていない → not-yet-valid（「期限が切れています」と言わない・検分 2026-09-17）', () => {
    // 端末の時計がずれている／発行直後で開始時刻が未来、のどちらでも起きる。入れ直しではなく待つのが次の一手。
    expect(judgePeerCertificate({ ...OK_CERT, valid_from: 'Oct  1 00:00:00 2026 GMT' }, HOST, NOW)).toBe('not-yet-valid')
    const line = siteCheckLines({ dns: 'match', cert: 'not-yet-valid', httpsOpen: 'rejected', app: null })[1]
    expect(line).not.toContain('期限が切れています')
    expect(line).toContain('まだ有効な期間に入っていません')
  })

  it('★★ このホスト名を含まない → name-mismatch', () => {
    expect(judgePeerCertificate({
      ...OK_CERT, subject: { CN: 'other.example.com' }, subjectaltname: 'DNS:other.example.com',
    }, HOST, NOW)).toBe('name-mismatch')
  })

  it('★★ ワイルドカード（*.example.com）は app.example.com を含むと見なす', () => {
    expect(judgePeerCertificate({
      ...OK_CERT, subject: { CN: '*.example.com' }, subjectaltname: 'DNS:*.example.com',
    }, HOST, NOW)).toBe('issued')
    // 1段だけ。裸のドメインも、2段下も含まない（ブラウザと同じ扱い）
    expect(certNameCovers('*.example.com', 'example.com')).toBe(false)
    expect(certNameCovers('*.example.com', 'a.b.example.com')).toBe(false)
    expect(certNameCovers('*.example.com', 'APP.Example.com')).toBe(true)
  })

  it('正しい証明書 → issued（subjectaltname だけに名前があっても通る）', () => {
    expect(judgePeerCertificate(OK_CERT, HOST, NOW)).toBe('issued')
    expect(judgePeerCertificate({
      ...OK_CERT, subject: { O: 'Example Inc' }, subjectaltname: 'DNS:app.example.com, DNS:www.example.com',
    }, HOST, NOW)).toBe('issued')
  })

  it('★★ null・空・形が違う → unknown（issued に倒さない）', () => {
    expect(judgePeerCertificate(null, HOST, NOW)).toBe('unknown')
    expect(judgePeerCertificate(undefined, HOST, NOW)).toBe('unknown')
    expect(judgePeerCertificate({}, HOST, NOW)).toBe('unknown')
    expect(judgePeerCertificate({ subject: 'app.example.com' } as any, HOST, NOW)).toBe('unknown')
    expect(judgePeerCertificate({ issuer: { CN: 'R11' } }, HOST, NOW)).toBe('unknown') // 名前が1つも読めない
    expect(judgePeerCertificate({ subject: { CN: 'app.example.com' } }, HOST, NOW)).toBe('unknown') // 発行者が読めない
  })

  it('★ 有効期間が読めないときに「期限切れ」と言わない（確かめていないことを断定しない）', () => {
    const noDates = { subject: OK_CERT.subject, issuer: OK_CERT.issuer, subjectaltname: OK_CERT.subjectaltname }
    expect(judgePeerCertificate(noDates, HOST, NOW)).toBe('issued')
  })

  it('★ 発行者が Let\'s Encrypt かどうかで通す／通さないを決めない（利用者が自分で入れた証明書も通る）', () => {
    expect(judgePeerCertificate({ ...OK_CERT, issuer: { CN: 'Acme Private CA', O: 'Acme' } }, HOST, NOW)).toBe('issued')
    // 発行者の名前は別に取れる（文面に添えるため。判定には使わない）
    expect(certIssuerName(OK_CERT)).toContain("Let's Encrypt")
    expect(certIssuerName(null)).toBe(null)
  })
})

describe('O-1 judgeHttpsOpenError: 切られた理由が証明書のせいか', () => {
  it('★ 証明書が理由なら rejected（ブラウザでも同じ警告が出る）', () => {
    for (const c of ['DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
      expect(judgeHttpsOpenError(c)).toBe('rejected')
    }
  })

  it('★★ 繋がらなかっただけのときは unknown（証明書が悪い証拠にしない）', () => {
    for (const c of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', '', null, undefined]) {
      expect(judgeHttpsOpenError(c)).toBe('unknown')
    }
  })
})

describe('O-1 siteCheckLines: 画面に出す行（1行につき1つの軸）', () => {
  it('★★ 4つの軸が別々の行に出る（混ざらない）', () => {
    const lines = siteCheckLines({ dns: 'match', cert: 'issued', httpsOpen: 'ok', app: 'responding' })
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('ドメイン')
    expect(lines[1]).toContain('証明書')
    expect(lines[2]).toContain('ブラウザ')
    expect(lines[3]).toContain('アプリ')
    // 1行に2つの軸を詰めない
    expect(lines[0]).not.toContain('証明書')
    expect(lines[1]).not.toContain('アプリ')
  })

  it('★★ 証明書は出ていて、アプリは応答していない——両方が別々に読み取れる', () => {
    const lines = siteCheckLines({ dns: 'match', cert: 'issued', httpsOpen: 'ok', app: 'no-backend' })
    expect(lines[1]).toBe('✅ https の証明書が発行されています')
    expect(lines[3].startsWith('❌')).toBe(true)
    expect(lines[3]).toContain('アプリがまだ応答していません')
    // アプリの文は⑧と同じ一元定義（同じ観測に2つの言い方を作らない・掟10）
    expect(lines[3]).toBe(dedicatedVerifyMessage('no-backend'))
  })

  it('★★ 証明書が出ていないことと、確かめられなかったことを書き分ける（掟1）', () => {
    const notIssued = siteCheckLines({ dns: 'match', cert: 'not-issued', httpsOpen: 'rejected', app: 'responding' })
    expect(notIssued[1]).toContain('まだ発行されていません')
    const unknown = siteCheckLines({ dns: 'unknown', cert: 'unknown', httpsOpen: 'unknown', app: null })
    for (const line of unknown) {
      expect(line.startsWith('ℹ️')).toBe(true)
      expect(line).toContain('確かめられませんでした')
      expect(line).not.toContain('ありません（')
    }
  })

  it('★★ ドメインが別の場所を向いているとき、下の3行を ✅ で出さない（検分・2026-09-17）', () => {
    // 「いま別のところで動いているサイトを、これから Koto に移す」場面。証明書・ブラウザ・アプリの
    // 3軸はホスト名で繋いで調べるので、見ているのは**いまドメインが向いている先**であって、
    // このアプリではない。4行のうち3行が緑だと「だいたい出来ている」と読まれる。
    const lines = siteCheckLines({ dns: 'mismatch', cert: 'issued', httpsOpen: 'ok', app: 'responding' })
    expect(lines[0].startsWith('❌')).toBe(true)
    for (const line of lines.slice(1)) {
      expect(line, `✅ のまま出ている: ${line}`).not.toMatch(/^✅/)
      expect(line).toContain('このアプリのものとは限りません')
    }
    // ドメインが向いていると確かめられたときは、そのまま ✅（不必要に悪い側へも倒さない）
    const ok = siteCheckLines({ dns: 'match', cert: 'issued', httpsOpen: 'ok', app: 'responding' })
    expect(ok.slice(1).every(l => l.startsWith('✅'))).toBe(true)
    for (const dns of ['not-found', 'no-record', 'unknown'] as const) {
      const other = siteCheckLines({ dns, cert: 'issued', httpsOpen: 'ok', app: 'responding' })
      expect(other.slice(1).some(l => l.startsWith('✅')), dns).toBe(false)
    }
  })

  it('★★ 比べる先の IP が記録に無いとき、原因を「この端末」と断定しない（検分・2026-09-17）', () => {
    // ⑧は「IP がまだ取れていません」＋「🔄 IP を取り直す」の下にもこのボタンを出す。
    const line = siteCheckLines({ dns: 'no-record', cert: 'unknown', httpsOpen: 'unknown', app: null })[0]
    expect(line).not.toContain('この端末から調べられませんでした')
    expect(line).toContain('🔄 IP を取り直す')
    // 本当に引けなかったときだけ「この端末から」と言う
    expect(siteCheckLines({ dns: 'unknown', cert: 'unknown', httpsOpen: 'unknown', app: null })[0])
      .toContain('この端末から調べられませんでした')
  })

  it('★ 並びは ドメイン → 証明書 → ブラウザ → アプリ（先に直すべきものが上）', () => {
    const lines = siteCheckLines({ dns: 'not-found', cert: 'not-issued', httpsOpen: 'rejected', app: 'unreachable' })
    expect(lines[0]).toContain('ドメインの向き先が見つかりません')
    expect(lines[1]).toContain('証明書')
    expect(lines[2]).toContain('ブラウザ')
  })

  it('★ 各行の頭は ✅／⚠️／❌／ℹ️ のどれか。次の一手が要る行には、それも書く', () => {
    const all: Array<Parameters<typeof siteCheckLines>[0]> = []
    for (const dns of ['match', 'mismatch', 'not-found', 'no-record', 'unknown'] as const) {
      for (const cert of ['issued', 'not-issued', 'name-mismatch', 'expired', 'not-yet-valid', 'unknown'] as const) {
        for (const httpsOpen of ['ok', 'rejected', 'unknown'] as const) {
          for (const app of ['ok', 'stale', 'responding', 'error-status', 'no-backend', 'unreachable', null] as const) {
            all.push({ dns, cert, httpsOpen, app })
          }
        }
      }
    }
    for (const r of all) {
      for (const line of siteCheckLines(r)) {
        expect(line, `頭に印が無い: ${line}`).toMatch(/^(✅|⚠️|❌|ℹ️)/)
      }
    }
    // 直し方が要る行には、次に何をするかが書いてある
    expect(siteCheckLines({ dns: 'not-found', cert: 'unknown', httpsOpen: 'unknown', app: null })[0]).toContain('A レコード')
    expect(siteCheckLines({ dns: 'match', cert: 'not-issued', httpsOpen: 'rejected', app: null })[1]).toContain('もう一度')
    expect(siteCheckLines({ dns: 'match', cert: 'expired', httpsOpen: 'rejected', app: null })[1]).toContain('コントロールパネル')
  })

  it('★★ 内部用語・専門用語（SNI・SAN・自己署名・コモンネーム）が1つも出ない（非エンジニア向け）', () => {
    const lines: string[] = []
    for (const dns of ['match', 'mismatch', 'not-found', 'no-record', 'unknown'] as const) {
      for (const cert of ['issued', 'not-issued', 'name-mismatch', 'expired', 'not-yet-valid', 'unknown'] as const) {
        for (const httpsOpen of ['ok', 'rejected', 'unknown'] as const) {
          for (const app of ['ok', 'responding', 'no-backend', 'unreachable', null] as const) {
            lines.push(...siteCheckLines({ dns, cert, httpsOpen, app }))
          }
        }
      }
    }
    for (const line of lines) {
      expect(line, `内部用語が出ている: ${line}`).not.toMatch(/SNI|SANs?|自己署名|コモンネーム|実機|検分|変異試験|ワイルドカード|CN=|Traefik|TRAEFIK/)
    }
  })
})
