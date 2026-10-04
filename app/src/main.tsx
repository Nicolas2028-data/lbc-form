import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './i18n';
import './index.css';
import './theme-neon.css';
import App from './App';
import { AuthProvider } from './auth';
import { BusinessError } from './lib/rpc';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 通信エラーは指数バックオフで 3 回まで自動リトライ。業務エラーはリトライしない
      retry: (count, error) => !(error instanceof BusinessError) && count < 3,
      retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4000),
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
