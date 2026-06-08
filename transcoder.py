import os
import uuid
import shutil
import subprocess

class TranscoderBackend:
    """
    Isolated Transcoding Engine using synchronous subprocess.
    Optimized based on jp_iptv_test to prevent UI blocking.
    """
    def __init__(self):
        self.active_sessions = {}
        self.app_data = os.environ.get('APPDATA', os.path.expanduser('~'))
        self.hls_dir = os.path.join(self.app_data, 'IPTV_v2', 'hls_temp')
        os.makedirs(self.hls_dir, exist_ok=True)
        self.codec_cache = {}

    def probe_codec(self, raw_url: str, ffmpeg_exe: str) -> str:
        if raw_url in self.codec_cache:
            return self.codec_cache[raw_url]
            
        import subprocess, re, sys, os
        
        if getattr(sys, 'frozen', False):
            base_dir = sys._MEIPASS
        else:
            base_dir = os.path.dirname(os.path.abspath(__file__))
            
        ffprobe_exe = os.path.join(base_dir, 'ffprobe.exe')
        
        cmd = [
            ffprobe_exe, 
            '-v', 'error', 
            '-timeout', '5000000', 
            '-select_streams', 'v:0', 
            '-show_entries', 'stream=codec_name', 
            '-of', 'default=noprint_wrappers=1:nokey=1', 
            raw_url
        ]
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        try:
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, creationflags=creationflags)
            if res.returncode == 0:
                codec_raw = res.stdout.decode('utf-8', errors='ignore').strip().lower()
                if codec_raw:
                    codec = codec_raw.split('\n')[0].strip()
                    print(f"[PROBE SUCCESS] Codec detected: {codec} (Raw: {repr(codec_raw)})")
                    self.codec_cache[raw_url] = codec
                    return codec
                else:
                    print(f"[PROBE WARNING] FFprobe succeeded but returned empty codec string.")
            else:
                print(f"[PROBE ERROR] FFprobe failed with code {res.returncode}. Stderr: {res.stderr.decode('utf-8', errors='ignore')}")
        except subprocess.TimeoutExpired:
            print(f"[PROBE ERROR] FFprobe timed out after 10 seconds.")
        except Exception as e:
            print(f"[PROBE ERROR] Exception running ffprobe: {str(e)}")
            
        print("[PROBE FALLBACK] Routing to unknown (forces libx264 encoding).")
        self.codec_cache[raw_url] = 'unknown'
        return 'unknown'

    def start_session(self, raw_url: str, headers_str: str = "") -> str:
        try:
            import imageio_ffmpeg
            ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception as e:
            raise RuntimeError(f"FFmpeg not available: {e}")

        # Kill any existing sessions first to ensure only 1 active stream
        for sid in list(self.active_sessions.keys()):
            self.stop_session(sid)

        # Clear old HLS root directory safely
        try:
            for f in os.listdir(self.hls_dir):
                path = os.path.join(self.hls_dir, f)
                if os.path.isdir(path):
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    os.remove(path)
        except Exception:
            pass

        session_id = str(uuid.uuid4())
        session_dir = os.path.join(self.hls_dir, session_id)
        os.makedirs(session_dir, exist_ok=True)
        m3u8_path = "playlist.m3u8"

        cmd = [ffmpeg_exe]
        
        # Add timeout parameters BEFORE input file
        # -timeout: tcp/http timeout in microseconds (10,000,000 = 10s)
        # -rw_timeout: read/write timeout in microseconds (10,000,000 = 10s)
        cmd.extend(["-timeout", "10000000", "-rw_timeout", "10000000"])

        if headers_str:
            cmd.extend(["-headers", headers_str])

        codec = self.probe_codec(raw_url, ffmpeg_exe)
        
        cmd.extend(["-i", raw_url])
        
        if codec == "h264":
            cmd.extend(["-c:v", "copy"])
        else:
            cmd.extend(["-c:v", "libx264", "-preset", "ultrafast"])
            
        cmd.extend([
            "-c:a", "aac",
            "-f", "hls", "-hls_time", "4", "-hls_list_size", "5",
            "-hls_segment_type", "fmp4",
            "-hls_flags", "delete_segments",
            m3u8_path
        ])

        creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

        try:
            # Launch FFmpeg with stderr piped to memory to avoid Disk I/O
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                cwd=session_dir,
                creationflags=creationflags,
                text=True,
                encoding="utf-8",
                errors="ignore"
            )
        except Exception as e:
            raise RuntimeError(f"Failed to spawn FFmpeg process: {e}")

        # Start background thread to actively drain the pipe to prevent process deadlock
        from collections import deque
        import threading
        
        stderr_lines = deque(maxlen=10)
        
        def read_stderr(proc, lines_deque):
            try:
                for line in proc.stderr:
                    lines_deque.append(line)
            except Exception:
                pass
            finally:
                try:
                    proc.stderr.close()
                except Exception:
                    pass

        reader_thread = threading.Thread(target=read_stderr, args=(process, stderr_lines), daemon=True)
        reader_thread.start()

        self.active_sessions[session_id] = {
            "process": process,
            "dir": session_dir,
            "cmd": cmd,
            "raw_url": raw_url,
            "headers_str": headers_str,
            "retries_left": 2,
            "stderr_lines": stderr_lines,
            "reader_thread": reader_thread
        }
        return session_id

    def get_session_status(self, session_id: str) -> dict:
        if session_id not in self.active_sessions:
            return {"status": "not_found", "message": "Session not found"}
        
        info = self.active_sessions[session_id]
        process = info["process"]
        session_dir = info["dir"]
        
        poll_val = process.poll()
        if poll_val is None:
            return {"status": "running"}
            
        # Process has exited. Check stderr details first.
        stderr_str = " | ".join([line.strip() for line in info["stderr_lines"] if line.strip()])
        
        # Optimization 1: If 404/Not Found is in stderr, do not retry
        is_404 = "404" in stderr_str or "Not Found" in stderr_str or "403" in stderr_str or "Server returned 4" in stderr_str
        if is_404:
            info["retries_left"] = 0
            print(f"[TRANSCODE SESSION] Fast failure due to HTTP error (no retry): {stderr_str}")

        # Process has exited. Check if we can retry.
        if info["retries_left"] > 0:
            info["retries_left"] -= 1
            print(f"[TRANSCODE RETRY] Session {session_id} failed with code {poll_val}. Retrying... (Remaining retries: {info['retries_left']})")
            try:
                creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
                
                # Re-spawn process
                new_process = subprocess.Popen(
                    info["cmd"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    cwd=session_dir,
                    creationflags=creationflags,
                    text=True,
                    encoding="utf-8",
                    errors="ignore"
                )
                
                # Start new reader thread
                import threading
                from collections import deque
                
                info["stderr_lines"] = deque(maxlen=10)
                
                def read_stderr(proc, lines_deque):
                    try:
                        for line in proc.stderr:
                            lines_deque.append(line)
                    except Exception:
                        pass
                    finally:
                        try:
                            proc.stderr.close()
                        except Exception:
                            pass

                reader_thread = threading.Thread(target=read_stderr, args=(new_process, info["stderr_lines"]), daemon=True)
                reader_thread.start()
                
                info["process"] = new_process
                info["reader_thread"] = reader_thread
                return {"status": "running"}
            except Exception as e:
                print(f"[TRANSCODE RETRY ERROR] Failed to restart: {e}")

        # No retries left, it failed.
        exit_code = poll_val
        error_msg = f"FFmpeg exited with code {exit_code}"
        if stderr_str:
            error_msg += f". Stderr: {stderr_str}"
                
        return {
            "status": "failed",
            "exit_code": exit_code,
            "message": error_msg
        }

    def stop_session(self, session_id: str):
        if session_id in self.active_sessions:
            info = self.active_sessions.pop(session_id)
            process = info["process"]
            try:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=0.5)
                    except subprocess.TimeoutExpired:
                        process.kill()
            except Exception:
                pass

            session_dir = info["dir"]
            try:
                if os.path.exists(session_dir):
                    shutil.rmtree(session_dir, ignore_errors=True)
            except Exception:
                pass

# Global instance
engine = TranscoderBackend()
