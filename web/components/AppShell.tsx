'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { apiFetch, clearToken, getUser } from '@/lib/api'

const NAV = [
  { href: '/', label: 'Dashboard', id: 'nav-dashboard' },
  { href: '/queues', label: 'Queues', id: 'nav-queues' },
  { href: '/jobs', label: 'Jobs', id: 'nav-jobs' },
  { href: '/workers', label: 'Workers', id: 'nav-workers' },
]

export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [user, setUser] = useState<{ email?: string } | null>(null)
  const [authed, setAuthed] = useState<boolean | null>(null)

  useEffect(() => {
    const u = getUser()
    if (!u) {
      setAuthed(false)
      router.replace('/login')
    } else {
      setUser(u)
      setAuthed(true)
    }
  }, [router])

  async function handleLogout() {
    try {
      await apiFetch('/auth/logout', { method: 'POST' })
    } catch { /* ignore */ }
    clearToken()
    router.push('/login')
  }

  if (authed === null) return null // hydrating
  if (authed === false) return null // redirecting

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-4 border-b bg-muted/40 px-6">
        <div className="flex items-center gap-2 font-semibold text-primary">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Chronos
        </div>

        <nav className="flex items-center gap-1 ml-6" role="navigation" aria-label="Main navigation">
          {NAV.map(({ href, label, id }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
            return (
              <Link
                key={href}
                id={id}
                href={href}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  active
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                {label}
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {user?.email && (
            <span className="text-xs text-muted-foreground hidden sm:inline">{user.email}</span>
          )}
          <button
            id="logout-button"
            onClick={handleLogout}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            Logout
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        {children}
      </main>
    </div>
  )
}
