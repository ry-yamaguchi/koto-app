import { describe, it, expect } from 'vitest'
import { isValidHost, isValidPort, isValidUsername, isValidPublicKey, assertSafeForShell } from '../src/main/vps/validate'
import { buildStartupScript, buildInstallKeyCommands, buildHardenSshdCommands } from '../src/main/vps/scripts'

// 実在っぽい ed25519 公開鍵のダミー値（base64本体は形式チェックのみを満たせばよく、実鍵である必要はない）。
const PUBKEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJlfxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx koto-vps'
const PUBKEY_NO_COMMENT = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJlfxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

describe('isValidHost', () => {
  it('accepts IPv4 addresses', () => {
    expect(isValidHost('192.168.1.1')).toBe(true)
    expect(isValidHost('160.16.1.1')).toBe(true)
  })

  it('accepts FQDNs', () => {
    expect(isValidHost('xxx.vs.sakura.ne.jp')).toBe(true)
    expect(isValidHost('example.com')).toBe(true)
    expect(isValidHost('localhost')).toBe(true)
    expect(isValidHost('a.b.c.d.example.com')).toBe(true)
  })

  it('rejects command-injection attempts', () => {
    expect(isValidHost('evil.com; rm -rf /')).toBe(false)
    expect(isValidHost('evil.com`rm -rf /`')).toBe(false)
    expect(isValidHost('evil.com$(rm -rf /)')).toBe(false)
    expect(isValidHost('evil.com\nrm -rf /')).toBe(false)
    expect(isValidHost('evil.com && rm -rf /')).toBe(false)
    expect(isValidHost('evil.com | rm -rf /')).toBe(false)
    expect(isValidHost('"evil.com"')).toBe(false)
    expect(isValidHost("'evil.com'")).toBe(false)
    expect(isValidHost('evil.com; ')).toBe(false)
    expect(isValidHost(' evil.com')).toBe(false)
    expect(isValidHost('evil.com ')).toBe(false)
  })

  it('rejects malformed hosts', () => {
    expect(isValidHost('')).toBe(false)
    expect(isValidHost('-evil.com')).toBe(false)
    expect(isValidHost('evil-.com')).toBe(false)
    expect(isValidHost('evil..com')).toBe(false)
    expect(isValidHost('a'.repeat(300))).toBe(false)
    expect(isValidHost(null)).toBe(false)
    expect(isValidHost(undefined)).toBe(false)
    expect(isValidHost(123 as unknown as string)).toBe(false)
  })
})

describe('isValidPort', () => {
  it('accepts integers in range 1-65535', () => {
    expect(isValidPort(1)).toBe(true)
    expect(isValidPort(22)).toBe(true)
    expect(isValidPort(65535)).toBe(true)
  })

  it('rejects out-of-range or non-integer values', () => {
    expect(isValidPort(0)).toBe(false)
    expect(isValidPort(65536)).toBe(false)
    expect(isValidPort(-1)).toBe(false)
    expect(isValidPort(22.5)).toBe(false)
    expect(isValidPort(NaN)).toBe(false)
    expect(isValidPort('22' as unknown as number)).toBe(false)
    expect(isValidPort(null)).toBe(false)
    expect(isValidPort(undefined)).toBe(false)
  })
})

describe('isValidUsername', () => {
  it('accepts the fixed account names used by scripts.ts', () => {
    expect(isValidUsername('sakura-admin')).toBe(true)
    expect(isValidUsername('deploy')).toBe(true)
    expect(isValidUsername('_svc')).toBe(true)
  })

  it('accepts a 32-char username and rejects a 33-char one', () => {
    expect(isValidUsername('a'.repeat(32))).toBe(true)
    expect(isValidUsername('a'.repeat(33))).toBe(false)
  })

  it('rejects uppercase, digit-first, and empty names', () => {
    expect(isValidUsername('Deploy')).toBe(false)
    expect(isValidUsername('1abc')).toBe(false)
    expect(isValidUsername('')).toBe(false)
  })

  it('rejects command-injection attempts', () => {
    expect(isValidUsername('deploy; rm -rf /')).toBe(false)
    expect(isValidUsername('deploy`whoami`')).toBe(false)
    expect(isValidUsername('deploy$(whoami)')).toBe(false)
    expect(isValidUsername('deploy\nrm -rf /')).toBe(false)
    expect(isValidUsername('deploy && rm -rf /')).toBe(false)
  })
})

describe('isValidPublicKey', () => {
  it('accepts a well-formed ssh-ed25519 key with or without a comment', () => {
    expect(isValidPublicKey(PUBKEY)).toBe(true)
    expect(isValidPublicKey(PUBKEY_NO_COMMENT)).toBe(true)
  })

  it('rejects other key types', () => {
    expect(isValidPublicKey('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC1example koto-vps')).toBe(false)
    expect(isValidPublicKey('ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY koto-vps')).toBe(false)
  })

  it('rejects command-injection attempts embedded in the comment', () => {
    expect(isValidPublicKey(`${PUBKEY_NO_COMMENT} ; rm -rf /`)).toBe(false)
    expect(isValidPublicKey(`${PUBKEY_NO_COMMENT} $(rm -rf /)`)).toBe(false)
    expect(isValidPublicKey(`${PUBKEY_NO_COMMENT} \`rm -rf /\``)).toBe(false)
    expect(isValidPublicKey(`${PUBKEY_NO_COMMENT}\nrm -rf /`)).toBe(false)
    expect(isValidPublicKey(`${PUBKEY_NO_COMMENT} koto-vps; rm -rf /`)).toBe(false)
    // 3フィールド（type body comment）に収まる形でも、コメント自体に危険文字が混じっていれば拒否する
    expect(isValidPublicKey(`${PUBKEY_NO_COMMENT} evil;rm`)).toBe(false)
    expect(isValidPublicKey(`${PUBKEY_NO_COMMENT} evil$(rm)`)).toBe(false)
  })

  it('rejects malformed keys', () => {
    expect(isValidPublicKey('')).toBe(false)
    expect(isValidPublicKey('ssh-ed25519')).toBe(false)
    expect(isValidPublicKey('ssh-ed25519 short')).toBe(false)
    expect(isValidPublicKey(`  ${PUBKEY}`)).toBe(false) // 前後空白
    expect(isValidPublicKey(null)).toBe(false)
    expect(isValidPublicKey(undefined)).toBe(false)
  })
})

describe('assertSafeForShell', () => {
  it('does not throw for values that already passed isValidHost/isValidUsername/isValidPublicKey', () => {
    expect(() => assertSafeForShell('xxx.vs.sakura.ne.jp')).not.toThrow()
    expect(() => assertSafeForShell('sakura-admin')).not.toThrow()
    expect(() => assertSafeForShell(PUBKEY)).not.toThrow()
  })

  it('throws for shell metacharacters and injection attempts', () => {
    expect(() => assertSafeForShell('foo; rm -rf /')).toThrow()
    expect(() => assertSafeForShell('foo`rm -rf /`')).toThrow()
    expect(() => assertSafeForShell('foo$(rm -rf /)')).toThrow()
    expect(() => assertSafeForShell('foo\nrm -rf /')).toThrow()
    expect(() => assertSafeForShell('foo && rm -rf /')).toThrow()
    expect(() => assertSafeForShell('foo | rm -rf /')).toThrow()
    expect(() => assertSafeForShell('foo > /etc/passwd')).toThrow()
    expect(() => assertSafeForShell('foo"bar')).toThrow()
    expect(() => assertSafeForShell("foo'bar")).toThrow()
  })
})

const IDENTITY = { publicKey: PUBKEY, adminUser: 'sakura-admin', deployUser: 'deploy' }

describe('buildStartupScript', () => {
  const script = buildStartupScript(IDENTITY)

  it('embeds the public key exactly once per user and both usernames', () => {
    expect(script.split(PUBKEY).length - 1).toBe(2) // sakura-admin用・deploy用の2回
    expect(script).toContain('sakura-admin')
    expect(script).toContain('deploy')
  })

  it('never contains a shebang other than the first line, and starts correctly', () => {
    expect(script.startsWith('#!/bin/bash\n')).toBe(true)
  })

  it('does not embed any secret-like content (no password field exists on the input type)', () => {
    expect(script.toLowerCase()).not.toContain('password=')
  })

  it('hardens sshd (password auth disabled, root login disabled, pubkey auth enabled)', () => {
    expect(script).toContain('PasswordAuthentication no')
    expect(script).toContain('PermitRootLogin no')
    expect(script).toContain('PubkeyAuthentication yes')
  })

  it('validates sshd config (`sshd -t`) before reloading it', () => {
    const testIdx = script.indexOf('sshd -t')
    const reloadIdx = script.indexOf('systemctl reload sshd')
    expect(testIdx).toBeGreaterThan(-1)
    expect(reloadIdx).toBeGreaterThan(-1)
    expect(testIdx).toBeLessThan(reloadIdx)
  })

  it('creates both accounts idempotently (id -u check before useradd) and gives deploy ownership of /srv/app', () => {
    expect(script).toContain('id -u sakura-admin >/dev/null 2>&1 || useradd')
    expect(script).toContain('id -u deploy >/dev/null 2>&1 || useradd')
    expect(script).toContain('/srv/app')
    expect(script).toContain('chown deploy:deploy /srv/app')
  })

  it('grants sudo only to the admin user, not the deploy user', () => {
    expect(script).toContain('usermod -aG sudo sakura-admin')
    expect(script).not.toContain('usermod -aG sudo deploy')
  })

  it('rejects invalid identity fields (command injection attempts)', () => {
    expect(() => buildStartupScript({ ...IDENTITY, adminUser: 'sakura-admin; rm -rf /' })).toThrow()
    expect(() => buildStartupScript({ ...IDENTITY, deployUser: '$(whoami)' })).toThrow()
    expect(() => buildStartupScript({ ...IDENTITY, publicKey: 'ssh-rsa AAAA' })).toThrow()
    expect(() => buildStartupScript({ ...IDENTITY, adminUser: 'deploy', deployUser: 'deploy' })).toThrow()
  })
})

describe('buildInstallKeyCommands (route B)', () => {
  const commands = buildInstallKeyCommands(IDENTITY)
  const joined = commands.join('\n')

  it('embeds the public key and both usernames, without hardening sshd', () => {
    expect(joined).toContain(PUBKEY)
    expect(joined).toContain('sakura-admin')
    expect(joined).toContain('deploy')
    expect(joined).not.toContain('PasswordAuthentication')
    expect(joined).not.toContain('PermitRootLogin')
    expect(joined.toLowerCase()).not.toContain('password=')
  })

  it('rejects invalid identity fields', () => {
    expect(() => buildInstallKeyCommands({ ...IDENTITY, publicKey: 'not-a-key' })).toThrow()
    expect(() => buildInstallKeyCommands({ ...IDENTITY, adminUser: 'admin`id`' })).toThrow()
  })
})

describe('buildHardenSshdCommands (called only after key-auth is confirmed)', () => {
  const commands = buildHardenSshdCommands()
  const joined = commands.join('\n')

  it('disables password auth and root login, enables pubkey auth', () => {
    expect(joined).toContain('PasswordAuthentication no')
    expect(joined).toContain('PermitRootLogin no')
    expect(joined).toContain('PubkeyAuthentication yes')
  })

  it('validates config (`sshd -t`) strictly before reloading', () => {
    const testIdx = joined.indexOf('sshd -t')
    const reloadIdx = joined.indexOf('systemctl reload sshd')
    expect(testIdx).toBeGreaterThan(-1)
    expect(reloadIdx).toBeGreaterThan(-1)
    expect(testIdx).toBeLessThan(reloadIdx)
  })

  it('does not create or touch user accounts (that is buildInstallKeyCommands/buildStartupScript job)', () => {
    expect(joined).not.toContain('useradd')
  })
})
