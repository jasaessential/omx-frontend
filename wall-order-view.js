/* ═══════════════════════════════════════════════
   JASA V2 — wall-order-view.js
   Build Your Wall / poster pack lines on order pages: every spot in print
   order, with its Wall Posters design or the customer's photo (private file,
   opened through secure-files.js via data-secure-file).
   ═══════════════════════════════════════════════ */
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SIZE_LABEL = { A5: 'A5', A4: 'A4', A3: 'A3', P13: '13×19"' };
const ARRANGEMENT = { grid: 'Grid', zigzag: 'Zigzag', cascade: 'Cascade', gallery: 'Gallery' };

/** HTML for a wall / pack line's spots, or '' for any other line. staff: wording for the shop. */
export function wallSlotsHtml(item, orderId, { staff = false } = {}) {
    const slots = Array.isArray(item?.wallSlots) ? item.wallSlots : [];
    if (!slots.length) return '';
    const photos = slots.filter(s => s.photo).length;
    const oid = String(orderId || '').replace(/[^A-Za-z0-9_-]/g, '');
    const head = item.wallPoster === 'pack'
        ? `${slots.length} × ${SIZE_LABEL[item.packSize] || item.packSize || ''} posters · ${ARRANGEMENT[item.arrangement] || 'Grid'} arrangement`
        : `${slots.length} posters — print and pack in this order`;
    const cells = slots.map((s, i) => {
        const pic = s.img
            ? `<img src="${esc(s.img)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;">`
            : '<i class="fa-regular fa-image" style="font-size:1.1rem;color:#9ca3af;"></i>';
        const label = s.photo ? (staff ? 'Customer photo' : 'Your photo') : esc(s.name || 'Poster');
        const link = s.photo
            ? `<a href="${esc(s.photo)}" data-secure-file data-order-id="${oid}" target="_blank" rel="noopener" style="color:#ec4899;font-weight:800;text-decoration:none;">
                 <i class="fa-solid fa-download"></i> ${staff ? 'Print file' : 'View'}</a>`
            : '';
        return `<div style="min-width:0;font-size:.66rem;font-weight:700;line-height:1.25;">
            <div style="position:relative;aspect-ratio:1/1.414;border-radius:5px;overflow:hidden;background:#f3f4f6;display:flex;align-items:center;justify-content:center;">
                ${pic}<span style="position:absolute;top:2px;left:2px;padding:0 4px;border-radius:3px;background:rgba(255,255,255,.92);color:#0d1117;font-weight:800;">${(s.position ?? i) + 1}</span>
            </div>
            <div style="margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${label}</div>
            <div style="color:#6b7280;">${esc(SIZE_LABEL[s.size] || s.size || '')}</div>${link}
        </div>`;
    }).join('');
    return `<div style="margin:8px 0 2px;padding:8px 10px;border:1.5px dashed #2D8CF0;border-radius:10px;">
        <div style="font-size:.74rem;font-weight:800;margin-bottom:6px;"><i class="fa-solid fa-table-cells-large"></i> ${esc(head)}${photos ? ` · ${photos} ${staff ? 'customer' : 'your'} photo${photos === 1 ? '' : 's'}` : ''}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(62px,1fr));gap:8px;">${cells}</div>
    </div>`;
}
