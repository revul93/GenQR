import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { CLIENT_DIST_DIR, env } from './config.js';
import { dbClient } from './db/index.js';
import { errorHandler, HttpError } from './http.js';
import { originCheck, sessionMiddleware } from './auth/middleware.js';
import { getVersionInfo } from './services/system.js';
import { setupRouter } from './routes/setup.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { adminUsersRouter } from './routes/adminUsers.js';
import { adminSettingsRouter } from './routes/adminSettings.js';
import { qrRouter } from './routes/qr.js';
import { linksRouter } from './routes/links.js';
import { statsRouter } from './routes/stats.js';
import { shortRedirectRouter } from './routes/shortRedirect.js';

export function createApp(): express.Express {
  const app = express();
  app.set('trust proxy', env.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet());

  const api = express.Router();
  // Large enough for a logo upload sent as a data URL.
  api.use(express.json({ limit: '5mb' }));
  api.use(cookieParser());
  api.use(originCheck);
  api.use(sessionMiddleware);

  api.get('/health', async (_req, res) => {
    const { version, commit } = await getVersionInfo();
    res.json({ status: 'ok', version, commit, database: dbClient() });
  });
  api.use('/setup', setupRouter);
  api.use('/auth', authRouter);
  api.use('/qr', qrRouter);
  api.use(statsRouter); // /stats and /links/:id/stats
  api.use('/links', linksRouter);
  api.use('/admin/users', adminUsersRouter);
  api.use('/admin/settings', adminSettingsRouter);
  api.use('/admin', adminRouter);
  api.use(() => {
    throw new HttpError(404, 'Not found.');
  });
  app.use('/api', api);
  app.use('/short', shortRedirectRouter);

  // Built React app, with client-side routing fallback.
  if (fs.existsSync(CLIENT_DIST_DIR)) {
    app.use(express.static(CLIENT_DIST_DIR, { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(CLIENT_DIST_DIR, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
