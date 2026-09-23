import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  APP_DEFAULTS,
  APPLICATION_NAME_PATTERN,
  HOSTNAME_PATTERN,
  deriveApplicationName,
  validateAppSpec,
  buildApplicationCreateBody,
  buildVersionCreateBody,
  buildActiveVersionBody,
  buildLetsEncryptPatchBody,
  versionsToDelete,
  bareIp,
  collectBareLbAddresses,
  appDeleteRetryable,
  appDeleteExhaustedMessage,
  letsEncryptEmailFieldState,
  isLikelyEmail,
  REQUIRED_CLUSTER_PORTS,
  missingRequiredPorts,
  type ApprunDedicatedAppSpec,
} from '../src/shared/apprunDedicatedApp'

// 委譲仕様 D-1: roadmap #23 ⑤「アプリを公開する」の土台となる純関数群
// （docs/apprun-dedicated-plan.md 12-1〜12-3）。原本（OpenAPI v1.4.0）の制約と食い違わないことを
// 境界値で固定する。apprunDedicatedApply.ts の validateClusterSpec のテストと同じ方針
// （妥当な spec を1つ用意し、1項目だけ壊して NG になることを確かめる）。

const VALID_SPEC: ApprunDedicatedAppSpec = {
  name: 'myapp',
  host: 'app.example.com',
  port: 8080,
  cpu: APP_DEFAULTS.cpu,
  memory: APP_DEFAULTS.memory,
  fixedScale: APP_DEFAULTS.fixedScale,
  env: [],
}

describe('APP_DEFAULTS: 決定B-2（12-3）どおりの既定値', () => {
  it('cpu 500 / memory 512 / fixedScale 1', () => {
    expect(APP_DEFAULTS).toEqual({ cpu: 500, memory: 512, fixedScale: 1 })
  })
})

describe('APPLICATION_NAME_PATTERN / HOSTNAME_PATTERN: 原本の pattern と一致する', () => {
  it('APPLICATION_NAME_PATTERN: 1〜20文字の英数字・_・-（原本 CreateApplicationRequest.name）', () => {
    expect(APPLICATION_NAME_PATTERN.test('a')).toBe(true)
    expect(APPLICATION_NAME_PATTERN.test('a'.repeat(20))).toBe(true)
    expect(APPLICATION_NAME_PATTERN.test('a'.repeat(21))).toBe(false)
    expect(APPLICATION_NAME_PATTERN.test('')).toBe(false)
    expect(APPLICATION_NAME_PATTERN.test('my.app')).toBe(false)
  })

  it('HOSTNAME_PATTERN: 小文字の英数字・ハイフン・ドット（原本 Hostname）。大文字はNG', () => {
    expect(HOSTNAME_PATTERN.test('app.example.com')).toBe(true)
    expect(HOSTNAME_PATTERN.test('a')).toBe(true)
    expect(HOSTNAME_PATTERN.test('App.Example.com')).toBe(false)
    expect(HOSTNAME_PATTERN.test('-app.example.com')).toBe(false)
    expect(HOSTNAME_PATTERN.test('')).toBe(false)
  })
})

describe('deriveApplicationName: 原本の制約に収める', () => {
  it('許されない文字（空白・記号等）を - に置き換える', () => {
    expect(deriveApplicationName('my app!')).toBe('my-app')
  })

  it('連続する - を1つにまとめる', () => {
    expect(deriveApplicationName('my   app')).toBe('my-app')
  })

  it('両端の -/_ を落とす', () => {
    expect(deriveApplicationName('-my-app-')).toBe('my-app')
    expect(deriveApplicationName('_my_app_')).toBe('my_app')
  })

  it('20文字に切る', () => {
    expect(deriveApplicationName('a'.repeat(30))).toBe('a'.repeat(20))
  })

  it('結果が空になれば app', () => {
    expect(deriveApplicationName('')).toBe('app')
    expect(deriveApplicationName('!!!')).toBe('app')
    expect(deriveApplicationName('---')).toBe('app')
  })

  it('作った名前は APPLICATION_NAME_PATTERN に必ず合致する（日本語プロジェクト名等の実例）', () => {
    const cases = ['マイアプリ', 'My App (test)', '  spaced  ', 'already-valid-name', 'a'.repeat(50)]
    for (const c of cases) {
      expect(APPLICATION_NAME_PATTERN.test(deriveApplicationName(c))).toBe(true)
    }
  })
})

describe('validateAppSpec: 境界値（妥当な spec を1項目だけ壊す）', () => {
  it('妥当な spec は ok:true', () => {
    expect(validateAppSpec(VALID_SPEC)).toEqual({ ok: true })
  })

  it('name 21文字 → NG（20文字はOK）', () => {
    expect(validateAppSpec({ ...VALID_SPEC, name: 'a'.repeat(21) }).ok).toBe(false)
    expect(validateAppSpec({ ...VALID_SPEC, name: 'a'.repeat(20) }).ok).toBe(true)
  })

  it('host に大文字が混じる → NG（小文字化はしない。原文のまま弾く）', () => {
    const r = validateAppSpec({ ...VALID_SPEC, host: 'App.Example.com' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('小文字')
  })

  it('port: 0/65536 → NG・1/65535 → OK', () => {
    expect(validateAppSpec({ ...VALID_SPEC, port: 0 }).ok).toBe(false)
    expect(validateAppSpec({ ...VALID_SPEC, port: 65536 }).ok).toBe(false)
    expect(validateAppSpec({ ...VALID_SPEC, port: 1 }).ok).toBe(true)
    expect(validateAppSpec({ ...VALID_SPEC, port: 65535 }).ok).toBe(true)
  })

  it('cpu: 99 → NG・100 → OK（原本 min100）', () => {
    expect(validateAppSpec({ ...VALID_SPEC, cpu: 99 }).ok).toBe(false)
    expect(validateAppSpec({ ...VALID_SPEC, cpu: 100 }).ok).toBe(true)
  })

  it('cpu: 64001 → NG・64000 → OK（原本 max64000）', () => {
    expect(validateAppSpec({ ...VALID_SPEC, cpu: 64001 }).ok).toBe(false)
    expect(validateAppSpec({ ...VALID_SPEC, cpu: 64000 }).ok).toBe(true)
  })

  it('memory: 127 → NG・128 → OK（原本 min128）', () => {
    expect(validateAppSpec({ ...VALID_SPEC, memory: 127 }).ok).toBe(false)
    expect(validateAppSpec({ ...VALID_SPEC, memory: 128 }).ok).toBe(true)
  })

  it('memory: 131073 → NG・131072 → OK（原本 max131072）', () => {
    expect(validateAppSpec({ ...VALID_SPEC, memory: 131073 }).ok).toBe(false)
    expect(validateAppSpec({ ...VALID_SPEC, memory: 131072 }).ok).toBe(true)
  })

  it('fixedScale: 51 → NG・50 → OK（原本 max50）', () => {
    expect(validateAppSpec({ ...VALID_SPEC, fixedScale: 51 }).ok).toBe(false)
    expect(validateAppSpec({ ...VALID_SPEC, fixedScale: 50 }).ok).toBe(true)
  })

  it('fixedScale: 0 → NG（原本 min1）', () => {
    expect(validateAppSpec({ ...VALID_SPEC, fixedScale: 0 }).ok).toBe(false)
  })

  it('env: 51件 → NG・50件 → OK（原本 maxItems50）', () => {
    const env51 = Array.from({ length: 51 }, (_, i) => ({ key: `k${i}`, value: 'v', secret: false }))
    const env50 = Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, value: 'v', secret: false }))
    expect(validateAppSpec({ ...VALID_SPEC, env: env51 }).ok).toBe(false)
    expect(validateAppSpec({ ...VALID_SPEC, env: env50 }).ok).toBe(true)
  })

  it('env: key が空文字 → NG', () => {
    expect(validateAppSpec({ ...VALID_SPEC, env: [{ key: '', value: 'v', secret: false }] }).ok).toBe(false)
  })

  it('healthCheckPath: / で始まらない → NG。/ から始まる・未指定はOK', () => {
    expect(validateAppSpec({ ...VALID_SPEC, healthCheckPath: 'healthz' }).ok).toBe(false)
    expect(validateAppSpec({ ...VALID_SPEC, healthCheckPath: '/healthz' }).ok).toBe(true)
    expect(validateAppSpec(VALID_SPEC).ok).toBe(true) // healthCheckPath 未指定
  })

  it('複数違反があっても最初の1件だけ返す（name→host の順で name が先）', () => {
    const bad: ApprunDedicatedAppSpec = { ...VALID_SPEC, name: 'a'.repeat(21), host: 'BAD HOST' }
    const r = validateAppSpec(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('アプリ名')
  })
})

describe('buildApplicationCreateBody: POST /applications の本文（原本 CreateApplicationRequest）', () => {
  it('name・clusterID のみ', () => {
    expect(buildApplicationCreateBody({ name: 'myapp', clusterID: 'cluster-1' })).toEqual({ name: 'myapp', clusterID: 'cluster-1' })
  })
})

describe('buildVersionCreateBody: POST /applications/{id}/versions の本文（原本の必須9キーすべて）', () => {
  const REGISTRY = { username: 'reg-user', password: 'reg-pass', action: 'new' as const }

  it('原本 CreateApplicationVersionRequest の必須9キーをすべて持つ', () => {
    const body = buildVersionCreateBody(VALID_SPEC, 'xxx.sakuracr.jp/myapp:v1', REGISTRY)
    for (const key of ['image', 'cpu', 'memory', 'scalingMode', 'registryUsername', 'registryPassword', 'registryPasswordAction', 'exposedPorts', 'env']) {
      expect(body).toHaveProperty(key)
    }
  })

  it('useLetsEncrypt:true・loadBalancerPort:443・host:[spec.host] を持つ', () => {
    const body: any = buildVersionCreateBody(VALID_SPEC, 'img:v1', REGISTRY)
    expect(body.exposedPorts).toEqual([
      expect.objectContaining({ useLetsEncrypt: true, loadBalancerPort: 443, host: [VALID_SPEC.host], targetPort: VALID_SPEC.port }),
    ])
  })

  it('scalingMode は manual 固定・fixedScale は spec の値', () => {
    const body: any = buildVersionCreateBody(VALID_SPEC, 'img:v1', REGISTRY)
    expect(body.scalingMode).toBe('manual')
    expect(body.fixedScale).toBe(VALID_SPEC.fixedScale)
  })

  it('healthCheckPath が無ければ healthCheck は null。あれば path/intervalSeconds/timeoutSeconds を持つ', () => {
    const withoutHc: any = buildVersionCreateBody(VALID_SPEC, 'img:v1', REGISTRY)
    expect(withoutHc.exposedPorts[0].healthCheck).toBeNull()

    const withHc: any = buildVersionCreateBody({ ...VALID_SPEC, healthCheckPath: '/healthz' }, 'img:v1', REGISTRY)
    expect(withHc.exposedPorts[0].healthCheck).toEqual({ path: '/healthz', intervalSeconds: 30, timeoutSeconds: 5 })
  })

  it('env は key/value/secret の3つだけに絞る（余計なキーを持ち込まない）', () => {
    const spec = { ...VALID_SPEC, env: [{ key: 'K', value: 'V', secret: true }] }
    const body: any = buildVersionCreateBody(spec, 'img:v1', REGISTRY)
    expect(body.env).toEqual([{ key: 'K', value: 'V', secret: true }])
  })

  it('registryUsername/Password/PasswordAction は渡した registry をそのまま使う（null も可）', () => {
    const body: any = buildVersionCreateBody(VALID_SPEC, 'img:v1', { username: null, password: null, action: 'keep' })
    expect(body.registryUsername).toBeNull()
    expect(body.registryPassword).toBeNull()
    expect(body.registryPasswordAction).toBe('keep')
  })

  it('minScale/maxScale/scaleInThreshold/scaleOutThreshold/cmd は送らない（原本では任意）', () => {
    const body: any = buildVersionCreateBody(VALID_SPEC, 'img:v1', REGISTRY)
    for (const key of ['minScale', 'maxScale', 'scaleInThreshold', 'scaleOutThreshold', 'cmd']) {
      expect(body).not.toHaveProperty(key)
    }
  })
})

describe('buildActiveVersionBody: PUT /applications/{id} の本文（原本 UpdateApplicationRequest）', () => {
  it('activeVersion をそのまま包む（number）', () => {
    expect(buildActiveVersionBody(3)).toEqual({ activeVersion: 3 })
  })

  it('null（有効なバージョン無しにする）も可', () => {
    expect(buildActiveVersionBody(null)).toEqual({ activeVersion: null })
  })
})

describe('buildLetsEncryptPatchBody: PATCH /clusters/{id}/load_balancer の本文（原本 PatchClusterLoadBalancerRequest）', () => {
  it('letsEncryptEmail のみを持つ（ports は送らない）', () => {
    const body = buildLetsEncryptPatchBody('owner@example.com')
    expect(body).toEqual({ letsEncryptEmail: 'owner@example.com' })
    expect(body).not.toHaveProperty('ports')
  })
})

describe('versionsToDelete: created の新しい順に keep 件＋active を残し、残りを昇順で返す', () => {
  it('active を消さない（keep件の中に入っていなくても残る）', () => {
    const rows = [
      { version: 1, created: 100 },
      { version: 2, created: 200 },
      { version: 3, created: 300 },
    ]
    // keep=1（最新のv3だけが対象）だが、active=1（一番古い）も別枠で残る → 消えるのはv2のみ。
    expect(versionsToDelete(rows, 1, 1)).toEqual([2])
  })

  it('keep 件（新しい順）を残す', () => {
    const rows = [
      { version: 1, created: 100 },
      { version: 2, created: 200 },
      { version: 3, created: 300 },
      { version: 4, created: 400 },
      { version: 5, created: 500 },
    ]
    // active なし。keep=2 → v5,v4（新しい2件）を残し、v1,v2,v3 を消す（昇順）。
    expect(versionsToDelete(rows, null, 2)).toEqual([1, 2, 3])
  })

  it('空なら空', () => {
    expect(versionsToDelete([], null, 5)).toEqual([])
    expect(versionsToDelete([], 1, 5)).toEqual([])
  })

  it('全件が keep 件以下なら消す物なし', () => {
    const rows = [{ version: 1, created: 100 }, { version: 2, created: 200 }]
    expect(versionsToDelete(rows, null, 5)).toEqual([])
  })

  it('keep を省略すると DEFAULT_KEEP（=5・共用型と同じ）を使う', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ version: i + 1, created: (i + 1) * 100 }))
    // 新しい順(7,6,5,4,3)の5件を残し、古い(1,2)を消す。
    expect(versionsToDelete(rows, null)).toEqual([1, 2])
  })

  it('戻り値は version の昇順（古い順ではなく番号順）', () => {
    const rows = [
      { version: 10, created: 500 },
      { version: 2, created: 100 },
      { version: 3, created: 200 },
    ]
    expect(versionsToDelete(rows, null, 0)).toEqual([2, 3, 10])
  })
})

// ── D-5（2026-09-16 実測）: LB ノードの address は `IP/24` のネットマスク付き。A レコードに書くのは素の IP ──

describe('bareIp: ネットマスク付きのアドレスから素の IP だけを取り出す（5-13）', () => {
  it('★ `59.106.222.212/24` → `59.106.222.212`（実測の生の形。`/24` を落とす）', () => {
    expect(bareIp('59.106.222.212/24')).toBe('59.106.222.212')
    expect(bareIp('59.106.222.212/24')).not.toContain('/')
  })

  it('`/` が無ければそのまま', () => {
    expect(bareIp('203.0.113.10')).toBe('203.0.113.10')
  })

  it('空文字は空', () => {
    expect(bareIp('')).toBe('')
  })

  it('`/` 始まり（IP 部分が無い）は空（`/24` を IP として案内しない）', () => {
    expect(bareIp('/24')).toBe('')
  })

  it('前後の空白は落とす。文字列でなければ空', () => {
    expect(bareIp(' 59.106.222.212/24 ')).toBe('59.106.222.212')
    expect(bareIp(undefined as unknown as string)).toBe('')
  })
})

describe('collectBareLbAddresses: GET load_balancer_nodes の応答 → 素の IP の配列（2026-09-16 実測の生の形）', () => {
  // probe-dedicated-nodes ⑥ の実測（docs/apprun-dedicated-plan.md 5-13）。推測で形を変えない。
  const MEASURED = {
    loadBalancerNodes: [{
      loadBalancerNodeID: 'lbn-1', resourceID: 'res-1', status: 'healthy',
      interfaces: [{ interfaceIndex: 0, addresses: [{ address: '59.106.222.212/24', vip: false }] }],
      archiveVersion: 'v2026.825.1', created: 1789515207,
    }],
  }

  it('★ 実測の形から `59.106.222.212`（素の IP）を取り出す', () => {
    expect(collectBareLbAddresses(MEASURED)).toEqual(['59.106.222.212'])
  })

  it('ノードが空・形が違う → 空配列', () => {
    expect(collectBareLbAddresses({ loadBalancerNodes: [] })).toEqual([])
    expect(collectBareLbAddresses({})).toEqual([])
    expect(collectBareLbAddresses(null)).toEqual([])
  })

  it('IP 部分が無いアドレス（`/24`）は捨てる', () => {
    const data = { loadBalancerNodes: [{ loadBalancerNodeID: 'n', interfaces: [{ interfaceIndex: 0, addresses: [{ address: '/24', vip: false }, { address: '10.0.0.1/24', vip: false }] }] }] }
    expect(collectBareLbAddresses(data)).toEqual(['10.0.0.1'])
  })
})

// ── D-10（2026-09-16 実機実測・課金が止まらない穴）: アプリ削除の400には「やり直せば解ける理由」が
// 2つある（active version・currently running）。文言の判定はここ1か所に固める（掟10）。
describe('appDeleteRetryable: アプリ削除の400が、やり直す価値があるか（2026-09-16実機で両方観測）', () => {
  it('"active version" を含む → true', () => {
    expect(appDeleteRetryable('Cannot delete application because it has active version')).toBe(true)
  })

  it('"currently running" を含む → true', () => {
    expect(appDeleteRetryable('Cannot delete application because it is currently running')).toBe(true)
  })

  it('大文字小文字が違っても true', () => {
    expect(appDeleteRetryable('CANNOT DELETE APPLICATION BECAUSE IT IS CURRENTLY RUNNING')).toBe(true)
    expect(appDeleteRetryable('Active Version')).toBe(true)
  })

  it('関係ない文言は false', () => {
    expect(appDeleteRetryable('Some other reason entirely')).toBe(false)
  })

  it('null・undefined・空文字は false', () => {
    expect(appDeleteRetryable(null)).toBe(false)
    expect(appDeleteRetryable(undefined)).toBe(false)
    expect(appDeleteRetryable('')).toBe(false)
  })
})

describe('appDeleteExhaustedMessage: 3回やり直しても消えないときの文面は、理由ごとに変え、嘘にならないようにする', () => {
  it('active version → 「有効なバージョンが解消しません」＋課金が続きます＋生のmessageを含む', () => {
    const msg = appDeleteExhaustedMessage('Cannot delete application because it has active version', 'raw-detail')
    expect(msg).toContain('有効なバージョンが解消しません')
    expect(msg).toContain('課金が続きます')
    expect(msg).toContain('raw-detail')
  })

  it('currently running → 「有効なバージョン」とは書かない（決め打ちの文面は嘘になる）', () => {
    const msg = appDeleteExhaustedMessage('Cannot delete application because it is currently running', 'raw-detail')
    expect(msg).not.toContain('有効なバージョン')
    expect(msg).toContain('課金が続きます')
    expect(msg).toContain('raw-detail')
  })

  it('該当しない理由・null → 汎用の文面（「有効なバージョン」を名乗らない）', () => {
    expect(appDeleteExhaustedMessage(null, 'raw-detail')).not.toContain('有効なバージョン')
    expect(appDeleteExhaustedMessage('unknown reason', 'raw-detail')).not.toContain('有効なバージョン')
  })
})

// ── 散らばりを禁じるテスト（掟10）: 判定は appDeleteRetryable 1か所だけ ─────────────────────
// 呼び出し側に `title.includes('active version')` を書き散らすと、3つ目の文言が出たときに
// 直し忘れる（2026-09-16、実際に2つ目の文言「currently running」で直し忘れた）。
// apprunDedicatedIpcWiring.test.ts の codeOnly と同じやり方でコメントを剥がしてから確かめる
// （ファイル冒頭のコメントに同じ文字列があるだけで落ちる弱いテストにしない）。
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
}

/** dir 以下の .ts/.tsx を再帰的に列挙する。 */
function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...listTsFiles(p))
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('散らばりを禁じる: src/ のどこにも includes(\'active version\') / includes(\'currently running\') の直書きが無い', () => {
  it('★ 判定は appDeleteRetryable 1か所だけ（コメント行は除く）', () => {
    const root = join(__dirname, '..', 'src')
    const offenders: string[] = []
    for (const file of listTsFiles(root)) {
      const code = codeOnly(readFileSync(file, 'utf-8'))
      if (code.includes("includes('active version')") || code.includes("includes('currently running')")) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})

// ── F-1 A-2（2026-09-16）: ⑧の Let's Encrypt メール欄をどう出すか（3状態） ─────────────────
describe('letsEncryptEmailFieldState: hasLetsEncryptEmail の3状態 → 欄の有無・必須/任意', () => {
  it('false（未設定と分かっている）→ 出す・必須', () => {
    expect(letsEncryptEmailFieldState(false)).toEqual({ show: true, required: true })
  })
  // ★ null（確かめられなかった）を必須にすると、通信が一時的に失敗しただけの人が公開できなくなる。
  it('★ null（確かめられなかった）→ 出すが任意（公開を止めない）', () => {
    expect(letsEncryptEmailFieldState(null)).toEqual({ show: true, required: false })
  })
  it('true（設定済み）→ 出さない', () => {
    expect(letsEncryptEmailFieldState(true)).toEqual({ show: false, required: false })
  })
})

// ── F-1 A-3（2026-09-16）: メールアドレスの最低限の形式検査（ゆるい判定） ─────────────────
describe('isLikelyEmail: ゆるい判定（@が1つ・前後が空でない・空白を含まない）', () => {
  it('通す例', () => {
    expect(isLikelyEmail('you@example.com')).toBe(true)
    expect(isLikelyEmail('a.b+tag@sub.example.co.jp')).toBe(true)
    // ゆるい判定であることを固定する: 日本語ドメイン・長い TLD を弾かない。
    expect(isLikelyEmail('例え@日本語ドメイン.jp')).toBe(true)
    expect(isLikelyEmail('you@example.technology')).toBe(true)
    expect(isLikelyEmail('  you@example.com  ')).toBe(true) // 前後の空白は trim
  })
  it('弾く例', () => {
    expect(isLikelyEmail('')).toBe(false)
    expect(isLikelyEmail('   ')).toBe(false)
    expect(isLikelyEmail('no-at-sign')).toBe(false)
    expect(isLikelyEmail('@missing-local.com')).toBe(false)
    expect(isLikelyEmail('missing-domain@')).toBe(false)
    expect(isLikelyEmail('a b@example.com')).toBe(false) // 空白を含む
    expect(isLikelyEmail('a@@example.com')).toBe(false) // '@' が2つ
    expect(isLikelyEmail(null as unknown as string)).toBe(false)
  })
})

// ── F-1（2026-09-16・任意）: letsEncryptEmail は⑧の経路だけに一本化されている ───────────────
// 消す前は⑤（AppRunDedicatedPanel.tsx のクラスタ作成・apprunDedicatedApply.ts の
// ApprunDedicatedClusterSpec/buildClusterCreateBody）にも別の letsEncryptEmail があった。
// 消したあと `grep -rn letsEncryptEmail src/` を実際に引いて確かめた、⑧の経路一式（8ファイル）
// だけを許可リストにする——ここに⑤関連のファイルが増えたら、この一覧のどれにも当たらず落ちる。
describe('letsEncryptEmail は⑧の経路（main→クラスタへの反映）だけに一本化されている（F-1 A-1）', () => {
  it('★ src/ 内での出現は、⑧の経路の8ファイルだけ（⑤関連が復活していない）', () => {
    const root = join(__dirname, '..', 'src')
    const allowed = new Set([
      join(root, 'main/ipc/apprunDedicated.ts'), // AppPublishInput・isAppPublishInput・publishApp への受け渡し
      join(root, 'main/cloud/apprunDedicatedAppApply.ts'), // publishAppFlow の 'lets-encrypt' 段
      join(root, 'main/cloud/apprunDedicated.ts'), // patchClusterLoadBalancer（PATCH の実呼び出し）のコメント
      join(root, 'shared/apprunDedicatedApp.ts'), // buildLetsEncryptPatchBody・letsEncryptEmailFieldState（F-1 A-2）
      join(root, 'renderer/global.d.ts'), // IPC 型宣言（掟6の3点セット）
      join(root, 'renderer/apprunDedicatedActions.ts'), // runPublishApp まわりの型コメント
      join(root, 'renderer/components/AppRunDedicatedPanel.tsx'), // ⑧のメール欄そのもの（F-1 A-2）
    ])
    const offenders: string[] = []
    for (const file of listTsFiles(root)) {
      if (allowed.has(file)) continue
      if (readFileSync(file, 'utf-8').includes('letsEncryptEmail')) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})

// ── G-1（2026-09-16）: 専有型は必ず Let's Encrypt を使う作りなので、80/http・443/https の
// どちらが欠けても「月額およそ2万2千円かかるのに使えないクラスタ」になる。その判定
// （missingRequiredPorts）を固定する。
describe('missingRequiredPorts: 必須ポート（80/http・443/https）が欠けていないか（G-1）', () => {
  it('REQUIRED_CLUSTER_PORTS は 80/http と 443/https の2件', () => {
    expect(REQUIRED_CLUSTER_PORTS).toEqual([
      { port: 80, protocol: 'http' },
      { port: 443, protocol: 'https' },
    ])
  })

  it('80/http と 443/https が両方あれば空', () => {
    expect(missingRequiredPorts([{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }])).toEqual([])
  })

  it('★ 80/http が無ければ拾う（今回の穴そのもの）', () => {
    expect(missingRequiredPorts([{ port: 443, protocol: 'https' }])).toEqual([{ port: 80, protocol: 'http' }])
  })

  it('★ 80/https は 80/http の代わりにならない（プロトコルまで見る）', () => {
    expect(missingRequiredPorts([{ port: 80, protocol: 'https' }, { port: 443, protocol: 'https' }]))
      .toEqual([{ port: 80, protocol: 'http' }])
  })

  it('443/https が無ければ拾う', () => {
    expect(missingRequiredPorts([{ port: 80, protocol: 'http' }])).toEqual([{ port: 443, protocol: 'https' }])
  })

  it('両方無ければ2件とも拾う', () => {
    expect(missingRequiredPorts([{ port: 8080, protocol: 'http' }])).toEqual([
      { port: 80, protocol: 'http' },
      { port: 443, protocol: 'https' },
    ])
  })

  it('余分なポートがあっても、必要な2つが揃っていれば空', () => {
    expect(missingRequiredPorts([
      { port: 80, protocol: 'http' },
      { port: 443, protocol: 'https' },
      { port: 8080, protocol: 'http' },
    ])).toEqual([])
  })

  it('null・undefined・空配列でも落ちない', () => {
    expect(missingRequiredPorts(null)).toEqual(REQUIRED_CLUSTER_PORTS as unknown as { port: number; protocol: string }[])
    expect(missingRequiredPorts(undefined)).toEqual(REQUIRED_CLUSTER_PORTS as unknown as { port: number; protocol: string }[])
    expect(missingRequiredPorts([])).toEqual(REQUIRED_CLUSTER_PORTS as unknown as { port: number; protocol: string }[])
  })
})
