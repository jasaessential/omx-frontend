/* OMX — fetch-based stand-in for the `razorpay` npm package (its `request`
   dependency does not run on Workers). Only what server/routes/payment.js uses:
   orders.create and payments.fetch. */
class Razorpay {
    constructor({ key_id, key_secret }) {
        const auth = 'Basic ' + btoa(`${key_id}:${key_secret}`);
        const call = async (method, path, body) => {
            const res = await fetch(`https://api.razorpay.com/v1${path}`, {
                method,
                headers: { Authorization: auth, 'Content-Type': 'application/json' },
                body: body ? JSON.stringify(body) : undefined,
            });
            const j = await res.json().catch(() => ({}));
            if (!res.ok) {
                // Same shape the SDK rejects with
                const err = new Error(j?.error?.description || `Razorpay ${res.status}`);
                err.statusCode = res.status;
                err.error = j.error || {};
                throw err;
            }
            return j;
        };
        this.orders = {
            create: params => call('POST', '/orders', params),
            fetch: id => call('GET', `/orders/${encodeURIComponent(id)}`),
        };
        this.payments = {
            fetch: id => call('GET', `/payments/${encodeURIComponent(id)}`),
        };
    }
}
module.exports = Razorpay;
