/* ═══════════════════════════════════════════════
   JASA V2 — xerox-book.js
   Shared by seller-order-details.js and admin-order-details.js.

   A combined book's binding is charged on one of its files
   (config.bindingSet.chargedHere / bindingCharge, set by the server).
   When staff reject that file, the charge moves to the book's next active
   file, so the order still pays for the binding of the remaining files.
   Same logic as moveBookCharge() in server/pricing.js.
   ═══════════════════════════════════════════════ */

const num = v => Number(v) || 0;
const r2  = n => Math.round(n * 100) / 100;
const inactive = d => ['rejected', 'cancelled'].includes(String(d?.status || '').toLowerCase());

/** Returns a new documents array with the binding charge on an active book file. */
export function moveBookCharge(docs) {
    const list = docs.map(d => d);
    if (list.some(d => d?.config?.bindingSet?.chargedHere && !inactive(d))) return list;
    const charge = list.reduce((s, d) => s + (d?.config?.bindingSet?.chargedHere ? num(d.config.bindingSet.bindingCharge) : 0), 0);
    if (!(charge > 0)) return list;
    const next = list
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => d?.config?.bindingSet && !inactive(d))
        .sort((a, b) => num(a.d.config.bindingSet.position) - num(b.d.config.bindingSet.position))[0];
    if (!next) return list;   // whole book rejected — nothing left to bind
    list.forEach((d, i) => {
        if (d?.config?.bindingSet?.chargedHere) {
            list[i] = { ...d, price: r2(num(d.price) - charge),
                        config: { ...d.config, bindingSet: { ...d.config.bindingSet, chargedHere: false, bindingCharge: 0 } } };
        }
    });
    const n = list[next.i];
    list[next.i] = { ...n, price: r2(num(n.price) + charge),
                     config: { ...n.config, bindingSet: { ...n.config.bindingSet, chargedHere: true, bindingCharge: charge } } };
    return list;
}
