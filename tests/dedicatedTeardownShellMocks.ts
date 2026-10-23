// 専有型の削除 apprunDedicated:teardown を、本物の main（ハンドラ・骨・teardownFlow・保存場所の片づけ）に、偽の HTTP サーバと偽の保存場所で流すための
// 土台その1（偽物と、それに渡す入れ物 h）。tests/dedicatedTeardownShell*.test.ts が使う（0.6.22 段階3B-7 で、400行を超えた試験を2つに分けるために切り出した）。
//
// 使い方: 各テストファイルの先頭で、次の4つの vi.mock を書く（vi.mock はそのファイルの中でしか効かない）。
//   vi.mock('electron', async () => (await import('./dedicatedTeardownShellMocks')).electronMock())
//   vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./dedicatedTeardownShellMocks')).storageAdapterMock(await orig()))
//   vi.mock('../src/main/cloud/apprunDedicatedApply', async (orig) => (await import('./dedicatedTeardownShellMocks')).applyMock(await orig()))
//   vi.mock('../src/main/publishMetaFs', async (orig) => (await import('./dedicatedTeardownShellMocks')).publishMetaMock(await orig()))
// このファイルは mock される側のモジュール（storageAdapter・publishMetaFs ほか）を import しない（import すると、mock の中からこのファイルを読む輪になる）。
// 下ごしらえ（プロジェクトの用意・偽サーバ）は tests/dedicatedTeardownShellHarness.ts。実物の判断（storageTeardown.ts → teardownPlanFor）は mock しない。

export const h = {
  /** 偽のさくらの API サーバの根（teardownFlow の baseUrl）。 */
  baseUrl: '',
  handlers: new Map<string, (...args: any[]) => any>(),
  keys: [] as string[],
  listThrows: false,
  /** 保存場所へ出た要求の一覧（順序込み）。**空であることを確かめるのに使う。** */
  storageCalls: [] as string[],
  deletedBuckets: [] as string[],
  /** forgetPublishTargetFs の差し替え（null なら本物）。 */
  forget: null as null | ((projectDir: string, target: string) => unknown),
  /** 一覧に失敗する保存場所（バケット名）。`listThrows` が true なら全部。 */
  listThrowsFor: new Set<string>(),
  /** 保存場所ごとの中身（無ければ `keys`）。ほかのプロジェクトのデータがある保存場所＝バケットごとは消さない保存場所を作る。 */
  keysFor: new Map<string, string[]>(),
  /** 専有型の記録の書き込みを失敗させる条件（書こうとした内容を見て true なら、書かずに false を返す）。null なら本物。 */
  failRecordWrite: null as null | ((patch: Record<string, unknown>) => boolean),
  /** 保存場所の設定（env.json）から、消したバケットを外せない回にする（forgetDeletedBuckets が false を返す）。 */
  forgetBucketsFails: false,
  /** 保存場所の片づけそのもの（teardownStorageForProject）が投げる回にする。 */
  storageThrows: false,
}

export function electronMock() {
  return {
    ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
    app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
    BrowserWindow: class {},
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
    shell: { openExternal: async () => {} },
    dialog: {},
  }
}

// 偽の保存場所。**呼ばれた操作を順番に積むだけ**。実物の判断（storageTeardown.ts → teardownPlanFor）はそのまま動かす。
export function storageAdapterMock(real: any) {
  return {
    ...real,
    createStorageAdapter: async () => {
      h.storageCalls.push('connect')
      return {
        siteInfo: () => ({ s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' }),
        async isSiteReady() { return true },
        async ensureBucket() { /* 破棄では使わない */ },
        async putMarker() { /* 破棄では使わない */ },
        async listAllKeys(bucket: string) {
          h.storageCalls.push(`listAllKeys ${bucket}`)
          if (h.listThrows || h.listThrowsFor.has(bucket)) throw new Error('一覧を取得できませんでした（テスト）')
          return h.keysFor.get(bucket) ?? h.keys
        },
        async deleteKeys(bucket: string) { h.storageCalls.push(`deleteKeys ${bucket}`) },
        async deleteBucket(bucket: string) { h.storageCalls.push(`deleteBucket ${bucket}`); h.deletedBuckets.push(bucket) },
        async deletePermission(id: string) { h.storageCalls.push(`deletePermission ${id}`) },
        async issueKey() { h.storageCalls.push('issueKey'); return { accessKey: 'A', secretKey: 'S', permissionId: 'p' } },
        async listPermissions() { h.storageCalls.push('listPermissions'); return [] },
        async dispose() { h.storageCalls.push('dispose') },
      }
    },
  }
}

// 破棄の本体は**実物**を動かす。偽サーバへ向けるため baseUrl だけを足し、待たない sleep を入れる。
export function applyMock(real: any) {
  return {
    ...real,
    teardownFlow: (auth: any, dir: string, opts: any) => real.teardownFlow(auth, dir, { ...opts, sleep: async () => {} }, h.baseUrl),
  }
}

// 公開の記録を消す口だけ、消し損ねを作れるようにする（null のときは本物）。
export function publishMetaMock(real: any) {
  return {
    ...real,
    forgetPublishTargetFs: (projectDir: string, target: string) => (h.forget ? h.forget(projectDir, target) : real.forgetPublishTargetFs(projectDir, target)),
    // 専有型の記録への書き込みだけ、条件に当たったものを書かずに false にする（実物は書き込めなければ false を返す）。
    writeApprunDedicatedRecordFs: (projectDir: string, patch: Record<string, unknown>) =>
      (h.failRecordWrite?.(patch) ? false : real.writeApprunDedicatedRecordFs(projectDir, patch)),
  }
}

// 保存場所の設定の書き換え（消したバケットを外す）と片づけそのものに、失敗を作れるようにする（5つ目の vi.mock。使うファイルだけが書く）:
//   vi.mock('../src/main/cloud/storageForTarget', async (orig) => (await import('./dedicatedTeardownShellMocks')).storageForTargetMock(await orig()))
export function storageForTargetMock(real: any) {
  return {
    ...real,
    forgetDeletedBuckets: (...args: unknown[]) => (h.forgetBucketsFails ? false : real.forgetDeletedBuckets(...args)),
    teardownStorageForProject: (...args: unknown[]) =>
      (h.storageThrows ? Promise.reject(new Error('片づけが投げました（テスト）')) : real.teardownStorageForProject(...args)),
  }
}
