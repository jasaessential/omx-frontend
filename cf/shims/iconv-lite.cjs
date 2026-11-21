/* OMX — minimal iconv-lite for Workers (the real one's bundled "browser" build
   crashes there). body-parser / raw-body only need these three, and our API only
   receives UTF-8 JSON. */
'use strict';
const norm = e => String(e || 'utf-8').toLowerCase().replace(/[^a-z0-9]/g, '');
const known = new Set(['utf8', 'utf16le', 'latin1', 'iso88591', 'ascii', 'usascii', 'windows1252']);
const label = e => ({ utf8: 'utf-8', utf16le: 'utf-16le', latin1: 'latin1', iso88591: 'latin1', ascii: 'latin1', usascii: 'latin1', windows1252: 'windows-1252' })[norm(e)] || 'utf-8';
module.exports = {
    encodingExists: e => known.has(norm(e)),
    decode: (buf, e) => new TextDecoder(label(e)).decode(buf),
    getDecoder: e => {
        const d = new TextDecoder(label(e));
        return { write: chunk => d.decode(chunk, { stream: true }), end: () => d.decode() };
    },
};
