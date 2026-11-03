import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { lazy, Suspense, useEffect, useRef } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { AuthProvider, useAuth } from './context/AuthContext'
import { CommunitiesPage } from './pages/CommunitiesPage'
import { ExplorePage } from './pages/ExplorePage'
import { HomePage } from './pages/HomePage'
import { MessagesPage } from './pages/MessagesPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { ProfilePage } from './pages/ProfilePage'
import { SettingsPage } from './pages/SettingsPage'
import { AuthPage } from './pages/AuthPage'
import { AdminPage } from './pages/AdminPage'
import { DownloadPage } from './pages/DownloadPage'
import { AiPage } from './pages/AiPage'
import { UpdatesPage } from './pages/UpdatesPage'
import { VideosPage } from './pages/VideosPage'
import { CompleteProfilePage } from './pages/CompleteProfilePage'
import { CreatorMonetizationPage } from './pages/CreatorMonetizationPage'
import { AdCampaignsPage } from './pages/AdCampaignsPage'
import { CreatePage } from './pages/CreatePage'
import { AccountAppealPage } from './pages/AccountAppealPage'
import { UpdateChecker } from './components/UpdateChecker'
import { getAndroidBackAction } from './lib/androidBackNavigation'

const LivePage = lazy(() => import('./pages/LivePage').then(({ LivePage: page }) => ({ default: page })))
const CallsPage = lazy(() => import('./pages/CallsPage').then(({ CallsPage: page }) => ({ default: page })))

function MediaPageLoading() {
  return <div className="p-6 text-sm text-slate-600" role="status">Loading media tools…</div>
}

function PublicRoute() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm font-medium text-slate-600">Loading...</div>
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />
  }

  return <Outlet />
}

function ProtectedRoute() {
  const { isAuthenticated, isLoading, user } = useAuth()
  const location = useLocation()

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm font-medium text-slate-600">Loading...</div>
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  const restricted = ['BANNED', 'SUSPENDED', 'DEACTIVATED'].includes(user?.status ?? '')
  if (restricted && location.pathname !== '/appeal') {
    return <Navigate to="/appeal" replace />
  }
  if (!restricted && location.pathname === '/appeal') {
    return <Navigate to="/" replace />
  }

  return <Outlet key={user?.id ?? 'anonymous'} />
}

function AdminRoute() {
  const { isAuthenticated, isLoading, user } = useAuth()

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm font-medium text-slate-600">Loading...</div>
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  if (!['ADMIN', 'SUPER_ADMIN', 'MODERATOR'].includes(user?.role ?? 'USER')) {
    return <Navigate to="/" replace />
  }

  return <Outlet />
}


function AndroidBackHandler() {
  const navigate = useNavigate()
  const location = useLocation()
  const locationRef = useRef(location)
  locationRef.current = location

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    let active = true
    const listener = CapacitorApp.addListener('backButton', () => {
      if (!active) return
      const action = getAndroidBackAction(locationRef.current.pathname, window.history.state?.idx)
      if (action === 'history') {
        navigate(-1)
      } else if (action === 'home') {
        navigate('/', { replace: true })
      } else {
        void CapacitorApp.minimizeApp()
      }
    })

    return () => {
      active = false
      void listener.then((handle) => handle.remove())
    }
  }, [navigate])

  return null
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/download" element={<DownloadPage />} />
      <Route element={<PublicRoute />}>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route path="/appeal" element={<AccountAppealPage />} />
        <Route path="/complete-profile" element={<CompleteProfilePage />} />
        <Route path="/" element={<AppShell><HomePage /></AppShell>} />
        <Route path="/explore" element={<AppShell><ExplorePage /></AppShell>} />
        <Route path="/create" element={<AppShell><CreatePage /></AppShell>} />
        <Route path="/videos" element={<AppShell><VideosPage /></AppShell>} />
        <Route path="/notifications" element={<AppShell><NotificationsPage /></AppShell>} />
        <Route path="/messages" element={<AppShell><MessagesPage /></AppShell>} />
        <Route path="/updates" element={<AppShell><UpdatesPage /></AppShell>} />
        <Route path="/live" element={<Suspense fallback={<MediaPageLoading />}><AppShell><LivePage /></AppShell></Suspense>} />
        <Route path="/calls" element={<Suspense fallback={<MediaPageLoading />}><AppShell><CallsPage /></AppShell></Suspense>} />
        <Route path="/ai" element={<AppShell><AiPage /></AppShell>} />
        <Route path="/communities" element={<AppShell><CommunitiesPage /></AppShell>} />
        <Route path="/profile" element={<AppShell><ProfilePage /></AppShell>} />
        <Route path="/profile/:id" element={<AppShell><ProfilePage /></AppShell>} />
        <Route path="/settings" element={<AppShell><SettingsPage /></AppShell>} />
        <Route path="/creator/monetization" element={<AppShell><CreatorMonetizationPage /></AppShell>} />
        <Route path="/advertise" element={<AppShell><AdCampaignsPage /></AppShell>} />

        <Route element={<AdminRoute />}>
          <Route path="/admin" element={<AppShell><AdminPage /></AppShell>} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AndroidBackHandler />
        <UpdateChecker />
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  )
}

export default App
