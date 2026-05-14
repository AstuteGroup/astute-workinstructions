'use strict';

/**
 * Netlify static-site deploy helper.
 *
 * Uploads a local directory to a Netlify site via the public API — no
 * netlify-cli, no zip, no extra deps. Uses Node's built-in fetch + crypto.
 *
 * Flow:
 *   1. Walk the directory, sha1 each file.
 *   2. POST /sites/{site_id}/deploys with the {path: sha1} manifest.
 *      Netlify replies with a deploy id and a `required[]` list of sha1s
 *      whose contents it does NOT already have on disk.
 *   3. PUT the body of each required file to /deploys/{id}/files/<path>.
 *   4. Once every required file is uploaded Netlify auto-promotes the deploy.
 *
 * Usage:
 *   const { deployDirectory } = require('./netlify-deploy');
 *   const res = await deployDirectory({
 *     dir: '/path/to/site',
 *     siteId: process.env.NETLIFY_SITE_ID,
 *     token: process.env.NETLIFY_AUTH_TOKEN,
 *     title: 'stock-rfq-digest 2026-05-14T20Z',
 *   });
 *   console.log(res.url);
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const API_BASE = 'https://api.netlify.com/api/v1';

async function walkDir(dir, base) {
  base = base || dir;
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...await walkDir(full, base));
    } else if (e.isFile()) {
      // Netlify wants POSIX-style paths starting with /
      const rel = '/' + path.relative(base, full).split(path.sep).join('/');
      const buf = await fs.readFile(full);
      const sha = crypto.createHash('sha1').update(buf).digest('hex');
      out.push({ rel, full, buf, sha });
    }
  }
  return out;
}

async function deployDirectory({ dir, siteId, token, title }) {
  if (!siteId) throw new Error('netlify-deploy: siteId is required');
  if (!token)  throw new Error('netlify-deploy: token is required');

  const files = await walkDir(dir);
  if (files.length === 0) throw new Error(`netlify-deploy: no files found under ${dir}`);

  const manifest = {};
  for (const f of files) manifest[f.rel] = f.sha;

  // 1. Create deploy
  const createRes = await fetch(`${API_BASE}/sites/${siteId}/deploys`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: manifest,
      title: title || 'auto-deploy',
      async: false,
    }),
  });
  if (!createRes.ok) {
    const txt = await createRes.text();
    throw new Error(`Netlify deploy create failed (${createRes.status}): ${txt}`);
  }
  const deploy = await createRes.json();
  const required = new Set(deploy.required || []);

  // 2. Upload required files (de-dup by sha — if two files share a hash,
  //    only one needs to be uploaded).
  const uploadedShas = new Set();
  for (const f of files) {
    if (!required.has(f.sha)) continue;
    if (uploadedShas.has(f.sha)) continue;
    const uploadRes = await fetch(`${API_BASE}/deploys/${deploy.id}/files${f.rel}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: f.buf,
    });
    if (!uploadRes.ok) {
      const txt = await uploadRes.text();
      throw new Error(`Netlify upload ${f.rel} failed (${uploadRes.status}): ${txt}`);
    }
    uploadedShas.add(f.sha);
  }

  return {
    deployId: deploy.id,
    state: deploy.state,
    url: deploy.deploy_ssl_url || deploy.ssl_url || deploy.url,
    siteUrl: deploy.ssl_url || deploy.url,
    fileCount: files.length,
    uploadedCount: uploadedShas.size,
  };
}

module.exports = { deployDirectory };
