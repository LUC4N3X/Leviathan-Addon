require('dotenv').config();

const axios = require('axios');
const http = require('http');
const https = require('https');

const DEFAULT_HTTP_TIMEOUT = Math.max(parseInt(process.env.HTTP_TIMEOUT_MS || '10000', 10) || 10000, 1000);
const HTTP_MAX_SOCKETS = Math.max(32, Math.min(512, parseInt(process.env.HTTP_MAX_SOCKETS || '128', 10) || 128));
const HTTP_MAX_FREE_SOCKETS = Math.max(8, Math.min(128, parseInt(process.env.HTTP_MAX_FREE_SOCKETS || '32', 10) || 32));
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: HTTP_MAX_SOCKETS, maxFreeSockets: HTTP_MAX_FREE_SOCKETS });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: HTTP_MAX_SOCKETS, maxFreeSockets: HTTP_MAX_FREE_SOCKETS });

axios.defaults.timeout = DEFAULT_HTTP_TIMEOUT;
axios.defaults.httpAgent = HTTP_AGENT;
axios.defaults.httpsAgent = HTTPS_AGENT;

module.exports = {
    DEFAULT_HTTP_TIMEOUT,
    HTTP_MAX_SOCKETS,
    HTTP_MAX_FREE_SOCKETS,
    HTTP_AGENT,
    HTTPS_AGENT
};
