import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import App from './App.js'
import { AuthProvider } from './features/auth/AuthProvider.js'
import { createQueryClient } from './lib/queryClient.js'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found in index.html')

// One client for the process lifetime. AuthProvider sits inside it because the
// signed-in user is itself a query, and clearing the cache on sign-out is how
// one user's data is kept off the next user's screen on a shared machine.
const queryClient = createQueryClient()

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
