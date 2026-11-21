// Which pushes does each order change produce? (pure logic, no network)
import assert from 'node:assert/strict';
import { plan } from '../cf/notify.js';
const o = { userId: 'c1', shopId: 's1', shopName: 'Ravi Xerox', type: 'xerox', totalAmount: 120, documents: [{}, {}], groupOrderId: 'G123' };
const kinds = js => js.map(j => j.kind + (j.title ? ':' + j.title : '')).join(' | ');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok  ', name); };

t('new COD order → staff only', () => assert.equal(kinds(plan([{ path: 'orders/a', before: null, after: { ...o, paymentStatus: 'cod', status: 'Pending' } }])), 'new_order'));
t('new online order, unpaid → nothing yet', () => assert.equal(plan([{ path: 'orders/a', before: null, after: { ...o, paymentStatus: 'pending', status: 'Pending' } }]).length, 0));
t('online order paid → staff + customer receipt', () => assert.equal(kinds(plan([{ path: 'orders/a', before: { ...o, paymentStatus: 'pending', status: 'Pending' }, after: { ...o, paymentStatus: 'paid', status: 'Pending', amountPaid: 120 } }])), 'new_order | customer:💳 Payment received'));
t('confirmed → customer', () => assert.equal(kinds(plan([{ path: 'orders/a', before: { ...o, paymentStatus: 'cod', status: 'Pending' }, after: { ...o, paymentStatus: 'cod', status: 'Confirmed' } }])), 'customer:✅ Order confirmed'));
t('out for delivery → customer', () => assert.match(kinds(plan([{ path: 'orders/a', before: { ...o, status: 'Processing' }, after: { ...o, status: 'Out for Delivery' } }])), /Out for delivery/));
t('abandoned checkout swept → nothing', () => assert.equal(plan([{ path: 'orders/a', before: { ...o, paymentStatus: 'pending', status: 'Pending' }, after: { ...o, paymentStatus: 'abandoned', status: 'Cancelled' } }]).length, 0));
t('same status, other field → nothing', () => assert.equal(plan([{ path: 'orders/a', before: { ...o, status: 'Confirmed' }, after: { ...o, status: 'Confirmed', note: 'x' } }]).length, 0));
t('order_status mirror ignored', () => assert.equal(plan([{ path: 'order_status/a', before: { status: 'Pending' }, after: { status: 'Confirmed', userId: 'c1' } }]).length, 0));
t('xerox processing text', () => assert.match(plan([{ path: 'orders/a', before: { ...o, status: 'Confirmed' }, after: { ...o, status: 'Processing' } }])[0].title, /Printing/));
console.log(`\n${n} passed`);
