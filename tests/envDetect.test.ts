import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { detectEnvKeysInProject } from '../src/main/envDetect'

describe('detectEnvKeysInProject', () => {
  let dir: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envdetect-'))

    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'src', 'app.js'),
      [
        "const key = process.env.API_KEY",
        "const db = process.env['DATABASE_URL']",
        "const port = process.env.PORT",
        "const refresh = process.env[`REFRESH_TOKEN`]",
        '',
      ].join('\n'),
    )

    fs.writeFileSync(
      path.join(dir, 'server.py'),
      [
        "secret_key = os.getenv('SECRET_KEY')",
        "debug = os.environ['DEBUG']",
        "redis_url = os.environ.get(\"REDIS_URL\")",
        '',
      ].join('\n'),
    )

    fs.writeFileSync(
      path.join(dir, 'index.php'),
      "<?php $s = getenv('STRIPE_KEY'); $h = $_ENV['MAIL_HOST']; ?>",
    )

    fs.writeFileSync(
      path.join(dir, '.env.example'),
      [
        'FOO=1',
        'export BAR=baz',
        'ADMIN_PASSWORD=',
        '# comment',
        '',
      ].join('\n'),
    )

    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'node_modules', 'lib.js'),
      'const x = process.env.SHOULD_NOT_APPEAR',
    )

    fs.writeFileSync(
      path.join(dir, '.hanamii-static.js'),
      'const x = process.env.ALSO_EXCLUDED',
    )
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('detects env keys across languages/formats while excluding PORT, node_modules, and .hanamii-static.js', () => {
    const result = detectEnvKeysInProject(dir)
    expect(result).toEqual(
      [
        'ADMIN_PASSWORD',
        'API_KEY',
        'BAR',
        'DATABASE_URL',
        'DEBUG',
        'FOO',
        'MAIL_HOST',
        'REDIS_URL',
        'REFRESH_TOKEN',
        'SECRET_KEY',
        'STRIPE_KEY',
      ].sort(),
    )
  })

  it('returns an empty array for a nonexistent directory', () => {
    const missing = path.join(dir, 'does-not-exist-' + Math.random().toString(36).slice(2))
    expect(detectEnvKeysInProject(missing)).toEqual([])
  })
})
