import { useNavigate } from 'react-router-dom'
import { PostComposer } from '../components/PostComposer'

export function CreatePage() {
  const navigate = useNavigate()
  return <PostComposer onClose={() => navigate('/')} onPublished={() => navigate('/')} />
}
