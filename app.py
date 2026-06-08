"""
IPTV v2 - Clean backend with localized messages and complete features.
Features: Playlists management, M3U import, EPG parser, stream proxy, channel status scanner.
"""
import asyncio
import gzip
import hashlib
import json
import os
import re
import sqlite3
import time
import urllib.parse
import xml.etree.ElementTree as ET
import subprocess
import uuid
import sys
from typing import List, Optional
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, UploadFile, File
from fastapi.responses import Response, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import ipaddress
import socket

def is_safe_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https'):
            return False
        hostname = parsed.hostname
        if not hostname:
            return False
        if hostname.lower() == 'localhost':
            return False
        try:
            ip = ipaddress.ip_address(hostname)
        except ValueError:
            try:
                resolved_ip = socket.gethostbyname(hostname)
                ip = ipaddress.ip_address(resolved_ip)
            except Exception:
                return True
        if ip.is_private or ip.is_loopback or ip.is_link_local:
            return False
        return True
    except Exception:
        return False

async def download_playlist_with_limit(url: str, headers: dict, limit_bytes: int = 20 * 1024 * 1024) -> bytes:
    if not is_safe_url(url):
        raise ValueError("SSRF Protection: Local or private network URLs are prohibited.")
    req = shared_client.build_request("GET", url, headers=headers)
    resp = await shared_client.send(req, stream=True)
    try:
        resp.raise_for_status()
        cl = resp.headers.get("content-length")
        if cl and int(cl) > limit_bytes:
            raise ValueError(f"Playlist file size exceeds the limit of {limit_bytes // (1024 * 1024)}MB.")
        content = bytearray()
        async for chunk in resp.aiter_bytes(chunk_size=8192):
            content.extend(chunk)
            if len(content) > limit_bytes:
                raise ValueError(f"Playlist file size exceeds the limit of {limit_bytes // (1024 * 1024)}MB.")
        return bytes(content)
    finally:
        await resp.aclose()

APP_TOKEN = str(uuid.uuid4())

app = FastAPI()
use_stream_proxy = False
GLOBAL_SCAN_LOCK = False

if getattr(sys, 'frozen', False):
    BASE_DIR = sys._MEIPASS
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

import logging

# Target the safe system AppData folder for local storage unconditionally
app_data_dir = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'IPTV_v2')
if not os.path.exists(app_data_dir):
    os.makedirs(app_data_dir)

DATA_DIR = os.path.join(app_data_dir, "data")
os.makedirs(DATA_DIR, exist_ok=True)

# Main Database and session paths
DATABASE_PATH = os.path.join(app_data_dir, 'app_settings.db')
DEBUG_GUEST_MODE = False
SECRET_SALT_MASK = "IPTV_v2_Secure_Salt_Token_2026_Lock"
guest_failed_attempts = 0
guest_lockout_until = 0
SESSION_PATH = os.path.join(app_data_dir, 'local_session.json')

logging.basicConfig(
    filename=os.path.join(app_data_dir, 'app.log'),
    level=logging.ERROR,
    format='%(asctime)s %(levelname)s %(name)s %(message)s'
)
logger = logging.getLogger(__name__)

NET_SETTINGS_FILE = os.path.join(DATA_DIR, "net_settings.json")
def load_net_settings():
    default = {"proxy": "", "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "scan_concurrency": 30}
    if os.path.exists(NET_SETTINGS_FILE):
        try:
            import json
            with open(NET_SETTINGS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    default.update(data)
        except:
            pass
    return default

net_settings = load_net_settings()

# ── Singleton HTTP Client ────────────────────────────────────────────
# Tạo 1 AsyncClient duy nhất, tái sử dụng cho mọi request.
# Giảm tạo/huỷ TCP pool liên tục, giảm phân mảnh bộ nhớ.

shared_client: httpx.AsyncClient = None  # initialized in lifespan

def _build_shared_client() -> httpx.AsyncClient:
    kwargs = {
        "verify": False,
        "follow_redirects": True,
        "timeout": httpx.Timeout(30.0, connect=10.0),
        "limits": httpx.Limits(
            max_connections=100,
            max_keepalive_connections=20
        ),
    }
    if net_settings.get("proxy"):
        kwargs["proxy"] = net_settings["proxy"]
    return httpx.AsyncClient(**kwargs)

def get_client(**kwargs):
    """Tạo client tạm thời cho các trường hợp cần cấu hình riêng (timeout khác, headers riêng).
    Ưu tiên dùng shared_client thay vì hàm này."""
    if net_settings.get("proxy"):
        kwargs["proxy"] = net_settings["proxy"]
    return httpx.AsyncClient(**kwargs)

@app.middleware("http")
async def global_exception_logger(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception as e:
        logger.error(f"Unhandled backend crash on {request.url}: {str(e)}", exc_info=True)
        raise

@app.middleware("http")
async def verify_app_token(request: Request, call_next):
    try:
        path = request.url.path
        if not path.startswith("/api/"):
            return await call_next(request)
            
        if path.startswith("/api/hls/"):
            return await call_next(request)
            
        token_header = request.headers.get("X-App-Token")
        token_query = request.query_params.get("token")
        if token_header != APP_TOKEN and token_query != APP_TOKEN:
            return Response(status_code=403, content="Forbidden: Invalid or missing App Token")
            
        return await call_next(request)
    except Exception as e:
        print(f"Auth Layer Error: {e}")
        return await call_next(request)

DB_FILE = DATABASE_PATH
def init_db():
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute('''
            CREATE TABLE IF NOT EXISTS channels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                playlist_id TEXT,
                name TEXT,
                group_title TEXT,
                tvg_logo TEXT,
                url TEXT,
                tvg_id TEXT,
                tvg_name TEXT,
                catchup TEXT,
                catchup_days TEXT,
                catchup_source TEXT,
                status TEXT,
                qualities TEXT
            )
        ''')
        c.execute('CREATE INDEX IF NOT EXISTS idx_playlist ON channels(playlist_id)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_name ON channels(name)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_group ON channels(group_title)')
        
        try:
            c.execute("ALTER TABLE channels ADD COLUMN last_checked INTEGER DEFAULT 0")
        except sqlite3.OperationalError:
            pass
        
        c.execute('''
            CREATE TABLE IF NOT EXISTS recordings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_name TEXT,
                filepath TEXT,
                record_type TEXT,
                start_time INTEGER
            )
        ''')
        
        c.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE,
                password TEXT,
                account_type TEXT
            )
        ''')
        
        c.execute('SELECT COUNT(*) FROM users')
        if c.fetchone()[0] == 0:
            c.execute('INSERT INTO users (username, password, account_type) VALUES (?, ?, ?)', ('guest_user', 'guest123', 'guest'))
            c.execute('INSERT INTO users (username, password, account_type) VALUES (?, ?, ?)', ('account_user', 'account123', 'account'))
            
        try:
            c.execute('ALTER TABLE users ADD COLUMN display_name TEXT')
            c.execute('ALTER TABLE users ADD COLUMN avatar TEXT')
        except Exception:
            pass
            
        try:
            c.execute('ALTER TABLE recordings ADD COLUMN status TEXT DEFAULT "ready"')
        except Exception:
            pass
        try:
            c.execute('ALTER TABLE recordings ADD COLUMN duration INTEGER DEFAULT 0')
        except Exception:
            pass
            
        c.execute('''
            CREATE TABLE IF NOT EXISTS login_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT,
                session_token TEXT UNIQUE,
                expires_at DATETIME
            )
        ''')
        
        c.execute('''
            CREATE TABLE IF NOT EXISTS app_settings (
                setting_key TEXT PRIMARY KEY,
                setting_value TEXT
            )
        ''')
            
        # Reset any stuck recordings from previous run
        try:
            c.execute("UPDATE recordings SET status = 'failed' WHERE status IN ('recording', 'processing')")
        except Exception:
            pass

        conn.commit()

init_db()

RECORDINGS_DIR = os.path.join(DATA_DIR, "recordings")
os.makedirs(RECORDINGS_DIR, exist_ok=True)
ACTIVE_RECORDINGS = {}

PLAYLISTS_FILE = os.path.join(DATA_DIR, "playlists.json")
LOCAL_SESSION_FILE = SESSION_PATH
LANGUAGES = {}

# ── Translation System (i18n) ───────────────────────────────────────

def load_languages():
    languages_dir = os.path.join(BASE_DIR, "languages")
    if os.path.exists(languages_dir):
        for f in os.listdir(languages_dir):
            if f.endswith(".json"):
                lang = f.split(".")[0]
                try:
                    with open(os.path.join(languages_dir, f), "r", encoding="utf-8") as file:
                        LANGUAGES[lang] = json.load(file)
                except Exception as e:
                    print(f"Error loading language {f}: {e}")

load_languages()

def get_text(user_id: str, key: str, **kwargs) -> str:
    lang = user_id or "vi"
    if lang not in LANGUAGES:
        lang = "vi"
    translation = LANGUAGES.get(lang, {}).get(key, key)
    if kwargs:
        try:
            return translation.format(**kwargs)
        except Exception:
            return translation
    return translation

# ── Helpers đọc/ghi JSON ────────────────────────────────────────────

def read_json(filepath, default=None):
    if default is None:
        default = []
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return default
    return default

def write_json(filepath, data):
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

# ── Parse XMLTV Date for EPG ────────────────────────────────────────

def parse_xmltv_date(date_str: str) -> int:
    m = re.match(r"(\d{14})(?:\s+([+-]\d{4}))?", date_str)
    if not m:
        return 0
    dt_part = m.group(1)
    tz_part = m.group(2)
    
    try:
        from datetime import datetime, timezone, timedelta
        dt = datetime.strptime(dt_part, "%Y%m%d%H%M%S")
        if tz_part:
            sign = 1 if tz_part[0] == '+' else -1
            hours = int(tz_part[1:3])
            minutes = int(tz_part[3:5])
            tz = timezone(timedelta(hours=sign*hours, minutes=sign*minutes))
            dt = dt.replace(tzinfo=tz)
            return int(dt.timestamp())
        else:
            dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp())
    except Exception:
        return 0

# ── EPG XML Parser ──────────────────────────────────────────────────

def parse_epg_xml(xml_content_or_path, is_bytes=False):
    """Parse EPG XML using iterparse (streaming) to avoid loading entire DOM tree into RAM.
    Giảm RAM từ 1-2GB xuống còn 50-150MB cho file EPG lớn."""
    import io
    try:
        channel_names = {}
        epg_data = {}
        now_ts = int(time.time())
        min_ts = now_ts - 43200  # -12 hours
        max_ts = now_ts + 129600 # +36 hours

        # Prepare the source for iterparse
        if is_bytes:
            if xml_content_or_path.startswith(b'\x1f\x8b'):
                source = gzip.GzipFile(fileobj=io.BytesIO(xml_content_or_path))
            else:
                source = io.BytesIO(xml_content_or_path)
        else:
            source = xml_content_or_path  # file path string

        for event, elem in ET.iterparse(source, events=('end',)):
            if elem.tag == 'channel':
                chan_id = elem.get('id')
                if chan_id:
                    names = [node.text for node in elem.findall('display-name') if node.text]
                    channel_names[chan_id] = names
                elem.clear()

            elif elem.tag == 'programme':
                chan_id = elem.get('channel')
                start_str = elem.get('start')
                stop_str = elem.get('stop')

                if chan_id and start_str and stop_str:
                    start_ts = parse_xmltv_date(start_str)
                    stop_ts = parse_xmltv_date(stop_str)

                    if not (stop_ts < min_ts or start_ts > max_ts):
                        title_node = elem.find('title')
                        title = title_node.text if title_node is not None else ""
                        desc_node = elem.find('desc')
                        desc = desc_node.text if desc_node is not None else ""

                        prog_item = {
                            "title": title,
                            "desc": desc,
                            "start": start_ts,
                            "stop": stop_ts
                        }
                        if chan_id not in epg_data:
                            epg_data[chan_id] = []
                        epg_data[chan_id].append(prog_item)
                elem.clear()

            elif elem.tag == 'tv':
                # Root element, clear to release all children refs
                elem.clear()

        # Close the source if it's a file-like object we opened
        if is_bytes and hasattr(source, 'close'):
            source.close()

        return {
            "channel_names": channel_names,
            "epg_data": epg_data
        }
    except Exception as e:
        print("Error parsing EPG XML:", e)
        return None

def get_channel_epg(ch, epg_data, channel_names, now_ts):
    tvg_id = ch.get('tvg_id', '')
    tvg_name = ch.get('tvg_name', '')
    ch_name = ch.get('name', '').strip().lower()
    
    matched_id = None
    
    if tvg_id and tvg_id in epg_data:
        matched_id = tvg_id
    elif tvg_name and tvg_name in epg_data:
        matched_id = tvg_name
    else:
        for cid, names in channel_names.items():
            if any(name.strip().lower() == ch_name for name in names):
                matched_id = cid
                break
                
        if not matched_id:
            for cid in epg_data.keys():
                if cid.strip().lower() == ch_name:
                    matched_id = cid
                    break
                    
    if not matched_id:
        return None
        
    progs = epg_data.get(matched_id, [])
    sorted_progs = sorted(progs, key=lambda x: x['start'])
    
    current_index = -1
    for i, p in enumerate(sorted_progs):
        if p['start'] <= now_ts < p['stop']:
            current_index = i
            break
                
    return {
        "programs": sorted_progs,
        "current_index": current_index
    }

async def download_and_parse_epg_bg(playlist_id: str, epg_url: str):
    if not is_safe_url(epg_url):
        print(f"Background EPG error for playlist {playlist_id}: SSRF URL blocked")
        return
    headers = {
        "User-Agent": net_settings.get("user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
    }
    limit_bytes = 50 * 1024 * 1024
    req = shared_client.build_request("GET", epg_url, headers=headers)
    resp = None
    try:
        resp = await shared_client.send(req, stream=True)
        if resp.status_code >= 400:
            return
        cl = resp.headers.get("content-length")
        if cl and int(cl) > limit_bytes:
            print(f"Background EPG error for playlist {playlist_id}: File size exceeds 50MB limit")
            return
        content = bytearray()
        async for chunk in resp.aiter_bytes(chunk_size=8192):
            content.extend(chunk)
            if len(content) > limit_bytes:
                print(f"Background EPG error for playlist {playlist_id}: File size exceeds 50MB limit")
                return
        parsed = parse_epg_xml(bytes(content), is_bytes=True)
        if parsed:
            epg_filename = os.path.join(DATA_DIR, f"epg_{playlist_id}.json")
            with open(epg_filename, "w", encoding="utf-8") as f:
                json.dump(parsed, f, ensure_ascii=False, indent=2)
            print(f"Background EPG success for playlist {playlist_id}")
    except Exception as e:
        print(f"Background EPG error for playlist {playlist_id}: {e}")
    finally:
        if resp:
            await resp.aclose()

# ── Parse M3U ────────────────────────────────────────────────────────

def parse_m3u(content: str) -> list[dict]:
    lines = content.splitlines()
    channels = []
    current = {}

    for line in lines:
        line = line.strip()
        if not line:
            continue

        if line.startswith("#EXTINF"):
            name = line.split(",", 1)[-1].strip() if "," in line else "Unknown"

            logo = ""
            m = re.search(r'tvg-logo="([^"]*)"', line)
            if m:
                logo = m.group(1)
                if logo:
                    logo_lower = logo.lower().strip()
                    if not (logo_lower.startswith("http://") or logo_lower.startswith("https://") or logo_lower.startswith("data:image/")):
                        logo = ""

            group = "Chung"
            m = re.search(r'group-title="([^"]*)"', line)
            if m and m.group(1).strip():
                group = m.group(1).strip()

            tvg_id = ""
            m = re.search(r'tvg-id="([^"]*)"', line)
            if m:
                tvg_id = m.group(1)

            tvg_name = ""
            m = re.search(r'tvg-name="([^"]*)"', line)
            if m:
                tvg_name = m.group(1)

            catchup = ""
            m = re.search(r'catchup="([^"]*)"', line)
            if m:
                catchup = m.group(1)

            catchup_days = ""
            m = re.search(r'catchup-days="([^"]*)"', line)
            if m:
                catchup_days = m.group(1)

            catchup_source = ""
            m = re.search(r'catchup-source="([^"]*)"', line)
            if m:
                catchup_source = m.group(1)

            current = {
                "name": name, 
                "logo": logo, 
                "group": group,
                "tvg_id": tvg_id,
                "tvg_name": tvg_name,
                "catchup": catchup,
                "catchup_days": catchup_days,
                "catchup_source": catchup_source,
                "status": "unknown"
            }

        elif line.startswith(("http://", "https://", "rtsp://", "rtmp://")):
            if current:
                current["url"] = line
                channels.append(current)
                current = {}

    return channels

def parse_sports_json(data) -> list[dict]:
    channels = []
    fixtures = []
    
    # Check if there is a 'groups' key (commonly used for nesting events under categories)
    if isinstance(data, dict) and "groups" in data and isinstance(data["groups"], list):
        for gp in data["groups"]:
            if isinstance(gp, dict):
                # Look for a list of events inside the group (e.g. 'channels', 'fixtures', etc.)
                for key in ("channels", "fixtures", "matches", "items"):
                    if key in gp and isinstance(gp[key], list):
                        fixtures.extend(gp[key])
                        
    # Otherwise, check if the root itself is a list of fixtures or if it has other list keys
    if not fixtures:
        if isinstance(data, list):
            fixtures = data
        elif isinstance(data, dict):
            # Check for other list keys
            for k, v in data.items():
                if isinstance(v, list) and len(v) > 0 and isinstance(v[0], dict):
                    # It must not be the 'groups' list itself if we didn't find any fixtures
                    sample = v[0]
                    if any(key in sample for key in ("sources", "streams", "url", "stream_links")):
                        fixtures = v
                        break
            if not fixtures:
                if any(key in data for key in ("sources", "streams", "url", "stream_links")):
                    fixtures = [data]
                
    for f in fixtures:
        if not isinstance(f, dict):
            continue
        event_name = f.get("name", "Unknown Event")
        event_group = f.get("subtitle", "Sports")
        event_logo = ""
        img_obj = f.get("image")
        if isinstance(img_obj, dict):
            event_logo = img_obj.get("url", "")
        elif isinstance(img_obj, str):
            event_logo = img_obj
        if event_logo:
            logo_lower = event_logo.lower().strip()
            if not (logo_lower.startswith("http://") or logo_lower.startswith("https://") or logo_lower.startswith("data:image/")):
                event_logo = ""
            
        found_streams = []
        
        def find_streams_recursive(obj, current_stream_name=""):
            if isinstance(obj, list):
                for item in obj:
                    find_streams_recursive(item, current_stream_name)
            elif isinstance(obj, dict):
                if "url" in obj and isinstance(obj["url"], str) and obj["url"].startswith(("http://", "https://")):
                    stream_name = obj.get("name", current_stream_name)
                    found_streams.append((stream_name, obj))
                    return
                
                name_val = obj.get("name", "")
                next_name = name_val if name_val else current_stream_name
                for k, v in obj.items():
                    if k not in ("image", "labels"):
                        find_streams_recursive(v, next_name)
                        
        find_streams_recursive(f)
        
        for idx, (stream_name, stream_obj) in enumerate(found_streams):
            url = stream_obj["url"]
            req_headers = stream_obj.get("request_headers", [])
            header_parts = []
            if isinstance(req_headers, list):
                for h in req_headers:
                    if isinstance(h, dict) and "key" in h and "value" in h:
                        header_parts.append(f"{h['key']}={h['value']}")
            if header_parts:
                url = f"{url}|{'&'.join(header_parts)}"
                
            ch_name = f"{event_name}"
            if stream_name:
                ch_name += f" - {stream_name}"
            else:
                ch_name += f" - Stream {idx + 1}"
                
            channels.append({
                "name": ch_name,
                "logo": event_logo,
                "group": event_group,
                "url": url,
                "status": "unknown"
            })
            
    return channels

# ── API: Languages ──────────────────────────────────────────────────

@app.get("/api/languages/{lang}")
async def get_language_keys(lang: str):
    lang_file = os.path.join(BASE_DIR, "languages", f"{lang}.json")
    if os.path.exists(lang_file):
        return read_json(lang_file, default={})
    fallback_file = os.path.join(BASE_DIR, "languages", "vi.json")
    return read_json(fallback_file, default={})

# ── API: Settings & Auth ────────────────────────────────────────

class SetStreamProxyRequest(BaseModel):
    enabled: bool

@app.get("/api/settings")
def get_settings():
    return {"use_stream_proxy": use_stream_proxy}

@app.post("/api/settings/stream_proxy")
def set_stream_proxy(req: SetStreamProxyRequest):
    global use_stream_proxy
    use_stream_proxy = req.enabled
    return {"status": "success", "use_stream_proxy": use_stream_proxy}

@app.post("/api/settings/clear_cache")
def clear_cache():
    try:
        import glob
        import shutil
        deleted_epg = 0
        for f in glob.glob(os.path.join(DATA_DIR, "epg_*.json")):
            try:
                os.remove(f)
                deleted_epg += 1
            except Exception:
                pass
                
        # Also clear any temp/cache folders created by webview if possible, but that's normally handled by the OS webview itself.
        # So we just clear our explicit EPG data.
        return {"status": "success", "message": "Cache and old EPG data cleared successfully"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


class NetworkSettingsReq(BaseModel):
    proxy: str
    user_agent: str
    scan_concurrency: int

@app.get("/api/settings/network")
def get_network_settings():
    return net_settings

@app.post("/api/settings/network")
def set_network_settings(req: NetworkSettingsReq):
    net_settings["proxy"] = req.proxy
    net_settings["user_agent"] = req.user_agent
    net_settings["scan_concurrency"] = req.scan_concurrency
    import json
    with open(NET_SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(net_settings, f, ensure_ascii=False, indent=2)
    return {"status": "success"}

def get_db_connection():
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn

@app.get("/api/settings/kv/{key}")
async def get_kv_setting(key: str):
    import json
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT setting_value FROM app_settings WHERE setting_key = ?", (key,))
        row = cursor.fetchone()
        if row:
            try:
                # Force decode the database string into a real Python dictionary
                return json.loads(row['setting_value'])
            except Exception:
                return {}
        return {}

@app.post("/api/settings/kv/{key}")
async def post_kv_setting(key: str, request: Request):
    import json
    try:
        payload = await request.json()
        string_value = json.dumps(payload)
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT OR REPLACE INTO app_settings (setting_key, setting_value) VALUES (?, ?)",
                (key, string_value)
            )
            conn.commit()
        return {"status": "success"}
    except Exception as e:
        import logging
        logging.error(f"Failed to save key {key}: {str(e)}")
        return {"status": "error", "message": str(e)}, 500

class LoginRequest(BaseModel):
    username: str = ""
    password: str = ""
    remember_me: bool = False
    login_type: str = "standard"

@app.post("/api/login")
async def login_api(req: LoginRequest):
    try:
        with sqlite3.connect(DB_FILE) as conn:
            c = conn.cursor()
            
            row = None
            if req.login_type == "guest":
                req.username = "guest_user"
                # Respect the incoming payload parameter state instead of forcing it to True
                req.remember_me = req.remember_me
                try:
                    c.execute('SELECT account_type, display_name, avatar FROM users WHERE username = ?', (req.username,))
                    row = c.fetchone()
                    if row:
                        row = (row[0], row[1] or req.username, row[2] or "")
                except sqlite3.OperationalError:
                    c.execute('SELECT account_type FROM users WHERE username = ?', (req.username,))
                    fallback_row = c.fetchone()
                    if fallback_row:
                        row = (fallback_row[0], req.username, "")
            else:
                # Handle schema updates in case the columns weren't added
                try:
                    c.execute('SELECT account_type, display_name, avatar FROM users WHERE username = ? AND password = ?', (req.username, req.password))
                    row = c.fetchone()
                    if row:
                        row = (row[0], row[1] or req.username, row[2] or "")
                except sqlite3.OperationalError:
                    # Fallback if display_name/avatar columns are missing
                    c.execute('SELECT account_type FROM users WHERE username = ? AND password = ?', (req.username, req.password))
                    fallback_row = c.fetchone()
                    if fallback_row:
                        row = (fallback_row[0], req.username, "")
            
            if row:
                account_type = row[0]
                display_name = row[1]
                avatar = row[2]
                
                session_token = ""
                if req.remember_me:
                    import secrets
                    from datetime import datetime, timedelta
                    session_token = secrets.token_hex(32)
                    expires_at = datetime.now() + timedelta(days=30)
                    
                    # Store in database
                    c.execute('INSERT INTO login_sessions (username, session_token, expires_at) VALUES (?, ?, ?)', 
                              (req.username, session_token, expires_at.strftime("%Y-%m-%d %H:%M:%S")))
                    conn.commit()
                    
                    # Store locally for the desktop app to auto-login
                    import json
                    with open(LOCAL_SESSION_FILE, "w", encoding="utf-8") as f:
                        json.dump({"session_token": session_token}, f)
                
                return {
                    "status": "success", 
                    "username": req.username,
                    "type": account_type, 
                    "display_name": display_name,
                    "avatar": avatar,
                    "session_token": session_token,
                    "message": "Login successful"
                }
            
            return {"status": "error", "message": "Invalid username or password"}

    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/logout")
async def logout_api():
    try:
        if os.path.exists(SESSION_PATH):
            try:
                with open(SESSION_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    token = data.get("session_token")
                if token:
                    with sqlite3.connect(DATABASE_PATH) as conn:
                        c = conn.cursor()
                        c.execute('DELETE FROM login_sessions WHERE session_token = ?', (token,))
                        conn.commit()
            except Exception:
                pass
            os.remove(SESSION_PATH)
        return {"status": "success", "message": "Session wiped successfully"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/api/check-session")
def check_session():
    import json
    from datetime import datetime
    
    if not os.path.exists(LOCAL_SESSION_FILE):
        return {"status": "error", "message": "No session found"}
        
    try:
        with open(LOCAL_SESSION_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            session_token = data.get("session_token")
            
        if not session_token:
            return {"status": "error", "message": "Invalid session data"}
            
        with sqlite3.connect(DB_FILE) as conn:
            c = conn.cursor()
            c.execute('SELECT username, expires_at FROM login_sessions WHERE session_token = ?', (session_token,))
            session_row = c.fetchone()
            
            if not session_row:
                return {"status": "error", "message": "Session not found"}
                
            username, expires_at_str = session_row
            expires_at = datetime.strptime(expires_at_str, "%Y-%m-%d %H:%M:%S")
            
            if datetime.now() > expires_at:
                c.execute('DELETE FROM login_sessions WHERE session_token = ?', (session_token,))
                conn.commit()
                os.remove(LOCAL_SESSION_FILE)
                return {"status": "error", "message": "Session expired"}
                
            # Session valid, get user info
            try:
                c.execute('SELECT account_type, display_name, avatar FROM users WHERE username = ?', (username,))
                user_row = c.fetchone()
                if user_row:
                    return {
                        "status": "success",
                        "username": username,
                        "type": user_row[0],
                        "display_name": user_row[1] or username,
                        "avatar": user_row[2] or "",
                        "message": "Session valid"
                    }
            except sqlite3.OperationalError:
                c.execute('SELECT account_type FROM users WHERE username = ?', (username,))
                user_row = c.fetchone()
                if user_row:
                    return {
                        "status": "success",
                        "username": username,
                        "type": user_row[0],
                        "display_name": username,
                        "avatar": "",
                        "message": "Session valid"
                    }
                    
        return {"status": "error", "message": "User not found"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

class ProfileRequest(BaseModel):
    username: str
    display_name: str
    avatar: str

@app.post("/api/user/profile")
async def update_profile(req: ProfileRequest):
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            c.execute('UPDATE users SET display_name = ?, avatar = ? WHERE username = ?', (req.display_name, req.avatar, req.username))
            conn.commit()
            return {"status": "success", "message": "Profile updated successfully"}
    except Exception as e:
        logger.error(f"Failed to update profile for {req.username}: {str(e)}", exc_info=True)
        return {"status": "error", "message": str(e)}

class PasswordRequest(BaseModel):
    username: str
    old_password: str
    new_password: str

@app.post("/api/user/password")
async def change_password(req: PasswordRequest):
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            c.execute('SELECT account_type FROM users WHERE username = ? AND password = ?', (req.username, req.old_password))
            if not c.fetchone():
                return {"status": "error", "message": "Incorrect current password"}
            
            c.execute('UPDATE users SET password = ? WHERE username = ?', (req.new_password, req.username))
            conn.commit()
            return {"status": "success", "message": "Password updated successfully"}
    except Exception as e:
        logger.error(f"Failed to change password for {req.username}: {str(e)}", exc_info=True)
        return {"status": "error", "message": str(e)}



# ── API: Playlists ───────────────────────────────────────────────────

@app.get("/api/playlists")
async def get_playlists():
    return read_json(PLAYLISTS_FILE)

@app.post("/api/import")
async def import_m3u(m3u_url: str, background_tasks: BackgroundTasks, lang: str = "vi"):
    m3u_url = m3u_url.strip()
    
    # Auto-rewrite Dropbox preview links to raw content download links
    if "dropbox.com" in m3u_url:
        if "www.dropbox.com" in m3u_url:
            m3u_url = m3u_url.replace("www.dropbox.com", "dl.dropboxusercontent.com")
        elif "dl.dropboxusercontent.com" not in m3u_url:
            m3u_url = m3u_url.replace("dropbox.com", "dl.dropboxusercontent.com")
        
        if "dl=0" in m3u_url:
            m3u_url = m3u_url.replace("dl=0", "dl=1")
        elif "dl=" not in m3u_url:
            separator = "&" if "?" in m3u_url else "?"
            m3u_url = f"{m3u_url}{separator}dl=1"
            
    # Auto-rewrite Google Drive sharing links to direct download links
    elif "drive.google.com" in m3u_url:
        m = re.search(r'/file/d/([^/]+)', m3u_url)
        if m:
            file_id = m.group(1)
            m3u_url = f"https://drive.google.com/uc?export=download&id={file_id}"

    headers = {
        "User-Agent": net_settings.get("user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
    }
    try:
        content_bytes = await download_playlist_with_limit(m3u_url, headers)
    except Exception as e:
        raise HTTPException(status_code=400, detail=get_text(lang, "toast_import_error") + f": {str(e)}")

    channels = []
    is_json = False
    epg_url = ""
    try:
        json_data = json.loads(content_bytes.decode("utf-8", errors="ignore"))
        channels = await asyncio.to_thread(parse_sports_json, json_data)
        if channels:
            is_json = True
    except Exception:
        pass

    if not is_json:
        content = content_bytes.decode("utf-8", errors="ignore").lstrip("\ufeff")
        lines = content.split("\n")
        if len(lines) > 0 and lines[0].strip().startswith("#EXTM3U"):
            first_line = lines[0]
            if 'x-tvg-url="' in first_line:
                epg_url = first_line.split('x-tvg-url="')[1].split('"')[0]
            elif 'url-tvg="' in first_line:
                epg_url = first_line.split('url-tvg="')[1].split('"')[0]
        channels = await asyncio.to_thread(parse_m3u, content)

    if not channels:
        raise HTTPException(status_code=400, detail=get_text(lang, "toast_import_error"))

    if len(channels) > 50000:
        raise HTTPException(status_code=400, detail="Playlist exceeds the maximum limit of 50,000 channels.")

    playlist_id = hashlib.md5(m3u_url.encode()).hexdigest()[:10]

    raw_name = m3u_url.split("/")[-1].split("?")[0]
    if raw_name:
        playlist_name = raw_name
        if is_json and not playlist_name.endswith(".json"):
            playlist_name = f"{playlist_name}.json"
    else:
        playlist_name = f"Sports_{playlist_id}.json" if is_json else f"Playlist_{playlist_id}"

    # Group channels by resolution before saving
    from_json_grouped = await asyncio.to_thread(group_channels_by_resolution, channels)
    await asyncio.to_thread(save_channels_to_db, playlist_id, from_json_grouped)

    playlists = read_json(PLAYLISTS_FILE)
    existing = next((p for p in playlists if p["id"] == playlist_id), None)
    if existing:
        existing["name"] = playlist_name
        existing["url"] = m3u_url
        existing["count"] = len(channels)
        if epg_url and not existing.get("epg_url"):
            existing["epg_url"] = epg_url
    else:
        playlists.append({
            "id": playlist_id,
            "name": playlist_name,
            "url": m3u_url,
            "count": len(channels),
            "epg_url": epg_url
        })
    write_json(PLAYLISTS_FILE, playlists)

    if epg_url:
        background_tasks.add_task(download_and_parse_epg_bg, playlist_id, epg_url)

    return {
        "message": get_text(lang, "toast_import_success", count=len(channels)),
        "playlist_id": playlist_id,
        "count": len(channels),
    }

@app.post("/api/import/file")
async def import_m3u_file(background_tasks: BackgroundTasks, file: UploadFile = File(...), lang: str = "vi"):
    try:
        content_bytes = await file.read()
        if len(content_bytes) > 20 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="Playlist file size exceeds the limit of 20MB.")
        content = content_bytes.decode("utf-8", errors="ignore")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=get_text(lang, "toast_import_error") + f": {str(e)}")
        
    channels = []
    is_json = False
    epg_url = ""
    try:
        json_data = json.loads(content)
        channels = await asyncio.to_thread(parse_sports_json, json_data)
        if channels:
            is_json = True
    except Exception:
        pass

    if not is_json:
        clean_content = content.lstrip("\ufeff")
        lines = clean_content.split("\n")
        if len(lines) > 0 and lines[0].strip().startswith("#EXTM3U"):
            first_line = lines[0]
            if 'x-tvg-url="' in first_line:
                epg_url = first_line.split('x-tvg-url="')[1].split('"')[0]
            elif 'url-tvg="' in first_line:
                epg_url = first_line.split('url-tvg="')[1].split('"')[0]
        channels = await asyncio.to_thread(parse_m3u, clean_content)

    if not channels:
        raise HTTPException(status_code=400, detail=get_text(lang, "toast_import_error"))

    if len(channels) > 50000:
        raise HTTPException(status_code=400, detail="Playlist exceeds the maximum limit of 50,000 channels.")

    playlist_id = hashlib.md5(file.filename.encode("utf-8")).hexdigest()[:10]
    playlist_name = file.filename if file.filename else (f"Sports_{playlist_id}.json" if is_json else f"Playlist_{playlist_id}")

    from_json_grouped = await asyncio.to_thread(group_channels_by_resolution, channels)
    await asyncio.to_thread(save_channels_to_db, playlist_id, from_json_grouped)

    playlists = read_json(PLAYLISTS_FILE)
    existing = next((p for p in playlists if p["id"] == playlist_id), None)
    if existing:
        existing["name"] = playlist_name
        existing["url"] = "local_file"
        existing["count"] = len(channels)
        if epg_url and not existing.get("epg_url"):
            existing["epg_url"] = epg_url
    else:
        playlists.append({
            "id": playlist_id,
            "name": playlist_name,
            "url": "local_file",
            "count": len(channels),
            "epg_url": epg_url
        })
    write_json(PLAYLISTS_FILE, playlists)

    if epg_url:
        background_tasks.add_task(download_and_parse_epg_bg, playlist_id, epg_url)

    return {
        "message": get_text(lang, "toast_import_success", count=len(channels)),
        "playlist_id": playlist_id,
        "count": len(channels),
    }

@app.delete("/api/playlists/{playlist_id}")
async def delete_playlist(playlist_id: str, lang: str = "vi"):
    playlists = read_json(PLAYLISTS_FILE)
    playlists = [p for p in playlists if p["id"] != playlist_id]
    write_json(PLAYLISTS_FILE, playlists)

    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("DELETE FROM channels WHERE playlist_id = ?", (playlist_id,))
        conn.commit()

    epg_file = os.path.join(DATA_DIR, f"epg_{playlist_id}.json")
    if os.path.exists(epg_file):
        os.remove(epg_file)

    return {"message": get_text(lang, "toast_delete_success")}

@app.post("/api/playlists/{playlist_id}/sync")
async def sync_playlist(playlist_id: str, background_tasks: BackgroundTasks, lang: str = "vi"):
    playlists = read_json(PLAYLISTS_FILE)
    playlist = next((p for p in playlists if p["id"] == playlist_id), None)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
        
    m3u_url = playlist.get("url")
    if not m3u_url or m3u_url == "local_file":
        raise HTTPException(status_code=400, detail="Cannot sync local file playlists" if lang == "en" else "Khong the dong bo playlist tu file cuc bo")
        
    headers = {
        "User-Agent": net_settings.get("user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
    }
    
    # Auto-rewrite sharing URLs during sync as well
    if "dropbox.com" in m3u_url:
        if "www.dropbox.com" in m3u_url:
            m3u_url = m3u_url.replace("www.dropbox.com", "dl.dropboxusercontent.com")
        elif "dl.dropboxusercontent.com" not in m3u_url:
            m3u_url = m3u_url.replace("dropbox.com", "dl.dropboxusercontent.com")
        
        if "dl=0" in m3u_url:
            m3u_url = m3u_url.replace("dl=0", "dl=1")
        elif "dl=" not in m3u_url:
            separator = "&" if "?" in m3u_url else "?"
            m3u_url = f"{m3u_url}{separator}dl=1"
            
    elif "drive.google.com" in m3u_url:
        m = re.search(r'/file/d/([^/]+)', m3u_url)
        if m:
            file_id = m.group(1)
            m3u_url = f"https://drive.google.com/uc?export=download&id={file_id}"

    try:
        resp = await shared_client.get(m3u_url, headers=headers)
        resp.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=400, detail=get_text(lang, "toast_import_error") + f": {str(e)}")

    channels = []
    is_json = False
    epg_url = ""
    try:
        json_data = resp.json()
        channels = parse_sports_json(json_data)
        if channels:
            is_json = True
    except Exception:
        pass

    if not is_json:
        content = resp.text.lstrip("\ufeff")
        lines = content.split("\n")
        if len(lines) > 0 and lines[0].strip().startswith("#EXTM3U"):
            first_line = lines[0]
            if 'x-tvg-url="' in first_line:
                epg_url = first_line.split('x-tvg-url="')[1].split('"')[0]
            elif 'url-tvg="' in first_line:
                epg_url = first_line.split('url-tvg="')[1].split('"')[0]
        channels = parse_m3u(content)

    if not channels:
        raise HTTPException(status_code=400, detail=get_text(lang, "toast_import_error"))

    from_json_grouped = group_channels_by_resolution(channels)
    save_channels_to_db(playlist_id, from_json_grouped)

    playlist["count"] = len(channels)
    if epg_url and not playlist.get("epg_url"):
        playlist["epg_url"] = epg_url
        
    write_json(PLAYLISTS_FILE, playlists)

    if epg_url:
        background_tasks.add_task(download_and_parse_epg_bg, playlist_id, epg_url)

    return {
        "message": get_text(lang, "toast_sync_success", count=len(channels)),
        "count": len(channels)
    }

@app.put("/api/playlists/{playlist_id}/rename")
async def rename_playlist(playlist_id: str, new_name: str, lang: str = "vi"):
    playlists = read_json(PLAYLISTS_FILE)
    found = False
    for p in playlists:
        if p["id"] == playlist_id:
            p["name"] = new_name
            found = True
            break
    if not found:
        raise HTTPException(status_code=404, detail="Playlist not found")
    write_json(PLAYLISTS_FILE, playlists)
    return {"message": get_text(lang, "toast_rename_success")}

@app.post("/api/playlists/{playlist_id}/epg")
async def update_playlist_epg(playlist_id: str, epg_url: str, background_tasks: BackgroundTasks, lang: str = "vi"):
    if epg_url and not is_safe_url(epg_url):
        raise HTTPException(status_code=400, detail="SSRF Protection: Local or private network URLs are prohibited.")
    playlists = read_json(PLAYLISTS_FILE)
    playlist = next((p for p in playlists if p["id"] == playlist_id), None)
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    playlist["epg_url"] = epg_url
    write_json(PLAYLISTS_FILE, playlists)
    
    background_tasks.add_task(download_and_parse_epg_bg, playlist_id, epg_url)
    return {"message": get_text(lang, "toast_epg_success")}

# ── API: Channels ────────────────────────────────────────────────────

def group_channels_by_resolution(channels: list[dict]) -> list[dict]:
    grouped = {}
    for ch in channels:
        name = ch.get("name", "Unknown")
        m = re.match(r'^(.*?)\s*[-_\[\(\s]\s*(FHD|1080p|1080|HD|720p|720|SD|480p|480|4K)\s*[\]\)]*$', name, flags=re.IGNORECASE)
        
        base_name = name
        quality = "Default"
        
        if m:
            base_name = m.group(1).strip()
            raw_q = m.group(2).upper()
            if raw_q in ("1080P", "1080"): raw_q = "FHD"
            elif raw_q in ("720P", "720"): raw_q = "HD"
            elif raw_q in ("480P", "480"): raw_q = "SD"
            quality = raw_q
            
        key = (base_name, ch.get("group", ""))
        
        if key not in grouped:
            grouped[key] = {
                "name": base_name,
                "logo": ch.get("logo", ""),
                "group": ch.get("group", ""),
                "url": ch.get("url", ""),
                "status": ch.get("status", "unknown"),
                "qualities": {}
            }
            if "epg_programs" in ch:
                grouped[key]["epg_programs"] = ch["epg_programs"]
                grouped[key]["epg_current_index"] = ch.get("epg_current_index", -1)
            
        grouped[key]["qualities"][quality] = ch.get("url", "")
        
        if "epg_programs" in ch and "epg_programs" not in grouped[key]:
            grouped[key]["epg_programs"] = ch["epg_programs"]
            grouped[key]["epg_current_index"] = ch.get("epg_current_index", -1)
            
        q_order = {"4K": 4, "FHD": 3, "HD": 2, "SD": 1, "Default": 0}
        current_default = "Default"
        for q in grouped[key]["qualities"]:
            if grouped[key]["url"] == grouped[key]["qualities"][q]:
                current_default = q
                break
                
        if q_order.get(quality, 0) > q_order.get(current_default, -1):
            grouped[key]["url"] = ch.get("url", "")
            
    return list(grouped.values())

def save_channels_to_db(playlist_id: str, channels: list[dict]):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        
        c.execute("SELECT url, status FROM channels WHERE playlist_id = ?", (playlist_id,))
        existing_status = {r[0]: r[1] for r in c.fetchall()}
        
        c.execute("DELETE FROM channels WHERE playlist_id = ?", (playlist_id,))
        rows = []
        for ch in channels:
            url = ch.get("url", "")
            status = existing_status.get(url, ch.get("status", "unknown"))
            rows.append((
                playlist_id,
                ch.get("name", ""),
                ch.get("group", ""),
                ch.get("logo", ""),
                url,
                ch.get("tvg_id", ""),
                ch.get("tvg_name", ""),
                ch.get("catchup", ""),
                ch.get("catchup_days", ""),
                ch.get("catchup_source", ""),
                status,
                json.dumps(ch.get("qualities", {}))
            ))
        c.executemany('''
            INSERT INTO channels (
                playlist_id, name, group_title, tvg_logo, url,
                tvg_id, tvg_name, catchup, catchup_days, catchup_source, status, qualities
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', rows)
        conn.commit()

@app.get("/api/groups")
async def get_groups(playlist_id: str):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("SELECT DISTINCT group_title FROM channels WHERE playlist_id = ? ORDER BY group_title", (playlist_id,))
        rows = c.fetchall()
    return [r[0] for r in rows if r[0]]

@app.get("/api/channels/count")
async def get_channels_count(playlist_id: str, search: str = "", group: str = ""):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        query = "SELECT COUNT(*) FROM channels WHERE playlist_id = ?"
        params = [playlist_id]
        if group and group != "Favorites":
            query += " AND group_title = ?"
            params.append(group)
        if search:
            query += " AND name LIKE ?"
            params.append(f"%{search}%")
            
        c.execute(query, params)
        count = c.fetchone()[0]
    return {"count": count}

@app.get("/api/channels")
async def get_channels_virtual(
    playlist_id: str, 
    offset: int = 0, 
    limit: int = 50, 
    search: str = "", 
    group: str = ""
):
    with sqlite3.connect(DB_FILE) as conn:
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        
        query = "SELECT * FROM channels WHERE playlist_id = ?"
        params = [playlist_id]
        
        if group and group != "Favorites":
            query += " AND group_title = ?"
            params.append(group)
            
        if search:
            query += " AND name LIKE ?"
            params.append(f"%{search}%")
            
        query += " LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        
        c.execute(query, params)
        rows = c.fetchall()
        
    channels = []
    for r in rows:
        ch = dict(r)
        ch["logo"] = ch.pop("tvg_logo")
        ch["group"] = ch.pop("group_title")
        if ch.get("qualities"):
            ch["qualities"] = json.loads(ch["qualities"])
        else:
            ch["qualities"] = {}
        channels.append(ch)
    
    epg_data_file = os.path.join(DATA_DIR, f"epg_{playlist_id}.json")
    if os.path.exists(epg_data_file):
        epg_store = get_epg_from_cache(playlist_id, epg_data_file)
        if epg_store:
            channel_names = epg_store.get("channel_names", {})
            epg_data = epg_store.get("epg_data", {})
            
            now_ts = int(time.time())
            for ch in channels:
                epg_info = get_channel_epg(ch, epg_data, channel_names, now_ts)
                if epg_info and epg_info["programs"]:
                    ch["epg_programs"] = epg_info["programs"]
                    ch["epg_current_index"] = epg_info["current_index"]
            
    return channels

EPG_CACHE = {}  # playlist_id -> {"mtime": float, "store": dict}

def get_epg_from_cache(playlist_id: str, epg_data_file: str) -> Optional[dict]:
    try:
        mtime = os.path.getmtime(epg_data_file)
        cached = EPG_CACHE.get(playlist_id)
        if cached and cached["mtime"] == mtime:
            return cached["store"]
        
        with open(epg_data_file, "r", encoding="utf-8") as f:
            store = json.load(f)
        
        EPG_CACHE[playlist_id] = {"mtime": mtime, "store": store}
        return store
    except Exception as e:
        print("Error reading/caching EPG:", e)
        return None

# ── API: Scan channels ───────────────────────────────────────────────

async def verify_hls_playlist(client: httpx.AsyncClient, url: str, headers: dict, depth: int = 0) -> bool:
    if depth > 3:
        return False
    if not is_safe_url(url):
        return False
    try:
        resp = await client.get(url, headers=headers, timeout=3.0, follow_redirects=True)
        if resp.status_code >= 400:
            return False
        content_type = resp.headers.get("content-type", "").lower()
        if "text/html" in content_type:
            return False
            
        body_text = resp.text
        if not body_text.startswith("#EXTM3U"):
            return False
            
        lines = [line.strip() for line in body_text.splitlines() if line.strip()]
        
        # Check if it's a master/variant playlist
        has_sub_playlists = False
        sub_playlist_urls = []
        for line in lines:
            if line.startswith("#EXT-X-STREAM-INF"):
                has_sub_playlists = True
            elif has_sub_playlists and not line.startswith("#"):
                sub_playlist_urls.append(line)
                has_sub_playlists = False
                
        if sub_playlist_urls:
            first_sub_url = urljoin(url, sub_playlist_urls[0])
            return await verify_hls_playlist(client, first_sub_url, headers, depth + 1)
            
        # Check if it's a media playlist containing segments
        has_segment = False
        segment_urls = []
        for line in lines:
            if line.startswith("#EXTINF:"):
                has_segment = True
            elif has_segment and not line.startswith("#"):
                segment_urls.append(line)
                has_segment = False
                
        if segment_urls:
            first_seg_url = urljoin(url, segment_urls[0])
            try:
                seg_resp = await client.head(first_seg_url, headers=headers, timeout=3.0, follow_redirects=True)
                if seg_resp.status_code < 400 and "text/html" not in seg_resp.headers.get("content-type", "").lower():
                    return True
            except Exception:
                pass
            
            # Fallback to GET stream check for headers
            try:
                async with client.stream("GET", first_seg_url, headers=headers, timeout=3.0, follow_redirects=True) as seg_stream:
                    if seg_stream.status_code < 400 and "text/html" not in seg_stream.headers.get("content-type", "").lower():
                        return True
            except Exception:
                pass
                
        return False
    except Exception:
        return False

async def check_channel_url(client: httpx.AsyncClient, channel: dict, semaphore: asyncio.Semaphore) -> dict:
    raw_url = channel.get("url", "")
    url = raw_url
    custom_headers = {}
    if "|" in url:
        parts = url.split("|", 1)
        url = parts[0]
        header_params = parts[1]
        for pair in header_params.split("&"):
            if "=" in pair:
                k, v = pair.split("=", 1)
                custom_headers[urllib.parse.unquote(k)] = urllib.parse.unquote(v)

    headers = {
        "User-Agent": net_settings.get("user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
    }
    for k, v in custom_headers.items():
        headers[k] = v

    if not is_safe_url(url):
        channel["status"] = "dead"
        return channel

    async with semaphore:
        try:
            # Check content type first via HEAD
            resp = await client.head(url, headers=headers, timeout=3.0, follow_redirects=True)
            content_type = resp.headers.get("content-type", "").lower()
            status_code = resp.status_code
        except Exception:
            # Fallback GET stream just for headers
            try:
                async with client.stream("GET", url, headers=headers, timeout=3.0, follow_redirects=True) as stream_resp:
                    content_type = stream_resp.headers.get("content-type", "").lower()
                    status_code = stream_resp.status_code
            except Exception:
                channel["status"] = "dead"
                return channel

        if status_code >= 400 or "text/html" in content_type:
            channel["status"] = "dead"
            return channel

        # Check HLS
        is_m3u8 = "mpegurl" in content_type or url.split("?")[0].endswith(".m3u8")
        if is_m3u8:
            is_valid = await verify_hls_playlist(client, url, headers)
            channel["status"] = "alive" if is_valid else "dead"
        else:
            channel["status"] = "alive"
            
    return channel

from pydantic import BaseModel
from typing import List, Optional

class ScanRequest(BaseModel):
    playlist_id: str
    channel_ids: Optional[List[int]] = None

class ScanState:
    def __init__(self):
        self.playlist_id = ""
        self.total = 0
        self.scanned = 0
        self.failed = 0
        self.running = False

class ScanManager:
    def __init__(self):
        self.input_queue = asyncio.Queue()
        self.result_queue = asyncio.Queue()
        self.workers = []
        self.db_writer_task = None
        self.is_running = False
        
        # Concurrency safety & tracking sets
        self.queued_ids = set()
        self.processing_ids = set()
        
        # Generation token to cancel active scans instantly
        self.scan_generation = 0
        
        # Job State Tracker
        self.state = ScanState()

    def start(self):
        if self.is_running:
            return
        self.is_running = True
        self.workers = [asyncio.create_task(self._worker_loop()) for _ in range(30)]
        self.db_writer_task = asyncio.create_task(self._db_writer_loop())
        print("[SCAN MANAGER] Started 30 workers and 1 DB writer task.")

    async def stop(self):
        """Clean shutdown of background tasks without leaving pending tasks."""
        if not self.is_running:
            return
        self.is_running = False
        
        # Cancel all tasks
        for task in self.workers:
            task.cancel()
        if self.db_writer_task:
            self.db_writer_task.cancel()
            
        # Drain queues
        while not self.input_queue.empty():
            try:
                self.input_queue.get_nowait()
                self.input_queue.task_done()
            except Exception:
                pass
        while not self.result_queue.empty():
            try:
                self.result_queue.get_nowait()
                self.result_queue.task_done()
            except Exception:
                pass
                
        # Wait for cancellation cleanup to finish cleanly
        tasks_to_wait = list(self.workers)
        if self.db_writer_task:
            tasks_to_wait.append(self.db_writer_task)
            
        if tasks_to_wait:
            await asyncio.gather(*tasks_to_wait, return_exceptions=True)
            
        self.workers = []
        self.db_writer_task = None
        self.queued_ids.clear()
        self.processing_ids.clear()
        self.state = ScanState()
        print("[SCAN MANAGER] Cleanly stopped and cancelled all background scan tasks.")

    async def cancel_scan(self):
        """Increments scan generation to discard all processing requests and drains input queue."""
        self.scan_generation += 1
        
        # Drain the input queue
        drained_count = 0
        while not self.input_queue.empty():
            try:
                self.input_queue.get_nowait()
                self.input_queue.task_done()
                drained_count += 1
            except Exception:
                pass
                
        self.queued_ids.clear()
        self.processing_ids.clear()
        self.state.running = False
        self.state.total = 0
        self.state.scanned = 0
        self.state.failed = 0
        print(f"[SCAN MANAGER] Active scan cancelled. Drained {drained_count} items. Generation: {self.scan_generation}.")

    async def add_channels(self, playlist_id: str, channels_list: list, is_manual: bool = False):
        if is_manual and self.state.running and self.state.playlist_id != playlist_id:
            await self.cancel_scan()

        added_count = 0
        for ch in channels_list:
            ch_id = ch.get("id")
            if ch_id and ch_id not in self.queued_ids and ch_id not in self.processing_ids:
                self.queued_ids.add(ch_id)
                queue_item = {
                    "channel": ch,
                    "scan_generation": self.scan_generation,
                    "playlist_id": playlist_id
                }
                await self.input_queue.put(queue_item)
                added_count += 1
                
        if added_count > 0:
            if is_manual:
                # Manual scan: reset counters completely
                self.state.playlist_id = playlist_id
                self.state.total = added_count
                self.state.scanned = 0
                self.state.failed = 0
                self.state.running = True
            else:
                # Auto-scan (viewport): incrementally add to running state
                if not self.state.running:
                    self.state.playlist_id = playlist_id
                    self.state.total = added_count
                    self.state.scanned = 0
                    self.state.failed = 0
                    self.state.running = True
                elif self.state.playlist_id == playlist_id:
                    self.state.total += added_count
            print(f"[SCAN MANAGER] Added {added_count} channels to queue. Generation: {self.scan_generation}. Queue size: {self.input_queue.qsize()}")

    async def _worker_loop(self):
        dummy_sem = asyncio.Semaphore(1)
        while self.is_running:
            try:
                queue_item = await self.input_queue.get()
            except asyncio.CancelledError:
                break
            except Exception:
                continue
            
            channel = queue_item["channel"]
            item_gen = queue_item["scan_generation"]
            playlist_id = queue_item["playlist_id"]
            ch_id = channel.get("id")
            
            if item_gen != self.scan_generation:
                self.input_queue.task_done()
                continue
                
            self.queued_ids.discard(ch_id)
            self.processing_ids.add(ch_id)
            
            try:
                scan_client = get_client(verify=False, timeout=3.0)
                try:
                    res_ch = await check_channel_url(scan_client, channel, dummy_sem)
                finally:
                    await scan_client.aclose()
                
                result_item = {
                    "channel": res_ch,
                    "scan_generation": item_gen,
                    "playlist_id": playlist_id
                }
                await self.result_queue.put(result_item)
            except Exception as e:
                print(f"[SCAN WORKER ERROR] {e}")
                channel["status"] = "dead"
                result_item = {
                    "channel": channel,
                    "scan_generation": item_gen,
                    "playlist_id": playlist_id
                }
                await self.result_queue.put(result_item)
            finally:
                self.input_queue.task_done()

    async def _db_writer_loop(self):
        while self.is_running:
            try:
                first_res = await self.result_queue.get()
                batch = [first_res]
                self.result_queue.task_done()
                
                while not self.result_queue.empty() and len(batch) < 100:
                    try:
                        res = self.result_queue.get_nowait()
                        batch.append(res)
                        self.result_queue.task_done()
                    except asyncio.QueueEmpty:
                        break
                
                valid_batch = []
                discarded_count = 0
                failed_increment = 0
                scanned_increment = 0
                
                for item in batch:
                    item_gen = item["scan_generation"]
                    item_playlist_id = item["playlist_id"]
                    channel = item["channel"]
                    ch_id = channel.get("id")
                    
                    if item_gen != self.scan_generation or (self.state.running and self.state.playlist_id != item_playlist_id):
                        discarded_count += 1
                        self.processing_ids.discard(ch_id)
                        continue
                        
                    valid_batch.append(channel)
                    self.processing_ids.discard(ch_id)
                    
                    if self.state.running and self.state.playlist_id == item_playlist_id:
                        scanned_increment += 1
                        if channel.get("status") == "dead":
                            failed_increment += 1
                
                if valid_batch:
                    now_ts = int(time.time())
                    update_rows = []
                    for ch in valid_batch:
                        ch_id = ch.get("id")
                        status = ch.get("status", "unknown")
                        update_rows.append((status, now_ts, ch_id))
                    
                    try:
                        with sqlite3.connect(DB_FILE) as conn:
                            c = conn.cursor()
                            c.executemany("UPDATE channels SET status = ?, last_checked = ? WHERE id = ?", update_rows)
                            conn.commit()
                    except Exception as e:
                        print(f"[SCAN DB WRITER ERROR] {e}")
                
                if self.state.running:
                    self.state.scanned += scanned_increment
                    self.state.failed += failed_increment
                    if self.state.scanned >= self.state.total:
                        self.state.running = False
                        
                if discarded_count > 0 or valid_batch:
                    print(f"[SCAN DB WRITER] Committed {len(valid_batch)} items, discarded {discarded_count} stale. Progress: {self.state.scanned}/{self.state.total}")
                    
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[SCAN DB WRITER LOOP ERROR] {e}")

scan_manager = ScanManager()

@app.post("/api/scan")
async def scan_channels(req: ScanRequest, lang: str = "vi"):
    scan_manager.start()
    is_manual = (req.channel_ids is None)
    
    if req.channel_ids is not None:
        if not req.channel_ids:
            return {"message": "Empty channel list", "status": "empty"}
            
        with sqlite3.connect(DB_FILE) as conn:
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            now_ts = int(time.time())
            placeholders = ",".join("?" for _ in req.channel_ids)
            query = f"SELECT * FROM channels WHERE id IN ({placeholders}) AND (status = 'unknown' OR last_checked < ?)"
            params = list(req.channel_ids) + [now_ts - 3600]
            c.execute(query, params)
            rows = c.fetchall()
    else:
        with sqlite3.connect(DB_FILE) as conn:
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            now_ts = int(time.time())
            c.execute("SELECT * FROM channels WHERE playlist_id = ? AND (status = 'unknown' OR last_checked < ?)", (req.playlist_id, now_ts - 3600))
            rows = c.fetchall()

    channels = [dict(r) for r in rows]
    if not channels:
        return {"message": get_text(lang, "toast_scan_success", alive=0, dead=0), "status": "completed"}

    await scan_manager.add_channels(req.playlist_id, channels, is_manual=is_manual)
    
    return {
        "message": "Scan started in background",
        "status": "accepted",
        "queued_count": len(channels)
    }

@app.post("/api/scan/cancel")
async def cancel_scan():
    await scan_manager.cancel_scan()
    return {"message": "Scan cancelled successfully", "status": "cancelled"}

@app.get("/api/scan/progress")
async def get_scan_progress(playlist_id: str):
    is_scanning = (scan_manager.state.running and scan_manager.state.playlist_id == playlist_id)
    pct = int((scan_manager.state.scanned / scan_manager.state.total) * 100) if (is_scanning and scan_manager.state.total > 0) else 0
    return {
        "is_scanning": is_scanning,
        "total": scan_manager.state.total if is_scanning else 0,
        "scanned": scan_manager.state.scanned if is_scanning else 0,
        "failed": scan_manager.state.failed if is_scanning else 0,
        "progress_percent": pct,
        "queued_ids": list(scan_manager.queued_ids) if is_scanning else [],
        "processing_ids": list(scan_manager.processing_ids) if is_scanning else []
    }

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app_instance: FastAPI):
    global shared_client
    shared_client = _build_shared_client()
    scan_manager.start()
    yield
    await recording_manager.stop_all()
    await scan_manager.stop()
    await shared_client.aclose()
    shared_client = None

app.router.lifespan_context = lifespan

class ChannelStatusRequest(BaseModel):
    id: int
    status: str

@app.post("/api/channel/status")
async def update_channel_status(req: ChannelStatusRequest):
    with sqlite3.connect(DB_FILE) as conn:
        c = conn.cursor()
        c.execute("UPDATE channels SET status = ? WHERE id = ?", (req.status, req.id))
        conn.commit()
    return {"status": "success"}

# ── API: Export Data ───────────────────────────────────────────────

import re

@app.get("/api/export/playlist")
async def export_playlist(request: Request):
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("SELECT DISTINCT playlist_id FROM channels")
        rows = c.fetchall()
        
        import json
        import urllib.parse
        import re
        
        host_url = str(request.base_url)
        if host_url.endswith("/"):
            host_url = host_url[:-1]
            
        playlist_dir = os.path.join(os.environ.get('USERPROFILE', ''), 'Downloads', 'list_exported', 'playlists')
        os.makedirs(playlist_dir, exist_ok=True)
        
        try:
            playlists_info = read_json(PLAYLISTS_FILE)
        except:
            playlists_info = []
        
        if not rows:
            conn.close()
            return {"status": "success", "path": playlist_dir}
            
        for r in rows:
            playlist_id = r["playlist_id"]
            playlist_name = playlist_id
            
            for p in playlists_info:
                if p.get("id") == playlist_id:
                    playlist_name = p.get("name", playlist_id)
                    break
                    
            sanitized_title = re.sub(r'[\\/*?:"<>|]', "", playlist_name).strip()
            if not sanitized_title:
                sanitized_title = f"playlist_{playlist_id}"
                
            c.execute("SELECT * FROM channels WHERE playlist_id = ?", (playlist_id,))
            channels = c.fetchall()
            
            if not channels:
                continue
                
            lines = ["#EXTM3U"]
            for ch in channels:
                name = ch["name"]
                group = ch["group_title"] or "Uncategorized"
                logo = ch["tvg_logo"] or ""
                ch_id = ch["id"]
                
                try:
                    qualities_dict = json.loads(ch["qualities"]) if ch["qualities"] else {}
                except:
                    qualities_dict = {}
                    
                if not qualities_dict:
                    qualities_dict = {"Auto": ch["url"]}
                    
                for q_label, stream_url in qualities_dict.items():
                    target_url = stream_url
                    req_headers = []
                    
                    if "|" in target_url:
                        parts = target_url.split("|")
                        target_url = parts[0]
                        headers_part = parts[1]
                        for hp in headers_part.split("&"):
                            if "=" in hp:
                                k, v = hp.split("=", 1)
                                req_headers.append({"key": k, "value": v})
                                
                    suffix = ""
                    if q_label and q_label != "Auto" and q_label != "Default" and q_label != "Luồng Gốc (Default)":
                        if " - " in q_label:
                            suffix = f" - {q_label.split(' - ')[-1].strip()}"
                        elif q_label.upper() in ["FHD", "HD", "SD", "4K"]:
                            suffix = f" - {q_label.upper()}"
                        else:
                            suffix = f" - {q_label}"
                            
                    display_name = f"{name}{suffix}"
                    
                    lines.append(f'#EXTINF:-1 tvg-id="{ch_id}" tvg-logo="{logo}" group-title="{group}",{display_name}')
                    
                    if req_headers:
                        for h in req_headers:
                            h_key = h["key"].strip().lower()
                            h_val = h["value"].strip()
                            if h_key == "referer":
                                lines.append(f'#EXTVLCOPT:http-referrer={h_val}')
                            elif h_key == "user-agent":
                                lines.append(f'#EXTVLCOPT:http-user-agent={h_val}')
                                
                    transcode_proxy_url = f"{host_url}/api/transcode?url={urllib.parse.quote(target_url)}"
                    if req_headers:
                        transcode_proxy_url += f"&headers={urllib.parse.quote(json.dumps(req_headers))}"
                        
                    transcode_proxy_url += f"&token={APP_TOKEN}"
                    
                    lines.append(transcode_proxy_url)
                    
            content = "\\n".join(lines)
            filepath = os.path.join(playlist_dir, f"{sanitized_title}.m3u")
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(content)
                
        conn.close()
        return {"status": "success", "path": playlist_dir}
    except Exception as e:
        print(f"Export Error: {e}")
        return {"status": "error", "message": str(e)}

from datetime import datetime
@app.get("/api/export/epg")
async def export_epg(request: Request):
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("SELECT DISTINCT playlist_id FROM channels")
        playlists = c.fetchall()
        
        downloads_dir = os.path.join(os.environ.get('USERPROFILE', ''), 'Downloads', 'list_exported', 'schedules')
        os.makedirs(downloads_dir, exist_ok=True)
        
        lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="IPTV v2">']
        
        c.execute("SELECT tvg_id, tvg_name, name FROM channels")
        all_channels = c.fetchall()
        conn.close()
        
        chan_seen = set()
        for ch in all_channels:
            cid = ch["tvg_id"] or ch["tvg_name"] or ch["name"]
            if cid and cid not in chan_seen:
                chan_seen.add(cid)
                lines.append(f'  <channel id="{cid}">')
                lines.append(f'    <display-name>{ch["name"]}</display-name>')
                lines.append(f'  </channel>')
                
        import json
        from datetime import datetime
        for p in playlists:
            playlist_id = p["playlist_id"]
            epg_file = os.path.join(DATA_DIR, f"epg_{playlist_id}.json")
            if os.path.exists(epg_file):
                try:
                    with open(epg_file, "r", encoding="utf-8") as f:
                        epg_store = json.load(f)
                    
                    epg_data = epg_store.get("epg_data", {})
                    for chan_id, programs in epg_data.items():
                        for prog in programs:
                            start_ts = prog.get("start", 0)
                            stop_ts = prog.get("stop", 0)
                            if start_ts == 0 or stop_ts == 0:
                                continue
                                
                            start_dt = datetime.fromtimestamp(start_ts)
                            end_dt = datetime.fromtimestamp(stop_ts)
                            start_str = start_dt.strftime("%Y%m%d%H%M%S +0700")
                            end_str = end_dt.strftime("%Y%m%d%H%M%S +0700")
                            
                            lines.append(f'  <programme start="{start_str}" stop="{end_str}" channel="{chan_id}">')
                            title = prog.get("title", "")
                            lines.append(f'    <title lang="vi">{title}</title>')
                            desc = prog.get("desc", "")
                            if desc:
                                lines.append(f'    <desc lang="vi">{desc}</desc>')
                            lines.append(f'  </programme>')
                except Exception as e:
                    print(f"Error reading EPG {playlist_id}: {e}")
                    
        lines.append('</tv>')
        
        content = "\\n".join(lines)
        filepath = os.path.join(downloads_dir, "iptv_export_epg.xml")
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
            
        return {"status": "success", "path": filepath}
    except Exception as e:
        print(f"Export Error: {e}")
        return {"status": "error", "message": str(e)}

# ── API: Proxy Stream ───────────────────────────────────────────────

def _get_origin(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"

from transcoder import engine as transcoder_engine

@app.post("/api/transcode/init")
async def transcode_stream_init(request: Request):
    data = await request.json()
    url = data.get("url")
    headers = data.get("headers")
    
    headers_str = ""
    raw_url = url
    if "|" in url:
        parts = url.split("|", 1)
        raw_url = parts[0]
        header_suffix = parts[1]
        for pair in header_suffix.split("&"):
            if "=" in pair:
                k, v = pair.split("=", 1)
                headers_str += f"{urllib.parse.unquote(k)}: {urllib.parse.unquote(v)}\r\n"
    
    if not is_safe_url(raw_url):
        return {"status": "error", "message": "SSRF Protection: Local or private network URLs are prohibited."}

    if headers and headers.strip() not in ("", "[]", "null"):
        try:
            import json
            parsed_headers = json.loads(headers)
            if isinstance(parsed_headers, list) and len(parsed_headers) > 0:
                for header in parsed_headers:
                    if isinstance(header, dict) and 'key' in header and 'value' in header:
                        headers_str += f"{header['key']}: {header['value']}\r\n"
                    elif isinstance(header, str):
                        headers_str += f"{header}\r\n"
        except Exception:
            pass

    try:
        session_id = transcoder_engine.start_session(raw_url, headers_str)
        return {"status": "success", "session_id": session_id, "url": f"/api/hls/{session_id}/playlist.m3u8"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/transcode/stop")
async def transcode_stream_stop(request: Request):
    data = await request.json()
    session_id = data.get("session_id")
    if session_id:
        transcoder_engine.stop_session(session_id)
        return {"status": "success"}
    return {"status": "error", "message": "Session ID required"}

@app.get("/api/hls/{session_id}/{filename}")
async def serve_transcode_hls(session_id: str, filename: str):
    import os
    import asyncio
    HLS_TEMP_DIR = os.path.join(app_data_dir, 'hls_temp')
    file_path = os.path.join(HLS_TEMP_DIR, session_id, filename)
    
    if not os.path.exists(file_path):
        if filename == "playlist.m3u8":
            status_info = transcoder_engine.get_session_status(session_id)
            if status_info.get("status") == "failed":
                print(f"[TRANSCODE SESSION FAILED] {status_info.get('message')}")
                raise HTTPException(status_code=503, detail=status_info.get("message", "Transcode session failed"))
        raise HTTPException(status_code=404, detail="File not found")
        
    if filename.endswith(".m3u8"):
        media_type = "application/vnd.apple.mpegurl"
    elif filename.endswith(".mp4") or filename.endswith(".m4s"):
        media_type = "video/mp4"
    else:
        media_type = "video/MP2T"
    return FileResponse(file_path, media_type=media_type)

@app.get("/api/proxy")
async def proxy_stream(url: str, request: Request):
    custom_headers = {}
    header_suffix = ""
    if "|" in url:
        parts = url.split("|", 1)
        url = parts[0]
        header_suffix = parts[1]
        for pair in header_suffix.split("&"):
            if "=" in pair:
                k, v = pair.split("=", 1)
                custom_headers[urllib.parse.unquote(k)] = urllib.parse.unquote(v)

    origin = _get_origin(url)
    headers = {
        "User-Agent": net_settings.get("user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"),
        "Accept": "*/*",
        "Referer": origin + "/",
        "Origin": origin,
    }

    for k, v in custom_headers.items():
        headers[k] = v

    if "range" in request.headers:
        headers["Range"] = request.headers["range"]

    client = get_client(verify=False, timeout=httpx.Timeout(60.0, connect=10.0), follow_redirects=True)

    try:
        max_retries = 3
        resp = None
        for attempt in range(max_retries):
            try:
                resp = await client.send(
                    client.build_request("GET", url, headers=headers),
                    stream=True,
                )
                if resp.status_code >= 500 and attempt < max_retries - 1:
                    await resp.aclose()
                    await asyncio.sleep(1)
                    continue
                break
            except httpx.RequestError as e:
                if attempt < max_retries - 1:
                    await asyncio.sleep(1)
                    continue
                raise e

        content_type = resp.headers.get("content-type", "")
        cors = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "*",
        }

        if "text/html" in content_type.lower():
            body = await resp.aread()
            await resp.aclose()
            await client.aclose()
            print("HTML error response:", body.decode("utf-8", errors="ignore")[:500])
            return Response(
                status_code=502,
                content=f"Server returned HTML instead of video stream.",
                headers=cors,
            )

        if resp.status_code >= 400:
            await resp.aclose()
            await client.aclose()
            print("Upstream error code:", resp.status_code)
            return Response(
                status_code=resp.status_code,
                content=f"Upstream HTTP Error {resp.status_code}",
                headers=cors,
            )

        is_m3u8 = "mpegurl" in content_type.lower() or url.split("?")[0].endswith(".m3u8")
        if is_m3u8:
            body = await resp.aread()
            await resp.aclose()
            await client.aclose()

            text = body.decode("utf-8", errors="ignore")
            rewritten = _rewrite_m3u8(text, str(resp.url), header_suffix)

            return Response(
                content=rewritten,
                media_type="application/vnd.apple.mpegurl",
                headers=cors,
            )
        else:
            async def generate():
                try:
                    async for chunk in resp.aiter_bytes(chunk_size=65536):
                        yield chunk
                finally:
                    await resp.aclose()
                    await client.aclose()

            # Build safe response headers: keep upstream headers but strip
            # Content-Length (often wrong for live streams) to use chunked transfer
            safe_headers = dict(cors)
            for k, v in resp.headers.items():
                k_lower = k.lower()
                if k_lower not in ('content-length', 'content-encoding', 'transfer-encoding', 'connection'):
                    safe_headers[k] = v

            return StreamingResponse(
                generate(),
                media_type=content_type or "video/mp2t",
                status_code=resp.status_code,
                headers=safe_headers,
            )

    except Exception as e:
        await client.aclose()
        import traceback
        traceback.print_exc()
        return Response(
            status_code=502,
            content=f"Proxy error: {e}",
            headers={"Access-Control-Allow-Origin": "*"},
        )

def _rewrite_m3u8(text: str, base_url: str, header_suffix: str = "") -> str:
    lines = text.splitlines()
    result = []

    for line in lines:
        stripped = line.strip()

        if stripped and not stripped.startswith("#"):
            absolute = urljoin(base_url, stripped)
            if header_suffix:
                absolute = f"{absolute}|{header_suffix}"
            result.append(f"/api/proxy?url={urllib.parse.quote(absolute, safe='')}")

        elif 'URI="' in stripped:
            def replace_uri(m):
                orig = m.group(1)
                absolute = urljoin(base_url, orig)
                if header_suffix:
                    absolute = f"{absolute}|{header_suffix}"
                return f'URI="/api/proxy?url={urllib.parse.quote(absolute, safe="")}"'

            result.append(re.sub(r'URI="([^"]+)"', replace_uri, stripped))
        else:
            result.append(line)

    return "\n".join(result)

# ── API: Recording ──────────────────────────────────────────────────

class RecordingManager:
    """Manages active FFmpeg recording processes under a unified lifecycle.
    Tracks state: RECORDING, STOPPING, REMUXING, READY, FAILED."""
    def __init__(self):
        self.active_recordings = {}
        self.lock = asyncio.Lock()

    async def start(self, url: str, channel_name: str, filepath: str = None) -> dict:
        async with self.lock:
            if url in self.active_recordings:
                return {"status": "error", "message": "Already recording"}
            
            try:
                import imageio_ffmpeg
                ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
            except Exception:
                return {"status": "error", "message": "FFmpeg not available"}
            
            # Generate filepath as .ts (safer for crash recovery)
            if not filepath:
                recordings_dir = os.path.join(os.path.expanduser('~'), "Videos", "iptv_v2_records")
                os.makedirs(recordings_dir, exist_ok=True)
                safe_name = "".join([c for c in channel_name if c.isalpha() or c.isdigit() or c==' ']).rstrip()
                if not safe_name:
                    safe_name = "recording"
                filename = f"{safe_name}_{int(time.time())}.ts"
                filepath = os.path.join(recordings_dir, filename)
            else:
                filepath = os.path.splitext(filepath)[0] + ".ts"

            headers_str = "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n"
            raw_url = url
            if '|' in url:
                parts = url.split('|', 1)
                raw_url = parts[0]
                header_suffix = parts[1]
                for pair in header_suffix.split("&"):
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        headers_str += f"{urllib.parse.unquote(k)}: {urllib.parse.unquote(v)}\r\n"
            
            codec = transcoder_engine.probe_codec(raw_url, ffmpeg_exe)
            
            cmd = [
                ffmpeg_exe,
                *([ "-http_proxy", net_settings["proxy"] ] if net_settings.get("proxy") else []),
                "-y",
                "-headers", headers_str,
                "-i", raw_url,
                "-map", "0:v:0?",
                "-map", "0:a:0?",
            ]
            
            if codec == "h264":
                cmd.extend(["-c:v", "copy"])
            else:
                cmd.extend(["-vf", "yadif=deint=interlaced", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18"])
                
            cmd.extend([
                "-c:a", "aac",
                "-b:a", "192k",
                "-f", "mpegts",
                filepath
            ])
            
            creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            try:
                process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    creationflags=creationflags
                )
                self.active_recordings[url] = {
                    "process": process,
                    "filepath": filepath,
                    "channel_name": channel_name,
                    "start_time": int(time.time())
                }
                
                # Insert into DB with status = 'recording'
                try:
                    with sqlite3.connect(DB_FILE) as conn:
                        c = conn.cursor()
                        c.execute(
                            "INSERT INTO recordings (channel_name, filepath, record_type, start_time, status) VALUES (?, ?, ?, ?, 'recording')",
                            (channel_name, filepath, "background", int(time.time()))
                        )
                        conn.commit()
                except Exception as db_err:
                    print("DB Insert Error:", db_err)
                
                # Start monitor task
                asyncio.create_task(self._monitor_recording(url, process, filepath))
                return {"status": "success", "message": f"Started recording {channel_name}"}
            except Exception as e:
                return {"status": "error", "message": f"Failed to start: {str(e)}"}

    async def _monitor_recording(self, url: str, proc, ts_path: str):
        await proc.wait()
        async with self.lock:
            # Only trigger remux if it's still the active process in active_recordings
            if url in self.active_recordings and self.active_recordings[url]["process"] == proc:
                self.active_recordings.pop(url, None)
                if ts_path and os.path.exists(ts_path):
                    mp4_path = os.path.splitext(ts_path)[0] + ".mp4"
                    with sqlite3.connect(DB_FILE) as conn:
                        conn.execute("UPDATE recordings SET status = 'processing' WHERE filepath = ?", (ts_path,))
                        conn.commit()
                    # Trigger remux
                    asyncio.create_task(_background_remux(ts_path, mp4_path))

    async def stop(self, url: str) -> dict:
        async with self.lock:
            if url not in self.active_recordings:
                return {"status": "error", "message": "No active recording found for this URL"}
            
            info = self.active_recordings.pop(url)
            process = info["process"]
            filepath = info["filepath"]

        # Outside lock to prevent blocking
        try:
            if process.stdin:
                process.stdin.write(b'q\n')
                await process.stdin.drain()
            try:
                await asyncio.wait_for(process.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                process.terminate()
                await process.wait()
        except Exception:
            pass

        if filepath and os.path.exists(filepath):
            mp4_path = os.path.splitext(filepath)[0] + ".mp4"
            with sqlite3.connect(DB_FILE) as conn:
                conn.execute("UPDATE recordings SET status = 'processing' WHERE filepath = ?", (filepath,))
                conn.commit()
            asyncio.create_task(_background_remux(filepath, mp4_path))
            
        return {"status": "success", "message": "Recording saved"}

    async def stop_all(self):
        """Stops all active recordings safely during application shutdown."""
        async with self.lock:
            active_items = list(self.active_recordings.values())
            self.active_recordings.clear()

        for info in active_items:
            process = info["process"]
            filepath = info["filepath"]
            try:
                if process.stdin:
                    process.stdin.write(b'q\n')
                    await process.stdin.drain()
                try:
                    await asyncio.wait_for(process.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    process.terminate()
                    await process.wait()
            except Exception:
                pass
            
            if filepath and os.path.exists(filepath):
                try:
                    with sqlite3.connect(DB_FILE) as conn:
                        conn.execute("UPDATE recordings SET status = 'failed' WHERE filepath = ?", (filepath,))
                        conn.commit()
                except Exception:
                    pass

    def get_active_urls(self) -> list:
        return list(self.active_recordings.keys())

recording_manager = RecordingManager()

async def _background_remux(ts_filepath, mp4_filepath):
    """Remux .ts → .mp4 with faststart, then delete .ts and update DB.
    Flow: TS → FFmpeg copy → MP4 → delete TS → status=ready"""
    import os, asyncio, subprocess
    
    try:
        import imageio_ffmpeg
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:
        print(f"[REMUX ERROR] FFmpeg not available: {e}")
        with sqlite3.connect(DB_FILE) as conn:
            conn.execute("UPDATE recordings SET status = 'failed' WHERE filepath = ? OR filepath = ?", (ts_filepath, mp4_filepath))
            conn.commit()
        return
    
    try:
        cmd = [
            ffmpeg_exe, "-y",
            "-i", ts_filepath,
            "-c", "copy",
            "-movflags", "+faststart",
            mp4_filepath
        ]
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        remux_proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            creationflags=creationflags
        )
        await remux_proc.wait()
        
        if remux_proc.returncode == 0 and os.path.exists(mp4_filepath):
            # Success: delete TS, update DB to MP4 path
            try:
                os.remove(ts_filepath)
            except Exception:
                pass
            
            duration_sec = 0
            dur_str = get_video_duration(mp4_filepath)
            if dur_str and dur_str != '??:??':
                parts = dur_str.split(':')
                if len(parts) == 3:
                    duration_sec = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                elif len(parts) == 2:
                    duration_sec = int(parts[0]) * 60 + int(parts[1])
            
            with sqlite3.connect(DB_FILE) as conn:
                conn.execute(
                    "UPDATE recordings SET status = 'ready', filepath = ?, duration = ? WHERE filepath = ?",
                    (mp4_filepath, duration_sec, ts_filepath)
                )
                conn.commit()
            print(f"[REMUX SUCCESS] {os.path.basename(ts_filepath)} → {os.path.basename(mp4_filepath)} ({dur_str})")
        else:
            # Remux failed but TS still exists — mark as failed
            print(f"[REMUX FAILED] FFmpeg returned code {remux_proc.returncode}")
            with sqlite3.connect(DB_FILE) as conn:
                conn.execute("UPDATE recordings SET status = 'failed' WHERE filepath = ?", (ts_filepath,))
                conn.commit()
    except Exception as e:
        print(f"[REMUX ERROR] {e}")
        with sqlite3.connect(DB_FILE) as conn:
            conn.execute("UPDATE recordings SET status = 'failed' WHERE filepath = ?", (ts_filepath,))
            conn.commit()

@app.post("/api/record/start")
async def start_recording(request: Request):
    data = await request.json()
    url = data.get("url")
    channel_name = data.get("channel_name", "Unknown")
    filepath = data.get("filepath")
    
    if not url:
        return {"status": "error", "message": "Missing URL"}
        
    return await recording_manager.start(url, channel_name, filepath)

@app.post("/api/record/stop")
async def stop_recording(request: Request):
    data = await request.json()
    url = data.get("url")
    if not url:
        return {"status": "error", "message": "Missing URL"}
        
    return await recording_manager.stop(url)

def get_video_duration(filepath):
    try:
        import imageio_ffmpeg
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        cmd = [ffmpeg_exe, "-i", filepath]
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        proc = subprocess.run(cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, creationflags=creationflags, timeout=2.0)
        output = proc.stderr.decode("utf-8", errors="ignore")
        import re
        m = re.search(r"Duration:\s*(\d{2}):(\d{2}):(\d{2})\.\d+", output)
        if m:
            h, m, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
            return f"{h:02d}:{m:02d}:{s:02d}" if h > 0 else f"{m:02d}:{s:02d}"
    except Exception as e:
        pass
    return "??:??"

@app.get("/api/recordings")
def get_recordings():
    try:
        with sqlite3.connect(DB_FILE) as conn:
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute("SELECT * FROM recordings ORDER BY start_time DESC")
            rows = c.fetchall()
            
            result = []
            for row in rows:
                filepath = row["filepath"]
                
                # Try DB status first
                try:
                    status = row["status"] or "ready"
                except (IndexError, KeyError):
                    status = "ready"
                
                # Skip if file doesn't exist and not currently recording/processing
                if not os.path.exists(filepath):
                    # Maybe the .ts was remuxed to .mp4 — check mp4 path
                    mp4_path = os.path.splitext(filepath)[0] + ".mp4"
                    if os.path.exists(mp4_path):
                        filepath = mp4_path
                    elif status in ('ready', 'failed'):
                        continue
                    else:
                        continue
                
                size_bytes = os.path.getsize(filepath)
                if size_bytes < 1000000:
                    size_str = f"{size_bytes / 1024:.1f} KB"
                else:
                    size_str = f"{size_bytes / 1024 / 1024:.1f} MB"
                
                # Use DB duration if available, otherwise probe
                try:
                    duration_sec = row["duration"] or 0
                except (IndexError, KeyError):
                    duration_sec = 0
                
                if duration_sec > 0:
                    h = duration_sec // 3600
                    m = (duration_sec % 3600) // 60
                    s = duration_sec % 60
                    duration = f"{h:02d}:{m:02d}:{s:02d}" if h > 0 else f"{m:02d}:{s:02d}"
                else:
                    duration = get_video_duration(filepath) if status == 'ready' else '...'
                
                result.append({
                    "id": row["id"],
                    "channel_name": row["channel_name"],
                    "filepath": filepath,
                    "filename": os.path.basename(filepath),
                    "record_type": row["record_type"],
                    "start_time": row["start_time"],
                    "size": size_str,
                    "duration": duration,
                    "status": status
                })
            return {"status": "success", "data": result}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/recordings/status/{recording_id}")
def check_recording_status(recording_id: int):
    try:
        with sqlite3.connect(DB_FILE) as conn:
            conn.row_factory = sqlite3.Row
            rec = conn.execute("SELECT filepath, status FROM recordings WHERE id = ?", (recording_id,)).fetchone()
            
        if not rec:
            return {"status": "error", "message": "Not found"}
            
        try:
            status = rec["status"] or "ready"
        except (IndexError, KeyError):
            status = "ready"
        return {"status": status}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/recordings/play/{recording_id}")
async def play_recording(recording_id: int):
    while True:
        with sqlite3.connect(DB_FILE) as conn:
            conn.row_factory = sqlite3.Row
            rec = conn.execute("SELECT * FROM recordings WHERE id = ?", (recording_id,)).fetchone()
            
        if not rec:
            raise HTTPException(status_code=404, detail="File not found")
            
        try:
            status = rec["status"]
        except IndexError:
            status = "ready"
            
        if status == 'processing':
            await asyncio.sleep(1.0)
            continue
            
        if not os.path.exists(rec["filepath"]):
            raise HTTPException(status_code=404, detail="File not found")
            
        return FileResponse(rec["filepath"])

@app.post("/api/recordings/rename")
async def rename_recording(request: Request):
    data = await request.json()
    rec_id = data.get("id")
    new_name = data.get("new_name")
    
    if not rec_id or not new_name:
        return {"status": "error", "message": "Missing parameters"}
        
    try:
        with sqlite3.connect(DB_FILE) as conn:
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            c.execute("SELECT filepath FROM recordings WHERE id = ?", (rec_id,))
            row = c.fetchone()
            if not row:
                return {"status": "error", "message": "Recording not found in DB"}
            
            old_path = row["filepath"]
            if not os.path.exists(old_path):
                return {"status": "error", "message": "File not found on disk"}
                
            dir_name = os.path.dirname(old_path)
            ext = os.path.splitext(old_path)[1]
            if not new_name.lower().endswith(ext.lower()):
                new_name += ext
                
            new_path = os.path.join(dir_name, new_name)
            
            if os.path.exists(new_path) and old_path.lower() != new_path.lower():
                return {"status": "error", "message": "A file with that name already exists"}
                
            os.rename(old_path, new_path)
            
            c.execute("UPDATE recordings SET filepath = ? WHERE id = ?", (new_path, rec_id))
            conn.commit()
            
            return {"status": "success", "message": "File renamed"}
    except Exception as e:
        return {"status": "error", "message": str(e)}
    
    return {"status": "error", "message": "Not recording"}

@app.get("/api/record/status")
async def record_status():
    return {"active_urls": recording_manager.get_active_urls()}

@app.post("/api/record/save_ts")
async def save_ts_segments(request: Request):
    data = await request.json()
    urls = data.get("urls", [])
    filepath = data.get("filepath")
    
    if not urls or not filepath:
        return {"status": "error", "message": "Missing urls or filepath"}
        
    async def download_task():
        headers = {
            "User-Agent": net_settings.get("user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"),
            "Accept": "*/*"
        }
        client = get_client(verify=False, timeout=httpx.Timeout(30.0, connect=10.0), follow_redirects=True, headers=headers)
        try:
            with open(filepath, 'wb') as f:
                for u in urls:
                    try:
                        # Extract real URL if wrapped in proxy
                        if "/api/proxy" in u and "url=" in u:
                            import urllib.parse
                            parsed = urllib.parse.urlparse(u)
                            qs = urllib.parse.parse_qs(parsed.query)
                            if 'url' in qs:
                                u = qs['url'][0]
                                
                        real_url = u.split('|')[0] if '|' in u else u
                        
                        resp = await client.get(real_url)
                        if resp.status_code == 200:
                            f.write(resp.content)
                        else:
                            print(f"Error {resp.status_code} downloading TS chunk {real_url}")
                    except Exception as e:
                        print(f"Error downloading TS chunk {u}: {e}")
        except Exception as e:
            print(f"Error saving TS file: {e}")
        finally:
            await client.aclose()
            
    # Run in background so we don't block the API
    asyncio.create_task(download_task())
    return {"status": "success", "message": "Started downloading TS segments"}

@app.post("/api/record/save_blob")
async def save_blob(request: Request):
    try:
        form = await request.form()
        filepath = form.get("filepath")
        file = form.get("file")
        if not filepath or not file:
            return {"status": "error", "message": "Missing file or filepath"}

        # Persist binary asset to storage layout
        with open(filepath, "wb") as f:
            f.write(await file.read())

        # Synchronously insert recording transaction into sqlite table layout
        filename = os.path.basename(filepath)
        channel_name = filename.split('_session_')[0].replace('_', ' ')
        with sqlite3.connect(DB_FILE) as conn:
            c = conn.cursor()
            c.execute(
                "INSERT INTO recordings (channel_name, filepath, record_type, start_time) VALUES (?, ?, ?, ?)",
                (channel_name, filepath, "session", int(time.time()))
            )
            conn.commit()

        return {"status": "success", "message": "Video saved successfully!"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# ── Auto-Migrate Old JSON Data to SQLite ────────────────────────────
def auto_migrate():
    try:
        with sqlite3.connect(DB_FILE) as conn:
            c = conn.cursor()
            c.execute("SELECT COUNT(*) FROM channels")
            count = c.fetchone()[0]
            if count > 0:
                return
    except Exception:
        return

    print("Auto-migrating JSON to SQLite...")
    for filename in os.listdir(DATA_DIR):
        if filename.startswith("channels_") and filename.endswith(".json"):
            playlist_id = filename[9:-5]
            filepath = os.path.join(DATA_DIR, filename)
            try:
                channels = read_json(filepath)
                if channels:
                    print(f"Migrating playlist {playlist_id}...")
                    from_json_grouped = group_channels_by_resolution(channels)
                    save_channels_to_db(playlist_id, from_json_grouped)
                    os.rename(filepath, filepath + ".bak")
            except Exception as e:
                print(f"Failed to migrate {filename}: {e}")

auto_migrate()

# The static mount has been moved to the bottom of the file

import hashlib
import time

@app.get("/api/guest/status")
async def guest_status():
    global guest_lockout_until
    current_time = int(time.time())
    
    if current_time < guest_lockout_until:
        return {"is_activated": False, "lockout_until": guest_lockout_until}
        
    if DEBUG_GUEST_MODE:
        return {"is_activated": False}
    
    with sqlite3.connect(DB_FILE) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT setting_value FROM app_settings WHERE setting_key = 'guest_expiry_time'")
        row_time = cursor.fetchone()
        cursor.execute("SELECT setting_value FROM app_settings WHERE setting_key = 'guest_expiry_signature'")
        row_sig = cursor.fetchone()
        
    if not row_time or not row_sig:
        if current_time < guest_lockout_until:
            return {"is_activated": False, "lockout_until": guest_lockout_until}
        return {"is_activated": False}
        
    extracted_timestamp = row_time['setting_value']
    extracted_sig = row_sig['setting_value']
    
    computed_hash = hashlib.sha256(f"{extracted_timestamp}_{SECRET_SALT_MASK}".encode('utf-8')).hexdigest()
    
    if computed_hash != extracted_sig:
        print("Security Alert: Local database tampering detected!")
        with sqlite3.connect(DB_FILE) as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM app_settings WHERE setting_key IN ('guest_expiry_time', 'guest_expiry_signature')")
            conn.commit()
        if current_time < guest_lockout_until:
            return {"is_activated": False, "lockout_until": guest_lockout_until}
        return {"is_activated": False}
        
    try:
        expiry_time = int(extracted_timestamp)
    except:
        return {"is_activated": False}
        
    if current_time > expiry_time:
        return {"is_activated": False}
        
    days_remaining = int((expiry_time - current_time) / (24 * 60 * 60))
    from datetime import datetime
    expiry_date_str = datetime.fromtimestamp(expiry_time).strftime('%d/%m/%Y')
    return {"is_activated": True, "days_remaining": days_remaining, "expiry_date": expiry_date_str}

@app.post("/api/guest/verify-code")
async def verify_guest_code(request: Request):
    global guest_failed_attempts, guest_lockout_until
    current_time = int(time.time())
    
    if current_time < guest_lockout_until:
        return {"status": "error", "message": f"Too many attempts. Lockout until {guest_lockout_until}.", "lockout_until": guest_lockout_until}
        
    payload = await request.json()
    code = payload.get("code", "")
    
    if code != "GUEST-3M-2026":
        guest_failed_attempts += 1
        if guest_failed_attempts >= 5:
            lockout_duration = 10
            guest_lockout_until = current_time + lockout_duration
            return {"status": "error", "message": "Too many failures. Locked for a while.", "lockout_until": guest_lockout_until}
        return {"status": "error", "message": "Invalid code."}
        
    guest_failed_attempts = 0
    guest_lockout_until = 0
    expiry_epoch = current_time + (90 * 24 * 60 * 60)
    expiry_str = str(expiry_epoch)
    signature = hashlib.sha256(f"{expiry_str}_{SECRET_SALT_MASK}".encode('utf-8')).hexdigest()
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO app_settings (setting_key, setting_value) VALUES (?, ?)", ("guest_expiry_time", expiry_str))
        cursor.execute("INSERT OR REPLACE INTO app_settings (setting_key, setting_value) VALUES (?, ?)", ("guest_expiry_signature", signature))
        conn.commit()
        
    from datetime import datetime
    expiry_date_str = datetime.fromtimestamp(expiry_epoch).strftime('%d/%m/%Y')
    return {"status": "success", "expiry_date": expiry_date_str}

# ── Mount static files (phải ở cuối) ────────────────────────────────
app.mount("/", StaticFiles(directory=os.path.join(BASE_DIR, "static"), html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    import threading

    try:
        import webview
        USE_WEBVIEW = True
    except ImportError:
        USE_WEBVIEW = False

    if USE_WEBVIEW:
        import time
        def start_server():
            uvicorn.run(app, host="127.0.0.1", port=8001, log_level="info", access_log=False)
        
        server_thread = threading.Thread(target=start_server, daemon=True)
        server_thread.start()
        
        import socket
        import sys
        
        # Active polling health-check loop (up to 10 seconds, 100ms intervals)
        max_retries = 100
        server_ready = False
        for i in range(max_retries):
            if not server_thread.is_alive():
                break
            try:
                with socket.create_connection(("127.0.0.1", 8001), timeout=0.1):
                    server_ready = True
                    break
            except OSError:
                time.sleep(0.1)
                
        if not server_ready:
            print("ERROR: FastAPI server failed to start or bind to port 8001 within the timeout.", file=sys.stderr)
            print("Port 8001 might be in TIME_WAIT from a previous session or blocked. Exiting.", file=sys.stderr)
            sys.exit(1)
        
        class Api:
            def terminate_application(self):
                import os
                os._exit(0)
                
            def get_token(self):
                return APP_TOKEN
                
            def toggle_fullscreen(self):
                import webview
                if webview.windows:
                    webview.windows[0].toggle_fullscreen()
                    
            def choose_save_location(self, default_filename):
                import webview
                import os
                if webview.windows:
                    default_dir = os.path.join(os.path.expanduser('~'), "Videos", "iptv_v2_records")
                    os.makedirs(default_dir, exist_ok=True)
                    result = webview.windows[0].create_file_dialog(
                        webview.SAVE_DIALOG,
                        directory=default_dir,
                        save_filename=default_filename,
                        file_types=('Video Files (*.mp4)', 'All Files (*.*)')
                    )
                    if result and len(result) > 0:
                        return result[0]
                return None
                    
        api = Api()
        
        print("Starting Desktop App (pywebview)...")
        webview.create_window("IPTV v2", "http://127.0.0.1:8001", width=1280, height=720, background_color="#07090e", js_api=api)
        webview.start()
    else:
        uvicorn.run("app:app", host="0.0.0.0", port=8001, reload=True, reload_dirs=[os.path.dirname(os.path.abspath(__file__))], access_log=False)