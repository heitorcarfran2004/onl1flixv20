const https = require('https');

const SYNC_API_BASE = 'https://api.syncpayments.com.br';
const CLIENT_ID = 'b90bdcb5-9e04-4d0b-9eff-d23ae686f187';
const CLIENT_SECRET = process.env.SYNC_CLIENT_SECRET || 'b802f521-7485-4e16-909b-020e51fc7383';

let authToken = null;
let tokenExpiresAt = 0;

function makeRequest(method, path, data = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path.startsWith('http') ? path : SYNC_API_BASE + path);
        const options = {
            method: method,
            headers: { 'Content-Type': 'application/json', ...headers }
        };
        const req = https.request(url, options, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(body)); } catch (e) { resolve(body); }
                } else {
                    reject({ status: res.statusCode, body: body });
                }
            });
        });
        req.on('error', e => reject(e));
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

async function getAuthToken() {
    if (authToken && Date.now() < tokenExpiresAt) return authToken;
    const response = await makeRequest('POST', '/api/partner/v1/auth-token', {
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET
    });
    authToken = response.access_token;
    tokenExpiresAt = Date.now() + (response.expires_in ? response.expires_in * 1000 : 3600000) - 60000;
    return authToken;
}

// Helper to Trigger UTMify
async function sendUtmifyConversion(order) {
    if (!order.utms) return;

    console.log(`[UTMify] Vercel Trigger for Order: ${order.id}`);
    const payload = {
        order_id: order.id,
        amount: order.amount,
        status: 'approved',
        payment_method: 'pix',
        ...order.utms
    };

    try {
        await makeRequest('POST', 'https://api.utmify.com.br/v1/postback', payload);
        console.log('[UTMify] Postback sent.');
    } catch (e) {
        console.error('[UTMify] Postback failed. Attempting Pixel fallback...');
        try {
            const pixelId = '692058bf4a65d26de92c8fdc'; // Hardcoded from index.html
            const qs = Object.entries(order.utms).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
            // Using a simple GET to the pixel URL
            const pixelUrl = `https://api.utmify.com.br/pixel?id=${pixelId}&event=purchase&amount=${order.amount}&order_id=${order.id}&${qs}`;

            https.get(pixelUrl, (res) => {
                console.log(`[UTMify] Pixel fallback status: ${res.statusCode}`);
            }).on('error', (err) => console.error('[UTMify] Pixel fallback error:', err.message));
        } catch (err2) {
            console.error('[UTMify] All triggers failed.');
        }
    }
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    const { id } = req.query;

    if (!id) {
        return res.status(400).json({ error: 'Missing id query parameter' });
    }

    try {
        const token = await getAuthToken();
        const statusData = await makeRequest('GET', `/api/partner/v1/transaction/${id}`, null, {
            'Authorization': `Bearer ${token}`
        });

        // Vercel Logic: Hydrate from Metadata directly
        const remoteStatus = statusData.data ? statusData.data.status : null;
        const metadata = statusData.data ? statusData.data.metadata : null;

        if (remoteStatus === 'paid' || remoteStatus === 'completed') {
            if (metadata) {
                // Best-effort send to UTMify
                // Note: On Vercel this might run multiple times if specific deduplication isn't external (DB).
                // UTMify should handle duplicate order_id events gracefully (idempotency).
                const orderStub = {
                    id: id,
                    amount: statusData.data.amount,
                    utms: metadata
                };
                // Fire and forget (don't await, or await if we want to ensure it sends before timeout)
                // In Serverless, we SHOULD await to ensure execution completes before freeze.
                await sendUtmifyConversion(orderStub);
            }
        }

        res.status(200).json(statusData);
    } catch (err) {
        res.status(500).json({ error: err.message || JSON.stringify(err) });
    }
};
