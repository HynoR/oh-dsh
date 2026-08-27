const TENANT_BASE = '/oh-dsh/tenant'

interface ClientContext {
  effect(effect: () => (() => void) | void, label?: string): void
}

interface TenantIdentity {
  loopback: boolean
  user: string | null
}

const SWITCH_CSS = `
[data-oh-dsh-tenant-switch] {
  position: fixed;
  z-index: 9100;
  top: 10px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 32px;
  padding: 4px 5px 4px 11px;
  border: 1px solid var(--dsw-alias-border-l1, rgb(128 128 128 / 35%));
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 92%, transparent);
  color: var(--dsw-alias-label-secondary, #5a5a5a);
  box-shadow: 0 8px 26px rgb(0 0 0 / 12%);
  backdrop-filter: blur(14px);
  font: 500 12px/1.2 "Avenir Next", "Segoe UI", sans-serif;
}

[data-oh-dsh-tenant-user] {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-oh-dsh-tenant-switch] button {
  min-height: 24px;
  padding: 4px 9px;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-label-primary, #202020);
  color: var(--dsw-alias-bg-base, #fff);
  cursor: pointer;
  font: inherit;
  font-weight: 650;
}

[data-oh-dsh-tenant-switch] button:hover {
  filter: brightness(1.12);
}

[data-oh-dsh-tenant-switch] button:focus-visible {
  outline: 2px solid var(--dsw-alias-primary, #d9682b);
  outline-offset: 2px;
}

[data-oh-dsh-tenant-switch] button:disabled {
  cursor: wait;
  opacity: 0.55;
}

@media (max-width: 640px) {
  [data-oh-dsh-tenant-switch] {
    top: auto;
    right: 10px;
    bottom: 10px;
  }
}
`

async function identity(): Promise<TenantIdentity | undefined> {
  const response = await fetch(`${TENANT_BASE}/me`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) return
  return await response.json() as TenantIdentity
}

function mountSwitch(user: string): () => void {
  const chinese = navigator.language.toLowerCase().startsWith('zh')
  const root = document.createElement('aside')
  root.dataset.ohDshTenantSwitch = 'true'
  root.setAttribute('aria-label', chinese ? '当前局域网账号' : 'Current LAN account')

  const name = document.createElement('span')
  name.dataset.ohDshTenantUser = 'true'
  name.textContent = `@${user}`
  name.title = user

  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = chinese ? '切换账号' : 'Switch account'
  button.addEventListener('click', () => {
    button.disabled = true
    void fetch(`${TENANT_BASE}/logout`, {
      method: 'POST',
      credentials: 'same-origin',
    }).finally(() => {
      location.assign(`${TENANT_BASE}/login`)
    })
  })

  const style = document.createElement('style')
  style.dataset.ohDshTenantStyle = 'true'
  style.textContent = SWITCH_CSS
  root.append(name, button)
  document.head.append(style)
  document.body.append(root)
  return () => {
    root.remove()
    style.remove()
  }
}

export const inject: string[] = []

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    let disposed = false
    let unmount: (() => void) | undefined
    void identity().then((current) => {
      if (disposed || current === undefined || current.loopback || current.user === null) return
      unmount = mountSwitch(current.user)
    }).catch(() => {})
    return () => {
      disposed = true
      unmount?.()
    }
  }, 'oh-dsh-web-tenant: account switch')
}
