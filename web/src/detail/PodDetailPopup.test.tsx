import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEventSource } from '../test-support/fakeEventSource'
import { makeContainerDetail, makePodDetail } from '../test-support/sceneFixtures'
import { PodDetailPopup } from './PodDetailPopup'

const podDetail = makePodDetail({
  restartCount: 3,
  containers: [makeContainerDetail({ restartCount: 3 })],
  events: [
    {
      type: 'Warning',
      reason: 'BackOff',
      message: 'restarting failed container',
      count: 5,
      lastSeen: '',
    },
  ],
})

beforeEach(() => {
  FakeEventSource.reset()
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(podDetail), { status: 200 })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PodDetailPopup', () => {
  it('renders the pod detail and a recent event once loaded', async () => {
    render(<PodDetailPopup namespace="team" pod="web-1" onClose={() => {}} />)

    await screen.findByText('Running')
    const popup = screen.getByTestId('detail-popup')
    expect(popup).toHaveTextContent('web-1')
    expect(popup).toHaveTextContent('Running')
    expect(popup).toHaveTextContent('1/1 ready')
    expect(popup).toHaveTextContent('BackOff')
  })

  it('opens the log-tail SSE stream and renders streamed lines (height-limited)', async () => {
    render(<PodDetailPopup namespace="team" pod="web-1" onClose={() => {}} />)
    await screen.findByText('Running')

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].url).toContain('/api/pods/team/web-1/logtail')

    act(() =>
      FakeEventSource.instances[0].emit(JSON.stringify({ lines: ['boot', 'ready', 'serving'] })),
    )

    const tail = screen.getByTestId('log-tail')
    expect(tail).toHaveAttribute('data-line-count', '3')
    expect(tail).toHaveTextContent('serving')
  })

  it('closes the log-tail stream on unmount (cancels the server-side follow)', async () => {
    const { unmount } = render(<PodDetailPopup namespace="team" pod="web-1" onClose={() => {}} />)
    await screen.findByText('Running')

    unmount()

    expect(FakeEventSource.instances[0].closed).toBe(true)
  })

  it('is read-only: its only control is the close button', async () => {
    const onClose = vi.fn()
    render(<PodDetailPopup namespace="team" pod="web-1" onClose={onClose} />)
    await screen.findByText('Running')

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
