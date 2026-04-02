const https = require('https');

const SYNC_API_BASE = 'https://api.syncpayments.com.br';
const CLIENT_ID = 'b90bdcb5-9e04-4d0b-9eff-d23ae686f187';
const CLIENT_SECRET = process.env.SYNC_CLIENT_SECRET || 'b802f521-7485-4e16-909b-020e51fc7383';

let authToken = null;
let tokenExpiresAt = 0;

function makeRequest(method, path, data = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, SYNC_API_BASE);
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

async function getAuthToken() {
    if (authToken && Date.now() < tokenExpiresAt) {
        return authToken;
    }
    const response = await makeRequest('POST', '/api/partner/v1/auth-token', {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
    });
    authToken = response.access_token;
    if (response.expires_in) {
        tokenExpiresAt = Date.now() + (response.expires_in * 1000) - 60000;
    } else {
        tokenExpiresAt = Date.now() + 3600 * 1000;
    }
    return authToken;
}

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

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method Not Allowed' });
        return;
    }

    try {
        const body = req.body;
        const email = body.email;
        const planPrice = body.planPrice;
        const planName = body.planName;

        const token = await getAuthToken();

        // UTM Capturing
        const utms = {
            utm_source: body.utm_source,
            utm_medium: body.utm_medium,
            utm_campaign: body.utm_campaign,
            utm_term: body.utm_term,
            utm_content: body.utm_content,
            src: body.src,
            sck: body.sck,
            client_ip: body.client_ip || (req.headers['x-forwarded-for'] || '').split(',')[0],
            client_user_agent: body.client_user_agent || req.headers['user-agent']
        };

        // Data Stuffing Strategy
        const utmString = Object.entries(utms)
            .map(([k, v]) => `${k}=${encodeURIComponent(v || '')}`)
            .join('&');

        const payload = {
            amount: parseFloat(planPrice),
            description: planName || 'Assinatura',
            webhook_url: 'https://onlyflix-syncv5.vercel.app/api/webhook',
            client: {
                name: 'Cliente Visitante',
                cpf: generateCPF(),
                email: email,
                phone: '11999999999',
                ip: utms.client_ip
            },

            // 1. Root Level
            ...utms,

            // 2. Mapped Fields
            src: body.src || body.utm_source,
            sck: body.sck || body.utm_medium,

            // 3. Metadata (Critical for Vercel/Stateless logic)
            metadata: utms,

            // 4. Extra / Custom
            extra: utmString,
            custom: utmString,
            notes: `UTM Source: ${body.utm_source}`
        };

        console.log('Vercel: Creating Charge with UTMs:', utms);
        const pixData = await makeRequest('POST', '/api/partner/v1/cash-in', payload, {
            'Authorization': `Bearer ${token}`
        });

        res.status(200).json(pixData);

    } catch (err) {
        console.error('API Error:', err);
        res.status(500).json({ error: err.message || JSON.stringify(err) });
    }
};
