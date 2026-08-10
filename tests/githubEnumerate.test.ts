import { describe, it, expect } from 'vitest'
import { isEnvFileName, isSkippedDirName, isSkippedFileName, excludeReason, partitionEntries, MAX_FILE_BYTES } from '../src/main/github/enumerate'

describe('isEnvFileName', () => {
  it('matches bare .env', () => {
    expect(isEnvFileName('.env')).toBe(true)
  })

  it('matches .env.local, .env.production, etc.', () => {
    expect(isEnvFileName('.env.local')).toBe(true)
    expect(isEnvFileName('.env.production')).toBe(true)
  })

  it('does not match unrelated files', () => {
    expect(isEnvFileName('env.ts')).toBe(false)
    expect(isEnvFileName('environment.json')).toBe(false)
    expect(isEnvFileName('README.md')).toBe(false)
  })
})

describe('isSkippedDirName', () => {
  it('flags node_modules, .git, and other known heavy dirs', () => {
    expect(isSkippedDirName('node_modules')).toBe(true)
    expect(isSkippedDirName('.git')).toBe(true)
    expect(isSkippedDirName('dist')).toBe(true)
  })

  it('does not flag ordinary source directories', () => {
    expect(isSkippedDirName('src')).toBe(false)
    expect(isSkippedDirName('components')).toBe(false)
  })
})

describe('isSkippedFileName', () => {
  it('flags .DS_Store', () => {
    expect(isSkippedFileName('.DS_Store')).toBe(true)
  })

  it('does not flag ordinary files', () => {
    expect(isSkippedFileName('index.ts')).toBe(false)
    expect(isSkippedFileName('.env')).toBe(false)
  })
})

describe('excludeReason', () => {
  it('excludes .env files regardless of size', () => {
    expect(excludeReason('.env', 10)).toBe('env')
    expect(excludeReason('config/.env.production', 10)).toBe('env')
  })

  it('excludes files over the size limit', () => {
    expect(excludeReason('big.zip', MAX_FILE_BYTES + 1)).toBe('size')
  })

  it('includes normal small files', () => {
    expect(excludeReason('src/index.ts', 1024)).toBeNull()
  })

  it('treats exactly-at-limit size as included (not excluded)', () => {
    expect(excludeReason('exact.bin', MAX_FILE_BYTES)).toBeNull()
  })

  it('prioritizes env exclusion even for small env files', () => {
    expect(excludeReason('.env', 1)).toBe('env')
  })
})

describe('partitionEntries', () => {
  it('separates included and excluded files with reasons', () => {
    const result = partitionEntries([
      { rel: 'src/index.ts', sizeBytes: 100 },
      { rel: '.env', sizeBytes: 20 },
      { rel: 'assets/huge.bin', sizeBytes: MAX_FILE_BYTES + 1 },
      { rel: 'README.md', sizeBytes: 500 },
    ])
    expect(result.included).toEqual(['src/index.ts', 'README.md'])
    expect(result.excluded).toEqual([
      { path: '.env', reason: 'env' },
      { path: 'assets/huge.bin', reason: 'size' },
    ])
  })

  it('returns empty arrays for empty input', () => {
    expect(partitionEntries([])).toEqual({ included: [], excluded: [] })
  })

  it('includes everything when nothing needs exclusion', () => {
    const result = partitionEntries([
      { rel: 'a.ts', sizeBytes: 10 },
      { rel: 'b.ts', sizeBytes: 20 },
    ])
    expect(result.excluded).toEqual([])
    expect(result.included).toEqual(['a.ts', 'b.ts'])
  })
})
