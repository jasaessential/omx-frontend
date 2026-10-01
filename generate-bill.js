/* ═══════════════════════════════════════════════
   GENERATE & PRINT BILL — generate-bill.js
   URL params: ?orderId=xxx&shopId=xxx
   Interactive item selection & live printable invoice
   Supports single orders and group orders
   ═══════════════════════════════════════════════ */
import { auth, db } from './firebase-init.js';
import {
    doc, getDoc, getDocs, collection, query, where
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { onAuthStateChanged }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { WORKER_URL } from './env-config.js';

/* ── URL Params ── */
const orderId = new URLSearchParams(window.location.search).get('orderId');
const shopId  = new URLSearchParams(window.location.search).get('shopId');

/* ── State ── */
let currentOrder    = null;
let groupOrdersList = [];
let combinedItems   = []; // Master array of all items under this order or group order
let shopData        = null;
let customerProfile = null;
let xeroxMeta       = { paper: [], binding: [], lamination: [] };
let selectedIndices = new Set();

/* ── Helpers ── */
function esc(s) {
    return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(raw) {
    if (!raw) return new Date().toLocaleDateString('en-IN');
    try {
        const d = raw.toDate ? raw.toDate() : new Date((raw.seconds || 0) * 1000);
        return d.toLocaleDateString('en-IN', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true
        });
    } catch (_) { return new Date().toLocaleDateString('en-IN'); }
}

const COLOR_LABELS  = { bw: 'Black & White', color: 'Color', mixed: 'Mixed' };
const FORMAT_LABELS = { frontOnly: 'Front Only', both: 'Front & Back' };
function resolveMetaName(list, id) {
    if (!id || id === 'none') return null;
    return list.find(x => x.id === id)?.name || null;
}

function toast(msg, type = '') {
    const el = document.getElementById('soToast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'so-toast ' + type;
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

/* ── Back Navigation ── */
window.goBack = function () {
    if (shopId) {
        window.location.href = `seller-order-details.html?orderId=${encodeURIComponent(orderId)}&shopId=${encodeURIComponent(shopId)}`;
    } else {
        history.back();
    }
};

/* ── Print Trigger ── */
window.triggerPrint = function () {
    if (selectedIndices.size === 0) {
        toast('Please select at least one item to print the bill.', 'error');
        return;
    }
    window.print();
};

/* ── Auth + Access Guard ── */
onAuthStateChanged(auth, async user => {
    if (!user) {
        window.location.replace('login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search));
        return;
    }
    if (!orderId) {
        showError();
        return;
    }

    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) { window.location.replace('index.html'); return; }
        const uData     = snap.data();
        const roles     = uData.roles || [uData.role || 'user'];
        const userShops = uData.userShops || [];
        const isAdmin   = roles.includes('admin');
        const isSeller  = roles.includes('seller');
        const isEmployee = roles.includes('employee');

        let hasAccess = isAdmin;
        if (!hasAccess && shopId) {
            hasAccess = userShops.some(s => s.shopId === shopId);
        }

        if (!hasAccess && (isSeller || isEmployee) && shopId) {
            try {
                const shopSnap = await getDoc(doc(db, 'shops', shopId));
                if (shopSnap.exists()) {
                    const sd = shopSnap.data();
                    if ((sd.owners || []).includes(user.uid) || (sd.employees || []).includes(user.uid)) hasAccess = true;
                }
            } catch (e) { console.warn('shop access check:', e); }
        }

        // Admin mode without explicit shopId in URL
        if (isAdmin && !shopId) {
            hasAccess = true;
        }

        if (!hasAccess) {
            toast('Access denied.', 'error');
            setTimeout(() => window.location.replace('index.html'), 1400);
            return;
        }

        await loadXeroxMeta();
        await loadOrderData();
    } catch (err) {
        console.error('[GenerateBill] auth init:', err);
        showError();
    }
});

async function loadXeroxMeta() {
    try {
        const res = await fetch(`${WORKER_URL}/api/config/xerox`, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
            const json = await res.json();
            const cfg  = json.config || json;
            if (cfg.paper?.length || cfg.binding?.length) {
                xeroxMeta.paper      = cfg.paper      || [];
                xeroxMeta.binding    = cfg.binding    || [];
                xeroxMeta.lamination = cfg.lamination || [];
                return;
            }
        }
    } catch (_) {}
    try {
        const [p, b, l] = await Promise.all([
            getDocs(collection(db, 'xerox_config_paper')),
            getDocs(collection(db, 'xerox_config_binding')),
            getDocs(collection(db, 'xerox_config_lamination')),
        ]);
        xeroxMeta.paper      = p.docs.map(d => ({ id: d.id, ...d.data() }));
        xeroxMeta.binding    = b.docs.map(d => ({ id: d.id, ...d.data() }));
        xeroxMeta.lamination = l.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) { console.warn('xerox meta:', e); }
}

async function loadOrderData() {
    try {
        let primaryDoc = null;
        const oSnap = await getDoc(doc(db, 'orders', orderId));
        if (oSnap.exists()) {
            primaryDoc = { id: oSnap.id, ...oSnap.data() };
        } else {
            // Try querying by groupOrderId
            const qG = query(collection(db, 'orders'), where('groupOrderId', '==', orderId));
            const gSnap = await getDocs(qG);
            if (!gSnap.empty) {
                primaryDoc = { id: gSnap.docs[0].id, ...gSnap.docs[0].data() };
            }
        }

        if (!primaryDoc) {
            showError();
            return;
        }

        currentOrder = primaryDoc;
        const effectiveShopId = shopId || currentOrder.shopId;

        // Shop Profile
        if (effectiveShopId) {
            try {
                const sSnap = await getDoc(doc(db, 'shops', effectiveShopId));
                if (sSnap.exists()) shopData = { id: sSnap.id, ...sSnap.data() };
            } catch (e) { console.warn('shop fetch:', e); }
        }

        // Customer Profile
        if (currentOrder.userId) {
            try {
                const uSnap = await getDoc(doc(db, 'users', currentOrder.userId));
                if (uSnap.exists()) {
                    const ud = uSnap.data();
                    customerProfile = {
                        name: ud.fullName || ud.name || 'Customer',
                        email: ud.email || '',
                        displayId: ud.userId || currentOrder.userId.slice(0, 8).toUpperCase()
                    };
                }
            } catch (e) { console.warn('customer fetch:', e); }
        }

        // Fetch Group Order items if groupOrderId exists
        const gId = currentOrder.groupOrderId;
        groupOrdersList = [currentOrder];

        if (gId) {
            try {
                let qGroup;
                if (effectiveShopId) {
                    qGroup = query(collection(db, 'orders'), where('groupOrderId', '==', gId), where('shopId', '==', effectiveShopId));
                } else {
                    qGroup = query(collection(db, 'orders'), where('groupOrderId', '==', gId));
                }
                const gSnap = await getDocs(qGroup);
                if (!gSnap.empty) {
                    groupOrdersList = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));
                } else if (effectiveShopId) {
                    // Fallback: try without shopId filter
                    const qFallback = query(collection(db, 'orders'), where('groupOrderId', '==', gId));
                    const fSnap = await getDocs(qFallback);
                    if (!fSnap.empty) {
                        groupOrdersList = fSnap.docs.map(d => ({ id: d.id, ...d.data() }));
                    }
                }
            } catch (e) { console.warn('Group order fetch:', e); }
        }

        // Combine items from all group orders
        combinedItems = [];
        groupOrdersList.forEach(ord => {
            const isXerox = ord.type === 'xerox';
            const items = isXerox ? (ord.documents || []) : (ord.items || []);
            items.forEach(it => {
                combinedItems.push({
                    ...it,
                    _isXerox: isXerox,
                    _orderId: ord.id
                });
            });
        });

        // Initialize Selected Items: select non-cancelled / non-rejected items by default
        selectedIndices.clear();
        combinedItems.forEach((item, i) => {
            const s = (item.status || 'pending').toLowerCase();
            if (s !== 'cancelled' && s !== 'rejected') {
                selectedIndices.add(i);
            }
        });
        if (selectedIndices.size === 0 && combinedItems.length > 0) {
            combinedItems.forEach((_, i) => selectedIndices.add(i));
        }

        hideSkeleton();
        renderChecklist();
        updateBillPreview();

    } catch (err) {
        console.error('[GenerateBill] loadOrderData:', err);
        showError();
    }
}

/* ── Checklist Rendering ── */
function renderChecklist() {
    const container = document.getElementById('billItemsChecklist');

    if (!combinedItems.length) {
        container.innerHTML = `<div style="padding:14px;color:var(--txt3);font-size:.8rem;">No items found in this order.</div>`;
        return;
    }

    container.innerHTML = combinedItems.map((item, i) => {
        const isChecked = selectedIndices.has(i);
        const status    = (item.status || 'pending').toLowerCase();
        const isRejected = status === 'rejected' || status === 'cancelled';
        const isXerox   = item._isXerox === true;
        
        let title = '', desc = '', priceText = '';
        if (isXerox) {
            const cfg = item.config || {};
            const paperName = resolveMetaName(xeroxMeta.paper, cfg.paperId) || 'Standard Paper';
            const colorName = COLOR_LABELS[cfg.color] || cfg.color || 'B&W';
            const fmtName   = FORMAT_LABELS[cfg.format] || cfg.format || 'Front Only';
            const qty       = cfg.quantity || 1;
            title     = item.name || `Document #${i + 1}`;
            desc      = `${item.pages || 0} pgs · ${paperName} · ${colorName} · ${fmtName} × ${qty} cop${qty > 1 ? 'ies' : 'y'}`;
            priceText = `₹${(item.price || 0).toFixed(2)}`;
        } else {
            const qty = item.qty || 1;
            const lineTotal = (item.price || 0) * qty;
            title     = item.name || `Product #${i + 1}`;
            desc      = `Qty: ${qty} × ₹${(item.price || 0).toFixed(2)}`;
            priceText = `₹${lineTotal.toFixed(2)}`;
        }

        const badgeHtml = isRejected
            ? `<span style="font-size:.65rem;font-weight:800;color:#ef4444;background:#fee2e2;padding:2px 6px;border-radius:4px;margin-left:6px;text-transform:uppercase;">${status}</span>`
            : '';

        return `
<div class="bill-item-row" onclick="toggleItemRow(${i}, event)">
    <div class="bill-item-left">
        <input type="checkbox" class="bill-checkbox" id="chkItem_${i}" ${isChecked ? 'checked' : ''} 
            onclick="event.stopPropagation(); toggleItem(${i})">
        <div class="bill-item-info">
            <div class="bill-item-title">${esc(title)}${badgeHtml}</div>
            <div class="bill-item-sub">${esc(desc)}</div>
        </div>
    </div>
    <div style="font-size:.84rem;font-weight:800;color:var(--txt1);white-space:nowrap;">${priceText}</div>
</div>`;
    }).join('');
}

window.toggleItemRow = function(i, event) {
    if (event.target.tagName === 'INPUT') return;
    const chk = document.getElementById(`chkItem_${i}`);
    if (chk) {
        chk.checked = !chk.checked;
        toggleItem(i);
    }
};

window.toggleItem = function(i) {
    if (selectedIndices.has(i)) {
        selectedIndices.delete(i);
    } else {
        selectedIndices.add(i);
    }
    updateBillPreview();
};

window.selectAllItems = function(select) {
    selectedIndices.clear();
    if (select) {
        combinedItems.forEach((_, i) => selectedIndices.add(i));
    }
    renderChecklist();
    updateBillPreview();
};

/* ── Live Invoice Recalculation & Preview Render ── */
window.updateBillPreview = function() {
    if (!currentOrder) return;
    const o       = currentOrder;
    const s       = shopData || {};
    const ordRef  = o.groupOrderId || o.id.slice(0, 8).toUpperCase();

    // 1. Shop Info Header
    document.getElementById('invShopName').textContent = s.name || o.shopName || 'STORE NAME';
    document.getElementById('invShopAddr').textContent = s.address || o.shopAddress || 'Local Center';
    const shopPhone = s.phone || s.mobile || o.contacts?.mobile || '—';
    document.getElementById('invShopContact').textContent = `Phone: ${shopPhone}`;

    // 2. Invoice Meta
    document.getElementById('invNumber').textContent  = `INV-${ordRef}`;
    document.getElementById('invDate').textContent    = fmtDate(o.createdAt);
    document.getElementById('invOrderId').textContent = `#${ordRef}`;

    // 3. Customer Info
    const cName  = customerProfile?.name || o.userName || 'Guest Customer';
    const cPhone = o.contacts?.mobile || o.contacts?.altMobile || '—';
    const addr   = o.deliveryAddress || {};
    const cAddr  = (addr.street || addr.city)
        ? `${addr.street || ''}${addr.city ? ', ' + addr.city : ''}${addr.pincode ? ' - ' + addr.pincode : ''}`
        : 'Self Pickup / Counter';

    document.getElementById('invCustName').textContent  = cName;
    document.getElementById('invCustPhone').innerHTML = `<i class="fa-solid fa-phone"></i> ${esc(cPhone)}`;
    document.getElementById('invCustAddr').innerHTML  = `<i class="fa-solid fa-location-dot"></i> ${esc(cAddr)}`;

    // 4. Order & Payment Info
    const isPickup  = o.fulfillmentType === 'pickup' || o.deliveryMode === 'pickup' || o.isPickup === true || o.orderType === 'pickup' || (o.deliveryFee === 0 && !o.deliveryAddress);
    const pMethod   = (o.paymentMethod || '').toLowerCase();
    const pStatus   = (o.paymentStatus || '').toLowerCase();
    const isPartial = pMethod === 'partial' || pStatus === 'partial_paid' || (o.balanceDue > 0 && o.amountPaid > 0);
    const isPaid    = pStatus === 'paid' || pMethod === 'paid' || (pMethod === 'razorpay' && pStatus !== 'pending' && !isPartial);

    document.getElementById('invFulfillment').textContent = isPickup ? 'Self Pickup (Pick Myself)' : 'Home Delivery';
    document.getElementById('invPayMethod').textContent   = pMethod === 'razorpay' ? 'Razorpay Online' : (pMethod === 'partial' ? 'Partial Payment' : 'Cash on Delivery (COD)');
    
    const statusEl = document.getElementById('invPayStatus');
    if (isPartial) {
        statusEl.textContent = 'PARTIAL PAID';
        statusEl.style.background = '#e0f2fe'; statusEl.style.color = '#0284c7';
    } else if (isPaid) {
        statusEl.textContent = 'PAID ONLINE';
        statusEl.style.background = '#dcfce7'; statusEl.style.color = '#15803d';
    } else {
        statusEl.textContent = 'PENDING (COD)';
        statusEl.style.background = '#fef3c7'; statusEl.style.color = '#b45309';
    }

    // 5. Selected Items Table & Pricing Calculation
    let subtotal = 0;
    const tableBody = document.getElementById('invItemsBody');
    let itemRowsHtml = '';
    let rowNum = 1;
    let hasXeroxItems = false;

    combinedItems.forEach((item, i) => {
        if (!selectedIndices.has(i)) return; // Skip unselected
        const isXerox = item._isXerox === true;
        if (isXerox) hasXeroxItems = true;

        if (isXerox) {
            const cfg = item.config || {};
            const paperName = resolveMetaName(xeroxMeta.paper, cfg.paperId) || 'Standard Paper';
            const bindName  = resolveMetaName(xeroxMeta.binding, cfg.bindingId);
            const lamName   = resolveMetaName(xeroxMeta.lamination, cfg.laminationId);
            const colorName = COLOR_LABELS[cfg.color] || cfg.color || 'B&W';
            const fmtName   = FORMAT_LABELS[cfg.format] || cfg.format || 'Front Only';
            const qty       = cfg.quantity || 1;
            const pages     = item.pages || 0;
            const lineTotal = item.price || 0;

            subtotal += lineTotal;

            const specParts = [
                `${pages} pages`, paperName, colorName, fmtName,
                cfg.color === 'mixed' ? `Colour pages: ${cfg.colorPages}` : null,
                bindName ? `Binding: ${bindName}${cfg.bindingSet ? ` (combined book, file ${cfg.bindingSet.position}/${cfg.bindingSet.size})` : ''}` : null,
                lamName  ? `Lamination: ${lamName}`  : null
            ].filter(Boolean).join(' · ');

            const unitRateText = pages > 0 ? `₹${(lineTotal / (pages * qty)).toFixed(2)}/pg` : '—';

            itemRowsHtml += `
<tr>
    <td style="text-align:center;">${rowNum++}</td>
    <td>
        <div class="inv-item-name">${esc(item.name || 'Document Print')}</div>
        <div class="inv-item-sub">${esc(specParts)}</div>
    </td>
    <td style="text-align:center;">${unitRateText}</td>
    <td style="text-align:center;">${qty} cop${qty > 1 ? 'ies' : 'y'}</td>
    <td style="text-align:right;font-weight:700;">₹${lineTotal.toFixed(2)}</td>
</tr>`;
        } else {
            const qty = item.qty || 1;
            const unitPrice = item.price || 0;
            const lineTotal = unitPrice * qty;

            subtotal += lineTotal;

            itemRowsHtml += `
<tr>
    <td style="text-align:center;">${rowNum++}</td>
    <td>
        <div class="inv-item-name">${esc(item.name || 'Product Item')}</div>
    </td>
    <td style="text-align:center;">₹${unitPrice.toFixed(2)}</td>
    <td style="text-align:center;">${qty}</td>
    <td style="text-align:right;font-weight:700;">₹${lineTotal.toFixed(2)}</td>
</tr>`;
        }
    });

    if (!itemRowsHtml) {
        itemRowsHtml = `<tr><td colspan="5" style="text-align:center;padding:16px;color:#94a3b8;font-style:italic;">No items selected for this bill.</td></tr>`;
    }

    tableBody.innerHTML = itemRowsHtml;

    // 6. Delivery Fee Calculation
    const chkDelivery = document.getElementById('chkIncludeDelivery');
    let deliveryFee = 0;

    if (!isPickup && chkDelivery.checked && shopData) {
        const rules = hasXeroxItems
            ? (shopData.deliveryPrices?.xerox || [])
            : (shopData.deliveryPrices?.others || []);
        const rule = rules.find(r => subtotal >= r.min && (r.max == null || subtotal <= r.max));
        if (rule) deliveryFee = rule.fee || 0;
    }

    const deliveryRowEl = document.getElementById('invDeliveryRow');
    if (isPickup || !chkDelivery.checked) {
        deliveryRowEl.style.display = 'none';
        deliveryFee = 0;
    } else {
        deliveryRowEl.style.display = 'table-row';
        document.getElementById('invDeliveryFee').textContent = deliveryFee === 0 ? 'FREE' : `₹${deliveryFee.toFixed(2)}`;
    }

    // 7. Coupon discount — billed share is proportional when only some items are billed
    const orderDiscount = Number(o.discountAmount) || 0;
    const orderSubtotal = Number(o.subtotal) || 0;
    const couponDiscount = orderDiscount > 0 && subtotal > 0
        ? Math.min(subtotal, Math.round(orderDiscount * Math.min(1, subtotal / (orderSubtotal || subtotal)) * 100) / 100)
        : 0;
    const discountRowEl = document.getElementById('invDiscountRow');
    if (discountRowEl) {
        discountRowEl.style.display = couponDiscount > 0 ? 'table-row' : 'none';
        if (couponDiscount > 0) {
            document.getElementById('invDiscountLabel').textContent = `Coupon Discount${o.couponCode ? ` (${o.couponCode})` : ''}:`;
            document.getElementById('invDiscount').textContent = `-₹${couponDiscount.toFixed(2)}`;
        }
    }

    // 7b. Wallet — prepaid share, billed proportionally like the coupon
    const orderWallet = Number(o.walletAmount) || 0;
    const walletShare = orderWallet > 0 && subtotal > 0
        ? Math.min(subtotal - couponDiscount + deliveryFee, Math.round(orderWallet * Math.min(1, subtotal / (orderSubtotal || subtotal)) * 100) / 100)
        : 0;
    const walletRowEl = document.getElementById('invWalletRow');
    if (walletRowEl) {
        walletRowEl.style.display = walletShare > 0 ? 'table-row' : 'none';
        if (walletShare > 0) document.getElementById('invWallet').textContent = `-₹${walletShare.toFixed(2)}`;
    }

    // 8. Totals & Balance
    const grandTotal = subtotal - couponDiscount - walletShare + deliveryFee;
    const paidAmt    = isPaid ? grandTotal : (o.amountPaid || 0);
    const balanceDue = isPaid ? 0 : Math.max(0, grandTotal - paidAmt);

    document.getElementById('invSubtotal').textContent   = `₹${subtotal.toFixed(2)}`;
    document.getElementById('invGrandTotal').textContent = `₹${grandTotal.toFixed(2)}`;

    const paidRow = document.getElementById('invPaidRow');
    const balRow  = document.getElementById('invBalanceRow');

    if (isPartial || paidAmt > 0) {
        paidRow.style.display = 'table-row';
        balRow.style.display  = 'table-row';
        document.getElementById('invAmountPaid').textContent = `₹${paidAmt.toFixed(2)}`;
        document.getElementById('invBalanceDue').textContent = `₹${balanceDue.toFixed(2)}`;
    } else if (isPaid) {
        paidRow.style.display = 'table-row';
        balRow.style.display  = 'none';
        document.getElementById('invAmountPaid').textContent = `₹${grandTotal.toFixed(2)}`;
    } else {
        paidRow.style.display = 'none';
        balRow.style.display  = 'table-row';
        document.getElementById('invBalanceDue').textContent = `₹${grandTotal.toFixed(2)}`;
    }

    // 9. Custom Note
    const customNoteInput = document.getElementById('billCustomNote');
    const customNoteText  = customNoteInput ? customNoteInput.value.trim() : '';
    document.getElementById('invNotesText').textContent = customNoteText || 'Thank you for your business! Please retain this bill for your records.';
};

/* ── UI Skeleton & Error ── */
function hideSkeleton() {
    const skel = document.getElementById('billSkeleton');
    const cont = document.getElementById('billContent');
    if (skel) skel.style.display = 'none';
    if (cont) cont.style.display = 'block';
}

function showError() {
    const skel  = document.getElementById('billSkeleton');
    const cont  = document.getElementById('billContent');
    const errEl = document.getElementById('billError');
    if (skel)  skel.style.display  = 'none';
    if (cont)  cont.style.display  = 'none';
    if (errEl) errEl.style.display = 'block';
}
