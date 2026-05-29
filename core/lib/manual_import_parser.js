'use strict';

const crypto = require('crypto');
const { extractInfoHash } = require('../utils');
const { parseSeasonEpisode } = require('../intelligence/pack_intelligence');

function normalizeHash(value) {
    const normalized = String(value || '').trim().toUpperCase();
    return /^[A-F0-9]{40}$/.test(normalized) ? normalized : null;
}

function parseMagnetInput(value) {
    const magnet = String(value || '').trim();
    if (!magnet.toLowerCase().startsWith('magnet:?')) return null;
    const infoHash = normalizeHash(extractInfoHash(magnet));
    if (!infoHash) return null;

    let displayName = '';
    try {
        const params = new URLSearchParams(magnet.slice('magnet:?'.length));
        displayName = String(params.get('dn') || '').trim();
    } catch (_) {}

    return {
        infoHash,
        title: displayName || null,
        magnet
    };
}

function parseByteString(buffer, offset) {
    const colonIndex = buffer.indexOf(58, offset);
    if (colonIndex === -1) throw new Error('Invalid bencode string length');
    const length = Number.parseInt(buffer.subarray(offset, colonIndex).toString('ascii'), 10);
    if (!Number.isFinite(length) || length < 0) throw new Error('Invalid bencode string length');
    const start = colonIndex + 1;
    const end = start + length;
    return {
        value: buffer.subarray(start, end),
        start: offset,
        end
    };
}

function decodeBencodeNode(buffer, offset = 0, state = {}) {
    const token = String.fromCharCode(buffer[offset]);

    if (token === 'i') {
        const end = buffer.indexOf(101, offset + 1);
        if (end === -1) throw new Error('Invalid bencode integer');
        return {
            value: Number.parseInt(buffer.subarray(offset + 1, end).toString('ascii'), 10),
            start: offset,
            end: end + 1
        };
    }

    if (token === 'l') {
        const list = [];
        let cursor = offset + 1;
        while (buffer[cursor] !== 101) {
            const node = decodeBencodeNode(buffer, cursor, state);
            list.push(node.value);
            cursor = node.end;
        }
        return { value: list, start: offset, end: cursor + 1 };
    }

    if (token === 'd') {
        const map = {};
        let cursor = offset + 1;
        while (buffer[cursor] !== 101) {
            const keyNode = parseByteString(buffer, cursor);
            const key = keyNode.value.toString('utf8');
            cursor = keyNode.end;
            const valueNode = decodeBencodeNode(buffer, cursor, state);
            if (key === 'info') state.infoSlice = buffer.subarray(valueNode.start, valueNode.end);
            map[key] = valueNode.value;
            cursor = valueNode.end;
        }
        return { value: map, start: offset, end: cursor + 1 };
    }

    if (/^[0-9]$/.test(token)) {
        return parseByteString(buffer, offset);
    }

    throw new Error(`Unsupported bencode token: ${token}`);
}

function extractTorrentInputBuffer(value) {
    if (Buffer.isBuffer(value)) return value;
    const raw = String(value || '').trim();
    if (!raw) return null;
    const stripped = raw.includes(',') && raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
    try {
        const buffer = Buffer.from(stripped, 'base64');
        if (buffer.length > 0) return buffer;
    } catch (_) {}
    return null;
}

function mapTorrentFiles(infoDict = {}) {
    const multiFiles = Array.isArray(infoDict?.files) ? infoDict.files : null;
    if (multiFiles && multiFiles.length > 0) {
        return multiFiles.map((entry, index) => {
            const parts = Array.isArray(entry?.path) ? entry.path : [];
            const normalizedParts = parts.map((part) => Buffer.isBuffer(part) ? part.toString('utf8') : String(part || '')).filter(Boolean);
            const path = normalizedParts.join('/');
            return {
                file_index: index,
                file_path: path,
                file_title: normalizedParts[normalizedParts.length - 1] || path || `file-${index}`,
                file_size: Number(entry?.length || 0) || 0
            };
        });
    }

    const singleName = Buffer.isBuffer(infoDict?.name) ? infoDict.name.toString('utf8') : String(infoDict?.name || '').trim();
    const singleLength = Number(infoDict?.length || 0) || 0;
    if (!singleName) return [];
    return [{ file_index: 0, file_path: singleName, file_title: singleName, file_size: singleLength }];
}

function parseTorrentInput(value) {
    const buffer = extractTorrentInputBuffer(value);
    if (!buffer) return null;
    const state = {};
    const root = decodeBencodeNode(buffer, 0, state).value;
    const infoSlice = state.infoSlice;
    if (!infoSlice) throw new Error('Torrent file missing info dictionary');

    const infoHash = crypto.createHash('sha1').update(infoSlice).digest('hex').toUpperCase();
    const infoDict = root?.info || {};
    const title = Buffer.isBuffer(infoDict?.name) ? infoDict.name.toString('utf8') : String(infoDict?.name || '').trim() || null;
    const files = mapTorrentFiles(infoDict);

    return {
        infoHash,
        title,
        files,
        totalSize: files.reduce((sum, file) => sum + (Number(file.file_size || 0) || 0), 0)
    };
}

function inferPackMappings(files, payload = {}) {
    const imdbId = String(payload?.imdbId || payload?.imdb_id || '').trim().toLowerCase();
    const type = String(payload?.type || '').trim().toLowerCase();
    const season = Number(payload?.season) > 0 ? Number(payload.season) : null;
    const episode = Number(payload?.episode) > 0 ? Number(payload.episode) : null;
    if (!/^tt\d+$/.test(imdbId) || !Array.isArray(files) || files.length === 0) return [];

    if (type === 'movie') {
        return files.map((file) => ({
            ...file,
            imdb_id: imdbId
        }));
    }

    const defaultSeason = season || 1;
    const mappings = [];
    for (const file of files) {
        const parsed = parseSeasonEpisode(file.file_title || file.file_path, defaultSeason, { anime: Boolean(payload?.isAnime) });
        if (!parsed) continue;
        mappings.push({
            ...file,
            imdb_id: imdbId,
            imdb_season: parsed.season,
            imdb_episode: parsed.episode
        });
    }

    if (mappings.length === 0 && season && episode && files[0]) {
        mappings.push({
            ...files[0],
            imdb_id: imdbId,
            imdb_season: season,
            imdb_episode: episode
        });
    }

    return mappings;
}

module.exports = {
    normalizeHash,
    parseMagnetInput,
    parseTorrentInput,
    inferPackMappings
};
