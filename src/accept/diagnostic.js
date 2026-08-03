// Bounded HTML dumps so we can tune Accept Order / Accept Appraisal markup
// against the real portal without guessing. Cap keeps disk use finite.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_DUMPS = Number(process.env.ACCEPT_DIAGNOSTIC_MAX || 30);
const DIR = process.env.ACCEPT_DIAGNOSTIC_DIR || './data/accept-diagnostic';

let dumps = 0;

/**
 * @param {object} opts
 * @param {string} [opts.orderId]
 * @param {string} opts.stage  e.g. 'email_confirm_page' | 'portal_post_accept'
 * @param {string} [opts.html]
 * @param {string} [opts.url]
 */
export async function dumpAcceptDiagnostic({ orderId, stage, html, url }) {
  if (process.env.ACCEPT_DIAGNOSTIC === '0') return;
  if (dumps >= MAX_DUMPS) return;
  const body = html || '';
  if (!body) return;
  dumps += 1;
  try {
    await mkdir(DIR, { recursive: true });
    const safeId = String(orderId || 'unknown').replace(/[^\w.-]+/g, '_').slice(0, 64);
    const safeStage = String(stage || 'page').replace(/[^\w.-]+/g, '_').slice(0, 48);
    const path = join(DIR, `${Date.now()}_${safeId}_${safeStage}.html`);
    const header = `<!-- url=${String(url || '').slice(0, 500)} stage=${safeStage} orderId=${safeId} -->\n`;
    await writeFile(path, header + body.slice(0, 500_000), 'utf8');
  } catch {
    /* never break the accept hot path for diagnostics */
  }
}
