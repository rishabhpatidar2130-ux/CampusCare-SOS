let locations = [];
let config = {};

const $ = selector => document.querySelector(selector);

function publicSosUrl(location) {
  try {
    const inputVal = $('#base-url').value.trim();
    const base = new URL(inputVal.startsWith('http') ? inputVal : `${window.location.origin}/sos.html`);
    base.search = '';
    base.hash = '';
    base.searchParams.set('location', location.id);
    return base.toString();
  } catch {
    return `${window.location.origin}/sos.html?location=${encodeURIComponent(location.id)}`;
  }
}

function qrImageUrl(destination) {
  const endpoint = new URL('https://api.qrserver.com/v1/create-qr-code/');
  endpoint.searchParams.set('size', '230x230');
  endpoint.searchParams.set('ecc', 'H');
  endpoint.searchParams.set('margin', '8');
  endpoint.searchParams.set('data', destination);
  return endpoint.toString();
}

function posterFor(location) {
  const destination = publicSosUrl(location);
  const card = document.createElement('article');
  card.className = 'poster';

  const brand = document.createElement('div');
  brand.className = 'poster-brand';
  brand.textContent = 'CAMPUSCARE EMERGENCY SOS';
  card.append(brand);

  const heading = document.createElement('h2');
  heading.textContent = location.name;
  card.append(heading);

  const code = document.createElement('div');
  code.className = 'poster-code';
  code.textContent = `ZONE CODE: ${location.id.toUpperCase()}`;
  card.append(code);

  const image = document.createElement('img');
  image.alt = `QR code for ${location.name}`;
  image.src = qrImageUrl(destination);
  image.loading = 'lazy';
  card.append(image);

  const callout = document.createElement('div');
  callout.className = 'poster-callout';
  callout.textContent = '🚨 Medical emergency? Scan QR → Allow GPS → Send SOS';
  card.append(callout);

  const phone = document.createElement('p');
  phone.style.fontSize = '13px';
  phone.style.fontWeight = '700';
  phone.style.margin = '10px 0 4px';
  phone.textContent = `Uni Health Centre 24/7 Helpline: ${config.emergencyPhone || '01824-501227'}`;
  card.append(phone);

  const status = document.createElement('small');
  status.textContent = location.verified ? '✓ Official Verified Location' : 'Provisional Location';
  card.append(status);

  return card;
}

function render() {
  const base = $('#base-url').value.trim();
  const grid = $('#poster-grid');
  grid.replaceChildren();

  const includePending = $('#include-pending').checked;
  const active = locations.filter(location => includePending || location.verified);

  $('#poster-message').textContent = active.length
    ? `Displaying ${active.length} QR posters linked to: ${base}`
    : 'No locations available.';

  active.forEach(location => grid.append(posterFor(location)));
}

async function initialise() {
  try {
    const [configResponse, locationsResponse] = await Promise.all([
      fetch('/api/config').catch(() => null),
      fetch('/api/locations').catch(() => null)
    ]);

    config = configResponse && configResponse.ok ? await configResponse.json() : { emergencyPhone: '01824-501227' };
    const locData = locationsResponse && locationsResponse.ok ? await locationsResponse.json() : null;

    if (locData && locData.locations && locData.locations.length) {
      locations = locData.locations;
    } else {
      // Fallback local list
      const localRes = await fetch('/locations.json').catch(() => null);
      if (localRes && localRes.ok) {
        locations = await localRes.json();
      }
    }

    const currentOrigin = window.location.origin.startsWith('http') ? window.location.origin : 'http://localhost:8080';
    $('#base-url').value = config.publicBaseUrl ? `${config.publicBaseUrl.replace(/\/$/, '')}/sos.html` : `${currentOrigin}/sos.html`;
    render();
  } catch {
    $('#poster-message').textContent = 'Unable to load location registry.';
  }
}

window.addEventListener('DOMContentLoaded', () => {
  $('#base-url').addEventListener('input', render);
  $('#include-pending').addEventListener('change', render);
  $('#print').addEventListener('click', () => window.print());
  initialise();
});
