import { useEffect, useState } from 'react'
import { Download, Smartphone } from 'lucide-react'
import './DownloadPage.css'

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const apkPath = '/downloads/novakoko-1.0.0.apk'

export function DownloadPage() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const [apkAvailable, setApkAvailable] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', handleInstallPrompt)
    void fetch(apkPath, { method: 'HEAD' }).then((response) => setApkAvailable(response.ok)).catch(() => setApkAvailable(false))
    return () => window.removeEventListener('beforeinstallprompt', handleInstallPrompt)
  }, [])

  async function installPwa() {
    if (!installPrompt) {
      setStatus('Use your browser menu and choose Install app or Add to Home Screen.')
      return
    }
    await installPrompt.prompt()
    const choice = await installPrompt.userChoice
    setStatus(choice.outcome === 'accepted' ? 'novachat is ready on your device.' : 'Installation was dismissed.')
    setInstallPrompt(null)
  }

  return (
    <main className="download-page">
      <header className="download-header">
        <img src="/pwa-icon.svg" alt="" />
        <span>novachat</span>
      </header>
      <section className="download-hero">
        <div className="download-copy">
          <p className="download-eyebrow">Your community, within reach</p>
          <h1>Stay close to what matters.</h1>
          <p>Install novachat on your device for a faster, focused way to connect with your people.</p>
          <div className="download-actions">
            <button className="download-action download-action-primary" onClick={() => void installPwa()}>
              <Smartphone size={18} aria-hidden="true" />
              Install novachat
            </button>
            {apkAvailable ? (
              <a className="download-action" href={apkPath} download>
                <Download size={18} aria-hidden="true" />
                Android APK
              </a>
            ) : (
              <button className="download-action" disabled title="A signed Android release is not available yet">
                <Download size={18} aria-hidden="true" />
                Android release pending
              </button>
            )}
          </div>
          <p className="download-status" aria-live="polite">{status || (apkAvailable ? 'Signed Android release available.' : 'The signed Android release is being prepared.')}</p>
        </div>
        <div className="download-mark" aria-hidden="true">
          <img src="/pwa-icon.svg" alt="" />
        </div>
      </section>
      <footer className="download-footer">
        <span>© novachat</span>
        <span>Installable on supported browsers</span>
      </footer>
    </main>
  )
}
