import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets, formatLogLine, trimLog } from '../src/shared/updateLog'

// 2026-08-11。自動更新は失敗しても画面が静かなままで、原因を追う手段が無かった。
// ログを残すことにしたが、**このログは利用者が私に送ってくるもの**なので、
// ここに秘密が混ざると秘密が外へ出る。書く前に落とすのがこのモジュールの役目（掟10）。

describe('秘密を伏せる', () => {
  // electron-updater は配信元のURLを記録する。private 配信へ切り替えたときが危ない
  it('URL に埋め込まれた資格情報を伏せる', () => {
    expect(redactSecrets('GET https://user:p@ssw0rd@github.com/x/y'))
      .toBe('GET https://***@github.com/x/y')
  })

  it('名前つきのパラメータを伏せる', () => {
    expect(redactSecrets('?access_token=abcdefgh12345678')).toContain('***')
    expect(redactSecrets('?access_token=abcdefgh12345678')).not.toContain('abcdefgh12345678')
    expect(redactSecrets('"api_key": "abcdefgh12345678"')).not.toContain('abcdefgh12345678')
    expect(redactSecrets('Authorization: Bearer abcdefgh12345678')).not.toContain('abcdefgh12345678')
    expect(redactSecrets('password=hunter22222')).not.toContain('hunter22222')
  })

  it('形で分かる秘密は、前後がどうであれ落とす', () => {
    const cases = [
      'ghp_0123456789abcdefghij',
      'github_pat_0123456789abcdefghij0123',
      'sk-ant-0123456789abcdefghij',
    ]
    for (const c of cases) {
      expect(redactSecrets(`なにか ${c} なにか`)).not.toContain(c)
      expect(redactSecrets(`なにか ${c} なにか`)).toContain('***')
    }
  })

  it('秘密鍵は丸ごと落とす', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nAAAA\nBBBB\n-----END RSA PRIVATE KEY-----'
    expect(redactSecrets(`key: ${pem}`)).not.toContain('AAAA')
  })

  // 全部伏せたらログの意味が無くなる。調べるのに要るものは残す
  it('調べるのに要る情報は残す', () => {
    const keep = [
      'https://github.com/ry-yamaguchi/koto-app/releases/download/v0.3.3/latest-mac.yml',
      'Found version 0.3.3 (url: Koto-0.3.3-arm64-mac.zip)',
      'sha512 checksum mismatch, expected TAk9g2z+mtQ2xtZUa3skK7aW245F6YNYeXQug/x86Oi5',
      'Unable to locate previous update.zip for differential download',
      'net::ERR_INTERNET_DISCONNECTED',
    ]
    for (const k of keep) expect(redactSecrets(k)).toBe(k)
  })

  it('空・未定義でも落ちない', () => {
    expect(redactSecrets('')).toBe('')
    expect(redactSecrets(undefined as unknown as string)).toBe('')
  })
})

describe('1行に組み立てる', () => {
  const T = new Date('2026-08-11T12:00:00.000Z')

  it('時刻と深刻度を頭に付ける', () => {
    expect(formatLogLine('info', 'checking for update', T))
      .toBe('2026-08-11T12:00:00.000Z [info] checking for update')
  })

  // 1件＝1行でないと、後ろから行単位で捨てられなくなる
  it('改行を潰して必ず1行にする', () => {
    const out = formatLogLine('error', 'あ\nい\nう', T)
    expect(out.split('\n')).toHaveLength(1)
    expect(out).toContain('あ ⏎ い ⏎ う')
  })

  it('Error はメッセージとスタックを残す', () => {
    const e = new Error('feed が読めません')
    const out = formatLogLine('error', e, T)
    expect(out).toContain('feed が読めません')
    expect(out.split('\n')).toHaveLength(1)
  })

  it('文字列でないものも書ける', () => {
    expect(formatLogLine('debug', { version: '0.3.3' }, T)).toContain('0.3.3')
  })

  // ここを通さないと、秘密がそのままファイルに残る
  it('組み立てる時点で秘密を落とす', () => {
    expect(formatLogLine('info', 'token=abcdefgh12345678', T)).not.toContain('abcdefgh12345678')
  })

  // ログは利用者が作者へ送る。貼り付け先が公開の場所のこともあるので、利用者名を含むホームのパスは `~` にする
  it('★ ホームのパス（利用者名）を ~ にする。その下のフォルダ名は残す。エラーのスタックも', () => {
    const line = formatLogLine('error', "ENOENT: open '/Users/tanaka/Library/Caches/koto-updater/pending/Koto.zip'", T)
    expect(line).not.toContain('tanaka')
    expect(line).toContain("open '~/Library/Caches/koto-updater/pending/Koto.zip'")
    const withStack = formatLogLine('error', Object.assign(new Error('boom'), { stack: 'Error: boom\n    at read (/Users/tanaka/app/main.js:1:1)' }), T)
    expect(withStack).not.toContain('tanaka')
    expect(withStack).toContain('at read (~/app/main.js:1:1)')
  })

  it('実行している環境のホーム（home）を渡せば、/Users の外でも ~ にする', () => {
    expect(formatLogLine('info', 'cache=/var/folders/zz/tanaka-home/c', T, '/var/folders/zz/tanaka-home')).toBe('2026-08-11T12:00:00.000Z [info] cache=~/c')
    expect(formatLogLine('info', 'cache=/var/folders/zz/tanaka-home/c', T)).toContain('/var/folders/zz/tanaka-home/c')
  })

  it('★ 更新ログの書き手は、ホームを渡して行を組み立てる（組み立ては formatLogLine の1か所）', () => {
    const src = readFileSync(join(__dirname, '..', 'src/main/updateLog.ts'), 'utf-8')
    expect(src).toContain("fs.appendFileSync(p, formatLogLine(level, message, new Date(), os.homedir()) + '\\n', 'utf8')")
    expect(src).not.toContain('formatLogLine(level, message, new Date()) +')
  })
})

describe('際限なく育たないようにする', () => {
  it('上限以下ならそのまま（無駄に書き換えない）', () => {
    const s = 'a\nb\nc\n'
    expect(trimLog(s, 1000)).toBe(s)
  })

  it('古い行から捨てる', () => {
    const s = ['1行目', '2行目', '3行目', '4行目'].join('\n') + '\n'
    const out = trimLog(s, 24)
    expect(out).toContain('4行目')
    expect(out).not.toContain('1行目')
  })

  // 途中で切ると壊れた行が残り、読む人を混乱させる
  it('行の途中では切らない', () => {
    const s = ['あああああああああ', 'いいいいいいいいい', 'ううううううううう'].join('\n') + '\n'
    const out = trimLog(s, 40)
    for (const line of out.split('\n').filter(Boolean)) {
      expect(['あああああああああ', 'いいいいいいいいい', 'ううううううううう']).toContain(line)
    }
  })

  it('必ず上限以下に収まる', () => {
    const s = Array.from({ length: 500 }, (_, i) => `${i} 行目のログ`).join('\n') + '\n'
    expect(Buffer.byteLength(trimLog(s, 500), 'utf8')).toBeLessThanOrEqual(500)
  })
})
