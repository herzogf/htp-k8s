import { getWebSocketUrl } from './config'
import { useSceneState } from './hooks/useSceneState'
import { Scene } from './Scene'

function App() {
  const sceneState = useSceneState(getWebSocketUrl())

  return <Scene sceneState={sceneState} />
}

export default App
