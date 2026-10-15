import { describe, it, expect } from 'vitest'
import {
  readLimits,
  readWorkerClasses,
  readLbClasses,
  readClusters,
  readClusterIDs,
  readAsgIDs,
  readAsgIdRows,
  readLoadBalancerIDs,
  readLoadBalancerIdRows,
  readClusterId,
  readAsgId,
  readLoadBalancerId,
  readApiErrorTitle,
  readZones,
  isZonesShape,
  readNextCursor,
  readApplicationRows,
  readApplicationIDs,
  readApplicationId,
  readApplication,
  readVersionNumber,
  readVersionRows,
  readWorkerNodeAddresses,
  readLoadBalancerNodeAddresses,
  readContainerStates, isContainerStopped, countRunningContainers, readRunningContainerCount,
  readHasLetsEncryptEmail,
  readClusterPorts,
} from '../src/shared/apprunDedicatedShapes'

// roadmap #23。docs/apprun-dedicated-plan.md 5-8 の表（OpenAPI原本 v1.4.0 と2026-09-07の実測の
// 両方で裏を取った、実物の応答の形）が唯一の正。
//
// **方針の固定**: 形が違えば null / 空配列を返す。**別のキーを当てにいく後方互換の推測を足さない**
// ——それが v0.6.8 で配布された事故（extractLimits が data.clusterCount を、unwrapList が
// 'service_classes'/'clusters'/'data'/'items'/'plans'/'worker'/'lb' を試していたが、実物は
// limit.clusterCount と workerServiceClasses/lbServiceClasses だった）の原因だったから。
// このテストは「実物の形から正しく読めること」と「形が違えば推測で拾わず null/空を返すこと」の
// 両方を固定する。

describe('readLimits: GET /limits は { limit: {...} } の入れ子（5-8）', () => {
  it('実物の形から読める', () => {
    const data = {
      limit: {
        clusterCount: 3,
        autoScalingGroupCount: 6,
        workerNodeCount: 14,
        loadBalancerNodeCount: 6,
        applicationCount: 10,
        applicationVersionCountPerApplication: 50,
      },
    }
    expect(readLimits(data)).toEqual({
      clusterCount: 3,
      autoScalingGroupCount: 6,
      workerNodeCount: 14,
      loadBalancerNodeCount: 6,
      applicationCount: 10,
      applicationVersionCountPerApplication: 50,
    })
  })

  it('数値でない値は null にする（文字列や null が混じっても壊れない）', () => {
    expect(readLimits({ limit: { clusterCount: '3', workerNodeCount: null } })).toEqual({
      clusterCount: null,
      workerNodeCount: null,
    })
  })

  it('★事故の再現: フラットな形 { clusterCount: 3 }（旧実装が読んでいた形）は空を返す。推測で拾わない', () => {
    expect(readLimits({ clusterCount: 3, autoScalingGroupCount: 6 })).toEqual({})
  })

  it('limit が無い・配列・nullなら空', () => {
    expect(readLimits({})).toEqual({})
    expect(readLimits({ limit: [1, 2, 3] })).toEqual({})
    expect(readLimits(null)).toEqual({})
    expect(readLimits(undefined)).toEqual({})
  })
})

describe('readWorkerClasses: GET /service_classes/worker は { workerServiceClasses: [...] }（5-8）', () => {
  it('実物の形から読める', () => {
    const data = { workerServiceClasses: [{ name: '1vCPU / 2GB メモリ', path: 'cloud/apprun/dedicated/worker/1vcpu_2gb' }] }
    expect(readWorkerClasses(data)).toEqual([
      { name: '1vCPU / 2GB メモリ', nodeCount: null, path: 'cloud/apprun/dedicated/worker/1vcpu_2gb' },
    ])
  })

  it('★事故の再現: 旧実装が試していたキー（service_classes/plans/worker等）は拾わない', () => {
    expect(readWorkerClasses({ service_classes: [{ name: 'x', path: 'y' }] })).toEqual([])
    expect(readWorkerClasses({ plans: [{ name: 'x', path: 'y' }] })).toEqual([])
    expect(readWorkerClasses({ worker: [{ name: 'x', path: 'y' }] })).toEqual([])
    expect(readWorkerClasses({ data: [{ name: 'x', path: 'y' }] })).toEqual([])
  })

  it('lbServiceClasses のキー（隣の関数の形）は拾わない（取り違え防止）', () => {
    expect(readWorkerClasses({ lbServiceClasses: [{ name: 'x', path: 'y' }] })).toEqual([])
  })

  it('形が無ければ空配列', () => {
    expect(readWorkerClasses({})).toEqual([])
    expect(readWorkerClasses(null)).toEqual([])
  })
})

describe('readLbClasses: GET /service_classes/lb は { lbServiceClasses: [...] }（5-8）', () => {
  it('実物の形から読める（nodeCount も含む）', () => {
    const data = {
      lbServiceClasses: [
        { name: '1vCPU / 2GB メモリ * 1 (非冗長構成)', nodeCount: 1, path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1' },
      ],
    }
    expect(readLbClasses(data)).toEqual([
      { name: '1vCPU / 2GB メモリ * 1 (非冗長構成)', nodeCount: 1, path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1' },
    ])
  })

  it('workerServiceClasses のキー（隣の関数の形）は拾わない（取り違え防止）', () => {
    expect(readLbClasses({ workerServiceClasses: [{ name: 'x', path: 'y' }] })).toEqual([])
  })

  it('形が無ければ空配列', () => {
    expect(readLbClasses({})).toEqual([])
  })
})

describe('readClusters: GET /clusters は { clusters: [...] }（5-8）', () => {
  it('実物の形から読める', () => {
    expect(readClusters({ clusters: [{ clusterID: 'a' }, { clusterID: 'b' }] })).toEqual([{ clusterID: 'a' }, { clusterID: 'b' }])
  })

  it('★事故の再現: 旧実装が試していたキー（data/items）や配列そのものは拾わない', () => {
    expect(readClusters({ data: [{}] })).toEqual([])
    expect(readClusters({ items: [{}] })).toEqual([])
    expect(readClusters([{}, {}])).toEqual([])
  })

  it('形が無ければ空配列', () => {
    expect(readClusters({})).toEqual([])
    expect(readClusters(null)).toEqual([])
  })
})

// C（2026-09-17）: 在否の判定（消えたか）専用のリーダー。readClusterRows は名前探し用のため
// name の無い行を捨てるが、それを在否判定に流用すると「name欠落＝存在しない」という
// 誤判定を生む（原本の仕様逸脱時に限られるが、判定の方針としては明確な誤り）。
describe('readClusterIDs: クラスタの在否判定専用。name が無い行も clusterID があれば拾う', () => {
  it('★ name が無い行でも、clusterID が文字列なら ID を拾う', () => {
    expect(readClusterIDs({ clusters: [{ clusterID: 'a' }, { clusterID: 'b', name: 'x' }] })).toEqual(['a', 'b'])
  })

  it('clusterID が文字列でない行は落とす', () => {
    expect(readClusterIDs({ clusters: [{ clusterID: 123 }, { clusterID: null }, {}] })).toEqual([])
  })

  it('null・文字列・空オブジェクトでも落ちない（形が違えば空配列）', () => {
    expect(readClusterIDs(null)).toEqual([])
    expect(readClusterIDs('not an object')).toEqual([])
    expect(readClusterIDs({})).toEqual([])
  })
})

// M-1（2026-09-17）: readClusterIDs と同じ理由をASG/LB/アプリケーションにも広げる。
// readAsgRows/readLoadBalancerRows/readApplicationRows は名前探し用のため name（や他の必須欄）が
// 無い行を捨てるが、それを在否判定に流用すると「name欠落＝存在しない」という誤判定を生む。
describe('readAsgIDs: ASGの在否判定専用。name が無い行も autoScalingGroupID があれば拾う', () => {
  it('★ name が無い行でも、autoScalingGroupID が文字列なら ID を拾う', () => {
    expect(readAsgIDs({ autoScalingGroups: [{ autoScalingGroupID: 'a' }, { autoScalingGroupID: 'b', name: 'x' }] })).toEqual(['a', 'b'])
  })

  it('autoScalingGroupID が文字列でない行は落とす', () => {
    expect(readAsgIDs({ autoScalingGroups: [{ autoScalingGroupID: 123 }, { autoScalingGroupID: null }, {}] })).toEqual([])
  })

  it('null・文字列・空オブジェクトでも落ちない（形が違えば空配列）', () => {
    expect(readAsgIDs(null)).toEqual([])
    expect(readAsgIDs('not an object')).toEqual([])
    expect(readAsgIDs({})).toEqual([])
  })
})

describe('readLoadBalancerIDs: ロードバランサの在否判定専用。name が無い行も loadBalancerID があれば拾う', () => {
  it('★ name が無い行でも、loadBalancerID が文字列なら ID を拾う', () => {
    expect(readLoadBalancerIDs({ loadBalancers: [{ loadBalancerID: 'a' }, { loadBalancerID: 'b', name: 'x' }] })).toEqual(['a', 'b'])
  })

  it('loadBalancerID が文字列でない行は落とす', () => {
    expect(readLoadBalancerIDs({ loadBalancers: [{ loadBalancerID: 123 }, { loadBalancerID: null }, {}] })).toEqual([])
  })

  it('null・文字列・空オブジェクトでも落ちない（形が違えば空配列）', () => {
    expect(readLoadBalancerIDs(null)).toEqual([])
    expect(readLoadBalancerIDs('not an object')).toEqual([])
    expect(readLoadBalancerIDs({})).toEqual([])
  })
})

describe('readClusterId / readAsgId / readLoadBalancerId: 作成応答からのID取り出し（5-8）', () => {
  it('POST /clusters の実物の形 { cluster: { clusterID } } から読める', () => {
    expect(readClusterId({ cluster: { clusterID: 'cluster-abc123' } })).toBe('cluster-abc123')
  })

  it('POST …/asg の実物の形 { autoScalingGroup: { autoScalingGroupID } } から読める', () => {
    expect(readAsgId({ autoScalingGroup: { autoScalingGroupID: 'asg-abc123' } })).toBe('asg-abc123')
  })

  it('POST …/load_balancers の実物の形 { loadBalancer: { loadBalancerID } } から読める', () => {
    expect(readLoadBalancerId({ loadBalancer: { loadBalancerID: 'lb-abc123' } })).toBe('lb-abc123')
  })

  it('★事故の再現: 旧実装が試していた id/ID/nested.id 等の形は null（推測で拾わない）', () => {
    expect(readClusterId({ id: 'x' })).toBeNull()
    expect(readClusterId({ ID: 'x' })).toBeNull()
    expect(readClusterId({ cluster: { id: 'x' } })).toBeNull() // clusterID ではなく id
    expect(readClusterId({ cluster: { ID: 'x' } })).toBeNull()
  })

  it('資源ごとの取り違えは拾わない（クラスタ作成の応答からASGのIDを読もうとしても null）', () => {
    expect(readAsgId({ cluster: { clusterID: 'cluster-abc123' } })).toBeNull()
    expect(readClusterId({ autoScalingGroup: { autoScalingGroupID: 'asg-abc123' } })).toBeNull()
    expect(readLoadBalancerId({ autoScalingGroup: { autoScalingGroupID: 'asg-abc123' } })).toBeNull()
  })

  it('形が無ければ null', () => {
    expect(readClusterId({})).toBeNull()
    expect(readClusterId(null)).toBeNull()
    expect(readAsgId(undefined)).toBeNull()
  })
})

describe('readZones: GET /zone は { Zones: [...] }（roadmap #28・2026-09-08 実測完了）', () => {
  // 実測の生応答そのもの（docs/apprun-dedicated-plan.md 5-9・2026-09-08 Ryosuke さん実行・6件
  // すべて）。Region の中身は readZones が使わないため、実物と同じ構造だけ再現する。
  const REAL_ZONES_RESPONSE = {
    From: 0,
    Count: 6,
    Total: 6,
    Zones: [
      {
        Index: 0, ID: 21001, DisplayOrder: 20021001, Name: 'tk1a',
        Description: '東京第1ゾーン', IsDummy: false,
        Region: { ID: 210, Name: '東京', Description: '東京' },
      },
      {
        Index: 1, ID: 21002, DisplayOrder: 20021002, Name: 'tk1b',
        Description: '東京第2ゾーン', IsDummy: false,
        Region: { ID: 210, Name: '東京', Description: '東京' },
      },
      {
        Index: 2, ID: 31001, DisplayOrder: 20031001, Name: 'is1a',
        Description: '石狩第1ゾーン', IsDummy: false,
        Region: { ID: 310, Name: '石狩', Description: '石狩' },
      },
      {
        Index: 3, ID: 31002, DisplayOrder: 20031002, Name: 'is1b',
        Description: '石狩第2ゾーン', IsDummy: false,
        Region: { ID: 310, Name: '石狩', Description: '石狩' },
      },
      {
        Index: 4, ID: 31003, DisplayOrder: 20031003, Name: 'is1c',
        Description: '石狩第3ゾーン', IsDummy: false,
        Region: { ID: 310, Name: '石狩', Description: '石狩' },
      },
      {
        // tk1v（Sandbox）だけ IsDummy:true。DisplayOrder は実測の 80029001（5-9）。
        Index: 5, ID: 29001, DisplayOrder: 80029001, Name: 'tk1v',
        Description: 'Sandbox', IsDummy: true,
        Region: { ID: 290, Name: 'Sandbox', Description: 'Sandbox' },
      },
    ],
  }

  it('実測どおりの応答から6件すべて読める（name/description/isDummy/displayOrder）', () => {
    expect(readZones(REAL_ZONES_RESPONSE)).toEqual([
      { name: 'tk1a', description: '東京第1ゾーン', isDummy: false, displayOrder: 20021001 },
      { name: 'tk1b', description: '東京第2ゾーン', isDummy: false, displayOrder: 20021002 },
      { name: 'is1a', description: '石狩第1ゾーン', isDummy: false, displayOrder: 20031001 },
      { name: 'is1b', description: '石狩第2ゾーン', isDummy: false, displayOrder: 20031002 },
      { name: 'is1c', description: '石狩第3ゾーン', isDummy: false, displayOrder: 20031003 },
      { name: 'tk1v', description: 'Sandbox', isDummy: true, displayOrder: 80029001 },
    ])
  })

  it('★推測で拾わない: Zones が無い・配列でない・違う形（小文字の zones 等）なら空配列', () => {
    expect(readZones({})).toEqual([])
    expect(readZones({ Zones: 'not-an-array' })).toEqual([])
    expect(readZones({ Zones: { 0: { Name: 'tk1a' } } })).toEqual([]) // オブジェクトは配列ではない
    expect(readZones({ zones: REAL_ZONES_RESPONSE.Zones })).toEqual([]) // 小文字キーは拾わない
    expect(readZones(null)).toEqual([])
    expect(readZones(undefined)).toEqual([])
  })

  it('Name が無い行は捨てる', () => {
    // ⚠️ tk1v（Sandbox）の IsDummy:true / DisplayOrder:20021006 は**作り物**。実測ではない
    // （probe-zones.mjs の初版が4000字で切っていたため、実測できたのは先頭3件=tk1a/tk1b/is1a
    // だけ。5-9 参照）。ここでは「Name が無い行は捨てる」動作だけを確かめるための値。
    const data = {
      Zones: [
        { Description: '名前なし', IsDummy: false },
        { Name: 'tk1v', Description: 'Sandbox', IsDummy: true, DisplayOrder: 20021006 },
      ],
    }
    expect(readZones(data)).toEqual([
      { name: 'tk1v', description: 'Sandbox', isDummy: true, displayOrder: 20021006 },
    ])
  })

  it('Description/DisplayOrder は型が違えば null にする（推測で埋めない）', () => {
    const data = { Zones: [{ Name: 'tk1c', Description: 123, IsDummy: 'yes', DisplayOrder: '20021003' }] }
    expect(readZones(data)).toEqual([{ name: 'tk1c', description: null, isDummy: null, displayOrder: null }])
  })

  // 事故の直し1（2026-09-08 検分で発見）: 直す前は「IsDummy が boolean でなければ false」に
  // 倒していた。応答の形が変わったとき、それを黙って「本物のゾーン」として選ばせてしまう。
  // 「分からないものは null」にし、選ばせるかどうかは selectableZones 側の判断に委ねる。
  it('IsDummy が boolean でなければ isDummy: null にする（文字列 / 数値 / 欠落 の3通り）', () => {
    expect(readZones({ Zones: [{ Name: 'z1', IsDummy: 'true' } ] })[0].isDummy).toBeNull()
    expect(readZones({ Zones: [{ Name: 'z2', IsDummy: 1 }] })[0].isDummy).toBeNull()
    expect(readZones({ Zones: [{ Name: 'z3' }] })[0].isDummy).toBeNull()
  })
})

// O（2026-09-10 レビューの修理・バッチ3）: 200でも形が想定と違えば「成功・0件」にしない。
// zonesCache.ts の readZones 呼び出しの直前でこれを見る。
describe('isZonesShape: Zones が配列で、かつ Count/Total のどちらかが数値であること', () => {
  it('実測どおりの応答（Count/Total あり・Zonesは配列）は true', () => {
    expect(isZonesShape({ From: 0, Count: 6, Total: 6, Zones: [] })).toBe(true)
  })

  it('Count だけ、Total だけでも true（どちらか一方でよい）', () => {
    expect(isZonesShape({ Count: 1, Zones: [] })).toBe(true)
    expect(isZonesShape({ Total: 1, Zones: [] })).toBe(true)
  })

  it('Zones が無い・配列でない・Count/Total がどちらも無ければ false', () => {
    expect(isZonesShape({ foo: 1 })).toBe(false)
    expect(isZonesShape({ Count: 6, Total: 6, Zones: 'not-an-array' })).toBe(false)
    expect(isZonesShape({ Zones: [] })).toBe(false) // Count/Total どちらも無い
    expect(isZonesShape(null)).toBe(false)
    expect(isZonesShape(undefined)).toBe(false)
    expect(isZonesShape('plain text')).toBe(false)
  })
})

// N（2026-09-10 レビューの修理・バッチ3）: 一覧の続きは `nextCursor` だけを見る
// （原本 v1.4.0。`cursor`/`next` を推測で試さない）。
describe('readNextCursor: nextCursor が非空の string のときだけそれを返す', () => {
  it('nextCursor があれば返す', () => {
    expect(readNextCursor({ clusters: [], nextCursor: 'abc123' })).toBe('abc123')
  })

  it('nextCursor が無い・空文字・文字列でなければ null（続きなし扱い）', () => {
    expect(readNextCursor({ clusters: [] })).toBeNull()
    expect(readNextCursor({ nextCursor: '' })).toBeNull()
    expect(readNextCursor({ nextCursor: 123 })).toBeNull()
    expect(readNextCursor(null)).toBeNull()
  })

  it('★推測で拾わない: cursor/next という別のキー名では拾わない（5-8と同じ事故の形）', () => {
    expect(readNextCursor({ cursor: 'abc123' })).toBeNull()
    expect(readNextCursor({ next: 'abc123' })).toBeNull()
  })
})

describe('readApiErrorTitle: 失敗応答は { status, title }（5-8）', () => {
  it('title があれば返す', () => {
    expect(readApiErrorTitle({ status: 400, title: 'クラスタ名が不正です' })).toBe('クラスタ名が不正です')
  })

  it('title が無い・文字列でない・応答自体が無ければ null', () => {
    expect(readApiErrorTitle({ status: 400 })).toBeNull()
    expect(readApiErrorTitle({ status: 400, title: 123 })).toBeNull()
    expect(readApiErrorTitle(null)).toBeNull()
    expect(readApiErrorTitle('plain text error')).toBeNull()
  })
})

// ── D-1（土台）: アプリケーション・バージョン・ノードのアドレス（roadmap #23 ⑤・12-1） ───────
// 原本（OpenAPI v1.4.0）のスキーマから決め打つ。5-8と同じ方針:
// 「実物の形から読める」「隣の資源のキー（取り違え）は拾わない」「形が無ければ空/null」の3点を固定する。

describe('readApplicationRows: GET /applications は { applications: [ReadApplication…] }（12-1）', () => {
  it('実物の形から読める（4項目に絞る。activeVersion は number）', () => {
    const data = {
      applications: [
        { applicationID: 'app-1', name: 'myapp', clusterID: 'cluster-1', activeVersion: 3, clusterName: 'x', desiredCount: 1, enoughResources: { cpu: true, memory: true }, scalingCooldownSeconds: 300 },
      ],
    }
    expect(readApplicationRows(data)).toEqual([
      { applicationID: 'app-1', name: 'myapp', clusterID: 'cluster-1', activeVersion: 3 },
    ])
  })

  it('activeVersion が null（有効バージョン無し）や型違いは null にする', () => {
    const data = {
      applications: [
        { applicationID: 'a', name: 'n', clusterID: 'c', activeVersion: null },
        { applicationID: 'a2', name: 'n2', clusterID: 'c2', activeVersion: '3' },
      ],
    }
    expect(readApplicationRows(data)).toEqual([
      { applicationID: 'a', name: 'n', clusterID: 'c', activeVersion: null },
      { applicationID: 'a2', name: 'n2', clusterID: 'c2', activeVersion: null },
    ])
  })

  it('applicationID/name/clusterID のいずれか無い行は捨てる', () => {
    const data = { applications: [{ name: 'n', clusterID: 'c', activeVersion: 1 }, { applicationID: 'a', clusterID: 'c' }] }
    expect(readApplicationRows(data)).toEqual([])
  })

  it('★隣の資源のキー（clusters/versions等）は拾わない。形が無ければ空配列', () => {
    expect(readApplicationRows({ clusters: [{ clusterID: 'x', name: 'y' }] })).toEqual([])
    expect(readApplicationRows({ versions: [{ version: 1 }] })).toEqual([])
    expect(readApplicationRows({})).toEqual([])
    expect(readApplicationRows(null)).toEqual([])
  })
})

// M-1（2026-09-17）: readClusterIDs と同じ理由。アプリケーションの在否判定専用。
describe('readApplicationIDs: アプリケーションの在否判定専用。name/clusterID が無い行も applicationID があれば拾う', () => {
  it('★ name/clusterID が無い行でも、applicationID が文字列なら ID を拾う', () => {
    expect(readApplicationIDs({ applications: [{ applicationID: 'a' }, { applicationID: 'b', name: 'x', clusterID: 'c' }] })).toEqual(['a', 'b'])
  })

  it('applicationID が文字列でない行は落とす', () => {
    expect(readApplicationIDs({ applications: [{ applicationID: 123 }, { applicationID: null }, {}] })).toEqual([])
  })

  it('null・文字列・空オブジェクトでも落ちない（形が違えば空配列）', () => {
    expect(readApplicationIDs(null)).toEqual([])
    expect(readApplicationIDs('not an object')).toEqual([])
    expect(readApplicationIDs({})).toEqual([])
  })
})

describe('readApplicationId: POST /applications の { application: { applicationID } }（12-1）', () => {
  it('実物の形から読める', () => {
    expect(readApplicationId({ application: { applicationID: 'app-abc123' } })).toBe('app-abc123')
  })

  it('★隣の資源の形（cluster/autoScalingGroup/loadBalancer）は拾わない', () => {
    expect(readApplicationId({ cluster: { clusterID: 'cluster-1' } })).toBeNull()
    expect(readApplicationId({ autoScalingGroup: { autoScalingGroupID: 'asg-1' } })).toBeNull()
    expect(readApplicationId({ loadBalancer: { loadBalancerID: 'lb-1' } })).toBeNull()
  })

  it('形が無ければ null', () => {
    expect(readApplicationId({})).toBeNull()
    expect(readApplicationId(null)).toBeNull()
    expect(readApplicationId({ application: { id: 'x' } })).toBeNull() // applicationID ではなく id
  })
})

describe('readApplication: GET /applications/{id} の { application: {...} }（原本 ReadApplicationResponse）', () => {
  it('実物の形から読める（原本 example そのまま）', () => {
    const data = {
      application: {
        activeVersion: 3,
        applicationID: 'A0199B39-B361-45B9-8DF4-FC8BE494D690',
        clusterID: '13B9EA83-DDB0-4385-9533-3D693A6A310F',
        clusterName: 'mock-cluster',
        desiredCount: 3,
        enoughResources: { cpu: true, memory: true },
        name: 'my-app',
        scalingCooldownSeconds: 300,
      },
    }
    expect(readApplication(data)).toEqual({
      applicationID: 'A0199B39-B361-45B9-8DF4-FC8BE494D690',
      name: 'my-app',
      clusterID: '13B9EA83-DDB0-4385-9533-3D693A6A310F',
      activeVersion: 3,
      desiredCount: 3,
      enoughResources: { cpu: true, memory: true },
    })
  })

  it('enoughResources.cpu/memory が boolean でなければ null（原本では nullable＝不明の意味）', () => {
    const data = {
      application: {
        applicationID: 'a', name: 'n', clusterID: 'c', activeVersion: null, desiredCount: null,
        enoughResources: { cpu: null, memory: 'yes' },
      },
    }
    expect(readApplication(data)?.enoughResources).toEqual({ cpu: null, memory: null })
  })

  it('applicationID/name/clusterID のいずれか無ければ丸ごと null（形が無い扱い）', () => {
    expect(readApplication({ application: { name: 'n', clusterID: 'c' } })).toBeNull()
  })

  it('★隣の資源の形は拾わない。形が無ければ null', () => {
    expect(readApplication({ cluster: { clusterID: 'x' } })).toBeNull()
    expect(readApplication({})).toBeNull()
    expect(readApplication(null)).toBeNull()
  })
})

describe('readVersionNumber: POST versions の { applicationVersion: { version } }（原本 CreateApplicationVersionResponse）', () => {
  it('実物の形から読める', () => {
    expect(readVersionNumber({ applicationVersion: { version: 3 } })).toBe(3)
  })

  it('★隣の資源の形（application/cluster）は拾わない。形が無ければ null', () => {
    expect(readVersionNumber({ application: { applicationID: 'a' } })).toBeNull()
    expect(readVersionNumber({})).toBeNull()
    expect(readVersionNumber(null)).toBeNull()
    expect(readVersionNumber({ applicationVersion: { version: '3' } })).toBeNull() // 文字列は拾わない
  })
})

describe('readVersionRows: GET .../versions は { versions: [ApplicationVersionSummary…] }（原本 example そのまま）', () => {
  it('実物の形から読める', () => {
    const data = {
      versions: [
        { version: 3, image: 'nginx:2', activeNodeCount: 1, created: 1577836800 },
        { version: 2, image: 'nginx:2', activeNodeCount: 0, created: 1577836800 },
      ],
    }
    expect(readVersionRows(data)).toEqual([
      { version: 3, image: 'nginx:2', activeNodeCount: 1, created: 1577836800 },
      { version: 2, image: 'nginx:2', activeNodeCount: 0, created: 1577836800 },
    ])
  })

  it('4つの必須キーのどれか型が違う行は捨てる', () => {
    const data = { versions: [{ version: '1', image: 'x', activeNodeCount: 0, created: 1 }, { version: 1, image: 'x', activeNodeCount: 0 }] }
    expect(readVersionRows(data)).toEqual([])
  })

  it('★隣の資源のキー（applications等）は拾わない。形が無ければ空配列', () => {
    expect(readVersionRows({ applications: [{}] })).toEqual([])
    expect(readVersionRows({})).toEqual([])
    expect(readVersionRows(null)).toEqual([])
  })
})

describe('readWorkerNodeAddresses: GET worker_nodes は { workerNodes: [WorkerNodeSummary…] }（原本 example）', () => {
  it('実物の形から読める（networkInterfaces[].addresses[].address を平らに集める）', () => {
    const data = {
      workerNodes: [
        {
          workerNodeID: '123e4567-e89b-12d3-a456-426614174002',
          status: 'healthy',
          networkInterfaces: [
            { interfaceIndex: 0, addresses: [{ address: '192.168.0.1' }] },
            { interfaceIndex: 1, addresses: [{ address: '10.0.0.8' }] },
          ],
        },
      ],
    }
    expect(readWorkerNodeAddresses(data)).toEqual([
      { workerNodeID: '123e4567-e89b-12d3-a456-426614174002', status: 'healthy', addresses: ['192.168.0.1', '10.0.0.8'] },
    ])
  })

  it('workerNodeID が無い行は捨てる。networkInterfaces/addresses が無ければ addresses は空配列', () => {
    const data = { workerNodes: [{ status: 'healthy', networkInterfaces: [] }, { workerNodeID: 'w1' }] }
    expect(readWorkerNodeAddresses(data)).toEqual([{ workerNodeID: 'w1', status: null, addresses: [] }])
  })

  it('★隣の資源のキー（loadBalancerNodes等）は拾わない。形が無ければ空配列', () => {
    expect(readWorkerNodeAddresses({ loadBalancerNodes: [{}] })).toEqual([])
    expect(readWorkerNodeAddresses({})).toEqual([])
    expect(readWorkerNodeAddresses(null)).toEqual([])
  })
})

describe('readLoadBalancerNodeAddresses: GET load_balancer_nodes は { loadBalancerNodes: [LoadBalancerNode…] }（原本 example）', () => {
  it('実物の形から読める（interfaces[].addresses[].{address,vip} を平らに集める）', () => {
    const data = {
      loadBalancerNodes: [
        {
          loadBalancerNodeID: '550e8400-e29b-41d4-a716-446655440001',
          status: 'healthy',
          interfaces: [
            { interfaceIndex: 1, addresses: [{ address: '10.0.0.8/24', vip: false }, { address: '10.0.1.2/24', vip: true }] },
          ],
        },
      ],
    }
    expect(readLoadBalancerNodeAddresses(data)).toEqual([
      {
        loadBalancerNodeID: '550e8400-e29b-41d4-a716-446655440001',
        status: 'healthy',
        addresses: [{ address: '10.0.0.8/24', vip: false }, { address: '10.0.1.2/24', vip: true }],
      },
    ])
  })

  it('vip が boolean でなければ null（分からないものを false に倒さない）', () => {
    const data = { loadBalancerNodes: [{ loadBalancerNodeID: 'l1', status: 'healthy', interfaces: [{ interfaceIndex: 0, addresses: [{ address: 'a' }] }] }] }
    expect(readLoadBalancerNodeAddresses(data)[0].addresses).toEqual([{ address: 'a', vip: null }])
  })

  it('loadBalancerNodeID が無い行は捨てる', () => {
    const data = { loadBalancerNodes: [{ status: 'healthy', interfaces: [] }] }
    expect(readLoadBalancerNodeAddresses(data)).toEqual([])
  })

  it('★隣の資源のキー（workerNodes等）は拾わない。形が無ければ空配列', () => {
    expect(readLoadBalancerNodeAddresses({ workerNodes: [{}] })).toEqual([])
    expect(readLoadBalancerNodeAddresses({})).toEqual([])
    expect(readLoadBalancerNodeAddresses(null)).toEqual([])
  })
})

describe('readHasLetsEncryptEmail: GET /clusters/{id} の原本 ReadCluster は hasLetsEncryptEmail: boolean（値は返さない）', () => {
  it('実物の形から読める（true / false）', () => {
    expect(readHasLetsEncryptEmail({ cluster: { clusterID: 'c1', hasLetsEncryptEmail: true } })).toBe(true)
    expect(readHasLetsEncryptEmail({ cluster: { clusterID: 'c1', hasLetsEncryptEmail: false } })).toBe(false)
  })
  it('★推測で拾わない: letsEncryptEmail（文字列の値）があっても、それは原本の応答の形ではないので null', () => {
    expect(readHasLetsEncryptEmail({ cluster: { letsEncryptEmail: 'a@example.com' } })).toBe(null)
  })
  it('boolean でない・形が無ければ null', () => {
    expect(readHasLetsEncryptEmail({ cluster: { hasLetsEncryptEmail: 'true' } })).toBe(null)
    expect(readHasLetsEncryptEmail({})).toBe(null)
    expect(readHasLetsEncryptEmail(null)).toBe(null)
  })
})

// ── readClusterPorts（A・2026-09-17）: GET /clusters/{id} の cluster.ports ─────────────────
// ⑧の公開の流れが、載せる先のクラスタの公開ポート（80/http・443/https）を確かめるのに使う。
// readContainerStates と同じ方針: **配列でなければ null**（0件と読み替えない・掟10）。
// 呼び出し側は null を「分からない」として扱い、公開そのものは止めない（warnings に1行だけ残す）。
describe('readClusterPorts: GET /clusters/{id} の cluster.ports（配列でなければ null＝0件と読み替えない）', () => {
  it('正しい形なら読める', () => {
    const data = { cluster: { clusterID: 'c1', ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }] } }
    expect(readClusterPorts(data)).toEqual([{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }])
  })
  it('★ ports が配列でなければ null（0件と読み替えない）', () => {
    expect(readClusterPorts({ cluster: { clusterID: 'c1' } })).toBe(null) // キーが無い
    expect(readClusterPorts({ cluster: { clusterID: 'c1', ports: 'none' } })).toBe(null) // 文字列
    expect(readClusterPorts({ cluster: { clusterID: 'c1', ports: {} } })).toBe(null) // オブジェクト
    expect(readClusterPorts({ cluster: { clusterID: 'c1', ports: null } })).toBe(null) // null
  })
  it('要素の形が違うものは落とす。全部落ちたら空配列（null ではない）', () => {
    const data = {
      cluster: {
        ports: [
          { port: '80', protocol: 'http' }, // port が文字列
          { port: 443 }, // protocol が無い
          null,
          'not-an-object',
        ],
      },
    }
    expect(readClusterPorts(data)).toEqual([])
  })
  it('一部だけ形が正しければ、正しい要素だけ拾う', () => {
    const data = { cluster: { ports: [{ port: 80, protocol: 'http' }, { port: '443', protocol: 'https' }] } }
    expect(readClusterPorts(data)).toEqual([{ port: 80, protocol: 'http' }])
  })
  it('null・文字列・空オブジェクトでも落ちない', () => {
    expect(readClusterPorts(null)).toBe(null)
    expect(readClusterPorts('not-an-object')).toBe(null)
    expect(readClusterPorts({})).toBe(null)
    expect(readClusterPorts(undefined)).toBe(null)
  })
})

// ── readContainerStates（D-8・2026-09-16）: GET /applications/{id}/containers の**旧い配列の形**と、読めない形 ──────
// ⚠️ この節の形（`{ "nodes": [ { "containersStats": [ { "state", "status", "image" } ], "desired": 1 } ] }`）は、最初の実装
// （2026-09-16）が原本と取り違えて決めた形で、**原本（OpenAPI v1.4.0）の形ではない**。原本の containersStats は
// `{ collectedAtSec, containers: [...] }` のオブジェクト（か null）で、`workerNodeID`・`desired: 1` も原本に無い
// （2026-10-08 に原本を取得して確かめた）。原本の形のテストはこの下の「原本の形（…）を読む（R6-2）」。
// ここは、(1) 旧い配列の形も**読めるなら読む**ことと、(2) **読めない形は null**（0件に倒さない）ことを固定する。
// 値は原本のまま返す（日本語へ言い換えない・全ての値を実測していないため・掟1）。
// **空配列と null は別の意味**: `[]` ＝形として読めて0件（1つも動いていない）／
// `null` ＝形として読めなかった（何台動いているかは分からない）。
describe('readContainerStates: 旧い配列の形（containersStats が配列そのもの）を読めるなら読む／読めない形は null', () => {
  it('原本の形から読める（ノードが複数でも平らに並べる）', () => {
    const data = {
      nodes: [
        { workerNodeID: 'wn-1', desired: 1, containersStats: [{ state: 'running', status: 'healthy', image: 'img:1' }] },
        { workerNodeID: 'wn-2', desired: 1, containersStats: [{ state: 'CrashLoopBackOff', status: 'restarting', image: 'img:1' }] },
      ],
    }
    expect(readContainerStates(data)).toEqual([
      { state: 'running', status: 'healthy' },
      { state: 'CrashLoopBackOff', status: 'restarting' },
    ])
  })

  it('1つのノードに複数のコンテナがあっても、すべて拾う', () => {
    const data = { nodes: [{ desired: 2, containersStats: [{ state: 'a', status: 'b' }, { state: 'c', status: 'd' }] }] }
    expect(readContainerStates(data)).toEqual([{ state: 'a', status: 'b' }, { state: 'c', status: 'd' }])
  })

  it('★state/status のどちらかが文字列でない行があれば、読めた分だけを事実にしない（null＝未確認）', () => {
    const data = { nodes: [{ containersStats: [{ state: 'running' }, { state: 'ok', status: 'ok' }] }] }
    expect(readContainerStates(data)).toBe(null)
    // 行が1件だけ・それが読めないときに [] を返すと、画面が「1つも動いていません」と断定してしまう
    expect(readContainerStates({ nodes: [{ containersStats: [{ state: 1, status: 2 }] }] })).toBe(null)
  })

  it('★隣の形は拾わない（applications・workerNodes・containers 直下など）。形が違えば null', () => {
    expect(readContainerStates({ containers: [{ state: 'running', status: 'healthy' }] })).toBe(null)
    expect(readContainerStates({ workerNodes: [{ containersStats: [{ state: 'running', status: 'healthy' }] }] })).toBe(null)
    expect(readContainerStates({ applications: [{ containersStats: [{ state: 'running', status: 'healthy' }] }] })).toBe(null)
    expect(readContainerStates({ nodes: { containersStats: [{ state: 'running', status: 'healthy' }] } })).toBe(null)
    expect(readContainerStates({ nodes: [{ containersStats: { state: 'running', status: 'healthy' } }] })).toBe(null)
  })

  it('形が無ければ null（null・空・配列でない）', () => {
    expect(readContainerStates({})).toBe(null)
    expect(readContainerStates(null)).toBe(null)
    expect(readContainerStates(undefined)).toBe(null)
    expect(readContainerStates('nodes')).toBe(null)
  })

  // ── 検分の指摘（2026-09-16）: 「読めなかった」を「0件」に倒さない ──────────────────
  //
  // 以前は形が違っても空配列を返していた。呼び出し側はそれを0件として扱い、画面は
  // 「コンテナが1つも動いていません。」と**断定**する。**HTTP が 200 でも、応答の形が原本と
  // 違えば分かることは何も無い。** D-7 の `unknown-read-as-ok` と同じ形なので null に倒す。
  it('★★ ノードに containersStats のキーが無い応答は null（0件に倒さない＝未確認を事実として出さない）', () => {
    // ← これがまさに素通りしていた形。以前の実装はこれを [] と読み、画面は「1つも動いていません」と言い切った
    expect(readContainerStates({ nodes: [{ workerNodeID: 'wn-1', desired: 1 }] })).toBe(null)
    // ノードが混在（片方だけ読める）でも、読めない側があれば全体を未確認に倒す
    expect(readContainerStates({
      nodes: [
        { containersStats: [{ state: 'running', status: 'healthy' }] },
        { workerNodeID: 'wn-2', desired: 1 },
      ],
    })).toBe(null)
    // ノードがオブジェクトですらない
    expect(readContainerStates({ nodes: ['wn-1'] })).toBe(null)
    expect(readContainerStates({ nodes: [null] })).toBe(null)
  })

  it('★★ 原本の形で読めた結果が0件なら空配列（「1つも動いていない」は事実として出してよい）', () => {
    expect(readContainerStates({ nodes: [] })).toEqual([])
    expect(readContainerStates({ nodes: [{ workerNodeID: 'wn-1', desired: 1, containersStats: [] }] })).toEqual([])
  })
})

// ── readContainerStates: 原本（OpenAPI v1.4.0）の形（2026-10-08・R6-2）──────────────────────────
// 原本 ListApplicationContainersResponse の example（2026-10-08 に原本そのものを取得して写した）。
// containersStats は配列ではなく { collectedAtSec, containers: [...] } のオブジェクトで、null もありうる（nullable）。
// ⚠️ 実際の応答はまだ誰も見ていない。ここは原本の example／スキーマの形で固定している（実機で生の応答を見たら、実測へ差し替える）。
const ORIGINAL_EXAMPLE = {
  nodes: [
    {
      nodeID: 'b7e6a1c2-3f4d-4e2a-9b1a-2c3d4e5f6a7b',
      containersStats: {
        collectedAtSec: 1721203200,
        containers: [
          {
            id: 'container-1', image: 'nginx:latest', state: 'running', status: 'Up 5 minutes', cpuUsagePercent: 12.5,
            applicationID: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', applicationVersion: 2,
          },
        ],
      },
      desired: { containers: [] },
    },
    {
      nodeID: 'c8f7b2d3-4e5f-5a6b-8c2d-3e4f5a6b7c8d',
      containersStats: { collectedAtSec: 1721203200, containers: [] },
      desired: {
        containers: [{ applicationID: '9c858901-8a57-4791-81fe-4c455b099bc9', applicationVersion: 1, cpuMillis: 250, memoryMB: 128, image: 'redis:alpine' }],
      },
    },
  ],
}

describe('readContainerStates: 原本の形（containersStats が { collectedAtSec, containers } のオブジェクト）を読む（R6-2）', () => {
  it('★★★ 原本の example が読める（ノードが複数でも平らに。desired は読まない）。直す前は null（読めない）だった', () => {
    expect(readContainerStates(ORIGINAL_EXAMPLE)).toEqual([{ state: 'running', status: 'Up 5 minutes' }])
  })

  it('★★ containers が空のノードだけ → 空配列（原本の形で読めて、コンテナが 0 件）', () => {
    expect(readContainerStates({ nodes: [{ nodeID: 'n1', containersStats: { collectedAtSec: 1, containers: [] }, desired: null }] })).toEqual([])
    expect(readContainerStates({ nodes: [] })).toEqual([])
  })

  it('★★ collectedAtSec が無くても containers が配列なら読める（読むのはコンテナだけ。原本は必須だが、使わない値で読めなくしない）', () => {
    expect(readContainerStates({ nodes: [{ containersStats: { containers: [{ state: 'exited', status: 'Exited (1)' }] } }] })).toEqual([{ state: 'exited', status: 'Exited (1)' }])
  })

  it('★★★ containersStats が null のノード（原本で nullable）: 読めたコンテナがあればそれを返し、他に何も読めないときは null（「0 件」とは言い切れない）', () => {
    const nullNode = { nodeID: 'n0', containersStats: null, desired: null }
    // 他のノードで読めたコンテナはそのまま（null のノードが、読めた事実を打ち消さない）
    expect(readContainerStates({ nodes: [nullNode, ORIGINAL_EXAMPLE.nodes[0]] })).toEqual([{ state: 'running', status: 'Up 5 minutes' }])
    // null のノードだけ → 未確認
    expect(readContainerStates({ nodes: [nullNode] })).toBe(null)
    // 読めたノードが 0 件で、他に null のノードがある → 「0 件」とは言えない
    expect(readContainerStates({ nodes: [nullNode, ORIGINAL_EXAMPLE.nodes[1]] })).toBe(null)
  })

  it('★★ 旧い形（containersStats が配列）も、読めるなら読む（原本の形と混在していても）', () => {
    expect(readContainerStates({ nodes: [{ containersStats: [{ state: 'running', status: 'healthy' }] }] })).toEqual([{ state: 'running', status: 'healthy' }])
    expect(readContainerStates({
      nodes: [{ containersStats: [{ state: 'a', status: 'b' }] }, { containersStats: { collectedAtSec: 1, containers: [{ state: 'c', status: 'd' }] } }],
    })).toEqual([{ state: 'a', status: 'b' }, { state: 'c', status: 'd' }])
  })

  it('★★ 読めない形は null: containersStats が文字列・数値・containers の無いオブジェクト・containers が配列でない・キーが無い', () => {
    for (const stats of ['running', 3, true, {}, { collectedAtSec: 1 }, { containers: 'x' }, { containers: { state: 'running', status: 'x' } }]) {
      expect(readContainerStates({ nodes: [{ containersStats: stats }] }), JSON.stringify(stats)).toBe(null)
    }
    expect(readContainerStates({ nodes: [{ nodeID: 'n1', desired: null }] })).toBe(null) // キーが無い
    expect(readContainerStates({ nodes: [{ containersStats: { containers: [{ state: 'running' }] } }] })).toBe(null) // status が無い
    expect(readContainerStates({ nodes: [{ containersStats: { containers: [{ state: 1, status: 'x' }] } }] })).toBe(null)
    expect(readContainerStates({ nodes: [{ containersStats: { containers: [null] } }] })).toBe(null)
  })

  it('★ 値は原本のまま返す（大文字小文字・知らない値も、そのまま）', () => {
    expect(readContainerStates({ nodes: [{ containersStats: { containers: [{ state: 'Running', status: 'S' }, { state: 'zombie', status: '' }] } }] })).toEqual([
      { state: 'Running', status: 'S' }, { state: 'zombie', status: '' },
    ])
  })
})

describe('isContainerStopped / countRunningContainers: 「止まっている」と言い切れるのは exited・dead だけ。知らない値は動いている側（R6-2）', () => {
  it('★★★ 原本が挙げる7つの state のうち、止まっているのは exited・dead だけ', () => {
    const stopped: Record<string, boolean> = {
      created: false, running: false, restarting: false, removing: false, paused: false, exited: true, dead: true,
    }
    for (const [state, expected] of Object.entries(stopped)) expect(isContainerStopped(state), state).toBe(expected)
  })

  it('★★ 原本に無い値・空文字・大文字小文字違い: 知らない値は「動いている」側。exited／dead は大文字・前後の空白があっても止まっている', () => {
    for (const state of ['zombie', '', 'Up', 'unknown', 'stopped', 'terminated', 'exit']) expect(isContainerStopped(state), JSON.stringify(state)).toBe(false)
    for (const state of ['EXITED', 'Dead', ' exited ']) expect(isContainerStopped(state), JSON.stringify(state)).toBe(true)
  })

  it('★★ countRunningContainers: 止まっていないコンテナの数。空は 0。exited・dead だけなら 0', () => {
    expect(countRunningContainers([])).toBe(0)
    expect(countRunningContainers([{ state: 'exited', status: 'x' }, { state: 'dead', status: 'y' }])).toBe(0)
    expect(countRunningContainers([{ state: 'exited', status: 'x' }, { state: 'running', status: 'y' }])).toBe(1)
    expect(countRunningContainers([{ state: 'running', status: '' }, { state: 'paused', status: '' }, { state: 'zombie', status: '' }])).toBe(3)
    // 原本の example（running が 1 件）
    expect(countRunningContainers(readContainerStates(ORIGINAL_EXAMPLE) ?? [])).toBe(1)
  })
})

// 2026-10-08 検分の再指摘: 削除前のコンテナの停止待ちは、最初の確認も待ちの中も readRunningContainerCount の1つで「動いている数」を読む。
// null（読めない）は 0 ではない——使う側は null を「分からない → 待ちを理由に止めない（DELETE へ進み、400 の待ち直しに任せる）」と扱う。
describe('readRunningContainerCount: 動いているコンテナの数。読めなければ null（0 とは別）', () => {
  it('★★★ 原本の example（running が 1 件）は 1。原本の形で 0 件は 0（null ではない）', () => {
    expect(readRunningContainerCount(ORIGINAL_EXAMPLE)).toBe(1)
    expect(readRunningContainerCount({ nodes: [] })).toBe(0)
    expect(readRunningContainerCount({ nodes: [{ nodeID: 'n', containersStats: { collectedAtSec: 1, containers: [] }, desired: null }] })).toBe(0)
  })

  it('★★★ exited・dead だけなら 0。知らない値（zombie）は動いている側＝1', () => {
    const node = (...states: string[]) => ({ nodeID: 'n', containersStats: { collectedAtSec: 1, containers: states.map(state => ({ state, status: 's' })) }, desired: null })
    expect(readRunningContainerCount({ nodes: [node('exited', 'dead')] })).toBe(0)
    expect(readRunningContainerCount({ nodes: [node('exited', 'zombie')] })).toBe(1)
    expect(readRunningContainerCount({ nodes: [node('running'), node('paused', 'exited')] })).toBe(2)
  })

  it('★★★ 読めない形は null（0 に倒さない）: 全ノード null・null のノードのほかに読めたコンテナが無い・形が違う・null／undefined', () => {
    expect(readRunningContainerCount({ nodes: [{ nodeID: 'n0', containersStats: null, desired: null }] })).toBeNull()
    // null のノード ＋ コンテナの無いノード（読めたコンテナが 1 件も無い）→ 0 件とは言い切れない
    expect(readRunningContainerCount({ nodes: [{ nodeID: 'n0', containersStats: null }, { nodeID: 'n1', containersStats: { collectedAtSec: 1, containers: [] } }] })).toBeNull()
    expect(readRunningContainerCount({ foo: 'bar' })).toBeNull()
    expect(readRunningContainerCount(null)).toBeNull()
    expect(readRunningContainerCount(undefined)).toBeNull()
  })

  it('null のノードがあっても、ほかのノードで読めたコンテナはそのまま数える（null のノードは読めたぶんを打ち消さない）', () => {
    const exited = { nodeID: 'n1', containersStats: { collectedAtSec: 1, containers: [{ state: 'exited', status: 'x' }] } }
    const running = { nodeID: 'n1', containersStats: { collectedAtSec: 1, containers: [{ state: 'running', status: 'x' }] } }
    expect(readRunningContainerCount({ nodes: [{ nodeID: 'n0', containersStats: null }, exited] })).toBe(0)
    expect(readRunningContainerCount({ nodes: [{ nodeID: 'n0', containersStats: null }, running] })).toBe(1)
  })

  it('旧い配列の形も、読めるなら読む', () => {
    expect(readRunningContainerCount({ nodes: [{ containersStats: [{ state: 'running', status: 'x' }] }] })).toBe(1)
  })
})

// 2026-10-08 検分の再指摘（J）: 「下位の一覧が空か」は ID だけで見る（name の無い行を捨てない）。読めない形は null（空とは別）。
describe('readLoadBalancerIdRows / readAsgIdRows: 一覧を ID と deleting だけで読む。読めなければ null（空配列とは別）', () => {
  it('★★★ 読めて空は []（反映のずれとみてよい）。name の無い行も拾う', () => {
    expect(readLoadBalancerIdRows({ loadBalancers: [] })).toEqual([])
    expect(readAsgIdRows({ autoScalingGroups: [] })).toEqual([])
    expect(readLoadBalancerIdRows({ loadBalancers: [{ loadBalancerID: 'l9' }] })).toEqual([{ loadBalancerID: 'l9', deleting: null }])
    expect(readAsgIdRows({ autoScalingGroups: [{ autoScalingGroupID: 'a9' }] })).toEqual([{ asgID: 'a9', deleting: null }])
  })

  it('★★★ deleting は boolean のときだけその値。それ以外は null（分からない）', () => {
    expect(readLoadBalancerIdRows({ loadBalancers: [{ loadBalancerID: 'l1', deleting: true }, { loadBalancerID: 'l2', deleting: false }, { loadBalancerID: 'l3', deleting: 'yes' }] }))
      .toEqual([{ loadBalancerID: 'l1', deleting: true }, { loadBalancerID: 'l2', deleting: false }, { loadBalancerID: 'l3', deleting: null }])
    expect(readAsgIdRows({ autoScalingGroups: [{ autoScalingGroupID: 'a1', deleting: true }] })).toEqual([{ asgID: 'a1', deleting: true }])
  })

  it.each([
    ['キーが無い・別のキー', { items: [] }],
    ['配列でない', { loadBalancers: 'x', autoScalingGroups: 'x' }],
    ['null', null],
    ['要素があるのに ID を 1 つも読めない', { loadBalancers: [{ foo: 1 }, null, 'x'], autoScalingGroups: [{ foo: 1 }] }],
  ])('★★★ 読めない（%s）→ null（空配列にしない）', (_label, body) => {
    expect(readLoadBalancerIdRows(body)).toBeNull()
    expect(readAsgIdRows(body)).toBeNull()
  })

  it('一部の要素だけ ID が読めるなら、読めた行だけを返す（null にはしない）', () => {
    expect(readLoadBalancerIdRows({ loadBalancers: [{ foo: 1 }, { loadBalancerID: 'l1' }] })).toEqual([{ loadBalancerID: 'l1', deleting: null }])
  })

  it('対照: 名前探し用の readLoadBalancerRows は name の無い行を捨てる（だから「空か」の判定には使えない）', async () => {
    const { readLoadBalancerRows, readAsgRows } = await import('../src/shared/apprunDedicatedShapes')
    expect(readLoadBalancerRows({ loadBalancers: [{ loadBalancerID: 'l9' }] })).toEqual([])
    expect(readAsgRows({ autoScalingGroups: [{ autoScalingGroupID: 'a9' }] })).toEqual([])
    expect(readLoadBalancerIDs({ loadBalancers: [{ loadBalancerID: 'l9' }] })).toEqual(['l9'])
  })
})
