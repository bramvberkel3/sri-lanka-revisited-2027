// Sri Lanka 2027 – shared trip planner
// Vanilla JS + Firebase (Auth + Firestore realtime) + Leaflet/OpenStreetMap.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, TRIP_ID } from "./firebase-config.js";

/* ───────────── Constants ───────────── */
const TRIP_START = "2027-01-12";
const TRIP_END = "2027-01-26";
const DEPART_AT = new Date("2027-01-12T12:30:00+02:00"); // LCA departure, Cyprus time
const COLS = ["flights", "items", "budget", "packing", "contacts", "prep", "ideas", "docs", "notes"];

const TYPES = {
  location: { label: "Location / base", ico: "📍" },
  accommodation: { label: "Accommodation", ico: "🛏️" },
  activity: { label: "Activity", ico: "🎯" },
  transport: { label: "Travel / transport", ico: "🚗" },
  food: { label: "Food & drink", ico: "🍽️" },
  other: { label: "Other", ico: "📝" },
};
const ITEM_STATUS = { tentative: "Tentative", tobook: "To book", booked: "Booked", paid: "Paid", done: "Done" };
const BUDGET_STATUS = { estimate: "Estimate", booked: "Booked", paid: "Paid" };
const COMMITTED = new Set(["booked", "paid", "done"]);
const PAID = new Set(["paid", "done"]);
const BUDGET_CATS = ["Flights", "Accommodation", "Transport", "Activities", "Food & drink", "Visa & documents", "Insurance", "Shopping & gifts", "Other"];
const TYPE_TO_CAT = { accommodation: "Accommodation", transport: "Transport", activity: "Activities", food: "Food & drink", location: "Other", other: "Other" };
const PACK_CATS = ["Clothes", "Toiletries", "Health & meds", "Electronics", "Documents & money", "Diving & activities", "Beach", "Other"];
const CONTACT_CATS = ["Accommodation", "Driver / transport", "Tour / activity", "Diving", "Restaurant", "Airline", "Insurance", "Emergency", "Other"];
const PREP_CATS = ["Bookings", "Documents", "Health", "Money", "Packing", "Home", "Other"];
const PREP_STATUS = { todo: "To do", doing: "In progress", done: "Done" };
const DOC_TYPES = ["Passport", "Sri Lanka ETA / visa", "Travel insurance", "Vaccinations", "International driving permit", "Diving certification", "Flight e-ticket", "Other"];
const DOC_STATUS = { todo: "To do", doing: "In progress", ready: "Ready" };
const NAV = [
  ["home", "Overview", "🏝️"], ["flights", "Flights", "✈️"], ["calendar", "Calendar", "📅"], ["map", "Map", "🗺️"],
  ["budget", "Budget", "💶"], ["packing", "Packing", "🎒"], ["prep", "Preparation", "✅"], ["ideas", "Ideas", "💡"],
  ["contacts", "Contacts", "📇"], ["docs", "Documents", "🛂"], ["notes", "To discuss", "💬"],
];

/* ───────────── State ───────────── */
const S = {
  user: null, meta: null, metaLoaded: false, view: localStorage.getItem("view") || "home",
  calMode: "list", mapDay: "all", mapIdeas: true, packFilter: "all", packOwner: "all",
  pending: false,
};
COLS.forEach((c) => (S[c] = []));
let fs, auth, unsubs = [];

/* ───────────── Utils ───────────── */
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pd = (s) => { if (!s) return null; const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (s, n) => { const d = pd(s); d.setDate(d.getDate() + n); return iso(d); };
const fmtDay = (s, opts = { weekday: "short", day: "numeric", month: "short" }) => (s ? pd(s).toLocaleDateString("en-GB", opts) : "");
const tripDays = () => { const out = []; for (let d = TRIP_START; d <= TRIP_END; d = addDays(d, 1)) out.push(d); return out; };
const rate = () => Number(S.meta?.usdEur) || 0.87;
const toEUR = (amt, cur) => (Number(amt) || 0) * (cur === "USD" ? rate() : 1);
const eur = (n, dec = 0) => "€" + (Number(n) || 0).toLocaleString("en-GB", { minimumFractionDigits: dec, maximumFractionDigits: dec });
const money = (amt, cur) => (amt === "" || amt == null ? "" : (cur === "USD" ? "$" : "€") + Number(amt).toLocaleString("en-GB", { maximumFractionDigits: 2 }));
const names = () => S.meta?.names?.length ? S.meta.names : ["Traveller 1", "Traveller 2"];
const myName = () => (S.meta?.who && S.user && S.meta.who[S.user.uid]) || S.user?.email?.split("@")[0] || "Someone";
const todayIso = () => iso(new Date());
const byDateTime = (a, b) => (a.date || "9999").localeCompare(b.date || "9999") || (a.time || "99").localeCompare(b.time || "99");
const pill = (key, label) => `<span class="pill ${esc(key)}">${esc(label)}</span>`;
const sumBy = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2200); }

/* ───────────── Firebase ───────────── */
const tripRef = () => doc(fs, "trips", TRIP_ID);
const colRef = (c) => collection(fs, "trips", TRIP_ID, c);
const docRef = (c, id) => doc(fs, "trips", TRIP_ID, c, id);

async function save(col, id, data) {
  const stamp = { updatedBy: myName(), updatedAt: serverTimestamp() };
  try {
    if (id) await updateDoc(docRef(col, id), { ...data, ...stamp });
    else { const r = await addDoc(colRef(col), { ...data, ...stamp, createdBy: myName(), createdAt: serverTimestamp() }); return r.id; }
    return id;
  } catch (e) { console.error(e); toast("Couldn't save: " + (e.code || e.message)); throw e; }
}
async function remove(col, id) { try { await deleteDoc(docRef(col, id)); } catch (e) { toast("Couldn't delete: " + (e.code || e.message)); } }
async function saveMeta(patch) { try { await setDoc(tripRef(), patch, { merge: true }); } catch (e) { toast("Couldn't save settings: " + (e.code || e.message)); } }

function subscribe() {
  unsubs.forEach((u) => u()); unsubs = [];
  unsubs.push(onSnapshot(tripRef(), { includeMetadataChanges: true }, (snap) => {
    S.meta = snap.exists() ? snap.data() : null; S.metaLoaded = true; setSync(snap.metadata.hasPendingWrites); render();
  }, onSubError));
  COLS.forEach((c) => unsubs.push(onSnapshot(colRef(c), { includeMetadataChanges: true }, (snap) => {
    S[c] = snap.docs.map((d) => ({ id: d.id, ...d.data() })); setSync(snap.metadata.hasPendingWrites); render();
  }, onSubError)));
}
function onSubError(e) {
  console.error(e);
  if (e.code === "permission-denied") {
    $("#view").innerHTML = `<div class="empty"><h3>No access</h3><p>This account (${esc(S.user?.email)}) isn't on the trip's allow-list. Check the email addresses in your Firestore rules.</p><button class="btn" data-act="signout">Sign out</button></div>`;
    showApp();
  }
}
function setSync(pending) {
  S.pending = pending;
  const el = $("#sync");
  const off = !navigator.onLine;
  el.className = "sync" + (off ? " offline" : "");
  el.textContent = off ? "Offline – changes will sync" : pending ? "Saving…" : "Synced";
}
window.addEventListener("online", () => setSync(S.pending));
window.addEventListener("offline", () => setSync(S.pending));

/* ───────────── Boot ───────────── */
function showOnly(id) { ["login", "loading", "app"].forEach((x) => $("#" + x).classList.toggle("hidden", x !== id)); }
function showApp() { showOnly("app"); }

function boot() {
  if (String(firebaseConfig.apiKey).startsWith("PASTE")) {
    showOnly("login");
    $("#loginForm").innerHTML = `<p class="form-msg">Firebase isn't configured yet. Paste your config into <code>firebase-config.js</code> (see README).</p>`;
    return;
  }
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  onAuthStateChanged(auth, (u) => {
    S.user = u;
    if (!u) { unsubs.forEach((x) => x()); unsubs = []; showOnly("login"); return; }
    showOnly("loading"); subscribe();
    setTimeout(() => { if (!S.metaLoaded) showApp(); }, 10000);
  });
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target), msg = $("#loginMsg");
    msg.className = "form-msg"; msg.textContent = "Signing in…";
    try { await signInWithEmailAndPassword(auth, f.get("email").trim(), f.get("password")); msg.textContent = ""; }
    catch (err) { msg.textContent = err.code === "auth/invalid-credential" ? "Wrong email or password." : "Sign-in failed: " + (err.code || err.message); }
  });
  $("#forgotBtn").addEventListener("click", async () => {
    const email = $("#loginForm [name=email]").value.trim(), msg = $("#loginMsg");
    if (!email) { msg.textContent = "Enter your email first."; return; }
    try { await sendPasswordResetEmail(auth, email); msg.className = "form-msg ok"; msg.textContent = "Reset link sent – check your inbox."; }
    catch (err) { msg.textContent = "Couldn't send reset: " + (err.code || err.message); }
  });
}

/* ───────────── Render ───────────── */
function render() {
  if (!S.user || !S.metaLoaded) return;
  showApp();
  // keep focus/typing across live re-renders
  const a = document.activeElement, key = a?.dataset?.keep, val = a?.value, sel = a?.selectionStart;
  renderNav();
  $("#whoami").textContent = `Signed in as ${myName()}`;
  const isMap = S.view === "map" && S.meta;
  $("#view").classList.toggle("hidden", isMap);
  $("#mapPanel").classList.toggle("hidden", !isMap);
  if (!S.meta) { $("#view").innerHTML = viewWelcome(); return; }
  if (isMap) renderMap();
  else $("#view").innerHTML = (VIEWS[S.view] || VIEWS.home)();
  $("#mobileTitle").textContent = NAV.find((n) => n[0] === S.view)?.[1] || "Sri Lanka 2027";
  if (S.meta && S.user && !S.meta.who?.[S.user.uid] && !S._askedName && $("#modal").classList.contains("hidden")) { S._askedName = true; openSettings(); }
  if (key) { const el = document.querySelector(`[data-keep="${key}"]`); if (el) { el.focus(); el.value = val; try { el.setSelectionRange(sel, sel); } catch {} } }
}
function renderNav() {
  const badge = { prep: S.prep.filter((p) => p.status !== "done" && p.due && p.due < todayIso()).length, notes: S.notes.filter((n) => n.status !== "decided").length };
  $("#nav").innerHTML = NAV.map(([k, l, i]) => `<button class="${S.view === k ? "active" : ""}" data-act="nav" data-v="${k}"><span class="ico">${i}</span><span>${l}</span>${badge[k] ? `<span class="badge">${badge[k]}</span>` : ""}</button>`).join("");
}
function head(title, sub, actions = "") {
  return `<div class="page-head"><div><h2>${title}</h2>${sub ? `<p class="muted">${sub}</p>` : ""}</div><div class="actions">${actions}</div></div>`;
}
const emptyBox = (text, btns = "") => `<div class="empty"><p>${text}</p>${btns}</div>`;

/* ───────────── Views ───────────── */
function viewWelcome() {
  return `<div class="card" style="max-width:560px">
    <h2>Welcome 🌴</h2>
    <p>This trip hasn't been set up yet. If Claude gave you a starter file (<code>trip-data.json</code>) with your flights, import it. Otherwise start blank and add things yourself.</p>
    <div class="actions"><button class="btn primary" data-act="import">Import starter file</button><button class="btn" data-act="start-blank">Start blank</button></div>
    <input type="file" id="importFile" accept="application/json" class="hidden" />
  </div>`;
}

const VIEWS = {
  home() {
    const days = Math.ceil((DEPART_AT - new Date()) / 864e5);
    const b = budgetTotals();
    const target = Number(S.meta.budgetTarget) || 0;
    const prepDone = S.prep.filter((p) => p.status === "done").length;
    const packDone = S.packing.filter((p) => p.packed).length;
    const toBook = S.items.filter((i) => i.status === "tobook").sort(byDateTime);
    const nextPrep = S.prep.filter((p) => p.status !== "done").sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999")).slice(0, 6);
    const open = S.notes.filter((n) => n.status !== "decided").slice(0, 5);
    return head(`Hi ${esc(myName())} 👋`, "Sri Lanka · 12–26 January 2027") + `
    <div class="grid cols-4">
      <div class="card stat countdown"><span class="num">${days > 0 ? days : "🌴"}</span><span class="lbl">${days > 0 ? "days to go" : "Enjoy the trip!"}</span></div>
      <div class="card stat"><span class="num">${eur(b.total)}</span><span class="lbl">planned budget${target ? ` of ${eur(target)}` : ""}</span>${target ? `<div class="progress ${b.total > target ? "over" : ""}"><span style="width:${Math.min(100, (b.total / target) * 100)}%"></span></div>` : ""}</div>
      <div class="card stat"><span class="num">${prepDone}/${S.prep.length}</span><span class="lbl">preparation tasks done</span><div class="progress"><span style="width:${S.prep.length ? (prepDone / S.prep.length) * 100 : 0}%"></span></div></div>
      <div class="card stat"><span class="num">${packDone}/${S.packing.length}</span><span class="lbl">items packed</span><div class="progress"><span style="width:${S.packing.length ? (packDone / S.packing.length) * 100 : 0}%"></span></div></div>
    </div>
    <div class="grid cols-3" style="margin-top:1rem">
      <div class="card"><h3>Next preparation steps</h3><ul class="list-plain" style="margin-top:.7rem">${nextPrep.map((p) => `<li><span>${esc(p.title)}</span><span class="${p.due && p.due < todayIso() ? "overdue" : "muted"} small">${p.due ? fmtDay(p.due, { day: "numeric", month: "short" }) : ""}</span></li>`).join("") || `<li class="muted">Nothing pending.</li>`}</ul><button class="btn link" data-act="nav" data-v="prep">Open preparation →</button></div>
      <div class="card"><h3>Still to book</h3><ul class="list-plain" style="margin-top:.7rem">${toBook.slice(0, 6).map((i) => `<li><span>${TYPES[i.type]?.ico || ""} ${esc(i.title)}</span><span class="muted small">${fmtDay(i.date, { day: "numeric", month: "short" })}</span></li>`).join("") || `<li class="muted">Nothing marked "To book".</li>`}</ul><button class="btn link" data-act="nav" data-v="calendar">Open calendar →</button></div>
      <div class="card"><h3>To discuss</h3><ul class="list-plain" style="margin-top:.7rem">${open.map((n) => `<li><span>${esc(n.title)}</span><span class="muted small">${esc(n.createdBy || "")}</span></li>`).join("") || `<li class="muted">No open topics.</li>`}</ul><button class="btn link" data-act="nav" data-v="notes">Open to discuss →</button></div>
    </div>`;
  },

  flights() {
    const segs = [...S.flights].sort((a, b) => ((a.depDate || "") + (a.depTime || "")).localeCompare((b.depDate || "") + (b.depTime || "")));
    const groups = ["Outbound", "Return"].map((dir) => [dir, segs.filter((s) => (s.dir || "Outbound") === dir)]);
    const pax = S.meta.passengers || [];
    const fc = S.meta.flightCost || {};
    const segCard = (s) => `<div class="card flight" data-act="edit" data-col="flights" data-id="${s.id}" style="cursor:pointer">
      <div class="flight-route">
        <div><div class="code">${esc(s.from)}</div><div class="when">${fmtDay(s.depDate)} · <b>${esc(s.depTime)}</b></div><div class="small muted">${esc(s.fromName || "")}</div></div>
        <div class="flight-line">${esc(s.flightNo)}<br>${esc(s.duration || "")}</div>
        <div class="end"><div class="code">${esc(s.to)}</div><div class="when">${fmtDay(s.arrDate)} · <b>${esc(s.arrTime)}</b></div><div class="small muted">${esc(s.toName || "")}</div></div>
      </div>
      <div class="kv"><span><b>Airline</b>${esc(s.airline)}</span><span><b>Aircraft</b>${esc(s.aircraft || "–")}</span><span><b>Cabin</b>${esc(s.cabin || "–")}</span><span><b>Seats</b>${esc(s.seats || "not selected")}</span><span><b>Status</b>${esc(s.status || "")}</span></div>
      ${s.notes ? `<div class="small muted">${esc(s.notes)}</div>` : ""}
    </div>`;
    return head("Flights", "Times are local at each airport.", `<button class="btn" data-act="add" data-col="flights">+ Add flight</button>`) + `
    <div class="grid cols-2">
      <div class="card"><div class="muted small">Booking reference (PNR)</div><div class="pnr">${esc(S.meta.pnr || "—")}</div>
        <div class="small" style="margin-top:.4rem">${esc(S.meta.airline || "")} · ${esc(S.meta.baggage || "")}</div>
        <a class="btn small" style="margin-top:.6rem;display:inline-block" href="https://www.qatarairways.com/en/manage-booking.html" target="_blank" rel="noopener">Manage booking ↗</a></div>
      <div class="card"><div class="muted small">Passengers & e-tickets</div>
        <ul class="list-plain" style="margin-top:.5rem">${pax.map((p) => `<li><span>${esc(p.name)}</span><span class="small" style="font-family:ui-monospace,monospace">${esc(p.eticket || "")}</span></li>`).join("") || `<li class="muted">—</li>`}</ul>
        <div class="small" style="margin-top:.7rem">Flight cost (total): <b>${fc.amount ? money(fc.amount, fc.cur) : "not set"}</b> <button class="btn link small" data-act="flight-cost">edit</button></div></div>
    </div>
    ${groups.map(([dir, list]) => `<div class="section-title"><h3>${dir === "Outbound" ? "🛫 Outbound" : "🛬 Return"}</h3></div><div class="grid">${list.map(segCard).join("") || emptyBox("No segments.")}</div>`).join("")}`;
  },

  calendar() {
    const days = tripDays();
    const outside = S.items.filter((i) => !i.date || i.date < TRIP_START || i.date > TRIP_END).sort(byDateTime);
    const stays = S.items.filter((i) => i.type === "accommodation" && i.date && Number(i.nights) > 0);
    const dayHtml = (d) => {
      const list = S.items.filter((i) => i.date === d).sort(byDateTime);
      const staying = stays.filter((s) => d > s.date && d < addDays(s.date, Number(s.nights)));
      const base = list.find((i) => i.type === "location") || null;
      const dayCost = sumBy(list, (i) => toEUR(i.cost, i.cur));
      return `<div class="day" id="day-${d}">
        <div class="day-head"><div class="day-date"><small>${fmtDay(d, { weekday: "short" })}</small><b>${pd(d).getDate()}</b><small>Jan</small></div>
          <div class="day-title"><div class="base">${base ? esc(base.place || base.title) : `<span class="muted">Day ${days.indexOf(d) + 1}</span>`}</div>${dayCost ? `<div class="small muted">${eur(dayCost)} planned</div>` : ""}</div>
          <button class="btn small" data-act="add" data-col="items" data-date="${d}">+ Add</button></div>
        <div class="day-body">
          ${staying.map((s) => `<div class="stay-line">🛏️ Staying at ${esc(s.title)} (night ${Math.round((pd(d) - pd(s.date)) / 864e5) + 1} of ${s.nights})</div>`).join("")}
          ${list.map(entryHtml).join("") || (staying.length ? "" : `<div class="day-empty">Nothing planned yet.</div>`)}
        </div></div>`;
    };
    return head("Calendar", "Locations, stays, activities and travel for each day. Tap an entry to edit.",
      `<button class="btn" data-act="nav" data-v="map">🗺️ View on map</button><button class="btn primary" data-act="add" data-col="items">+ Add entry</button>`) +
      `<div class="days">${days.map(dayHtml).join("")}</div>
      ${outside.length ? `<div class="section-title"><h3>Outside trip dates / undated</h3></div><div class="day"><div class="day-body">${outside.map(entryHtml).join("")}</div></div>` : ""}`;
  },

  budget() {
    const b = budgetTotals();
    const target = Number(S.meta.budgetTarget) || 0;
    const cats = BUDGET_CATS.filter((c) => b.byCat[c]);
    const days = tripDays();
    const maxDay = Math.max(1, ...days.map((d) => (b.byDay[d]?.c || 0) + (b.byDay[d]?.e || 0)));
    const ideasEst = sumBy(S.ideas.filter((i) => !i.scheduledId), (i) => toEUR(i.cost, i.cur));
    const lines = [...S.budget].sort((a, b) => (a.category || "").localeCompare(b.category || ""));
    return head("Budget", `Rolls up flights, calendar costs and the extra lines below. All totals in EUR · 1 USD = €${rate()}.`,
      `<button class="btn" data-act="budget-settings">Rate & target</button><button class="btn primary" data-act="add" data-col="budget">+ Budget line</button>`) + `
    <div class="grid cols-4">
      <div class="card stat"><span class="num">${eur(b.total)}</span><span class="lbl">Total planned</span>${target ? `<div class="progress ${b.total > target ? "over" : ""}"><span style="width:${Math.min(100, (b.total / target) * 100)}%"></span></div><span class="small muted">${b.total > target ? `${eur(b.total - target)} over` : `${eur(target - b.total)} left`} of ${eur(target)}</span>` : `<button class="btn link small" data-act="budget-settings">Set a target</button>`}</div>
      <div class="card stat"><span class="num">${eur(b.committed)}</span><span class="lbl">Booked or paid</span></div>
      <div class="card stat"><span class="num">${eur(b.paid)}</span><span class="lbl">Already paid</span></div>
      <div class="card stat"><span class="num">${eur(b.total / 2)}</span><span class="lbl">Per person</span></div>
    </div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card"><h3>By category</h3>
        <table class="table" style="margin-top:.5rem"><thead><tr><th>Category</th><th class="num">Estimated</th><th class="num">Booked</th><th class="num">Paid</th><th class="num">Total</th></tr></thead><tbody>
        ${cats.map((c) => { const x = b.byCat[c]; return `<tr><td>${c}</td><td class="num">${eur(x.est)}</td><td class="num">${eur(x.booked)}</td><td class="num">${eur(x.paid)}</td><td class="num"><b>${eur(x.est + x.booked + x.paid)}</b></td></tr>`; }).join("") || `<tr><td colspan="5" class="muted">No costs entered yet.</td></tr>`}
        ${cats.length ? `<tr class="total"><td>Total</td><td class="num">${eur(b.total - b.committed)}</td><td class="num">${eur(b.committed - b.paid)}</td><td class="num">${eur(b.paid)}</td><td class="num">${eur(b.total)}</td></tr>` : ""}
        </tbody></table>
        ${ideasEst ? `<p class="small muted">Not included: ${eur(ideasEst)} of unscheduled ideas.</p>` : ""}</div>
      <div class="card"><h3>Per day</h3><p class="small muted" style="margin:.2rem 0 .7rem">Stays are spread over their nights. <span class="pill booked">booked/paid</span> <span class="pill">estimate</span></p>
        <div class="bars">${days.map((d) => { const x = b.byDay[d] || { c: 0, e: 0 }; return `<div class="bar-row"><span>${fmtDay(d, { day: "numeric", month: "short" })}</span><div class="bar"><span class="seg-committed" style="width:${(x.c / maxDay) * 100}%"></span><span class="seg-estimate" style="width:${(x.e / maxDay) * 100}%"></span></div><span class="v">${x.c + x.e ? eur(x.c + x.e) : ""}</span></div>`; }).join("")}</div></div>
    </div>
    <div class="section-title"><h3>Extra budget lines</h3><span class="small muted">For costs that aren't a calendar entry: visa, insurance, daily food allowance, gifts…</span></div>
    <div class="row-list">${lines.map((l) => `<div class="row" data-act="edit" data-col="budget" data-id="${l.id}" style="cursor:pointer"><div class="main-col"><div class="title">${esc(l.title)}</div><div class="meta"><span>${esc(l.category)}</span>${l.date ? `<span>${fmtDay(l.date)}</span>` : ""}${l.notes ? `<span>${esc(l.notes)}</span>` : ""}</div></div><div class="right">${pill(l.status, BUDGET_STATUS[l.status] || "")}<b>${money(l.cost, l.cur)}</b></div></div>`).join("") || emptyBox("No extra lines yet.")}</div>`;
  },

  packing() {
    const ns = [...names(), "Shared"];
    let list = S.packing;
    if (S.packFilter === "todo") list = list.filter((p) => !p.packed);
    if (S.packOwner !== "all") list = list.filter((p) => p.owner === S.packOwner);
    const done = S.packing.filter((p) => p.packed).length;
    const groups = PACK_CATS.map((c) => [c, list.filter((p) => (p.category || "Other") === c).sort((a, b) => (a.name || "").localeCompare(b.name || ""))]).filter(([, l]) => l.length);
    return head("Packing list", `${done} of ${S.packing.length} packed`, `<button class="btn" data-act="pack-reset">Untick all</button>`) + `
    <div class="progress" style="margin-bottom:1rem"><span style="width:${S.packing.length ? (done / S.packing.length) * 100 : 0}%"></span></div>
    <form class="quick-add" data-form="pack">
      <input name="name" placeholder="Add an item, e.g. Reef-safe sunscreen" data-keep="pack-name" required />
      <select name="category" data-keep="pack-cat">${PACK_CATS.map((c) => `<option ${c === S._lastPackCat ? "selected" : ""}>${c}</option>`).join("")}</select>
      <select name="owner" data-keep="pack-owner">${ns.map((n) => `<option ${n === S._lastPackOwner ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
      <button class="btn primary">Add</button>
    </form>
    <div class="filters">
      ${[["all", "All"], ["todo", "Not packed"]].map(([k, l]) => `<button class="chip ${S.packFilter === k ? "active" : ""}" data-act="pack-filter" data-v="${k}">${l}</button>`).join("")}
      <span style="width:.6rem"></span>
      ${["all", ...ns].map((n) => `<button class="chip ${S.packOwner === n ? "active" : ""}" data-act="pack-owner" data-v="${esc(n)}">${n === "all" ? "Everyone" : esc(n)}</button>`).join("")}
    </div>
    ${groups.map(([c, l]) => `<div class="section-title"><h3>${c}</h3><span class="small muted">${l.filter((p) => p.packed).length}/${l.length}</span></div><div class="row-list">${l.map((p) => `
      <div class="row ${p.packed ? "done" : ""}"><button class="check ${p.packed ? "on" : ""}" data-act="toggle" data-col="packing" data-id="${p.id}" data-f="packed" aria-label="Packed">${p.packed ? "✓" : ""}</button>
      <div class="main-col"><div class="title">${esc(p.name)}${Number(p.qty) > 1 ? ` <span class="muted">×${p.qty}</span>` : ""}</div><div class="meta"><span>${esc(p.owner || "")}</span>${p.packed && p.updatedBy ? `<span>ticked by ${esc(p.updatedBy)}</span>` : ""}</div></div>
      <div class="right"><button class="icon-btn" data-act="edit" data-col="packing" data-id="${p.id}" aria-label="Edit">✎</button></div></div>`).join("")}</div>`).join("") ||
      emptyBox(S.packing.length ? "Nothing matches this filter." : "Your list is empty. Add items above, or start from a suggested list for a beach + diving + rafting trip.", S.packing.length ? "" : `<button class="btn" data-act="starter" data-col="packing">Load suggested list</button>`)}`;
  },

  prep() {
    const list = [...S.prep].sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
    const done = list.filter((p) => p.status === "done").length;
    const phaseOf = (p) => (!p.due ? "zz|No date set" : p.due >= TRIP_START ? "y|During the trip" : `${p.due.slice(0, 7)}|${pd(p.due).toLocaleDateString("en-GB", { month: "long", year: "numeric" })}`);
    const phases = {};
    list.forEach((p) => { (phases[phaseOf(p)] ||= []).push(p); });
    const t = todayIso();
    return head("Preparation", `Your planning process from now until departure · ${done}/${list.length} done`, `<button class="btn primary" data-act="add" data-col="prep">+ Task</button>`) + `
    <div class="progress" style="margin-bottom:1.6rem"><span style="width:${list.length ? (done / list.length) * 100 : 0}%"></span></div>
    ${Object.keys(phases).sort().map((k) => { const [, label] = k.split("|"); const ps = phases[k]; const past = ps.every((p) => p.status === "done");
      return `<div class="phase ${past ? "past" : ""}"><h3>${label} <span class="small muted">${ps.filter((p) => p.status === "done").length}/${ps.length}</span></h3><div class="row-list">${ps.map((p) => `
        <div class="row ${p.status === "done" ? "done" : ""}"><button class="check ${p.status === "done" ? "on" : ""}" data-act="prep-done" data-id="${p.id}" aria-label="Done">${p.status === "done" ? "✓" : ""}</button>
        <div class="main-col" data-act="edit" data-col="prep" data-id="${p.id}" style="cursor:pointer"><div class="title">${esc(p.title)}</div><div class="meta">${p.due ? `<span class="${p.status !== "done" && p.due < t ? "overdue" : ""}">${p.status !== "done" && p.due < t ? "Overdue · " : ""}${fmtDay(p.due)}</span>` : ""}<span>${esc(p.category || "")}</span>${p.owner ? `<span>👤 ${esc(p.owner)}</span>` : ""}${p.notes ? `<span>${esc(p.notes)}</span>` : ""}</div></div>
        <div class="right">${p.status === "doing" ? pill("doing", "In progress") : ""}${p.link ? `<a class="icon-btn" href="${esc(p.link)}" target="_blank" rel="noopener">↗</a>` : ""}</div></div>`).join("")}</div></div>`; }).join("") ||
      emptyBox("No tasks yet. Add your own, or load a suggested preparation plan (bookings, ETA visa, insurance, health, money, packing) with due dates working back from 12 January.", `<button class="btn" data-act="starter" data-col="prep">Load suggested plan</button>`)}`;
  },

  ideas() {
    const list = [...S.ideas].sort((a, b) => Object.keys(b.likes || {}).length - Object.keys(a.likes || {}).length);
    return head("Ideas wishlist", "Park places and activities here, heart the ones you like, then schedule them into a day.", `<button class="btn" data-act="nav" data-v="map">🗺️ On map</button><button class="btn primary" data-act="add" data-col="ideas">+ Idea</button>`) +
      (list.length ? `<div class="grid cols-3">${list.map((i) => { const sched = i.scheduledId && S.items.find((x) => x.id === i.scheduledId);
        return `<div class="card idea-card"><div class="top"><span class="type-ico t-${i.type || "other"}">${TYPES[i.type]?.ico || "💡"}</span><div style="flex:1;min-width:0"><div class="title" style="font-weight:600">${esc(i.title)}</div><div class="small muted">${esc(i.place || "")}${i.place && i.duration ? " · " : ""}${esc(i.duration || "")}</div></div><button class="icon-btn" data-act="edit" data-col="ideas" data-id="${i.id}" aria-label="Edit">✎</button></div>
        ${i.notes ? `<div class="small">${esc(i.notes)}</div>` : ""}
        <div class="small">${i.cost ? `≈ ${money(i.cost, i.cur)}` : ""} ${i.link ? `<a href="${esc(i.link)}" target="_blank" rel="noopener">link ↗</a>` : ""}</div>
        <div class="likes">${names().map((n) => `<button class="like ${i.likes?.[n] ? "on" : ""}" data-act="like" data-id="${i.id}" data-n="${esc(n)}">${i.likes?.[n] ? "❤️" : "🤍"} ${esc(n)}</button>`).join("")}</div>
        ${sched ? `<div class="small">${pill("booked", "Scheduled")} ${fmtDay(sched.date)}</div>` : `<button class="btn small" data-act="schedule" data-id="${i.id}">📅 Add to calendar</button>`}</div>`; }).join("")}</div>`
        : emptyBox("No ideas yet. Add anything you might want to do; you can schedule it into a day later."));
  },

  contacts() {
    const list = [...S.contacts].sort((a, b) => (a.category || "").localeCompare(b.category || "") || (a.name || "").localeCompare(b.name || ""));
    const tel = (p) => String(p || "").replace(/[^\d+]/g, "");
    return head("Contacts", "Hotels, drivers, dive centres, tour operators, emergency numbers.", `<button class="btn primary" data-act="add" data-col="contacts">+ Contact</button>`) +
      (list.length ? `<div class="grid cols-3">${list.map((c) => `<div class="card" style="display:grid;gap:.4rem;align-content:start">
        <div style="display:flex;justify-content:space-between;gap:.5rem"><div><div style="font-weight:600">${esc(c.name)}</div><div class="small muted">${esc(c.company || "")}</div></div><button class="icon-btn" data-act="edit" data-col="contacts" data-id="${c.id}" aria-label="Edit">✎</button></div>
        <div>${pill("", c.category || "Other")}</div>
        <div class="actions small">${c.phone ? `<a class="btn small" href="tel:${esc(tel(c.phone))}">📞 Call</a>` : ""}${c.phone && c.whatsapp ? `<a class="btn small" href="https://wa.me/${esc(tel(c.phone).replace("+", ""))}" target="_blank" rel="noopener">💬 WhatsApp</a>` : ""}${c.email ? `<a class="btn small" href="mailto:${esc(c.email)}">✉️ Email</a>` : ""}${c.website ? `<a class="btn small" href="${esc(c.website)}" target="_blank" rel="noopener">🌐 Web</a>` : ""}</div>
        ${c.phone ? `<div class="small">${esc(c.phone)}</div>` : ""}${c.notes ? `<div class="small muted">${esc(c.notes)}</div>` : ""}
        ${(() => { const linked = S.items.filter((i) => i.contactId === c.id); return linked.length ? `<div class="small">Linked: ${linked.map((i) => esc(i.title)).join(", ")}</div>` : ""; })()}
      </div>`).join("")}</div>` : emptyBox("No contacts yet."));
  },

  docs() {
    const ns = [...names(), "Both"];
    const warnDate = addDays(TRIP_END, 182);
    return head("Documents & entry", "Passports, ETA visa, insurance, health. Ticks turn green when ready.", `<button class="btn primary" data-act="add" data-col="docs">+ Document</button>`) +
      (S.docs.length ? ns.map((n) => { const list = S.docs.filter((d) => (d.person || "Both") === n).sort((a, b) => DOC_TYPES.indexOf(a.docType) - DOC_TYPES.indexOf(b.docType)); if (!list.length) return "";
        return `<div class="section-title"><h3>${esc(n)}</h3><span class="small muted">${list.filter((d) => d.status === "ready").length}/${list.length} ready</span></div><div class="row-list">${list.map((d) => {
          const lowValidity = d.docType === "Passport" && d.expiry && d.expiry < warnDate;
          return `<div class="row" data-act="edit" data-col="docs" data-id="${d.id}" style="cursor:pointer"><div class="main-col"><div class="title">${esc(d.docType)}${d.title ? ` · ${esc(d.title)}` : ""}</div><div class="meta">${d.expiry ? `<span>Expires ${fmtDay(d.expiry, { day: "numeric", month: "short", year: "numeric" })}</span>` : ""}${d.ref ? `<span>Ref ${esc(d.ref)}</span>` : ""}${d.notes ? `<span>${esc(d.notes)}</span>` : ""}</div></div>
          <div class="right">${lowValidity ? pill("warn", "Under 6 months validity after return – check entry rules") : ""}${pill(d.status, DOC_STATUS[d.status] || "")}</div></div>`; }).join("")}</div>`; }).join("")
        : emptyBox("Nothing tracked yet. Add documents one by one, or load a standard checklist for both of you.", `<button class="btn" data-act="starter" data-col="docs">Load checklist</button>`));
  },

  notes() {
    const open = S.notes.filter((n) => n.status !== "decided"), done = S.notes.filter((n) => n.status === "decided");
    const card = (n) => `<div class="row" data-act="edit" data-col="notes" data-id="${n.id}" style="cursor:pointer"><div class="main-col"><div class="title">${esc(n.title)}</div>${n.details ? `<div class="small" style="margin-top:.2rem;white-space:pre-wrap">${esc(n.details)}</div>` : ""}${n.decision ? `<div class="small" style="margin-top:.4rem"><b>Decision:</b> ${esc(n.decision)}</div>` : ""}<div class="meta"><span>Raised by ${esc(n.createdBy || "?")}</span></div></div><div class="right">${pill(n.status === "decided" ? "decided" : "open", n.status === "decided" ? "Decided" : "Open")}</div></div>`;
    return head("To discuss", "Things to decide together.", `<button class="btn primary" data-act="add" data-col="notes">+ Topic</button>`) +
      `<div class="row-list">${open.map(card).join("") || emptyBox("No open topics.")}</div>
      ${done.length ? `<div class="section-title"><h3>Decided</h3></div><div class="row-list">${done.map(card).join("")}</div>` : ""}`;
  },
};

function entryHtml(i) {
  const t = TYPES[i.type] || TYPES.other;
  const contact = i.contactId && S.contacts.find((c) => c.id === i.contactId);
  return `<div class="entry" data-act="edit" data-col="items" data-id="${i.id}">
    <span class="time">${esc(i.time || "")}</span><span class="type-ico t-${i.type || "other"}">${t.ico}</span>
    <div class="main-col" style="flex:1;min-width:0"><div style="font-weight:600">${esc(i.title)}</div>
      <div class="meta small muted" style="display:flex;flex-wrap:wrap;gap:.2rem .7rem">${i.place ? `<span>📍 ${esc(i.place)}</span>` : ""}${i.type === "accommodation" && i.nights ? `<span>${i.nights} night${i.nights > 1 ? "s" : ""}</span>` : ""}${contact ? `<span>📇 ${esc(contact.name)}</span>` : ""}${i.notes ? `<span>${esc(i.notes)}</span>` : ""}</div></div>
    <div style="display:grid;gap:.25rem;justify-items:end">${i.status ? pill(i.status, ITEM_STATUS[i.status]) : ""}${i.cost ? `<span class="small"><b>${money(i.cost, i.cur)}</b></span>` : ""}</div></div>`;
}

/* ───────────── Budget roll-up ───────────── */
function budgetTotals() {
  const byCat = {}, byDay = {};
  let total = 0, committed = 0, paid = 0;
  const add = (cat, eurAmt, status, spread) => {
    if (!eurAmt) return;
    const x = (byCat[cat] ||= { est: 0, booked: 0, paid: 0 });
    const isPaid = PAID.has(status), isCom = COMMITTED.has(status);
    if (isPaid) x.paid += eurAmt; else if (isCom) x.booked += eurAmt; else x.est += eurAmt;
    total += eurAmt; if (isCom) committed += eurAmt; if (isPaid) paid += eurAmt;
    (spread || []).forEach(([d, v]) => { const y = (byDay[d] ||= { c: 0, e: 0 }); if (isCom) y.c += v; else y.e += v; });
  };
  const fc = S.meta?.flightCost;
  if (fc?.amount) add("Flights", toEUR(fc.amount, fc.cur), fc.status || "paid");
  S.items.forEach((i) => {
    const v = toEUR(i.cost, i.cur); if (!v) return;
    const n = i.type === "accommodation" ? Math.max(1, Number(i.nights) || 1) : 1;
    const spread = i.date ? Array.from({ length: n }, (_, k) => [addDays(i.date, k), v / n]) : [];
    add(TYPE_TO_CAT[i.type] || "Other", v, i.status, spread);
  });
  S.budget.forEach((l) => add(l.category || "Other", toEUR(l.cost, l.cur), l.status, l.date ? [[l.date, toEUR(l.cost, l.cur)]] : []));
  return { byCat, byDay, total, committed, paid };
}

/* ───────────── Map ───────────── */
let map, layer;
function renderMap() {
  const days = tripDays();
  $("#mapControls").innerHTML = `<div style="display:flex;justify-content:space-between;gap:1rem;align-items:center;flex-wrap:wrap"><h2>Itinerary map</h2>
    <label class="checkbox-label small"><input type="checkbox" data-act="map-ideas" ${S.mapIdeas ? "checked" : ""}/> Show unscheduled ideas</label></div>
    <div class="chips"><button class="chip ${S.mapDay === "all" ? "active" : ""}" data-act="map-day" data-v="all">Whole trip</button>${days.map((d) => `<button class="chip ${S.mapDay === d ? "active" : ""}" data-act="map-day" data-v="${d}">${fmtDay(d, { weekday: "short", day: "numeric" })}</button>`).join("")}</div>
    <div class="legend"><span><i style="background:var(--teal)"></i>Location</span><span><i style="background:var(--violet)"></i>Stay</span><span><i style="background:var(--coral)"></i>Activity</span><span><i style="background:var(--blue)"></i>Travel</span><span><i style="background:var(--gold)"></i>Food</span><span><i style="background:#9aa5a2"></i>Idea</span><span class="muted">Numbers follow the order of the trip. Entries need a map location (use “Find” when editing).</span></div>`;
  if (!window.L) { $("#map").innerHTML = `<div class="empty" style="margin:1rem">Map library didn't load. Check your connection.</div>`; return; }
  if (!map) {
    map = L.map("map", { zoomControl: true }).setView([7.6, 80.7], 7);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
    layer = L.layerGroup().addTo(map);
    // Leaflet stops clicks inside popups from bubbling, so wire the Edit button directly
    map.on("popupopen", (ev) => { const b = ev.popup.getElement()?.querySelector("[data-act=edit]"); if (b) b.onclick = () => openForm(b.dataset.col, b.dataset.id); });
  }
  setTimeout(() => map.invalidateSize(), 50);
  layer.clearLayers();
  let pts = S.items.filter((i) => i.lat && i.lng).sort(byDateTime);
  const numbered = pts.map((p, k) => ({ ...p, n: k + 1 }));
  const shown = S.mapDay === "all" ? numbered : numbered.filter((p) => p.date === S.mapDay || (p.type === "accommodation" && p.date < S.mapDay && S.mapDay < addDays(p.date, Number(p.nights) || 1)));
  const popup = (p, idea) => `<b>${esc(p.title)}</b><br>${idea ? "Idea" : `${fmtDay(p.date)}${p.time ? " · " + esc(p.time) : ""}`}<br>${esc(TYPES[p.type]?.label || "")}${p.status ? " · " + esc(ITEM_STATUS[p.status] || "") : ""}${p.cost ? "<br>" + money(p.cost, p.cur) : ""}<br><button class="btn small" style="margin-top:.4rem" data-act="edit" data-col="${idea ? "ideas" : "items"}" data-id="${p.id}">Edit</button>`;
  const ll = [];
  shown.forEach((p) => {
    const icon = L.divIcon({ className: "", html: `<div class="num-marker ${p.type}">${p.n}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    L.marker([p.lat, p.lng], { icon }).bindPopup(popup(p)).addTo(layer); ll.push([p.lat, p.lng]);
  });
  if (ll.length > 1) L.polyline(ll, { color: "#17675d", weight: 3, opacity: .7, dashArray: "6 6" }).addTo(layer);
  if (S.mapIdeas) S.ideas.filter((i) => !i.scheduledId && i.lat && i.lng).forEach((p) => {
    const icon = L.divIcon({ className: "", html: `<div class="num-marker idea">💡</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    L.marker([p.lat, p.lng], { icon }).bindPopup(popup(p, true)).addTo(layer); ll.push([p.lat, p.lng]);
  });
  if (ll.length) map.fitBounds(ll, { padding: [40, 40], maxZoom: 12 }); else map.setView([7.6, 80.7], 7);
}

/* ───────────── Forms ───────────── */
const opt = (o) => Object.entries(o).map(([v, l]) => ({ v, l }));
const arr = (a) => a.map((x) => ({ v: x, l: x }));
const SCHEMA = {
  items: () => [
    { k: "type", l: "Type", t: "select", o: Object.entries(TYPES).map(([v, x]) => ({ v, l: `${x.ico} ${x.label}` })), req: 1 },
    { k: "status", l: "Status", t: "select", o: opt(ITEM_STATUS) },
    { k: "title", l: "Title", t: "text", full: 1, req: 1, ph: "e.g. Rafting on the Kelani river" },
    { k: "date", l: "Date", t: "date", req: 1, min: TRIP_START, max: TRIP_END },
    { k: "time", l: "Time", t: "time" },
    { k: "nights", l: "Nights (stays only)", t: "number" },
    { k: "cost", l: "Cost, total for both", t: "money" },
    { k: "place", l: "Place (for the map)", t: "place", full: 1 },
    { k: "contactId", l: "Contact / provider", t: "select", o: [{ v: "", l: "—" }, ...S.contacts.map((c) => ({ v: c.id, l: c.name + (c.company ? ` (${c.company})` : "") }))] },
    { k: "link", l: "Link (booking, website)", t: "url" },
    { k: "notes", l: "Notes", t: "textarea", full: 1 },
  ],
  flights: () => [
    { k: "dir", l: "Direction", t: "select", o: arr(["Outbound", "Return"]) },
    { k: "flightNo", l: "Flight no.", t: "text", req: 1 },
    { k: "from", l: "From (code)", t: "text" }, { k: "to", l: "To (code)", t: "text" },
    { k: "fromName", l: "From airport", t: "text" }, { k: "toName", l: "To airport", t: "text" },
    { k: "depDate", l: "Departure date", t: "date" }, { k: "depTime", l: "Departure time", t: "time" },
    { k: "arrDate", l: "Arrival date", t: "date" }, { k: "arrTime", l: "Arrival time", t: "time" },
    { k: "airline", l: "Airline", t: "text" }, { k: "aircraft", l: "Aircraft", t: "text" },
    { k: "cabin", l: "Cabin", t: "text" }, { k: "seats", l: "Seats", t: "text" },
    { k: "duration", l: "Duration", t: "text" }, { k: "status", l: "Status", t: "text" },
    { k: "notes", l: "Notes", t: "textarea", full: 1 },
  ],
  budget: () => [
    { k: "title", l: "Description", t: "text", full: 1, req: 1, ph: "e.g. Food & drinks, ~€60/day" },
    { k: "category", l: "Category", t: "select", o: arr(BUDGET_CATS) },
    { k: "status", l: "Status", t: "select", o: opt(BUDGET_STATUS) },
    { k: "cost", l: "Amount", t: "money", req: 1 },
    { k: "date", l: "Date (optional)", t: "date" },
    { k: "notes", l: "Notes", t: "textarea", full: 1 },
  ],
  packing: () => [
    { k: "name", l: "Item", t: "text", full: 1, req: 1 },
    { k: "category", l: "Category", t: "select", o: arr(PACK_CATS) },
    { k: "owner", l: "Whose", t: "select", o: arr([...names(), "Shared"]) },
    { k: "qty", l: "Quantity", t: "number" },
    { k: "packed", l: "Packed", t: "checkbox" },
  ],
  contacts: () => [
    { k: "name", l: "Name", t: "text", req: 1 }, { k: "company", l: "Company", t: "text" },
    { k: "category", l: "Category", t: "select", o: arr(CONTACT_CATS) },
    { k: "phone", l: "Phone (with country code)", t: "text", ph: "+94 …" },
    { k: "whatsapp", l: "On WhatsApp", t: "checkbox" },
    { k: "email", l: "Email", t: "email" }, { k: "website", l: "Website", t: "url" },
    { k: "notes", l: "Notes", t: "textarea", full: 1 },
  ],
  prep: () => [
    { k: "title", l: "Task", t: "text", full: 1, req: 1 },
    { k: "due", l: "Due date", t: "date" },
    { k: "status", l: "Status", t: "select", o: opt(PREP_STATUS) },
    { k: "category", l: "Category", t: "select", o: arr(PREP_CATS) },
    { k: "owner", l: "Who", t: "select", o: arr(["", ...names(), "Both"]) },
    { k: "link", l: "Link", t: "url", full: 1 },
    { k: "notes", l: "Notes", t: "textarea", full: 1 },
  ],
  ideas: () => [
    { k: "title", l: "Idea", t: "text", full: 1, req: 1 },
    { k: "type", l: "Type", t: "select", o: Object.entries(TYPES).map(([v, x]) => ({ v, l: `${x.ico} ${x.label}` })) },
    { k: "duration", l: "Duration", t: "text", ph: "half day, 2 nights…" },
    { k: "cost", l: "Estimated cost (both)", t: "money" },
    { k: "place", l: "Place", t: "place", full: 1 },
    { k: "link", l: "Link", t: "url", full: 1 },
    { k: "notes", l: "Why / notes", t: "textarea", full: 1 },
  ],
  docs: () => [
    { k: "person", l: "Person", t: "select", o: arr([...names(), "Both"]) },
    { k: "docType", l: "Document", t: "select", o: arr(DOC_TYPES) },
    { k: "title", l: "Label (optional)", t: "text" },
    { k: "status", l: "Status", t: "select", o: opt(DOC_STATUS) },
    { k: "expiry", l: "Expiry date", t: "date" },
    { k: "ref", l: "Reference / policy no.", t: "text" },
    { k: "notes", l: "Notes", t: "textarea", full: 1 },
  ],
  notes: () => [
    { k: "title", l: "Topic", t: "text", full: 1, req: 1 },
    { k: "details", l: "Details / options", t: "textarea", full: 1 },
    { k: "status", l: "Status", t: "select", o: [{ v: "open", l: "Open" }, { v: "decided", l: "Decided" }] },
    { k: "decision", l: "Decision", t: "textarea", full: 1 },
  ],
};
const TITLES = { items: "calendar entry", flights: "flight", budget: "budget line", packing: "packing item", contacts: "contact", prep: "task", ideas: "idea", docs: "document", notes: "topic" };

let formCtx = null;
function openForm(col, id, preset = {}, after) {
  const existing = id ? S[col].find((x) => x.id === id) : null;
  const v = { ...preset, ...(existing || {}) };
  const fields = SCHEMA[col]();
  formCtx = { col, id, after, lat: v.lat ?? null, lng: v.lng ?? null };
  const fieldHtml = (f) => {
    const val = v[f.k] ?? "";
    const attrs = `name="${f.k}" ${f.req ? "required" : ""} ${f.ph ? `placeholder="${esc(f.ph)}"` : ""}`;
    let input;
    switch (f.t) {
      case "select": input = `<select ${attrs}>${f.o.map((o) => `<option value="${esc(o.v)}" ${String(val) === String(o.v) ? "selected" : ""}>${esc(o.l || "—")}</option>`).join("")}</select>`; break;
      case "textarea": input = `<textarea ${attrs}>${esc(val)}</textarea>`; break;
      case "checkbox": return `<label class="checkbox-label ${f.full ? "full" : ""}"><input type="checkbox" name="${f.k}" ${val ? "checked" : ""}/> ${f.l}</label>`;
      case "money": input = `<div class="money"><input type="number" step="0.01" min="0" ${attrs} value="${esc(val)}"/><select name="cur">${["EUR", "USD"].map((c) => `<option ${(v.cur || "EUR") === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>`; break;
      case "place": input = `<div class="place-row"><input type="text" ${attrs} value="${esc(val)}" placeholder="e.g. Hiriketiya beach"/><button type="button" class="btn" data-act="geo">Find</button></div><div class="coords" id="coords">${v.lat ? `📍 ${(+v.lat).toFixed(4)}, ${(+v.lng).toFixed(4)} <button type="button" class="btn link small" data-act="geo-clear">remove pin</button>` : "No map pin yet – press Find."}</div><div class="place-results" id="placeResults"></div>`; break;
      default: input = `<input type="${f.t}" ${attrs} value="${esc(val)}" ${f.min ? `min="${f.min}"` : ""} ${f.max ? `max="${f.max}"` : ""}/>`;
    }
    return `<label class="${f.full ? "full" : ""}">${f.l}${input}</label>`;
  };
  $("#modalCard").innerHTML = `<form id="entityForm"><h3>${existing ? "Edit" : "New"} ${TITLES[col]}</h3><div class="form-grid">${fields.map(fieldHtml).join("")}</div>
    ${existing ? `<div class="audit">Last changed by ${esc(existing.updatedBy || existing.createdBy || "?")}${existing.updatedAt?.toDate ? " · " + existing.updatedAt.toDate().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : ""}</div>` : ""}
    <div class="modal-foot"><div>${existing ? `<button type="button" class="btn danger" data-act="delete">Delete</button>` : ""}</div><div class="right"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">Save</button></div></div></form>`;
  $("#modal").classList.remove("hidden");
  $("#entityForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target), data = {};
    fields.forEach((f) => {
      if (f.t === "checkbox") data[f.k] = fd.get(f.k) === "on";
      else if (f.t === "number") data[f.k] = fd.get(f.k) === "" ? null : Number(fd.get(f.k));
      else if (f.t === "money") { data[f.k] = fd.get(f.k) === "" ? null : Number(fd.get(f.k)); data.cur = fd.get("cur"); }
      else data[f.k] = (fd.get(f.k) ?? "").toString().trim();
      if (f.t === "place") { data.lat = formCtx.lat; data.lng = formCtx.lng; }
    });
    const { col: c, id: i, after: cb } = formCtx;
    closeModal();
    const newId = await save(c, i, data);
    toast("Saved");
    if (cb) cb(newId);
  });
}
function closeModal() { $("#modal").classList.add("hidden"); $("#modalCard").innerHTML = ""; }

async function geocode() {
  const q = $("#entityForm [name=place]").value.trim(), out = $("#placeResults");
  if (!q) return;
  out.innerHTML = `<span class="small muted">Searching…</span>`;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=lk&q=${encodeURIComponent(q)}`, { headers: { "Accept-Language": "en" } });
    const js = await r.json();
    out.innerHTML = js.length ? js.map((x) => `<button type="button" data-act="geo-pick" data-lat="${x.lat}" data-lng="${x.lon}" data-name="${esc(x.display_name.split(",").slice(0, 2).join(","))}">${esc(x.display_name)}</button>`).join("") : `<span class="small muted">No match in Sri Lanka. Try a simpler name (town or landmark).</span>`;
  } catch { out.innerHTML = `<span class="small muted">Search failed – check your connection.</span>`; }
}

function simpleDialog(title, inner, onSave) {
  $("#modalCard").innerHTML = `<form id="simpleForm"><h3>${title}</h3><div class="form-grid">${inner}</div><div class="modal-foot"><div></div><div class="right"><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary">Save</button></div></div></form>`;
  $("#modal").classList.remove("hidden");
  $("#simpleForm").addEventListener("submit", async (e) => { e.preventDefault(); const fd = new FormData(e.target); closeModal(); await onSave(fd); toast("Saved"); });
}

/* ───────────── Starter lists (only loaded on request) ───────────── */
const STARTERS = {
  packing: () => {
    const [a, b] = names();
    const L = [
      ["Passport", "Documents & money", "each"], ["Printed ETA approval", "Documents & money", "each"], ["Travel insurance details", "Documents & money", "Shared"],
      ["Bank cards + some EUR/USD cash", "Documents & money", "each"], ["Diving certification card / logbook", "Documents & money", "each"],
      ["Light summer clothes", "Clothes", "each"], ["Long, light clothes for temples (shoulders & knees covered)", "Clothes", "each"], ["Light rain jacket", "Clothes", "each"],
      ["Swimwear", "Beach", "each"], ["Rash guard", "Diving & activities", "each"], ["Sandals / flip-flops", "Clothes", "each"], ["Trainers for walks", "Clothes", "each"], ["Sun hat & sunglasses", "Beach", "each"],
      ["Reef-safe sunscreen", "Beach", "Shared"], ["Mosquito repellent", "Health & meds", "Shared"], ["First-aid kit & personal meds", "Health & meds", "Shared"], ["Rehydration salts", "Health & meds", "Shared"],
      ["Toiletries", "Toiletries", "each"], ["Mask (own fit)", "Diving & activities", "each"], ["Dry bag", "Diving & activities", "Shared"],
      ["Phone + charger", "Electronics", "each"], ["Power bank", "Electronics", "Shared"], ["Plug adapter (Sri Lanka uses types D, G and M)", "Electronics", "Shared"], ["Camera / GoPro", "Electronics", "Shared"],
    ];
    return L.flatMap(([name, category, who]) => (who === "each" ? [a, b] : [who]).map((owner) => ({ name, category, owner, qty: 1, packed: false })));
  },
  prep: () => [
    ["Agree overall budget and travel style", "2026-11-20", "Money"], ["Decide the route: central secondary spots + south-west/south coast", "2026-11-25", "Bookings"],
    ["Check passport validity for both", "2026-11-25", "Documents"], ["Buy travel insurance (covering diving & rafting)", "2026-11-30", "Documents"],
    ["Book accommodation for each base", "2026-12-05", "Bookings"], ["Book airport pick-up for 01:55 arrival on 13 Jan", "2026-12-05", "Bookings"],
    ["Decide transport between bases (private driver / train / tuk-tuk)", "2026-12-10", "Bookings"], ["Book dive centre & check dive season for chosen coast", "2026-12-10", "Bookings"],
    ["Book white-water rafting", "2026-12-15", "Bookings"], ["Travel clinic: vaccinations & malaria/dengue advice", "2026-12-10", "Health"],
    ["Apply for Sri Lanka ETA (both) and check current rules", "2026-12-20", "Documents"], ["Select seats on Qatar flights", "2026-12-20", "Bookings"],
    ["Notify banks / set up travel card", "2027-01-05", "Money"], ["Download offline maps & PickMe/Uber", "2027-01-08", "Other"],
    ["Get local SIM / eSIM plan", "2027-01-08", "Other"], ["Online check-in (opens 48h before)", "2027-01-10", "Bookings"],
    ["Finish packing", "2027-01-11", "Packing"], ["Arrange home: plants, mail, keys", "2027-01-11", "Home"],
    ["Book transport to CMB for the 03:25 flight on 26 Jan", "2027-01-20", "Bookings"],
  ].map(([title, due, category]) => ({ title, due, category, status: "todo", owner: "Both" })),
  docs: () => {
    const [a, b] = names();
    return [a, b].flatMap((person) => ["Passport", "Sri Lanka ETA / visa", "Vaccinations", "Diving certification"].map((docType) => ({ person, docType, status: "todo" })))
      .concat([{ person: "Both", docType: "Travel insurance", status: "todo" }, { person: "Both", docType: "Flight e-ticket", status: "ready", ref: S.meta?.pnr || "" }]);
  },
};
async function loadStarter(col) {
  const rows = STARTERS[col]();
  const batch = writeBatch(fs);
  rows.forEach((r) => batch.set(doc(colRef(col)), { ...r, createdBy: myName(), updatedBy: myName(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  await batch.commit(); toast(`Added ${rows.length} items`);
}

/* ───────────── Import / export ───────────── */
async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    let batch = writeBatch(fs), n = 0;
    const flush = async () => { await batch.commit(); batch = writeBatch(fs); n = 0; };
    if (data.meta) { batch.set(tripRef(), data.meta, { merge: true }); n++; }
    for (const c of COLS) for (const row of data[c] || []) {
      const { id, ...rest } = row;
      batch.set(id ? docRef(c, id) : doc(colRef(c)), { ...rest, updatedBy: myName(), updatedAt: serverTimestamp() }, { merge: true });
      if (++n >= 400) await flush();
    }
    await batch.commit(); toast("Imported");
  } catch (e) { console.error(e); toast("Import failed: " + e.message); }
}
function exportData() {
  const clean = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v && typeof v.toDate === "function" ? v.toDate().toISOString() : v)));
  const out = { exportedAt: new Date().toISOString(), meta: clean(S.meta) };
  COLS.forEach((c) => (out[c] = clean(S[c])));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
  a.download = `srilanka-trip-backup-${todayIso()}.json`; a.click();
}

/* ───────────── Events ───────────── */
document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-act]"); if (!a) return;
  const { act, col, id, v } = a.dataset;
  if (a.tagName === "INPUT" && a.type === "checkbox" && act !== "map-ideas") return;
  switch (act) {
    case "nav": S.view = v; localStorage.setItem("view", v); window.scrollTo(0, 0); render(); break;
    case "add": openForm(col, null, col === "items" ? { date: a.dataset.date || TRIP_START, status: "tentative", type: "activity", cur: "EUR" } : col === "prep" ? { status: "todo" } : col === "budget" ? { status: "estimate", category: "Other" } : col === "docs" ? { status: "todo" } : col === "notes" ? { status: "open" } : col === "flights" ? { airline: S.meta?.airline || "" } : {}); break;
    case "edit": e.stopPropagation(); openForm(col, id); break;
    case "close": closeModal(); break;
    case "delete": if (confirm("Delete this for both of you?")) { const { col: c, id: i } = formCtx; closeModal(); await remove(c, i); toast("Deleted"); } break;
    case "toggle": { const item = S[col].find((x) => x.id === id); await save(col, id, { [a.dataset.f]: !item[a.dataset.f] }); break; }
    case "prep-done": { const p = S.prep.find((x) => x.id === id); await save("prep", id, { status: p.status === "done" ? "todo" : "done" }); break; }
    case "like": { const i = S.ideas.find((x) => x.id === id); const likes = { ...(i.likes || {}) }; likes[a.dataset.n] ? delete likes[a.dataset.n] : (likes[a.dataset.n] = true); await save("ideas", id, { likes }); break; }
    case "schedule": { const i = S.ideas.find((x) => x.id === id);
      openForm("items", null, { title: i.title, type: i.type || "activity", place: i.place, lat: i.lat, lng: i.lng, cost: i.cost, cur: i.cur || "EUR", link: i.link, notes: i.notes, status: "tentative", date: TRIP_START }, (newId) => save("ideas", id, { scheduledId: newId })); break; }
    case "geo": geocode(); break;
    case "geo-pick": formCtx.lat = Number(a.dataset.lat); formCtx.lng = Number(a.dataset.lng); $("#coords").innerHTML = `📍 ${formCtx.lat.toFixed(4)}, ${formCtx.lng.toFixed(4)} ✓ <button type="button" class="btn link small" data-act="geo-clear">remove pin</button>`; $("#placeResults").innerHTML = ""; break;
    case "geo-clear": formCtx.lat = null; formCtx.lng = null; $("#coords").textContent = "No map pin."; break;
    case "map-day": S.mapDay = v; render(); break;
    case "map-ideas": S.mapIdeas = a.checked; render(); break;
    case "pack-filter": S.packFilter = v; render(); break;
    case "pack-owner": S.packOwner = v; render(); break;
    case "pack-reset": if (confirm("Untick every packed item?")) { const batch = writeBatch(fs); S.packing.filter((p) => p.packed).forEach((p) => batch.update(docRef("packing", p.id), { packed: false, updatedBy: myName() })); await batch.commit(); } break;
    case "starter": await loadStarter(col); break;
    case "signout": await signOut(auth); break;
    case "start-blank": await saveMeta({ names: ["Traveller 1", "Traveller 2"], usdEur: 0.87, createdAt: serverTimestamp() }); openSettings(); break;
    case "import": $("#importFile").click(); break;
    case "export": exportData(); break;
    case "import-settings": { const inp = document.createElement("input"); inp.type = "file"; inp.accept = "application/json"; inp.onchange = () => inp.files[0] && importData(inp.files[0]); inp.click(); break; }
    case "settings": openSettings(); break;
    case "budget-settings":
      simpleDialog("Budget settings", `<label>1 USD in EUR<input name="usdEur" type="number" step="0.0001" value="${rate()}"/></label><label>Total budget target (EUR)<input name="budgetTarget" type="number" step="1" value="${esc(S.meta.budgetTarget || "")}"/></label><p class="small muted full">Amounts entered in USD are converted at this rate everywhere.</p>`,
        (fd) => saveMeta({ usdEur: Number(fd.get("usdEur")) || 0.87, budgetTarget: fd.get("budgetTarget") ? Number(fd.get("budgetTarget")) : null })); break;
    case "flight-cost": { const fc = S.meta.flightCost || {};
      simpleDialog("Flight cost", `<label>Total for both<div class="money"><input name="amount" type="number" step="0.01" value="${esc(fc.amount ?? "")}"/><select name="cur">${["EUR", "USD"].map((c) => `<option ${(fc.cur || "EUR") === c ? "selected" : ""}>${c}</option>`).join("")}</select></div></label><label>Status<select name="status">${Object.entries(BUDGET_STATUS).map(([k, l]) => `<option value="${k}" ${(fc.status || "paid") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>`,
        (fd) => saveMeta({ flightCost: { amount: fd.get("amount") ? Number(fd.get("amount")) : null, cur: fd.get("cur"), status: fd.get("status") } })); break; }
  }
});
document.addEventListener("change", (e) => { if (e.target.id === "importFile" && e.target.files[0]) importData(e.target.files[0]); });
document.addEventListener("submit", async (e) => {
  if (e.target.dataset.form !== "pack") return;
  e.preventDefault();
  const fd = new FormData(e.target), name = fd.get("name").trim(); if (!name) return;
  S._lastPackCat = fd.get("category"); S._lastPackOwner = fd.get("owner");
  e.target.reset(); $("[data-keep=pack-name]").value = "";
  await save("packing", null, { name, category: S._lastPackCat, owner: S._lastPackOwner, qty: 1, packed: false });
});
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

function openSettings() {
  const ns = names();
  simpleDialog("Settings", `
    <label>Traveller 1 name<input name="n0" value="${esc(ns[0])}" required/></label>
    <label>Traveller 2 name<input name="n1" value="${esc(ns[1])}" required/></label>
    <label class="full">I am<select name="me">${ns.map((n) => `<option ${myName() === n ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
    <div class="full small muted">Your name is shown on changes you make. Backups: <button type="button" class="btn link small" data-act="export">export all data</button> · <button type="button" class="btn link small" data-act="import-settings">import a file</button></div>`,
    async (fd) => {
      const n0 = fd.get("n0").trim(), n1 = fd.get("n1").trim();
      const me = fd.get("me") === ns[0] ? n0 : fd.get("me") === ns[1] ? n1 : fd.get("me");
      await saveMeta({ names: [n0, n1], who: { ...(S.meta?.who || {}), [S.user.uid]: me } });
    });
}

boot();
