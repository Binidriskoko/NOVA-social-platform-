import { describe, expect, it, vi } from 'vitest'
import { callScreenState, callViewportClassName, formatCallDuration } from '../src/lib/callPresentation'
import { cameraSwitchErrorMessage, chooseNextCamera, switchToNextCamera } from '../src/lib/cameraSwitching'
import { sendPostToConversation } from '../src/lib/postSharing'
import { isVideoStoryMedia, sendStoryReply } from '../src/lib/storyReplies'
import { upsertMessageById } from '../src/lib/messageList'

describe('group video camera switching', () => {
  const devices = [
    { deviceId: 'front-id', label: 'Front camera' },
    { deviceId: 'rear-id', label: 'Back camera' },
  ]

  it('selects the opposite-facing camera when available', () => {
    expect(chooseNextCamera(devices, 'front-id', 'user')?.deviceId).toBe('rear-id')
    expect(chooseNextCamera(devices, 'rear-id', 'environment')?.deviceId).toBe('front-id')
  })

  it('switches through the provided LiveKit device callback and reports missing or failed devices', async () => {
    const switchDevice = vi.fn().mockResolvedValue(true)
    await expect(switchToNextCamera(devices, 'front-id', 'user', switchDevice)).resolves.toEqual(devices[1])
    expect(switchDevice).toHaveBeenCalledWith('rear-id')
    await expect(switchToNextCamera([devices[0]], 'front-id', 'user', switchDevice)).rejects.toThrow('No alternate camera')
    await expect(switchToNextCamera(devices, 'front-id', 'user', vi.fn().mockResolvedValue(false))).rejects.toThrow('could not switch')
    expect(cameraSwitchErrorMessage(new DOMException('Denied', 'NotAllowedError'))).toMatch(/permission was denied/)
  })
})

describe('call screen state', () => {
  const baseCall = {
    callerId: 'caller',
    status: 'ringing',
    type: 'voice' as const,
    participants: [{ userId: 'caller', status: 'pending' }, { userId: 'recipient', status: 'pending' }],
  }

  it('distinguishes incoming, outgoing, connecting, active, ended and failed calls', () => {
    expect(callScreenState(baseCall, 'recipient', false)).toBe('incoming')
    expect(callScreenState(baseCall, 'caller', false)).toBe('outgoing')
    expect(callScreenState({ ...baseCall, status: 'accepted' }, 'recipient', false)).toBe('connecting')
    expect(callScreenState({ ...baseCall, status: 'connected' }, 'recipient', true)).toBe('active')
    expect(callScreenState({ ...baseCall, status: 'ended' }, 'recipient', false)).toBe('ended')
    expect(callScreenState({ ...baseCall, status: 'connected', participants: [{ userId: 'caller', status: 'connected' }, { userId: 'recipient', status: 'left' }] }, 'recipient', false)).toBe('ended')
    expect(callScreenState(baseCall, 'caller', false, true)).toBe('failed')
  })

  it('formats a connected duration as mm:ss or h:mm:ss', () => {
    expect(formatCallDuration(65_000)).toBe('01:05')
    expect(formatCallDuration(3_661_000)).toBe('1:01:01')
  })

  it('uses a responsive safe-area call viewport with dynamic device height', () => {
    expect(callViewportClassName).toContain('h-[100dvh]')
    expect(callViewportClassName).toContain('w-auto')
    expect(callViewportClassName).toContain('max-w-full')
    expect(callViewportClassName).toContain('safe-area-inset-left')
    expect(callViewportClassName).toContain('safe-area-inset-right')
    expect(callViewportClassName).toContain('safe-area-inset-top')
    expect(callViewportClassName).toContain('safe-area-inset-bottom')
  })
})

describe('message list reconciliation', () => {
  it('keeps a sent voice message visible once when both the response and socket event arrive', () => {
    const initial = [{ id: 'text-1', contentType: 'TEXT' }]
    const sentVoiceMessage = { id: 'voice-1', contentType: 'VOICE' }
    const afterApiResponse = upsertMessageById(initial, sentVoiceMessage)
    const afterSocketEvent = upsertMessageById(afterApiResponse, sentVoiceMessage)

    expect(afterSocketEvent.filter((message) => message.id === 'voice-1')).toHaveLength(1)
    expect(afterSocketEvent).toHaveLength(2)
  })
})

describe('post share delivery', () => {
  it('sends the selected post URL through the existing conversation messages API', async () => {
    const request = vi.fn().mockResolvedValue({})
    await sendPostToConversation('friend/chat', 'Ari', 'https://nova.test/#post-42', request)
    expect(request).toHaveBeenCalledWith('/api/conversations/friend%2Fchat/messages', {
      method: 'POST',
      body: JSON.stringify({ text: 'Check out this post by Ari: https://nova.test/#post-42' }),
    })
  })
})

describe('story reply delivery and media', () => {
  it('replies in an existing direct conversation', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ conversations: [{ id: 'direct-1', participants: [{ userId: 'owner' }] }] })
      .mockResolvedValueOnce({})
    await sendStoryReply('owner', '  Nice story! ', request)
    expect(request).toHaveBeenNthCalledWith(2, '/api/conversations/direct-1/messages', {
      method: 'POST',
      body: JSON.stringify({ text: 'Reply to your story: Nice story!' }),
    })
  })

  it('creates a direct conversation when needed and does not mask API errors', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ conversations: [] })
      .mockResolvedValueOnce({ conversation: { id: 'new-direct' } })
      .mockResolvedValueOnce({})
    await sendStoryReply('owner', 'Hello', request)
    expect(request).toHaveBeenCalledTimes(3)
    const failedRequest = vi.fn().mockRejectedValue(new Error('Message send failed'))
    await expect(sendStoryReply('owner', 'Hello', failedRequest)).rejects.toThrow('Message send failed')
  })

  it('recognizes playable story video URL extensions', () => {
    expect(isVideoStoryMedia('/api/media/files/clip.mp4')).toBe(true)
    expect(isVideoStoryMedia('https://cdn.example.test/clip.webm?download=1')).toBe(true)
    expect(isVideoStoryMedia('https://cdn.example.test/photo.jpg')).toBe(false)
  })
})
