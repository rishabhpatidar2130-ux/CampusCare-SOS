# CampusCare SOS — LPU Emergency Healthcare & Hospital Dispatch Network

CampusCare SOS is an enterprise emergency geolocation hand-off and hospital dispatch system designed for university campuses. It connects distressed students with on-duty University Health Centre hospital dispatchers in real time with high-precision GPS telemetry.

---

## 🌟 Key Features

1. **Unified Flagship Portal (`index.html`)**:
   - **🚨 Student Emergency SOS**: 1-Tap SOS button with ripple animations, real-time HTML5 geolocation telemetry, zone detection, triage priority selectors (chest pain, fracture, unconsciousness, severe allergy), and live 4-stage response timeline (Broadcasted → Acknowledged → Ambulance En Route → On-Scene Care).
   - **🏥 Dispatcher Command Console**: Real-time active incident queue, priority badges (Critical, High, Standard), Google Maps pinpoint navigation, audio chimes, vehicle assignment modal (ambulance units, estimated arrival time, dispatcher notes), and resolution tracking.
   - **🏷️ QR Poster Print Studio**: Complete catalog of 27 LPU campus locations (Hostels BH-1 to BH-6, GH-1 to GH-4, Academic Blocks, Athletic Stadiums, Labs) with instant QR code generation and print-ready styles (`@media print`).
   - **🎟️ Campus Dispensary OPD Digital Tokens**: Non-emergency digital queue for regular clinic checkups, reducing waiting lines at the health centre.
   - **🗺️ Campus Rollout Roadmap**: 4-phase technical pathway from web prototype to native Flutter mobile app with background power-button panic triggers and offline SMS fallback.

2. **Standalone Modular Pages**:
   - `sos.html`: Student mobile-first emergency portal.
   - `dashboard.html`: Secure dispatcher console protected by session authentication.
   - `qr.html`: Printable emergency poster sheet generator.

3. **Dual Runtime Support (Node.js or Python)**:
   - Run with `node server.js` (standard Node 24 runtime with SSE).
   - Or run with `py server.py` (built-in Python 3 server, zero dependencies required).
   - Standalone preview: Can also be opened directly in any browser (`index.html`).

---

## 🚀 Quick Start on Windows

### Option A: Run via Python 3 (Immediate, Zero Dependencies)

Since Python 3 is already installed on Windows:

```powershell
cd "c:\Users\prash\OneDrive\Desktop\lpusos"
py server.py
```

Open your browser at:
- **Unified Master Portal**: [http://localhost:8080](http://localhost:8080)
- **Student SOS**: [http://localhost:8080/sos.html?location=uni-mall](http://localhost:8080/sos.html?location=uni-mall)
- **Staff Dispatcher**: [http://localhost:8080/dashboard.html](http://localhost:8080/dashboard.html)
- **QR Poster Studio**: [http://localhost:8080/qr.html](http://localhost:8080/qr.html)

*Default Dispatcher Password:* `campuscare2026`

---

### Option B: Run via Node.js

If Node.js is installed:

```powershell
cd "c:\Users\prash\OneDrive\Desktop\lpusos"
node server.js
```

Or with custom environment secrets:

```powershell
$env:PORT = "8080"
$env:DASHBOARD_PASSWORD = "your-secure-password"
$env:SESSION_SECRET = "long-random-secret-key"
node server.js
```

---

### Option C: Container Deployment (Docker)

```bash
docker build -t campuscare-sos .
docker run -p 8080:8080 -e DASHBOARD_PASSWORD="secure-password" campuscare-sos
```

---

## 📁 Project Architecture

```
lpusos/
├── index.html            # Flagship unified "All-in-One" presentable emergency portal
├── sos.html              # Dedicated Student SOS mobile-first page
├── sos.js                # Geolocation acquisition and status polling logic
├── dashboard.html        # Dedicated Hospital Dispatcher console
├── dashboard.js          # Dispatcher real-time SSE, authentication & vehicle assignment
├── qr.html               # Dedicated QR poster generator & print studio
├── qr.js                 # Dynamic QR code generation & print sheets
├── styles.css            # Refined emergency design system
├── locations.json        # 27 verified LPU campus locations catalog
├── server.js             # Node.js backend server (REST API, SSE, sessions)
├── server.py             # Python 3 backend server (REST API & static routing)
├── package.json          # Project metadata
├── Dockerfile            # Production container configuration
└── data/
    └── incidents.json    # Persistent incident database
```

---

## 🏥 Official Campus Emergency Reference
- **University Health Centre 24/7 Helpline**: `01824-501227`
- **Lead Campus First-Aid Base**: Block 5 Dispensary & Main Admin Health Centre Desk
