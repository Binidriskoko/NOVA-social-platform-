export type AndroidBackAction = 'history' | 'home' | 'minimize'

export function getAndroidBackAction(pathname: string, historyIndex: unknown): AndroidBackAction {
  if (typeof historyIndex === 'number' && Number.isInteger(historyIndex) && historyIndex > 0) {
    return 'history'
  }
  return pathname === '/' || pathname === '/login' || pathname === '/appeal' ? 'minimize' : 'home'
}