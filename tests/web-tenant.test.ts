import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ADMIN_USER,
  installTenantGate,
  TENANT_COOKIE,
  tenantToken,
  type TenantApiProxy,
  type TenantRpcRequest,
  type TenantRpcResponse,
  validTenantUsername,
  WebTenantStore,
  wrapTenantApi,
} from '../plugins/web-tenant/src/index.ts'

function ok(request: TenantRpcRequest, value: unknown): TenantRpcResponse {
  return { rpcId: request.rpcId, result: { ok: true, value } }
}

class ResponseRecorder {
  body = ''
  headers = new Map<string, unknown>()
  status = 0

  end(chunk?: unknown): void {
    if (chunk !== undefined) this.body += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)
  }

  setHeader(name: string, value: unknown): void {
    this.headers.set(name.toLowerCase(), value)
  }

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.status = status
    for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value)
    return this
  }
}

function request(options: {
  accept?: string
  cookie?: string
  method?: string
  remoteAddress?: string
  url?: string
}): IncomingMessage {
  return {
    headers: {
      ...(options.accept === undefined ? {} : { accept: options.accept }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    method: options.method ?? 'GET',
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    url: options.url ?? '/',
  } as unknown as IncomingMessage
}

test('web tenant credentials register once and persist private tokens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oh-dsh-web-tenant-'))
  try {
    const store = new WebTenantStore(root)
    const first = await store.authenticateOrRegister('alice', 'correct horse')
    assert.equal(first?.created, true)
    assert.equal(first?.token, tenantToken('alice', 'correct horse'))
    assert.equal(store.authenticateToken(first?.token), 'alice')
    assert.deepEqual(store.authenticateCookie(first?.token), { kind: 'tenant', user: 'alice' })
    assert.equal(await store.authenticateOrRegister('alice', 'wrong battery'), undefined)
    assert.equal(validTenantUsername('alice.dev-1'), true)
    assert.equal(validTenantUsername('alice:dev'), false)
    await assert.rejects(store.authenticateOrRegister('../alice', 'secret'))
    await assert.rejects(store.authenticateOrRegister(ADMIN_USER, 'secret'))

    assert.equal(await readFile(store.credentialsPath, 'utf8'), `${first?.token}\n`)
    if (process.platform !== 'win32') {
      assert.equal((await stat(store.credentialsPath)).mode & 0o777, 0o600)
    }
    assert.equal(new WebTenantStore(root).authenticateToken(first?.token), 'alice')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('web tenant admin passphrase is written once and reserved from tenants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oh-dsh-web-tenant-admin-'))
  try {
    await writeFile(join(root, 'web-tenants'), `${tenantToken(ADMIN_USER, 'stale')}\n`)
    const store = new WebTenantStore(root)
    assert.equal(store.hasAdmin(), false)
    assert.equal(store.authenticateToken(tenantToken(ADMIN_USER, 'stale')), undefined)

    const created = await store.setAdminPassword('correct horse')
    assert.ok(created)
    assert.equal(created.token, tenantToken(ADMIN_USER, 'correct horse'))
    assert.equal(store.hasAdmin(), true)
    assert.deepEqual(store.authenticateCookie(created.token), { kind: 'admin' })
    assert.equal(store.authenticateAdminPassword('correct horse'), created.token)
    assert.equal(store.authenticateAdminPassword('wrong battery'), undefined)
    assert.equal(await store.setAdminPassword('other horse'), undefined)

    assert.equal(await readFile(store.adminPath, 'utf8'), `${created.token}\n`)
    if (process.platform !== 'win32') {
      assert.equal((await stat(store.adminPath)).mode & 0o777, 0o600)
    }
    assert.deepEqual(
      new WebTenantStore(root).authenticateCookie(created.token),
      { kind: 'admin' },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('web tenant gate requires a cookie and ignores the peer address', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oh-dsh-web-tenant-gate-'))
  try {
    const store = new WebTenantStore(root)
    const context = new AsyncLocalStorage<string | undefined>()
    let reached = 0
    let current: string | undefined
    const server = createServer((_request, response) => {
      reached += 1
      current = context.getStore()
      response.end('passed')
    })
    const dispose = installTenantGate(server, store, context)

    const setupPage = new ResponseRecorder()
    server.emit('request', request({
      accept: 'text/html',
      remoteAddress: '127.0.0.1',
    }), setupPage as unknown as ServerResponse)
    assert.equal(setupPage.status, 200)
    assert.match(setupPage.body, /action="\/oh-dsh\/tenant\/setup"/)
    assert.equal(reached, 0)

    const api = new ResponseRecorder()
    server.emit('request', request({
      accept: 'application/json',
      remoteAddress: '::ffff:127.0.0.1',
      url: '/api/session.list',
    }), api as unknown as ServerResponse)
    assert.equal(api.status, 401)
    assert.equal(reached, 0)

    const admin = await store.setAdminPassword('secret')
    assert.ok(admin)
    const login = await store.authenticateOrRegister('alice', 'secret')
    assert.ok(login)

    const loginPage = new ResponseRecorder()
    server.emit('request', request({
      accept: 'text/html',
      remoteAddress: '127.0.0.1',
    }), loginPage as unknown as ServerResponse)
    assert.equal(loginPage.status, 200)
    assert.match(loginPage.body, /action="\/oh-dsh\/tenant\/login"/)
    assert.doesNotMatch(loginPage.body, /action="\/oh-dsh\/tenant\/setup"/)
    assert.equal(reached, 0)

    const authenticated = new ResponseRecorder()
    server.emit('request', request({
      cookie: `${TENANT_COOKIE}=${login.token}`,
      remoteAddress: '127.0.0.1',
    }), authenticated as unknown as ServerResponse)
    assert.equal(reached, 1)
    assert.equal(current, 'alice')

    const administrator = new ResponseRecorder()
    server.emit('request', request({
      cookie: `${TENANT_COOKIE}=${admin.token}`,
      remoteAddress: '192.168.1.24',
    }), administrator as unknown as ServerResponse)
    assert.equal(reached, 2)
    assert.equal(current, undefined)

    dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('web tenant api records creates, filters lists, and hides foreign ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oh-dsh-web-tenant-api-'))
  try {
    const store = new WebTenantStore(root)
    await store.claimSession('alice', 'session-alice')
    await store.claimSession('bob', 'session-bob')
    await store.claimWorkspace('alice', 'workspace-alice')
    await store.claimWorkspace('bob', 'workspace-bob')
    let historyCalls = 0
    let createdPayload: Record<string, unknown> | undefined
    const api = {
      sessions: {
        async create(request: TenantRpcRequest): Promise<TenantRpcResponse> {
          createdPayload = request.payload
          return ok(request, { sessionId: request.payload.sessionId })
        },
        async history(request: TenantRpcRequest): Promise<TenantRpcResponse> {
          historyCalls += 1
          return ok(request, { events: [], hasMore: false })
        },
        async list(request: TenantRpcRequest): Promise<TenantRpcResponse> {
          return ok(request, { items: [
            { sessionId: 'session-alice' },
            { sessionId: 'session-bob' },
          ] })
        },
      },
      workspace: {
        async create(request: TenantRpcRequest): Promise<TenantRpcResponse> {
          return ok(request, {
            created: true,
            workspace: { sessionIds: [], workspaceId: 'workspace-new' },
          })
        },
        async list(request: TenantRpcRequest): Promise<TenantRpcResponse> {
          return ok(request, {
            archivedSessionIds: ['session-alice', 'session-bob'],
            items: [
              {
                workspaceId: 'workspace-alice',
                sessionIds: ['session-alice', 'session-bob'],
              },
              {
                workspaceId: 'workspace-bob',
                sessionIds: ['session-bob'],
              },
            ],
          })
        },
      },
    } satisfies TenantApiProxy
    const context = new AsyncLocalStorage<string | undefined>()
    const dispose = wrapTenantApi(api, store, context, async () => 'workspace-alice')

    await context.run('alice', async () => {
      const list = await (api.sessions.list as (
        request: TenantRpcRequest,
      ) => Promise<TenantRpcResponse>)({ rpcId: 'list', payload: {} })
      assert.deepEqual(okValue(list), { items: [{ sessionId: 'session-alice' }] })

      const hidden = await (api.sessions.history as (
        request: TenantRpcRequest,
      ) => Promise<TenantRpcResponse>)({
        rpcId: 'history',
        payload: { sessionId: 'session-bob' },
      })
      assert.equal(hidden.result.ok, false)
      assert.equal(hidden.result.ok ? undefined : hidden.result.error.code, 'session-not-found')
      assert.equal(historyCalls, 0)

      const created = await (api.sessions.create as (
        request: TenantRpcRequest,
      ) => Promise<TenantRpcResponse>)({ rpcId: 'create', payload: {} })
      const createdId = String(okValue(created)?.sessionId)
      assert.equal(store.ownsSession('alice', createdId), true)
      assert.equal(createdPayload?.workspaceId, 'workspace-alice')

      const workspace = await (api.workspace.create as (
        request: TenantRpcRequest,
      ) => Promise<TenantRpcResponse>)({ rpcId: 'workspace-create', payload: {} })
      assert.equal(okValue(workspace)?.created, true)
      assert.equal(store.ownsWorkspace('alice', 'workspace-new'), true)

      const workspaces = await (api.workspace.list as (
        request: TenantRpcRequest,
      ) => Promise<TenantRpcResponse>)({ rpcId: 'workspaces', payload: {} })
      assert.deepEqual(okValue(workspaces), {
        archivedSessionIds: ['session-alice'],
        items: [{
          workspaceId: 'workspace-alice',
          sessionIds: ['session-alice'],
        }],
      })
    })

    const unscopedList = await context.run(undefined, async () => {
      return await (api.sessions.list as (
        request: TenantRpcRequest,
      ) => Promise<TenantRpcResponse>)({ rpcId: 'admin', payload: {} })
    })
    assert.equal((okValue(unscopedList)?.items as unknown[]).length, 2)
    dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function okValue(response: TenantRpcResponse): Record<string, unknown> | undefined {
  return response.result.ok && typeof response.result.value === 'object'
    && response.result.value !== null && !Array.isArray(response.result.value)
    ? response.result.value as Record<string, unknown>
    : undefined
}
