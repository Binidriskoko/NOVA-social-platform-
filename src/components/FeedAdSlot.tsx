import { useEffect, useState } from 'react'
import { apiRequest } from '../lib/api'

type AdCampaign = { id: string; name: string; creativeUrl: string; destinationUrl: string; impressionId: string }
type ConsentResponse = { consented: boolean; adsAvailable: boolean }

export function FeedAdSlot() {
  const [consent, setConsent] = useState<ConsentResponse | null>(null)
  const [campaign, setCampaign] = useState<AdCampaign | null>(null)
  const [error, setError] = useState('')

  const loadCampaign = async () => {
    setError('')
    try {
      const preference = await apiRequest<ConsentResponse>('/api/ads/consent')
      setConsent(preference)
      if (!preference.consented || !preference.adsAvailable) {
        setCampaign(null)
        return
      }
      const response = await apiRequest<{ campaign: AdCampaign | null }>('/api/ads/placements/feed')
      setCampaign(response.campaign)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load advertising preferences.')
    }
  }

  useEffect(() => { void loadCampaign() }, [])

  const setAdvertisingConsent = async (consented: boolean) => {
    setError('')
    try {
      await apiRequest('/api/ads/consent', { method: 'PUT', body: JSON.stringify({ consented }) })
      await loadCampaign()
    } catch (consentError) {
      setError(consentError instanceof Error ? consentError.message : 'Unable to update advertising preferences.')
    }
  }

  const recordClick = async () => {
    if (!campaign) return
    try {
      await apiRequest(`/api/ads/campaigns/${encodeURIComponent(campaign.id)}/events`, {
        method: 'POST',
        body: JSON.stringify({ eventType: 'CLICK', impressionId: campaign.impressionId }),
      })
    } catch (clickError) {
      setError(clickError instanceof Error ? clickError.message : 'Unable to record the ad click.')
    }
  }

  if (!consent?.adsAvailable) return null
  if (!consent.consented) {
    return <aside className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ring-1 ring-slate-200" aria-label="Advertising preferences">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Advertising preferences</p>
      <p className="mt-1 text-sm text-slate-700">Ads are off. Allow relevant feed ads and their basic impression/click measurement?</p>
      <button type="button" onClick={() => void setAdvertisingConsent(true)} className="mt-3 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Allow ads</button>
      {error ? <p role="alert" className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </aside>
  }
  return <aside className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm ring-1 ring-slate-200" aria-label="Sponsored content">
    {campaign ? <a href={campaign.destinationUrl} target="_blank" rel="noopener noreferrer" onClick={() => void recordClick()} className="block">
      <img src={campaign.creativeUrl} alt={`Sponsored: ${campaign.name}`} className="max-h-80 w-full object-cover" loading="lazy" />
      <div className="p-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sponsored</p><p className="mt-1 font-semibold text-slate-900">{campaign.name}</p></div>
    </a> : <p className="p-4 text-sm text-slate-500">No sponsored content is available right now.</p>}
    <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2">
      {error ? <span role="alert" className="text-xs text-rose-600">{error}</span> : <span className="text-xs text-slate-500">Ad preference is saved to your account.</span>}
      <button type="button" onClick={() => void setAdvertisingConsent(false)} className="text-xs font-medium text-slate-600 underline">Turn ads off</button>
    </div>
  </aside>
}
