import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'

// @testing-library/react's automatic cleanup only self-registers when it
// detects a global `afterEach` (i.e. when Vitest's `globals` option is on).
// This project imports test globals explicitly instead, so unmount each
// rendered tree ourselves between tests.
afterEach(() => {
  cleanup()
})
