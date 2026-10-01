/* ═══════════════════════════════════════════════════════
   support.js — JASA Essentials Support Page Logic
   ═══════════════════════════════════════════════════════ */

let supportData = null;
let pendingAction = null;

document.addEventListener('DOMContentLoaded', () => {
    loadSupportData();
    setupModalListeners();
});

async function loadSupportData() {
    const container = document.getElementById('spCardsContainer');
    if (!container) return;

    try {
        const response = await fetch('support.json');
        if (!response.ok) throw new Error('Failed to load support configuration');
        supportData = await response.json();
    } catch (err) {
        console.warn('Could not fetch support.json, using fallback data:', err);
        // Fallback default matching exact prompt request
        supportData = {
            title: "JASA Essentials Customer Support",
            subtitle: "We are here to help you with your orders, Xerox services, and inquiries.",
            emails: [
                {
                    id: "email-1",
                    address: "jasaessentials3@gmail.com",
                    label: "Official Support Email",
                    description: "Send us your queries, bulk order requests, or feedback anytime.",
                    badge: "Primary"
                }
            ],
            phoneNumbers: [
                {
                    id: "phone-1",
                    number: "7639276705",
                    displayNumber: "+91 76392 76705",
                    label: "Customer Helpline",
                    timing: "Mon - Sat: 9:00 AM - 8:00 PM",
                    badge: "Call Us"
                }
            ],
            whatsappNumbers: [
                {
                    id: "wa-1",
                    number: "7639276705",
                    countryCode: "91",
                    displayNumber: "+91 76392 76705",
                    label: "Instant WhatsApp Support",
                    timing: "24/7 Available",
                    badge: "WhatsApp"
                }
            ],
            prefilledMessages: {
                whatsapp: "Hello JASA Essentials Support, I need help regarding your services / my order.",
                emailSubject: "Support Inquiry - JASA Essentials",
                emailBody: "Hello JASA Essentials Support Team,\n\nI need assistance with my order/query.\n\nPlease get back to me as soon as possible.\n\nThank you!"
            }
        };
    }

    renderSupportCards();
}

function renderSupportCards() {
    const container = document.getElementById('spCardsContainer');
    if (!container || !supportData) return;

    let html = '';

    // 1. WhatsApp Section
    if (supportData.whatsappNumbers && supportData.whatsappNumbers.length > 0) {
        html += `
        <div class="sp-section">
            <div class="sp-section-title">
                <i class="fa-brands fa-whatsapp" style="color:#25d366;"></i> WhatsApp Support
            </div>
            <div class="sp-cards-grid">
                ${supportData.whatsappNumbers.map((wa, idx) => `
                    <div class="sp-card">
                        <div>
                            <div class="sp-card-top">
                                <div class="sp-card-icon-wrap sp-icon-wa">
                                    <i class="fa-brands fa-whatsapp"></i>
                                </div>
                                <span class="sp-badge sp-badge-wa">${wa.badge || 'WhatsApp'}</span>
                            </div>
                            <div class="sp-card-label">${wa.label || 'Instant Chat'}</div>
                            <div class="sp-card-value">${wa.displayNumber || wa.number}</div>
                            <div class="sp-card-desc">${wa.timing || 'Fast response on WhatsApp'}</div>
                        </div>
                        <div class="sp-card-actions">
                            <button class="sp-btn sp-btn-wa" onclick="initiateAction('whatsapp', ${idx})">
                                <i class="fa-brands fa-whatsapp"></i> Chat on WhatsApp
                            </button>
                            <button class="sp-btn sp-btn-secondary" onclick="copyToClipboard('${wa.number}', 'WhatsApp number')" title="Copy Number">
                                <i class="fa-regular fa-copy"></i>
                            </button>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>`;
    }

    // 2. Phone Call Section
    if (supportData.phoneNumbers && supportData.phoneNumbers.length > 0) {
        html += `
        <div class="sp-section">
            <div class="sp-section-title">
                <i class="fa-solid fa-phone" style="color:var(--primary);"></i> Phone Support
            </div>
            <div class="sp-cards-grid">
                ${supportData.phoneNumbers.map((phone, idx) => `
                    <div class="sp-card">
                        <div>
                            <div class="sp-card-top">
                                <div class="sp-card-icon-wrap sp-icon-phone">
                                    <i class="fa-solid fa-phone"></i>
                                </div>
                                <span class="sp-badge sp-badge-phone">${phone.badge || 'Call Us'}</span>
                            </div>
                            <div class="sp-card-label">${phone.label || 'Direct Call'}</div>
                            <div class="sp-card-value">${phone.displayNumber || phone.number}</div>
                            <div class="sp-card-desc">${phone.timing || 'Available during business hours'}</div>
                        </div>
                        <div class="sp-card-actions">
                            <button class="sp-btn sp-btn-phone" onclick="initiateAction('phone', ${idx})">
                                <i class="fa-solid fa-phone"></i> Call Support
                            </button>
                            <button class="sp-btn sp-btn-secondary" onclick="copyToClipboard('${phone.number}', 'Phone number')" title="Copy Number">
                                <i class="fa-regular fa-copy"></i>
                            </button>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>`;
    }

    // 3. Email Section
    if (supportData.emails && supportData.emails.length > 0) {
        html += `
        <div class="sp-section">
            <div class="sp-section-title">
                <i class="fa-solid fa-envelope" style="color:#f59e0b;"></i> Email Support
            </div>
            <div class="sp-cards-grid">
                ${supportData.emails.map((email, idx) => `
                    <div class="sp-card">
                        <div>
                            <div class="sp-card-top">
                                <div class="sp-card-icon-wrap sp-icon-email">
                                    <i class="fa-solid fa-envelope"></i>
                                </div>
                                <span class="sp-badge sp-badge-email">${email.badge || 'Email'}</span>
                            </div>
                            <div class="sp-card-label">${email.label || 'Official Email'}</div>
                            <div class="sp-card-value" style="font-size: 1.05rem;">${email.address}</div>
                            <div class="sp-card-desc">${email.description || 'Send us your inquiries anytime'}</div>
                        </div>
                        <div class="sp-card-actions">
                            <button class="sp-btn sp-btn-email" onclick="initiateAction('email', ${idx})">
                                <i class="fa-solid fa-paper-plane"></i> Send Email
                            </button>
                            <button class="sp-btn sp-btn-secondary" onclick="copyToClipboard('${email.address}', 'Email address')" title="Copy Email">
                                <i class="fa-regular fa-copy"></i>
                            </button>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>`;
    }

    container.innerHTML = html;
}

/* ── Modal Confirmation Handlers ── */
function initiateAction(type, index) {
    if (!supportData) return;

    const modalOverlay = document.getElementById('spModalOverlay');
    const modalIconWrap = document.getElementById('spModalIcon');
    const modalTitle = document.getElementById('spModalTitle');
    const modalSub = document.getElementById('spModalSub');
    const modalBody = document.getElementById('spModalBody');
    const modalConfirmBtn = document.getElementById('spModalConfirmBtn');

    if (!modalOverlay || !modalBody || !modalConfirmBtn) return;

    const prefilled = supportData.prefilledMessages || {};

    if (type === 'whatsapp') {
        const item = supportData.whatsappNumbers[index];
        const cleanNumber = (item.countryCode ? item.countryCode : '91') + item.number.replace(/\D/g, '');
        const text = prefilled.whatsapp || "Hello JASA Essentials Support, I need assistance.";

        modalIconWrap.className = 'sp-modal-icon sp-icon-wa';
        modalIconWrap.innerHTML = '<i class="fa-brands fa-whatsapp"></i>';
        modalTitle.textContent = 'Redirect to WhatsApp?';
        modalSub.textContent = 'You will be redirected to WhatsApp with prefilled message.';

        modalBody.innerHTML = `
            <div class="sp-modal-field">
                <div class="sp-modal-field-label">Recipient Number</div>
                <div class="sp-modal-field-value">${item.displayNumber || item.number}</div>
            </div>
            <div class="sp-modal-field">
                <div class="sp-modal-field-label">Prefilled Message Preview</div>
                <div class="sp-modal-preview-box">${escapeHtml(text)}</div>
            </div>
        `;

        modalConfirmBtn.className = 'sp-modal-btn-confirm sp-btn-wa';
        modalConfirmBtn.innerHTML = '<i class="fa-brands fa-whatsapp"></i> Continue to WhatsApp';

        pendingAction = () => {
            const url = `https://wa.me/${cleanNumber}?text=${encodeURIComponent(text)}`;
            window.open(url, '_blank');
        };
    } else if (type === 'phone') {
        const item = supportData.phoneNumbers[index];
        const cleanNumber = item.number.replace(/\D/g, '');

        modalIconWrap.className = 'sp-modal-icon sp-icon-phone';
        modalIconWrap.innerHTML = '<i class="fa-solid fa-phone"></i>';
        modalTitle.textContent = 'Place Phone Call?';
        modalSub.textContent = 'Open your dialer to make a direct call.';

        modalBody.innerHTML = `
            <div class="sp-modal-field">
                <div class="sp-modal-field-label">Phone Number</div>
                <div class="sp-modal-field-value">${item.displayNumber || item.number}</div>
            </div>
            <div class="sp-modal-field">
                <div class="sp-modal-field-label">Service Label</div>
                <div class="sp-modal-preview-box">${escapeHtml(item.label || 'Helpline')}</div>
            </div>
        `;

        modalConfirmBtn.className = 'sp-modal-btn-confirm sp-btn-phone';
        modalConfirmBtn.innerHTML = '<i class="fa-solid fa-phone"></i> Dial Number';

        pendingAction = () => {
            window.location.href = `tel:${cleanNumber}`;
        };
    } else if (type === 'email') {
        const item = supportData.emails[index];
        const subject = prefilled.emailSubject || "Support Inquiry - JASA Essentials";
        const body = prefilled.emailBody || "Hello JASA Essentials Support Team,\n\nI need assistance.";

        modalIconWrap.className = 'sp-modal-icon sp-icon-email';
        modalIconWrap.innerHTML = '<i class="fa-solid fa-envelope"></i>';
        modalTitle.textContent = 'Compose Support Email?';
        modalSub.textContent = 'You will be redirected to your email client with prefilled details.';

        modalBody.innerHTML = `
            <div class="sp-modal-field">
                <div class="sp-modal-field-label">Send To</div>
                <div class="sp-modal-field-value">${item.address}</div>
            </div>
            <div class="sp-modal-field">
                <div class="sp-modal-field-label">Subject</div>
                <div class="sp-modal-preview-box">${escapeHtml(subject)}</div>
            </div>
            <div class="sp-modal-field">
                <div class="sp-modal-field-label">Message Preview</div>
                <div class="sp-modal-preview-box">${escapeHtml(body)}</div>
            </div>
        `;

        modalConfirmBtn.className = 'sp-modal-btn-confirm sp-btn-email';
        modalConfirmBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Open Email App';

        pendingAction = () => {
            const mailtoUrl = `mailto:${item.address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
            window.location.href = mailtoUrl;
        };
    }

    modalOverlay.classList.add('active');
}

function setupModalListeners() {
    const modalOverlay = document.getElementById('spModalOverlay');
    const cancelBtn = document.getElementById('spModalCancelBtn');
    const confirmBtn = document.getElementById('spModalConfirmBtn');

    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeModal);
    }

    if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
            if (typeof pendingAction === 'function') {
                pendingAction();
            }
            closeModal();
        });
    }

    if (modalOverlay) {
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) closeModal();
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });
}

function closeModal() {
    const modalOverlay = document.getElementById('spModalOverlay');
    if (modalOverlay) {
        modalOverlay.classList.remove('active');
    }
    pendingAction = null;
}

/* ── Copy Helper & Toast ── */
function copyToClipboard(text, label = 'Text') {
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => {
            showToast(`${label} copied to clipboard!`);
        }).catch(() => {
            fallbackCopyText(text, label);
        });
    } else {
        fallbackCopyText(text, label);
    }
}

function fallbackCopyText(text, label) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
        showToast(`${label} copied!`);
    } catch (err) {
        showToast(`Could not copy automatically`);
    }
    document.body.removeChild(textArea);
}

function showToast(message) {
    const toast = document.getElementById('spToast');
    if (!toast) return;

    toast.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#25d366;"></i> ${escapeHtml(message)}`;
    toast.classList.add('show');

    setTimeout(() => {
        toast.classList.remove('show');
    }, 2800);
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

window.initiateAction = initiateAction;
window.copyToClipboard = copyToClipboard;

/* ═══════════════════════════════════════════════════════
   QUERY FORM + HISTORY — injected below contact cards
   Uses Firebase as ES module loaded separately
   ═══════════════════════════════════════════════════════ */

/* ── Toast helper (reuse sp-toast if present) ── */
function sqToast(msg, type = '') {
    const el = document.getElementById('spToast');
    if (!el) return;
    clearTimeout(el._sqTimer);
    el.textContent = msg;
    el.className   = `sp-toast ${type}`;
    el.classList.add('show');
    el._sqTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function sqEsc(s) {
    return String(s || '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function sqFmtDate(raw) {
    if (!raw) return '—';
    try {
        const d = raw.toDate ? raw.toDate() : new Date((raw.seconds||0)*1000);
        return d.toLocaleDateString('en-IN', {
            day:'2-digit', month:'short', year:'numeric',
            hour:'2-digit', minute:'2-digit'
        });
    } catch(_) { return '—'; }
}

/* ── Pre-fill form with cached user data ── */
document.addEventListener('DOMContentLoaded', () => {
    try {
        const raw  = localStorage.getItem('jasa_user_cache');
        const user = raw ? JSON.parse(raw) : null;
        if (user) {
            if (user.fullName && document.getElementById('sqName'))
                document.getElementById('sqName').value = user.fullName;
            if (user.email && document.getElementById('sqEmail'))
                document.getElementById('sqEmail').value = user.email;
            if (user.mobileNumber && document.getElementById('sqPhone'))
                document.getElementById('sqPhone').value = user.mobileNumber;
        }
    } catch(_) {}
});

/* ── Submit query ── */
window.submitQuery = async function() {
    const name    = document.getElementById('sqName')?.value.trim();
    const email   = document.getElementById('sqEmail')?.value.trim();
    const phone   = document.getElementById('sqPhone')?.value.trim();
    const type    = document.getElementById('sqType')?.value;
    const subject = document.getElementById('sqSubject')?.value.trim();
    const message = document.getElementById('sqMessage')?.value.trim();

    if (!name)    { sqToast('Please enter your name.', 'error'); return; }
    if (!email)   { sqToast('Please enter your email.', 'error'); return; }
    if (!type)    { sqToast('Please select a query type.', 'error'); return; }
    if (!subject) { sqToast('Please enter a subject.', 'error'); return; }
    if (!message) { sqToast('Please enter your message.', 'error'); return; }

    const btn = document.getElementById('sqSubmitBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting…';

    try {
        /* Dynamic Firebase import so this plain script doesn't need bundling */
        const { initializeApp, getApps } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js');
        const { getFirestore, collection, addDoc, serverTimestamp, query, where, orderBy, getDocs }
            = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
        const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
        const { FIREBASE_CONFIG } = await import('./env-config.js');

        const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
        const db  = getFirestore(app);
        const auth = getAuth(app);

        const userId = auth.currentUser?.uid || null;

        await addDoc(collection(db, 'support_queries'), {
            name, email,
            phone:   phone || null,
            type,
            subject,
            message,
            status:    'open',
            userId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
        });

        sqToast('Query submitted! We\'ll get back to you soon.', 'success');

        /* Reset form */
        ['sqType','sqSubject','sqMessage'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });

        /* Refresh history */
        loadQueryHistory();

    } catch (e) {
        console.error('[SupportQuery] submit error:', e);
        sqToast('Failed to submit. Please try again.', 'error');
    } finally {
        btn.disabled  = false;
        btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit Query';
    }
};

/* ── Load & render user's own query history ── */
async function loadQueryHistory() {
    const listEl = document.getElementById('sqHistoryList');
    if (!listEl) return;

    try {
        const { initializeApp, getApps } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js');
        const { getFirestore, collection, query, where, orderBy, getDocs }
            = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
        const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
        const { FIREBASE_CONFIG } = await import('./env-config.js');

        const app  = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
        const db   = getFirestore(app);
        const auth = getAuth(app);
        const user = auth.currentUser;

        if (!user) {
            listEl.innerHTML = `
                <div class="sp-empty">
                    <i class="fa-solid fa-user-lock"></i>
                    Sign in to view your past queries
                </div>`;
            return;
        }

        /* sessionStorage 5-min cache */
        const CACHE_KEY = `jasa_sq_history_${user.uid}`;
        try {
            const raw = sessionStorage.getItem(CACHE_KEY);
            if (raw) {
                const { data, ts } = JSON.parse(raw);
                if (Date.now() - ts < 5 * 60 * 1000) { renderQueryHistory(data); return; }
            }
        } catch(_) {}

        listEl.innerHTML = '<div class="sp-empty"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';

        const q    = query(collection(db,'support_queries'),
                           where('userId','==',user.uid),
                           orderBy('createdAt','desc'));
        const snap = await getDocs(q);
        const data = snap.docs.map(d => ({ id:d.id, ...d.data() }));

        try {
            sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
        } catch(_) {}

        renderQueryHistory(data);

    } catch(e) {
        console.error('[SupportQuery] history error:', e);
        const listEl2 = document.getElementById('sqHistoryList');
        if (listEl2) listEl2.innerHTML = `
            <div class="sp-empty">
                <i class="fa-solid fa-circle-exclamation" style="color:#ef4444;opacity:1;"></i>
                Failed to load history.
            </div>`;
    }
}

function renderQueryHistory(items) {
    const listEl = document.getElementById('sqHistoryList');
    if (!listEl) return;

    if (!items.length) {
        listEl.innerHTML = `
            <div class="sp-empty">
                <i class="fa-solid fa-inbox"></i>
                No queries yet. Submit your first one above!
            </div>`;
        return;
    }

    const typeIcon = {
        order:'📦', product:'🛍️', delivery:'🚚',
        payment:'💳', technical:'🔧', feedback:'💬',
        general:'❓', other:'📝'
    };
    const statusMap = {
        open:    { cls:'sq-badge-open',    label:'Open'    },
        replied: { cls:'sq-badge-replied', label:'Replied' },
        closed:  { cls:'sq-badge-closed',  label:'Closed'  },
    };

    listEl.innerHTML = items.map(q => {
        const st = statusMap[q.status] || { cls:'sq-badge-open', label: q.status || 'Open' };
        return `
        <div class="sq-item">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:5px;">
                <div class="sq-subject">
                    ${typeIcon[q.type] || '❓'} ${sqEsc(q.subject)}
                </div>
                <span class="sq-badge ${st.cls}">${st.label}</span>
            </div>
            <div class="sq-meta">
                <span><i class="fa-solid fa-tag"></i>${sqEsc(q.type || 'general')}</span>
                <span><i class="fa-regular fa-calendar"></i>${sqFmtDate(q.createdAt)}</span>
            </div>
            <div class="sq-message">${sqEsc(q.message)}</div>
        </div>`;
    }).join('');
}

/* ── Auto-load history when page is ready ── */
document.addEventListener('DOMContentLoaded', () => {
    /* Small delay to let Firebase auth settle */
    setTimeout(loadQueryHistory, 1200);
});
