import { Bell, LogOut, MonitorSmartphone } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ApiError, apiRequest } from '../lib/api'
type NotificationPreference = {
  key: 'social' | 'messages' | 'security' | 'live' | 'calls' | 'mentions'
  enabled: boolean
  channel: 'in_app' | 'email' | 'push'
}

const notificationLabels: Record<NotificationPreference['key'], string> = {
  social: 'Social activity',
  messages: 'Messages',
  security: 'Security alerts',
  live: 'Live sessions',
  calls: 'Calls',
  mentions: 'Mentions',
}

type Session = {
  id: string
  userAgent: string | null
  deviceName: string | null
  ipAddress: string | null
  createdAt: string
  lastSeenAt: string | null
  expiresAt: string
}

export function SettingsPage() {
  const navigate = useNavigate()
  const { logout } = useAuth()
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [sessionError, setSessionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreference[]>([])
  const [preferencesLoading, setPreferencesLoading] = useState(true)
  const [preferencesBusy, setPreferencesBusy] = useState('')
  const [preferencesError, setPreferencesError] = useState('')

  useEffect(() => {
    let mounted = true
    apiRequest<{ sessions: Session[] }>('/api/auth/sessions')
      .then((response) => { if (mounted) setSessions(response.sessions) })
      .catch(() => { if (mounted) setSessionError('Active sessions could not be loaded.') })
      .finally(() => { if (mounted) setSessionsLoading(false) })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    let mounted = true
    apiRequest<{ preferences: NotificationPreference[] }>('/api/notifications/preferences')
      .then((response) => { if (mounted) setNotificationPreferences(response.preferences) })
      .catch((error) => { if (mounted) setPreferencesError(error instanceof Error ? error.message : 'Notification preferences could not be loaded.') })
      .finally(() => { if (mounted) setPreferencesLoading(false) })
    return () => { mounted = false }
  }, [])

  const updateNotificationPreference = async (preference: NotificationPreference) => {
    setPreferencesBusy(preference.key)
    setPreferencesError('')
    try {
      const response = await apiRequest<{ preferences: NotificationPreference[] }>('/api/notifications/preferences', {
        method: 'PUT',
        body: JSON.stringify({ key: preference.key, enabled: !preference.enabled }),
      })
      setNotificationPreferences(response.preferences)
    } catch (error) {
      setPreferencesError(error instanceof ApiError ? error.message : 'Notification preference could not be updated.')
    } finally {
      setPreferencesBusy('')
    }
  }

  const revokeSession = async (id: string) => {
    setBusy(true)
    setSessionError('')
    try {
      await apiRequest(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
      setSessions((current) => current.filter((session) => session.id !== id))
    } catch (error) {
      setSessionError(error instanceof ApiError ? error.message : 'This session could not be revoked.')
    } finally {
      setBusy(false)
    }
  }

  const revokeAllSessions = async () => {
    setBusy(true)
    setSessionError('')
    try {
      await apiRequest('/api/auth/logout-all', { method: 'POST' })
      await logout()
      navigate('/login', { replace: true })
    } catch (error) {
      setSessionError(error instanceof ApiError ? error.message : 'Sessions could not be ended.')
      setBusy(false)
    }
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mx-auto max-w-5xl rounded-[32px] border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-indigo-600">Preferences</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Settings</h2>
        </div>

        <section className="mt-6 border-t border-slate-200 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h3 className="font-semibold text-slate-900">Profile details</h3><p className="text-sm text-slate-500">Add or update your profile picture and private details.</p></div>
            <button type="button" onClick={() => navigate('/complete-profile')} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Complete your profile</button>
          </div>
        </section>

        <section className="mt-6 border-t border-slate-200 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <MonitorSmartphone className="h-5 w-5 text-indigo-700" aria-hidden="true" />
              <div>
                <h3 className="font-semibold text-slate-900">Active sessions</h3>
                <p className="text-sm text-slate-500">Devices currently signed in to your account.</p>
              </div>
            </div>
            <button type="button" onClick={() => void revokeAllSessions()} disabled={busy || sessionsLoading || sessions.length === 0} className="inline-flex items-center gap-2 rounded-lg border border-rose-200 px-3 py-2 text-sm font-semibold text-rose-700 disabled:opacity-50">
              <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out all devices
            </button>
          </div>
          {sessionError ? <p className="mt-3 text-sm text-rose-700" role="alert">{sessionError}</p> : null}
          {sessionsLoading ? <p className="mt-4 text-sm text-slate-500" role="status">Loading active sessions…</p> : null}
          <ul className="mt-4 divide-y divide-slate-200">
            {sessions.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800">{session.deviceName || session.userAgent || 'Unknown device'}</p>
                  <p className="mt-1 text-xs text-slate-500">{session.ipAddress || 'Location unavailable'} · Signed in {new Date(session.createdAt).toLocaleString()}</p>
                </div>
                <button type="button" onClick={() => void revokeSession(session.id)} disabled={busy} className="rounded-lg px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50">Revoke</button>
              </li>
            ))}
            {!sessionsLoading && !sessionError && sessions.length === 0 ? <li className="py-4 text-sm text-slate-500">No active sessions found.</li> : null}
          </ul>
        </section>

        <section className="mt-6 border-t border-slate-200 pt-5">
          <div className="flex items-center gap-3">
            <Bell className="h-5 w-5 text-indigo-700" aria-hidden="true" />
            <div>
              <h3 className="font-semibold text-slate-900">In-app notifications</h3>
              <p className="text-sm text-slate-500">Choose which activity can notify you.</p>
            </div>
          </div>
          {preferencesError ? <p role="alert" className="mt-3 text-sm text-rose-700">{preferencesError}</p> : null}
          {preferencesLoading ? <p className="mt-4 text-sm text-slate-500">Loading notification preferences…</p> : null}
          {!preferencesLoading && !preferencesError ? (
            <ul className="mt-3 divide-y divide-slate-200">
              {notificationPreferences.map((preference) => (
                <li key={preference.key} className="flex items-center justify-between gap-4 py-3">
                  <span className="text-sm font-medium text-slate-800">{notificationLabels[preference.key]}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={preference.enabled}
                    aria-label={notificationLabels[preference.key]}
                    disabled={Boolean(preferencesBusy)}
                    onClick={() => void updateNotificationPreference(preference)}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${preference.enabled ? 'bg-indigo-600' : 'bg-slate-300'}`}
                  >
                    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${preference.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </div>
  )
}
