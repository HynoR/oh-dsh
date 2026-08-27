import { AsyncLocalStorage } from 'node:async_hooks'
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import {
  chmodSync,
  readFileSync,
} from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import type {
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'

const TENANT_BASE = '/oh-dsh/tenant'
export const TENANT_COOKIE = 'oh_dsh_tenant'
export const ADMIN_USER = 'admin'
const TENANT_ADMIN_FILE = 'web-tenant-admin'
const TENANT_CREDENTIALS_FILE = 'web-tenants'
const TENANT_INDEX_FILE = 'web-tenants-index.json'

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,32}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const TENANT_PATHS = new Set([
  `${TENANT_BASE}/login`,
  `${TENANT_BASE}/logout`,
  `${TENANT_BASE}/me`,
  `${TENANT_BASE}/setup`,
])

export type TenantSession =
  | { kind: 'admin' }
  | { kind: 'tenant'; user: string }

type TenantIds = {
  sessionIds: Set<string>
  workspaceIds: Set<string>
}

type StoredTenantIds = {
  sessionIds: string[]
  workspaceIds: string[]
}

export interface TenantRpcRequest {
  rpcId: string
  payload: Record<string, unknown>
}

export interface TenantRpcResponse {
  rpcId: string
  result:
    | { ok: true; value: unknown }
    | {
      ok: false
      error: {
        code: string
        message: string
        details: Record<string, unknown>
      }
    }
}

type Unary = (
  request: TenantRpcRequest,
  signal?: AbortSignal,
) => Promise<TenantRpcResponse>

type ApiDomain = Record<string, unknown>

export interface TenantApiProxy {
  sessions?: ApiDomain
  workspace?: ApiDomain
}

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (
      request: IncomingMessage,
      response: ServerResponse,
    ) => void | Promise<void>
  }): () => void
  server?: Server
}

interface HostContext {
  apiProxy: TenantApiProxy
  effect(effect: () => (() => void) | void, label?: string): void
  logger: { warn(message: string): void }
  webServer: WebServerLike
}

type LoginError = 'credentials' | 'password' | 'username' | 'workspace'

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

function readPrivateFile(path: string): string | undefined {
  try {
    const content = readFileSync(path, 'utf8')
    chmodSync(path, 0o600)
    return content
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.next-${randomBytes(6).toString('hex')}`
  await writeFile(temporary, content, { mode: 0o600 })
  try {
    await rename(temporary, path)
  } catch (error) {
    if (errorCode(error) !== 'EEXIST' && errorCode(error) !== 'EPERM') {
      await unlink(temporary).catch(() => {})
      throw error
    }
    await copyFile(temporary, path)
    await unlink(temporary)
  }
  await chmod(path, 0o600)
}

function safeHashEqual(left: string, right: string): boolean {
  if (!HASH_PATTERN.test(left) || !HASH_PATTERN.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

export function validTenantUsername(value: string): boolean {
  return USERNAME_PATTERN.test(value)
}

function parseTenantToken(
  value: string,
): { hash: string; user: string } | undefined {
  const separator = value.indexOf(':')
  if (separator < 1) return
  const user = value.slice(0, separator)
  const hash = value.slice(separator + 1)
  if (!validTenantUsername(user) || !HASH_PATTERN.test(hash)) return
  return { hash, user }
}

export function tenantToken(user: string, password: string): string {
  if (!validTenantUsername(user)) throw new Error('invalid tenant username')
  if (password.length < 1 || password.length > 1024) {
    throw new Error('tenant password must contain 1 to 1024 characters')
  }
  return `${user}:${createHash('sha256').update(password, 'utf8').digest('hex')}`
}

function parseCredentials(content: string | undefined): Map<string, string> {
  const credentials = new Map<string, string>()
  if (content === undefined || content === '') return credentials
  for (const line of content.split('\n')) {
    if (line === '') continue
    const token = parseTenantToken(line)
    if (token === undefined) throw new Error('web tenant credential file is invalid')
    if (token.user === ADMIN_USER) continue
    const current = credentials.get(token.user)
    if (current !== undefined && !safeHashEqual(current, token.hash)) {
      throw new Error(`web tenant credential file contains conflicting user ${token.user}`)
    }
    credentials.set(token.user, token.hash)
  }
  return credentials
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) {
    return
  }
  return [...new Set(value)]
}

function parseIndex(content: string | undefined): Map<string, TenantIds> {
  if (content === undefined) return new Map()
  const value = JSON.parse(content) as unknown
  if (!isRecord(value)) throw new Error('web tenant index is invalid')
  const index = new Map<string, TenantIds>()
  const sessionOwners = new Set<string>()
  const workspaceOwners = new Set<string>()
  for (const [user, entry] of Object.entries(value)) {
    if (!validTenantUsername(user) || !isRecord(entry)) {
      throw new Error('web tenant index is invalid')
    }
    const sessionIds = stringArray(entry.sessionIds)
    const workspaceIds = stringArray(entry.workspaceIds)
    if (sessionIds === undefined || workspaceIds === undefined) {
      throw new Error('web tenant index is invalid')
    }
    for (const id of sessionIds) {
      if (sessionOwners.has(id)) throw new Error('web tenant index shares a session id')
      sessionOwners.add(id)
    }
    for (const id of workspaceIds) {
      if (workspaceOwners.has(id)) throw new Error('web tenant index shares a workspace id')
      workspaceOwners.add(id)
    }
    index.set(user, {
      sessionIds: new Set(sessionIds),
      workspaceIds: new Set(workspaceIds),
    })
  }
  return index
}

function cloneIndex(index: ReadonlyMap<string, TenantIds>): Map<string, TenantIds> {
  return new Map([...index].map(([user, ids]) => [user, {
    sessionIds: new Set(ids.sessionIds),
    workspaceIds: new Set(ids.workspaceIds),
  }]))
}

function serializedIndex(index: ReadonlyMap<string, TenantIds>): string {
  const value = Object.fromEntries([...index].map(([user, ids]) => [user, {
    sessionIds: [...ids.sessionIds],
    workspaceIds: [...ids.workspaceIds],
  } satisfies StoredTenantIds]))
  return `${JSON.stringify(value, undefined, 2)}\n`
}

function parseAdminHash(content: string | undefined): string | undefined {
  if (content === undefined) return
  const lines = content.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (lines.length === 0) return
  if (lines.length !== 1) throw new Error('web tenant admin file is invalid')
  const token = parseTenantToken(lines[0] ?? '')
  if (token === undefined || token.user !== ADMIN_USER) {
    throw new Error('web tenant admin file is invalid')
  }
  return token.hash
}

/** Durable credentials and ownership index under the existing Oh-DSH data root. */
export class WebTenantStore {
  readonly adminPath: string
  readonly credentialsPath: string
  readonly indexPath: string
  #adminHash: string | undefined
  #credentials: Map<string, string>
  #index: Map<string, TenantIds>
  #tail = Promise.resolve()

  constructor(dataRoot: string) {
    this.adminPath = join(dataRoot, TENANT_ADMIN_FILE)
    this.credentialsPath = join(dataRoot, TENANT_CREDENTIALS_FILE)
    this.indexPath = join(dataRoot, TENANT_INDEX_FILE)
    this.#adminHash = parseAdminHash(readPrivateFile(this.adminPath))
    this.#credentials = parseCredentials(readPrivateFile(this.credentialsPath))
    this.#index = parseIndex(readPrivateFile(this.indexPath))
  }

  hasAdmin(): boolean {
    return this.#adminHash !== undefined
  }

  authenticateToken(value: string | undefined): string | undefined {
    if (value === undefined) return
    const token = parseTenantToken(value)
    if (token === undefined || token.user === ADMIN_USER) return
    const expected = this.#credentials.get(token.user)
    if (expected === undefined || !safeHashEqual(expected, token.hash)) return
    return token.user
  }

  authenticateCookie(value: string | undefined): TenantSession | undefined {
    if (value === undefined) return
    const token = parseTenantToken(value)
    if (token === undefined) return
    if (token.user === ADMIN_USER) {
      if (this.#adminHash !== undefined && safeHashEqual(this.#adminHash, token.hash)) {
        return { kind: 'admin' }
      }
      return
    }
    const user = this.authenticateToken(value)
    if (user === undefined) return
    return { kind: 'tenant', user }
  }

  authenticateAdminPassword(password: string): string | undefined {
    if (this.#adminHash === undefined) return
    if (password.length < 1 || password.length > 1024) return
    const token = tenantToken(ADMIN_USER, password)
    const parsed = parseTenantToken(token)
    if (parsed === undefined || !safeHashEqual(this.#adminHash, parsed.hash)) return
    return token
  }

  async setAdminPassword(password: string): Promise<{ token: string } | undefined> {
    const token = tenantToken(ADMIN_USER, password)
    const parsed = parseTenantToken(token)
    if (parsed === undefined) throw new Error('generated admin token is invalid')
    return await this.#serialize(async () => {
      if (this.#adminHash !== undefined) return
      await writePrivateFile(this.adminPath, `${token}\n`)
      this.#adminHash = parsed.hash
      return { token }
    })
  }

  async authenticateOrRegister(
    user: string,
    password: string,
  ): Promise<{ created: boolean; token: string } | undefined> {
    if (user === ADMIN_USER) throw new Error('admin is reserved')
    const token = tenantToken(user, password)
    const parsed = parseTenantToken(token)
    if (parsed === undefined) throw new Error('generated tenant token is invalid')
    return await this.#serialize(async () => {
      const current = this.#credentials.get(user)
      if (current !== undefined) {
        return safeHashEqual(current, parsed.hash)
          ? { created: false, token }
          : undefined
      }
      const next = new Map(this.#credentials)
      next.set(user, parsed.hash)
      await writePrivateFile(
        this.credentialsPath,
        `${[...next].map(([name, hash]) => `${name}:${hash}`).join('\n')}\n`,
      )
      this.#credentials = next
      return { created: true, token }
    })
  }

  ids(user: string): StoredTenantIds {
    const ids = this.#index.get(user)
    return {
      sessionIds: ids === undefined ? [] : [...ids.sessionIds],
      workspaceIds: ids === undefined ? [] : [...ids.workspaceIds],
    }
  }

  ownsSession(user: string, id: string): boolean {
    return this.#index.get(user)?.sessionIds.has(id) === true
  }

  ownsWorkspace(user: string, id: string): boolean {
    return this.#index.get(user)?.workspaceIds.has(id) === true
  }

  claimSession(user: string, id: string): Promise<boolean> {
    return this.#claim(user, id, 'sessionIds')
  }

  claimWorkspace(user: string, id: string): Promise<boolean> {
    return this.#claim(user, id, 'workspaceIds')
  }

  releaseSession(user: string, id: string): Promise<void> {
    return this.#serialize(async () => {
      if (this.#index.get(user)?.sessionIds.has(id) !== true) return
      const next = cloneIndex(this.#index)
      next.get(user)?.sessionIds.delete(id)
      await writePrivateFile(this.indexPath, serializedIndex(next))
      this.#index = next
    })
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }

  #claim(
    user: string,
    id: string,
    kind: keyof TenantIds,
  ): Promise<boolean> {
    return this.#serialize(async () => {
      const owner = [...this.#index].find(([, ids]) => ids[kind].has(id))?.[0]
      if (owner !== undefined) return owner === user
      const next = cloneIndex(this.#index)
      let ids = next.get(user)
      if (ids === undefined) {
        ids = { sessionIds: new Set(), workspaceIds: new Set() }
        next.set(user, ids)
      }
      ids[kind].add(id)
      await writePrivateFile(this.indexPath, serializedIndex(next))
      this.#index = next
      return true
    })
  }

}

function cookieValue(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie
  if (cookie === undefined) return
  for (const entry of cookie.split(';')) {
    const [name, ...value] = entry.trim().split('=')
    if (name === TENANT_COOKIE) return value.join('=')
  }
}

function pathname(request: IncomingMessage): string | undefined {
  try {
    return new URL(request.url ?? '/', 'http://oh-dsh.internal').pathname
  } catch {
    return
  }
}

function chineseRequest(request: IncomingMessage): boolean {
  const language = request.headers['accept-language']
  return typeof language === 'string'
    && language.toLowerCase().split(',').some(value => value.trim().startsWith('zh'))
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function scopedUser(session: TenantSession | undefined): string | undefined {
  return session?.kind === 'tenant' ? session.user : undefined
}

function renderLoginPage(options: {
  chinese?: boolean
  error?: LoginError
  setup?: boolean
  user?: string
} = {}): string {
  const chinese = options.chinese === true
  const setup = options.setup === true
  const copy = setup
    ? chinese ? {
      badge: '管理员',
      button: '保存并进入',
      first: '口令只写一次，保存在数据目录的 web-tenant-admin。之后每次访问都要登录，包括本机。',
      heading: '先设置管理员口令，\n再打开这个 Web。',
      password: '口令',
      passwordHint: '1–1024 个字符',
      scope: '保存之后，访问这个 Web 的人都要登录。',
      title: '设置 Oh-DSH Web 管理员',
      user: '用户名',
      userHint: '字母、数字、点、下划线或短横线',
      errors: {
        credentials: '管理员口令已经存在，请登录。',
        password: '请输入 1–1024 个字符的口令。',
        username: '用户名需为 1–32 个允许字符。',
        workspace: '暂时无法准备该账号的工作区，请重试。',
      },
    } : {
      badge: 'Administrator',
      button: 'Save and continue',
      first: 'Written once to web-tenant-admin under the data root. Every later visit must sign in, including on this machine.',
      heading: 'Set an administrator\npassphrase first.',
      password: 'Passphrase',
      passwordHint: '1–1024 characters',
      scope: 'After this is saved, everyone who opens this Web must sign in.',
      title: 'Set the Oh-DSH Web administrator',
      user: 'Username',
      userHint: 'Letters, numbers, dot, underscore, or hyphen',
      errors: {
        credentials: 'The administrator passphrase is already set. Sign in.',
        password: 'Enter a passphrase containing 1–1024 characters.',
        username: 'Use 1–32 allowed characters for the username.',
        workspace: 'The account workspace could not be prepared. Try again.',
      },
    }
    : chinese ? {
      badge: '会话隔间',
      button: '进入 Oh-DSH',
      first: '普通账号首次使用会登记用户名。管理员用户名为 admin。',
      heading: '你的工作区，\n只在这个账号里出现。',
      password: '口令',
      passwordHint: '1–1024 个字符',
      scope: '渠道、插件和 Marketplace 仍由此 Web 进程共享。',
      title: 'Oh-DSH Web 登录',
      user: '用户名',
      userHint: '字母、数字、点、下划线或短横线',
      errors: {
        credentials: '用户名已存在，口令不正确。',
        password: '请输入 1–1024 个字符的口令。',
        username: '用户名需为 1–32 个允许字符。',
        workspace: '暂时无法准备该账号的工作区，请重试。',
      },
    } : {
      badge: 'Session compartment',
      button: 'Enter Oh-DSH',
      first: 'First use of a regular name reserves it. The administrator username is admin.',
      heading: 'Your workspace,\ninside one account.',
      password: 'Passphrase',
      passwordHint: '1–1024 characters',
      scope: 'Providers, plugins, and Marketplace remain shared by this Web process.',
      title: 'Sign in to Oh-DSH Web',
      user: 'Username',
      userHint: 'Letters, numbers, dot, underscore, or hyphen',
      errors: {
        credentials: 'That username exists and the passphrase does not match.',
        password: 'Enter a passphrase containing 1–1024 characters.',
        username: 'Use 1–32 allowed characters for the username.',
        workspace: 'The account workspace could not be prepared. Try again.',
      },
    }
  const error = options.error === undefined ? '' : `
        <p class="error" role="alert">${copy.errors[options.error]}</p>`
  const user = escapeHtml(options.user ?? '')
  const usernameField = setup ? '' : `
        <label>${copy.user}
          <input name="user" value="${user}" autocomplete="username" inputmode="text" pattern="[A-Za-z0-9._-]{1,32}" maxlength="32" required autofocus>
          <small>${copy.userHint}</small>
        </label>`
  const passwordFocus = setup ? ' autofocus' : ''
  const passwordAutocomplete = setup ? 'new-password' : 'current-password'
  const action = setup ? `${TENANT_BASE}/setup` : `${TENANT_BASE}/login`
  return `<!doctype html>
<html lang="${chinese ? 'zh-CN' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${copy.title}</title>
  <style>
    :root { color-scheme: light; --ink: #171815; --paper: #f3efe4; --signal: #e25d2f; }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      overflow: hidden;
      background:
        linear-gradient(90deg, rgb(23 24 21 / 7%) 1px, transparent 1px) 0 0 / 42px 42px,
        linear-gradient(rgb(23 24 21 / 7%) 1px, transparent 1px) 0 0 / 42px 42px,
        var(--paper);
      color: var(--ink);
      font-family: "Avenir Next", "Segoe UI", sans-serif;
    }
    body::before {
      content: "";
      position: fixed;
      inset: -30vh -20vw auto auto;
      width: 70vw;
      aspect-ratio: 1;
      border-radius: 50%;
      background: var(--signal);
      opacity: 0.88;
      transform: rotate(-12deg);
    }
    main {
      position: relative;
      width: min(920px, calc(100vw - 32px));
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(310px, 0.85fr);
      border: 1px solid var(--ink);
      background: rgb(243 239 228 / 92%);
      box-shadow: 18px 18px 0 var(--ink);
      animation: arrive 420ms cubic-bezier(.2,.8,.2,1) both;
    }
    .story { min-height: 510px; padding: 42px; display: flex; flex-direction: column; }
    .mark { display: flex; align-items: center; gap: 12px; font: 700 12px/1 ui-monospace, monospace; text-transform: uppercase; letter-spacing: .11em; }
    .mark::before { content: "OH"; display: grid; place-items: center; width: 42px; height: 42px; background: var(--ink); color: var(--paper); }
    h1 { max-width: 580px; margin: auto 0 24px; white-space: pre-line; font: 500 clamp(40px, 6vw, 72px)/.94 Georgia, serif; letter-spacing: -.055em; }
    .scope { max-width: 520px; margin: 0; font-size: 14px; line-height: 1.55; }
    .form-panel { padding: 42px 38px; border-left: 1px solid var(--ink); background: #fffdf7; display: flex; flex-direction: column; justify-content: center; }
    .badge { align-self: flex-start; margin: 0 0 30px; padding: 6px 9px; border: 1px solid var(--signal); color: #a63716; font: 700 11px/1 ui-monospace, monospace; text-transform: uppercase; letter-spacing: .08em; }
    form { display: grid; gap: 20px; }
    label { display: grid; gap: 8px; font-size: 13px; font-weight: 700; }
    small { color: #68665e; font-weight: 500; }
    input { width: 100%; padding: 13px 2px 10px; border: 0; border-bottom: 2px solid #aaa69a; border-radius: 0; outline: 0; background: transparent; color: var(--ink); font: 500 18px/1.3 ui-monospace, monospace; }
    input:focus { border-color: var(--signal); }
    button { min-height: 48px; margin-top: 8px; border: 1px solid var(--ink); background: var(--ink); color: #fffdf7; cursor: pointer; font: 700 14px/1 "Avenir Next", sans-serif; transition: transform 120ms ease, background 120ms ease; }
    button:hover { background: var(--signal); transform: translate(-3px, -3px); box-shadow: 3px 3px 0 var(--ink); }
    button:focus-visible { outline: 3px solid var(--signal); outline-offset: 3px; }
    .first { margin: 22px 0 0; color: #68665e; font-size: 12px; line-height: 1.55; }
    .error { margin: 0 0 20px; padding: 10px 12px; border-left: 4px solid var(--signal); background: #fff0e8; color: #81270f; font-size: 13px; line-height: 1.45; }
    @keyframes arrive { from { opacity: 0; transform: translateY(18px); } }
    @media (max-width: 720px) {
      body { overflow: auto; padding: 18px 0 34px; }
      main { grid-template-columns: 1fr; box-shadow: 9px 9px 0 var(--ink); }
      .story { min-height: 290px; padding: 28px; }
      h1 { margin-top: 80px; }
      .form-panel { padding: 32px 28px; border-top: 1px solid var(--ink); border-left: 0; }
    }
    @media (prefers-reduced-motion: reduce) { main { animation: none; } button { transition: none; } }
  </style>
</head>
<body>
  <main>
    <section class="story">
      <div class="mark">Oh-DSH Web</div>
      <h1>${copy.heading}</h1>
      <p class="scope">${copy.scope}</p>
    </section>
    <section class="form-panel">
      <p class="badge">${copy.badge}</p>${error}
      <form method="post" action="${action}">${usernameField}
        <label>${copy.password}
          <input name="password" type="password" autocomplete="${passwordAutocomplete}" minlength="1" maxlength="1024" required${passwordFocus}>
          <small>${copy.passwordHint}</small>
        </label>
        <button type="submit">${copy.button}</button>
      </form>
      <p class="first">${copy.first}</p>
    </section>
  </main>
</body>
</html>`
}

function sendHtml(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readLogin(request: IncomingMessage): Promise<{
  password: string
  user: string
}> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    !== 'application/x-www-form-urlencoded') {
    throw new Error('login content type is invalid')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 16 * 1024) throw new Error('login request is too large')
    chunks.push(buffer)
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
  return {
    password: form.get('password') ?? '',
    user: (form.get('user') ?? '').trim(),
  }
}

function setLoginCookie(response: ServerResponse, token: string): void {
  response.setHeader(
    'set-cookie',
    `${TENANT_COOKIE}=${token}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Strict`,
  )
}

function clearLoginCookie(response: ServerResponse): void {
  response.setHeader(
    'set-cookie',
    `${TENANT_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`,
  )
}

function okValue(response: TenantRpcResponse): Record<string, unknown> | undefined {
  if (!response.result.ok || !isRecord(response.result.value)) return
  return response.result.value
}

function withValue(response: TenantRpcResponse, value: unknown): TenantRpcResponse {
  if (!response.result.ok) return response
  return { ...response, result: { ok: true, value } }
}

function sessionNotFound(request: TenantRpcRequest, id: string): TenantRpcResponse {
  return {
    rpcId: request.rpcId,
    result: {
      ok: false,
      error: {
        code: 'session-not-found',
        message: 'session not found',
        details: { sessionId: id },
      },
    },
  }
}

function workspaceNotFound(request: TenantRpcRequest, id: string): TenantRpcResponse {
  return {
    rpcId: request.rpcId,
    result: {
      ok: false,
      error: {
        code: 'workspace-not-found',
        message: 'workspace not found',
        details: { workspaceId: id },
      },
    },
  }
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined
}

function projectWorkspace(
  value: unknown,
  store: WebTenantStore,
  user: string,
): unknown {
  if (!isRecord(value)) return value
  return {
    ...value,
    sessionIds: Array.isArray(value.sessionIds)
      ? value.sessionIds.filter(id => typeof id === 'string' && store.ownsSession(user, id))
      : [],
  }
}

function replaceUnary(
  domain: ApiDomain | undefined,
  method: string,
  wrap: (original: Unary) => Unary,
  restorers: Array<() => void>,
): void {
  if (domain === undefined) return
  const implementation = domain[method]
  if (typeof implementation !== 'function') return
  const original: Unary = (request, signal) => Reflect.apply(
    implementation,
    domain,
    [request, signal],
  ) as Promise<TenantRpcResponse>
  domain[method] = wrap(original)
  restorers.push(() => {
    domain[method] = implementation
  })
}

/** Wrap the existing ApiProxy object; no route or second gateway is provided. */
export function wrapTenantApi(
  api: TenantApiProxy,
  store: WebTenantStore,
  context: AsyncLocalStorage<string | undefined>,
  defaultWorkspace: (user: string) => Promise<string>,
): () => void {
  const restorers: Array<() => void> = []
  const user = (): string | undefined => context.getStore()

  replaceUnary(api.sessions, 'list', original => async (request, signal) => {
    const current = user()
    const response = await original(request, signal)
    const value = okValue(response)
    if (current === undefined || value === undefined || !Array.isArray(value.items)) return response
    return withValue(response, {
      ...value,
      items: value.items.filter(item => isRecord(item)
        && typeof item.sessionId === 'string'
        && store.ownsSession(current, item.sessionId)),
    })
  }, restorers)

  replaceUnary(api.sessions, 'create', original => async (request, signal) => {
    const current = user()
    if (current === undefined) return await original(request, signal)
    const payload = request.payload
    const workspaceId = stringField(payload, 'workspaceId')
    if (workspaceId !== undefined && !store.ownsWorkspace(current, workspaceId)) {
      return workspaceNotFound(request, workspaceId)
    }
    const suppliedId = stringField(payload, 'sessionId')
    if (suppliedId !== undefined && !store.ownsSession(current, suppliedId)) {
      return sessionNotFound(request, suppliedId)
    }
    const sessionId = suppliedId ?? randomUUID()
    const nextPayload: Record<string, unknown> = { ...payload, sessionId }
    if (workspaceId === undefined && stringField(payload, 'cwd') === undefined) {
      nextPayload.workspaceId = await defaultWorkspace(current)
    }
    const claimed = suppliedId === undefined
      ? await store.claimSession(current, sessionId)
      : true
    if (!claimed) return sessionNotFound(request, sessionId)
    try {
      const response = await original({ ...request, payload: nextPayload }, signal)
      if (!response.result.ok && suppliedId === undefined) {
        await store.releaseSession(current, sessionId)
      }
      return response
    } catch (error) {
      if (suppliedId === undefined) await store.releaseSession(current, sessionId)
      throw error
    }
  }, restorers)

  for (const method of [
    'attachment',
    'cancel',
    'history',
    'models',
    'prompt',
    'rename',
    'selectModel',
    'updateQueue',
  ]) {
    replaceUnary(api.sessions, method, original => async (request, signal) => {
      const current = user()
      const sessionId = stringField(request.payload, 'sessionId')
      if (current !== undefined && sessionId !== undefined
        && !store.ownsSession(current, sessionId)) {
        return sessionNotFound(request, sessionId)
      }
      return await original(request, signal)
    }, restorers)
  }

  replaceUnary(api.workspace, 'list', original => async (request, signal) => {
    const current = user()
    const response = await original(request, signal)
    const value = okValue(response)
    if (current === undefined || value === undefined || !Array.isArray(value.items)) return response
    return withValue(response, {
      ...value,
      archivedSessionIds: Array.isArray(value.archivedSessionIds)
        ? value.archivedSessionIds.filter(id => typeof id === 'string'
          && store.ownsSession(current, id))
        : [],
      items: value.items
        .filter(item => isRecord(item)
          && typeof item.workspaceId === 'string'
          && store.ownsWorkspace(current, item.workspaceId))
        .map(item => projectWorkspace(item, store, current)),
    })
  }, restorers)

  replaceUnary(api.workspace, 'create', original => async (request, signal) => {
    const current = user()
    const response = await original(request, signal)
    const value = okValue(response)
    if (current === undefined || value === undefined || !isRecord(value.workspace)) {
      return response
    }
    const workspaceId = stringField(value.workspace, 'workspaceId')
    if (workspaceId === undefined || !await store.claimWorkspace(current, workspaceId)) {
      return workspaceNotFound(request, workspaceId ?? 'unknown')
    }
    return withValue(response, {
      ...value,
      workspace: projectWorkspace(value.workspace, store, current),
    })
  }, restorers)

  return () => {
    for (const restore of restorers.reverse()) restore()
  }
}

async function ensureDefaultWorkspace(
  user: string,
  dataRoot: string,
  store: WebTenantStore,
  createWorkspace: Unary,
): Promise<string> {
  const current = store.ids(user).workspaceIds[0]
  if (current !== undefined) return current
  const path = join(dataRoot, 'tenants', user, 'workspace')
  await mkdir(path, { recursive: true, mode: 0o700 })
  const response = await createWorkspace({
    rpcId: randomUUID(),
    payload: { path },
  })
  const value = okValue(response)
  if (value === undefined || !isRecord(value.workspace)) {
    const message = response.result.ok ? 'invalid workspace response' : response.result.error.message
    throw new Error(message)
  }
  const workspaceId = stringField(value.workspace, 'workspaceId')
  if (workspaceId === undefined || !await store.claimWorkspace(user, workspaceId)) {
    throw new Error('default workspace is owned by another tenant')
  }
  return workspaceId
}

function mountTenantRoutes(
  ctx: HostContext,
  store: WebTenantStore,
  ensureWorkspace: (user: string) => Promise<string>,
): () => void {
  const loginPage = (
    chinese: boolean,
    error?: LoginError,
    user?: string,
  ): string => renderLoginPage({
    chinese,
    ...(error === undefined ? {} : { error }),
    ...(user === undefined ? {} : { user }),
  })

  const setupPage = (chinese: boolean, error?: LoginError): string =>
    renderLoginPage({
      chinese,
      setup: true,
      ...(error === undefined ? {} : { error }),
    })

  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: `${TENANT_BASE}/setup`,
      handler: async (request, response) => {
        const chinese = chineseRequest(request)
        if (store.hasAdmin()) {
          response.writeHead(303, { location: `${TENANT_BASE}/login` })
          response.end()
          return
        }
        if (request.method === 'GET') {
          sendHtml(response, 200, setupPage(chinese))
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'GET, POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendHtml(response, 403, setupPage(chinese, 'credentials'))
          return
        }
        let login
        try {
          login = await readLogin(request)
        } catch {
          sendHtml(response, 400, setupPage(chinese, 'password'))
          return
        }
        if (login.password.length < 1 || login.password.length > 1024) {
          sendHtml(response, 400, setupPage(chinese, 'password'))
          return
        }
        let created
        try {
          created = await store.setAdminPassword(login.password)
        } catch {
          sendHtml(response, 400, setupPage(chinese, 'password'))
          return
        }
        if (created === undefined) {
          response.writeHead(303, { location: `${TENANT_BASE}/login` })
          response.end()
          return
        }
        setLoginCookie(response, created.token)
        response.writeHead(303, { location: '/' })
        response.end()
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${TENANT_BASE}/login`,
      handler: async (request, response) => {
        const chinese = chineseRequest(request)
        if (!store.hasAdmin()) {
          response.writeHead(303, { location: `${TENANT_BASE}/setup` })
          response.end()
          return
        }
        if (request.method === 'GET') {
          sendHtml(response, 200, loginPage(chinese))
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'GET, POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendHtml(response, 403, loginPage(chinese, 'credentials'))
          return
        }
        let login
        try {
          login = await readLogin(request)
        } catch {
          sendHtml(response, 400, loginPage(chinese, 'password'))
          return
        }
        if (!validTenantUsername(login.user)) {
          sendHtml(response, 400, loginPage(chinese, 'username', login.user))
          return
        }
        if (login.password.length < 1 || login.password.length > 1024) {
          sendHtml(response, 400, loginPage(chinese, 'password', login.user))
          return
        }
        if (login.user === ADMIN_USER) {
          const token = store.authenticateAdminPassword(login.password)
          if (token === undefined) {
            sendHtml(response, 401, loginPage(chinese, 'credentials', login.user))
            return
          }
          setLoginCookie(response, token)
          response.writeHead(303, { location: '/' })
          response.end()
          return
        }
        const authenticated = await store.authenticateOrRegister(login.user, login.password)
        if (authenticated === undefined) {
          sendHtml(response, 401, loginPage(chinese, 'credentials', login.user))
          return
        }
        try {
          await ensureWorkspace(login.user)
        } catch (error) {
          ctx.logger.warn(`web-tenant: default workspace failed: ${String(error)}`)
          sendHtml(response, 500, loginPage(chinese, 'workspace', login.user))
          return
        }
        setLoginCookie(response, authenticated.token)
        response.writeHead(303, { location: '/' })
        response.end()
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${TENANT_BASE}/logout`,
      handler: (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted logout origin' })
          return
        }
        clearLoginCookie(response)
        response.writeHead(303, { location: `${TENANT_BASE}/login` })
        response.end()
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${TENANT_BASE}/me`,
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        const session = store.authenticateCookie(cookieValue(request))
        if (session === undefined) {
          sendJson(response, 401, { error: 'authentication required' })
          return
        }
        if (session.kind === 'admin') {
          sendJson(response, 200, { admin: true, user: ADMIN_USER })
          return
        }
        try {
          await ensureWorkspace(session.user)
        } catch (error) {
          ctx.logger.warn(`web-tenant: default workspace failed: ${String(error)}`)
          sendJson(response, 500, { error: 'workspace unavailable' })
          return
        }
        sendJson(response, 200, { admin: false, user: session.user })
      },
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

type RequestListener = (
  request: IncomingMessage,
  response: ServerResponse,
) => void

type UpgradeListener = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void

function sendUpgradeUnauthorized(socket: Duplex): void {
  socket.end([
    'HTTP/1.1 401 Unauthorized',
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Length: 15',
    '',
    'login required',
  ].join('\r\n'))
}

/** Replace the server listeners with one gate that can truly short-circuit them. */
export function installTenantGate(
  server: Server,
  store: WebTenantStore,
  context: AsyncLocalStorage<string | undefined>,
): () => void {
  const requests = server.listeners('request') as RequestListener[]
  const upgrades = server.listeners('upgrade') as UpgradeListener[]
  server.removeAllListeners('request')
  server.removeAllListeners('upgrade')

  const passRequest = (
    request: IncomingMessage,
    response: ServerResponse,
    current: string | undefined,
  ): void => {
    context.run(current, () => {
      for (const listener of requests) listener.call(server, request, response)
    })
  }
  const requestGate: RequestListener = (request, response) => {
    const path = pathname(request)
    if (path === undefined) {
      response.writeHead(400)
      response.end()
      return
    }
    if (TENANT_PATHS.has(path)) {
      passRequest(request, response, undefined)
      return
    }
    const session = store.authenticateCookie(cookieValue(request))
    if (session !== undefined) {
      passRequest(request, response, scopedUser(session))
      return
    }
    const accept = request.headers.accept ?? ''
    if ((request.method === 'GET' || request.method === 'HEAD')
      && accept.includes('text/html') && !path.startsWith('/api')) {
      const page = renderLoginPage({
        chinese: chineseRequest(request),
        setup: !store.hasAdmin(),
      })
      if (request.method === 'HEAD') {
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(page),
          'content-type': 'text/html; charset=utf-8',
        })
        response.end()
      } else {
        sendHtml(response, 200, page)
      }
      return
    }
    response.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    response.end('login required')
  }

  const upgradeGate: UpgradeListener = (request, socket, head) => {
    const session = store.authenticateCookie(cookieValue(request))
    if (session === undefined) {
      sendUpgradeUnauthorized(socket)
      return
    }
    context.run(scopedUser(session), () => {
      for (const listener of upgrades) listener.call(server, request, socket, head)
    })
  }

  server.on('request', requestGate)
  server.on('upgrade', upgradeGate)
  return () => {
    server.off('request', requestGate)
    server.off('upgrade', upgradeGate)
    for (const listener of requests) server.on('request', listener)
    for (const listener of upgrades) server.on('upgrade', listener)
  }
}

async function waitForServer(webServer: WebServerLike): Promise<Server> {
  const deadline = Date.now() + 5_000
  while (webServer.server === undefined && Date.now() < deadline) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  if (webServer.server === undefined) {
    throw new Error('web-tenant: webServer did not expose its Node server')
  }
  return webServer.server
}

export const name = 'oh-dsh-web-tenant'
export const inject = ['apiProxy', 'webServer']

export async function apply(ctx: HostContext): Promise<void> {
  const dataRoot = process.env.DSH_OH_WEB_DATA
    ?? process.env.OH_DSH_HOME
    ?? process.env.DSH_HOME
    ?? ''
  if (dataRoot === '') {
    ctx.logger.warn('web-tenant: no Oh-DSH data root; tenant gate disabled')
    return
  }
  const create = ctx.apiProxy.workspace?.create
  if (typeof create !== 'function') {
    throw new Error('web-tenant: apiProxy.workspace.create is unavailable')
  }
  const createWorkspace: Unary = (request, signal) => Reflect.apply(
    create,
    ctx.apiProxy.workspace,
    [request, signal],
  ) as Promise<TenantRpcResponse>
  const store = new WebTenantStore(dataRoot)
  const tenantContext = new AsyncLocalStorage<string | undefined>()
  const ensureWorkspace = (user: string): Promise<string> => ensureDefaultWorkspace(
    user,
    dataRoot,
    store,
    createWorkspace,
  )

  ctx.effect(
    () => wrapTenantApi(ctx.apiProxy, store, tenantContext, ensureWorkspace),
    'oh-dsh-web-tenant: apiProxy ownership filter',
  )
  ctx.effect(
    () => mountTenantRoutes(ctx, store, ensureWorkspace),
    'oh-dsh-web-tenant: login and setup routes',
  )
  const server = await waitForServer(ctx.webServer)
  ctx.effect(
    () => installTenantGate(server, store, tenantContext),
    'oh-dsh-web-tenant: HTTP and WebSocket gate',
  )
}
