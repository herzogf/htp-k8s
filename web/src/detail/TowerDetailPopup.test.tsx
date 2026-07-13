import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type TowerDetail } from '../generated/scenestate'
import { makeTowerDetail } from '../test-support/sceneFixtures'
import { TowerDetailPopup } from './TowerDetailPopup'

const nodeDetail = makeTowerDetail()

function stubFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TowerDetailPopup', () => {
  it('renders the Node summary once loaded', async () => {
    stubFetch(nodeDetail)

    render(<TowerDetailPopup name="node-a" onClose={() => {}} />)

    await screen.findByText('Ready')
    const popup = screen.getByTestId('detail-popup')
    expect(popup).toHaveTextContent('Node')
    expect(popup).toHaveTextContent('node-a')
    expect(popup).toHaveTextContent('Ready')
    expect(popup).toHaveTextContent('linux / amd64')
  })

  it('shows a degraded message when the summary is absent (ADR-0002)', async () => {
    stubFetch({ name: 'node-a', kind: 'node' } satisfies TowerDetail)

    render(<TowerDetailPopup name="node-a" onClose={() => {}} />)

    await screen.findByText(/not available/i)
  })

  it('shows an unavailable message when the request fails', async () => {
    stubFetch('boom', 500)

    render(<TowerDetailPopup name="node-a" onClose={() => {}} />)

    await screen.findByText(/unavailable/i)
  })

  it('is read-only: its only control is the close button', async () => {
    stubFetch(nodeDetail)
    const onClose = vi.fn()

    render(<TowerDetailPopup name="node-a" onClose={onClose} />)
    await screen.findByText('Ready')

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('refetches for a different tower', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(
      async () => new Response(JSON.stringify(nodeDetail), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = render(<TowerDetailPopup name="node-a" onClose={() => {}} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    rerender(<TowerDetailPopup name="node-b" onClose={() => {}} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1][0]).toContain('/api/towers/node-b')
  })
})
