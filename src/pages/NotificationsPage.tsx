import { BellRing, Check, MessageSquareText, Radio, Rocket, ShieldAlert, UserPlus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { useEffect, useState } from 'react'
import { apiRequest } from '../lib/api'

type ApiNotification = { id: string; type: string; message: string; link?: string | null; readAt?: string | null; createdAt: string }

const typeMap = {
  like: { label: 'Like', icon: Rocket },
  comment: { label: 'Comment', icon: MessageSquareText },
  follow: { label: 'Follow', icon: UserPlus },
  mention: { label: 'Mention', icon: BellRing },
  live_started: { label: 'Live', icon: Radio },
  system: { label: 'System', icon: ShieldAlert },
}

export function NotificationsPage() {
  const [notifications, setNotifications] = useState<ApiNotification[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void apiRequest<{ notifications: ApiNotification[] }>('/api/notifications')
      .then((response) => setNotifications(response.notifications))
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Unable to load notifications.'))
      .finally(() => setLoading(false))
  }, [])

  const markRead = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      await apiRequest(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' })
      setNotifications((current) => current.map((item) => item.id === id ? { ...item, readAt: new Date().toISOString() } : item))
    } catch (markError) {
      setError(markError instanceof Error ? markError.message : 'Unable to mark notification as read.')
    } finally {
      setBusy(false)
    }
  }

  const markAllRead = async () => {
    setBusy(true)
    setError('')
    try {
      await apiRequest('/api/notifications/read-all', { method: 'POST' })
      const readAt = new Date().toISOString()
      setNotifications((current) => current.map((item) => item.readAt ? item : { ...item, readAt }))
    } catch (markError) {
      setError(markError instanceof Error ? markError.message : 'Unable to mark notifications as read.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mx-auto max-w-4xl rounded-[32px] border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-violet-600">Activity</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-900">Notifications</h2>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-700">{notifications.filter((item) => !item.readAt).length} unread</span>
            <Button variant="secondary" size="sm" disabled={busy || notifications.every((item) => item.readAt)} onClick={() => void markAllRead()} icon={<Check className="h-4 w-4" aria-hidden="true" />}>Read all</Button>
          </div>
        </div>

        <div className="mt-6 space-y-3">
            {error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div> : null}
            {loading ? <p className="p-4 text-sm text-slate-500">Loading notifications…</p> : null}
            {!loading && notifications.length === 0 && !error ? <p className="p-6 text-center text-sm text-slate-500">No notifications yet.</p> : null}
            {notifications.map((item) => {
            const config = item.type === 'reaction' ? typeMap.like : typeMap[item.type as keyof typeof typeMap] ?? typeMap.system
            const Icon = config.icon

            return (
              <div
                key={item.id}
                className={`flex items-start gap-3 rounded-[24px] border p-4 ${
                  !item.readAt ? 'border-violet-100 bg-violet-50' : 'border-slate-200 bg-slate-50'
                }`}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-violet-700 shadow-sm">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-700"><span className="font-semibold text-slate-900">NOVAKOKO</span> {item.message}</p>
                  {item.type === 'live_started' && item.link ? <Link to={item.link} className="mt-2 inline-flex min-h-10 items-center rounded-lg px-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-100">Watch live</Link> : null}
                  <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                    <span>{config.label}</span>
                    <span>•</span>
                    <span>{new Date(item.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                {!item.readAt ? <span className="mt-2 h-2.5 w-2.5 rounded-full bg-violet-600" aria-label="Unread notification" /> : null}
                {!item.readAt ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void markRead(item.id)}>Mark read</Button> : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
