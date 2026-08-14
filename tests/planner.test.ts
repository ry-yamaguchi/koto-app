import { describe, it, expect } from 'vitest'
import { computePlan } from '../src/main/cloud/planner'
import { emptyState, type EnvState, type ResourceRef } from '../src/main/cloud/state'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'

/**
 * defaultSpec() は 2026-08-14 から**保存場所を持たない**（バケットは1つにつき
 * 月額が発生するため、同意 = `consentedAt` があるものだけを要求する）。
 * バケットが要るテストは、ここで同意済みのものを明示的に足す。
 */
function withBucket(spec: EnvSpec): EnvSpec {
  spec.persistence.objectStorage = [
    { bucket: `${spec.name}-data`, prefix: `projects/${spec.name}/`, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' },
  ]
  return spec
}

describe('computePlan', () => {
  it('emits create actions and is non-destructive when state is empty', () => {
    const spec: EnvSpec = withBucket(defaultSpec({ name: 'myapp', hasDockerfile: true }))
    const state: EnvState = emptyState(spec.name, spec.backend)

    const plan = computePlan(spec, state)

    expect(plan.hasDestructive).toBe(false)
    expect(plan.hasStatefulDelete).toBe(false)
    expect(plan.actions.length).toBeGreaterThan(0)
    expect(plan.actions.every(a => a.type === 'create')).toBe(true)
    // Sanity: expected resources for a dockerfile-based spec with 1 bucket.
    const kinds = plan.actions.map(a => a.kind).sort()
    expect(kinds).toEqual(['apprun-app', 'bucket', 'image', 'registry'])
  })

  it('is all noop/update (never destructive) when state matches spec exactly', () => {
    const spec: EnvSpec = withBucket(defaultSpec({ name: 'myapp', hasDockerfile: true }))
    const resources: ResourceRef[] = [
      { kind: 'registry', id: 'reg-1', stateful: false, key: `registry:${spec.name}` },
      { kind: 'image', id: 'img-1', stateful: false, key: `image:${spec.name}` },
      { kind: 'apprun-app', id: 'app-1', stateful: false, key: `apprun-app:${spec.name}` },
      { kind: 'bucket', id: 'bucket-1', stateful: true, key: `bucket:${spec.name}-data` },
    ]
    const state: EnvState = { name: spec.name, backend: spec.backend, resources }

    const plan = computePlan(spec, state)

    expect(plan.hasDestructive).toBe(false)
    expect(plan.hasStatefulDelete).toBe(false)
    expect(plan.actions.every(a => a.type === 'noop' || a.type === 'update')).toBe(true)
    // apprun-app always redeploys per apprunNeedsUpdate() returning true unconditionally.
    const apprunAction = plan.actions.find(a => a.kind === 'apprun-app')
    expect(apprunAction?.type).toBe('update')
  })

  it('emits a destructive delete for a non-stateful resource present in state but absent from spec', () => {
    // NOTE: defaultSpec() always sets service.source.type = 'dockerfile' regardless of the
    // hasDockerfile input flag (that flag is currently unused in the implementation), so
    // desiredResources() always wants a registry+image when built via defaultSpec(). To get a
    // non-stateful resource that is absent from desired, we mutate the spec's persistence
    // list to remove the bucket is not enough (bucket is stateful); instead we simulate a
    // leftover apprun-app under a *different* name than spec.name, which will never appear
    // in desiredResources() (that only ever adds a single apprun-app keyed by spec.name).
    const spec: EnvSpec = withBucket(defaultSpec({ name: 'myapp', hasDockerfile: true }))
    const resources: ResourceRef[] = [
      { kind: 'registry', id: 'reg-1', stateful: false, key: `registry:${spec.name}` },
      { kind: 'image', id: 'img-1', stateful: false, key: `image:${spec.name}` },
      { kind: 'apprun-app', id: 'app-1', stateful: false, key: `apprun-app:${spec.name}` },
      { kind: 'bucket', id: 'bucket-1', stateful: true, key: `bucket:${spec.name}-data` },
      // Leftover from a previous spec.name (e.g. app was renamed) — not in desired.
      { kind: 'apprun-app', id: 'app-old', stateful: false, key: 'apprun-app:myapp-old' },
    ]
    const state: EnvState = { name: spec.name, backend: spec.backend, resources }

    const plan = computePlan(spec, state)

    const del = plan.actions.find(a => a.kind === 'apprun-app' && a.type === 'delete')
    expect(del).toBeDefined()
    expect(del?.destructive).toBe(true)
    expect(del?.stateful).toBe(false)
    expect(del?.name).toBe('myapp-old')
    expect(plan.hasDestructive).toBe(true)
    expect(plan.hasStatefulDelete).toBe(false)
  })

  it('KEY INVARIANT: a stateful bucket in state but absent from spec is PROPOSED as a destructive delete with hasStatefulDelete=true (confirmed policy 2026-07-04: downstream UI must warn + require explicit confirmation)', () => {
    const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: true })
    // Remove the bucket from persistence so it is no longer in desiredResources().
    spec.persistence.objectStorage = []

    const resources: ResourceRef[] = [
      { kind: 'registry', id: 'reg-1', stateful: false, key: `registry:${spec.name}` },
      { kind: 'image', id: 'img-1', stateful: false, key: `image:${spec.name}` },
      { kind: 'apprun-app', id: 'app-1', stateful: false, key: `apprun-app:${spec.name}` },
      // This bucket key is NOT in desiredResources() because persistence.objectStorage is empty.
      { kind: 'bucket', id: 'bucket-1', stateful: true, key: `bucket:${spec.name}-data` },
    ]
    const state: EnvState = { name: spec.name, backend: spec.backend, resources }

    const plan = computePlan(spec, state)

    const bucketDelete = plan.actions.find(a => a.kind === 'bucket' && a.type === 'delete')
    // CONFIRMED POLICY (2026-07-04): removing a bucket from the spec proposes a destructive
    // delete (spec editing stays the flexible way to remove one), and hasStatefulDelete=true
    // obliges downstream UI (AppRunPanel warning + apply confirmation "データは失われます")
    // to require explicit confirmation. It must never run automatically. If this test breaks,
    // the data-loss guard contract changed — review AppRunPanel/apply before "fixing" it.
    expect(bucketDelete).toBeDefined()
    expect(bucketDelete?.destructive).toBe(true)
    expect(bucketDelete?.stateful).toBe(true)
    expect(plan.hasStatefulDelete).toBe(true)
    expect(plan.hasDestructive).toBe(true)
  })
})

// ── 費用の同意（2026-08-14）─────────────────────────────────────────
// planner が「同意していないバケット」を要求すると、公開しただけで月額が発生する。
// **ここが最後の砦**（apply は言われたものを作るだけ）。
describe('computePlan と保存場所の同意', () => {
  it('既定のプロジェクトは、保存場所を要求しない', () => {
    const spec = defaultSpec({ name: 'myapp', hasDockerfile: true })
    const plan = computePlan(spec, emptyState(spec.name, spec.backend))
    expect(plan.actions.some(a => a.kind === 'bucket')).toBe(false)
  })

  it('consentedAt の無いバケットが env.json にあっても、作らない', () => {
    const spec = defaultSpec({ name: 'myapp', hasDockerfile: true })
    // v0.3.5 以前の env.json はこの形（同意を取っていない既定値）
    spec.persistence.objectStorage = [{ bucket: 'myapp-data' }]
    const plan = computePlan(spec, emptyState(spec.name, spec.backend))
    expect(plan.actions.some(a => a.kind === 'bucket')).toBe(false)
  })

  it('同意済みのバケットは作る', () => {
    const spec = withBucket(defaultSpec({ name: 'myapp', hasDockerfile: true }))
    const plan = computePlan(spec, emptyState(spec.name, spec.backend))
    const bucket = plan.actions.find(a => a.kind === 'bucket')
    expect(bucket?.type).toBe('create')
    expect(bucket?.name).toBe('myapp-data')
  })
})
