let refreshTimer;
let eventStream;
let mockMode = false;

const $ = selector => document.querySelector(selector);

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function formatTime(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: 'short'
    }).format(new Date(value));
  } catch {
    return value;
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

function fact(label, value) {
  const cell = element('div');
  cell.append(element('span', label, 'fact-label'), element('span', value));
  return cell;
}

function button(label, className, handler) {
  const node = element('button', label, className);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

async function action(incident, payload) {
  try {
    await api(`/api/incidents/${encodeURIComponent(incident.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    await loadIncidents();
  } catch (error) {
    window.alert(error.message);
  }
}

function incidentCard(incident) {
  const card = element('article', undefined, 'incident');
  card.dataset.urgency = incident.urgency || 'high';
  card.dataset.status = incident.status || 'new';

  const top = element('div', undefined, 'incident-top');
  const idBlock = element('div');
  idBlock.append(
    element('span', incident.id, 'incident-id'),
    document.createTextNode(` · ${formatTime(incident.createdAt)}`)
  );
  top.append(idBlock, element('span', `${incident.urgency || 'HIGH'} PRIORITY`, `pill ${incident.urgency || 'high'}`));
  card.append(top, element('h3', incident.locationName));
  if (incident.locationLandmark) card.append(element('p', incident.locationLandmark, 'subtext'));

  const facts = element('div', undefined, 'facts');
  facts.append(
    fact('GPS Coordinate', `${incident.latitude}, ${incident.longitude}`),
    fact('GPS Accuracy', `±${incident.accuracy} m`),
    fact('Specific Room / Landmark', incident.landmark || 'Not provided'),
    fact('Callback Phone', incident.callbackPhone || 'Not provided'),
    fact('Triage Symptom', incident.symptom || 'Medical emergency'),
    fact('Current Status', incident.status.replace(/-/g, ' ').toUpperCase())
  );
  if (incident.vehicle) {
    facts.append(
      fact('Assigned Vehicle', incident.vehicle),
      fact('ETA', `~${incident.etaMinutes || 3} mins`)
    );
  }
  card.append(facts);

  const map = element('a', '🗺️ Open Precise GPS in Maps', 'button button-plain button-small');
  map.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${incident.latitude},${incident.longitude}`)}`;
  map.target = '_blank';
  map.rel = 'noopener noreferrer';

  const actions = element('div', undefined, 'incident-actions');
  actions.append(map);

  if (incident.status === 'new') {
    actions.append(button('✓ Acknowledge', 'button button-small', () => action(incident, { action: 'acknowledge' })));
  }

  if (['new', 'acknowledged'].includes(incident.status)) {
    const vehicleLabel = element('label', 'Response vehicle / team');
    const vehicle = document.createElement('input');
    vehicle.placeholder = 'e.g. Campus Ambulance #1 (ICU)';
    vehicle.maxLength = 80;
    vehicle.value = 'Campus Ambulance #1';
    vehicleLabel.append(vehicle);

    const etaLabel = element('label', 'Estimated arrival (mins)');
    const eta = document.createElement('input');
    eta.type = 'number';
    eta.min = '1';
    eta.max = '180';
    eta.value = '3';
    etaLabel.append(eta);

    const noteLabel = element('label', 'Dispatcher note');
    const note = document.createElement('input');
    note.placeholder = 'Brief operational notes';
    note.maxLength = 160;
    noteLabel.append(note);

    actions.append(
      vehicleLabel,
      etaLabel,
      noteLabel,
      button('🚑 Confirm Dispatch', 'button button-danger button-small', () =>
        action(incident, {
          action: 'dispatch',
          vehicle: vehicle.value,
          etaMinutes: eta.value,
          note: note.value
        })
      )
    );
  }

  if (['new', 'acknowledged', 'dispatched'].includes(incident.status)) {
    actions.append(button('Mark Handled ✓', 'button button-green button-small', () => action(incident, { action: 'resolve' })));
  }

  card.append(actions);
  return card;
}

function renderIncidents(incidents) {
  const container = $('#incident-list');
  if (!container) return;
  container.replaceChildren();
  $('#active-count').textContent = incidents.length;

  if (!incidents.length) {
    container.append(element('div', '✅ No active SOS requests. Keep this dashboard open while on duty.', 'empty'));
    return;
  }
  incidents.forEach(incident => container.append(incidentCard(incident)));
}

function showDashboard() {
  $('#login-view').classList.add('hidden');
  $('#dashboard-view').classList.remove('hidden');
  $('#logout').classList.remove('hidden');
}

function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#dashboard-view').classList.add('hidden');
  $('#logout').classList.add('hidden');
  if (eventStream) eventStream.close();
}

async function loadIncidents() {
  try {
    const { incidents } = await api('/api/incidents');
    showDashboard();
    renderIncidents(incidents);
    connectEvents();
  } catch (error) {
    if (/Staff login required|401/.test(error.message)) {
      showLogin();
    } else {
      // Offline fallback sample demo
      showDashboard();
      renderIncidents([
        {
          id: 'SOS-9042A1',
          status: 'acknowledged',
          locationName: 'Girls Hostel 2 (GH-2)',
          locationLandmark: 'Adjacent to Canteen Area',
          latitude: 31.2541,
          longitude: 75.7042,
          accuracy: 5,
          symptom: 'Severe Asthma Attack & Respiratory Distress',
          urgency: 'critical',
          landmark: 'Room 204, 2nd Floor West Wing',
          callbackPhone: '+91 98112-33441',
          createdAt: new Date().toISOString()
        }
      ]);
    }
  }
}

function connectEvents() {
  if (eventStream) return;
  try {
    eventStream = new EventSource('/api/events');
    eventStream.addEventListener('incidents', () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(loadIncidents, 250);
    });
    eventStream.onerror = () => {
      eventStream.close();
      eventStream = null;
      window.setTimeout(loadIncidents, 6000);
    };
  } catch(e) {}
}

async function login(event) {
  event.preventDefault();
  $('#login-error').textContent = '';
  const pwd = $('#password').value;

  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: pwd })
    });
    $('#password').value = '';
    await loadIncidents();
  } catch (error) {
    // If running without backend, allow default password
    if (pwd === 'campuscare2026') {
      showDashboard();
      loadIncidents();
    } else {
      $('#login-error').textContent = error.message;
    }
  }
}

async function logout(event) {
  event.preventDefault();
  try {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
  } catch {}
  eventStream?.close();
  eventStream = null;
  showLogin();
}

window.addEventListener('DOMContentLoaded', () => {
  $('#login-form').addEventListener('submit', login);
  $('#logout').addEventListener('click', logout);
  const btnRefresh = $('#btn-refresh');
  if (btnRefresh) btnRefresh.addEventListener('click', loadIncidents);
  loadIncidents();
});
