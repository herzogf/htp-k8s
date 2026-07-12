import { getWebSocketUrl } from './config'
import { useWebSocketMessage } from './hooks/useWebSocketMessage'
import { Scene } from './Scene'

function App() {
  const message = useWebSocketMessage(getWebSocketUrl())

  return <Scene message={message} />
}

export default App
