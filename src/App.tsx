import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { AuthProvider, useAuth } from './context/AuthContext'
import { UpdateChecker } from './components/UpdateChecker'

const HomePage = lazy(() => import('./pages/HomePage').then(({ HomePage: page }) => ({ default: page })))
const AuthPage = lazy(() => import('./pages/AuthPage').then(({ AuthPage: page }) => ({ default: page })))
const DownloadPage = lazy(() => import('./pages/DownloadPage').then(({ DownloadPage: page }) => ({ default: page })))
const ExplorePage = lazy(() => import('./pages/ExplorePage').then(({ ExplorePage: page }) => ({ default: page })))
const MessagesPage = lazy(() => import('./pages/MessagesPage').then(({ MessagesPage: page }) => ({ default: page })))
const NotificationsPage = lazy(() => import('./pages/NotificationsPage').then(({ NotificationsPage: page }) => ({ default: page })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(({ SettingsPage: page }) => ({ default: page })))
const AdminPage = lazy(() => import('./pages/AdminPage').then(({ AdminPage: page }) => ({ default: page })))
const AiPage = lazy(() => import('./pages/AiPage').then(({ AiPage: page }) => ({ default: page })))
const UpdatesPage = lazy(() => import('./pages/UpdatesPage').then(({ UpdatesPage: page }) => ({ default: page })))
const VideosPage = lazy(() => import('./pages/VideosPage').then(({ VideosPage: page }) => ({ default: page })))
const CompleteProfilePage = lazy(() => import('./pages/CompleteProfilePage').then(({ CompleteProfilePage: page }) => ({ default: page })))
const CreatorMonetizationPage = lazy(() => import('./pages/CreatorMonetizationPage').then(({ CreatorMonetizationPage: page }) => ({ default: page })))
const AdCampaignsPage = lazy(() => import('./pages/AdCampaignsPage').then(({ AdCampaignsPage: page }) => ({ default: page })))
const CreatePage = lazy(() => import('./pages/CreatePage').then(({ CreatePage: page }) => ({ default: page })))
const CommunitiesPage = lazy(() => import('./pages/CommunitiesPage').then(({ CommunitiesPage: page }) => ({ default: page })))
const ProfilePage = lazy(() => import('./pages/ProfilePage').then(({ ProfilePage: page }) => ({ default: page })))
const LivePage = lazy(() => import('./pages/LivePage').then(({ LivePage: page }) => ({ default: page })))
const CallsPage = lazy(() => import('./pages/CallsPage').then(({ CallsPage: page }) => ({ default: page })))

function RouteContentLoading() {
  return <div className="p-6 text-sm text-slate-600" role="status">Loading page…</div>
}

function StartupShell() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-900" aria-label="NOVAKOKO startup">
      <header className="flex h-14 items-center border-b border-slate-200 bg-white px-5">
        <span className="text-sm font-bold tracking-wide text-blue-800">NOVAKOKO</span>
      </header>
      <div className="mx-auto max-w-7xl px-4 py-6">
        <div className="h-5 w-28 animate-pulse rounded bg-slate-200" />
        <div className="mt-5 h-24 animate-pulse rounded-lg bg-white ring-1 ring-slate-200" />
        <p className="mt-4 text-xs text-slate-500" role="status">Checking your session…</p>
      </div>
    </main>
  )
}

function PublicRoute() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return <StartupShell />
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />
  }

  return <Outlet />
}

function ProtectedRoute() {
  const { isAuthenticated, isLoading, user } = useAuth()

  if (isLoading) {
    return <StartupShell />
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return <div key={user?.id ?? 'anonymous'} className="contents"><Outlet /></div>
}

function AdminRoute() {
  const { isAuthenticated, isLoading, user } = useAuth()

  if (isLoading) {
    return <StartupShell />
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  if (!['ADMIN', 'SUPER_ADMIN', 'MODERATOR'].includes(user?.role ?? 'USER')) {
    return <Navigate to="/" replace />
  }

  return <Outlet />
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/download" element={<Suspense fallback={<RouteContentLoading />}><DownloadPage /></Suspense>} />
      <Route element={<PublicRoute />}>
        <Route path="/login" element={<Suspense fallback={<RouteContentLoading />}><AuthPage mode="login" /></Suspense>} />
        <Route path="/register" element={<Suspense fallback={<RouteContentLoading />}><AuthPage mode="register" /></Suspense>} />
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route path="/complete-profile" element={<Suspense fallback={<RouteContentLoading />}><CompleteProfilePage /></Suspense>} />
        <Route path="/" element={<AppShell><Suspense fallback={<RouteContentLoading />}><HomePage /></Suspense></AppShell>} />
        <Route path="/explore" element={<AppShell><Suspense fallback={<RouteContentLoading />}><ExplorePage /></Suspense></AppShell>} />
        <Route path="/create" element={<AppShell><Suspense fallback={<RouteContentLoading />}><CreatePage /></Suspense></AppShell>} />
        <Route path="/videos" element={<AppShell><Suspense fallback={<RouteContentLoading />}><VideosPage /></Suspense></AppShell>} />
        <Route path="/notifications" element={<AppShell><Suspense fallback={<RouteContentLoading />}><NotificationsPage /></Suspense></AppShell>} />
        <Route path="/messages" element={<AppShell><Suspense fallback={<RouteContentLoading />}><MessagesPage /></Suspense></AppShell>} />
        <Route path="/updates" element={<AppShell><Suspense fallback={<RouteContentLoading />}><UpdatesPage /></Suspense></AppShell>} />
        <Route path="/live" element={<AppShell><Suspense fallback={<RouteContentLoading />}><LivePage /></Suspense></AppShell>} />
        <Route path="/calls" element={<AppShell><Suspense fallback={<RouteContentLoading />}><CallsPage /></Suspense></AppShell>} />
        <Route path="/ai" element={<AppShell><Suspense fallback={<RouteContentLoading />}><AiPage /></Suspense></AppShell>} />
        <Route path="/communities" element={<AppShell><Suspense fallback={<RouteContentLoading />}><CommunitiesPage /></Suspense></AppShell>} />
        <Route path="/profile" element={<AppShell><Suspense fallback={<RouteContentLoading />}><ProfilePage /></Suspense></AppShell>} />
        <Route path="/profile/:id" element={<AppShell><Suspense fallback={<RouteContentLoading />}><ProfilePage /></Suspense></AppShell>} />
        <Route path="/settings" element={<AppShell><Suspense fallback={<RouteContentLoading />}><SettingsPage /></Suspense></AppShell>} />
        <Route path="/creator/monetization" element={<AppShell><Suspense fallback={<RouteContentLoading />}><CreatorMonetizationPage /></Suspense></AppShell>} />
        <Route path="/advertise" element={<AppShell><Suspense fallback={<RouteContentLoading />}><AdCampaignsPage /></Suspense></AppShell>} />

        <Route element={<AdminRoute />}>
          <Route path="/admin" element={<AppShell><Suspense fallback={<RouteContentLoading />}><AdminPage /></Suspense></AppShell>} />
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
        <UpdateChecker />
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  )
}

export default App
