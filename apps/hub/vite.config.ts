import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const lessonsLearnedUnavailablePage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Lessons Learned unavailable | PMO Hub</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #1d3458; background: #f3f6fb; }
      body { display: grid; min-height: 100vh; place-items: center; margin: 0; padding: 24px; box-sizing: border-box; }
      main { width: min(100%, 520px); padding: 36px; background: white; border: 1px solid #e1e8f2; border-radius: 16px; box-shadow: 0 18px 50px #1d34581c; }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { margin: 0 0 24px; color: #52627b; line-height: 1.6; }
      a { display: inline-flex; min-height: 44px; align-items: center; padding: 0 17px; border-radius: 9px; color: white; background: #315cbb; font-weight: 650; text-decoration: none; }
      a:focus-visible { outline: 3px solid #315cbb; outline-offset: 3px; }
    </style>
  </head>
  <body>
    <main>
      <p>PMO Hub</p>
      <h1>Lessons Learned is unavailable</h1>
      <p>The Lessons Learned screen could not be opened because its frontend did not respond successfully. Try again later or return to the module catalog.</p>
      <a href="/">Return to PMO Hub</a>
    </main>
  </body>
</html>`;

function normalizeLessonsLearnedRoot(path: string): string {
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  return pathname === '/lessons-learned'
    ? `/lessons-learned/${queryIndex === -1 ? '' : path.slice(queryIndex)}`
    : path;
}

function isHtmlNavigation(request: import('node:http').IncomingMessage): boolean {
  const fetchDestination = request.headers['sec-fetch-dest'];
  return request.method === 'GET' &&
    request.headers.accept?.includes('text/html') === true &&
    (fetchDestination === undefined || fetchDestination === 'document');
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '^/api/lessons-learned(?:/|\\?|$)': {
        target: process.env.LESSONS_LEARNED_API_TARGET ?? 'http://127.0.0.1:3002',
        changeOrigin: true,
      },
      '^/lessons-learned(?:/|\\?|$)': {
        target: process.env.LESSONS_LEARNED_FRONTEND_TARGET ?? 'http://127.0.0.1:5174',
        changeOrigin: true,
        ws: true,
        rewrite: normalizeLessonsLearnedRoot,
        configure(proxy) {
          proxy.on('proxyRes', (proxyResponse, request, response) => {
            const status = proxyResponse.statusCode ?? 0;
            const isModuleEntry = /^\/lessons-learned\/?(?:\?|$)/.test(request.url ?? '');
            const isUnavailable = status === 404 || status >= 500 || (isModuleEntry && status >= 400);
            if (!isUnavailable || !isHtmlNavigation(request)) return;

            proxyResponse.resume();
            response.writeHead(503, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
            });
            response.end(lessonsLearnedUnavailablePage);
          });

          proxy.on('error', (_error, request, response) => {
            if (!('writeHead' in response) || response.headersSent) {
              response.destroy();
              return;
            }

            if (isHtmlNavigation(request)) {
              response.writeHead(503, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
              });
              response.end(lessonsLearnedUnavailablePage);
              return;
            }

            response.writeHead(503, {
              'content-type': 'text/plain; charset=utf-8',
              'cache-control': 'no-store',
            });
            response.end('Lessons Learned frontend is unavailable.');
          });
        },
      },
      '/api': {
        target: process.env.HUB_API_TARGET ?? 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  test: {
    include: ['tests/**/*.test.tsx'],
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    restoreMocks: true,
  },
});
