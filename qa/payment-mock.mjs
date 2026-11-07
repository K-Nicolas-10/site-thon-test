// Payment mock for QA (ADR 0001, D-28 gate 2): accepts charges, then delivers a payment.succeeded
// webhook to the URL it was given. Every charge and webhook delivery is recorded and listed at
// GET /calls, which the QA runner asserts against. No real payment provider is ever contacted.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = 4010;
const WEBHOOK_DELAY_MS = 100;
const calls = [];

function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

async function readJson(req) {
    let raw = '';
    for await (const chunk of req) {
        raw += chunk;
    }
    return JSON.parse(raw || '{}');
}

async function deliverWebhook(charge) {
    const call = {
        kind: 'webhook',
        order_id: charge.order_id,
        charge_id: charge.id,
        url: charge.webhook_url,
        at: new Date().toISOString(),
    };
    try {
        const response = await fetch(charge.webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'payment.succeeded',
                order_id: charge.order_id,
                charge_id: charge.id,
                amount: charge.amount,
            }),
        });
        call.status = response.status;
    } catch (error) {
        call.status = 0;
        call.error = String(error);
    }
    calls.push(call);
}

createServer(async (req, res) => {
    try {
        if (req.method === 'GET' && req.url === '/healthz') {
            return send(res, 200, { ok: true });
        }
        if (req.method === 'GET' && req.url === '/calls') {
            return send(res, 200, calls);
        }
        if (req.method === 'POST' && req.url === '/charges') {
            const body = await readJson(req);
            if (!body.order_id || !body.webhook_url) {
                return send(res, 422, {
                    message: 'order_id and webhook_url are required',
                });
            }
            const charge = {
                id: `ch_${randomUUID()}`,
                order_id: body.order_id,
                amount: body.amount,
                webhook_url: body.webhook_url,
            };
            calls.push({
                kind: 'charge',
                order_id: charge.order_id,
                charge_id: charge.id,
                amount: charge.amount,
                at: new Date().toISOString(),
            });
            setTimeout(() => deliverWebhook(charge), WEBHOOK_DELAY_MS);
            return send(res, 201, { id: charge.id, status: 'pending' });
        }
        send(res, 404, { message: 'not found' });
    } catch (error) {
        send(res, 400, { message: String(error) });
    }
}).listen(PORT, () => console.log(`payment mock on :${PORT}`));
