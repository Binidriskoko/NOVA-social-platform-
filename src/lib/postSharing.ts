export type PostShareDetails = {
  title: string
  text: string
  url: string
}

export type PostShareResult = 'shared' | 'copied' | 'cancelled'
export type ShareMessageApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>

export async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const input = document.createElement('textarea')
  input.value = text
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.append(input)
  input.select()
  const copied = document.execCommand('copy')
  input.remove()
  if (!copied) throw new Error('Clipboard access is unavailable in this browser.')
}

export async function sharePostLink(details: PostShareDetails): Promise<PostShareResult> {
  if (navigator.share) {
    try {
      await navigator.share(details)
      return 'shared'
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return 'cancelled'
    }
  }
  await copyTextToClipboard(details.url)
  return 'copied'
}

export async function sendPostToConversation(
  conversationId: string,
  authorName: string,
  postUrl: string,
  request: ShareMessageApiRequest,
) {
  await request(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: `Check out this post by ${authorName}: ${postUrl}` }),
  })
}
