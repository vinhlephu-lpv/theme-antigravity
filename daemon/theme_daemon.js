#!/usr/bin/env node
'use strict';

/**
 * Antigravity Custom Theme Daemon (Windows / macOS / Linux)
 * Connects to Antigravity CDP (DevToolsActivePort), injects dist/theme_payload.js,
 * persists user theme preferences in theme_config.json, and hot-reloads on rebuild.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

if (typeof globalThis.WebSocket !== 'function') {
    console.error('[theme-daemon] Node.js >= 22 with built-in WebSocket is required.');
    process.exit(1);
}

const ROOT_DIR = path.resolve(__dirname, '..');
const PID_FILE = path.join(ROOT_DIR, 'daemon.pid');
const CONFIG_FILE = process.env.AGY_CONFIG_PATH || path.join(ROOT_DIR, 'theme_config.json');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const PAYLOAD_PATH = path.join(DIST_DIR, 'theme_payload.js');
const LOG_FILE = path.join(ROOT_DIR, 'daemon.log');
const DEFAULT_CONFIG = {};

function resolvePortFile() {
    if (process.env.AGY_PORT_FILE) {
        return process.env.AGY_PORT_FILE;
    }

    const home = os.homedir();
    let candidates;
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        candidates = [
            path.join(appData, 'antigravity', 'DevToolsActivePort'),
            path.join(appData, 'Antigravity', 'DevToolsActivePort'),
        ];
    } else if (process.platform === 'darwin') {
        const appSupport = path.join(home, 'Library', 'Application Support');
        candidates = [
            path.join(appSupport, 'antigravity', 'DevToolsActivePort'),
            path.join(appSupport, 'Antigravity', 'DevToolsActivePort'),
        ];
    } else {
        const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
        candidates = [
            path.join(xdgConfig, 'antigravity', 'DevToolsActivePort'),
            path.join(xdgConfig, 'Antigravity', 'DevToolsActivePort'),
        ];
    }

    return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 512 * 1024) {
            fs.writeFileSync(LOG_FILE, '');
        }
        fs.appendFileSync(LOG_FILE, line);
    } catch (_) {}
    if (process.stdout.isTTY || process.env.AGY_DAEMON_STDOUT === '1') {
        process.stdout.write(line);
    }
}

function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

function acquirePidLock() {
    if (fs.existsSync(PID_FILE)) {
        const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (existingPid && existingPid !== process.pid && isPidAlive(existingPid)) {
            log(`Another daemon instance is already running (PID ${existingPid}). Exiting.`);
            process.exit(0);
        }
    }
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
}

function removePidLock() {
    try {
        if (fs.existsSync(PID_FILE)) {
            const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
            if (pid === process.pid) {
                fs.unlinkSync(PID_FILE);
            }
        }
    } catch (_) {}
}

function readConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            if (parsed && typeof parsed === 'object') {
                return { ...DEFAULT_CONFIG, ...parsed };
            }
        }
    } catch (err) {
        log(`Failed reading theme_config.json: ${err.message}`);
    }
    return { ...DEFAULT_CONFIG };
}

function saveConfig(next) {
    try {
        const merged = { ...readConfig(), ...next };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
        return merged;
    } catch (err) {
        log(`Failed saving theme_config.json: ${err.message}`);
        return null;
    }
}

const THEMES_ASSETS_DIR = path.join(ROOT_DIR, 'themes', 'assets');
const USER_MEDIA_DIR = path.join(ROOT_DIR, 'themes', 'user_media');
let mediaServer = null;
let mediaPort = 0;

const IMAGE_EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac']);
const md5Cache = new Map();

function getMediaKind(fileName) {
    const ext = path.extname(String(fileName || '')).toLowerCase();
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    return null;
}

function stripMediaTimestamp(fileName) {
    return String(fileName || '').replace(/^\d{10,}_/, '');
}

function normalizeUserMediaFileName(urlOrName) {
    if (!urlOrName) return '';
    let s = String(urlOrName).trim();
    if (!s) return '';
    const match = s.match(/(?:^|\/)user_media\/([^?#]+)/i);
    if (match) {
        s = match[1];
    }
    try {
        s = decodeURIComponent(s);
    } catch (_) {}
    const base = path.basename(s);
    if (!base || base === '.' || base === '..') return '';
    return base;
}

function getFileMd5(filePath, stat) {
    const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    const cached = md5Cache.get(cacheKey);
    if (cached) return cached;
    const hash = crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
    if (md5Cache.size > 500) md5Cache.clear();
    md5Cache.set(cacheKey, hash);
    return hash;
}

function scanUserMedia() {
    const images = [];
    const videos = [];
    const audios = [];
    if (!fs.existsSync(USER_MEDIA_DIR)) {
        return { images, videos, audios };
    }

    const cfg = readConfig();
    const activeWpFile = normalizeUserMediaFileName(cfg.customWp);
    const activeVidFile = normalizeUserMediaFileName(cfg.customVideo);
    const activeVoiceFile = normalizeUserMediaFileName(cfg.customVoice);

    let entries = [];
    try {
        entries = fs.readdirSync(USER_MEDIA_DIR, { withFileTypes: true });
    } catch (_) {
        return { images, videos, audios };
    }

    const byHash = new Map();
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const kind = getMediaKind(entry.name);
        if (!kind) continue;
        const fullPath = path.join(USER_MEDIA_DIR, entry.name);
        let stat;
        try {
            stat = fs.statSync(fullPath);
        } catch (_) {
            continue;
        }
        const md5 = getFileMd5(fullPath, stat);
        const item = {
            url: `user_media/${encodeURIComponent(entry.name)}`,
            fileName: entry.name,
            name: stripMediaTimestamp(entry.name),
            kind,
            size: stat.size,
            addedAt: Math.round(stat.mtimeMs),
            md5,
        };
        const isActive = entry.name === activeWpFile || entry.name === activeVidFile || entry.name === activeVoiceFile;
        const existing = byHash.get(md5);
        if (!existing) {
            byHash.set(md5, { item, isActive });
        } else if (isActive && !existing.isActive) {
            byHash.set(md5, { item, isActive: true });
        } else if (!existing.isActive && item.addedAt > existing.item.addedAt) {
            byHash.set(md5, { item, isActive: false });
        }
    }

    for (const { item } of byHash.values()) {
        const clean = {
            url: item.url,
            fileName: item.fileName,
            name: item.name,
            kind: item.kind,
            size: item.size,
            addedAt: item.addedAt,
        };
        if (item.kind === 'image') images.push(clean);
        else if (item.kind === 'video') videos.push(clean);
        else audios.push(clean);
    }

    images.sort((a, b) => b.addedAt - a.addedAt);
    videos.sort((a, b) => b.addedAt - a.addedAt);
    audios.sort((a, b) => b.addedAt - a.addedAt);
    return { images, videos, audios };
}

const MEDIA_MIME = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.m4v': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.webp': 'image/webp',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
};

function startMediaServer() {
    mediaServer = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
        const pathname = decodeURIComponent(reqUrl.pathname || '/');

        if (req.method === 'GET' && pathname === '/user_media_list') {
            try {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, ...scanUserMedia() }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
            return;
        }

        if (req.method === 'POST' && pathname === '/delete_media') {
            const chunks = [];
            let total = 0;
            const MAX_JSON = 64 * 1024;
            req.on('data', (chunk) => {
                total += chunk.length;
                if (total > MAX_JSON) {
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Payload too large' }));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => {
                if (total > MAX_JSON) return;
                try {
                    let targetInput = reqUrl.searchParams.get('name') || '';
                    if (!targetInput && chunks.length > 0) {
                        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                        targetInput = body.url || body.fileName || body.name || '';
                    }
                    const fileName = normalizeUserMediaFileName(targetInput);
                    if (!fileName) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid media target' }));
                        return;
                    }
                    const baseDir = path.resolve(USER_MEDIA_DIR);
                    const resolved = path.resolve(baseDir, fileName);
                    if (!resolved.startsWith(baseDir + path.sep)) {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Forbidden path' }));
                        return;
                    }

                    const deletedFiles = [];
                    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
                        const targetStat = fs.statSync(resolved);
                        const targetMd5 = getFileMd5(resolved, targetStat);
                        for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
                            if (!entry.isFile()) continue;
                            const candidatePath = path.join(baseDir, entry.name);
                            try {
                                const cStat = fs.statSync(candidatePath);
                                if (candidatePath === resolved || (cStat.size === targetStat.size && getFileMd5(candidatePath, cStat) === targetMd5)) {
                                    fs.unlinkSync(candidatePath);
                                    deletedFiles.push(entry.name);
                                }
                            } catch (_) {}
                        }
                    }

                    const deletedSet = new Set(deletedFiles.concat(fileName));
                    const cfg = readConfig();
                    const patch = {};
                    if (deletedSet.has(normalizeUserMediaFileName(cfg.customWp))) {
                        patch.customWp = '';
                    }
                    if (deletedSet.has(normalizeUserMediaFileName(cfg.customVideo))) {
                        patch.customVideo = '';
                    }
                    if (Array.isArray(cfg.savedImages)) {
                        patch.savedImages = cfg.savedImages.filter((it) => !deletedSet.has(normalizeUserMediaFileName(it && it.url)));
                    }
                    if (Array.isArray(cfg.savedVideos)) {
                        patch.savedVideos = cfg.savedVideos.filter((it) => !deletedSet.has(normalizeUserMediaFileName(it && it.url)));
                    }
                    if (Array.isArray(cfg.taskVoices)) {
                        patch.taskVoices = cfg.taskVoices.filter((it) => !deletedSet.has(normalizeUserMediaFileName(it && it.url)));
                    }
                    if (Object.keys(patch).length > 0) {
                        saveConfig(patch);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, deleted: deletedFiles, media: scanUserMedia() }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
            return;
        }

        if (req.method === 'POST' && pathname === '/upload') {
            const rawName = String(reqUrl.searchParams.get('name') || 'custom_media.bin');
            const safeBase = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'media.bin';
            const fileName = `${Date.now()}_${safeBase}`;
            const chunks = [];
            let total = 0;
            const MAX_BYTES = 100 * 1024 * 1024;

            req.on('data', (chunk) => {
                total += chunk.length;
                if (total > MAX_BYTES) {
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'File too large (max 100MB)' }));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => {
                if (total > MAX_BYTES) return;
                try {
                    fs.mkdirSync(USER_MEDIA_DIR, { recursive: true });
                    const buf = Buffer.concat(chunks);
                    const uploadMd5 = crypto.createHash('md5').update(buf).digest('hex');

                    for (const entry of fs.readdirSync(USER_MEDIA_DIR, { withFileTypes: true })) {
                        if (!entry.isFile()) continue;
                        const existingPath = path.join(USER_MEDIA_DIR, entry.name);
                        try {
                            const stat = fs.statSync(existingPath);
                            if (stat.size === buf.length && getFileMd5(existingPath, stat) === uploadMd5) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({
                                    ok: true,
                                    duplicate: true,
                                    url: `user_media/${encodeURIComponent(entry.name)}`,
                                    fileName: entry.name,
                                    name: stripMediaTimestamp(entry.name),
                                    kind: getMediaKind(entry.name) || 'image',
                                }));
                                return;
                            }
                        } catch (_) {}
                    }

                    const dest = path.join(USER_MEDIA_DIR, fileName);
                    fs.writeFileSync(dest, buf);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        ok: true,
                        duplicate: false,
                        url: `user_media/${encodeURIComponent(fileName)}`,
                        fileName,
                        name: stripMediaTimestamp(fileName),
                        kind: getMediaKind(fileName) || 'image',
                    }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
            return;
        }

        let baseDir = null;
        let relPath = '';
        if (pathname.startsWith('/assets/')) {
            baseDir = path.resolve(THEMES_ASSETS_DIR);
            relPath = pathname.slice('/assets/'.length);
        } else if (pathname.startsWith('/user_media/')) {
            baseDir = path.resolve(USER_MEDIA_DIR);
            relPath = pathname.slice('/user_media/'.length);
        } else {
            res.writeHead(404);
            res.end('Not found');
            return;
        }

        const resolved = path.resolve(baseDir, relPath);
        if (!resolved.startsWith(baseDir + path.sep) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }

        const stat = fs.statSync(resolved);
        const ext = path.extname(resolved).toLowerCase();
        const mime = MEDIA_MIME[ext] || 'application/octet-stream';
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            if (Number.isNaN(start) || start >= stat.size || end >= stat.size) {
                res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
                res.end();
                return;
            }
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': end - start + 1,
                'Content-Type': mime,
            });
            fs.createReadStream(resolved, { start, end }).pipe(res);
            return;
        }

        res.writeHead(200, {
            'Content-Length': stat.size,
            'Content-Type': mime,
            'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(resolved).pipe(res);
    });

    mediaServer.listen(0, '127.0.0.1', () => {
        const addr = mediaServer.address();
        mediaPort = addr && typeof addr === 'object' ? addr.port : 0;
        log(`Local media server listening on http://127.0.0.1:${mediaPort}`);
    });
}

let missingPayloadLogged = false;
function buildInjectedSource() {
    if (!fs.existsSync(PAYLOAD_PATH)) {
        if (!missingPayloadLogged) {
            log(`Payload not built yet (${PAYLOAD_PATH}). Run: python scripts/build_payload.py`);
            missingPayloadLogged = true;
        }
        return null;
    }
    missingPayloadLogged = false;

    const cfgJson = JSON.stringify(readConfig());
    const mediaListJson = JSON.stringify(scanUserMedia());
    const mediaBase = mediaPort ? `http://127.0.0.1:${mediaPort}` : '';
    const payloadCode = fs.readFileSync(PAYLOAD_PATH, 'utf8');
    return `window.__AGY_MEDIA_BASE_URL__ = ${JSON.stringify(mediaBase)};\nwindow.__AGY_INITIAL_CONFIG__ = ${cfgJson};\nwindow.__AGY_USER_MEDIA__ = ${mediaListJson};\n${payloadCode}`;
}

function getPortInfo() {
    const portFile = resolvePortFile();
    if (!fs.existsSync(portFile)) return null;
    const lines = fs
        .readFileSync(portFile, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    const port = parseInt(lines[0], 10);
    if (!Number.isFinite(port) || port <= 0) return null;
    return { port, token: lines[1] || '' };
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 2000 }, (res) => {
            let body = '';
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
        req.on('error', reject);
    });
}

const sessions = new Map();
let lastPort = null;
let reloadTimer = null;

function createSession(target) {
    const ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
    let nextId = 1;
    const pending = new Map();
    const session = { id: target.id, ws, target };
    sessions.set(target.id, session);

    function send(method, params = {}) {
        return new Promise((resolve, reject) => {
            if (ws.readyState !== 1) {
                reject(new Error('WebSocket is not open'));
                return;
            }
            const id = nextId++;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    session.reinject = async () => {
        const src = buildInjectedSource();
        if (!src) return;
        try {
            await send('Runtime.evaluate', { expression: src, awaitPromise: false });
        } catch (_) {}
    };

    ws.addEventListener('message', async (event) => {
        let msg;
        try {
            msg = JSON.parse(String(event.data));
        } catch (_) {
            return;
        }

        if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
            else p.resolve(msg.result);
            return;
        }

        if (msg.method === 'Runtime.bindingCalled' && msg.params && msg.params.name === 'agySaveThemeConfig') {
            try {
                const payload = JSON.parse(msg.params.payload || '{}');
                saveConfig(payload);
                for (const other of sessions.values()) {
                    if (other.id !== target.id) {
                        other.reinject();
                    }
                }
            } catch (err) {
                log(`Config binding error: ${err.message}`);
            }
            return;
        }

        if (msg.method === 'Page.frameNavigated' && msg.params && msg.params.frame && !msg.params.frame.parentId) {
            await session.reinject();
        }
    });

    ws.addEventListener('open', async () => {
        try {
            await send('Page.enable');
            await send('Runtime.enable');
            try {
                await send('Page.setBypassCSP', { enabled: true });
            } catch (_) {}
            try {
                await send('Runtime.addBinding', { name: 'agySaveThemeConfig' });
            } catch (_) {}

            const src = buildInjectedSource();
            if (src) {
                await send('Page.addScriptToEvaluateOnNewDocument', { source: src });
                await send('Runtime.evaluate', { expression: src, awaitPromise: false });
            }
            log(`Attached target ${target.id} (${target.url})`);
        } catch (err) {
            log(`Attach error for ${target.id}: ${err.message}`);
        }
    });

    const cleanup = () => {
        for (const p of pending.values()) {
            p.reject(new Error('WebSocket closed'));
        }
        pending.clear();
        sessions.delete(target.id);
    };
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
}

async function scanPages() {
    const info = getPortInfo();
    if (!info) return;

    if (lastPort !== null && lastPort !== info.port) {
        for (const s of sessions.values()) {
            try {
                s.ws.close();
            } catch (_) {}
        }
        sessions.clear();
    }
    lastPort = info.port;

    let targets;
    try {
        targets = await fetchJson(`http://127.0.0.1:${info.port}/json`);
    } catch (_) {
        return;
    }
    if (!Array.isArray(targets)) return;

    const pages = targets.filter((t) => {
        if (!t || t.type !== 'page' || !t.webSocketDebuggerUrl) return false;
        const url = String(t.url || '');
        if (url.startsWith('devtools://') || url.startsWith('chrome-extension://')) return false;
        return url.includes('127.0.0.1') || url.includes('workbench') || url.includes('launchpad');
    });

    const liveIds = new Set(pages.map((p) => p.id));
    for (const [id, session] of sessions.entries()) {
        if (!liveIds.has(id)) {
            try {
                session.ws.close();
            } catch (_) {}
            sessions.delete(id);
        }
    }

    for (const page of pages) {
        if (!sessions.has(page.id)) {
            createSession(page);
        }
    }
}

function watchPayload() {
    try {
        if (!fs.existsSync(DIST_DIR)) {
            fs.mkdirSync(DIST_DIR, { recursive: true });
        }
        fs.watch(DIST_DIR, (_eventType, filename) => {
            if (filename && filename !== 'theme_payload.js') return;
            clearTimeout(reloadTimer);
            reloadTimer = setTimeout(() => {
                log('Detected dist/theme_payload.js update; hot-reloading attached pages.');
                for (const s of sessions.values()) {
                    s.reinject();
                }
            }, 250);
        });
    } catch (err) {
        log(`fs.watch skipped: ${err.message}`);
    }
}

function shutdown(signal) {
    log(`Shutting down on ${signal}.`);
    if (mediaServer) {
        try {
            mediaServer.close();
        } catch (_) {}
    }
    for (const s of sessions.values()) {
        try {
            s.ws.close();
        } catch (_) {}
    }
    sessions.clear();
    removePidLock();
    process.exit(0);
}

acquirePidLock();
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', removePidLock);

log(`Theme daemon started (PID ${process.pid}, platform=${process.platform}, portFile=${resolvePortFile()}).`);
startMediaServer();
const readyWait = setInterval(() => {
    if (mediaPort > 0) {
        clearInterval(readyWait);
        watchPayload();
        scanPages();
        setInterval(scanPages, 1500);
    }
}, 25);
