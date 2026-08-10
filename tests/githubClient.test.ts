import { describe, it, expect } from 'vitest'
import {
  splitRepoFullName, isRepoNameConflict, describeCreateRepoError, describeUserError,
  githubRefPath, githubUpdateRefPath, githubBlobsPath, githubTreesPath, githubCommitsPath,
} from '../src/main/github/client'

describe('splitRepoFullName', () => {
  it('splits a normal owner/repo string', () => {
    expect(splitRepoFullName('octocat/hello-world')).toEqual({ owner: 'octocat', repo: 'hello-world' })
  })

  it('returns null for a string without a slash', () => {
    expect(splitRepoFullName('no-slash')).toBeNull()
  })

  it('returns null for a string with more than one slash', () => {
    expect(splitRepoFullName('a/b/c')).toBeNull()
  })

  it('returns null for empty, null, or undefined input', () => {
    expect(splitRepoFullName('')).toBeNull()
    expect(splitRepoFullName(null as any)).toBeNull()
    expect(splitRepoFullName(undefined as any)).toBeNull()
  })

  it('trims surrounding whitespace before splitting', () => {
    expect(splitRepoFullName('  octocat/hello-world  ')).toEqual({ owner: 'octocat', repo: 'hello-world' })
  })

  it('returns null when the string contains internal whitespace', () => {
    expect(splitRepoFullName('octo cat/hello')).toBeNull()
  })
})

describe('isRepoNameConflict', () => {
  it('detects a name conflict from the errors array (message form)', () => {
    const data = { message: 'Validation Failed', errors: [{ resource: 'Repository', code: 'custom', message: 'name already exists on this account' }] }
    expect(isRepoNameConflict(422, data)).toBe(true)
  })

  it('detects a name conflict from the errors array (code form)', () => {
    const data = { errors: [{ resource: 'Repository', code: 'already_exists', field: 'name' }] }
    expect(isRepoNameConflict(422, data)).toBe(true)
  })

  it('detects a name conflict from a top-level message when errors is absent', () => {
    expect(isRepoNameConflict(422, { message: 'name already exists on this account' })).toBe(true)
  })

  it('returns false when status is not 422', () => {
    expect(isRepoNameConflict(401, { message: 'name already exists on this account' })).toBe(false)
  })

  it('returns false for an unrelated 422 validation error', () => {
    const data = { errors: [{ resource: 'Repository', code: 'invalid', field: 'name' }] }
    expect(isRepoNameConflict(422, data)).toBe(false)
  })

  it('returns false for null/undefined data', () => {
    expect(isRepoNameConflict(422, null)).toBe(false)
    expect(isRepoNameConflict(422, undefined)).toBe(false)
  })
})

describe('describeCreateRepoError', () => {
  it('gives a Japanese "name already exists" message on 422 name conflict', () => {
    const data = { message: 'name already exists on this account' }
    expect(describeCreateRepoError(422, data)).toBe('その名前の保管場所は既に存在します。別の名前を試してください。')
  })

  it('gives an auth failure message for 401', () => {
    expect(describeCreateRepoError(401, {})).toBe('認証に失敗しました（GitHub のトークンと権限を確認してください）。')
  })

  it('gives an auth failure message for 403', () => {
    expect(describeCreateRepoError(403, {})).toBe('認証に失敗しました（GitHub のトークンと権限を確認してください）。')
  })

  it('gives a generic 422 message when not a name conflict', () => {
    const data = { errors: [{ code: 'invalid', field: 'name' }] }
    expect(describeCreateRepoError(422, data)).toBe('リポジトリを作成できませんでした（入力内容を確認してください・HTTP 422）')
  })

  it('gives a generic message for other statuses', () => {
    expect(describeCreateRepoError(500, {})).toBe('リポジトリの作成に失敗しました（HTTP 500）')
  })
})

describe('describeUserError', () => {
  it('gives an auth failure message for 401 and 403', () => {
    expect(describeUserError(401)).toBe('認証に失敗しました（GitHub のトークンを確認してください）')
    expect(describeUserError(403)).toBe('認証に失敗しました（GitHub のトークンを確認してください）')
  })

  it('gives a generic message for other statuses', () => {
    expect(describeUserError(500)).toBe('接続に失敗しました（HTTP 500）')
  })
})

describe('endpoint path builders', () => {
  it('builds ref paths with heads/<branch>', () => {
    expect(githubRefPath('o', 'r', 'heads/main')).toBe('/repos/o/r/git/ref/heads/main')
  })

  it('builds update ref paths', () => {
    expect(githubUpdateRefPath('o', 'r', 'heads/main')).toBe('/repos/o/r/git/refs/heads/main')
  })

  it('builds blobs/trees/commits paths', () => {
    expect(githubBlobsPath('o', 'r')).toBe('/repos/o/r/git/blobs')
    expect(githubTreesPath('o', 'r')).toBe('/repos/o/r/git/trees')
    expect(githubCommitsPath('o', 'r')).toBe('/repos/o/r/git/commits')
  })

  it('URL-encodes owner/repo with special characters', () => {
    expect(githubBlobsPath('my org', 'my repo')).toBe('/repos/my%20org/my%20repo/git/blobs')
  })
})
