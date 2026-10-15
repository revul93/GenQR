import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { resolveCode } from '../services/shortLinks.js';
import { recordClick } from '../services/clicks.js';

/** Public redirector: GET /short/<code>. */
export const shortRedirectRouter = Router();

shortRedirectRouter.use(rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));

const MESSAGES = {
  missing: ['Link not found', 'This link does not exist. Check that it was typed correctly.'],
  disabled: ['Link not available', 'This link has been switched off by its owner.'],
  expired: ['Link expired', 'This link is no longer active.'],
} as const;

function unavailablePage(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f6f8;color:#1f2933}
main{background:#fff;padding:2.5rem 2rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:420px;margin:1rem;text-align:center}
h1{font-size:1.4rem;margin:.5rem 0}p{color:#52606d;line-height:1.5}svg{color:#0b5394}
</style></head><body><main>
<svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 3h8v8H3zm2 2v4h4V5zm8-2h8v8h-8zm2 2v4h4V5zM3 13h8v8H3zm2 2v4h4v-4zm13-2h3v2h-3zm-5 0h3v3h-3zm3 3h2v3h-2zm2 3h3v2h-3zm-5 0h3v2h-3z"/></svg>
<h1>${title}</h1><p>${text}</p></main></body></html>`;
}

shortRedirectRouter.get('/:code', async (req, res) => {
  const result = await resolveCode(req.params.code);
  // Never let browsers or proxies cache a redirect: targets can change at any time.
  res.set('Cache-Control', 'no-store');
  if (result.status !== 'ok') {
    const [title, text] = MESSAGES[result.status];
    res.status(result.status === 'missing' ? 404 : 410).type('html').send(unavailablePage(title, text));
    return;
  }
  res.redirect(302, result.target);
  // Logged after responding so the redirect is never slowed down. HEAD requests are
  // link-preview probes, not visits.
  if (req.method === 'GET') void recordClick(result.linkId, req);
});
