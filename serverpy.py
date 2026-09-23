"""
CampusCare SOS — Python Backend Server
Supports the full REST API, Server-Sent Events (SSE), and static file serving.
Can be executed with: py server.py
"""
import http.server
import socketserver
import json
import os
import sys
import uuid
import datetime
import urllib.parse
import hmac
import hashlib

PORT = int(os.environ.get("PORT", 8080))
ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
INCIDENTS_FILE = os.path.join(DATA_DIR, "incidents.json")
LOCATIONS_FILE = os.path.join(ROOT, "locations.json")
DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "campuscare2026")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "campuscare-super-secret-key-2026").encode()

os.makedirs(DATA_DIR, exist_ok=True)

# Load locations
try:
    with open(LOCATIONS_FILE, "r", encoding="utf-8") as f:
        locations = json.load(f)
except Exception:
    locations = []

# Load or init incidents
try:
    with open(INCIDENTS_FILE, "r", encoding="utf-8") as f:
        incidents = json.load(f)
except Exception:
    incidents = []

def save_incidents():
    with open(INCIDENTS_FILE, "w", encoding="utf-8") as f:
        json.dump(incidents, f, indent=2)

def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

class CampusCareHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/api/health":
            return self.send_json(200, {"ok": True, "time": now_iso()})

        if path == "/api/config":
            return self.send_json(200, {
                "publicBaseUrl": "",
                "emergencyPhone": "112",
                "emergencyTel": "112",
                "campusPhone": "01824-501227",
                "hotlineName": "National Emergency Service (112) / LPU Health Centre"
            })

        if path == "/api/locations":
            return self.send_json(200, {"locations": locations})

        if path == "/api/incidents":
            active_only = query.get("includeClosed", ["false"])[0] != "true"
            res = [inc for inc in incidents if not active_only or inc.get("status") not in ["resolved", "cancelled"]]
            return self.send_json(200, {"incidents": res})

        if path.startswith("/api/incidents/") and path.endswith("/status"):
            parts = path.strip("/").split("/")
            inc_id = parts[2]
            token = query.get("token", [""])[0]
            inc = next((i for i in incidents if i["id"] == inc_id), None)
            if not inc or (token and inc.get("publicToken") != token):
                return self.send_json(404, {"error": "SOS request not found"})
            return self.send_json(200, {
                "incident": {
                    "id": inc["id"],
                    "status": inc["status"],
                    "location": inc.get("locationName", ""),
                    "createdAt": inc.get("createdAt"),
                    "updatedAt": inc.get("updatedAt"),
                    "message": "A dispatcher reports that a response vehicle has been assigned." if inc.get("status") == "dispatched" else None
                }
            })

        # Static file routing
        if path in ["/", ""]:
            path = "/index.html"

        file_path = os.path.join(ROOT, path.lstrip("/"))
        if os.path.isfile(file_path):
            self.path = path
            return super().do_GET()

        return self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        body = {}
        if length > 0:
            raw = self.rfile.read(length)
            try:
                body = json.loads(raw.decode("utf-8"))
            except Exception:
                pass

        if path == "/api/auth/login":
            pwd = body.get("password", "")
            if pwd == DASHBOARD_PASSWORD:
                self.send_response(200)
                self.send_header("Set-Cookie", "campuscare_session=dispatcher_auth_ok; Path=/; Max-Age=28800")
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')
            else:
                return self.send_json(401, {"error": "Incorrect dispatcher password."})
            return

        if path == "/api/auth/logout":
            self.send_response(200)
            self.send_header("Set-Cookie", "campuscare_session=; Path=/; Max-Age=0")
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return

        if path == "/api/incidents":
            loc_id = body.get("locationId", "")
            loc = next((l for l in locations if l["id"] == loc_id), None)
            loc_name = loc["name"] if loc else "Campus Zone"
            loc_landmark = loc.get("landmark", "") if loc else ""

            incident = {
                "id": f"SOS-{uuid.uuid4().hex[:8].upper()}",
                "publicToken": uuid.uuid4().hex,
                "status": "new",
                "locationId": loc_id,
                "locationName": loc_name,
                "locationLandmark": loc_landmark,
                "latitude": round(float(body.get("latitude", 31.2536)), 6),
                "longitude": round(float(body.get("longitude", 75.7037)), 6),
                "accuracy": round(float(body.get("accuracy", 5))),
                "symptom": body.get("symptom", "Medical emergency"),
                "urgency": body.get("urgency", "high"),
                "landmark": body.get("landmark", ""),
                "callbackPhone": body.get("callbackPhone", ""),
                "createdAt": now_iso(),
                "updatedAt": now_iso(),
                "audit": [{"at": now_iso(), "action": "created", "actor": "student"}]
            }
            incidents.insert(0, incident)
            save_incidents()
            return self.send_json(201, {
                "incident": {
                    "id": incident["id"],
                    "status": incident["status"],
                    "location": incident["locationName"],
                    "createdAt": incident["createdAt"],
                    "updatedAt": incident["updatedAt"]
                },
                "token": incident["publicToken"],
                "full": incident
            })

        if path.startswith("/api/incidents/") and path.endswith("/cancel"):
            parts = path.strip("/").split("/")
            inc_id = parts[2]
            token = body.get("token", "")
            inc = next((i for i in incidents if i["id"] == inc_id), None)
            if not inc or (token and inc.get("publicToken") != token):
                return self.send_json(404, {"error": "SOS request not found"})
            inc["status"] = "cancelled"
            inc["updatedAt"] = now_iso()
            save_incidents()
            return self.send_json(200, {"incident": inc})

        return self.send_json(404, {"error": "Not found"})

    def do_PATCH(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        body = {}
        if length > 0:
            raw = self.rfile.read(length)
            try:
                body = json.loads(raw.decode("utf-8"))
            except Exception:
                pass

        if path.startswith("/api/incidents/"):
            inc_id = path.strip("/").split("/")[2]
            inc = next((i for i in incidents if i["id"] == inc_id), None)
            if not inc:
                return self.send_json(404, {"error": "Incident not found"})
            action = body.get("action")
            if action == "acknowledge":
                inc["status"] = "acknowledged"
                inc["dispatchNote"] = body.get("note", "Dispatcher acknowledgement recorded.")
            elif action == "dispatch":
                inc["status"] = "dispatched"
                inc["vehicle"] = body.get("vehicle", "Campus Response Ambulance")
                inc["etaMinutes"] = int(body.get("etaMinutes", 3))
                inc["dispatchNote"] = body.get("note", "Response vehicle en route.")
            elif action in ["on-scene", "arrive"]:
                inc["status"] = "on-scene"
                inc["dispatchNote"] = body.get("note", "Paramedic team arrived on scene. Care active.")
            elif action == "resolve":
                inc["status"] = "resolved"
                inc["resolutionNote"] = body.get("note", "Handled by dispatch.")
            inc["updatedAt"] = now_iso()
            save_incidents()
            return self.send_json(200, {"incident": inc})

        return self.send_json(404, {"error": "Not found"})

if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    print("======================================================")
    print(f"[CampusCare SOS] Python Server on: http://localhost:{PORT}")
    print(f"Default Dispatcher Password: '{DASHBOARD_PASSWORD}'")
    print("======================================================\n")
    with socketserver.TCPServer(("", PORT), CampusCareHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")
