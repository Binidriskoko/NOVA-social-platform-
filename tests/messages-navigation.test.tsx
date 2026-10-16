import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { MessagesNavigation } from '../src/components/AppShell'

const messageTabs = [
  { label: 'Chats', path: '/messages' },
  { label: 'Updates', path: '/updates' },
  { label: 'Communities', path: '/communities' },
  { label: 'Calls', path: '/calls' },
]

describe('Messages navigation', () => {
  it.each(messageTabs)('links $label to $path and marks it active on its route', ({ label, path }) => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <MessagesNavigation />
      </MemoryRouter>,
    )
    const links = markup.match(/<a\b[^>]*>/g) ?? []
    const activeLink = links.find((link) => link.includes('aria-current="page"'))

    expect(markup).toContain('aria-label="Messages navigation"')
    for (const tab of messageTabs) {
      expect(markup).toContain(`href="${tab.path}"`)
      expect(markup).toContain(`<span>${tab.label}</span>`)
    }
    expect(activeLink).toContain(`href="${path}"`)
    expect(links.filter((link) => link.includes('aria-current="page"'))).toHaveLength(1)
  })
})
