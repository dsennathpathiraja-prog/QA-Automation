import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createApiClient } from './api/client';
import { ApiProvider } from './api/context';
import { browserNavigator, loginUrl } from './auth/session';
import { buildRouter } from './router';
import './styles.css';

const client = createApiClient({ onUnauthenticated: () => browserNavigator.assign(loginUrl(browserNavigator.currentPath())) });
const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });
const router = buildRouter();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApiProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiProvider>
  </StrictMode>,
);
