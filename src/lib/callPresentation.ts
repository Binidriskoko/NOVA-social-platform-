type CallPresentationRecord = {
  callerId: string
  status: string
  type: 'voice' | 'video'
  participants: { userId: string; status: string }[]
}

export type CallScreenState = 'incoming' | 'outgoing' | 'connecting' | 'active' | 'ended' | 'failed'

export function callScreenState(call: CallPresentationRecord, userId: string, connected: boolean, failed = false): CallScreenState {
  if (failed) return 'failed'
  if (['ended', 'cancelled', 'rejected', 'missed'].includes(call.status)) return 'ended'
  const participant = call.participants.find((entry) => entry.userId === userId)
  if (participant?.status === 'left') return 'ended'
  if (call.status === 'ringing' && call.callerId !== userId && participant?.status === 'pending') return 'incoming'
  if (call.status === 'connected' && connected) return 'active'
  if (call.callerId === userId && call.status === 'ringing') return 'outgoing'
  return 'connecting'
}

export function formatCallDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const twoDigits = (value: number) => String(value).padStart(2, '0')
  return hours ? `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}` : `${twoDigits(minutes)}:${twoDigits(seconds)}`
}
