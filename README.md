# IPTV v2

A modern, lightweight, and highly customizable IPTV player built with a FastAPI backend and a vanilla JavaScript/HTML/CSS frontend.

## Features

*   **M3U Playlist Management**: Import local M3U files or provide remote URLs. Automatically synchronizes network-based playlists.
*   **HLS Playback Engine**: Robust streaming leveraging HLS.js for seamless video playback.
*   **Catch-up & Direct Play**: Intelligent proxy strategies for handling CORS issues and direct streaming fallback mechanisms.
*   **Electronic Program Guide (EPG)**: Parse XMLTV EPG data, link it to channels, and render current playing information directly in the user interface.
*   **Quality & Audio Track Selection**: Seamlessly toggle between different video resolutions and audio streams if provided by the source.
*   **Local Video Recording**: Native client-side recording of live streams to IndexedDB with .ts exporting.
*   **Favorites System**: Mark your most-watched channels for rapid access in a dedicated group.
*   **Picture-in-Picture (PiP)**: Keep watching in a floating window while navigating other tabs or applications.
*   **Responsive UI**: Modern dark theme with dynamic layouts, grouping, search filtering, and active channel highlighting.
*   **Internationalization**: Default English interface with underlying structures for multiple language definitions.

## Installation

1. Ensure Python 3.10+ is installed on your system.
2. Clone the repository.
3. Install the required backend dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Run the FastAPI application:
   ```bash
   python app.py
   ```
5. The web interface will be accessible by default at http://localhost:8001.

## Architecture

The application is split into a robust Python backend and a vanilla web frontend:
*   **Backend (app.py)**: Handles M3U parsing, EPG XML parsing, CORS proxying, state management for channels, and caching logic to improve performance. Built entirely on FastAPI and Uvicorn.
*   **Frontend (static/)**: A modularized HTML/JS/CSS structure running completely in the browser. Employs hls.js for playback, and stores configurations, favorites, and recorded segments locally.

## License

This project is licensed under the MIT License.
