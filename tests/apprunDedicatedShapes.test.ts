import { describe, it, expect } from 'vitest'
import {
  readLimits,
  readWorkerClasses,
  readLbClasses,
  readClusters,
  readClusterId,
  readAsgId,
  readLoadBalancerId,
  readApiErrorTitle,
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
