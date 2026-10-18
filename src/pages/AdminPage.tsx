import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Activity, AlertTriangle, ArrowUpRight, BadgeCheck, Check, ChevronRight, CircleDollarSign, FileWarning, Gavel, LoaderCircle, LockKeyhole, Search, ShieldCheck, UserRound, Users, X } from 'lucide-react'
import { apiRequest } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { SearchBar } from '../components/ui/SearchBar'

type RecordValue = Record<string, unknown>
type Section = 'overview' | 'users' | 'reports' | 'moderation' | 'appeals' | 'subscriptions' | 'payments' | 'creators' | 'earnings' | 'payouts' | 'revenue' | 'audit' | 'monetization' | 'creatorApplications' | 'creatorAccounts' | 'ads' | 'placements' | 'adAnalytics'
type ActionState = { endpoint: string; title: string; description: string; field: 'reason' | 'note'; method?: 'POST' | 'PATCH'; body?: RecordValue }
type DashboardResponse = { metrics: Record<string, number>; recentReports?: RecordValue[]; recentModerationActions?: RecordValue[]; recentAdminActivity?: RecordValue[] }

const sections: Array<{ id: Section; label: string; icon: typeof Users; adminOnly?: boolean }> = [
  { id: 'overview', label: 'Overview', icon: Activity }, { id: 'users', label: 'Users', icon: Users, adminOnly: true }, { id: 'reports', label: 'Reports', icon: FileWarning, adminOnly: true }, { id: 'moderation', label: 'Moderation', icon: Gavel }, { id: 'appeals', label: 'Appeals', icon: ShieldCheck, adminOnly: true }, { id: 'subscriptions', label: 'Subscriptions', icon: BadgeCheck, adminOnly: true }, { id: 'payments', label: 'Payments', icon: CircleDollarSign, adminOnly: true }, { id: 'creators', label: 'Creators', icon: UserRound, adminOnly: true }, { id: 'earnings', label: 'Earnings', icon: ArrowUpRight, adminOnly: true }, { id: 'payouts', label: 'Payouts', icon: ArrowUpRight, adminOnly: true }, { id: 'revenue', label: 'Revenue', icon: CircleDollarSign, adminOnly: true }, { id: 'audit', label: 'Audit logs', icon: LockKeyhole, adminOnly: true }, { id: 'monetization', label: 'Monetization settings', icon: CircleDollarSign, adminOnly: true }, { id: 'creatorApplications', label: 'Creator applications', icon: UserRound, adminOnly: true }, { id: 'creatorAccounts', label: 'Creator status', icon: ShieldCheck, adminOnly: true }, { id: 'ads', label: 'Ad campaigns', icon: Activity, adminOnly: true }, { id: 'placements', label: 'Ad placements', icon: Activity, adminOnly: true }, { id: 'adAnalytics', label: 'Ad analytics', icon: ArrowUpRight, adminOnly: true },
]
const metricCards = [{ label: 'Total users', key: 'totalUsers', icon: Users, tone: 'violet' }, { label: 'Active users', key: 'activeUsers', icon: BadgeCheck, tone: 'emerald' }, { label: 'Pending reports', key: 'pendingReports', icon: FileWarning, tone: 'amber' }, { label: 'Subscription revenue', key: 'subscriptionRevenue', icon: CircleDollarSign, tone: 'cyan' }, { label: 'Pending payouts', key: 'pendingPayouts', icon: ArrowUpRight, tone: 'slate' }, { label: 'Platform revenue', key: 'platformRevenue', icon: Activity, tone: 'rose' }] as const
const labels: Record<string, string> = { id: 'ID', name: 'Name', email: 'Email', role: 'Role', status: 'Status', createdAt: 'Created', category: 'Category', details: 'Details', reason: 'Reason', amountCents: 'Amount', currency: 'Currency', provider: 'Provider', actionType: 'Action', originalAction: 'Original action', reviewerNote: 'Reviewer note', adSpendCents: 'Ad spend', adImpressions: 'Impressions', adClicks: 'Clicks', grossRevenue: 'Gross revenue', platformRevenue: 'Platform revenue', creatorNetEarnings: 'Creator earnings', pendingPayouts: 'Pending payouts' }

function display(value: unknown) { if (value === null || value === undefined || value === '') return '—'; if (typeof value === 'object') return JSON.stringify(value); return String(value) }
function formatDate(value: unknown) { if (!value) return '—'; const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? display(value) : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) }
function formatMoney(value: unknown) { return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(Number(value ?? 0) / 100) }
function getRows(payload: RecordValue | null, key: string): RecordValue[] { const value = payload?.[key]; return Array.isArray(value) ? value.filter((item): item is RecordValue => typeof item === 'object' && item !== null) : [] }

export function AdminPage() {
  const { user } = useAuth()
  const isModerator = user?.role === 'MODERATOR'
  const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(user?.role ?? '')
  const availableSections = sections.filter((section) => !section.adminOnly || isAdmin)
  const [section, setSection] = useState<Section>(isModerator ? 'moderation' : 'overview')
  const [payload, setPayload] = useState<RecordValue | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<RecordValue | null>(null)
  const [action, setAction] = useState<ActionState | null>(null)
  const [actionReason, setActionReason] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const endpoint = section === 'overview' ? '/api/admin/dashboard' : section === 'users' ? '/api/admin/users?limit=100' : section === 'reports' ? '/api/admin/reports?limit=100' : section === 'moderation' ? '/api/admin/moderation/queue' : section === 'appeals' ? '/api/admin/appeals' : section === 'monetization' ? '/api/admin/monetization/settings' : section === 'creatorApplications' ? '/api/admin/monetization/applications' : section === 'creatorAccounts' ? '/api/admin/monetization/creators' : section === 'ads' ? '/api/admin/ads/campaigns' : section === 'placements' ? '/api/admin/ads/placements' : section === 'adAnalytics' ? '/api/admin/ads/analytics' : `/api/admin/${section === 'audit' ? 'audit-logs' : section}`

  useEffect(() => { if (!availableSections.some((item) => item.id === section)) setSection(availableSections[0]?.id ?? 'overview') }, [availableSections, section])
  useEffect(() => { let cancelled = false; setIsLoading(true); setError(null); setPayload(null); void apiRequest<RecordValue>(endpoint).then((response) => { if (!cancelled) setPayload(response) }).catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Unable to load this section.') }).finally(() => { if (!cancelled) setIsLoading(false) }); return () => { cancelled = true } }, [endpoint, refreshKey])

  const handleAction = async () => {
    if (!action || !actionReason.trim()) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await apiRequest<RecordValue>(action.endpoint, {
        method: action.method ?? "POST",
        body: JSON.stringify({ ...action.body, [action.field]: actionReason.trim() })
      });
      setSuccess(typeof response.message === 'string' ? response.message : "Action completed successfully.");
      setAction(null);
      setActionReason("");
      setRefreshKey((current) => current + 1)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Action failed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleView = async (row: RecordValue) => {
    if (!row.id || !['users', 'reports', 'appeals'].includes(section)) { setSelected(row); return }
    setError(null)
    try {
      const response = await apiRequest<RecordValue>(`/api/admin/${section}/${row.id}`)
      setSelected((response.user ?? response.report ?? response.appeal ?? row) as RecordValue)
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : 'Unable to load record details.')
    }
  }
  const filteredUsers = useMemo(() => getRows(payload, 'users').filter((item) => `${item.name ?? ''} ${item.email ?? ''} ${item.username ?? ''}`.toLowerCase().includes(search.toLowerCase())), [payload, search])
  const rows = section === 'users' ? filteredUsers : section === 'reports' ? getRows(payload, 'reports') : section === 'moderation' ? getRows(payload, 'items') : section === 'appeals' ? getRows(payload, 'appeals') : section === 'audit' ? getRows(payload, 'logs') : section === 'earnings' ? getRows(payload, 'entries') : section === 'creatorApplications' ? getRows(payload, 'applications') : section === 'creatorAccounts' ? getRows(payload, 'creators') : section === 'ads' ? getRows(payload, 'campaigns') : section === 'placements' ? getRows(payload, 'placements') : section === 'adAnalytics' ? (payload?.analytics ? [payload.analytics as RecordValue] : []) : section === 'revenue' ? getRows(payload, 'metrics').concat(payload?.metrics && typeof payload.metrics === 'object' ? [payload.metrics as RecordValue] : []) : getRows(payload, section)
  if (!user || !['ADMIN', 'SUPER_ADMIN', 'MODERATOR'].includes(user.role ?? '')) return <div className="p-6 text-sm text-slate-600">You do not have access to the admin center.</div>

  return <div className="space-y-5 p-4 pb-24 sm:p-6"><header className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.28em] text-violet-600">Operations</p><h1 className="mt-2 text-2xl font-semibold text-slate-900">Management center</h1><p className="mt-1 text-sm text-slate-500">Keep NOVAKOKO healthy, helpful, and moving.</p></div><div className="inline-flex w-fit items-center gap-2 rounded-full bg-violet-50 px-3 py-2 text-sm font-medium text-violet-700"><ShieldCheck className="h-4 w-4" aria-hidden="true" />{isModerator ? 'Moderator access' : 'Protected admin view'}</div></div><nav className="mt-5 -mx-1 flex gap-1 overflow-x-auto px-1 pb-1" aria-label="Admin sections">{availableSections.map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => { setSection(id); setSearch(''); setSuccess(null) }} className={`flex shrink-0 items-center gap-2 rounded-full px-3 py-2 text-sm font-medium transition ${section === id ? 'bg-violet-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}><Icon className="h-4 w-4" aria-hidden="true" />{label}</button>)}</nav></header>
    {success ? <div className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"><Check className="h-4 w-4" aria-hidden="true" />{success}<button className="ml-auto" onClick={() => setSuccess(null)} aria-label="Dismiss success"><X className="h-4 w-4" /></button></div> : null}{error ? <div className="flex items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"><AlertTriangle className="h-4 w-4" aria-hidden="true" />{error}</div> : null}
    {section === 'overview' && payload ? <Overview data={payload as DashboardResponse} onNavigate={setSection} /> : null}
    {section !== 'overview' ? <section className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-xl font-semibold text-slate-900">{sections.find((item) => item.id === section)?.label}</h2><p className="mt-1 text-sm text-slate-500">{rows.length} record{rows.length === 1 ? '' : 's'} returned by the API.</p></div>{section === 'users' || section === 'reports' ? <SearchBar value={search} onChange={setSearch} placeholder={`Search ${section}...`} /> : null}</div>
      {section === 'monetization' ? <MonetizationSettingsForm onSaved={() => setRefreshKey((current) => current + 1)} /> : null}
      {section === 'ads' ? <AdvertisingSettingsForm onSaved={() => setRefreshKey((current) => current + 1)} /> : null}
      {section === 'placements' ? <AdPlacementForm onSaved={() => setRefreshKey((current) => current + 1)} /> : null}
      {isLoading ? <LoadingState /> : ['monetization', 'placements'].includes(section) ? null : rows.length === 0 ? <EmptyState label={section === 'moderation' ? 'The moderation queue is clear.' : 'No records found in this section.'} /> : section === 'creatorApplications' ? <CreatorApplicationTable rows={rows} onAction={setAction} /> : section === 'creatorAccounts' ? <CreatorAccountTable rows={rows} onAction={setAction} /> : section === 'ads' ? <AdCampaignTable rows={rows} onAction={setAction} /> : section === 'payouts' ? <PayoutReviewTable rows={rows} onAction={setAction} /> : section === 'adAnalytics' ? <AdAnalytics data={(payload?.analytics ?? {}) as RecordValue} /> : <DataTable section={section} rows={rows} onView={handleView} onAction={setAction} />}
    </section> : null}{isLoading && section === 'overview' ? <LoadingState /> : null}
    {selected ? <DetailModal item={selected} onClose={() => setSelected(null)} /> : null}<Modal open={Boolean(action)} title={action?.title ?? 'Confirm action'} onClose={() => { if (!isSubmitting) { setAction(null); setActionReason('') } }}><p className="text-sm text-slate-600">{action?.description}</p><label className="mt-4 block text-sm font-medium text-slate-700">{action?.field === 'note' ? 'Note' : 'Reason'}<textarea value={actionReason} onChange={(event) => setActionReason(event.target.value)} rows={4} className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100" placeholder="Enter a reason for the audit trail..." /></label><div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={() => setAction(null)} disabled={isSubmitting}>Cancel</Button><Button onClick={() => void handleAction()} disabled={isSubmitting || !actionReason.trim()} icon={isSubmitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : undefined}>Confirm</Button></div></Modal></div>
}

function MonetizationSettingsForm({ onSaved }: { onSaved: () => void }) {
  const [settings, setSettings] = useState<RecordValue | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    apiRequest<{ settings: RecordValue }>('/api/admin/monetization/settings')
      .then((response) => setSettings(response.settings))
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Unable to load settings.'))
  }, [])
  const save = async () => {
    if (!settings) return
    setBusy(true); setError(''); setNotice('')
    try {
      const { id: _id, updatedAt: _updatedAt, updatedBy: _updatedBy, ...values } = settings
      const response = await apiRequest<{ settings: RecordValue }>('/api/admin/monetization/settings', { method: 'PATCH', body: JSON.stringify(values) })
      setSettings(response.settings); setNotice('Monetization settings saved.'); onSaved()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save settings.')
    } finally { setBusy(false) }
  }
  const recheck = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await apiRequest<{ suspended: number }>('/api/admin/monetization/recheck', { method: 'POST' })
      setNotice(`Eligibility recheck completed; ${response.suspended} creator account(s) were suspended.`); onSaved()
    } catch (recheckError) {
      setError(recheckError instanceof Error ? recheckError.message : 'Unable to recheck creators.')
    } finally { setBusy(false) }
  }
  if (!settings) return <p className="text-sm text-slate-500">{error || 'Loading settings…'}</p>
  const numericFields = [
    ['minimumFollowers', 'Minimum followers', 0],
    ['minimumQualifiedViews', 'Qualified views (measurement window)', 0],
    ['qualifiedViewWindowDays', 'Qualified-view window (days)', 1],
    ['minimumWatchTimeSeconds', 'Minimum watch time (seconds)', 0],
    ['minimumEngagementRate', 'Minimum engagement rate (%)', 0],
    ['minimumAccountAgeDays', 'Minimum account age (days)', 0],
    ['minimumPublicPosts', 'Minimum public posts', 0],
    ['revenueSharePercent', 'Creator revenue share (%)', 0],
    ['minimumPayoutCents', 'Minimum payout (cents)', 0],
  ] as const
  return <div className="space-y-4">
    <label className="flex items-center gap-3 text-sm font-medium text-slate-800"><input type="checkbox" checked={Boolean(settings.enabled)} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} />Enable creator monetization applications and eligibility checks</label>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{numericFields.map(([key, label, minimum]) => {
      const storedValue = Number(settings[key] ?? 0)
      const value = key === 'minimumEngagementRate' ? storedValue * 100 : storedValue
      return <label key={key} className="text-sm font-medium text-slate-700">{label}<input type="number" min={minimum} max={key === 'revenueSharePercent' || key === 'minimumEngagementRate' ? 100 : undefined} step={key === 'minimumEngagementRate' ? 0.1 : 1} value={value} onChange={(event) => {
        const numericValue = Number(event.target.value)
        setSettings({ ...settings, [key]: key === 'minimumEngagementRate' ? numericValue / 100 : numericValue })
      }} className="mt-1 w-full rounded-xl border border-slate-200 p-2" /></label>
    })}</div>
    <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">Qualified views and watch time are not collected yet. Any non-zero requirement remains unmet until a validated measurement source is added.</p>
    {error ? <p role="alert" className="text-sm text-rose-600">{error}</p> : null}{notice ? <p role="status" className="text-sm text-emerald-700">{notice}</p> : null}
    <div className="flex flex-wrap gap-2"><Button onClick={() => void save()} disabled={busy}>Save settings</Button><Button variant="ghost" onClick={() => void recheck()} disabled={busy}>Recheck creator eligibility</Button></div>
  </div>
}

function AdvertisingSettingsForm({ onSaved }: { onSaved: () => void }) {
  const [enabled, setEnabled] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    apiRequest<{ settings: { enabled: boolean } }>('/api/admin/ads/settings')
      .then((response) => setEnabled(response.settings.enabled))
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Unable to load ad settings.'))
  }, [])
  const save = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      await apiRequest('/api/admin/ads/settings', { method: 'PATCH', body: JSON.stringify({ enabled }) })
      setNotice('Advertising availability saved.'); onSaved()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save ad settings.')
    } finally { setBusy(false) }
  }
  return <div className="mb-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
    <label className="flex items-center gap-3 text-sm font-medium text-slate-800"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />Enable internal advertising (off by default)</label>
    <p className="mt-2 text-xs text-slate-500">Only configured public feed/content placements are served, and users must opt in to ad measurement.</p>
    {error ? <p role="alert" className="mt-2 text-sm text-rose-600">{error}</p> : null}{notice ? <p role="status" className="mt-2 text-sm text-emerald-700">{notice}</p> : null}
    <Button className="mt-3" size="sm" onClick={() => void save()} disabled={busy}>Save availability</Button>
  </div>
}

function AdPlacementForm({ onSaved }: { onSaved: () => void }) {
  const allowed = ['feed', 'content'] as const
  const [placements, setPlacements] = useState<Record<string, { enabled: boolean; dailyBudgetCents: number }>>({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    apiRequest<{ placements: Array<{ key: string; enabled: boolean; dailyBudgetCents: number }> }>('/api/admin/ads/placements')
      .then((response) => setPlacements(Object.fromEntries(allowed.map((key) => {
        const current = response.placements.find((placement) => placement.key === key)
        return [key, { enabled: current?.enabled ?? false, dailyBudgetCents: current?.dailyBudgetCents ?? 0 }]
      }))))
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Unable to load ad placements.'))
  }, [])
  const save = async (key: (typeof allowed)[number]) => {
    setBusy(true); setError(''); setNotice('')
    try {
      await apiRequest(`/api/admin/ads/placements/${key}`, { method: 'PUT', body: JSON.stringify(placements[key]) })
      setNotice(`${key} placement saved.`); onSaved()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save placement.')
    } finally { setBusy(false) }
  }
  if (Object.keys(placements).length === 0) return <p className="text-sm text-slate-500">{error || 'Loading placements…'}</p>
  return <div className="space-y-4">
    <p className="text-sm text-slate-600">Supported locations are limited to public feed and content areas; private messages, groups, and calls are not ad placements.</p>
    <div className="grid gap-4 md:grid-cols-2">{allowed.map((key) => <div key={key} className="rounded-2xl border border-slate-200 p-4">
      <h3 className="font-semibold capitalize text-slate-900">{key} placement</h3>
      <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={placements[key].enabled} onChange={(event) => setPlacements((current) => ({ ...current, [key]: { ...current[key], enabled: event.target.checked } }))} />Available</label>
      <label className="mt-3 block text-sm">Daily spend limit (cents; 0 = no placement cap)<input type="number" min="0" value={placements[key].dailyBudgetCents} onChange={(event) => setPlacements((current) => ({ ...current, [key]: { ...current[key], dailyBudgetCents: Number(event.target.value) } }))} className="mt-1 w-full rounded-xl border border-slate-200 p-2" /></label>
      <Button className="mt-3" size="sm" onClick={() => void save(key)} disabled={busy}>Save placement</Button>
    </div>)}</div>
    {error ? <p role="alert" className="text-sm text-rose-600">{error}</p> : null}{notice ? <p role="status" className="text-sm text-emerald-700">{notice}</p> : null}
  </div>
}

function CreatorApplicationTable({ rows, onAction }: { rows: RecordValue[]; onAction: (action: ActionState) => void }) {
  return <SimpleTable rows={rows} columns={['creatorName', 'email', 'status', 'createdAt', 'reason']} actions={(row) => row.status === 'PENDING' ? <>
    <ActionButton label="Approve" onClick={() => onAction({ endpoint: `/api/admin/monetization/applications/${row.id}`, method: 'PATCH', body: { status: 'APPROVED' }, title: 'Approve creator', description: 'Confirm this application and activate creator monetization.', field: 'reason' })} />
    <ActionButton label="Reject" danger onClick={() => onAction({ endpoint: `/api/admin/monetization/applications/${row.id}`, method: 'PATCH', body: { status: 'REJECTED' }, title: 'Reject creator', description: 'Reject this application with an auditable reason.', field: 'reason' })} />
  </> : null} />
}

function CreatorAccountTable({ rows, onAction }: { rows: RecordValue[]; onAction: (action: ActionState) => void }) {
  return <SimpleTable rows={rows} columns={['creatorName', 'email', 'status', 'followers', 'publicPosts', 'createdAt']} actions={(row) => row.status === 'ACTIVE'
    ? <ActionButton label="Suspend monetization" danger onClick={() => onAction({ endpoint: `/api/admin/monetization/creators/${row.creatorId}/status`, method: 'PATCH', body: { status: 'SUSPENDED' }, title: 'Suspend creator monetization', description: 'Disable this creator account. The account owner cannot reactivate it.', field: 'reason' })} />
    : <ActionButton label="Reactivate" onClick={() => onAction({ endpoint: `/api/admin/monetization/creators/${row.creatorId}/status`, method: 'PATCH', body: { status: 'ACTIVE' }, title: 'Reactivate creator monetization', description: 'Re-enable this approved creator account.', field: 'reason' })} />} />
}

function AdCampaignTable({ rows, onAction }: { rows: RecordValue[]; onAction: (action: ActionState) => void }) {
  return <SimpleTable rows={rows} columns={['name', 'advertiserName', 'placementKey', 'status', 'spendCents', 'totalBudgetCents', 'startsAt', 'endsAt']} actions={(row) => {
    const status = String(row.status)
    const action = (nextStatus: string, label: string, danger = false) => <ActionButton key={nextStatus} label={label} danger={danger} onClick={() => onAction({ endpoint: `/api/admin/ads/campaigns/${row.id}`, method: 'PATCH', body: { status: nextStatus }, title: `${label} ad campaign`, description: `Confirm the ${label.toLowerCase()} transition and add an audit note.`, field: 'reason' })} />
    if (status === 'SUBMITTED') return <>{action('APPROVED', 'Approve')}{action('REJECTED', 'Reject', true)}</>
    if (status === 'ACTIVE' || status === 'APPROVED') return <>{action('PAUSED', 'Pause')}{action('COMPLETED', 'Complete', true)}</>
    if (status === 'PAUSED') return <>{action('RESUMED', 'Resume')}{action('COMPLETED', 'Complete', true)}</>
    return null
  }} />
}

function PayoutReviewTable({ rows, onAction }: { rows: RecordValue[]; onAction: (action: ActionState) => void }) {
  return <SimpleTable rows={rows} columns={['id', 'creatorId', 'status', 'amountCents', 'currency', 'requestedAt']} actions={(row) => {
    const status = String(row.status)
    const action = (nextStatus: string, label: string, danger = false) => <ActionButton key={nextStatus} label={label} danger={danger} onClick={() => onAction({ endpoint: `/api/admin/finance/payouts/${row.id}`, method: 'PATCH', body: { status: nextStatus }, title: `${label} payout request`, description: 'Confirm this payout state transition and include an audit reason.', field: 'reason' })} />
    if (status === 'PENDING') return <>{action('APPROVED', 'Approve')}{action('REJECTED', 'Reject', true)}</>
    if (status === 'APPROVED') return action('PROCESSING', 'Mark processing')
    if (status === 'PROCESSING') return action('FAILED', 'Mark failed', true)
    return null
  }} />
}

function AdAnalytics({ data }: { data: RecordValue }) {
  const metrics: Array<{ label: string; value: unknown }> = [
    { label: 'Validated impressions', value: data.impressions },
    { label: 'Validated clicks', value: data.clicks },
    { label: 'Tracked ad spend', value: formatMoney(data.spendCents) },
  ]
  return <div className="grid gap-4 sm:grid-cols-3">{metrics.map(({ label, value }) => <div key={label} className="rounded-2xl bg-slate-50 p-4"><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-2xl font-semibold text-slate-900">{typeof value === 'string' ? value : display(value ?? 0)}</p></div>)}</div>
}

function SimpleTable({ rows, columns, actions }: { rows: RecordValue[]; columns: string[]; actions: (row: RecordValue) => ReactNode }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead><tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">{columns.map((column) => <th key={column} className="px-3 py-3">{labels[column] ?? column}</th>)}<th className="px-3 py-3 text-right">Review actions</th></tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)} className="border-b border-slate-100"><td className="px-3 py-3">{formatCell(columns[0], row[columns[0]])}</td>{columns.slice(1).map((column) => <td key={column} className="max-w-[220px] truncate px-3 py-3 text-slate-600">{formatCell(column, row[column])}</td>)}<td className="px-3 py-3"><div className="flex justify-end gap-3">{actions(row)}</div></td></tr>)}</tbody></table></div>
}

function formatCell(key: string, value: unknown) {
  if (key.toLowerCase().includes('cents') || key.toLowerCase().includes('spend') || key.toLowerCase().includes('budget')) return formatMoney(value)
  if (key.endsWith('At')) return formatDate(value)
  return display(value)
}

function Overview({ data, onNavigate }: { data: DashboardResponse; onNavigate: (section: Section) => void }) { return <><section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{metricCards.map(({ label, key, icon: Icon, tone }) => <div key={label} className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm"><div className="flex items-center justify-between"><p className="text-sm text-slate-500">{label}</p><span className={`flex h-9 w-9 items-center justify-center rounded-2xl ${tone === 'violet' ? 'bg-violet-100 text-violet-700' : tone === 'emerald' ? 'bg-emerald-100 text-emerald-700' : tone === 'amber' ? 'bg-amber-100 text-amber-700' : tone === 'cyan' ? 'bg-cyan-100 text-cyan-700' : tone === 'slate' ? 'bg-slate-100 text-slate-700' : 'bg-rose-100 text-rose-700'}`}><Icon className="h-4 w-4" aria-hidden="true" /></span></div><p className="mt-5 text-3xl font-semibold text-slate-900">{key.toLowerCase().includes('revenue') || key === 'pendingPayouts' ? formatMoney(data.metrics?.[key]) : display(data.metrics?.[key] ?? 0)}</p></div>)}</section><div className="grid gap-6 xl:grid-cols-2"><ActivityPanel title="Recent reports" rows={data.recentReports ?? []} onClick={() => onNavigate('reports')} /><ActivityPanel title="Recent moderation actions" rows={data.recentModerationActions ?? []} onClick={() => onNavigate('moderation')} /></div><ActivityPanel title="Recent admin activity" rows={data.recentAdminActivity ?? []} /></> }
function ActivityPanel({ title, rows, onClick }: { title: string; rows: RecordValue[]; onClick?: () => void }) { return <section className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold text-slate-900">{title}</h2>{onClick ? <Button variant="ghost" size="sm" onClick={onClick}>Review all<ChevronRight className="h-4 w-4" /></Button> : null}</div>{rows.length === 0 ? <EmptyState label="Nothing to show yet." /> : <div className="space-y-3">{rows.slice(0, 6).map((row, index) => <div key={String(row.id ?? index)} className="rounded-2xl bg-slate-50 p-3 text-sm"><div className="flex items-center justify-between gap-3"><p className="font-medium text-slate-800">{display(row.category ?? row.actionType ?? row.status ?? 'Admin activity')}</p><span className="text-xs text-slate-500">{formatDate(row.createdAt)}</span></div><p className="mt-1 truncate text-xs text-slate-500">{display(row.details ?? row.reason ?? row.message ?? 'No details')}</p></div>)}</div>}</section> }
function DataTable({ section, rows, onView, onAction }: { section: Section; rows: RecordValue[]; onView: (row: RecordValue) => void; onAction: (action: ActionState) => void }) { const columns = section === 'users' ? ['name', 'email', 'role', 'status', 'createdAt'] : section === 'reports' || section === 'moderation' ? ['category', 'status', 'details', 'createdAt'] : section === 'audit' ? ['actionType', 'details', 'createdAt'] : section === 'appeals' ? ['originalAction', 'status', 'reason', 'createdAt'] : section === 'revenue' ? ['grossRevenue', 'platformRevenue', 'creatorNetEarnings', 'pendingPayouts', 'adSpendCents', 'adImpressions', 'adClicks'] : ['id', 'status', 'amountCents', 'createdAt']; return <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead><tr className="border-b border-slate-200 text-xs uppercase tracking-[0.14em] text-slate-500">{columns.map((column) => <th key={column} className="px-3 py-3 font-semibold">{labels[column] ?? column}</th>)}<th className="px-3 py-3 text-right">Actions</th></tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)} className="border-b border-slate-100 last:border-0 hover:bg-slate-50"><td className="px-3 py-3 font-medium text-slate-800">{display(row[columns[0]])}</td>{columns.slice(1).map((column) => <td key={column} className="max-w-[220px] truncate px-3 py-3 text-slate-600">{column === 'createdAt' ? formatDate(row[column]) : column.toLowerCase().includes('revenue') || column === 'pendingPayouts' || column === 'grossRevenue' || column === 'adSpendCents' ? formatMoney(row[column]) : display(row[column])}</td>)}<td className="px-3 py-3"><div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => onView(row)}>View</Button>{section === 'users' ? <UserActions row={row} onAction={onAction} /> : null}{section === 'reports' ? <><ActionButton label="Resolve" onClick={() => onAction({ endpoint: `/api/admin/reports/${row.id}/resolve`, title: 'Resolve report', description: 'Mark this report resolved and add a note to the audit trail.', field: 'note' })} /><ActionButton label="Reject" danger onClick={() => onAction({ endpoint: `/api/admin/reports/${row.id}/reject`, title: 'Reject report', description: 'Reject this report and add a note to the audit trail.', field: 'note' })} /></> : null}{section === 'moderation' ? <><ActionButton label="Remove" danger onClick={() => onAction({ endpoint: `/api/admin/moderation/${row.id}/remove`, title: 'Remove content', description: 'Confirm removal of this moderation item.', field: 'note' })} /><ActionButton label="Approve" onClick={() => onAction({ endpoint: `/api/admin/moderation/${row.id}/approve`, title: 'Approve content', description: 'Confirm that this moderation item is safe to approve.', field: 'note' })} /></> : null}{section === 'appeals' ? <><ActionButton label="Approve" onClick={() => onAction({ endpoint: `/api/admin/appeals/${row.id}/approve`, title: 'Approve appeal', description: 'Confirm approval of this appeal.', field: 'note' })} /><ActionButton label="Reject" danger onClick={() => onAction({ endpoint: `/api/admin/appeals/${row.id}/reject`, title: 'Reject appeal', description: 'Confirm rejection of this appeal.', field: 'note' })} /></> : null}</div></td></tr>)}</tbody></table></div> }
function UserActions({ row, onAction }: { row: RecordValue; onAction: (action: ActionState) => void }) { const status = String(row.status ?? 'ACTIVE'); if (status === 'BANNED') return <ActionButton label="Unban" onClick={() => onAction({ endpoint: `/api/admin/users/${row.id}/unban`, title: 'Unban user', description: 'Restore this account to active status.', field: 'reason' })} />; if (status === 'SUSPENDED') return <><ActionButton label="Unsuspend" onClick={() => onAction({ endpoint: `/api/admin/users/${row.id}/unsuspend`, title: 'Unsuspend user', description: 'Restore this account to active status.', field: 'reason' })} /><ActionButton label="Ban" danger onClick={() => onAction({ endpoint: `/api/admin/users/${row.id}/ban`, title: 'Ban user', description: 'This is a destructive account action.', field: 'reason' })} /></>; return <><ActionButton label="Suspend" danger onClick={() => onAction({ endpoint: `/api/admin/users/${row.id}/suspend`, title: 'Suspend user', description: 'Restrict this account until an administrator restores it.', field: 'reason' })} /><ActionButton label="Ban" danger onClick={() => onAction({ endpoint: `/api/admin/users/${row.id}/ban`, title: 'Ban user', description: 'This is a destructive account action.', field: 'reason' })} /></> }
function ActionButton({ label, danger, onClick }: { label: string; danger?: boolean; onClick: () => void }) { return <button type="button" onClick={onClick} className={`text-xs font-semibold ${danger ? 'text-rose-600 hover:text-rose-800' : 'text-violet-700 hover:text-violet-900'}`}>{label}</button> }
function LoadingState() { return <div className="flex items-center justify-center rounded-2xl bg-slate-50 p-10 text-sm text-slate-500"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Loading from NOVAKOKO...</div> }
function EmptyState({ label }: { label: string }) { return <div className="rounded-2xl bg-slate-50 p-8 text-center text-sm text-slate-500"><Search className="mx-auto mb-2 h-5 w-5 text-slate-400" />{label}</div> }
function DetailModal({ item, onClose }: { item: RecordValue; onClose: () => void }) { const entries = Object.entries(item).filter(([key]) => !['id', 'profile', 'user', 'post', 'comment'].includes(key)); return <Modal open title="Record details" onClose={onClose}><div className="space-y-3">{entries.map(([key, value]) => <div key={key} className="grid grid-cols-[120px_1fr] gap-3 border-b border-slate-100 pb-2 text-sm"><dt className="font-medium text-slate-500">{labels[key] ?? key}</dt><dd className="break-words text-slate-800">{key.toLowerCase().includes('date') || key.endsWith('At') ? formatDate(value) : display(value)}</dd></div>)}</div></Modal> }