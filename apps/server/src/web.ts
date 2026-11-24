import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express } from 'express';
import helmet from 'helmet';

/** One HTTP entry serves the built frontend and API; Vite remains optional in development. */
export function installWeb(app: Express, directory: string, required = false) {
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameSrc: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: null,
        },
      },
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'same-origin' },
    }),
  );
  const index = join(directory, 'index.html');
  if (!existsSync(index)) {
    if (required) throw new Error('前端构建文件缺失，请使用完整应用镜像');
    return;
  }
  const files = express.static(directory, {
    index: false,
    redirect: false,
    dotfiles: 'deny',
    setHeaders(response, filename) {
      response.setHeader(
        'Cache-Control',
        /[/\\]assets[/\\][^/\\]+-[\w-]{8,}\.[\w.]+$/.test(filename)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      );
    },
  });
  app.use((request, response, next) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(request.path);
    } catch {
      response.status(400).end();
      return;
    }
    // Never let a missing API endpoint become a successful HTML response.
    if (pathname === '/api' || pathname.startsWith('/api/')) return next();
    if (
      pathname.includes('\\') ||
      pathname.includes('\0') ||
      pathname.split('/').some((part) => part.startsWith('.'))
    ) {
      response.status(404).end();
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) return next();
    files(request, response, (error) => {
      if (error) return next(error);
      // Real files and missing assets must not be disguised as SPA documents.
      if (pathname.startsWith('/assets/') || /\.[^/]+$/.test(pathname)) {
        response.status(404).end();
        return;
      }
      if (!request.accepts('html')) return next();
      response.setHeader('Cache-Control', 'no-cache');
      response.sendFile(index);
    });
  });
}
