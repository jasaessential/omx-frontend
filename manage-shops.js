/* ═══════════════════════════════════════════════
   manage-shops.js  —  JASA V2  (Admin only)
   ═══════════════════════════════════════════════ */
import { auth, db } from "./firebase-init.js";
import { WORKER_URL, getAdminToken } from "./env-config.js";
import { createMapPicker, hasCoords } from "./geo-map.js";
import {
  collection,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

/* ─────────── State ─────────── */
let shopsDataMap = new Map();
let usersDataMap = new Map();
let statesMap = new Map();
let districtsMap = new Map();
let citiesMap = new Map();
let editShopId = null;

let ownersChoices,
  employeesChoices,
  statesChoices,
  districtsChoices,
  citiesChoices;

/* ─────────── DOM refs ─────────── */
const shopsGrid = document.getElementById("shopsGrid");
const modalOverlay = document.getElementById("shopModalOverlay");
const stateModalOverlay = document.getElementById("stateModalOverlay");
const districtModalOverlay = document.getElementById("districtModalOverlay");
const cityModalOverlay = document.getElementById("cityModalOverlay");
const shopForm = document.getElementById("shopForm");
const formTitle = document.getElementById("formTitle");
const formSubtitle = document.getElementById("formSubtitle");
const submitBtn = document.getElementById("submitBtn");

/* ─────────── Helpers ─────────── */

/* Bust the Cloudflare Worker KV cache for shops so users see changes immediately */
async function bustShopsCache() {
  try {
    const idToken = await auth.currentUser?.getIdToken();
    const adminKey = idToken ? await getAdminToken(idToken) : null;
    const headers = {
      "Content-Type": "application/json",
      ...(adminKey ? { Authorization: `Bearer ${adminKey}` } : {}),
    };
    await fetch(`${WORKER_URL}/api/cache/clear?type=shops`, {
      method: "DELETE",
      headers,
    });
    console.log("[ManageShops] Worker shops cache cleared ✓");
  } catch (e) {
    console.warn("[ManageShops] Cache bust non-fatal:", e.message);
  }
}

/* Bust the Cloudflare Worker KV cache for locations (states/districts/cities) */
async function bustLocationsCache() {
  try {
    const idToken = await auth.currentUser?.getIdToken();
    const adminKey = idToken ? await getAdminToken(idToken) : null;
    const headers = {
      "Content-Type": "application/json",
      ...(adminKey ? { Authorization: `Bearer ${adminKey}` } : {}),
    };
    await fetch(`${WORKER_URL}/api/cache/clear?type=locations`, {
      method: "DELETE",
      headers,
    });
    console.log("[ManageShops] Worker locations cache cleared ✓");
  } catch (e) {
    console.warn("[ManageShops] Locations cache bust non-fatal:", e.message);
  }
}

function showToast(msg, type = "") {
  const t = document.getElementById("muToast");
  t.textContent = msg;
  t.className = "mu-toast " + type;
  void t.offsetWidth;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2800);
}

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ─────────── Shop map pin ─────────── */
let shopPin = null;
let shopMap = null;

/* Pull coordinates out of a pasted Google/OSM map link (…@12.97,77.59…, ?q=12.97,77.59, ll=, mlat/mlon) */
function parseLatLngFromLink(link) {
  if (!link) return null;
  const pats = [/@(-?\d+\.\d+),(-?\d+\.\d+)/, /[?&](?:q|ll|query)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/, /mlat=(-?\d+\.\d+)&mlon=(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/];
  for (const re of pats) {
    const m = link.match(re);
    if (m) {
      const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
    }
  }
  return null;
}

function updatePinText() {
  const el = document.getElementById("shopPinText");
  if (!el) return;
  el.textContent = shopPin
    ? `Pinned at ${shopPin.lat.toFixed(5)}, ${shopPin.lng.toFixed(5)}`
    : "No pin set — customers will not see distance to this shop.";
}

async function initShopMap(pin) {
  shopPin = pin || null;
  updatePinText();
  const host = document.getElementById("shopMapHost");
  if (!host) return;
  if (shopMap) { try { shopMap.destroy(); } catch (_) {} shopMap = null; }
  const radius = Number(document.getElementById("shopRadiusKm")?.value) || 0;
  shopMap = await createMapPicker(host, {
    value: shopPin,
    withAddress: true,
    radiusKm: radius,
    height: 260,
    onChange: (p, place) => {
      shopPin = p;
      updatePinText();
      const addr = document.getElementById("shopAddress");
      if (place?.address && addr && !addr.value.trim()) addr.value = place.address;
      const link = document.getElementById("shopLocationLink");
      if (link && !link.value.trim()) link.value = `https://www.google.com/maps?q=${p.lat},${p.lng}`;
    },
  });
  setTimeout(() => shopMap?.invalidate(), 150);
}

window.clearShopPin = function () {
  shopPin = null;
  updatePinText();
  shopMap?.setValue(null);
};

document.addEventListener("input", (e) => {
  if (e.target?.id === "shopRadiusKm") shopMap?.setRadius(Number(e.target.value) || 0);
});

/* ─────────── Modal Management ─────────── */
// Registered on window immediately so inline onclick handlers always resolve,
// regardless of async initialisation order.

window.toggleDeliveryTime = function (cb) {
  const wrap = document.getElementById("deliveryTimeWrap");
  if (wrap) wrap.style.display = cb.checked ? "" : "none";
};

window.openShopModal = function () {
  resetForm();
  if (modalOverlay) modalOverlay.classList.add("active");
  document.body.style.overflow = "hidden";
  initShopMap(null);
};

window.closeShopModal = function () {
  if (modalOverlay) modalOverlay.classList.remove("active");
  document.body.style.overflow = "";
};

window.handleModalClick = function (e) {
  if (e.target === modalOverlay) window.closeShopModal();
};

window.openStateModal = function () {
  if (stateModalOverlay) {
    stateModalOverlay.classList.add("active");
    document.body.style.overflow = "hidden";
  }
};

window.closeStateModal = function () {
  if (stateModalOverlay) stateModalOverlay.classList.remove("active");
  document.body.style.overflow = "";
};

window.handleStateModalClick = function (e) {
  if (e.target === stateModalOverlay) window.closeStateModal();
};

window.openDistrictModal = function () {
  if (districtModalOverlay) {
    districtModalOverlay.classList.add("active");
    document.body.style.overflow = "hidden";
    renderDistrictStateSelect();
  }
};

window.closeDistrictModal = function () {
  if (districtModalOverlay) districtModalOverlay.classList.remove("active");
  document.body.style.overflow = "";
};

window.handleDistrictModalClick = function (e) {
  if (e.target === districtModalOverlay) window.closeDistrictModal();
};

window.openCityModal = function () {
  if (cityModalOverlay) {
    cityModalOverlay.classList.add("active");
    document.body.style.overflow = "hidden";
    renderCityStateSelect();
    updateCityDistrictDropdown();
  }
};

window.closeCityModal = function () {
  if (cityModalOverlay) cityModalOverlay.classList.remove("active");
  document.body.style.overflow = "";
};

window.handleCityModalClick = function (e) {
  if (e.target === cityModalOverlay) window.closeCityModal();
};

/* ─────────── Dynamic Input Helpers ─────────── */
function createRemovableEntry(
  placeholder,
  pattern,
  maxlength,
  isRequired,
  clsPrefix,
) {
  const entry = document.createElement("div");
  entry.className = `ms-entry ${clsPrefix}-entry`;
  const reqAttr = isRequired ? "required" : "";
  const patAttr = pattern ? `pattern="${pattern}"` : "";
  const maxAttr = maxlength ? `maxlength="${maxlength}"` : "";

  entry.innerHTML = `
        <input type="${clsPrefix === "area" ? "text" : "tel"}"
               class="ms-input ${clsPrefix}-input"
               placeholder="${placeholder}"
               ${patAttr} ${maxAttr} ${reqAttr}>
        <button type="button" class="ms-btn-rm">
            <i class="fa-solid fa-trash-can"></i>
        </button>
    `;
  entry
    .querySelector(".ms-btn-rm")
    .addEventListener("click", () => entry.remove());
  return entry;
}

document.getElementById("addMobileBtn").addEventListener("click", () => {
  document
    .getElementById("mobilesContainer")
    .appendChild(
      createRemovableEntry("10-digit number", "[0-9]{10}", 10, true, "mobile"),
    );
});

document.getElementById("addWaBtn").addEventListener("click", () => {
  document
    .getElementById("waContainer")
    .appendChild(
      createRemovableEntry(
        "10-digit WhatsApp number",
        "[0-9]{10}",
        10,
        false,
        "wa",
      ),
    );
});

document.getElementById("addAreaBtn").addEventListener("click", () => {
  document
    .getElementById("areasContainer")
    .appendChild(
      createRemovableEntry("e.g., North District", null, null, false, "area"),
    );
});

// Wire up the hardcoded remove buttons that exist in the HTML
document
  .querySelectorAll(".remove-mobile-btn")
  .forEach((btn) =>
    btn.addEventListener("click", (e) =>
      e.target.closest(".mobile-entry").remove(),
    ),
  );
document
  .querySelectorAll(".remove-wa-btn")
  .forEach((btn) =>
    btn.addEventListener("click", (e) =>
      e.target.closest(".wa-entry").remove(),
    ),
  );
document
  .querySelectorAll(".remove-area-btn")
  .forEach((btn) =>
    btn.addEventListener("click", (e) =>
      e.target.closest(".area-entry").remove(),
    ),
  );

/* ─────────── Pricing Rules ─────────── */
window.addPricingRule = function (containerId, min = "", max = "", fee = "") {
  const container = document.getElementById(containerId);
  const entry = document.createElement("div");
  entry.className = "ms-rule-entry pricing-rule-entry";
  entry.innerHTML = `
        <input type="number" class="ms-input rule-min"  placeholder="Min Rs."        value="${min !== null ? min : ""}" required min="0" style="width:80px;">
        <span class="ms-rule-sep">to</span>
        <input type="number" class="ms-input rule-max"  placeholder="Max (Blank=∞)"  value="${max !== null ? max : ""}" min="0" style="width:100px;">
        <span class="ms-rule-sep">=</span>
        <input type="number" class="ms-input rule-fee"  placeholder="Fee Rs."        value="${fee !== null ? fee : ""}" required min="0" style="width:80px;">
        <button type="button" class="ms-btn-rm"><i class="fa-solid fa-trash-can"></i></button>
    `;
  entry
    .querySelector(".ms-btn-rm")
    .addEventListener("click", () => entry.remove());
  container.appendChild(entry);
};

/* ─────────── Data Fetching ─────────── */
async function initDropdowns() {
  try {
    const snap = await getDocs(collection(db, "users"));
    const sellers = [];
    const employees = [];

    snap.forEach((d) => {
      const data = d.data();
      const roles = data.roles || [data.role || "user"];
      const displayName =
        data.fullName || data.name || data.email || "Unknown User";

      usersDataMap.set(d.id, displayName);

      if (roles.includes("seller"))
        sellers.push({ value: d.id, label: displayName });
      if (roles.includes("employee"))
        employees.push({ value: d.id, label: displayName });
    });

    ownersChoices = new Choices(document.getElementById("shopOwners"), {
      removeItemButton: true,
      placeholderValue: "Select sellers",
      searchPlaceholderValue: "Search sellers...",
      choices: sellers,
    });

    employeesChoices = new Choices(document.getElementById("shopEmployees"), {
      removeItemButton: true,
      placeholderValue: "Select employees",
      searchPlaceholderValue: "Search employees...",
      choices: employees,
    });

    await fetchLocations();
    await fetchShops();
  } catch (err) {
    console.error("Error fetching users:", err);
    showToast("Failed to load users for dropdowns.", "error");
  }
}

/* ─────────── Locations ─────────── */
async function fetchLocations() {
  try {
    const [statesSnap, districtsSnap, citiesSnap] = await Promise.all([
      getDocs(collection(db, "states")),
      getDocs(collection(db, "districts")),
      getDocs(collection(db, "cities")),
    ]);

    const statesData = [];
    statesSnap.forEach((d) => statesData.push({ id: d.id, ...d.data() }));
    statesData.sort((a, b) => (a.order || 0) - (b.order || 0));
    statesMap.clear();
    statesData.forEach((d) => statesMap.set(d.id, d));

    const districtsData = [];
    districtsSnap.forEach((d) => districtsData.push({ id: d.id, ...d.data() }));
    districtsData.sort((a, b) => (a.order || 0) - (b.order || 0));
    districtsMap.clear();
    districtsData.forEach((d) => districtsMap.set(d.id, d));

    const citiesData = [];
    citiesSnap.forEach((d) => citiesData.push({ id: d.id, ...d.data() }));
    citiesData.sort((a, b) => (a.order || 0) - (b.order || 0));
    citiesMap.clear();
    citiesData.forEach((d) => citiesMap.set(d.id, d));

    renderStatesList();
    renderDistrictsList();
    renderCitiesList();
    updateLocationChoices();
  } catch (err) {
    console.error("Error fetching locations:", err);
    showToast("Failed to load locations.", "error");
  }
}

function renderStatesList() {
  const list = document.getElementById("statesList");
  list.innerHTML = "";
  if (statesMap.size === 0) {
    list.innerHTML =
      '<div style="color:var(--txt3); font-size:.8rem;">No states added yet.</div>';
    return;
  }
  const arr = Array.from(statesMap.entries());
  arr.forEach(([id, data], i) => {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex; justify-content:space-between; align-items:center; background:var(--bg); padding:8px 12px; border-radius:var(--r-sm); border:1px solid var(--border);";
    row.innerHTML = `
            <div style="font-weight:600; font-size:.85rem; color:var(--txt1);">${escHtml(data.name)}</div>
            <div style="display:flex; gap:4px;">
                <button type="button" class="ms-btn-rm" style="background:#e0f2fe; color:#0284c7;" onclick="moveState('${id}', -1)" ${i === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-up"></i></button>
                <button type="button" class="ms-btn-rm" style="background:#e0f2fe; color:#0284c7;" onclick="moveState('${id}', 1)"  ${i === arr.length - 1 ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i></button>
                <button type="button" class="ms-btn-rm" style="background:#fef3c7; color:#d97706;" onclick="editState('${id}')"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="ms-btn-rm" onclick="deleteState('${id}')"><i class="fa-solid fa-trash-can"></i></button>
            </div>
        `;
    list.appendChild(row);
  });
}

function renderDistrictStateSelect() {
  const select = document.getElementById("districtStateSelect");
  select.innerHTML = '<option value="">Choose a state...</option>';
  statesMap.forEach((data, id) => {
    select.innerHTML += `<option value="${id}">${escHtml(data.name)}</option>`;
  });
}

window.renderDistrictsList = function () {
  const stateId = document.getElementById("districtStateSelect")?.value;
  const list = document.getElementById("districtsList");
  if (!list) return;
  list.innerHTML = "";

  const arr = Array.from(districtsMap.entries()).filter(
    ([, d]) => !stateId || d.stateId === stateId,
  );

  if (arr.length === 0) {
    list.innerHTML =
      '<div style="color:var(--txt3); font-size:.8rem;">No districts found for selected state.</div>';
    return;
  }

  arr.forEach(([id, data], i) => {
    const stateName = statesMap.get(data.stateId)?.name || "Unknown State";
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex; justify-content:space-between; align-items:center; background:var(--bg); padding:8px 12px; border-radius:var(--r-sm); border:1px solid var(--border);";
    row.innerHTML = `
            <div>
                <div style="font-weight:600; font-size:.85rem; color:var(--txt1);">${escHtml(data.name)}</div>
                <div style="font-size:.7rem; color:var(--txt3);">${escHtml(stateName)}</div>
            </div>
            <div style="display:flex; gap:4px;">
                <button type="button" class="ms-btn-rm" style="background:#e0f2fe; color:#0284c7;" onclick="moveDistrict('${id}', -1)" ${i === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-up"></i></button>
                <button type="button" class="ms-btn-rm" style="background:#e0f2fe; color:#0284c7;" onclick="moveDistrict('${id}', 1)"  ${i === arr.length - 1 ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i></button>
                <button type="button" class="ms-btn-rm" style="background:#fef3c7; color:#d97706;" onclick="editDistrict('${id}')"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="ms-btn-rm" onclick="deleteDistrict('${id}')"><i class="fa-solid fa-trash-can"></i></button>
            </div>
        `;
    list.appendChild(row);
  });
};

function renderCityStateSelect() {
  const select = document.getElementById("cityStateSelect");
  if (!select) return;
  select.innerHTML = '<option value="">Choose a state...</option>';
  statesMap.forEach((data, id) => {
    select.innerHTML += `<option value="${id}">${escHtml(data.name)}</option>`;
  });
}

window.updateCityDistrictDropdown = function () {
  const stateId = document.getElementById("cityStateSelect")?.value;
  const districtSelect = document.getElementById("cityDistrictSelect");
  if (!districtSelect) return;

  districtSelect.innerHTML = '<option value="">Choose a district...</option>';

  if (!stateId) {
    renderCitiesList();
    return;
  }

  // Filter districts by selected state
  districtsMap.forEach((data, id) => {
    if (data.stateId === stateId) {
      districtSelect.innerHTML += `<option value="${id}">${escHtml(data.name)}</option>`;
    }
  });

  renderCitiesList();
};

window.renderCitiesList = function () {
  const stateId = document.getElementById("cityStateSelect")?.value;
  const districtId = document.getElementById("cityDistrictSelect")?.value;
  const list = document.getElementById("citiesList");
  if (!list) return;
  list.innerHTML = "";

  let arr = Array.from(citiesMap.entries());

  // Filter by state and district
  if (stateId && districtId) {
    arr = arr.filter(([, d]) => d.districtId === districtId);
  } else if (stateId) {
    // Show all cities in districts of selected state
    arr = arr.filter(([, d]) => {
      const district = districtsMap.get(d.districtId);
      return district && district.stateId === stateId;
    });
  } else if (districtId) {
    arr = arr.filter(([, d]) => d.districtId === districtId);
  }

  if (arr.length === 0) {
    list.innerHTML =
      '<div style="color:var(--txt3); font-size:.8rem;">No cities found.</div>';
    return;
  }

  arr.forEach(([id, data], i) => {
    const district = districtsMap.get(data.districtId);
    const districtName = district?.name || "Unknown District";
    const stateName = statesMap.get(district?.stateId)?.name || "";
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex; justify-content:space-between; align-items:center; background:var(--bg); padding:8px 12px; border-radius:var(--r-sm); border:1px solid var(--border);";
    row.innerHTML = `
            <div>
                <div style="font-weight:600; font-size:.85rem; color:var(--txt1);">${escHtml(data.name)}</div>
                <div style="font-size:.7rem; color:var(--txt3);">${escHtml(districtName)}${stateName ? ", " + escHtml(stateName) : ""}</div>
            </div>
            <div style="display:flex; gap:4px;">
                <button type="button" class="ms-btn-rm" style="background:#e0f2fe; color:#0284c7;" onclick="moveCity('${id}', -1)" ${i === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-up"></i></button>
                <button type="button" class="ms-btn-rm" style="background:#e0f2fe; color:#0284c7;" onclick="moveCity('${id}', 1)"  ${i === arr.length - 1 ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i></button>
                <button type="button" class="ms-btn-rm" style="background:#fef3c7; color:#d97706;" onclick="editCity('${id}')"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="ms-btn-rm" onclick="deleteCity('${id}')"><i class="fa-solid fa-trash-can"></i></button>
            </div>
        `;
    list.appendChild(row);
  });
};

/* ── State CRUD ── */
window.handleStateSubmit = async function (e) {
  e.preventDefault();
  const nameInput = document.getElementById("newStateName");
  const name = nameInput.value.trim();
  if (!name) return;

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = "...";
  try {
    await addDoc(collection(db, "states"), {
      name,
      order: statesMap.size,
      createdAt: new Date(),
    });
    showToast("State added successfully.", "success");
    nameInput.value = "";
    bustLocationsCache();
    await fetchLocations();
  } catch (err) {
    console.error("Error adding state:", err);
    showToast("Failed to add state.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Add";
  }
};

window.editState = async function (id) {
  const state = statesMap.get(id);
  if (!state) return;
  const newName = prompt("Enter new name for state:", state.name);
  if (!newName || newName.trim() === "" || newName.trim() === state.name)
    return;
  try {
    await updateDoc(doc(db, "states", id), { name: newName.trim() });
    showToast("State updated.", "success");
    bustLocationsCache();
    await fetchLocations();
  } catch (err) {
    console.error(err);
    showToast("Failed to update state.", "error");
  }
};

window.moveState = async function (id, direction) {
  const arr = Array.from(statesMap.entries());
  const idx = arr.findIndex(([sid]) => sid === id);
  if (idx < 0) return;
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= arr.length) return;

  const [curId, curData] = arr[idx];
  const [tgtId, tgtData] = arr[targetIdx];
  const curOrder = curData.order ?? idx;
  const tgtOrder = tgtData.order ?? targetIdx;

  try {
    await Promise.all([
      updateDoc(doc(db, "states", curId), { order: tgtOrder }),
      updateDoc(doc(db, "states", tgtId), { order: curOrder }),
    ]);
    bustLocationsCache();
    await fetchLocations();
  } catch (err) {
    console.error(err);
    showToast("Failed to reorder.", "error");
  }
};

window.deleteState = async function (id) {
  if (
    !confirm(
      "Are you sure? This state and related shop bindings may be affected.",
    )
  )
    return;
  try {
    await deleteDoc(doc(db, "states", id));
    showToast("State deleted.", "success");
    bustLocationsCache();
    await fetchLocations();
  } catch (err) {
    console.error("Error deleting state:", err);
    showToast("Failed to delete state.", "error");
  }
};

/* ── District CRUD ── */
window.handleDistrictSubmit = async function (e) {
  e.preventDefault();
  const stateId = document.getElementById("districtStateSelect").value;
  const nameInput = document.getElementById("newDistrictName");
  const name = nameInput.value.trim();

  if (!stateId) {
    showToast("Please select a state first.", "error");
    return;
  }
  if (!name) return;

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = "...";
  try {
    const order = Array.from(districtsMap.values()).filter(
      (d) => d.stateId === stateId,
    ).length;
    await addDoc(collection(db, "districts"), {
      name,
      stateId,
      order,
      createdAt: new Date(),
    });
    showToast("District added successfully.", "success");
    nameInput.value = "";
    bustLocationsCache();
    await fetchLocations();
  } catch (err) {
    console.error("Error adding district:", err);
    showToast("Failed to add district.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Add";
  }
};

window.editDistrict = async function (id) {
  const district = districtsMap.get(id);
  if (!district) return;
  const newName = prompt("Enter new name for district:", district.name);
  if (!newName || newName.trim() === "" || newName.trim() === district.name)
    return;
  try {
    await updateDoc(doc(db, "districts", id), { name: newName.trim() });
    showToast("District updated.", "success");
    bustLocationsCache();
    await fetchLocations();
  } catch (err) {
    console.error(err);
    showToast("Failed to update district.", "error");
  }
};

window.moveDistrict = async function (id, direction) {
  const stateId = document.getElementById("districtStateSelect")?.value;
  const arr = Array.from(districtsMap.entries()).filter(
    ([, d]) => !stateId || d.stateId === stateId,
  );

  const idx = arr.findIndex(([did]) => did === id);
  if (idx < 0) return;
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= arr.length) return;

  const [curId, curData] = arr[idx];
  const [tgtId, tgtData] = arr[targetIdx];
  const curOrder = curData.order ?? idx;
  const tgtOrder = tgtData.order ?? targetIdx;

  try {
    await Promise.all([
      updateDoc(doc(db, "districts", curId), { order: tgtOrder }),
      updateDoc(doc(db, "districts", tgtId), { order: curOrder }),
    ]);
    bustLocationsCache();
    await fetchLocations();
  } catch (err) {
    console.error(err);
    showToast("Failed to reorder.", "error");
  }
};

window.deleteDistrict = async function (id) {
  if (!confirm("Are you sure? Cities under this district may be affected."))
    return;
  try {
    await deleteDoc(doc(db, "districts", id));
    showToast("District deleted.", "success");
    bustLocationsCache();
    await fetchLocations();
  } catch (err) {
    console.error("Error deleting district:", err);
    showToast("Failed to delete district.", "error");
  }
};

/* ── City CRUD ── */
window.handleCitySubmit = async function (e) {
  e.preventDefault();
  const districtId = document.getElementById("cityDistrictSelect").value;
  const nameInput = document.getElementById("newCityName");
  const name = nameInput.value.trim();

  if (!districtId) {
    showToast("Please select a district first.", "error");
    return;
  }
  if (!name) return;

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = "...";
  try {
    const order = Array.from(citiesMap.values()).filter(
      (c) => c.districtId === districtId,
    ).length;
    await addDoc(collection(db, "cities"), {
      name,
      districtId,
      order,
      createdAt: new Date(),
    });
    showToast("City added successfully.", "success");
    nameInput.value = "";
    bustLocationsCache();
    await fetchLocations();
  } catch (err) {
    console.error("Error adding city:", err);
    showToast("Failed to add city.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Add";
  }
};

window.editCity = async function (id) {
  const city = citiesMap.get(id);
  if (!city) return;
  const newName = prompt("Enter new name for city:", city.name);
  if (!newName || newName.trim() === "" || newName.trim() === city.name) return;
  try {
    await updateDoc(doc(db, "cities", id), { name: newName.trim() });
    showToast("City updated.", "success");
    bustLocationsCache();
    await fetchLocations();
  } catch (err) {
    console.error(err);
    showToast("Failed to update city.", "error");
  }
};

window.moveCity = async function (id, direction) {
  const stateId = document.getElementById("cityStateSelect")?.value;
  const districtId = document.getElementById("cityDistrictSelect")?.value;

  let arr = Array.from(citiesMap.entries());

  // Filter by state and district (same as renderCitiesList)
  if (stateId && districtId) {
    arr = arr.filter(([, d]) => d.districtId === districtId);
  } else if (stateId) {
    arr = arr.filter(([, d]) => {
      const district = districtsMap.get(d.districtId);
      return district && district.stateId === stateId;
    });
  } else if (districtId) {
    arr = arr.filter(([, d]) => d.districtId === districtId);
  }

  const idx = arr.findIndex(([cid]) => cid === id);
  if (idx < 0) return;
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= arr.length) return;

  const [curId, curData] = arr[idx];
  const [tgtId, tgtData] = arr[targetIdx];
  const curOrder = curData.order ?? idx;
  const tgtOrder = tgtData.order ?? targetIdx;

  try {
    await Promise.all([
      updateDoc(doc(db, "cities", curId), { order: tgtOrder }),
      updateDoc(doc(db, "cities", tgtId), { order: curOrder }),
    ]);
    bustLocationsCache();
    await fetchLocations();
  } catch (err) {
    console.error(err);
    showToast("Failed to reorder.", "error");
  }
};

window.deleteCity = async function (id) {
  if (!confirm("Are you sure?")) return;
  try {
    await deleteDoc(doc(db, "cities", id));
    showToast("City deleted.", "success");
    bustLocationsCache();
    await fetchLocations();
  } catch (err) {
    console.error("Error deleting city:", err);
    showToast("Failed to delete city.", "error");
  }
};

/* ─────────── Location Choices ─────────── */
/* "Others" pseudo-locations a shop can be assigned to. Customers who pick
   "Others" in the xerox location picker see the shops tagged here.
     state    → "__others__"
     district → "__others__:<stateId>"     (Others inside that state)
     city     → "__others__:<districtId>"  (Others inside that district) */
const OTHERS_KEY = "__others__";
const othersKeyFor = (parentId) => `${OTHERS_KEY}:${parentId}`;
const othersParentId = (val) =>
  typeof val === "string" && val.startsWith(OTHERS_KEY + ":")
    ? val.slice(OTHERS_KEY.length + 1)
    : null;

function stateLabel(id) {
  if (id === OTHERS_KEY) return "Others";
  return statesMap.get(id)?.name || "Unknown";
}
function districtLabel(id) {
  const parent = othersParentId(id);
  if (parent !== null) return `Others (${stateLabel(parent)})`;
  return districtsMap.get(id)?.name || "Unknown";
}
function cityLabel(id) {
  const parent = othersParentId(id);
  if (parent !== null) return `Others (${districtLabel(parent)})`;
  return citiesMap.get(id)?.name || "Unknown";
}

function updateLocationChoices() {
  const statesData = [];
  statesMap.forEach((data, id) =>
    statesData.push({ value: id, label: data.name }),
  );
  statesData.push({ value: OTHERS_KEY, label: "Others" });

  const statesSelect = document.getElementById("shopStates");
  if (statesChoices) statesChoices.destroy();
  statesSelect.innerHTML = "";

  statesChoices = new Choices(statesSelect, {
    removeItemButton: true,
    placeholderValue: "Select states",
    searchPlaceholderValue: "Search states...",
    choices: statesData,
  });

  statesSelect.addEventListener("change", () => {
    updateDistrictChoices();
    updateCityChoices();
  });

  updateDistrictChoices();
  updateCityChoices();
}

function updateDistrictChoices() {
  const selectedStates = statesChoices ? statesChoices.getValue(true) : [];
  const districtsData = [];

  districtsMap.forEach((data, id) => {
    if (selectedStates.length === 0 || selectedStates.includes(data.stateId)) {
      const stateName = statesMap.get(data.stateId)?.name || "Unknown";
      districtsData.push({ value: id, label: `${data.name} (${stateName})` });
    }
  });
  // One "Others" district per real selected state (or all states if none selected)
  statesMap.forEach((data, id) => {
    if (selectedStates.length === 0 || selectedStates.includes(id)) {
      districtsData.push({ value: othersKeyFor(id), label: `Others (${data.name})` });
    }
  });
  districtsData.sort((a, b) => a.label.localeCompare(b.label));

  const districtsSelect = document.getElementById("shopDistricts");

  if (districtsChoices) {
    const currentVals = districtsChoices.getValue(true);
    districtsChoices.destroy();
    districtsSelect.innerHTML = "";
    districtsChoices = new Choices(districtsSelect, {
      removeItemButton: true,
      placeholderValue: "Select districts",
      searchPlaceholderValue: "Search districts...",
      choices: districtsData,
    });
    const validVals = currentVals.filter((v) =>
      districtsData.find((dd) => dd.value === v),
    );
    if (validVals.length) districtsChoices.setChoiceByValue(validVals);
  } else {
    districtsSelect.innerHTML = "";
    districtsChoices = new Choices(districtsSelect, {
      removeItemButton: true,
      placeholderValue: "Select districts",
      searchPlaceholderValue: "Search districts...",
      choices: districtsData,
    });
  }

  districtsSelect.addEventListener("change", () => updateCityChoices());
}

function updateCityChoices() {
  const selectedStates = statesChoices ? statesChoices.getValue(true) : [];
  const selectedDistricts = districtsChoices
    ? districtsChoices.getValue(true)
    : [];
  const citiesData = [];

  citiesMap.forEach((data, id) => {
    const district = districtsMap.get(data.districtId);
    if (district) {
      // Filter by selected districts if any, otherwise by selected states
      const matchesDistrict =
        selectedDistricts.length === 0 ||
        selectedDistricts.includes(data.districtId);
      const matchesState =
        selectedStates.length === 0 ||
        selectedStates.includes(district.stateId);

      if (matchesDistrict && matchesState) {
        const stateName = statesMap.get(district.stateId)?.name || "";
        citiesData.push({
          value: id,
          label: `${data.name} (${district.name}, ${stateName})`,
        });
      }
    }
  });
  // One "Others" city per real selected district (or per district in the selected states)
  districtsMap.forEach((data, id) => {
    const matchesDistrict =
      selectedDistricts.length === 0 || selectedDistricts.includes(id);
    const matchesState =
      selectedStates.length === 0 || selectedStates.includes(data.stateId);
    if (matchesDistrict && matchesState) {
      const stateName = statesMap.get(data.stateId)?.name || "";
      citiesData.push({
        value: othersKeyFor(id),
        label: `Others (${data.name}, ${stateName})`,
      });
    }
  });
  citiesData.sort((a, b) => a.label.localeCompare(b.label));

  const citiesSelect = document.getElementById("shopCities");

  if (citiesChoices) {
    const currentVals = citiesChoices.getValue(true);
    citiesChoices.destroy();
    citiesSelect.innerHTML = "";
    citiesChoices = new Choices(citiesSelect, {
      removeItemButton: true,
      placeholderValue: "Select cities",
      searchPlaceholderValue: "Search cities...",
      choices: citiesData,
    });
    const validVals = currentVals.filter((v) =>
      citiesData.find((cd) => cd.value === v),
    );
    if (validVals.length) citiesChoices.setChoiceByValue(validVals);
  } else {
    citiesSelect.innerHTML = "";
    citiesChoices = new Choices(citiesSelect, {
      removeItemButton: true,
      placeholderValue: "Select cities",
      searchPlaceholderValue: "Search cities...",
      choices: citiesData,
    });
  }
}

/* ─────────── Shops Grid ─────────── */
function formatRules(rulesArr) {
  if (!rulesArr || rulesArr.length === 0)
    return '<div class="ms-rule-line" style="color:var(--txt3);">Not Set</div>';
  return rulesArr
    .map((r) => {
      const maxStr = r.max === null ? "∞" : `Rs. ${r.max}`;
      const feeStr =
        r.fee === 0 ? '<span class="ms-rule-free">Free</span>' : `Rs. ${r.fee}`;
      return `<div class="ms-rule-line">Rs. ${r.min} <i>to</i> ${maxStr} = ${feeStr}</div>`;
    })
    .join("");
}

async function fetchShops() {
  shopsGrid.innerHTML = `
        <div class="ms-skeleton"></div>
        <div class="ms-skeleton"></div>
        <div class="ms-skeleton"></div>
    `;
  try {
    const snap = await getDocs(collection(db, "shops"));
    shopsGrid.innerHTML = "";
    shopsDataMap.clear();

    if (snap.empty) {
      shopsGrid.innerHTML = `
                <div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--txt3);">
                    <i class="fa-solid fa-store-slash fa-2x" style="margin-bottom:8px; display:block;"></i>
                    No shops found.
                </div>`;
      return;
    }

    snap.forEach((d) => {
      const data = d.data();
      shopsDataMap.set(d.id, data);

      const xeroxRulesHTML = formatRules(data.deliveryPrices?.xerox);
      const stdRulesHTML = formatRules(data.deliveryPrices?.others);

      const ownersList =
        (data.owners || [])
          .map((id) => usersDataMap.get(id) || "Unknown")
          .join(", ") || "None";
      const staffList =
        (data.employees || [])
          .map((id) => usersDataMap.get(id) || "Unknown")
          .join(", ") || "None";
      const statesListHTML =
        (data.states || [])
          .map(stateLabel)
          .join(", ") || "None";
      const districtsListHTML =
        (data.districts || [])
          .map(districtLabel)
          .join(", ") || "None";
      const citiesListHTML =
        (data.cities || [])
          .map(cityLabel)
          .join(", ") || "None";
      const svcs = (data.services || [])
        .map((s) => `<span class="ms-service-chip">${escHtml(s)}</span>`)
        .join("");
      const waHTML =
        data.whatsappNumbers && data.whatsappNumbers.length > 0
          ? `<span><i class="fa-brands fa-whatsapp wa-icon"></i> ${escHtml(data.whatsappNumbers.join(", "))}</span>`
          : "";

      const card = document.createElement("div");
      card.className = "ms-card";
      card.innerHTML = `
                <div class="ms-card-head">
                    <div>
                        <div class="ms-card-title">${escHtml(data.name)} <span style="font-size:.65rem; font-weight:800; padding:2px 8px; border-radius:50px; background:${data.shopType === "college" ? "#dcfce7" : "var(--primary-faint)"}; color:${data.shopType === "college" ? "#16a34a" : "var(--primary)"}; text-transform:uppercase; letter-spacing:.4px; vertical-align:middle;"><i class="fa-solid fa-${data.shopType === "college" ? "building-columns" : "store"}"></i> ${data.shopType === "college" ? "College" : "Shop"}</span></div>
                        <div class="ms-card-address"><i class="fa-solid fa-location-dot"></i> ${escHtml(data.address)}</div>
                        ${data.locationLink ? `<div class="ms-card-address" style="margin-top:4px;"><a href="${escHtml(data.locationLink)}" target="_blank" style="color:var(--primary); font-weight:600;"><i class="fa-solid fa-map-location-dot"></i> View on Map</a></div>` : ""}
                        <div class="ms-card-contact">
                            <span><i class="fa-solid fa-phone"></i> ${escHtml((data.mobileNumbers || []).join(", ") || "N/A")}</span>
                            ${waHTML}
                        </div>
                        ${data.homeDelivery ? `<div style="margin-top:5px;"><span style="display:inline-flex;align-items:center;gap:4px;background:#dcfce7;color:#16a34a;font-size:.65rem;font-weight:800;padding:2px 8px;border-radius:50px;"><i class="fa-solid fa-truck-fast"></i> Home Delivery${data.deliveryTime ? " · " + escHtml(data.deliveryTime) : ""}</span></div>` : ""}
                    </div>
                </div>

                <div class="ms-services">
                    ${svcs || '<span class="ms-service-chip" style="color:var(--txt3); border:none;">No services</span>'}
                </div>

                <div class="ms-rules-wrap">
                    <div class="ms-rules-col">
                        <div class="ms-rules-col-title">Xerox Delivery</div>
                        ${xeroxRulesHTML}
                    </div>
                    <div class="ms-rules-col">
                        <div class="ms-rules-col-title">Standard Delivery</div>
                        ${stdRulesHTML}
                    </div>
                </div>

                <div class="ms-card-users">
                    <div style="margin-bottom:4px;"><strong>States:</strong> ${escHtml(statesListHTML)}</div>
                    <div style="margin-bottom:4px;"><strong>Districts:</strong> ${escHtml(districtsListHTML)}</div>
                    <div style="margin-bottom:4px;"><strong>Cities:</strong> ${escHtml(citiesListHTML)}</div>
                    <div style="margin-bottom:4px;"><strong>Owners:</strong> ${escHtml(ownersList)}</div>
                    <div><strong>Staff:</strong> ${escHtml(staffList)}</div>
                </div>

                <div class="ms-card-actions">
                    <button class="ms-btn-edit" onclick="editShop('${d.id}')"><i class="fa-solid fa-pen"></i> Edit</button>
                    <button class="ms-btn-del"  onclick="deleteShop('${d.id}')"><i class="fa-solid fa-trash-can"></i> Delete</button>
                </div>
            `;
      shopsGrid.appendChild(card);
    });
  } catch (err) {
    console.error("Error fetching shops:", err);
    shopsGrid.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--danger); padding:20px;">Failed to load shops.</div>`;
  }
}

/* ─────────── Edit / Delete / Reset ─────────── */
function resetForm() {
  shopForm.reset();
  editShopId = null;
  formTitle.textContent = "Create Shop";
  formSubtitle.textContent = "Add a new shop to the system.";
  submitBtn.textContent = "Create Shop";

  // Reset shop type to default
  const defaultType = document.getElementById("shopTypeShop");
  if (defaultType) defaultType.checked = true;

  // Reset home delivery
  const hdEl = document.getElementById("shopHomeDelivery");
  if (hdEl) hdEl.checked = false;
  const dtWrap = document.getElementById("deliveryTimeWrap");
  if (dtWrap) dtWrap.style.display = "none";
  const dtEl = document.getElementById("shopDeliveryTime");
  if (dtEl) dtEl.value = "Within 24 hours";

  const radEl = document.getElementById("shopRadiusKm");
  if (radEl) radEl.value = 10;

  if (ownersChoices) ownersChoices.removeActiveItems();
  if (employeesChoices) employeesChoices.removeActiveItems();
  if (statesChoices) statesChoices.removeActiveItems();
  if (districtsChoices) districtsChoices.removeActiveItems();
  if (citiesChoices) citiesChoices.removeActiveItems();

  const resetDynamic = (id, makeFn) => {
    const c = document.getElementById(id);
    c.innerHTML = "";
    c.appendChild(makeFn());
  };
  resetDynamic("mobilesContainer", () =>
    createRemovableEntry("10-digit number", "[0-9]{10}", 10, true, "mobile"),
  );
  resetDynamic("waContainer", () =>
    createRemovableEntry(
      "10-digit WhatsApp number",
      "[0-9]{10}",
      10,
      false,
      "wa",
    ),
  );
  resetDynamic("areasContainer", () =>
    createRemovableEntry("e.g., North District", null, null, false, "area"),
  );

  document.getElementById("xeroxRulesContainer").innerHTML = "";
  window.addPricingRule("xeroxRulesContainer");
  document.getElementById("stdRulesContainer").innerHTML = "";
  window.addPricingRule("stdRulesContainer");
}

window.editShop = function (id) {
  const data = shopsDataMap.get(id);
  if (!data) return;

  resetForm();
  modalOverlay.classList.add("active");
  document.body.style.overflow = "hidden";

  document.getElementById("shopName").value = data.name || "";
  document.getElementById("shopAddress").value = data.address || "";
  document.getElementById("shopLocationLink").value = data.locationLink || "";
  document.getElementById("shopNotes").value = data.notes || "";
  document.getElementById("shopRadiusKm").value = data.serviceRadiusKm || 10;
  /* Saved pin, else try to read one from the pasted map link */
  initShopMap(hasCoords(data) ? { lat: Number(data.lat), lng: Number(data.lng) } : parseLatLngFromLink(data.locationLink));

  // Shop type radio
  const typeVal = data.shopType === "college" ? "college" : "shop";
  const typeRadio = document.querySelector(
    `input[name="shopType"][value="${typeVal}"]`,
  );
  if (typeRadio) typeRadio.checked = true;

  // Home delivery
  const hdEl = document.getElementById("shopHomeDelivery");
  if (hdEl) hdEl.checked = data.homeDelivery === true;
  const dtWrap = document.getElementById("deliveryTimeWrap");
  const dtEl = document.getElementById("shopDeliveryTime");
  if (dtWrap) dtWrap.style.display = data.homeDelivery ? "" : "none";
  if (dtEl && data.deliveryTime) dtEl.value = data.deliveryTime;

  // Services
  document.querySelectorAll(".service-checkbox").forEach((cb) => {
    cb.checked = (data.services || []).includes(cb.value);
  });

  // Choices dropdowns - ORDER IS IMPORTANT!
  // 1. Set owners and employees (no dependencies)
  if (ownersChoices) ownersChoices.setChoiceByValue(data.owners || []);
  if (employeesChoices) employeesChoices.setChoiceByValue(data.employees || []);

  // 2. Set states FIRST (districts and cities depend on states)
  if (statesChoices) {
    statesChoices.setChoiceByValue(data.states || []);
  }

  // 3. Update district choices based on selected states
  updateDistrictChoices();

  // 4. Update city choices based on states and districts
  updateCityChoices();

  // 5. THEN set districts and cities (after the choices have been updated)
  // Use setTimeout to ensure Choices.js has finished updating
  setTimeout(() => {
    if (districtsChoices && data.districts && data.districts.length > 0) {
      districtsChoices.setChoiceByValue(data.districts);
    }
    if (citiesChoices && data.cities && data.cities.length > 0) {
      citiesChoices.setChoiceByValue(data.cities);
    }
  }, 100);

  // Pricing rules
  const popRules = (cId, arr) => {
    document.getElementById(cId).innerHTML = "";
    if (arr && arr.length)
      arr.forEach((r) => window.addPricingRule(cId, r.min, r.max, r.fee));
    else window.addPricingRule(cId);
  };
  popRules("xeroxRulesContainer", data.deliveryPrices?.xerox);
  popRules("stdRulesContainer", data.deliveryPrices?.others);

  // Dynamic arrays
  const popArr = (cId, arr, makeFn) => {
    const c = document.getElementById(cId);
    c.innerHTML = "";
    const items = arr && arr.length ? arr : [""];
    items.forEach((v) => {
      const el = makeFn();
      el.querySelector("input").value = v;
      c.appendChild(el);
    });
  };
  popArr("mobilesContainer", data.mobileNumbers, () =>
    createRemovableEntry("10-digit number", "[0-9]{10}", 10, true, "mobile"),
  );
  popArr("waContainer", data.whatsappNumbers, () =>
    createRemovableEntry(
      "10-digit WhatsApp number",
      "[0-9]{10}",
      10,
      false,
      "wa",
    ),
  );
  popArr("areasContainer", data.areas, () =>
    createRemovableEntry("e.g., North District", null, null, false, "area"),
  );

  editShopId = id;
  formTitle.textContent = "Edit Shop";
  formSubtitle.textContent = `Updating settings for ${data.name}`;
  submitBtn.textContent = "Update Shop";
};

window.deleteShop = async function (id) {
  const data = shopsDataMap.get(id);
  if (
    !confirm(
      `Are you sure you want to completely delete "${data?.name || "this shop"}"?`,
    )
  )
    return;
  try {
    await deleteDoc(doc(db, "shops", id));
    showToast("Shop deleted successfully.", "success");
    if (editShopId === id) closeShopModal();
    // Clear localStorage + Cloudflare Worker KV cache
    try {
      Object.keys(localStorage)
        .filter(
          (k) =>
            k.includes("global_shops_data") ||
            k.includes("xerox_shops_data") ||
            k === "jasa_xerox_shops_v1" ||
            k === "jasa_xerox_shops_v2",
        )
        .forEach((k) => localStorage.removeItem(k));
    } catch (_) {}
    bustShopsCache();
    await fetchShops();
  } catch (err) {
    console.error("Error deleting shop:", err);
    showToast("Failed to delete shop.", "error");
  }
};

/* ─────────── Pricing Validation ─────────── */
function getAndValidatePricingRules(containerId, labelName) {
  const container = document.getElementById(containerId);
  const rules = [];
  let isValid = true;
  let errorMessage = "";

  container.querySelectorAll(".pricing-rule-entry").forEach((entry) => {
    const min = parseInt(entry.querySelector(".rule-min").value, 10);
    const maxStr = entry.querySelector(".rule-max").value.trim();
    const max = maxStr === "" ? null : parseInt(maxStr, 10);
    const fee = parseFloat(entry.querySelector(".rule-fee").value);
    if (isNaN(min) || isNaN(fee)) return;
    rules.push({ min, max, fee });
  });

  if (rules.length === 0) return { isValid: true, rules: [] };
  rules.sort((a, b) => a.min - b.min);

  for (let i = 0; i < rules.length; i++) {
    if (rules[i].max !== null && rules[i].min > rules[i].max) {
      isValid = false;
      errorMessage = `${labelName} Delivery: Min (${rules[i].min}) cannot exceed Max (${rules[i].max}).`;
      break;
    }
    if (i > 0) {
      const prevMax = rules[i - 1].max;
      if (prevMax === null || rules[i].min <= prevMax) {
        isValid = false;
        errorMessage = `${labelName} Delivery: Rules overlap. Keep ranges clean (e.g. 0–100, 101–200).`;
        break;
      }
    }
  }
  return { isValid, rules, errorMessage };
}

/* ─────────── Form Submit ─────────── */
shopForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const xeroxCheck = getAndValidatePricingRules("xeroxRulesContainer", "Xerox");
  const stdCheck = getAndValidatePricingRules(
    "stdRulesContainer",
    "Standard Services",
  );

  if (!xeroxCheck.isValid) {
    showToast(xeroxCheck.errorMessage, "error");
    return;
  }
  if (!stdCheck.isValid) {
    showToast(stdCheck.errorMessage, "error");
    return;
  }

  const owners = ownersChoices ? ownersChoices.getValue(true) : [];
  if (owners.length === 0) {
    showToast("Please select at least one Shop Owner.", "error");
    return;
  }

  const shopData = {
    name: document.getElementById("shopName").value.trim(),
    address: document.getElementById("shopAddress").value.trim(),
    locationLink: document.getElementById("shopLocationLink").value.trim(),
    shopType:
      document.querySelector('input[name="shopType"]:checked')?.value || "shop",
    homeDelivery: document.getElementById("shopHomeDelivery")?.checked === true,
    deliveryTime: document.getElementById("shopHomeDelivery")?.checked
      ? document.getElementById("shopDeliveryTime")?.value || "Within 24 hours"
      : null,
    mobileNumbers: Array.from(document.querySelectorAll(".mobile-input"))
      .map((i) => i.value.trim())
      .filter(Boolean),
    whatsappNumbers: Array.from(document.querySelectorAll(".wa-input"))
      .map((i) => i.value.trim())
      .filter(Boolean),
    owners,
    employees: employeesChoices ? employeesChoices.getValue(true) : [],
    states: statesChoices ? statesChoices.getValue(true) : [],
    districts: districtsChoices ? districtsChoices.getValue(true) : [],
    cities: citiesChoices ? citiesChoices.getValue(true) : [],
    services: Array.from(
      document.querySelectorAll(".service-checkbox:checked"),
    ).map((cb) => cb.value),
    areas: Array.from(document.querySelectorAll(".area-input"))
      .map((i) => i.value.trim())
      .filter(Boolean),
    deliveryPrices: {
      xerox: xeroxCheck.rules,
      others: stdCheck.rules,
    },
    notes: document.getElementById("shopNotes").value.trim(),
    lat: shopPin ? shopPin.lat : null,
    lng: shopPin ? shopPin.lng : null,
    serviceRadiusKm: Math.max(1, Number(document.getElementById("shopRadiusKm")?.value) || 10),
    status: "active",
  };

  submitBtn.disabled = true;
  submitBtn.textContent = editShopId ? "Updating..." : "Creating...";

  try {
    if (editShopId) {
      shopData.updatedAt = new Date();
      await updateDoc(doc(db, "shops", editShopId), shopData);
      showToast("Shop updated successfully!", "success");
    } else {
      shopData.createdAt = new Date();
      await addDoc(collection(db, "shops"), shopData);
      showToast("Shop created successfully!", "success");
    }

    // Clear user-facing shop caches (localStorage + Cloudflare Worker KV)
    try {
      Object.keys(localStorage)
        .filter(
          (k) =>
            k.includes("global_shops_data") ||
            k.includes("xerox_shops_data") ||
            k === "jasa_xerox_shops_v1" ||
            k === "jasa_xerox_shops_v2",
        )
        .forEach((k) => localStorage.removeItem(k));
    } catch (_) {
      /* ignore */
    }
    await Promise.all([bustShopsCache(), bustLocationsCache()]);

    closeShopModal();
    await fetchShops();
  } catch (err) {
    console.error("Error saving shop:", err);
    showToast("Failed to save shop. Check console.", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = editShopId ? "Update Shop" : "Create Shop";
  }
});

/* ─────────── Auth Guard (admin only) ─────────── */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace(
      "login.html?redirect=" +
        encodeURIComponent(window.location.pathname + window.location.search),
    );
    return;
  }
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists()) {
      window.location.replace("index.html");
      return;
    }

    const roles = snap.data().roles || [snap.data().role || "user"];
    if (!roles.includes("admin")) {
      showToast("Admin access required.", "error");
      setTimeout(() => window.location.replace("index.html"), 1200);
      return;
    }

    // Init
    window.addPricingRule("xeroxRulesContainer");
    window.addPricingRule("stdRulesContainer");
    initDropdowns().then(() => loadOtherShops());
  } catch (err) {
    console.error("[ManageShops] Auth check failed:", err);
    window.location.replace("index.html");
  }
});

/* ─────────── "Others" Fallback Shops ─────────── */

/**
 * Populate the four fallback-shop <select> elements.
 * Shops are sorted alphabetically by name.
 * Preserves any currently selected value so re-population after a shop
 * create/edit doesn't lose the admin's saved choice.
 */
function populateFallbackSelects() {
  const ids = [
    "fallbackXerox",
    "fallbackStationary",
    "fallbackBooks",
    "fallbackKits",
  ];

  // Snapshot current selections before rebuilding
  const prev = {};
  ids.forEach((id) => {
    const el = document.getElementById(id);
    prev[id] = el ? el.value : "";
  });

  // Sort shops alphabetically
  const sorted = Array.from(shopsDataMap.entries()).sort(([, a], [, b]) =>
    (a.name || "").localeCompare(b.name || ""),
  );

  const emptyOpt = '<option value="">— None —</option>';
  const shopOpts = sorted
    .map(([id, data]) => `<option value="${id}">${escHtml(data.name)}</option>`)
    .join("");

  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = emptyOpt + shopOpts;
    // Restore previous selection if the shop still exists
    if (prev[id] && shopsDataMap.has(prev[id])) el.value = prev[id];
  });
}

/**
 * Load the current "other shops" config from the KV worker and
 * pre-select the saved values in the four dropdowns.
 * Also validates that saved IDs still correspond to existing shops —
 * stale IDs (from deleted shops) are cleared automatically.
 */
async function loadOtherShops() {
  // Always rebuild the option lists with the latest shop data first
  populateFallbackSelects();

  try {
    // GET /api/config/other-shops is public — no auth header needed
    const res = await fetch(`${WORKER_URL}/api/config/other-shops`, {
      signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
    });
    if (!res.ok) {
      console.warn("[OtherShops] load failed: HTTP", res.status);
      return;
    }

    const json = await res.json();

    // Map of category → element ID
    const mapping = {
      xerox: "fallbackXerox",
      stationary: "fallbackStationary",
      books: "fallbackBooks",
      kits: "fallbackKits",
    };

    let staleFound = false;
    for (const [category, elId] of Object.entries(mapping)) {
      const savedId = json[category];
      const el = document.getElementById(elId);
      if (!el) continue;

      if (savedId && shopsDataMap.has(savedId)) {
        // ID is valid — select it
        el.value = savedId;
      } else if (savedId) {
        // Stale ID — shop was deleted; keep dropdown on "None" and flag it
        el.value = "";
        staleFound = true;
        console.warn(
          `[OtherShops] Stale shop ID for "${category}": ${savedId} (shop not found)`,
        );
      }
      // null/undefined savedId → leave as "— None —"
    }

    if (staleFound) {
      // Update the badge label to warn the admin
      const status = document.getElementById("otherShopsStatus");
      if (status) {
        status.className = "ms-fallback-status error";
        status.textContent =
          "⚠ Some saved shops no longer exist. Review and save.";
      }
    }
  } catch (e) {
    console.warn("[OtherShops] load error:", e.message);
  }
}

/**
 * Save the four selected shop IDs to Cloudflare Worker KV via POST.
 * Empty selections are sent as null (clear).
 */
window.saveOtherShops = async function () {
  const btn = document.getElementById("saveOtherShopsBtn");
  const status = document.getElementById("otherShopsStatus");
  if (!btn || !status) return;

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
  status.className = "ms-fallback-status";
  status.textContent = "";

  try {
    const idToken = await auth.currentUser?.getIdToken();
    const adminKey = idToken ? await getAdminToken(idToken) : null;
    if (!adminKey) throw new Error("Not authenticated as admin.");

    // Read values — empty string → null (explicitly cleared)
    const readVal = (id) => {
      const v = document.getElementById(id)?.value?.trim();
      return v && v !== "" ? v : null;
    };

    const payload = {
      xerox: readVal("fallbackXerox"),
      stationary: readVal("fallbackStationary"),
      books: readVal("fallbackBooks"),
      kits: readVal("fallbackKits"),
    };

    console.log(
      "[OtherShops] Saving payload:",
      payload,
      "| adminKey present:",
      !!adminKey,
    );

    const res = await fetch(`${WORKER_URL}/api/config/other-shops`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminKey}`,
      },
      body: JSON.stringify(payload),
    });

    // Read body once — works for both error and success paths
    let json;
    try {
      json = await res.json();
    } catch (_) {
      json = {};
    }
    console.log("[OtherShops] Worker response:", res.status, json);

    if (!res.ok) {
      console.error("[OtherShops] Worker error response:", res.status, json);
      throw new Error(json.error || `HTTP ${res.status} ${res.statusText}`);
    }

    if (!json.success) {
      console.error("[OtherShops] Worker success=false response:", json);
      throw new Error(
        json.error ||
          `Worker returned status ${res.status} but no success flag`,
      );
    }

    status.className = "ms-fallback-status success";
    status.textContent = "✓ Saved";
    showToast("Fallback shops saved.", "success");
  } catch (e) {
    console.error("[OtherShops] save error:", e);
    status.className = "ms-fallback-status error";
    status.textContent = "✗ " + e.message;
    showToast("Failed to save: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save';
  }
};
