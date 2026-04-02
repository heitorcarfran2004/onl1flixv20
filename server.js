const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');

const PORT = 3334;
const SYNC_API_BASE = 'https://api.syncpayments.com.br';
const CLIENT_ID = 'b90bdcb5-9e04-4d0b-9eff-d23ae686f187';
const CLIENT_SECRET = 'b802f521-7485-4e16-909b-020e51fc7383';

// In-Memory Database for Orders (Persists UTMs)
const orders = new Map();

// Helper to make HTTPS requests
function makeRequest(method, path, data = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path.startsWith('http') ? path : SYNC_API_BASE + path);
        const options = {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        };

        const req = https.request(url, options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        resolve(body);
                    }
                } else {
                    reject({ status: res.statusCode, body: body });
                }
            });
        });

        req.on('error', (e) => reject(e));

        if (data) {
            req.write(JSON.stringify(data));
        }
        req.end();
    });
}

// Auth Flow
let authToken = null;
let tokenExpiresAt = 0;

async function getAuthToken() {
    if (authToken && Date.now() < tokenExpiresAt) {
        return authToken;
    }
    console.log('Refreshing Auth Token...');
    try {
        const response = await makeRequest('POST', '/api/partner/v1/auth-token', {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET
        });
        authToken = response.access_token;
        tokenExpiresAt = Date.now() + ((response.expires_in || 3600) * 1000) - 60000;
        return authToken;
    } catch (error) {
        console.error('Auth Failed:', error);
        throw error;
    }
}

// Generate valid CPF
function generateCPF() {
    const rnd = (n) => Math.round(Math.random() * n);
    const mod = (dividend, divisor) => Math.round(dividend - (Math.floor(dividend / divisor) * divisor));
    const n = 9;
    const n1 = rnd(n), n2 = rnd(n), n3 = rnd(n), n4 = rnd(n), n5 = rnd(n), n6 = rnd(n), n7 = rnd(n), n8 = rnd(n), n9 = rnd(n);
    let d1 = n9 * 2 + n8 * 3 + n7 * 4 + n6 * 5 + n5 * 6 + n4 * 7 + n3 * 8 + n2 * 9 + n1 * 10;
    d1 = 11 - (mod(d1, 11));
    if (d1 >= 10) d1 = 0;
    let d2 = d1 * 2 + n9 * 3 + n8 * 4 + n7 * 5 + n6 * 6 + n5 * 7 + n4 * 8 + n3 * 9 + n2 * 10 + n1 * 11;
    d2 = 11 - (mod(d2, 11));
    if (d2 >= 10) d2 = 0;
    return `${n1}${n2}${n3}${n4}${n5}${n6}${n7}${n8}${n9}${d1}${d2}`;
}

// UTMify Server-Side Conversion Trigger
async function sendUtmifyConversion(order) {
    console.log(`[UTMify] Triggering Server-Side Conversion for Order: ${order.id}`);

    // Construct Payload
    const payload = {
        order_id: order.id,
        amount: order.amount,
        status: 'approved',
        payment_method: 'pix',
        ...order.utms // Spread captured UTMs
    };

    console.log('[UTMify] Payload:', payload);

    try {
        // Attempt Manual POST to Webhook
        await makeRequest('POST', 'https://api.utmify.com.br/v1/postback', payload);
        console.log('[UTMify] Conversion sent successfully via Postback.');
    } catch (e) {
        console.error('[UTMify] Postback failed (Expected if no Token). Trying Pixel Hit fallback...');

        // Fallback: Attempt to hit Pixel URL (GET) if POST fails
        // This is a common S2S fallback using the Pixel ID
        try {
            const pixelId = '692058bf4a65d26de92c8fdc'; // From index.html
            const qs = Object.entries(order.utms).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
            const pixelUrl = `https://api.utmify.com.br/pixel?id=${pixelId}&event=purchase&amount=${order.amount}&order_id=${order.id}&${qs}`;
            // Simple GET trigger
            https.get(pixelUrl, (res) => {
                console.log(`[UTMify] Pixel fallback status: ${res.statusCode}`);
            }).on('error', (err) => console.error('[UTMify] Pixel fallback error:', err.message));
        } catch (err2) {
            console.error('[UTMify] All fallback triggers failed.');
        }
    }
}

const mimeTypes = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.webp': 'image/webp', '.avif': 'image/avif',
    '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

// Tipos comprimíveis via gzip
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg']);

// Determina Cache-Control ideal por tipo/caminho
function getCacheControl(pathname, extname) {
    // Assets Next.js com hash no nome = imutáveis por 1 ano
    if (/\/_next\/static\/(chunks|css|media)\//.test(pathname)) {
        return 'public, max-age=31536000, immutable';
    }
    // Fontes e imagens gerais
    if (['.woff2','.woff','.ttf','.png','.jpg','.jpeg','.webp','.avif','.gif','.ico'].includes(extname)) {
        return 'public, max-age=86400';
    }
    // HTML principal — sempre revalidar
    return 'no-cache, no-store, must-revalidate';
}

const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // API: CHECK STATUS
    if (pathname === '/api/status' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing ID' }));
            return;
        }

        try {
            let order = orders.get(id);
            const token = await getAuthToken();
            const statusData = await makeRequest('GET', `/api/partner/v1/transaction/${id}`, null, {
                'Authorization': `Bearer ${token}`
            });

            // Hydrate local order if missing
            if (!order && statusData.data && statusData.data.metadata) {
                order = {
                    id: id,
                    status: statusData.data.status,
                    amount: statusData.data.amount,
                    utms: statusData.data.metadata,
                    utmifySent: false
                };
                orders.set(id, order);
            }

            const remoteStatus = statusData.data ? statusData.data.status : null;
            if (remoteStatus === 'paid' || remoteStatus === 'completed') {
                if (order) {
                    order.status = 'paid';
                    if (!order.utmifySent) {
                        order.utmifySent = true;
                        sendUtmifyConversion(order).catch(err => console.error(err));
                    }
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(statusData));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message || 'Internal Error' }));
        }
        return;
    }

    // API: CREATE PIX
    if (pathname === '/api/create-pix' && req.method === 'POST') {
        let bodyStr = '';
        req.on('data', chunk => bodyStr += chunk);
        req.on('end', async () => {
            try {
                const body = JSON.parse(bodyStr);
                const token = await getAuthToken();

                const utms = {
                    utm_source: body.utm_source,
                    utm_medium: body.utm_medium,
                    utm_campaign: body.utm_campaign,
                    utm_term: body.utm_term,
                    utm_content: body.utm_content,
                    src: body.src,
                    sck: body.sck,
                    client_ip: body.client_ip,
                    client_user_agent: body.client_user_agent
                };

                // DATA STUFFING: Send UTMs in every possible field SyncPay/Gateways use
                const utmString = Object.entries(utms)
                    .map(([k, v]) => `${k}=${encodeURIComponent(v || '')}`)
                    .join('&');

                const payload = {
                    amount: parseFloat(body.planPrice),
                    description: body.planName || 'Assinatura',
                    webhook_url: 'https://example.com/webhook',
                    client: {
                        name: 'Cliente Visitante',
                        cpf: generateCPF(),
                        email: body.email,
                        phone: '11999999999',
                        ip: body.client_ip || req.socket.remoteAddress
                    },

                    // 1. Root Level (Standard)
                    ...utms,

                    // 2. Mapped Fields (Common in BR Gateways)
                    src: body.src || body.utm_source,
                    sck: body.sck || body.utm_medium, // or utm_campaign

                    // 3. Metadata (Modern Standard)
                    metadata: utms,

                    // 4. Extra / Custom (Legacy/Fallback)
                    extra: utmString,
                    custom: utmString,
                    notes: `UTM Source: ${body.utm_source}`
                };

                console.log('Creating Charge. Metadata:', utms);
                const pixData = await makeRequest('POST', '/api/partner/v1/cash-in', payload, {
                    'Authorization': `Bearer ${token}`
                });

                const identifier = pixData.identifier || pixData.payment_id;
                if (identifier) {
                    orders.set(identifier, {
                        id: identifier,
                        createDate: new Date(),
                        status: 'pending',
                        amount: payload.amount,
                        utms: utms,
                        utmifySent: false
                    });
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(pixData));

            } catch (err) {
                console.error('API Error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message || 'Internal Error' }));
            }
        });
        return;
    }

    // STATIC FILE SERVING
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    let extname = String(path.extname(filePath)).toLowerCase();

    const serve = (fPath, cType) => {
        fs.stat(fPath, (err, stats) => {
            if (err || !stats.isFile()) {
                if (err && err.code === 'ENOENT') {
                    fs.readFile(path.join(__dirname, '404.html'), (e, c) => {
                        res.writeHead(404, { 'Content-Type': 'text/html' });
                        res.end(c || '404', 'utf-8');
                    });
                } else {
                    res.writeHead(500);
                    res.end('Server Error');
                }
                return;
            }

            const ext = String(path.extname(fPath)).toLowerCase();
            const cacheControl = getCacheControl(pathname, ext);
            const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
            const shouldCompress = acceptsGzip && COMPRESSIBLE.has(ext) && stats.size > 1024;

            const headers = {
                'Content-Type': cType,
                'Cache-Control': cacheControl,
                'Vary': 'Accept-Encoding',
            };

            if (shouldCompress) {
                headers['Content-Encoding'] = 'gzip';
                res.writeHead(200, headers);
                fs.createReadStream(fPath).pipe(zlib.createGzip({ level: 6 })).pipe(res);
            } else {
                res.writeHead(200, headers);
                fs.createReadStream(fPath).pipe(res);
            }
        });
    };

    if (!extname && !pathname.endsWith('/')) {
        const htmlPath = filePath + '.html';
        fs.access(htmlPath, fs.constants.F_OK, (err) => {
            if (!err) serve(htmlPath, 'text/html');
            else serve(filePath, 'application/octet-stream');
        });
    } else {
        serve(filePath, mimeTypes[extname] || 'application/octet-stream');
    }

});

server.listen(PORT, () => {
    console.log(`OnlyFlix Server running at http://localhost:${PORT}`);
});
