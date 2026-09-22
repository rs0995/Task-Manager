const fs = require('fs');

function normalizeDriveScriptUrl(value) {
  const input = String(value || '').trim();
  const extracted = input.match(/https:\/\/script\.google\.com\/macros\/s\/[^\s"',;<>]+(?:\/exec)?/i)?.[0] || input;
  const raw = extracted.trim().replace(/\/$/, '');
  if (!raw) return '';
  if (/^https:\/\/script\.google\.com\/macros\/s\/[^/]+$/i.test(raw)) {
    return `${raw}/exec`;
  }
  return raw;
}

function buildUrl(scriptUrl, params = {}) {
  const normalized = normalizeDriveScriptUrl(scriptUrl);
  if (!normalized) throw new Error('Google Apps Script URL is required.');
  const url = new URL(normalized);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function appsScriptErrorFromResponse(text, status) {
  const body = String(text || '');
  if (/accounts\.google\.com\/v3\/signin|<title>\s*Sign in\s*-\s*Google Accounts/i.test(body)) {
    return 'Google Apps Script requires sign-in. Redeploy the Web App with "Execute as: Me" and "Who has access: Anyone", then use the /exec URL.';
  }
  if (/<!doctype html|<html[\s>]/i.test(body)) {
    return 'Google Apps Script returned an HTML page instead of JSON. Check that you are using the deployed Web App /exec URL and that access is set to Anyone.';
  }
  return body.slice(0, 180).replace(/\s+/g, ' ').trim() || `Apps Script request failed: ${status}`;
}

async function appsScriptGet(scriptUrl, token, action, params = {}) {
  const response = await fetch(buildUrl(scriptUrl, { action, token, ...params }));
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || appsScriptErrorFromResponse(text, response.status));
  }
  return data;
}

async function appsScriptPost(scriptUrl, token, payload = {}) {
  const response = await fetch(normalizeDriveScriptUrl(scriptUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, token }),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || appsScriptErrorFromResponse(text, response.status));
  }
  return data;
}

function decodeBase64ToFile(base64, filePath) {
  fs.writeFileSync(filePath, Buffer.from(String(base64 || ''), 'base64'));
}

function readFileBase64(filePath) {
  return fs.readFileSync(filePath).toString('base64');
}

module.exports = {
  normalizeDriveScriptUrl,
  appsScriptGet,
  appsScriptPost,
  decodeBase64ToFile,
  readFileBase64,
};
