import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { HttpError, parseBody } from '../http.js';
import { requireAuth } from '../auth/middleware.js';
import { getLink } from '../services/shortLinks.js';
import { clicksCsv, computeStats, rangeFor, scopeFor, type Scope } from '../services/stats.js';

export const statsRouter = Router();

const rangeQuery = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(30),
  tz: z.coerce.number().int().min(-900).max(900).default(0), // Date.getTimezoneOffset()
  all: z.enum(['0', '1']).optional(),
});

async function linkScope(req: Request): Promise<Scope> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id.');
  await getLink(id, req.user!); // ownership check
  return { kind: 'link', linkId: id };
}

async function sendCsv(res: Response, scope: Scope, days: number, tz: number, name: string) {
  const csv = await clicksCsv(scope, rangeFor(days, tz));
  res.attachment(`${name}-clicks-last-${days}-days.csv`).type('text/csv; charset=utf-8').send(csv);
}

/** Dashboard: the caller's links, or every link for admins with all=1. */
statsRouter.get('/stats', requireAuth, async (req, res) => {
  const { days, tz, all } = parseBody(rangeQuery, req.query);
  res.json(await computeStats(scopeFor(req.user!, all === '1'), rangeFor(days, tz)));
});

statsRouter.get('/stats/clicks.csv', requireAuth, async (req, res) => {
  const { days, tz, all } = parseBody(rangeQuery, req.query);
  await sendCsv(res, scopeFor(req.user!, all === '1'), days, tz, all === '1' ? 'all-links' : 'my-links');
});

statsRouter.get('/links/:id/stats', requireAuth, async (req, res) => {
  const { days, tz } = parseBody(rangeQuery, req.query);
  res.json(await computeStats(await linkScope(req), rangeFor(days, tz)));
});

statsRouter.get('/links/:id/clicks.csv', requireAuth, async (req, res) => {
  const { days, tz } = parseBody(rangeQuery, req.query);
  const link = await getLink(Number(req.params.id), req.user!);
  await sendCsv(res, await linkScope(req), days, tz, `link-${link.code}`);
});
