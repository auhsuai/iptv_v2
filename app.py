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
import time
import urllib.parse
import xml.etree.ElementTree as ET
from typing import List, Optional
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, UploadFile, File
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI()

if getattr(sys, 'frozen', False):
    BASE_DIR = sys._MEIPASS
    DATA_DIR = os.path.join(os.environ.get('APPDATA', os.path.expanduser("~")), 'IPTV_v2', 'data')
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    DATA_DIR = os.path.join(BASE_DIR, "data")

os.makedirs(DATA_DIR, exist_ok=True)

PLAYLISTS_FILE = os.path.join(DATA_DIR, "playlists.json")
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
    try:
        if is_bytes:
            if xml_content_or_path.startswith(b'\x1f\x8b'):
                import io
                with gzip.GzipFile(fileobj=io.BytesIO(xml_content_or_path)) as f:
                    tree = ET.parse(f)
            else:
                tree = ET.ElementTree(ET.fromstring(xml_content_or_path.decode('utf-8', errors='ignore')))
        else:
            tree = ET.parse(xml_content_or_path)
            
        root = tree.getroot()
        
        channel_names = {}
        for chan in root.findall('channel'):
            chan_id = chan.get('id')
            if not chan_id:
                continue
            names = [node.text for node in chan.findall('display-name') if node.text]
            channel_names[chan_id] = names
            
        epg_data = {}
        now_ts = int(time.time())
        min_ts = now_ts - 43200  # -12 hours
        max_ts = now_ts + 129600 # +36 hours
        
        for prog in root.findall('programme'):
            chan_id = prog.get('channel')
            if not chan_id:
                continue
            
            start_str = prog.get('start')
            stop_str = prog.get('stop')
            if not start_str or not stop_str:
                continue
                
            start_ts = parse_xmltv_date(start_str)
            stop_ts = parse_xmltv_date(stop_str)
            
            if stop_ts < min_ts or start_ts > max_ts:
                continue
                
            title_node = prog.find('title')
            title = title_node.text if title_node is not None else ""
            
            desc_node = prog.find('desc')
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
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    async with httpx.AsyncClient(verify=False) as client:
        try:
            resp = await client.get(epg_url, headers=headers, follow_redirects=True, timeout=60.0)
            if resp.status_code < 400:
                parsed = parse_epg_xml(resp.content, is_bytes=True)
                if parsed:
                    epg_filename = os.path.join(DATA_DIR, f"epg_{playlist_id}.json")
                    with open(epg_filename, "w", encoding="utf-8") as f:
                        json.dump(parsed, f, ensure_ascii=False, indent=2)
                    print(f"Background EPG success for playlist {playlist_id}")
        except Exception as e:
            print(f"Background EPG error for playlist {playlist_id}: {e}")

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
                ch_name += f" - Luồng {idx + 1}"
                
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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    async with httpx.AsyncClient(verify=False, follow_redirects=True, timeout=30.0) as client:
        try:
            resp = await client.get(m3u_url, headers=headers)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=400, detail=get_text(lang, "toast_import_error") + f": HTTP {e.response.status_code}")
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

    playlist_id = hashlib.md5(m3u_url.encode()).hexdigest()[:10]

    raw_name = m3u_url.split("/")[-1].split("?")[0]
    if raw_name:
        playlist_name = raw_name
        if is_json and not playlist_name.endswith(".json"):
            playlist_name = f"{playlist_name}.json"
    else:
        playlist_name = f"Sports_{playlist_id}.json" if is_json else f"Playlist_{playlist_id}"

    channels_file = os.path.join(DATA_DIR, f"channels_{playlist_id}.json")
    write_json(channels_file, channels)

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
        content = content_bytes.decode("utf-8", errors="ignore")
    except Exception as e:
        raise HTTPException(status_code=400, detail=get_text(lang, "toast_import_error") + f": {str(e)}")
        
    channels = []
    is_json = False
    epg_url = ""
    try:
        json_data = json.loads(content)
        channels = parse_sports_json(json_data)
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
        channels = parse_m3u(clean_content)

    if not channels:
        raise HTTPException(status_code=400, detail=get_text(lang, "toast_import_error"))

    playlist_id = hashlib.md5(file.filename.encode("utf-8")).hexdigest()[:10]
    playlist_name = file.filename if file.filename else (f"Sports_{playlist_id}.json" if is_json else f"Playlist_{playlist_id}")

    channels_file = os.path.join(DATA_DIR, f"channels_{playlist_id}.json")
    write_json(channels_file, channels)

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

    channels_file = os.path.join(DATA_DIR, f"channels_{playlist_id}.json")
    if os.path.exists(channels_file):
        os.remove(channels_file)

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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
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

    async with httpx.AsyncClient(verify=False, follow_redirects=True, timeout=30.0) as client:
        try:
            resp = await client.get(m3u_url, headers=headers)
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

    channels_file = os.path.join(DATA_DIR, f"channels_{playlist_id}.json")
    write_json(channels_file, channels)

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

@app.get("/api/channels/{playlist_id}")
async def get_channels(playlist_id: str):
    channels_file = os.path.join(DATA_DIR, f"channels_{playlist_id}.json")
    channels = read_json(channels_file)
    
    epg_data_file = os.path.join(DATA_DIR, f"epg_{playlist_id}.json")
    if os.path.exists(epg_data_file):
        try:
            with open(epg_data_file, "r", encoding="utf-8") as f:
                epg_store = json.load(f)
                
            channel_names = epg_store.get("channel_names", {})
            epg_data = epg_store.get("epg_data", {})
            
            now_ts = int(time.time())
            for ch in channels:
                epg_info = get_channel_epg(ch, epg_data, channel_names, now_ts)
                if epg_info and epg_info["programs"]:
                    ch["epg_programs"] = epg_info["programs"]
                    ch["epg_current_index"] = epg_info["current_index"]
        except Exception as e:
            print("Error matching EPG:", e)
            
    return group_channels_by_resolution(channels)

# ── API: Scan channels ───────────────────────────────────────────────

async def verify_hls_playlist(client: httpx.AsyncClient, url: str, headers: dict, depth: int = 0) -> bool:
    if depth > 3:
        return False
    try:
        resp = await client.get(url, headers=headers, timeout=5.0, follow_redirects=True)
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
                seg_resp = await client.head(first_seg_url, headers=headers, timeout=5.0, follow_redirects=True)
                if seg_resp.status_code < 400 and "text/html" not in seg_resp.headers.get("content-type", "").lower():
                    return True
            except Exception:
                pass
            
            # Fallback to GET stream check for headers
            try:
                async with client.stream("GET", first_seg_url, headers=headers, timeout=5.0, follow_redirects=True) as seg_stream:
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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    for k, v in custom_headers.items():
        headers[k] = v

    async with semaphore:
        try:
            # Check content type first via HEAD
            resp = await client.head(url, headers=headers, timeout=5.0, follow_redirects=True)
            content_type = resp.headers.get("content-type", "").lower()
            status_code = resp.status_code
        except Exception:
            # Fallback GET stream just for headers
            try:
                async with client.stream("GET", url, headers=headers, timeout=5.0, follow_redirects=True) as stream_resp:
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

@app.post("/api/scan")
async def scan_channels(playlist_id: str, lang: str = "vi"):
    channels_file = os.path.join(DATA_DIR, f"channels_{playlist_id}.json")
    channels = read_json(channels_file)
    if not channels:
        return {"message": get_text(lang, "toast_scan_success", alive=0, dead=0), "results": []}

    semaphore = asyncio.Semaphore(10) # limit to 10 concurrent requests to keep it stable
    async with httpx.AsyncClient(verify=False, timeout=10.0) as client:
        tasks = [check_channel_url(client, ch, semaphore) for ch in channels]
        results = await asyncio.gather(*tasks)
        write_json(channels_file, results)
        
    alive_count = sum(1 for ch in results if ch.get("status") == "alive")
    dead_count = sum(1 for ch in results if ch.get("status") == "dead")
    
    return {
        "message": get_text(lang, "toast_scan_success", alive=alive_count, dead=dead_count),
        "results": results
    }

# ── API: Proxy Stream ───────────────────────────────────────────────

def _get_origin(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"

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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "*/*",
        "Referer": origin + "/",
        "Origin": origin,
    }

    for k, v in custom_headers.items():
        headers[k] = v

    if "range" in request.headers:
        headers["Range"] = request.headers["range"]

    client = httpx.AsyncClient(verify=False, timeout=60.0, follow_redirects=True)

    try:
        resp = await client.send(
            client.build_request("GET", url, headers=headers),
            stream=True,
        )

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

            return StreamingResponse(
                generate(),
                media_type=content_type or "video/mp2t",
                status_code=resp.status_code,
                headers=cors,
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
            uvicorn.run(app, host="127.0.0.1", port=8001, log_level="error")
        
        server_thread = threading.Thread(target=start_server, daemon=True)
        server_thread.start()
        
        # Give uvicorn a second to boot up before showing webview
        time.sleep(1)
        
        class Api:
            def toggle_fullscreen(self):
                import webview
                if webview.windows:
                    webview.windows[0].toggle_fullscreen()
                    
        api = Api()
        
        print("Starting Desktop App (pywebview)...")
        webview.create_window("IPTV v2 Premium", "http://127.0.0.1:8001", width=1280, height=720, background_color="#07090e", js_api=api)
        webview.start()
    else:
        uvicorn.run("app:app", host="0.0.0.0", port=8001, reload=True, reload_dirs=[os.path.dirname(os.path.abspath(__file__))])