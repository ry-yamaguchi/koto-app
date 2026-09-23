#!/usr/bin/env node
// probe-dedicated-nodes.mjs — AppRun 専有型の「ノードのアドレスの実物」を実測する GET だけの道具。
//
// ── なぜ要るか（docs/apprun-dedicated-plan.md 12-4）─────────────────────
// 段階③（記録）⑤（アプリ公開）の設計には、次の2点が「実測で確かめること」として残っている:
//   ・GET .../load_balancer_nodes の addresses の実物（vip の有無・台数）
//   ・GET .../worker_nodes の networkInterfaces の実物
//   ・GET /applications?clusterID= の空応答の形（トップレベルのキー・件数・nextCursor）
// これは「作る→壊す」（5-11・#39）で実際にクラスタ・ASG・LB を作った**直後**に、
// Ryosuke さんが手で実行して結果を貼ってもらう想定の道具（掟1: 推測しない・実測で決める）。
//
// ── 手順 ──────────────────────────────────────────────────────────────
//   ① GET /clusters?maxItems=20                              クラスタ一覧
//   ② GET /clusters/{c}                                      クラスタ詳細（Let's Encrypt・ポート）
//   ③ GET /clusters/{c}/asg?maxItems=20                       ASG 一覧
//   ④ GET .../asg/{a}/worker_nodes?maxItems=20                ワーカノード（★アドレス実物）
//   ⑤ GET .../asg/{a}/load_balancers?maxItems=20              LB 一覧
//   ⑥ GET .../load_balancers/{l}/load_balancer_nodes?maxItems=20  LBノード（★アドレス・vip実物）
//   ⑦ GET /applications?clusterID={c}&maxItems=20             アプリ一覧（★応答の生の形）
//
// ── 安全性 ────────────────────────────────────────────────────────────
// **このスクリプトは GET しか行わない。** POST/PUT/PATCH/DELETE は1つも書いていない。
// 何も作らず、何も変えず、何も消さない。課金は発生しない。
//
// クラスタID・ASGID・LBID・ワーカノードID・LBノードID・サービスプリンシパルIDは
// **値だけを伏せ字にする（キー名は出す）**。末尾4文字だけ残し、残りは `*` にする
// （scripts/probe-monitoring-suite.mjs の maskTail と同じ考え方）。
// 一方で、**ワーカノード／LBノードのアドレスと vip は伏せない**（これを実測するのが目的のため）。
//
// ── 使い方 ────────────────────────────────────────────────────────────
//   SAKURA_TOKEN=<アクセストークン> SAKURA_SECRET=<シークレット> \
//     node scripts/probe-dedicated-nodes.mjs
//
//   （SAKURA_CLOUD_TOKEN と SAKURA_CLOUD_SECRET でも可。Koto の「認証情報」に保存済みのキーと同じもの）
//
// ⚠️ 資格情報は画面に出さない。**出力**を貼るのは安全。
// ⚠️ ただし**実行したコマンドそのものを貼らないこと**（環境変数にトークンの実物が載る）。
//    貼るのは区切り線から下の「出力だけ」でよい。

const BASE = 'https://secure.sakura.ad.jp/cloud/api/apprun-dedicated/1.0/'
const TOKEN = process.env.SAKURA_TOKEN || process.env.SAKURA_CLOUD_TOKEN || ''
const SECRET = process.env.SAKURA_SECRET || process.env.SAKURA_CLOUD_SECRET || ''

const MAX_BODY_CHARS = 4000

const c = {
  g: s => `\x1b[32m${s}\x1b[0m`,
  r: s => `\x1b[31m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`,
  d: s => `\x1b[2m${s}\x1b[0m`,
}
const ok = s => console.log(`  ${c.g('✅')} ${s}`)
const ng = s => console.log(`  ${c.r('❌')} ${s}`)
const info = s => console.log(`  ${c.d(s)}`)

/** ID の値だけを伏せる（キー名は呼び出し側がそのまま出す）。末尾4文字だけ残す。 */
function maskId(value) {
  if (value === null || value === undefined) return String(value)
  const s = String(value)
  return s.length <= 4 ? '*'.repeat(s.length) : '*'.repeat(s.length - 4) + s.slice(-4)
}

/** オブジェクトを再帰的に歩き、キー名が ID で終わる文字列の値だけを伏せる（形はそのまま見せる）。 */
function maskIdsDeep(v) {
  if (Array.isArray(v)) return v.map(maskIdsDeep)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) out[k] = (/ID$/.test(k) && typeof val === 'string') ? maskId(val) : maskIdsDeep(val)
    return out
  }
  return v
}

/** 4000字を超える本文は打ち切り、打ち切った事実（省略した字数）を明記する（道具が事実を隠さない）。 */
function truncateBody(text) {
  const body = text ?? ''
  if (body.length <= MAX_BODY_CHARS) return body
  return body.slice(0, MAX_BODY_CHARS) + `\n…（${body.length - MAX_BODY_CHARS} 字省略）`
}

/** GET だけを行う。**書き込み系メソッドは意図的に実装していない**（誤って課金・変更しないため）。 */
async function get(pathStr) {
  const url = BASE + pathStr.replace(/^\//, '')
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${TOKEN}:${SECRET}`, 'utf-8').toString('base64'),
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    return { ok: res.ok, status: res.status, data, text }
  } catch (e) {
    return { ok: false, status: undefined, data: null, text: '', error: e?.message ?? String(e) }
  }
}

/**
 * 失敗応答をそのまま出す（要約しない）。
 * 掟10「確かめられないときは生の応答を載せる」・2026-09-07 の教訓（道具が失敗の中身を隠していた）。
 */
function showFailure(label, r) {
  if (r.error) {
    ng(`${label} → 通信失敗: ${r.error}`)
    return
  }
  ng(`${label} → HTTP ${r.status}`)
  const raw = truncateBody(r.text)
  if (raw) {
    console.log('    応答本文（そのまま）:')
    console.log(raw.split('\n').map(l => '      ' + l).join('\n'))
  }
}

async function main() {
  if (!TOKEN || !SECRET) {
    console.error('使い方:')
    console.error('  SAKURA_TOKEN=<アクセストークン> SAKURA_SECRET=<シークレット> \\')
    console.error('    node scripts/probe-dedicated-nodes.mjs')
    console.error()
    console.error('  （SAKURA_CLOUD_TOKEN と SAKURA_CLOUD_SECRET でも構いません）')
    console.error()
    console.error('⚠️ 結果は出力だけを貼ってください。コマンド行（環境変数にトークンの実物が載ります）は貼らないでください。')
    process.exit(1)
  }

  console.log(c.d('※ このスクリプトは GET しか行いません。何も作らず・何も変えず、課金も発生しません。'))
  console.log(c.d('※ ID（clusterID 等）は末尾4文字だけ表示します。ノードのアドレス・vip は伏せずそのまま出します。'))

  // ── ① クラスタ一覧 ──────────────────────────────────────────────────
  console.log('\n① クラスタ一覧 GET /clusters?maxItems=20')
  const clustersRes = await get('clusters?maxItems=20')
  /** @type {Array<{clusterID:string,name:string,created:number}>} */
  let clusters = []
  if (!clustersRes.ok) {
    showFailure('GET /clusters', clustersRes)
  } else {
    clusters = Array.isArray(clustersRes.data?.clusters) ? clustersRes.data.clusters : []
    ok(`件数: ${clusters.length}`)
    if (clusters.length === 0) {
      info('クラスタが 0 件です。このスクリプトは⑤でクラスタを作った直後（⑥で壊す前）に実行してください。')
    }
    for (const cl of clusters) {
      info(`- name: ${cl?.name}  created: ${cl?.created}  clusterID: ${maskId(cl?.clusterID)}`)
    }
  }

  // ── ② クラスタ詳細 ──────────────────────────────────────────────────
  console.log('\n② クラスタ詳細 GET /clusters/{c}（各クラスタ）')
  for (const cl of clusters) {
    const cid = cl?.clusterID
    const r = await get(`clusters/${encodeURIComponent(cid)}`)
    if (!r.ok) { showFailure(`GET /clusters/${maskId(cid)}`, r); continue }
    const detail = r.data?.cluster ?? {}
    ok(`clusterID: ${maskId(cid)}`)
    info(`  hasLetsEncryptEmail: ${detail.hasLetsEncryptEmail}`)
    info(`  servicePrincipalID: ${maskId(detail.servicePrincipalID)}`)
    info(`  ports: ${JSON.stringify(detail.ports ?? [])}`)
  }

  // ── ③ ASG 一覧 ──────────────────────────────────────────────────────
  console.log('\n③ ASG一覧 GET /clusters/{c}/asg?maxItems=20（各クラスタ）')
  /** @type {Array<{clusterID:string,autoScalingGroupID:string}>} */
  let asgEntries = []
  for (const cl of clusters) {
    const cid = cl?.clusterID
    const r = await get(`clusters/${encodeURIComponent(cid)}/asg?maxItems=20`)
    if (!r.ok) { showFailure(`GET /clusters/${maskId(cid)}/asg`, r); continue }
    const list = Array.isArray(r.data?.autoScalingGroups) ? r.data.autoScalingGroups : []
    ok(`clusterID ${maskId(cid)} の ASG 件数: ${list.length}`)
    for (const a of list) {
      info(`- name: ${a?.name}  zone: ${a?.zone}  minNodes: ${a?.minNodes}  maxNodes: ${a?.maxNodes}  workerNodeCount: ${a?.workerNodeCount}  deleting: ${a?.deleting}  autoScalingGroupID: ${maskId(a?.autoScalingGroupID)}`)
      asgEntries.push({ clusterID: cid, autoScalingGroupID: a?.autoScalingGroupID })
    }
  }

  // ── ④ ワーカノード（★アドレスの実物） ────────────────────────────────
  console.log('\n④ ワーカノード GET .../asg/{a}/worker_nodes?maxItems=20（各ASG）')
  for (const entry of asgEntries) {
    const { clusterID: cid, autoScalingGroupID: aid } = entry
    const r = await get(`clusters/${encodeURIComponent(cid)}/asg/${encodeURIComponent(aid)}/worker_nodes?maxItems=20`)
    if (!r.ok) { showFailure(`GET .../asg/${maskId(aid)}/worker_nodes`, r); continue }
    const list = Array.isArray(r.data?.workerNodes) ? r.data.workerNodes : []
    ok(`ASG ${maskId(aid)} のワーカノード件数: ${list.length}`)
    for (const wn of list) {
      info(`- status: ${wn?.status}  draining: ${wn?.draining}  workerNodeID: ${maskId(wn?.workerNodeID)}`)
      const ifaces = Array.isArray(wn?.networkInterfaces) ? wn.networkInterfaces : []
      for (const ni of ifaces) {
        const addrs = Array.isArray(ni?.addresses) ? ni.addresses : []
        for (const addr of addrs) {
          info(`    interfaceIndex ${ni?.interfaceIndex}  address: ${addr?.address}`)
        }
      }
    }
  }

  // ── ⑤ ロードバランサ一覧 ────────────────────────────────────────────
  console.log('\n⑤ ロードバランサ一覧 GET .../asg/{a}/load_balancers?maxItems=20（各ASG）')
  /** @type {Array<{clusterID:string,autoScalingGroupID:string,loadBalancerID:string}>} */
  let lbEntries = []
  for (const entry of asgEntries) {
    const { clusterID: cid, autoScalingGroupID: aid } = entry
    const r = await get(`clusters/${encodeURIComponent(cid)}/asg/${encodeURIComponent(aid)}/load_balancers?maxItems=20`)
    if (!r.ok) { showFailure(`GET .../asg/${maskId(aid)}/load_balancers`, r); continue }
    const list = Array.isArray(r.data?.loadBalancers) ? r.data.loadBalancers : []
    ok(`ASG ${maskId(aid)} のロードバランサ件数: ${list.length}`)
    for (const lb of list) {
      info(`- name: ${lb?.name}  serviceClassPath: ${lb?.serviceClassPath}  deleting: ${lb?.deleting}  loadBalancerID: ${maskId(lb?.loadBalancerID)}`)
      lbEntries.push({ clusterID: cid, autoScalingGroupID: aid, loadBalancerID: lb?.loadBalancerID })
    }
  }

  // ── ⑥ LBノード（★アドレス・vip の実物） ──────────────────────────────
  console.log('\n⑥ LBノード GET .../load_balancers/{l}/load_balancer_nodes?maxItems=20（各LB）')
  for (const entry of lbEntries) {
    const { clusterID: cid, autoScalingGroupID: aid, loadBalancerID: lid } = entry
    const r = await get(`clusters/${encodeURIComponent(cid)}/asg/${encodeURIComponent(aid)}/load_balancers/${encodeURIComponent(lid)}/load_balancer_nodes?maxItems=20`)
    if (!r.ok) { showFailure(`GET .../load_balancers/${maskId(lid)}/load_balancer_nodes`, r); continue }
    const list = Array.isArray(r.data?.loadBalancerNodes) ? r.data.loadBalancerNodes : []
    ok(`LB ${maskId(lid)} のノード件数: ${list.length}`)
    info(`  生の形（ID は伏せ字・そのまま）: ${truncateBody(JSON.stringify(maskIdsDeep(r.data)))}`)
    for (const node of list) {
      info(`- status: ${node?.status}  loadBalancerNodeID: ${maskId(node?.loadBalancerNodeID)}`)
      const ifaces = Array.isArray(node?.interfaces) ? node.interfaces : []
      for (const ni of ifaces) {
        const addrs = Array.isArray(ni?.addresses) ? ni.addresses : []
        for (const addr of addrs) {
          info(`    interfaceIndex ${ni?.interfaceIndex}  address: ${addr?.address}  vip: ${addr?.vip}`)
        }
      }
    }
  }

  // ── ⑦ アプリケーション一覧（★応答の生の形） ──────────────────────────
  console.log('\n⑦ アプリケーション一覧 GET /applications?clusterID={c}&maxItems=20（各クラスタ・応答の生の形）')
  for (const cl of clusters) {
    const cid = cl?.clusterID
    const r = await get(`applications?clusterID=${encodeURIComponent(cid)}&maxItems=20`)
    if (!r.ok) { showFailure(`GET /applications?clusterID=${maskId(cid)}`, r); continue }
    const topLevelKeys = r.data && typeof r.data === 'object' ? Object.keys(r.data) : []
    const apps = Array.isArray(r.data?.applications) ? r.data.applications : []
    const nextCursor = r.data && typeof r.data === 'object' ? r.data.nextCursor : undefined
    ok(`clusterID ${maskId(cid)}`)
    info(`  トップレベルのキー: ${topLevelKeys.join(', ') || '(なし)'}`)
    info(`  applications 件数: ${apps.length}`)
    info(`  nextCursor: ${nextCursor === null || nextCursor === undefined ? String(nextCursor) : maskId(nextCursor)}`)
    info(`  生の形（ID は伏せ字・そのまま）: ${truncateBody(JSON.stringify(maskIdsDeep(r.data)))}`)
  }

  console.log('\n' + '─'.repeat(70))
  console.log('この出力だけを貼ってください（コマンド行は貼らないでください。環境変数にトークンの実物が載ります）。')
}

if (process.argv[1] && process.argv[1].endsWith('probe-dedicated-nodes.mjs')) {
  main().catch(e => {
    console.error('\n❌ 途中で落ちました:', e?.message ?? e)
    process.exit(1)
  })
}
