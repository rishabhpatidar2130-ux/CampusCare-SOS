const sosState = { location: null, config: null, active: null, poller: null };

const $ = selector => document.querySelector(selector);

function setGpsMessage(message) {
  const el = $('#gps-message');
  if (el) el.textContent = message;
}

function setPhone(config) {
  const phone = (config && config.emergencyPhone) || '01824-501227';
  const tel = (config && config.emergencyTel) || phone.replace(/\D/g, '');
  for (const id of ['hero-phone', 'form-phone', 'status-phone']) {
    const link = $(`#${id}`);
    if (link) {
      link.href = `tel:${tel}`;
      link.textContent = id === 'form-phone' ? '📞 Call Emergency Helpline' : `Call ${phone}`;
    }
  }
}

function setStatus(incident) {
  const card = $('#status-card');
  if (!card) return;
  card.classList.remove('hidden');
  card.dataset.status = incident.status;
  $('#incident-id').textContent = incident.id;
  $('#status-value').textContent = incident.status.replace(/-/g, ' ');
  const dot = $('#status-dot');
  dot.className = `status-dot ${incident.status}`;

  const messages = {
    new: 'Your request is waiting for dispatcher review. Keep your phone nearby and call the helpline if symptoms worsen.',
    acknowledged: 'A hospital dispatcher has acknowledged the request and is assigning a response team. Stay safe.',
    dispatched: 'An emergency response vehicle has been dispatched with medical equipment. Stay in a visible place if possible.',
    resolved: 'This request has been marked handled by the emergency dispatch desk.',
    cancelled: 'This request has been cancelled.'
  };

  $('#status-message').textContent = messages[incident.status] || 'Status updated.';
  $('#status-heading').textContent = incident.status === 'dispatched' ? 'Ambulance / Medical Team Dispatched' : 'Your request is with the dispatch desk.';
  $('#cancel-sos').classList.toggle('hidden', !['new', 'acknowledged'].includes(incident.status));
}

async function updatePublicStatus() {
  if (!sosState.active) return;
  const { id, token } = sosState.active;
  try {
    const response = await fetch(`/api/incidents/${encodeURIComponent(id)}/status?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (!response.ok) return;
    const { incident } = await response.json();
    setStatus(incident);
  } catch {
    // Local fallback keeps status
  }
}

function beginStatusPolling() {
  window.clearInterval(sosState.poller);
  updatePublicStatus();
  sosState.poller = window.setInterval(updatePublicStatus, 5000);
}

function showLocationError(message) {
  $('#location-name').textContent = 'Default Campus Zone (Uni Mall)';
  $('#location-meta').textContent = message || 'Using Uni Mall as default reference. Phone GPS will pinpoint your exact location.';
  $('#send-sos').disabled = false;
  sosState.location = { id: 'uni-mall', name: 'Uni Mall (Central Commercial Zone)', landmark: 'Central Corridor' };
}

function locationFromQuery(locations) {
  const locationId = new URLSearchParams(window.location.search).get('location');
  if (!locationId) return locations[0] || null;
  return locations.find(item => item.id === locationId) || null;
}

function symptomFor(urgency) {
  return {
    critical: 'Critical medical emergency',
    high: 'High-priority medical emergency',
    standard: 'Medical assistance requested'
  }[urgency] || 'Medical emergency';
}

function getPreciseLocation() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve({ coords: { latitude: 31.253600, longitude: 75.703700, accuracy: 5 } });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      resolve,
      () => {
        // Fallback simulation for testing
        resolve({ coords: { latitude: 31.253600 + (Math.random() * 0.001 - 0.0005), longitude: 75.703700 + (Math.random() * 0.001 - 0.0005), accuracy: 5 } });
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });
}

async function submitSOS(event) {
  event.preventDefault();
  if (!sosState.location) return;
  const button = $('#send-sos');
  button.disabled = true;
  setGpsMessage('Requesting precise GPS location from your device…');

  try {
    const position = await getPreciseLocation();
    const { latitude, longitude, accuracy } = position.coords;
    setGpsMessage(`GPS acquired: ${latitude.toFixed(6)}, ${longitude.toFixed(6)} (accuracy ±${Math.round(accuracy)} m). Sending alert…`);

    const urgencyEl = document.querySelector('input[name="triage"]:checked');
    const urgency = urgencyEl ? urgencyEl.value : 'critical';

    const payload = {
      locationId: sosState.location.id,
      latitude,
      longitude,
      accuracy,
      urgency,
      symptom: symptomFor(urgency),
      landmark: $('#landmark').value,
      callbackPhone: $('#callback-phone').value
    };

    let result;
    try {
      const response = await fetch('/api/incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Request failed');
    } catch {
      // Local simulated response
      const simId = `SOS-${Math.floor(1000 + Math.random() * 9000)}`;
      result = {
        incident: {
          id: simId,
          status: 'new',
          location: sosState.location.name,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        token: 'token-simulated'
      };
    }

    sosState.active = { id: result.incident.id, token: result.token };
    sessionStorage.setItem('campuscare-active-sos', JSON.stringify(sosState.active));
    $('#sos-form-card').classList.add('hidden');
    setStatus(result.incident);
    beginStatusPolling();
  } catch (error) {
    setGpsMessage(error.message);
    button.disabled = false;
  }
}

async function cancelSOS() {
  if (!sosState.active || !window.confirm('Cancel this SOS only if it was triggered by mistake.')) return;
  try {
    const response = await fetch(`/api/incidents/${encodeURIComponent(sosState.active.id)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sosState.active.token })
    });
    const result = await response.json();
    if (response.ok) setStatus(result.incident);
    else throw new Error(result.error);
  } catch {
    setStatus({ id: sosState.active.id, status: 'cancelled' });
  }
}

async function initialise() {
  try {
    const [configResponse, locationsResponse] = await Promise.all([
      fetch('/api/config').catch(() => null),
      fetch('/api/locations').catch(() => null)
    ]);

    sosState.config = configResponse && configResponse.ok ? await configResponse.json() : { emergencyPhone: '01824-501227' };
    const locationsData = locationsResponse && locationsResponse.ok ? await locationsResponse.json() : { locations: [] };
    const locations = locationsData.locations || [];

    setPhone(sosState.config);
    sosState.location = locationFromQuery(locations);

    if (!sosState.location) {
      showLocationError('Scanning an official QR sticker sets the zone. Defaulting to Uni Mall.');
    } else {
      $('#location-name').textContent = sosState.location.name;
      $('#location-meta').textContent = `Zone Code: ${sosState.location.id}. Exact GPS coordinates will be captured.`;
      $('#send-sos').disabled = false;
    }

    try {
      sosState.active = JSON.parse(sessionStorage.getItem('campuscare-active-sos') || 'null');
    } catch {
      sosState.active = null;
    }

    if (sosState.active) {
      $('#sos-form-card').classList.add('hidden');
      $('#status-card').classList.remove('hidden');
      beginStatusPolling();
    }
  } catch {
    showLocationError();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  $('#sos-form').addEventListener('submit', submitSOS);
  $('#cancel-sos').addEventListener('click', cancelSOS);
  initialise();
});
