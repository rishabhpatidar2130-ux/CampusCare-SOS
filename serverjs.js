/*
 * CampusCare SOS Reference Server — LPU Campus Healthcare Dispatch Network
 *
 * This server securely coordinates student emergency alerts, real-time GPS
 * telemetry, and hospital dispatcher authorization.
 */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = path.join(ROOT, 'data');
const INCIDENTS_FILE = path.join(DATA_DIR, 'incidents.json');
const LOCATIONS_FILE = path.join(ROOT, 'locations.json');
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'campuscare2026';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_SECONDS = 8 * 60 * 60;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const DISPATCH_WEBHOOK_URL = process.env.DISPATCH_WEBHOOK_URL || '';
const DISPATCH_WEBHOOK_SECRET = process.env.DISPATCH_WEBHOOK_SECRET || '';
const FORCE_SECURE_COOKIES = process.env.FORCE_SECURE_COOKIES === 'true';

let locations = [];
let incidents = [];
let writeInFlight = Promise.resolve();
const staffStreams = new Set();
const loginAttempts = new Map();
const incidentAttempts = new Map();

function now() {
  return new Date().toISOString();
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(body));
}

function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').map(item => {
    const index = item.indexOf('=');
    return index < 0 ? [] : [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1).trim())];
  }).filter(pair => pair.length));
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function makeSession() {
  const payload = Buffer.from(JSON.stringify({ role: 'dispatcher', exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, nonce: crypto.randomUUID() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSession(request) {
  const token = parseCookies(request).campuscare_session;
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed.role === 'dispatcher' && parsed.exp > Math.floor(Date.now() / 1000) ? parsed : null;
  } catch {
    return null;
  }
}

function isStaff(request) {
  return Boolean(readSession(request));
}

function setSessionCookie(res, value) {
  const secure = FORCE_SECURE_COOKIES || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `campuscare_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'campuscare_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function clientIp(request) {
  return (request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
}

function isRateLimited(store, key, limit, windowMs) {
  const cutoff = Date.now() - windowMs;
  const values = (store.get(key) || []).filter(value => value > cutoff);
  values.push(Date.now());
  store.set(key, values);
  return values.length > limit;
}

function sanitizeText(value, limit = 160) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 20_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON');
  }
}

async function loadState() {
  const loadedLocations = JSON.parse(await fs.readFile(LOCATIONS_FILE, 'utf8'));
  if (!Array.isArray(loadedLocations) || !loadedLocations.every(location => location.id && location.name)) {
    throw new Error('locations.json must be an array with id and name for every location.');
  }
  locations = loadedLocations;
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    incidents = JSON.parse(await fs.readFile(INCIDENTS_FILE, 'utf8'));
    if (!Array.isArray(incidents)) incidents = [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    incidents = [];
    await fs.writeFile(INCIDENTS_FILE, '[]\n', 'utf8');
  }
  purgeExpiredIncidents();
}

function purgeExpiredIncidents() {
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  const previousLength = incidents.length;
  incidents = incidents.filter(incident => {
    const isClosed = ['resolved', 'cancelled'].includes(incident.status);
    return !isClosed || new Date(incident.updatedAt).getTime() > cutoff;
  });
  if (incidents.length !== previousLength) persist();
}

function persist() {
  const serialized = `${JSON.stringify(incidents, null, 2)}\n`;
  writeInFlight = writeInFlight
    .catch(() => undefined)
    .then(async () => {
      const temporary = `${INCIDENTS_FILE}.${process.pid}.tmp`;
      await fs.writeFile(temporary, serialized, 'utf8');
      await fs.rename(temporary, INCIDENTS_FILE);
    });
  return writeInFlight;
}

function publish() {
  const message = `event: incidents\ndata: ${JSON.stringify({ changedAt: now() })}\n\n`;
  for (const stream of staffStreams) stream.write(message);
}

function publicLocations() {
  return locations.map(({ id, name, category, landmark, verified }) => ({ id, name, category, landmark, verified: Boolean(verified) }));
}

function findLocation(id) {
  return locations.find(location => location.id === id);
}

function safeEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicIncident(incident) {
  return {
    id: incident.id,
    status: incident.status,
    location: incident.locationName,
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
    message: incident.status === 'dispatched' ? 'A dispatcher reports that a response vehicle has been assigned.' : undefined
  };
}

function staffIncident(incident) {
  const { publicToken, ...visible } = incident;
  return visible;
}

async function notifyDispatcherWebhook(incident) {
  if (!DISPATCH_WEBHOOK_URL) return;
  let target;
  try {
    target = new URL(DISPATCH_WEBHOOK_URL);
    if (target.protocol !== 'https:') throw new Error('Dispatch webhook must use HTTPS');
  } catch (error) {
    console.error(`Dispatch webhook not called: ${error.message}`);
    return;
  }
  const payload = JSON.stringify({ event: 'manual_ambulance_dispatch', incident: staffIncident(incident) });
  const signature = DISPATCH_WEBHOOK_SECRET ? crypto.createHmac('sha256', DISPATCH_WEBHOOK_SECRET).update(payload).digest('hex') : '';
  try {
    await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-CampusCare-Signature': `sha256=${signature}` } : {}) },
      body: payload,
      signal: AbortSignal.timeout(7000)
    });
  } catch (error) {
    console.error(`Dispatch webhook delivery failed for ${incident.id}: ${error.message}`);
  }
}

async function handleApi(request, response, url) {
  const method = request.method || 'GET';
  const pathname = url.pathname;

  if (pathname === '/api/health' && method === 'GET') return json(response, 200, { ok: true, time: now() });
  if (pathname === '/api/config' && method === 'GET') {
    return json(response, 200, {
      publicBaseUrl: PUBLIC_BASE_URL,
      emergencyPhone: '112',
      emergencyTel: '112',
      campusPhone: '01824-501227',
      hotlineName: 'National Emergency Service (112) / LPU Health Centre'
    });
  }
  if (pathname === '/api/locations' && method === 'GET') return json(response, 200, { locations: publicLocations() });

  if (pathname === '/api/auth/login' && method === 'POST') {
    const ip = clientIp(request);
    const cutoff = Date.now() - (15 * 60 * 1000);
    const failures = (loginAttempts.get(ip) || []).filter(value => value > cutoff);
    loginAttempts.set(ip, failures);
    if (failures.length >= 8) return json(response, 429, { error: 'Too many login attempts. Try again in 15 minutes.' });
    const body = await readBody(request);
    if (!safeEqual(sanitizeText(body.password, 256), DASHBOARD_PASSWORD)) {
      failures.push(Date.now());
      loginAttempts.set(ip, failures);
      return json(response, 401, { error: 'Incorrect dispatcher password.' });
    }
    loginAttempts.delete(ip);
    setSessionCookie(response, makeSession());
    return json(response, 200, { ok: true });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    clearSessionCookie(response);
    return json(response, 200, { ok: true });
  }

  if (pathname === '/api/events' && method === 'GET') {
    if (!isStaff(request)) return json(response, 401, { error: 'Staff login required.' });
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.write('event: connected\ndata: {}\n\n');
    staffStreams.add(response);
    request.on('close', () => staffStreams.delete(response));
    return;
  }

  if (pathname === '/api/incidents' && method === 'POST') {
    const ip = clientIp(request);
    if (isRateLimited(incidentAttempts, ip, 10, 5 * 60 * 1000)) {
      return json(response, 429, { error: 'Rate limit exceeded. Call 01824-501227 immediately for urgent assistance.' });
    }
    const body = await readBody(request);
    const location = findLocation(sanitizeText(body.locationId, 80));
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const accuracy = Number(body.accuracy);
    if (!location) {
      return json(response, 400, { error: 'This QR location is not registered in the campus catalog.' });
    }
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return json(response, 400, { error: 'A valid GPS latitude/longitude is required to dispatch an emergency responder.' });
    }
    if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10_000) {
      return json(response, 400, { error: 'Valid GPS accuracy radius is required.' });
    }
    const incident = {
      id: `SOS-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      publicToken: crypto.randomBytes(18).toString('hex'),
      status: 'new',
      locationId: location.id,
      locationName: location.name,
      locationLandmark: location.landmark || '',
      latitude: Number(latitude.toFixed(6)),
      longitude: Number(longitude.toFixed(6)),
      accuracy: Math.round(accuracy),
      symptom: sanitizeText(body.symptom, 120) || 'Medical emergency',
      urgency: ['critical', 'high', 'standard'].includes(body.urgency) ? body.urgency : 'high',
      landmark: sanitizeText(body.landmark, 160),
      callbackPhone: sanitizeText(body.callbackPhone, 32),
      createdAt: now(),
      updatedAt: now(),
      audit: [{ at: now(), action: 'created', actor: 'student' }]
    };
    incidents.unshift(incident);
    await persist();
    publish();
    return json(response, 201, { incident: publicIncident(incident), token: incident.publicToken, full: staffIncident(incident) });
  }

  const publicStatusMatch = pathname.match(/^\/api\/incidents\/(SOS-[A-F0-9-]+)\/status$/);
  if (publicStatusMatch && method === 'GET') {
    const incident = incidents.find(item => item.id === publicStatusMatch[1]);
    if (!incident || !safeEqual(incident.publicToken, url.searchParams.get('token') || '')) return json(response, 404, { error: 'SOS request not found.' });
    return json(response, 200, { incident: publicIncident(incident), details: staffIncident(incident) });
  }

  const publicCancelMatch = pathname.match(/^\/api\/incidents\/(SOS-[A-F0-9-]+)\/cancel$/);
  if (publicCancelMatch && method === 'POST') {
    const incident = incidents.find(item => item.id === publicCancelMatch[1]);
    const body = await readBody(request);
    if (!incident || !safeEqual(incident.publicToken, body.token || '')) return json(response, 404, { error: 'SOS request not found.' });
    if (!['new', 'acknowledged'].includes(incident.status)) return json(response, 409, { error: 'Ambulance is already dispatched. Please call 01824-501227 directly.' });
    incident.status = 'cancelled';
    incident.updatedAt = now();
    incident.audit.push({ at: now(), action: 'cancelled', actor: 'student' });
    await persist();
    publish();
    return json(response, 200, { incident: publicIncident(incident) });
  }

  if (pathname === '/api/incidents' && method === 'GET') {
    if (!isStaff(request)) return json(response, 401, { error: 'Staff login required.' });
    const activeOnly = url.searchParams.get('includeClosed') !== 'true';
    const results = incidents.filter(incident => !activeOnly || !['resolved', 'cancelled'].includes(incident.status));
    return json(response, 200, { incidents: results.map(staffIncident) });
  }

  const staffActionMatch = pathname.match(/^\/api\/incidents\/(SOS-[A-F0-9-]+)$/);
  if (staffActionMatch && method === 'PATCH') {
    if (!isStaff(request)) return json(response, 401, { error: 'Staff login required.' });
    const body = await readBody(request);
    const incident = incidents.find(item => item.id === staffActionMatch[1]);
    if (!incident) return json(response, 404, { error: 'Incident not found.' });
    const action = body.action;
    if (action === 'acknowledge' && incident.status === 'new') {
      incident.status = 'acknowledged';
      incident.dispatchNote = sanitizeText(body.note, 160) || 'Dispatcher acknowledgement recorded.';
    } else if (action === 'dispatch' && ['new', 'acknowledged'].includes(incident.status)) {
      incident.status = 'dispatched';
      incident.vehicle = sanitizeText(body.vehicle, 80) || 'Campus Response Ambulance';
      const eta = Number(body.etaMinutes);
      incident.etaMinutes = Number.isFinite(eta) && eta >= 0 && eta <= 180 ? Math.round(eta) : 3;
      incident.dispatchNote = sanitizeText(body.note, 160) || 'Response vehicle en route.';
    } else if (action === 'on-scene' && ['new', 'acknowledged', 'dispatched'].includes(incident.status)) {
      incident.status = 'on-scene';
      incident.dispatchNote = sanitizeText(body.note, 160) || 'Paramedic team arrived on scene. Care active.';
    } else if (action === 'resolve' && ['new', 'acknowledged', 'dispatched', 'on-scene'].includes(incident.status)) {
      incident.status = 'resolved';
      incident.resolutionNote = sanitizeText(body.note, 160) || 'Patient assisted and incident resolved.';
    } else {
      return json(response, 409, { error: 'That action is not available for the current incident status.' });
    }
    incident.updatedAt = now();
    incident.audit.push({ at: now(), action, actor: 'dispatcher' });
    await persist();
    publish();
    if (action === 'dispatch') void notifyDispatcherWebhook(incident);
    return json(response, 200, { incident: staffIncident(incident) });
  }

  return json(response, 404, { error: 'API route not found.' });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const ALLOWED_FILES = new Set([
  '/',
  '/index.html',
  '/sos.html',
  '/dashboard.html',
  '/qr.html',
  '/styles.css',
  '/sos.js',
  '/dashboard.js',
  '/qr.js',
  '/locations.json'
]);

async function serveStatic(request, response, url) {
  let relative = decodeURIComponent(url.pathname);
  if (relative === '/' || relative === '') relative = '/index.html';
  if (!ALLOWED_FILES.has(relative)) return text(response, 404, 'Not found');
  const filePath = path.join(ROOT, relative);
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(content);
  } catch (err) {
    text(response, 404, 'File not found');
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else await serveStatic(request, response, url);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) {
      json(response, 500, { error: error.message || 'Server error' });
    } else {
      response.end();
    }
  }
});

async function start() {
  await loadState();
  if (!process.env.DASHBOARD_PASSWORD) {
    console.log(`[DEV MODE] Default dispatcher password is set to: "${DASHBOARD_PASSWORD}"`);
  }
  server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚑 CampusCare SOS Server active on: http://localhost:${PORT}`);
    console.log(`   - Unified Portal:    http://localhost:${PORT}/index.html`);
    console.log(`   - Student SOS:       http://localhost:${PORT}/sos.html?location=uni-mall`);
    console.log(`   - Staff Dashboard:   http://localhost:${PORT}/dashboard.html`);
    console.log(`   - QR Generator:      http://localhost:${PORT}/qr.html`);
    console.log(`======================================================\n`);
  });
}

if (require.main === module) {
  start().catch(error => { console.error(error.message); process.exit(1); });
}

module.exports = { server, loadState };
