/* Wheel of Procrastination – Web (Listen + Arbeitszeit + Statistik) */
"use strict";
const APP_VERSION = 54; // muss zur sw.js-Cache-Version passen

// ---------- Setup check ----------
const configured = SUPABASE_URL.startsWith("https://") && !SUPABASE_ANON_KEY.startsWith("HIER");
const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];

if (!configured) {
  $("#setupScreen").classList.remove("hidden");
  throw new Error("Supabase nicht konfiguriert");
}

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- Theme (Auto / Hell / Dunkel) ----------
function applyTheme(){
  const pref = localStorage.getItem("wopTheme") || "auto"; // auto|light|dark
  const sysLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  const mode = pref==="auto" ? (sysLight ? "light" : "dark") : pref;
  document.documentElement.setAttribute("data-theme", mode);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", mode==="light" ? "#faf7f1" : "#0a0c13");
}
applyTheme();
if (window.matchMedia) window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", applyTheme);

// ---------- State ----------
const S = {
  user: null,
  tasks: [], locations: [], completions: [], workEntries: [], settings: {}, timeBlocks: [],
  planDate: null, chat: [], chatBusy: false,
  locFilter: "ALLE", tagFilter: null, tab: "home", search: "", collapsed: new Set(), showAllDue: false,
  expanded: new Set(),   // task ids with open subtasks
  tickTimer: null,
};

const LOC_PALETTE = ["#6c8cff","#3ddc84","#ff9f43","#b58cff","#38d4c3","#ffd54f","#f48fb1","#ff5d6c","#7986cb","#a1887f"];
const DEFAULT_LOCATIONS = ["Home", "Work", "Homeoffice", "To-Do"];
const WEEKDAYS_DE = ["So","Mo","Di","Mi","Do","Fr","Sa"]; // index = JS getDay()

// ---------- Helpers ----------
const pad = n => String(n).padStart(2,"0");
const fmtMin = m => {
  const sign = m < 0 ? "-" : ""; m = Math.abs(Math.round(m));
  const h = Math.floor(m/60), r = m%60;
  if (h>0 && r>0) return `${sign}${h}h ${r}m`;
  if (h>0) return `${sign}${h}h`;
  return `${sign}${r}m`;
};
const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDate = d => d.toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit",year:"numeric"});
const fmtDateShort = d => d.toLocaleDateString("de-DE",{weekday:"short",day:"2-digit",month:"2-digit"});
const isToday = d => d && sameDay(new Date(d), new Date());
const sameDay = (a,b) => a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
const startOfDay = d => { const x=new Date(d); x.setHours(0,0,0,0); return x; };
const dayKey = d => { const x=new Date(d); return `${x.getFullYear()}-${pad(x.getMonth()+1)}-${pad(x.getDate())}`; };
const daysBetween = (a,b) => Math.round((startOfDay(b)-startOfDay(a))/86400000); // round: DST-sicher
const esc = s => String(s??"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())+Math.random());

function toast(msg, isErr){
  let t = $("#toastEl");
  if(!t){ t=document.createElement("div"); t.id="toastEl";
    t.style.cssText="position:fixed;left:50%;transform:translateX(-50%);bottom:calc(96px + env(safe-area-inset-bottom,0px));background:var(--card2);color:var(--text);border:1px solid var(--line);padding:10px 18px;border-radius:12px;font-size:14px;z-index:200;transition:opacity .3s;max-width:85%;text-align:center;box-shadow:0 4px 18px rgba(0,0,0,.25);";
    document.body.appendChild(t); }
  t.textContent = msg;
  t.style.background = isErr ? "#8c2f39" : "var(--card2)";
  t.style.color = isErr ? "#fff" : "var(--text)";
  t.style.opacity = "1";
  clearTimeout(t._h); t._h = setTimeout(()=>t.style.opacity="0", 2600);
}

function setSync(state, text){
  const d=$("#syncDot"); d.className = "syncdot " + (state||"");
  $("#syncText").textContent = text;
}

// ---------- Auth ----------
async function initAuth(){
  const { data:{ session } } = await sb.auth.getSession();
  if (session){ S.user = session.user; startApp(); }
  else { $("#authScreen").classList.remove("hidden"); }

  sb.auth.onAuthStateChange((_e, sess)=>{
    if (sess && !S.user){ S.user = sess.user; location.reload(); }
    if (!sess && S.user){ location.reload(); }
  });

  $("#btnLogin").onclick = async ()=>{
    const email=$("#authEmail").value.trim(), password=$("#authPass").value;
    if(!email||!password) return authMsg("Bitte E-Mail und Passwort eingeben.", true);
    authMsg("Anmelden…");
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) authMsg(übersetzeAuthFehler(error.message), true);
  };
  $("#btnSignup").onclick = async ()=>{
    const email=$("#authEmail").value.trim(), password=$("#authPass").value;
    if(!email||!password) return authMsg("Bitte E-Mail und Passwort eingeben.", true);
    if(password.length<6) return authMsg("Passwort braucht mind. 6 Zeichen.", true);
    authMsg("Registrieren…");
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) return authMsg(übersetzeAuthFehler(error.message), true);
    if (data.session) return; // direkt eingeloggt
    authMsg("Fast fertig! Prüfe dein E-Mail-Postfach und bestätige die Adresse, dann hier anmelden.");
  };
}
function authMsg(m, err){ const el=$("#authMsg"); el.textContent=m; el.className="msg "+(err?"err":"ok"); }
function übersetzeAuthFehler(m){
  if(/invalid login credentials/i.test(m)) return "E-Mail oder Passwort falsch.";
  if(/already registered/i.test(m)) return "Diese E-Mail ist schon registriert – bitte anmelden.";
  if(/email not confirmed/i.test(m)) return "Bitte zuerst die E-Mail bestätigen (Link im Postfach).";
  return m;
}

// ---------- Data ----------
async function loadAll(){
  setSync("", "lade…");
  const since = new Date(Date.now() - 400*86400000).toISOString(); // Completions: letzte ~13 Monate
  const [t, l, c, w, st, tb] = await Promise.all([
    sb.from("tasks").select("*").order("sort_order").order("created_at"),
    sb.from("locations").select("*").order("sort_order").order("created_at"),
    sb.from("completions").select("*").gte("completed_at", since).order("completed_at",{ascending:false}),
    sb.from("work_entries").select("*").order("start_time",{ascending:false}).limit(2000),
    sb.from("settings").select("*"),
    sb.from("time_blocks").select("*").order("start_min").limit(2000),
  ]);
  const err = t.error||l.error||c.error||w.error||st.error;
  if (err){ setSync("err","Fehler: "+err.message); toast("Laden fehlgeschlagen: "+err.message, true); return; }
  S.tasks=t.data; S.locations=l.data; S.completions=c.data; S.workEntries=w.data;
  S.timeBlocks = tb.error ? [] : tb.data;  // Tabelle fehlt evtl. noch (SQL-Update)
  if (tb.error && !S._tbWarned){ S._tbWarned=true; toast("Kalender: bitte update-kalender.sql in Supabase ausführen", true); }
  S.settings = Object.fromEntries(st.data.map(r=>[r.key, r.value]));
  // Wetter-Ort einmalig in die Settings spiegeln (fürs Morgen-Briefing der Edge Function)
  try { const g = JSON.parse(localStorage.getItem("wopGeo")||"null");
    if (g && g.lat && !S.settings.geo) saveSetting("geo", g); } catch(e){}

  if (S.locations.length===0){
    const rows = DEFAULT_LOCATIONS.map((name,i)=>({name, sort_order:i, is_work_location:name==="Work"}));
    const { data } = await sb.from("locations").insert(rows).select();
    if (data) S.locations = data;
  }
  setSync("ok","synchron");
  renderAll();
}

async function saveSetting(key, value){
  S.settings[key]=value;
  await sb.from("settings").upsert({ user_id:S.user.id, key, value });
}
const getSetting = (k, def) => (k in S.settings) ? S.settings[k] : def;

// Realtime: bei jeder Änderung (auch von anderen Geräten) neu laden – gedrosselt
let reloadPending=false;
function scheduleReload(){
  if (reloadPending) return;
  reloadPending=true;
  setTimeout(async ()=>{ reloadPending=false; await loadAll(); }, 400);
}
let _rtChannel = null;
function initRealtime(){
  if (_rtChannel){ try{ sb.removeChannel(_rtChannel); }catch(e){} }
  _rtChannel = sb.channel("sync-all-"+Date.now())
    .on("postgres_changes", { event:"*", schema:"public" }, scheduleReload)
    .subscribe(status=>{
      if (status==="SUBSCRIBED") setSync("ok","synchron (live)");
      if (status==="CHANNEL_ERROR" || status==="TIMED_OUT" || status==="CLOSED"){
        setSync("", "synchron (auto-refresh)");
        setTimeout(initRealtime, 8000); // neu verbinden
      }
    });
}
document.addEventListener("visibilitychange", ()=>{ if(!document.hidden){ loadAll(); initRealtime(); } });
window.addEventListener("online", ()=>{ loadAll(); initRealtime(); });

// ---------- Task-Logik (aus der iOS-App übernommen) ----------
function effCompletedToday(t){
  if (!t.last_completed_count_reset || !isToday(t.last_completed_count_reset)) return 0;
  return t.completed_today_count;
}
function isCompletedToday(t){
  return t.last_done_at && isToday(t.last_done_at) && effCompletedToday(t) >= t.repeat_count;
}
function remainingRepeats(t){ return Math.max(0, t.repeat_count - effCompletedToday(t)); }
function recurrenceIntervalDays(t){
  if (t.recurrence==="weekly") return 7;
  if (t.recurrence==="customDays") return Math.max(1, t.custom_recurrence_days);
  return 1;
}
function overdueDays(t){
  const base = t.kind==="recurring" ? (t.last_done_at||t.created_at) : (t.last_done_at||t.created_at);
  return Math.max(0, daysBetween(new Date(base), new Date()));
}
function recurringIsDue(t){
  if (!t.last_done_at) return true;
  return daysBetween(new Date(t.last_done_at), new Date()) >= recurrenceIntervalDays(t);
}
function isActiveWeekday(t){
  const days = t.active_weekdays||[];
  if (!days.length) return true;
  return days.includes(new Date().getDay()+1); // 1=Sonntag … 7=Samstag
}
function startReached(t){ return !t.start_date || new Date(t.start_date) <= new Date(); }
function dependencySatisfied(t){
  if (!t.dependency_task_id) return true;
  const p = S.tasks.find(x=>x.id===t.dependency_task_id);
  return !p || isCompletedToday(p);
}
function inCooldown(t){
  if (!t.repeat_cooldown_minutes || remainingRepeats(t)===0) return false;
  if (!t.last_repeat_completed_at || !isToday(t.last_repeat_completed_at)) return false;
  const mins = (Date.now() - new Date(t.last_repeat_completed_at)) / 60000;
  return mins < t.repeat_cooldown_minutes;
}
function cooldownRemaining(t){
  const mins = (Date.now() - new Date(t.last_repeat_completed_at)) / 60000;
  return Math.max(0, Math.ceil(t.repeat_cooldown_minutes - mins));
}
function taskDueState(t){
  // liefert {due:boolean, label, cls} für Meta-Zeile
  if (t.kind==="oneOff"){
    if (t.due_date){
      const d = daysBetween(new Date(), new Date(t.due_date));
      if (d < 0) return {due:true, label:`⚠️ ${-d} Tag${d===-1?"":"e"} überfällig`, cls:"warn"};
      if (d === 0) return {due:true, label:"Heute fällig", cls:"amber"};
      if (d <= 3) return {due:false, label:`Fällig in ${d} Tag${d===1?"":"en"}`, cls:"amber"};
      return {due:false, label:`Fällig ${fmtDate(new Date(t.due_date))}`, cls:""};
    }
    return {due:false, label:null, cls:""};
  }
  // recurring
  if (isCompletedToday(t)) return {due:false, label:"Heute erledigt ✓", cls:""};
  if (recurringIsDue(t)){
    const od = t.last_done_at ? daysBetween(new Date(t.last_done_at), new Date()) - recurrenceIntervalDays(t) : 0;
    if (od > 0) return {due:true, label:`⚠️ ${od} Tag${od===1?"":"e"} drüber`, cls:"warn"};
    return {due:true, label:"Fällig", cls:"amber"};
  }
  const next = recurrenceIntervalDays(t) - daysBetween(new Date(t.last_done_at), new Date());
  return {due:false, label:`Wieder in ${next} Tag${next===1?"":"en"}`, cls:""};
}

// Eine Wiederholung erledigen
const _completing = new Set(); // verhindert Doppel-Tipp
async function completeTask(t){
  if (_completing.has(t.id)) return;
  _completing.add(t.id);
  try {
    const now = new Date().toISOString();
    let count = effCompletedToday(t) + 1;
    const upd = {
      completed_today_count: count,
      last_completed_count_reset: now,
      last_repeat_completed_at: now,
    };
    let fullyDone = count >= t.repeat_count;
    if (fullyDone){
      upd.last_done_at = now;
      if (t.kind==="oneOff") upd.is_archived = true;
    }
    // Optimistisch lokal – mit Snapshot für Rollback
    const snapshot = {};
    Object.keys(upd).forEach(k=>snapshot[k]=t[k]);
    Object.assign(t, upd);
    setTimeout(renderAll, 500); // Animation kurz zeigen, dann Liste aktualisieren
    const { error } = await sb.from("tasks").update(upd).eq("id", t.id);
    if (error){
      Object.assign(t, snapshot); renderAll();
      toast("Speichern fehlgeschlagen (offline?): "+error.message, true);
      return;
    }
    const spentMin = (arguments.length>1 && arguments[1]>0) ? Math.round(arguments[1]) : t.duration_minutes;
    const { error: cErr } = await sb.from("completions").insert({ task_id:t.id, title:t.title, minutes:spentMin });
    if (cErr) toast("Statistik nicht gespeichert: "+cErr.message, true);
    const xpGain = xpForCompletion(spentMin, t.is_priority);
    // Arbeitszeit automatisch buchen – aber nur, wenn die Stempeluhr NICHT läuft (sonst doppelt)
    const loc = S.locations.find(l => l.name.toLowerCase() === (t.location||"").toLowerCase());
    if (loc && loc.is_work_location && !runningEntry()){
      const end = new Date();
      const start = new Date(end - Math.max(1,t.duration_minutes)*60000);
      const accM = workAccounts().find(a=>a.toLowerCase() === (t.location||"").toLowerCase());
      const { error: wErr } = await sb.from("work_entries").insert({ start_time:start.toISOString(), end_time:end.toISOString(), notes:"Task: "+t.title,
        account: accM && accM!==workAccounts()[0] ? accM : null });
      toast(wErr ? "Arbeitszeit nicht gebucht: "+wErr.message : `✓ Erledigt · +${xpGain} XP – Arbeitszeit gebucht`, !!wErr);
    } else {
      toast(fullyDone ? `✓ Erledigt · +${xpGain} XP` : `✓ ${count}/${t.repeat_count} · +${xpGain} XP`);
    }
    loadAll();
  } finally { _completing.delete(t.id); }
}

async function uncompleteToday(t){
  const todayStart = startOfDay(new Date()).toISOString();
  // heutige Completions entfernen, dann last_done_at auf die letzte FRÜHERE Erledigung zurücksetzen
  await sb.from("completions").delete().eq("task_id", t.id).gte("completed_at", todayStart);
  const { data: prev } = await sb.from("completions").select("completed_at")
    .eq("task_id", t.id).lt("completed_at", todayStart)
    .order("completed_at",{ascending:false}).limit(1);
  const upd = { completed_today_count:0, last_repeat_completed_at:null,
    last_done_at: (prev && prev[0]) ? prev[0].completed_at : null,
    last_completed_count_reset:new Date().toISOString(), is_archived:false };
  Object.assign(t, upd); renderAll();
  const { error } = await sb.from("tasks").update(upd).eq("id", t.id);
  if (error) toast("Zurücknehmen fehlgeschlagen: "+error.message, true);
  loadAll();
}

async function toggleSubtask(t, subId){
  const subs = (t.subtasks||[]).map(s => s.id===subId ? {...s, done:!s.done} : s);
  t.subtasks = subs; renderAll();
  await sb.from("tasks").update({ subtasks: subs }).eq("id", t.id);
}

// ---------- Rendering: Aufgaben ----------
function visibleTasks(){
  const q = S.search.trim().toLowerCase();
  return S.tasks.filter(t => !t.is_archived)
    .filter(t => S.locFilter==="ALLE" ? !isRoutineTask(t) : (t.location||"") === S.locFilter)
    .filter(t => !S.tagFilter || (t.tags||[]).some(x => x.toLowerCase()===S.tagFilter.toLowerCase()))
    .filter(t => !q || t.title.toLowerCase().includes(q) || (t.notes||"").toLowerCase().includes(q)
      || (t.tags||[]).some(x=>x.toLowerCase().includes(q)) || (t.location||"").toLowerCase().includes(q));
}

function renderLocationChips(){
  const counts = {};
  S.tasks.filter(t=>!t.is_archived).forEach(t=>{ counts[t.location||""] = (counts[t.location||""]||0)+1; });
  const el = $("#locChips");
  const chips = [{name:"ALLE", label:"Alle", n:S.tasks.filter(t=>!t.is_archived && !isRoutineTask(t)).length}]
    .concat(S.locations.map(l=>({name:l.name, label:l.name, n:counts[l.name]||0})));
  el.innerHTML = chips.map(c =>
    `<button class="chip ${S.locFilter===c.name?"active":""}" data-loc="${esc(c.name)}">${esc(c.label)} <span class="n">${c.n}</span></button>`
  ).join("");
  $$(".chip", el).forEach(b => b.onclick = ()=>{ S.locFilter=b.dataset.loc; renderAll(); });
}

function renderTagChips(){
  const tags = new Set();
  S.tasks.filter(t=>!t.is_archived).forEach(t => (t.tags||[]).forEach(x=>tags.add(x)));
  const el = $("#tagChips");
  if (!tags.size){ el.innerHTML=""; return; }
  el.innerHTML = [...tags].sort().map(x =>
    `<button class="chip ${S.tagFilter===x?"active":""}" data-tag="${esc(x)}"># ${esc(x)}</button>`
  ).join("");
  $$(".chip", el).forEach(b => b.onclick = ()=>{
    S.tagFilter = (S.tagFilter===b.dataset.tag) ? null : b.dataset.tag; renderAll();
  });
}

function taskRow(t){
  const done = isCompletedToday(t);
  const cool = inCooldown(t);
  const subs = t.subtasks||[];
  const subsDone = subs.filter(s=>s.done).length;
  const ds = taskDueState(t);
  const eff = effCompletedToday(t);
  const meta = [];
  if (t.is_priority) meta.push(`<span class="star">★</span>`);
  meta.push(`⏳ ${fmtMin(t.duration_minutes)}`);
  if (S.locFilter==="ALLE" && t.location) meta.push(`📍 ${esc(t.location)}`);
  if (t.kind==="recurring"){
    const r = t.recurrence==="daily" ? "täglich" : t.recurrence==="weekly" ? "wöchentlich" : `alle ${t.custom_recurrence_days} Tage`;
    meta.push(`🔁 ${r}`);
  }
  if (t.repeat_count>1) meta.push(`<b>${eff}/${t.repeat_count}×</b>`);
  if (cool) meta.push(`<span class="amber">⏸ Pause noch ${fmtMin(cooldownRemaining(t))}</span>`);
  if (ds.label) meta.push(`<span class="${ds.cls}">${ds.label}</span>`);
  if (t.scheduled_date && !isToday(t.scheduled_date) && dayKey(new Date(t.scheduled_date))===dayKey(new Date(Date.now()+86400000))) meta.push(`<span class="amber">🌙 morgen geplant</span>`);
  if ((t.active_weekdays||[]).length) meta.push(`📅 ${(t.active_weekdays).map(d=>WEEKDAYS_DE[d-1]).join(",")}`);
  if (!dependencySatisfied(t)){
    const p = S.tasks.find(x=>x.id===t.dependency_task_id);
    meta.push(`<span class="amber">🔒 erst: ${esc(p?p.title:"?" )}</span>`);
  }
  if (!startReached(t)) meta.push(`<span class="amber">🕓 ab ${fmtDate(new Date(t.start_date))}</span>`);
  (t.tags||[]).forEach(x=>meta.push(`<span class="tagpill">${esc(x)}</span>`));
  if (t.notes) meta.push("📝");

  const chkClass = done ? "on" : (eff>0 ? "partial" : "");
  const chkContent = done ? "✓" : (t.repeat_count>1 && eff>0 ? eff : "✓");
  const blocked = cool || !dependencySatisfied(t) || !startReached(t);
  const expanded = S.expanded.has(t.id);

  let subHtml = "";
  if (subs.length){
    subHtml += `<div class="subprog"><div style="width:${subs.length? (100*subsDone/subs.length):0}%"></div></div>`;
    if (expanded){
      subHtml += `<div class="subtasklist">` + subs.map(s =>
        `<div class="subrow ${s.done?"on":""}" data-sub="${esc(s.id)}"><span class="box">✓</span><span>${esc(s.title)}</span></div>`
      ).join("") + `</div>`;
    }
  }

  return `<div class="task ${done?"done":""}" data-id="${t.id}">
    <button class="chk ${chkClass}" ${done||blocked?(done?"":"disabled"):""} title="Erledigt">${chkContent}</button>
    <div class="main" role="button" tabindex="0">
      <div class="title">${esc(t.title)}</div>
      <div class="meta">${meta.join(" ")}</div>
      ${subHtml}
    </div>
    ${(!done && !blocked) ? `<button class="playbtn" data-play="${t.id}" title="Fokus starten" aria-label="Fokus starten">▶</button>` : ""}
  </div>`;
}

function renderTasks(){
  renderLocationChips();
  renderTagChips();
  const el = $("#taskSections");
  const tasks = visibleTasks();
  if (!tasks.length){ el.innerHTML = `<div class="empty">Keine Aufgaben hier.<br>Tippe auf +, um eine anzulegen.</div>`; return; }

  const future = tasks.filter(t=>!startReached(t) && !isCompletedToday(t));
  const nowTasks = tasks.filter(t=>startReached(t) || isCompletedToday(t));
  const active = nowTasks.filter(t=>isActiveWeekday(t));
  const inactive = nowTasks.filter(t=>!isActiveWeekday(t));
  const dueNow = active.filter(t => !isCompletedToday(t) && (taskDueState(t).due));
  const openRest = active.filter(t => !isCompletedToday(t) && !taskDueState(t).due);
  const doneToday = active.filter(t => isCompletedToday(t));

  const prio = a => (b1,b2) => (b2.is_priority-b1.is_priority) || overdueDays(b2)-overdueDays(b1);
  dueNow.sort(prio());

  let html = "";
  const section = (title, arr) => arr.length ? `<h2>${title}</h2>` + arr.map(taskRow).join("") : "";
  // "Jetzt fällig" deckeln, damit es keine Wand wird
  const DUE_CAP = 7;
  if (!S.showAllDue && dueNow.length > DUE_CAP){
    html += section("🔥 Jetzt fällig", dueNow.slice(0, DUE_CAP));
    html += `<button class="btn sec" id="showAllDue" style="margin-bottom:6px">＋ ${dueNow.length-DUE_CAP} weitere fällige anzeigen</button>`;
  } else {
    html += section("🔥 Jetzt fällig", dueNow);
  }
  if (S.locFilter==="ALLE"){
    // Nach Ort/Kategorie gruppieren – auf breiten Screens als Spalten nebeneinander
    const palette = LOC_PALETTE;
    const locSection = (name, color, arr) => {
      if (!arr.length) return "";
      const collapsed = S.collapsed.has(name);
      return `<div class="taskcol"><div class="locsec" data-sec="${esc(name)}" role="button" tabindex="0">
        <span class="dot" style="background:${color}"></span>
        <h2>${esc(name)}</h2><span class="cnt">${arr.length}</span><span class="arr">${collapsed?"▸":"▾"}</span></div>`
        + (collapsed ? "" : arr.map(taskRow).join("")) + `</div>`;
    };
    let cols = "";
    S.locations.forEach((l,i)=>{
      cols += locSection(l.name, palette[i%palette.length], openRest.filter(t=>(t.location||"")===l.name));
    });
    const noLoc = openRest.filter(t=>!S.locations.some(l=>l.name===(t.location||"")));
    cols += locSection("Sonstiges", "#5c6579", noLoc);
    html += `<div class="taskcols">${cols}</div>`;
  } else {
    html += section("Offen", openRest);
  }
  html += section("Nicht heute", inactive);
  future.sort((a,b)=>new Date(a.start_date)-new Date(b.start_date));
  html += section("⏳ Später geplant", future);
  html += section("Heute erledigt", doneToday);
  const archN = S.tasks.filter(t=>t.is_archived).length;
  if (archN) html += `<div style="text-align:center;padding:14px 0"><a id="toArchive" style="color:var(--accent2);font-weight:700;font-size:13.5px;cursor:pointer">🗂 Archiv (${archN}) ›</a></div>`;
  el.innerHTML = html;
  const sad = $("#showAllDue"); if (sad) sad.onclick = ()=>{ S.showAllDue = true; renderTasks(); };
  const ta = $("#toArchive"); if (ta) ta.onclick = ()=>switchTab("archive");
  $$(".locsec[data-sec]", el).forEach(sec=>sec.onclick = ()=>{
    const n = sec.dataset.sec;
    S.collapsed.has(n) ? S.collapsed.delete(n) : S.collapsed.add(n);
    renderTasks();
  });

  // Events
  $$(".task", el).forEach(row => {
    const t = S.tasks.find(x=>x.id===row.dataset.id);
    $(".chk", row).onclick = (e)=>{ e.stopPropagation();
      if (isCompletedToday(t)) uncompleteToday(t);
      else { celebrate(e.currentTarget, xpForCompletion(t.duration_minutes, t.is_priority)); completeTask(t); }
    };
    const pb = $("[data-play]", row);
    if (pb) pb.onclick = (e)=>{ e.stopPropagation(); startFocusTask(t.id); };
    $(".main", row).onclick = (e)=>{
      if (e.target.closest(".subrow")){
        toggleSubtask(t, e.target.closest(".subrow").dataset.sub); return;
      }
      if ((t.subtasks||[]).length && !S.expanded.has(t.id)){
        S.expanded.add(t.id); renderTasks(); return;
      }
      openTaskForm(t);
    };
  });
}

// ---------- Archiv ----------
function renderArchive(){
  const el = $("#view-archive");
  const arch = S.tasks.filter(t=>t.is_archived).sort((a,b)=>new Date(b.last_done_at||b.created_at)-new Date(a.last_done_at||a.created_at));
  if (!arch.length){ el.innerHTML = `<div class="empty">Archiv ist leer.<br>Erledigte einmalige Aufgaben landen hier.</div>`; return; }
  el.innerHTML = arch.map(t=>`<div class="task done" data-id="${t.id}">
      <div class="main" role="button" tabindex="0"><div class="title">${esc(t.title)}</div>
      <div class="meta">✓ ${t.last_done_at?fmtDate(new Date(t.last_done_at)):""} ${t.location?("· 📍 "+esc(t.location)):""}</div></div>
      <button class="btn small sec" data-act="restore">↩︎</button>
      <button class="iconbtn" data-act="del">🗑</button>
    </div>`).join("");
  $$(".task", el).forEach(row=>{
    const t = S.tasks.find(x=>x.id===row.dataset.id);
    $("[data-act=restore]",row).onclick = async ()=>{
      await sb.from("tasks").update({is_archived:false,last_done_at:null,completed_today_count:0}).eq("id",t.id);
      toast("Wiederhergestellt"); loadAll();
    };
    armDelete($("[data-act=del]",row), async ()=>{
      const { error } = await sb.from("tasks").delete().eq("id",t.id);
      if (error) return toast("Löschen fehlgeschlagen: "+error.message, true);
      loadAll();
    });
  });
}


// confirm() ist in iOS-Homescreen-Apps unzuverlässig -> Löschen per Doppel-Tipp bestätigen
function armDelete(btn, fn){
  if (!btn) return;
  btn.onclick = async (e)=>{
    e.stopPropagation();
    if (btn.dataset.armed){ btn.disabled=true; await fn(); return; }
    btn.dataset.armed = "1";
    btn.dataset.old = btn.textContent;
    btn.textContent = "❗ Wirklich löschen? Nochmal tippen";
    setTimeout(()=>{ if (btn.isConnected && btn.dataset.armed){ delete btn.dataset.armed; btn.textContent = btn.dataset.old; } }, 3500);
  };
}

// ---------- Modal-Grundgerüst ----------
function openModal(html){
  const box = $("#modalBox");
  box.setAttribute("role","dialog"); box.setAttribute("aria-modal","true");
  box.innerHTML = html;
  $("#modalBg").classList.add("open");
}
document.addEventListener("keydown", e=>{
  if (e.key==="Escape" && $("#modalBg").classList.contains("open")) closeModal();
  // Enter/Leertaste auf role=button-Divs (Tastatur-Bedienung am Mac)
  if ((e.key==="Enter"||e.key===" ") && e.target.matches && e.target.matches('[role="button"]:not(button)')){
    e.preventDefault(); e.target.click();
  }
});
function closeModal(){ $("#modalBg").classList.remove("open"); }
$("#modalBg").addEventListener("click", e=>{ if(e.target.id==="modalBg") closeModal(); });

// ---------- Tabs & App-Start ----------
function switchTab(tab){
  S.tab = tab;
  $$(".tabbar button").forEach(b=>b.classList.toggle("active", b.dataset.tab===tab));
  ["home","tasks","plan","now","work","stats","archive"].forEach(v=>$("#view-"+v).classList.toggle("hidden", v!==tab));
  $("#pageTitle").textContent = {home:"Heute",tasks:"Aufgaben",plan:"Plan",now:"Now",work:"Arbeitszeit",stats:"Statistik",archive:"Archiv"}[tab];
  $("#fab").classList.toggle("hidden", tab==="stats" || tab==="archive");
  renderAll();
}

function renderAll(){
  if (S.tab==="home") renderHome();
  if (S.tab==="plan") renderPlan();
  if (S.tab==="now") renderNow();
  if (S.tab==="tasks") renderTasks();
  if (S.tab==="work") renderWork();
  if (S.tab==="stats") renderStats();
  if (S.tab==="archive") renderArchive();
}

function startApp(){
  $("#authScreen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $$(".tabbar button").forEach(b => b.onclick = ()=>switchTab(b.dataset.tab));
  const sIn = $("#searchTasks");
  if (sIn) sIn.oninput = ()=>{ S.search = sIn.value; renderTasks(); };
  $("#fab").onclick = ()=>{ if(S.tab==="work") openWorkEntryForm(null); else if(S.tab==="plan") openBlockForm(null); else openTaskForm(null); };
  $("#btnChat").onclick = ()=>{
    const p = $("#chatPanel");
    if (p){ p.classList.toggle("hidden"); if (!p.classList.contains("hidden")) renderChat(); }
    const i = $("#chatIn"); if (i) i.focus();
  };
  wireChatBar();
  $("#btnSettings").onclick = openSettings;
  initRealtime();
  loadAll().then(()=>{ if (getFocus()) showFocus(); migratePushKey(); });
  // Ticker für laufende Stempeluhr & Cooldowns
  S.tickTimer = setInterval(()=>{ if(S.tab==="work") renderWork(); if(S.tab==="home") renderHome(); }, 30000);
  setInterval(()=>{
    if (document.hidden) return;
    if ($("#modalBg").classList.contains("open")) return;
    const a = document.activeElement;
    if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return; // nicht beim Tippen
    loadAll();
  }, 60000);
  // Service Worker
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
}

initAuth();

// ============================================================
// Aufgaben-Formular (Neu / Bearbeiten)
// ============================================================
function openTaskForm(t){
  const isNew = !t;
  t = t || {};
  const subs = (t.subtasks||[]).map(s=>({...s}));
  const wk = new Set(t.active_weekdays||[]);
  const locOpts = S.locations.map(l=>`<option ${((t.location||S.locFilter!=="ALLE"&&S.locFilter)||"")===l.name?"selected":""}>${esc(l.name)}</option>`).join("");
  const others = S.tasks.filter(x=>!x.is_archived && x.id!==t.id);
  const depOpts = `<option value="">– keine –</option>` + others.map(x=>
    `<option value="${x.id}" ${t.dependency_task_id===x.id?"selected":""}>${esc(x.title)}</option>`).join("");

  const hasExtra = !isNew && ((t.repeat_count||1)>1 || t.repeat_cooldown_minutes>0 || t.due_date || t.start_date
    || t.dependency_task_id || (t.tags||[]).length || (t.subtasks||[]).length || (t.notes||"").length);
  const dtLocal = iso => { if(!iso) return ""; const d=new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const dLocal = iso => iso ? dayKey(new Date(iso)) : "";

  openModal(`
    <h3>${isNew?"Neue Aufgabe":"Aufgabe bearbeiten"}</h3>
    <label>Titel</label><input id="f_title" value="${esc(t.title||"")}" placeholder="Was ist zu tun?">
    <div class="mrow">
      <div><label>Dauer (Min.)</label><input id="f_dur" type="number" min="1" value="${t.duration_minutes||15}"></div>
      <div><label>Ort / Liste</label><select id="f_loc">${locOpts}</select></div>
    </div>
    <div class="switch"><label>⭐ Priorität</label><button class="toggle ${t.is_priority?"on":""}" id="f_prio"></button></div>
    <div class="mrow">
      <div><label>Art</label><select id="f_kind">
        <option value="oneOff" ${t.kind!=="recurring"?"selected":""}>Einmalig</option>
        <option value="recurring" ${t.kind==="recurring"?"selected":""}>Wiederkehrend</option></select></div>
      <div id="f_recwrap" class="${t.kind==="recurring"?"":"hidden"}"><label>Rhythmus</label><select id="f_rec">
        <option value="daily" ${t.recurrence==="daily"?"selected":""}>Täglich</option>
        <option value="weekly" ${t.recurrence==="weekly"?"selected":""}>Wöchentlich</option>
        <option value="customDays" ${t.recurrence==="customDays"?"selected":""}>Alle X Tage</option></select></div>
    </div>
    <div id="f_customwrap" class="${t.recurrence==="customDays"?"":"hidden"}">
      <label>Alle wie viele Tage?</label><input id="f_customdays" type="number" min="1" value="${t.custom_recurrence_days||2}">
    </div>
    <div id="f_wkwrap" class="${t.kind==="recurring"?"":"hidden"}">
      <label>Nur an bestimmten Wochentagen (leer = jeden Tag)</label>
      <div class="wkdays" id="f_wk">${[2,3,4,5,6,7,1].map(d=>
        `<button type="button" data-d="${d}" class="${wk.has(d)?"on":""}">${WEEKDAYS_DE[d-1]}</button>`).join("")}</div>
    </div>
    <details class="moreopts" ${hasExtra?"open":""}>
      <summary>Mehr Optionen</summary>
    <div class="mrow">
      <div><label>Wiederholungen pro Tag</label><input id="f_repeat" type="number" min="1" value="${t.repeat_count||1}"></div>
      <div><label>Pause dazwischen (Min., 0 = keine)</label><input id="f_cool" type="number" min="0" value="${t.repeat_cooldown_minutes||0}"></div>
    </div>
    <div class="mrow">
      <div><label>Fällig am (optional)</label><input id="f_due" type="date" value="${dLocal(t.due_date)}"></div>
      <div><label>Start ab (optional)</label><input id="f_start" type="datetime-local" value="${dtLocal(t.start_date)}"></div>
    </div>
    <label>Erst nach dieser Aufgabe (Abhängigkeit)</label><select id="f_dep">${depOpts}</select>
    <label>Tags (mit Komma trennen)</label><input id="f_tags" value="${esc((t.tags||[]).join(", "))}" placeholder="z.B. Haushalt, Wichtig">
    <label>Unteraufgaben</label>
    <div class="sublistedit" id="f_subs"></div>
    <div class="mrow"><input id="f_newsub" placeholder="Unteraufgabe hinzufügen…"><button class="btn small sec" id="f_addsub" style="width:auto">+</button></div>
    <label>Notizen</label><textarea id="f_notes" rows="3">${esc(t.notes||"")}</textarea>
    </details>
    <div style="height:18px"></div>
    ${isNew?"":`<button class="btn sec" id="f_frog" style="margin-bottom:8px">🐸 Heute als Frosch des Tages</button>`}
    <button class="btn" id="f_save">${isNew?"Aufgabe anlegen":"Speichern"}</button>
    ${isNew?"":`<div style="height:8px"></div><button class="btn danger" id="f_del">Löschen</button>`}
  `);

  const renderSubs = ()=>{
    $("#f_subs").innerHTML = subs.map((s,i)=>
      `<div class="row"><span style="flex:1;font-size:14px">${s.done?"✅":"◻️"} ${esc(s.title)}</span>
       <button class="iconbtn" data-i="${i}">🗑</button></div>`).join("") || `<div class="section-empty">Keine Unteraufgaben.</div>`;
    $$("#f_subs .iconbtn").forEach(b=>b.onclick=()=>{ subs.splice(+b.dataset.i,1); renderSubs(); });
  };
  renderSubs();
  $("#f_addsub").onclick = ()=>{ const v=$("#f_newsub").value.trim(); if(!v)return;
    subs.push({id:uid(), title:v, done:false}); $("#f_newsub").value=""; renderSubs(); };
  $("#f_newsub").addEventListener("keydown",e=>{ if(e.key==="Enter"){e.preventDefault();$("#f_addsub").click();} });

  $("#f_prio").onclick = e=>e.target.classList.toggle("on");
  $$("#f_wk button").forEach(b=>b.onclick=()=>b.classList.toggle("on"));
  const syncKind = ()=>{
    const rec = $("#f_kind").value==="recurring";
    $("#f_recwrap").classList.toggle("hidden",!rec);
    $("#f_wkwrap").classList.toggle("hidden",!rec);
    $("#f_customwrap").classList.toggle("hidden", !(rec && $("#f_rec").value==="customDays"));
  };
  $("#f_kind").onchange = syncKind; $("#f_rec").onchange = syncKind;

  const ffr = $("#f_frog");
  if (ffr) ffr.onclick = async ()=>{ await setTodayFrog(t.id); closeModal(); };
  $("#f_save").onclick = async ()=>{
    const title = $("#f_title").value.trim();
    if (!title) return toast("Bitte einen Titel eingeben.", true);
    const row = {
      title,
      duration_minutes: Math.max(1, +$("#f_dur").value||15),
      location: $("#f_loc").value,
      is_priority: $("#f_prio").classList.contains("on"),
      kind: $("#f_kind").value,
      recurrence: $("#f_rec").value,
      custom_recurrence_days: Math.max(1, +$("#f_customdays").value||2),
      active_weekdays: $("#f_kind").value==="recurring" ? $$("#f_wk button.on").map(b=>+b.dataset.d) : [],
      repeat_count: Math.max(1, +$("#f_repeat").value||1),
      repeat_cooldown_minutes: Math.max(0, +$("#f_cool").value||0),
      due_date: $("#f_due").value ? new Date($("#f_due").value+"T23:59:00").toISOString() : null,
      start_date: $("#f_start").value ? new Date($("#f_start").value).toISOString() : null,
      dependency_task_id: $("#f_dep").value || null,
      tags: $("#f_tags").value.split(",").map(x=>x.trim()).filter(Boolean),
      subtasks: subs,
      notes: $("#f_notes").value,
    };
    const q = isNew ? sb.from("tasks").insert(row) : sb.from("tasks").update(row).eq("id", t.id);
    const { error } = await q;
    if (error) return toast("Fehler: "+error.message, true);
    closeModal(); toast(isNew?"Aufgabe angelegt":"Gespeichert"); loadAll();
  };
  if (!isNew) armDelete($("#f_del"), async ()=>{
    const { error } = await sb.from("tasks").delete().eq("id", t.id);
    if (error) return toast("Löschen fehlgeschlagen: "+error.message, true);
    closeModal(); toast("Gelöscht"); loadAll();
  });
}

// ============================================================
// Arbeitszeit
// ============================================================
function runningEntry(){ return S.workEntries.find(w=>!w.end_time); }
// Aktuellen offenen Stempel-Eintrag IMMER frisch vom Server holen (andere Geräte!)
async function serverOpenEntry(){
  const { data, error } = await sb.from("work_entries").select("*")
    .is("end_time", null).order("start_time",{ascending:false}).limit(1);
  if (error){ toast("Verbindung fehlgeschlagen: "+error.message, true); return undefined; }
  return (data && data[0]) || null;
}

// ---- Zeitkonten: Hauptjob (Soll/Saldo/Urlaub) + Nebenkonten (nur Stunden, eigenes Konto) ----
function workAccounts(){
  const main = getSetting("workMainAccount", "Fleischmann Vermessung");
  const extra = getSetting("workAccounts", ["Mozarteumorchester","Hipper Machines"]);
  return [main, ...(Array.isArray(extra)?extra:[]).filter(x=>x && x!==main)];
}
const entryAcc = w => w.account || workAccounts()[0];

// ---- Abwesenheiten (Urlaub/Krank/Feiertag): zählen als Soll-Gutschrift ----
function getAbsences(){ const a = getSetting("absences", []); return Array.isArray(a) ? a : []; }
async function saveAbsences(list){ await saveSetting("absences", list); }
function absDayMinutesDefault(){ return Math.round(getSetting("weeklyTargetMinutes",2310)/5); }
const ABS_LABEL = { urlaub:"🏖 Urlaub", krank:"🤒 Krank", feiertag:"🎉 Feiertag" };

function workedMinutes(w, ref){
  ref = ref || new Date();
  const end = w.end_time ? new Date(w.end_time) : ref;
  const gross = Math.max(0, (end - new Date(w.start_time))/60000);
  let brk = w.break_minutes||0;
  if (w.break_started_at) brk += Math.max(0,(ref - new Date(w.break_started_at))/60000);
  return Math.max(0, Math.round(gross - brk));
}
function periodKeyOf(d, mode){
  d = new Date(d);
  if (mode==="week"){
    const x = startOfDay(d); const day=(x.getDay()+6)%7; x.setDate(x.getDate()-day); // Montag
    return dayKey(x);
  }
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}`;
}
function renderWork(){
  const el = $("#view-work");
  const mode = getSetting("workTargetMode","month"); // 'week'|'month'
  const weeklyTarget = getSetting("weeklyTargetMinutes", 2310);
  const monthlyTarget = getSetting("monthlyTargetMinutes", 4800);
  const target = mode==="week" ? weeklyTarget : monthlyTarget;
  const now = new Date();
  const curKey = periodKeyOf(now, mode);

  const accs = workAccounts();
  if (!S.workAccount || !accs.includes(S.workAccount)) S.workAccount = accs[0];
  const acc = S.workAccount, isMain = acc === accs[0];
  const mine = S.workEntries.filter(w => entryAcc(w) === acc);

  const run = runningEntry(); // global – es läuft immer nur eine Uhr
  const closed = mine.filter(w=>w.end_time);
  const thisPeriod = mine.filter(w => periodKeyOf(w.start_time, mode)===curKey);
  const workedThis = thisPeriod.reduce((a,w)=>a+workedMinutes(w), 0);

  // Abwesenheiten: nur beim Hauptjob (zählen als Gutschrift aufs Soll)
  const absAll = isMain ? getAbsences() : [];
  const absThisList = absAll.filter(a=>periodKeyOf(a.date+"T12:00:00", mode)===curKey)
    .sort((a,b)=> a.date<b.date ? 1 : -1);
  const absCreditThis = absThisList.reduce((a,x)=>a+(x.min||0), 0);
  const totalThis = workedThis + absCreditThis;

  // Überstunden-Saldo: abgeschlossene Perioden (ohne aktuelle), inkl. Abwesenheits-Gutschriften
  const byPeriod = {};
  closed.forEach(w=>{ const k=periodKeyOf(w.start_time, mode); if(k!==curKey) byPeriod[k]=(byPeriod[k]||0)+workedMinutes(w); });
  absAll.forEach(a=>{ const k=periodKeyOf(a.date+"T12:00:00", mode); if(k!==curKey) byPeriod[k]=(byPeriod[k]||0)+(a.min||0); });
  const balance = Object.values(byPeriod).reduce((a,v)=>a+(v-target), 0);

  // Konto-Umschalter
  const accSeg = accs.length>1 ? `<div class="seg" id="w_accseg" style="margin-bottom:10px">${accs.map(a=>
    `<button data-a="${esc(a)}" class="${a===acc?"active":""}" style="font-size:11.5px;padding:8px 2px">${esc(a.length>16?a.slice(0,15)+"…":a)}</button>`).join("")}</div>` : "";

  // Stempeluhr-Anzeige (die laufende Uhr zeigt ihr Konto)
  let clockHtml;
  if (run){
    const mins = workedMinutes(run);
    const onBreak = !!run.break_started_at;
    clockHtml = `<div class="card clockcard">
      <div class="big">${fmtMin(mins)}</div>
      <div class="state">${onBreak?"⏸ Pause läuft":"🟢 Eingestempelt"} seit ${fmtTime(new Date(run.start_time))} · <b>${esc(entryAcc(run))}</b>${run.break_minutes?` · Pausen: ${fmtMin(run.break_minutes)}`:""}</div>
      <div class="clockbtns">
        <button class="btn sec" id="w_break">${onBreak?"▶️ Pause beenden":"⏸ Pause"}</button>
        <button class="btn" id="w_out" style="background:var(--red)">⏹ Ausstempeln</button>
      </div></div>`;
  } else {
    clockHtml = `<div class="card clockcard">
      <div class="big">–</div><div class="state">Nicht eingestempelt</div>
      <div class="clockbtns"><button class="btn" id="w_in" style="background:var(--green);color:#08351d">▶️ Einstempeln · ${esc(acc.length>20?acc.slice(0,19)+"…":acc)}</button></div></div>`;
  }

  // Zielfortschritt (inkl. Abwesenheits-Gutschrift)
  const pct = target>0 ? Math.min(100, 100*totalThis/target) : 0;
  const over = totalThis>=target;
  const periodLabel = mode==="week" ? "Diese Woche" : "Dieser Monat";
  const targetHtml = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <b>${periodLabel}</b>
      <span style="font-variant-numeric:tabular-nums">${fmtMin(totalThis)} / ${fmtMin(target)}${absCreditThis?` <span style="color:var(--dim);font-size:11.5px">(inkl. 🏖 ${fmtMin(absCreditThis)})</span>`:""}</span></div>
    <div class="progressbar"><div class="${over?"over":""}" style="width:${pct}%"></div></div>
    <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--dim)">
      <span>${over?`🎉 +${fmtMin(totalThis-target)} über Soll`:`Noch ${fmtMin(target-totalThis)}`}</span>
      <span>Saldo: <b style="color:${balance>=0?"var(--green)":"var(--red)"}">${balance>=0?"+":""}${fmtMin(balance)}</b></span>
    </div></div>`;

  // Nebenkonto: kein Soll – nur Stunden dieser Periode + gesamt
  const grandTotal = closed.reduce((a,w)=>a+workedMinutes(w),0) + (run && entryAcc(run)===acc ? workedMinutes(run) : 0);
  const sideHtml = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <b>${periodLabel}</b>
      <b style="color:var(--accent2);font-variant-numeric:tabular-nums;font-size:17px">${fmtMin(workedThis)}</b></div>
    <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--dim);margin-top:4px">
      <span>Eigenes Zeitkonto · zählt nicht zum Soll</span>
      <span>Gesamt: <b style="color:var(--text)">${fmtMin(grandTotal)}</b></span></div></div>`;
  const summaryHtml = isMain ? targetHtml : sideHtml;

  // Abwesenheiten-Karte: eingeklappt, nur Kopf mit Summe (Details auf Tipp)
  const absRow = a => `<div class="wt-entry" style="cursor:default">
    <div><div class="t">${ABS_LABEL[a.kind]||"🏖 Urlaub"} · ${fmtDateShort(new Date(a.date+"T12:00:00"))}</div></div>
    <div style="display:flex;align-items:center;gap:6px"><span class="dur" style="color:var(--green)">+${fmtMin(a.min||0)}</span>
    <button class="abs-del" data-id="${a.id}" style="background:none;border:none;color:var(--dim);font-size:15px;cursor:pointer;padding:2px 6px" aria-label="Abwesenheit löschen">✕</button></div></div>`;
  const absCardHtml = (isMain && absThisList.length) ? `<div class="card" style="${S.absOpen?"":"padding:11px 14px;"}">
    <div id="absHead" role="button" tabindex="0" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;gap:8px">
      <b style="font-size:13.5px">${S.absOpen?"▾":"▸"} 🏖 Abwesenheiten · ${periodLabel} <span style="color:var(--dim2)">${absThisList.length} Tag${absThisList.length>1?"e":""}</span></b>
      <b style="font-size:13.5px;color:var(--green)">+${fmtMin(absCreditThis)}</b></div>
    ${S.absOpen?`<div style="margin-top:6px;border-top:1px solid var(--line);padding-top:2px">${absThisList.map(absRow).join("")}</div>`:""}</div>` : "";

  // Einträge dieser Periode, gruppiert nach Tag
  const groups = {};
  thisPeriod.forEach(w=>{ const k=dayKey(new Date(w.start_time)); (groups[k]=groups[k]||[]).push(w); });
  const dayKeys = Object.keys(groups).sort().reverse();
  let listHtml = `<h2>Einträge · ${periodLabel}</h2>`;
  if (!dayKeys.length) listHtml += `<div class="section-empty">Noch keine Einträge. Stemple ein oder lege mit + einen manuellen Eintrag an.</div>`;
  dayKeys.forEach(k=>{
    const arr = groups[k].sort((a,b)=>new Date(b.start_time)-new Date(a.start_time));
    const sum = arr.reduce((a,w)=>a+workedMinutes(w),0);
    listHtml += `<div class="card"><div style="display:flex;justify-content:space-between;margin-bottom:4px">
      <b style="font-size:13.5px">${fmtDateShort(new Date(k+"T12:00:00"))}</b>
      <b style="font-size:13.5px;color:var(--accent2)">${fmtMin(sum)}</b></div>` +
      arr.map(w=>`<div class="wt-entry" data-id="${w.id}" role="button" tabindex="0">
        <div><div class="t">${fmtTime(new Date(w.start_time))} – ${w.end_time?fmtTime(new Date(w.end_time)):"…"}${w.break_minutes||w.break_started_at?` <span class="n">(P: ${fmtMin(w.break_minutes)})</span>`:""}</div>
        ${w.notes?`<div class="n">${esc(w.notes)}</div>`:""}</div>
        <div class="dur">${fmtMin(workedMinutes(w))}</div></div>`).join("") + `</div>`;
  });

  // Verlauf: frühere Perioden (Monate/Wochen) mit Summe und Abweichung vom Soll
  const histKeys = Object.keys(byPeriod).sort().reverse();
  let histHtml = "";
  if (histKeys.length){
    const monthNames = ["Jänner","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
    const label = k => mode==="week"
      ? "Woche ab " + fmtDate(new Date(k+"T12:00:00"))
      : monthNames[+k.slice(5,7)-1] + " " + k.slice(0,4);
    histHtml = `<h2>Verlauf</h2>` + histKeys.map(k=>{
      const sum = byPeriod[k], diff = sum - target;
      const open = S.wtExpand === k;
      let inner = "";
      if (open){
        const arr = closed.filter(w=>periodKeyOf(w.start_time,mode)===k)
          .sort((a,b)=>new Date(b.start_time)-new Date(a.start_time));
        const absHere = absAll.filter(a=>periodKeyOf(a.date+"T12:00:00",mode)===k)
          .sort((a,b)=> a.date<b.date ? 1 : -1);
        inner = `<div style="margin-top:8px;border-top:1px solid var(--line);padding-top:4px">` +
          absHere.map(absRow).join("") +
          arr.map(w=>`<div class="wt-entry" data-id="${w.id}" role="button" tabindex="0">
            <div><div class="t">${fmtDateShort(new Date(w.start_time))} · ${fmtTime(new Date(w.start_time))}–${fmtTime(new Date(w.end_time))}${w.break_minutes?` <span class="n">(P: ${fmtMin(w.break_minutes)})</span>`:""}</div>
            ${w.notes?`<div class="n">${esc(w.notes)}</div>`:""}</div>
            <div class="dur">${fmtMin(workedMinutes(w))}</div></div>`).join("") + `</div>`;
      }
      return `<div class="card histcard" data-k="${k}" style="cursor:pointer">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <b style="font-size:14px">${open?"▾":"▸"} ${label(k)}</b>
          <span style="font-variant-numeric:tabular-nums;font-size:13.5px"><b>${fmtMin(sum)}</b>
          ${isMain?`<span style="color:${diff>=0?"var(--green)":"var(--red)"};margin-left:8px">${diff>=0?"+":""}${fmtMin(diff)}</span>`:""}</span>
        </div>${inner}</div>`;
    }).join("");
  }

  el.innerHTML = accSeg + clockHtml + summaryHtml + absCardHtml +
    (isMain ? `<div style="display:flex;gap:8px;margin-bottom:4px">
      <button class="btn sec" id="w_settings" style="flex:1">⚙️ Sollzeit (${mode==="week"?"Woche":"Monat"})</button>
      <button class="btn sec" id="w_abs" style="flex:1">🏖 Urlaub eintragen</button></div>` : "") +
    listHtml + histHtml;

  $$("#w_accseg button", el).forEach(bt=>bt.onclick = ()=>{ S.workAccount = bt.dataset.a; S.wtExpand=null; renderWork(); });
  const ah = $("#absHead", el); if (ah) ah.onclick = (e)=>{ if (e.target.closest(".abs-del")) return; S.absOpen = !S.absOpen; renderWork(); };
  const wa = $("#w_abs"); if (wa) wa.onclick = openAbsenceForm;
  $$(".abs-del", el).forEach(b=>armDelete(b, async ()=>{
    await saveAbsences(getAbsences().filter(a=>a.id!==b.dataset.id));
    toast("Gelöscht"); renderWork();
  }));

  $$(".histcard", el).forEach(c=>c.addEventListener("click", (e)=>{
    if (e.target.closest(".wt-entry")) return; // Eintrag-Klick = bearbeiten
    S.wtExpand = (S.wtExpand===c.dataset.k) ? null : c.dataset.k;
    renderWork();
  }));

  // Events
  if (run){
    $("#w_break").onclick = async ()=>{
      const open = await serverOpenEntry();
      if (open === undefined) return;
      if (!open){ toast("Schon ausgestempelt (anderes Gerät)"); loadAll(); return; }
      if (open.break_started_at){
        const add = Math.max(0, Math.round((Date.now()-new Date(open.break_started_at))/60000));
        await sb.from("work_entries").update({ break_minutes:(open.break_minutes||0)+add, break_started_at:null })
          .eq("id",open.id).is("end_time", null);
      } else {
        await sb.from("work_entries").update({ break_started_at:new Date().toISOString() })
          .eq("id",open.id).is("end_time", null);
      }
      loadAll();
    };
    $("#w_out").onclick = async ()=>{
      const open = await serverOpenEntry();
      if (open === undefined) return;
      if (!open){ toast("War schon ausgestempelt (anderes Gerät)"); loadAll(); return; }
      let brk = open.break_minutes||0;
      if (open.break_started_at) brk += Math.max(0, Math.round((Date.now()-new Date(open.break_started_at))/60000));
      const { data: closed, error } = await sb.from("work_entries").update({ end_time:new Date().toISOString(), break_minutes:brk, break_started_at:null })
        .eq("id",open.id).is("end_time", null).select("id");
      if (error) return toast("Ausstempeln fehlgeschlagen: "+error.message, true);
      toast(closed && closed.length ? "Ausgestempelt ✓" : "War schon ausgestempelt (anderes Gerät)"); loadAll();
    };
  } else {
    $("#w_in").onclick = async ()=>{
      const open = await serverOpenEntry();
      if (open === undefined) return;
      if (open){ toast("Läuft schon seit "+fmtTime(new Date(open.start_time))+" (anderes Gerät)"); loadAll(); return; }
      const { error } = await sb.from("work_entries").insert({ start_time:new Date().toISOString(),
        account: isMain ? null : acc });
      if (error) return toast("Einstempeln fehlgeschlagen: "+error.message+(String(error.message).includes("account")?" – bitte update-arbeit.sql in Supabase ausführen!":""), true);
      toast(`Eingestempelt (${acc}) – viel Erfolg!`); loadAll();
    };
  }
  const ws = $("#w_settings"); if (ws) ws.onclick = openWorkSettings;
  $$(".wt-entry", el).forEach(r=>r.onclick=()=>{
    const w = S.workEntries.find(x=>x.id===r.dataset.id);
    if (w && w.end_time) openWorkEntryForm(w);
  });
}

function openWorkEntryForm(w){
  const isNew = !w;
  const now = new Date();
  const st = w ? new Date(w.start_time) : new Date(now-4*3600000);
  const en = w && w.end_time ? new Date(w.end_time) : now;
  const dt = d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  openModal(`
    <h3>${isNew?"Arbeitszeit nachtragen":"Eintrag bearbeiten"}</h3>
    <label>Beginn</label><input type="datetime-local" id="we_start" value="${dt(st)}">
    <label>Ende</label><input type="datetime-local" id="we_end" value="${dt(en)}">
    <label>Pausen (Minuten)</label><input type="number" min="0" id="we_break" value="${w?w.break_minutes:0}">
    <label>Zeitkonto</label><select id="we_acc">${workAccounts().map(a=>
      `<option value="${esc(a)}" ${(w ? entryAcc(w) : (S.workAccount||workAccounts()[0]))===a?"selected":""}>${esc(a)}</option>`).join("")}</select>
    <label>Notiz</label><input id="we_notes" value="${esc(w?w.notes:"")}" placeholder="optional">
    <div style="height:18px"></div>
    <button class="btn" id="we_save">Speichern</button>
    ${isNew?"":`<div style="height:8px"></div><button class="btn danger" id="we_del">Eintrag löschen</button>`}
  `);
  $("#we_save").onclick = async ()=>{
    const start = new Date($("#we_start").value), end = new Date($("#we_end").value);
    if (!(start<end)) return toast("Ende muss nach Beginn liegen.", true);
    const selAcc = $("#we_acc").value;
    const row = { start_time:start.toISOString(), end_time:end.toISOString(),
      break_minutes:Math.max(0,+$("#we_break").value||0), notes:$("#we_notes").value,
      account: selAcc === workAccounts()[0] ? null : selAcc };
    const q = isNew ? sb.from("work_entries").insert(row) : sb.from("work_entries").update(row).eq("id",w.id);
    const { error } = await q;
    if (error) return toast("Fehler: "+error.message, true);
    closeModal(); loadAll();
  };
  if (!isNew) armDelete($("#we_del"), async ()=>{
    const { error } = await sb.from("work_entries").delete().eq("id",w.id);
    if (error) return toast("Löschen fehlgeschlagen: "+error.message, true);
    closeModal(); toast("Gelöscht"); loadAll();
  });
}

function openWorkSettings(){
  const mode = getSetting("workTargetMode","month");
  const wt = getSetting("weeklyTargetMinutes",2310), mt = getSetting("monthlyTargetMinutes",4800);
  openModal(`
    <h3>Sollzeit</h3>
    <label>Zeitraum</label>
    <div class="seg" id="ws_mode">
      <button data-v="week" class="${mode==="week"?"active":""}">Pro Woche</button>
      <button data-v="month" class="${mode==="month"?"active":""}">Pro Monat</button>
    </div>
    <label>Soll pro Woche (Stunden)</label><input type="number" step="0.5" min="0" id="ws_week" value="${(wt/60).toFixed(1)}">
    <label>Soll pro Monat (Stunden)</label><input type="number" step="0.5" min="0" id="ws_month" value="${(mt/60).toFixed(1)}">
    <div style="height:18px"></div>
    <button class="btn" id="ws_save">Speichern</button>
  `);
  let m = mode;
  $$("#ws_mode button").forEach(b=>b.onclick=()=>{ m=b.dataset.v;
    $$("#ws_mode button").forEach(x=>x.classList.toggle("active",x===b)); });
  $("#ws_save").onclick = async ()=>{
    await saveSetting("workTargetMode", m);
    await saveSetting("weeklyTargetMinutes", Math.round((+$("#ws_week").value||38.5)*60));
    await saveSetting("monthlyTargetMinutes", Math.round((+$("#ws_month").value||80)*60));
    closeModal(); renderWork(); toast("Gespeichert");
  };
}

function openAbsenceForm(){
  const defH = (absDayMinutesDefault()/60).toFixed(1);
  const today = dayKey(new Date());
  openModal(`
    <h3>🏖 Abwesenheit eintragen</h3>
    <label>Art</label>
    <div class="seg" id="ab_kind">
      <button data-v="urlaub" class="active">🏖 Urlaub</button>
      <button data-v="krank">🤒 Krank</button>
      <button data-v="feiertag">🎉 Feiertag</button>
    </div>
    <label>Von</label><input type="date" id="ab_from" value="${today}">
    <label>Bis (leer = nur ein Tag)</label><input type="date" id="ab_to" value="">
    <label>Gutschrift pro Tag (Stunden)</label><input type="number" step="0.5" min="0" id="ab_hours" value="${defH}">
    <label style="display:flex;align-items:center;gap:8px;margin-top:10px;cursor:pointer">
      <input type="checkbox" id="ab_wd" checked style="width:auto;margin:0"> Nur Werktage (Mo–Fr)</label>
    <div style="height:18px"></div>
    <button class="btn" id="ab_save">Eintragen</button>
    <div style="font-size:12px;color:var(--dim);margin-top:10px">Jeder Tag zählt als Gutschrift aufs Soll – so rutscht der Saldo im Urlaub nicht ins Minus.</div>
  `);
  let kind = "urlaub";
  $$("#ab_kind button").forEach(b=>b.onclick=()=>{ kind=b.dataset.v;
    $$("#ab_kind button").forEach(x=>x.classList.toggle("active", x===b)); });
  $("#ab_save").onclick = async ()=>{
    const from = $("#ab_from").value; if(!from) return toast("Bitte Datum wählen.", true);
    const to = $("#ab_to").value || from;
    if (to < from) return toast("„Bis“ liegt vor „Von“.", true);
    const min = Math.round((+$("#ab_hours").value||0)*60);
    if (!min) return toast("Stunden pro Tag fehlen.", true);
    const wdOnly = $("#ab_wd").checked;
    const list = getAbsences().slice();
    let n = 0;
    const d = new Date(from+"T12:00:00"), end = new Date(to+"T12:00:00");
    while (d <= end && n < 400){
      const k = dayKey(d), dow = d.getDay();
      if ((!wdOnly || (dow>=1 && dow<=5)) && !list.some(a=>a.date===k)){
        list.push({ id:crypto.randomUUID(), date:k, kind, min }); n++;
      }
      d.setDate(d.getDate()+1);
    }
    await saveAbsences(list);
    closeModal(); toast(n ? `${n} Tag${n>1?"e":""} eingetragen ✓` : "Keine neuen Tage (schon eingetragen?)");
    renderWork();
  };
}

// ============================================================
// Statistik & Streaks
// ============================================================
function renderStats(){
  const el = $("#view-stats");
  const byDay = {};
  S.completions.forEach(c=>{ const k=dayKey(new Date(c.completed_at));
    (byDay[k]=byDay[k]||{n:0,min:0}); byDay[k].n++; byDay[k].min+=c.minutes||0; });

  // Streak: aufeinanderfolgende Tage mit >=1 Erledigung (heute darf noch offen sein)
  let streak=0; const d=new Date();
  if (!byDay[dayKey(d)]) d.setDate(d.getDate()-1);
  while (byDay[dayKey(d)]){ streak++; d.setDate(d.getDate()-1); }

  const todayS = byDay[dayKey(new Date())]||{n:0,min:0};
  let weekN=0, weekMin=0;
  for(let i=0;i<7;i++){ const x=new Date(); x.setDate(x.getDate()-i);
    const v=byDay[dayKey(x)]; if(v){weekN+=v.n; weekMin+=v.min;} }
  const totalN = S.completions.length;

  // Balken: letzte 14 Tage
  const bars=[]; let max=1;
  for(let i=13;i>=0;i--){ const x=new Date(); x.setDate(x.getDate()-i);
    const v=(byDay[dayKey(x)]||{n:0}).n; max=Math.max(max,v);
    bars.push({d:new Date(x), v}); }

  // Meist erledigte Aufgaben (30 Tage)
  const cutoff = Date.now()-30*86400000, freq={};
  S.completions.filter(c=>new Date(c.completed_at)>cutoff).forEach(c=>{ freq[c.title]=(freq[c.title]||0)+1; });
  const top = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,8);

  // Jahres-Heatmap: letzte 52 Wochen, Spalten = Wochen (Mo–So), scrollt zum Ende
  const thisMon = startOfDay(new Date());
  thisMon.setDate(thisMon.getDate() - ((thisMon.getDay()+6)%7));
  const todayK = dayKey(new Date());
  let heatCells = "";
  const monthMarks = [];
  for (let w=51; w>=0; w--){
    const mon = new Date(thisMon); mon.setDate(mon.getDate()-w*7);
    if (mon.getDate() <= 7) monthMarks.push({ col:51-w, label: mon.toLocaleDateString("de-DE",{month:"short"}) });
    for (let i=0;i<7;i++){
      const dd = new Date(mon); dd.setDate(dd.getDate()+i);
      const k = dayKey(dd);
      if (k > todayK){ heatCells += `<span class="hcell future"></span>`; continue; }
      const n = (byDay[k]||{n:0}).n;
      const lvl = n===0?0 : n<=2?1 : n<=4?2 : n<=7?3 : 4;
      heatCells += `<span class="hcell l${lvl}" title="${k}: ${n}"></span>`;
    }
  }
  const heatHtml = `<h2>Jahres-Heatmap</h2>
    <div class="card"><div class="heatwrap" id="heatwrap">
      <div class="heatmonths">${monthMarks.map(m=>`<span style="grid-column:${m.col+1}">${m.label}</span>`).join("")}</div>
      <div class="heatmap">${heatCells}</div></div>
    <div style="display:flex;justify-content:flex-end;align-items:center;gap:4px;font-size:10.5px;color:var(--dim2);margin-top:6px">
      weniger <span class="hcell l0"></span><span class="hcell l1"></span><span class="hcell l2"></span><span class="hcell l3"></span><span class="hcell l4"></span> mehr</div></div>`;

  // Achievements
  const badges = achievementsList(byDay, streak);
  const gotN = badges.filter(b=>b.got).length;
  const badgeHtml = `<h2>Achievements · ${gotN}/${badges.length}</h2>
    <div class="badgegrid">${badges.map(b=>`
      <div class="badge ${b.got?"":"locked"}">
        <div class="bi">${b.ico}</div>
        <div class="bn">${b.name}</div>
        <div class="bd">${b.got ? b.desc : b.prog}</div>
      </div>`).join("")}</div>`;

  el.innerHTML = `
    <div class="statgrid">
      <div class="stat"><div class="v">🔥 ${streak}</div><div class="l">Tage-Streak</div></div>
      <div class="stat"><div class="v">${todayS.n}</div><div class="l">Heute erledigt</div></div>
      <div class="stat"><div class="v">${weekN}</div><div class="l">Letzte 7 Tage</div></div>
      <div class="stat"><div class="v">${fmtMin(weekMin)}</div><div class="l">Zeit · 7 Tage</div></div>
    </div>
    <h2>Letzte 14 Tage</h2>
    <div class="card"><div class="barchart">${bars.map(b=>
      `<div class="bar ${sameDay(b.d,new Date())?"today":""}">
        ${b.v?`<em>${b.v}</em>`:""}<i style="height:${Math.max(2,90*b.v/max)}%"></i><b>${b.d.getDate()}.</b></div>`).join("")}
    </div></div>
    ${heatHtml}
    ${badgeHtml}
    <h2>Top-Aufgaben · 30 Tage</h2>
    <div class="card">${ top.length ? top.map(([n,v])=>
      `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line);font-size:14.5px">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:10px">${esc(n)}</span><b>${v}×</b></div>`).join("")
      : `<div class="section-empty">Noch keine Daten – leg los! 💪</div>`}</div>
    <div class="card" style="text-align:center;color:var(--dim);font-size:13px">Insgesamt ${totalN} Erledigungen aufgezeichnet</div>
  `;
  const hw = $("#heatwrap", el); if (hw) hw.scrollLeft = hw.scrollWidth; // zum aktuellen Ende scrollen
}

// Achievements – alles aus vorhandenen Daten ableitbar, kein extra Speichern nötig
function achievementsList(byDay, curStreak){
  const total = S.completions.length;
  const li = levelInfo();
  // Bester Streak aller Zeiten
  const days = Object.keys(byDay).sort();
  let best=0, run=0, prev=null;
  days.forEach(k=>{
    run = (prev && (new Date(k+"T00:00:00Z") - new Date(prev+"T00:00:00Z")) === 86400000) ? run+1 : 1;
    best = Math.max(best, run); prev = k;
  });
  best = Math.max(best, curStreak);
  const maxDay = days.length ? Math.max(...days.map(k=>byDay[k].n)) : 0;
  const early = S.completions.some(c=>new Date(c.completed_at).getHours() < 7);
  const night = S.completions.some(c=>new Date(c.completed_at).getHours() >= 23);
  const workH = Math.floor(S.workEntries.filter(w=>w.end_time).reduce((a,w)=>a+workedMinutes(w),0)/60);
  const hasAbs = getAbsences().length > 0;
  const A = (ico,name,desc,got,prog) => ({ico,name,desc,got,prog});
  const cnt = (v,goal,unit)=>`${Math.min(v,goal)}/${goal}${unit||""}`;
  return [
    A("🌱","Erster Schritt","1 Aufgabe erledigt", total>=1, cnt(total,1)),
    A("✅","Zehnerpack","10 Aufgaben erledigt", total>=10, cnt(total,10)),
    A("💪","Halbes Hundert","50 Aufgaben erledigt", total>=50, cnt(total,50)),
    A("🏆","Century","100 Aufgaben erledigt", total>=100, cnt(total,100)),
    A("🚀","Maschine","500 Aufgaben erledigt", total>=500, cnt(total,500)),
    A("🔥","Dranbleiber","3-Tage-Streak", best>=3, cnt(best,3)),
    A("⚡","Wochenheld","7-Tage-Streak", best>=7, cnt(best,7)),
    A("🌟","Zwei Wochen stark","14-Tage-Streak", best>=14, cnt(best,14)),
    A("👑","Unaufhaltbar","30-Tage-Streak", best>=30, cnt(best,30)),
    A("⭐","Aufsteiger","Level 5 erreicht", li.level>=5, `Level ${Math.min(li.level,5)}/5`),
    A("🌠","Level-Legende","Level 10 erreicht", li.level>=10, `Level ${Math.min(li.level,10)}/10`),
    A("🐝","Fleißige Biene","10 Aufgaben an einem Tag", maxDay>=10, cnt(maxDay,10)),
    A("🌅","Frühaufsteher","Vor 7 Uhr erledigt", early, "vor 07:00"),
    A("🦉","Nachteule","Nach 23 Uhr erledigt", night, "nach 23:00"),
    A("⏱","Zeitmeister","100 h Arbeit erfasst", workH>=100, cnt(workH,100," h")),
    A("🏖","Work-Life-Balance","Urlaub eingetragen", hasAbs, "Urlaub nutzen!"),
  ];
}

// ============================================================
// Einstellungen (Orte verwalten, Abmelden)
// ============================================================
function openSettings(){
  const locRows = S.locations.map(l=>`
    <div class="wt-entry" data-id="${l.id}" style="cursor:default">
      <div><div class="t">${esc(l.name)}</div>
      <div class="n">${[l.is_routine?"🔁 Routine":"", l.is_work_location?"💼 Arbeitsort":""].filter(Boolean).join(" · ")}</div></div>
      <div>
        <button class="iconbtn" data-act="routine" title="Routine umschalten" style="opacity:${l.is_routine?1:.35}">🔁</button>
        <button class="iconbtn" data-act="work" title="Arbeitsort umschalten" style="opacity:${l.is_work_location?1:.35}">💼</button>
        <button class="iconbtn" data-act="del" title="Löschen">🗑</button>
      </div>
    </div>`).join("");
  const themePref = localStorage.getItem("wopTheme") || "auto";
  openModal(`
    <h3>Einstellungen</h3>
    <label>🎨 Erscheinungsbild</label>
    <div class="seg" id="s_theme" style="margin-top:4px">
      <button data-v="auto" class="${themePref==="auto"?"active":""}">Auto</button>
      <button data-v="light" class="${themePref==="light"?"active":""}">🌸 Hell</button>
      <button data-v="dark" class="${themePref==="dark"?"active":""}">🌙 Dunkel</button>
    </div>
    <label>Orte / Listen</label>
    <div class="card" style="margin-top:4px">${locRows||"<div class='section-empty'>Keine Orte.</div>"}</div>
    <div class="mrow"><input id="s_newloc" placeholder="Neuer Ort…"><button class="btn small sec" id="s_addloc" style="width:auto">+</button></div>
    <div style="height:20px"></div>
    <label>🔔 Benachrichtigungen</label>
    <div class="card" style="margin-top:4px" id="s_notifyBox">wird geladen…</div>
    <label>Daten</label>
    <button class="btn sec" id="s_export">📤 Backup exportieren (.json)</button>
    <div style="height:8px"></div>
    <button class="btn sec" id="s_import">📥 Backup importieren (.json)</button>
    <input type="file" id="s_importfile" accept=".json,application/json" class="hidden">
    <div style="height:8px"></div>
    <button class="btn sec" id="s_archive">🗂 Archiv öffnen</button>
    <div style="height:8px"></div>
    <button class="btn sec" id="s_meds">💊 Medikamente verwalten</button>
    <label>💬 Assistent – OpenAI API-Key (bleibt nur auf diesem Gerät)</label>
    <input type="password" id="s_aikey" placeholder="sk-…" value="${esc(localStorage.getItem("wopAiKey")||"")}">
    <div style="height:8px"></div>
    <button class="btn sec" id="s_savekey">Key speichern</button>
    <div style="height:20px"></div>
    <div class="card" style="font-size:13px;color:var(--dim)">Angemeldet als <b style="color:var(--text)">${esc(S.user.email)}</b> · App v${APP_VERSION}</div>
    <button class="btn danger" id="s_logout">Abmelden</button>
  `);
  renderNotifySettings();
  $("#s_export").onclick = exportBackup;
  $("#s_meds").onclick = openMedsForm;
  $("#s_import").onclick = ()=>$("#s_importfile").click();
  $("#s_importfile").onchange = async (e)=>{
    const file = e.target.files[0]; if(!file) return;
    try {
      const json = JSON.parse(await file.text());
      await importBackup(json);
    } catch(err){ toast("Import fehlgeschlagen: "+err.message, true); }
  };
  $$("#modalBox .wt-entry").forEach(row=>{
    const l = S.locations.find(x=>x.id===row.dataset.id);
    $("[data-act=routine]",row).onclick = async ()=>{
      await sb.from("locations").update({is_routine:!l.is_routine}).eq("id",l.id);
      await loadAll(); openSettings();
    };
    $("[data-act=work]",row).onclick = async ()=>{
      await sb.from("locations").update({is_work_location:!l.is_work_location}).eq("id",l.id);
      await loadAll(); openSettings();
    };
    armDelete($("[data-act=del]",row), async ()=>{
      const { error } = await sb.from("locations").delete().eq("id",l.id);
      if (error) return toast("Löschen fehlgeschlagen: "+error.message, true);
      await loadAll(); openSettings();
    });
  });
  $("#s_addloc").onclick = async ()=>{
    const v=$("#s_newloc").value.trim(); if(!v) return;
    await sb.from("locations").insert({name:v, sort_order:S.locations.length});
    await loadAll(); openSettings();
  };
  $$("#s_theme button").forEach(b=>b.onclick = ()=>{
    localStorage.setItem("wopTheme", b.dataset.v);
    $$("#s_theme button").forEach(x=>x.classList.toggle("active", x===b));
    applyTheme();
  });
  $("#s_logout").onclick = async ()=>{ await sb.auth.signOut(); };
  $("#s_archive").onclick = ()=>{ closeModal(); switchTab("archive"); };
  $("#s_savekey").onclick = ()=>{
    const v = $("#s_aikey").value.trim();
    if (v) localStorage.setItem("wopAiKey", v); else localStorage.removeItem("wopAiKey");
    toast(v ? "Key gespeichert ✓" : "Key entfernt");
  };
}

// ============================================================
// Import: Backup der iOS-App (BackupManager, Format v3/v4)
// ============================================================
function mapBackup(json){
  if (!json || !Array.isArray(json.tasks)) throw new Error("Das ist kein gültiges Backup der iOS-App.");
  const parseRaw = v => { if (Array.isArray(v)) return v;
    try { return JSON.parse(v||"[]"); } catch(e){ return []; } };
  const kindMap = { "One-off":"oneOff", "Recurring":"recurring" };
  const recMap = { "Daily":"daily", "Weekly":"weekly", "Custom (days)":"customDays" };
  const lc = id => id ? String(id).toLowerCase() : null;

  const locations = (json.locations||[]).map((l,i)=>({
    id: lc(l.id), name: l.name,
    is_routine: !!l.isRoutine, is_work_location: !!l.isWorkLocation, sort_order: i,
  }));

  const tasks = (json.tasks||[]).map(t=>({
    id: lc(t.id),
    title: t.title || "(ohne Titel)",
    duration_minutes: Math.max(1, t.durationMinutes||15),
    location: t.location || "",
    kind: kindMap[t.kindRaw] || "oneOff",
    recurrence: recMap[t.recurrenceRaw] || "daily",
    custom_recurrence_days: Math.max(1, t.customRecurrenceDays||2),
    is_priority: !!t.isPriority,
    due_date: t.dueDate || null,
    scheduled_date: t.scheduledDate || null,
    has_scheduled_time: !!t.hasScheduledTime,
    repeat_count: Math.max(1, t.repeatCount||1),
    completed_today_count: t.completedTodayCount||0,
    last_completed_count_reset: t.lastCompletedCountResetDate || null,
    repeat_cooldown_minutes: t.repeatCooldownMinutes||0,
    last_repeat_completed_at: t.lastRepeatCompletedAt || null,
    tags: parseRaw(t.tagsRaw),
    subtasks: parseRaw(t.subtasksRaw).map(s=>({ id: lc(s.id)||uid(), title: s.title, done: !!s.isCompleted })),
    notes: t.notes || "",
    dependency_task_id: lc(t.dependencyTaskId),
    start_date: t.startDate || null,
    active_weekdays: parseRaw(t.activeWeekdaysRaw),
    sort_order: t.sortOrder||0,
    created_at: t.createdAt || new Date().toISOString(),
    last_done_at: t.lastDoneAt || null,
    is_archived: !!t.isArchived,
  }));

  const work_entries = (json.workTimeEntries||[]).map(w=>({
    id: lc(w.id),
    start_time: w.startTime,
    end_time: w.endTime || null,
    break_minutes: w.breakMinutes||0,
    notes: w.notes || "",
  })).filter(w=>w.start_time);

  const typeMap = { "Work":"work","Home":"home","Travel":"travel","Event":"event","Routine":"routine","Free Time":"free","Sleep":"sleep" };
  const time_blocks = [];
  (json.daySchedules||[]).forEach(ds=>{
    if (!ds.date) return;
    const dk = dayKey(new Date(ds.date));
    (ds.timeBlocks||[]).forEach(tb=>{
      const bType = typeMap[tb.typeRaw]||"event";
      let bEnd = tb.endTime||0;
      if (bEnd <= (tb.startTime||0) && bType!=="sleep") bEnd = 1439; // Über-Mitternacht normalisieren
      time_blocks.push({ id: lc(tb.id), date: dk, title: tb.title||"",
        type: bType, start_min: tb.startTime||0, end_min: bEnd,
        notes: tb.notes||"", color: tb.customColorRaw||"" });
    });
  });

  const settings = [];
  const s = json.settings||{};
  if (s.workTimeTargetMode) settings.push({ key:"workTargetMode", value:s.workTimeTargetMode });
  if (s.weeklyTargetWorkMinutes) settings.push({ key:"weeklyTargetMinutes", value:s.weeklyTargetWorkMinutes });
  if (s.monthlyTargetWorkMinutes) settings.push({ key:"monthlyTargetMinutes", value:s.monthlyTargetWorkMinutes });

  return { locations, tasks, work_entries, settings, time_blocks };
}

// 📤 Eigenes Backup: alles als JSON herunterladen (Gegenstück: importBackup versteht es wieder)
function exportBackup(){
  const data = {
    webBackup: true, version: 1, exportDate: new Date().toISOString(),
    tasks: S.tasks, locations: S.locations, completions: S.completions,
    workEntries: S.workEntries, timeBlocks: S.timeBlocks, settings: S.settings,
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "procrastination-backup-" + dayKey(new Date()) + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 5000);
  toast("📤 Backup heruntergeladen");
}

async function importBackup(json){
  // Eigenes Web-Backup? Dann 1:1 wiederherstellen (upsert nach id, nichts wird doppelt)
  if (json && json.webBackup){
    toast("Stelle Backup wieder her…");
    const strip = r => { const { user_id, ...rest } = r; return { ...rest, user_id: S.user.id }; };
    const tables = [["locations", json.locations], ["tasks", json.tasks], ["completions", json.completions],
      ["work_entries", json.workEntries], ["time_blocks", json.timeBlocks]];
    for (const [table, rows] of tables){
      if (!rows || !rows.length) continue;
      for (let i=0; i<rows.length; i+=200){
        const { error } = await sb.from(table).upsert(rows.slice(i, i+200).map(strip));
        if (error) return toast(`Import ${table} fehlgeschlagen: ${error.message}`, true);
      }
    }
    if (json.settings) for (const [k,v] of Object.entries(json.settings)) await saveSetting(k, v);
    toast("✅ Backup wiederhergestellt");
    closeModal(); loadAll();
    return;
  }
  const m = mapBackup(json);
  toast("Importiere…");

  // Orte: nur die einfügen, die es (nach Name) noch nicht gibt
  const haveNames = new Set(S.locations.map(l=>l.name.toLowerCase()));
  const newLocs = m.locations.filter(l=>!haveNames.has(l.name.toLowerCase()));

  const results = [];
  if (newLocs.length)
    results.push(await sb.from("locations").upsert(newLocs, { onConflict:"id", ignoreDuplicates:true }));
  if (m.tasks.length)
    results.push(await sb.from("tasks").upsert(m.tasks, { onConflict:"id", ignoreDuplicates:true }));
  if (m.work_entries.length)
    results.push(await sb.from("work_entries").upsert(m.work_entries, { onConflict:"id", ignoreDuplicates:true }));
  if (m.time_blocks.length)
    results.push(await sb.from("time_blocks").upsert(m.time_blocks, { onConflict:"id", ignoreDuplicates:true }));
  for (const st of m.settings)
    results.push(await sb.from("settings").upsert({ user_id:S.user.id, key:st.key, value:st.value }));

  const err = results.find(r=>r && r.error);
  if (err) { toast("Import-Fehler: "+err.error.message, true); return; }

  if (json.stats && json.stats.totalXP && !getSetting("xpBase", 0))
    await saveSetting("xpBase", json.stats.totalXP);
  closeModal();
  toast(`✓ Import fertig: ${m.tasks.length} Aufgaben, ${newLocs.length} neue Orte, ${m.work_entries.length} Arbeitszeiten, ${m.time_blocks.length} Kalender-Blöcke`);
  loadAll();
}

// ============================================================
// Heute (Home-Dashboard): Wetter, Tagesplan, Fortschritt
// ============================================================
const WMO = { // Open-Meteo Wettercodes -> [Emoji, Text]
  0:["☀️","Klar"],1:["🌤","Überwiegend klar"],2:["⛅️","Teils bewölkt"],3:["☁️","Bedeckt"],
  45:["🌫","Nebel"],48:["🌫","Reifnebel"],51:["🌦","Leichter Niesel"],53:["🌦","Niesel"],55:["🌧","Starker Niesel"],
  61:["🌦","Leichter Regen"],63:["🌧","Regen"],65:["🌧","Starker Regen"],66:["🌧","Gefr. Regen"],67:["🌧","Gefr. Regen"],
  71:["🌨","Leichter Schnee"],73:["🌨","Schnee"],75:["❄️","Starker Schnee"],77:["❄️","Schneegriesel"],
  80:["🌦","Regenschauer"],81:["🌧","Regenschauer"],82:["⛈","Heftige Schauer"],
  85:["🌨","Schneeschauer"],86:["🌨","Schneeschauer"],95:["⛈","Gewitter"],96:["⛈","Gewitter m. Hagel"],99:["⛈","Gewitter m. Hagel"],
};
let weatherCache = null; // {ts, key, data}
let _effGeo = null;      // zuletzt verwendeter effektiver Wetter-Ort {lat,lon,name}

// Effektiver Wetter-Ort: Basis-Standort, aber vergangene Reisen (📍 whereAmI) überschreiben ihn
async function effectiveGeo(){
  let base = null;
  try { base = JSON.parse(localStorage.getItem("wopGeo")||"null"); } catch(e){}
  const w = whereAmI();
  if (w.name && base && w.name !== base.name){
    const g = await geocodeCity(w.name);
    if (g) return { lat:g.lat, lon:g.lon, name:g.name||w.name };
  }
  return base;
}

// Standort still aktualisieren, wenn die Erlaubnis schon erteilt ist (kein Popup)
let _geoRefreshed = false;
function refreshGeoSilently(){
  if (_geoRefreshed) return; _geoRefreshed = true;
  try {
    if (!navigator.geolocation || !navigator.permissions) return;
    navigator.permissions.query({ name:"geolocation" }).then(st=>{
      if (st.state !== "granted") return;
      navigator.geolocation.getCurrentPosition(p=>{
        const g = { lat:+p.coords.latitude.toFixed(3), lon:+p.coords.longitude.toFixed(3), name:"Mein Standort" };
        let old = null; try { old = JSON.parse(localStorage.getItem("wopGeo")||"null"); } catch(e){}
        if (!old || Math.abs(old.lat-g.lat)>0.05 || Math.abs(old.lon-g.lon)>0.05){
          localStorage.setItem("wopGeo", JSON.stringify(g));
          saveSetting("geo", g);
          weatherCache = null; _weekWx = {};
          if (S.tab==="home") renderHome();
        }
      }, ()=>{}, { timeout:8000, maximumAge:600000 });
    }).catch(()=>{});
  } catch(e){}
}

async function fetchWeather(){
  const loc = await effectiveGeo();
  if (!loc) return null;
  _effGeo = loc;
  // Fürs Morgen-Briefing mitziehen (Edge Function nutzt settings.geo)
  try { if (S.settings && (!S.settings.geo || S.settings.geo.name !== loc.name)) saveSetting("geo", loc); } catch(e){}
  const key = loc.lat+","+loc.lon;
  if (weatherCache && weatherCache.key===key && Date.now()-weatherCache.ts < 30*60000) return weatherCache.data;
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`+
      `&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m`+
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=2`;
    const r = await fetch(u); const d = await r.json();
    weatherCache = { ts: Date.now(), key, data: d };
    return d;
  } catch(e){ return null; }
}
function askGeo(){
  if (!navigator.geolocation) return openCityPicker();
  navigator.geolocation.getCurrentPosition(p=>{
    const g = {lat:+p.coords.latitude.toFixed(3), lon:+p.coords.longitude.toFixed(3), name:"Mein Standort"};
    localStorage.setItem("wopGeo", JSON.stringify(g));
    saveSetting("geo", g); // für das Morgen-Briefing (Edge Function)
    weatherCache=null; renderHome();
  }, ()=>{ toast("Standort nicht verfügbar – gib stattdessen deinen Ort ein."); openCityPicker(); }, {timeout:8000});
}

function openCityPicker(){
  openModal(`
    <h3>Ort für das Wetter</h3>
    <label>Stadt / Ort</label>
    <input id="cp_q" placeholder="z.B. Salzburg" autocomplete="off">
    <div id="cp_results" style="margin-top:10px"></div>
    <div style="height:6px"></div>
    <button class="btn sec" id="cp_search">Suchen</button>
  `);
  const doSearch = async ()=>{
    const q = $("#cp_q").value.trim();
    if (!q) return;
    $("#cp_results").innerHTML = `<div class="section-empty">Suche…</div>`;
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=de&format=json`);
      const d = await r.json();
      const res = d.results||[];
      if (!res.length){ $("#cp_results").innerHTML = `<div class="section-empty">Nichts gefunden – anders schreiben?</div>`; return; }
      $("#cp_results").innerHTML = res.map((c,i)=>
        `<div class="wt-entry" data-i="${i}"><div><div class="t">${esc(c.name)}</div>
         <div class="n">${esc([c.admin1,c.country].filter(Boolean).join(", "))}</div></div><div>›</div></div>`).join("");
      $$("#cp_results .wt-entry").forEach(row=>row.onclick = ()=>{
        const c = res[+row.dataset.i];
        const g = {lat:+c.latitude.toFixed(3), lon:+c.longitude.toFixed(3), name:c.name};
        localStorage.setItem("wopGeo", JSON.stringify(g));
        saveSetting("geo", g); // für das Morgen-Briefing (Edge Function)
        weatherCache=null; closeModal(); renderHome();
      });
    } catch(e){ $("#cp_results").innerHTML = `<div class="section-empty">Suche fehlgeschlagen – Internet?</div>`; }
  };
  $("#cp_search").onclick = doSearch;
  $("#cp_q").addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); doSearch(); } });
  setTimeout(()=>$("#cp_q").focus(), 100);
}

function greetingText(){
  const h = new Date().getHours();
  if (h<5) return "Gute Nacht";
  if (h<11) return "Guten Morgen";
  if (h<14) return "Mahlzeit";
  if (h<18) return "Guten Nachmittag";
  return "Guten Abend";
}

function homeBlockRows(){
  const blocks = blocksFor(dayKey(new Date())).filter(b=>b.type!=="sleep");
  const nowM = new Date().getHours()*60+new Date().getMinutes();
  return blocks.map(b=>{
    const t = BLOCK_TYPES[b.type]||BLOCK_TYPES.event;
    const bAllDay = b.start_min<=0 && (b.end_min>=1439 || b.end_min<=60);
    if (bAllDay){
      return `<div class="planrow" data-block="${b.id}" role="button" tabindex="0">
        <span class="ptime">📅</span>
        <span class="pt">${blockIco(b)} ${esc(b.title||t.label)}</span>
        <span class="pm">ganztägig</span></div>`;
    }
    const endEff = b.end_min > b.start_min ? b.end_min : 1440;
    const past = endEff < nowM;
    return `<div class="planrow ${past?"pdone":""}" data-block="${b.id}">
      <span class="ptime">${minToHM(b.start_min)}</span>
      <span class="pt">${blockIco(b)} ${esc(b.title||t.label)}</span>
      <span class="pm">bis ${minToHM(b.end_min)}</span></div>`;
  }).join("");
}

// 📍 Wo bin ich? – aus vergangenen Reise-Blöcken (Ziel gilt ab Ankunft), plus nächste Reise
function whereAmI(){
  let name = null;
  try { const g = JSON.parse(localStorage.getItem("wopGeo")||"null");
    if (g && g.name && g.name !== "Mein Standort") name = g.name; } catch(e){}
  const todayK = dayKey(new Date());
  const nowM = new Date().getHours()*60 + new Date().getMinutes();
  let nextTrip = null;
  for (let i=-14; i<=7; i++){
    const d = new Date(); d.setDate(d.getDate()+i);
    const dk = dayKey(d);
    for (const b of blocksFor(dk).filter(x=>x.type==="travel").sort((a,c)=>a.start_min-c.start_min)){
      const dest = travelDest(b.title);
      const past = dk < todayK || (dk === todayK && (b.end_min>b.start_min?b.end_min:1440) <= nowM);
      if (past){ if (dest) name = dest; }
      else if (!nextTrip){ nextTrip = { b, d, dk, dest }; }
    }
  }
  return { name, nextTrip };
}

// Kompakte Kalender-Kachel (mobil, neben dem Wetter)
function calTileHtml(){
  const nowM = new Date().getHours()*60 + new Date().getMinutes();
  const bAllDay = b => b.start_min<=0 && (b.end_min>=1439 || b.end_min<=60);
  const today = blocksFor(dayKey(new Date())).filter(b=>b.type!=="sleep");
  const upcoming = today.filter(b => bAllDay(b) || (b.end_min>b.start_min?b.end_min:1440) >= nowM).slice(0,3);
  const tm = new Date(); tm.setDate(tm.getDate()+1);
  const tomorrow = blocksFor(dayKey(tm)).filter(b=>b.type!=="sleep");
  const row = b => {
    const t = BLOCK_TYPES[b.type]||BLOCK_TYPES.event;
    return `<div style="display:flex;gap:6px;align-items:baseline;font-size:12px;line-height:1.35;overflow:hidden">
      <span style="font-variant-numeric:tabular-nums;font-weight:800;color:var(--accent2);flex-shrink:0">${bAllDay(b)?"📅":minToHM(b.start_min)}</span>
      <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${blockIco(b)} ${esc(b.title||t.label)}</span></div>`;
  };
  const w = whereAmI();
  let head = "📅 Heute", body = "", foot = "";
  if (upcoming.length){
    body = upcoming.map(row).join("");
    if (tomorrow.length){
      const f = tomorrow[0], t = BLOCK_TYPES[f.type]||BLOCK_TYPES.event;
      foot = `<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--line);font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
        Morgen: ${bAllDay(f)?"📅":minToHM(f.start_min)} ${blockIco(f)} ${esc(f.title||t.label)}${tomorrow.length>1?` +${tomorrow.length-1}`:""}</div>`;
    }
  } else {
    // Heute nichts → nächsten Termin der kommenden 14 Tage zeigen (statt "Heute frei"-Leerkarte)
    outer: for (let i=1;i<=14;i++){
      const d = new Date(); d.setDate(d.getDate()+i);
      for (const b of blocksFor(dayKey(d)).filter(x=>x.type!=="sleep").sort((a,c)=>a.start_min-c.start_min)){
        const t = BLOCK_TYPES[b.type]||BLOCK_TYPES.event;
        head = "📅 Demnächst";
        body = `<div style="display:flex;gap:6px;align-items:baseline;font-size:12px;line-height:1.35;overflow:hidden">
          <span style="font-weight:800;color:var(--accent2);flex-shrink:0">${i===1?"Morgen":WEEKDAYS_DE[d.getDay()]+" "+d.getDate()+"."}</span>
          <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${bAllDay(b)?"":minToHM(b.start_min)+" "}${blockIco(b)} ${esc(b.title||t.label)}</span></div>`;
        break outer;
      }
    }
  }
  let trip = "";
  if (w.nextTrip){
    const nt = w.nextTrip;
    const when = nt.dk===dayKey(new Date()) ? minToHM(nt.b.start_min) : WEEKDAYS_DE[nt.d.getDay()];
    trip = `<div style="font-size:11px;font-weight:700;color:var(--accent2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px">${travelIcon(nt.b.title)} ${when} → ${esc(nt.dest || nt.b.title || "Reise")}</div>`;
  }
  if (!body && !trip) return ""; // nichts zu zeigen → Karte ganz weglassen
  return `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:6px;margin-bottom:6px">
      <span style="font-size:11px;color:var(--dim);font-weight:800;text-transform:uppercase;letter-spacing:.04em">${head}</span>
      ${w.name?`<span style="font-size:10.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">📍 ${esc(w.name)}</span>`:""}</div>
    <div style="display:flex;flex-direction:column;gap:5px;overflow:hidden">${body}${trip}</div>${foot}`;
}

const routineLocations = () => S.locations.filter(l=>l.is_routine);
// Skincare zählt immer als Routine (steckt in Morgen-/Abendroutine), auch ohne Routine-Flag
const isRoutineTask = t => routineLocations().some(l=>l.name.toLowerCase()===(t.location||"").toLowerCase())
  || isSkincareLoc(t.location||"");

function homePlanItems(){
  // Heutiger Plan: geplante Aufgaben (mit/ohne Uhrzeit), Fällige, Prioritäten
  // Routine-Schritte erscheinen in den Routine-Karten, nicht hier
  const items = [];
  const active = S.tasks.filter(t=>!t.is_archived && isActiveWeekday(t) && startReached(t) && !isRoutineTask(t));
  active.forEach(t=>{
    const done = isCompletedToday(t);
    if (t.scheduled_date && isToday(t.scheduled_date)){
      items.push({ t, done, time: t.has_scheduled_time ? fmtTime(new Date(t.scheduled_date)) : null,
        sort: t.has_scheduled_time ? new Date(t.scheduled_date).getHours()*60+new Date(t.scheduled_date).getMinutes() : 1441 });
    } else if (!done && taskDueState(t).due){
      items.push({ t, done:false, time:null, due:true, sort: 2000 - (t.is_priority?500:0) - overdueDays(t) });
    } else if (done){
      items.push({ t, done:true, time:null, sort: 5000 });
    } else {
      // offen, aber (noch) nicht fällig – Einmaliges bleibt sichtbar, damit nichts verloren geht.
      // Wiederkehrendes (Chores) taucht erst wieder auf, wenn es laut Rhythmus dran ist.
      if (t.kind === "recurring") return;
      items.push({ t, done:false, time:null, sort: 3000 - (t.is_priority?400:0) - overdueDays(t) });
    }
  });
  items.sort((a,b)=>a.sort-b.sort);
  return items;
}

const homeCat = () => ""; // Kategorie-Dropdown entfernt – Karten sind ohnehin einklappbar
// Auf/zu-Zustand der Kategorie-Karten (pro Gerät gemerkt)
function homeCatState(){
  try { return JSON.parse(localStorage.getItem("wopHomeCatState")||"{}"); } catch(e){ return {}; }
}
function setHomeCatState(name, open){
  const st = homeCatState(); st[name] = open ? "open" : "closed";
  localStorage.setItem("wopHomeCatState", JSON.stringify(st));
}
// "Als Nächstes": aufklappbare Kategorie-Karten (Fleischmann, Hipper Machines, …)
function homeGroupedPlan(openPlan, planRow){
  if (!openPlan.length) return "";
  const PER_CAT = homeCat() ? 10 : 4;
  const groups = [];
  S.locations.filter(l=>!l.is_routine).forEach((l,i)=>{
    const arr = openPlan.filter(p=>(p.t.location||"")===l.name);
    if (arr.length) groups.push({ name:l.name, color:LOC_PALETTE[i%LOC_PALETTE.length], arr });
  });
  const rest = openPlan.filter(p=>!S.locations.some(l=>!l.is_routine && l.name===(p.t.location||"")));
  if (rest.length) groups.push({ name:"Sonstiges", color:"#7e88a0", arr:rest });
  // "Home" ganz ans Ende – Arbeit & Projekte zuerst
  const grank = g => g.name==="Home" ? 3 : g.name==="Sonstiges" ? 2 : 1;
  groups.sort((a,b)=>grank(a)-grank(b));
  const st = homeCatState();
  return groups.map(g=>{
    const hasUrgent = g.arr.some(p=>p.due || p.time);
    const isOpen = homeCat() ? true : (st[g.name] ? st[g.name]==="open" : hasUrgent); // Standard: auf, wenn was fällig ist
    const dueN = g.arr.filter(p=>p.due||p.time).length;
    return `<div class="card" style="border-left:4px solid ${g.color};${isOpen?"":"padding:11px 14px;"}">
      <div class="homecathead" data-cat="${esc(g.name)}" role="button" tabindex="0"
        style="display:flex;align-items:center;gap:8px;cursor:pointer;${isOpen?"margin-bottom:2px;":""}">
        <span style="color:var(--dim2);font-size:11px">${isOpen?"▾":"▸"}</span>
        <b style="font-size:13px">${esc(g.name)}</b>
        <span style="font-size:11.5px;color:var(--dim2);font-weight:700">${g.arr.length}</span>
        ${dueN&&!isOpen?`<span style="font-size:10.5px;font-weight:800;color:var(--amber)">${dueN} fällig</span>`:""}
        <span style="margin-left:auto"></span>
        ${g.name!=="Sonstiges"?`<button class="catplus" data-cat="${esc(g.name)}" aria-label="Aufgabe in ${esc(g.name)} anlegen"
          style="background:var(--card2);border:1px solid var(--line);color:var(--accent2);width:26px;height:26px;border-radius:8px;font-size:16px;font-weight:800;cursor:pointer;line-height:1;flex-shrink:0">＋</button>`:""}
      </div>
      ${isOpen ? g.arr.slice(0,PER_CAT).map(p=>planRow(p, g.name!=="Sonstiges")).join("")
        + (g.arr.length>PER_CAT?`<div style="text-align:center;padding-top:6px"><a class="homeMoreCat" data-loc="${esc(g.name)}" style="color:var(--accent2);font-size:12px;font-weight:700;cursor:pointer">＋ ${g.arr.length-PER_CAT} weitere ›</a></div>`:"") : ""}
      ${isOpen && g.name!=="Sonstiges" ? `<input class="cat-add-in" data-loc="${esc(g.name)}" placeholder="＋ Neue Aufgabe…" autocomplete="off" enterkeyhint="done"
        style="margin-top:8px;background:transparent;border:none;border-top:1px dashed var(--line);border-radius:0;padding:8px 2px 2px;font-size:13.5px">` : ""}
    </div>`;
  }).join("");
}

async function renderHome(){
  const el = $("#view-home");
  if (!el || S.tab!=="home") return;
  purgeDoneNotes(); // abgehakte Notizen vom letzten Mal verschwinden jetzt
  refreshGeoSilently(); // Standort still nachziehen, wenn Erlaubnis schon da ist

  // Streak (gleiche Logik wie Statistik)
  const byDay = {};
  S.completions.forEach(c=>{ const k=dayKey(new Date(c.completed_at)); byDay[k]=(byDay[k]||0)+1; });
  let streak=0; const sd=new Date();
  if (!byDay[dayKey(sd)]) sd.setDate(sd.getDate()-1);
  while (byDay[dayKey(sd)]){ streak++; sd.setDate(sd.getDate()-1); }

  // Tagesfortschritt
  const active = S.tasks.filter(t=>!t.is_archived && isActiveWeekday(t) && startReached(t));
  const dueOrPlanned = active.filter(t=>isCompletedToday(t) || taskDueState(t).due || (t.scheduled_date&&isToday(t.scheduled_date)));
  const doneN = dueOrPlanned.filter(isCompletedToday).length;
  const totalN = dueOrPlanned.length;
  const pct = totalN ? doneN/totalN : 0;
  const doneMinToday = S.completions.filter(c=>isToday(c.completed_at)).reduce((a,c)=>a+(c.minutes||0),0);

  // Arbeitszeit heute
  const run = runningEntry();
  const todayWork = S.workEntries.filter(w=>isToday(w.start_time)).reduce((a,w)=>a+workedMinutes(w),0);

  const dateStr = new Date().toLocaleDateString("de-DE",{weekday:"long",day:"numeric",month:"long"});
  const r = 32, circ = 2*Math.PI*r;

  const plan = homePlanItems();
  const openPlan = plan.filter(p=>!p.done), donePlan = plan.filter(p=>p.done);

  const planRow = (p, hideLoc) => {
    const t = p.t;
    const bits = [];
    bits.push(fmtMin(t.duration_minutes));
    if (t.location && !hideLoc) bits.push(esc(t.location)); // in Kategorie-Karten redundant
    if (!p.done && t.repeat_count>1) bits.push(`${effCompletedToday(t)}/${t.repeat_count}×`);
    const st = taskDueState(t);
    if (!p.done && st.label && st.cls) bits.push(`<span class="${st.cls}">${st.label}</span>`);
    return `<div class="planrow ${p.done?"pdone":""}" data-id="${t.id}" role="button" tabindex="0" style="padding:11px 0">
      <button class="chk ${p.done?"on":""}" data-chk="${t.id}" style="width:24px;height:24px;min-width:24px;margin:0;font-size:12px" aria-label="Erledigt">${p.done?"✓":"✓"}</button>
      ${p.time?`<span class="ptime">${p.time}</span>`:(t.is_priority?`<span class="ptime star">★</span>`:"")}
      <span class="pt">${esc(t.title)}</span>
      <span class="pm">${bits.join(" · ")}</span></div>`;
  };

  el.innerHTML = `
    <div class="home-left">
      <div class="m-sec m-ww"><div class="card" id="weekWeather"><b style="font-size:13.5px">🌤 Wetter-Woche</b><div class="section-empty">lädt…</div></div></div>
      <div class="m-sec m-planned">${plannedCardHtml()}</div>
    </div>
    <div class="home-main">
    <div class="m-sec m-hero">
    <div class="hero">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
        <div style="min-width:0">
          <div class="greet">${greetingText()}, Finn! 👋</div>
          <div class="date">${dateStr}</div>
          ${streak>0?`<div class="streakline">🔥 ${streak} Tage-Streak – weiter so!</div>`:""}
        </div>
        <div id="heroWx" class="herowx"></div>
      </div>
      <div class="xphide">${xpLineHtml()}</div>
    </div>
    ${frogCardHtml()}
    </div>

    ${(()=>{ const c = calTileHtml(); return c ? `<div class="m-sec m-quick">
      <div class="card qtile" id="calTile" role="button" tabindex="0" style="cursor:pointer">${c}</div></div>` : ""; })()}

    <div class="m-sec m-weather"><div class="card" id="weatherCard"><div class="section-empty">Wetter lädt…</div></div></div>

    <div class="m-sec m-stats"><div class="homegrid">
      <div class="card ringwrap" style="margin:0">
        <div class="ring">
          <svg width="74" height="74"><circle cx="37" cy="37" r="${r}" fill="none" stroke="var(--line)" stroke-width="7"/>
          <circle cx="37" cy="37" r="${r}" fill="none" stroke="${pct>=1?"var(--green)":"var(--accent)"}" stroke-width="7"
            stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${circ*(1-pct)}"/></svg>
          <div class="rv">${totalN?Math.round(pct*100)+"%":"–"}</div>
        </div>
        <div><div style="font-weight:800;font-size:17px">${doneN}/${totalN}</div>
        <div style="font-size:12px;color:var(--dim)">Aufgaben heute<br>${doneMinToday?fmtMin(doneMinToday)+" investiert":""}</div></div>
      </div>
      <div class="card" style="margin:0;cursor:pointer" id="homeWork">
        <div style="font-size:12px;color:var(--dim);font-weight:700;text-transform:uppercase;letter-spacing:.04em">Arbeitszeit</div>
        <div style="font-size:22px;font-weight:800;margin-top:4px">${run?fmtMin(workedMinutes(run)):(todayWork?fmtMin(todayWork):"–")}</div>
        <div style="font-size:12px;color:${run?"var(--green)":"var(--dim)"};margin-top:2px">
          ${run?(run.break_started_at?"⏸ Pause läuft":"🟢 läuft seit "+fmtTime(new Date(run.start_time))):(todayWork?"heute gearbeitet":"nicht eingestempelt")}</div>
      </div>
    </div></div>

    <div class="m-sec m-rout">${ routineCardsHtml() }</div>
    <div class="m-sec m-blocks">${ homeBlockRows() ? `<div class="homehead"><h2>📅 Termine heute</h2><a id="homeToPlan">Zum Plan ›</a></div>
    <div class="card">${homeBlockRows()}</div>` : "" }</div>
    <div class="m-sec m-next">
    <div class="homehead"><h2>📋 Als Nächstes</h2><div style="display:flex;align-items:center;gap:12px">
      <a id="homeRandom" title="Zufällig eine wählen">🎲</a>
      <a id="homeToTasks">Alle ›</a></div></div>
    ${ homeGroupedPlan(homeCat() ? openPlan.filter(p=>(p.t.location||"")===homeCat()) : openPlan, planRow)
      || `<div class="card"><div class="section-empty">${homeCat()?`In „${esc(homeCat())}" ist heute nichts offen ✨`:(totalN?"Alles erledigt – stark! 🎉":"Heute steht nichts an. Genieß den Tag ☕️")}</div></div>` }
    <button class="btn sec" id="planTomorrow" style="margin-top:2px">🌙 Morgen planen</button>
    ${donePlan.length?`<div class="card" style="opacity:.65;margin-top:10px">${donePlan.map(planRow).join("")}</div>`:""}
    </div>
    </div>
    <div class="home-side">
      <div class="m-sec m-pomo">${pomoWidgetHtml()}</div>
      <div class="m-sec m-meds">${medsCardHtml()}</div>
      <div class="m-sec m-todo">${todoPanelHtml()}</div>
      <div class="m-sec m-post">${postitHtml()}</div>
    </div>
  `;
  wirePomoWidget(el);
  wireMeds(el);
  wireTodoPanel(el);
  wirePostit(el);
  fillWeekWeather();
  wirePlannedCard(el);

  $$(".routinecard", el).forEach(c=>c.onclick=()=>openRoutine(c.dataset.loc));
  $("#homeToTasks").onclick = ()=>switchTab("tasks");
  const hp = $("#homeToPlan"); if (hp) hp.onclick = ()=>{ S.planDate=dayKey(new Date()); switchTab("plan"); };
  $$("[data-block]", el).forEach(row=>row.onclick=()=>{
    const b=S.timeBlocks.find(x=>x.id===row.dataset.block); if(b) openBlockForm(b);
  });
  $("#homeWork").onclick = ()=>switchTab("work");
  const ct = $("#calTile"); if (ct) ct.onclick = ()=>{ S.planDate=dayKey(new Date()); switchTab("plan"); };
  $$(".homecathead", el).forEach(h=>h.onclick = ()=>{
    const name = h.dataset.cat;
    const st = homeCatState();
    const cur = st[name] ? st[name]==="open" : h.textContent.includes("▾");
    setHomeCatState(name, !cur);
    renderHome();
  });
  // ＋ am Karten-Kopf: Karte öffnen und direkt ins Eingabefeld springen
  $$(".catplus", el).forEach(bt=>bt.onclick = (e)=>{
    e.stopPropagation();
    setHomeCatState(bt.dataset.cat, true);
    S._focusCatAdd = bt.dataset.cat;
    renderHome();
  });
  // Schnell-Anlegen direkt in der Kategorie
  $$(".cat-add-in", el).forEach(inp=>{
    inp.addEventListener("keydown", async e=>{
      if (e.key !== "Enter") return;
      e.preventDefault();
      const title = inp.value.trim(); if (!title) return;
      inp.value = "";
      const loc = inp.dataset.loc;
      const { error } = await sb.from("tasks").insert({ title, duration_minutes:15, location:loc, kind:"oneOff" });
      if (error) return toast("Anlegen fehlgeschlagen: "+error.message, true);
      toast(`✓ „${title}" → ${loc}`);
      S._focusCatAdd = loc; // nach dem Neu-Rendern wieder fokussieren (mehrere nacheinander)
      loadAll();
    });
  });
  if (S._focusCatAdd){
    const fi = $(`.cat-add-in[data-loc="${CSS.escape(S._focusCatAdd)}"]`, el);
    S._focusCatAdd = null;
    if (fi) fi.focus();
  }
  $$(".homeMoreCat", el).forEach(a=>a.onclick = ()=>{
    S.locFilter = S.locations.some(l=>l.name===a.dataset.loc) ? a.dataset.loc : "ALLE";
    switchTab("tasks");
  });
  const pt = $("#planTomorrow"); if (pt) pt.onclick = openPlanTomorrow;
  const rnd = $("#homeRandom"); if (rnd) rnd.onclick = ()=>{
    const cand = homePlanItems().filter(p=>!p.done && dependencySatisfied(p.t) && !inCooldown(p.t));
    if (!cand.length) return toast("Nichts offen – genieß es!");
    const pick = cand[Math.floor(Math.random()*cand.length)].t;
    startFocusTask(pick.id);
  };
  const fc = $(".frogcard", el);
  if (fc){ const fb = $("[data-frogstart]", fc); if (fb) fb.onclick = ()=>startFocusTask(fb.dataset.frogstart); }
  $$(".planrow[data-id]", el).forEach(row=>{
    const t = S.tasks.find(x=>x.id===row.dataset.id);
    const chk = $("[data-chk]", row);
    if (chk) chk.onclick = (e)=>{ e.stopPropagation();
      if (!t) return;
      if (isCompletedToday(t)) uncompleteToday(t);
      else { celebrate(e.currentTarget, xpForCompletion(t.duration_minutes, t.is_priority)); completeTask(t); }
    };
    row.onclick = ()=>{ if(t) openTaskForm(t); };
  });

  // Wetter asynchron nachladen
  const wc = $("#weatherCard");
  const wt = $("#heroWx");
  const geo = localStorage.getItem("wopGeo");
  if (!geo){
    wc.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <div style="font-size:14px;color:var(--dim)">🌤 Wetter anzeigen?</div>
      <div style="display:flex;gap:8px">
        <button class="btn small sec" id="btnGeo">📍 Standort</button>
        <button class="btn small" id="btnCity">🏙 Ort eingeben</button></div></div>`;
    $("#btnGeo").onclick = askGeo;
    $("#btnCity").onclick = openCityPicker;
    if (wt){
      wt.innerHTML = `<button class="btn small sec" id="btnCityH" style="white-space:nowrap">🌤 Ort wählen</button>`;
      $("#btnCityH").onclick = openCityPicker;
    }
  } else {
    const w = await fetchWeather();
    if (!w || !w.current){
      wc.innerHTML = `<div class="section-empty">Wetter gerade nicht verfügbar.</div>`;
      if (wt) wt.innerHTML = `<div class="section-empty" style="padding:6px 0">Wetter nicht verfügbar</div>`;
    }
    else {
      const [ico,txt] = WMO[w.current.weather_code] || ["🌡","–"];
      const dmax = Math.round(w.daily.temperature_2m_max[0]), dmin = Math.round(w.daily.temperature_2m_min[0]);
      const rain = w.daily.precipitation_probability_max[0];
      const [ico2] = WMO[w.daily.weather_code[1]] || ["–"];
      const locName = (_effGeo && _effGeo.name) || (JSON.parse(geo)||{}).name || "";
      wc.innerHTML = `<div class="weather">
        <div class="wico">${ico}</div>
        <div><div class="wtemp">${Math.round(w.current.temperature_2m)}°</div><div class="wdesc">${txt}${locName?" · "+esc(locName):""}</div></div>
        <div class="wmeta">H ${dmax}° · T ${dmin}°<br>☔️ ${rain??0}% · 💨 ${Math.round(w.current.wind_speed_10m)} km/h<br>Morgen: ${ico2} ${Math.round(w.daily.temperature_2m_max[1])}°</div>
      </div>
      <div style="text-align:right;margin-top:6px"><a style="font-size:11.5px;color:var(--dim2);cursor:pointer" id="wChange">Standort ändern</a></div>`;
      $("#wChange").onclick = openCityPicker;
      if (wt){
        wt.innerHTML = `
          <div style="display:flex;align-items:center;gap:7px;justify-content:flex-end">
            <span style="font-size:27px;line-height:1">${ico}</span>
            <span style="font-size:24px;font-weight:800">${Math.round(w.current.temperature_2m)}°</span>
          </div>
          <div style="font-size:10.5px;color:var(--dim);text-align:right;margin-top:3px;white-space:nowrap">
            H ${dmax}° · T ${dmin}°${(rain??0)>=30?` · ☔️ ${rain}%`:""}<br>Morgen: ${ico2} ${Math.round(w.daily.temperature_2m_max[1])}°</div>`;
        wt.style.cursor = "pointer";
        wt.onclick = openCityPicker;
      }
    }
  }
}

// ============================================================
// Plan (Kalender mit Zeitblöcken – wie in der iOS-App)
// ============================================================
const BLOCK_TYPES = {
  work:   { label:"Arbeit",  ico:"💼", color:"#5b8def" },
  home:   { label:"Zuhause", ico:"🏠", color:"#3ddc84" },
  travel: { label:"Fahrt",   ico:"🚗", color:"#ff9f43" },
  event:  { label:"Termin",  ico:"📌", color:"#b58cff" },
  routine:{ label:"Routine", ico:"🔁", color:"#38d4c3" },
  free:   { label:"Freizeit",ico:"✨", color:"#ffd54f" },
  sleep:  { label:"Schlaf",  ico:"🌙", color:"#7986cb" },
};
const BLOCK_PALETTE = { red:"#ff5d6c", orange:"#ff9f43", yellow:"#ffd54f", green:"#3ddc84",
  teal:"#38d4c3", blue:"#5b8def", indigo:"#7986cb", purple:"#b58cff", pink:"#f48fb1", brown:"#a1887f" };
const blockColor = b => (b.color && BLOCK_PALETTE[b.color]) || (BLOCK_TYPES[b.type]||BLOCK_TYPES.event).color;
// Reise-Icon nach Verkehrsmittel im Titel (✈️ Flug, 🚆 Zug, 🚌 Bus, ⛴ Fähre, sonst 🚗)
function travelIcon(title){
  const t = String(title||"").toLowerCase();
  if (/flug|flieg|flight|✈/.test(t)) return "✈️";
  if (/zug|bahn|train|railjet|🚆|🚄/.test(t)) return "🚆";
  if (/\bbus\b/.test(t)) return "🚌";
  if (/schiff|fähre|ferry/.test(t)) return "⛴";
  return "🚗";
}
function blockIco(b){ return b.type==="travel" ? travelIcon(b.title) : (BLOCK_TYPES[b.type]||BLOCK_TYPES.event).ico; }
const minToHM = m => `${pad(Math.floor(m/60))}:${pad(m%60)}`;
const blocksFor = dk => S.timeBlocks.filter(b=>b.date===dk).sort((a,b)=>a.start_min-b.start_min);

function renderPlan(){
  const el = $("#view-plan");
  if (!S.planDate) S.planDate = dayKey(new Date());
  const sel = new Date(S.planDate+"T12:00:00");

  // Wochenleiste (Mo–So der Woche des gewählten Tags)
  const mon = new Date(sel); mon.setDate(mon.getDate() - ((mon.getDay()+6)%7));
  let strip = `<div class="weekstrip">`;
  for (let i=0;i<7;i++){
    const d = new Date(mon); d.setDate(d.getDate()+i);
    const dk = dayKey(d);
    const dots = blocksFor(dk).slice(0,4).map(b=>`<i style="background:${blockColor(b)}"></i>`).join("");
    strip += `<button class="${dk===S.planDate?"sel":""}" data-d="${dk}">
      <span>${WEEKDAYS_DE[d.getDay()]}</span><b>${d.getDate()}</b><span class="dots">${dots}</span></button>`;
  }
  strip += `</div>`;

  const monthStr = sel.toLocaleDateString("de-DE",{month:"long",year:"numeric"});
  const isTodaySel = S.planDate===dayKey(new Date());
  const nav = `<div class="plannav">
    <button class="iconbtn" id="pl_prev">‹</button>
    <b>${sel.toLocaleDateString("de-DE",{weekday:"long",day:"numeric",month:"long"})}${isTodaySel?" · heute":""}</b>
    <div><button class="btn small sec" id="pl_today" ${isTodaySel?"disabled":""}>Heute</button>
    <button class="iconbtn" id="pl_next">›</button></div></div>`;

  // Ganztägige Blöcke (00:00–23:59 oder um Mitternacht) als Banner, nicht in der Timeline
  const isAllDay = b => b.start_min<=0 && (b.end_min>=1439 || b.end_min<=60);
  const all = blocksFor(S.planDate);
  const allDayBlocks = all.filter(b=>isAllDay(b) && b.type!=="sleep");
  const blocks = all.filter(b=>!(isAllDay(b) && b.type!=="sleep"));
  let banner = "";
  if (allDayBlocks.length){
    banner = `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">` + allDayBlocks.map(b=>{
      const c = blockColor(b), t = BLOCK_TYPES[b.type]||BLOCK_TYPES.event;
      return `<div class="tl-allday" data-id="${b.id}" role="button" tabindex="0" style="background:${c}22;border:1px solid ${c}55;
        border-left:4px solid ${c};border-radius:10px;padding:7px 12px;font-size:13px;font-weight:700;cursor:pointer">
        ${blockIco(b)} ${esc(b.title||t.label)} <span style="font-weight:500;opacity:.65;font-size:11.5px">ganztägig</span></div>`;
    }).join("") + `</div>`;
  }
  // Timeline 05–24 Uhr (Blöcke davor werden geklemmt)
  const H0=5, PXH=34, top = m => Math.max(0,(m/60-H0))*PXH;
  let tl = `<div class="timeline" style="height:${(24-H0)*PXH+10}px">`;
  for (let h=H0; h<=24; h++)
    tl += `<div class="tl-hour" style="top:${(h-H0)*PXH}px"><span>${pad(h%24)}:00</span></div>`;
  if (isTodaySel){
    const nowM = new Date().getHours()*60+new Date().getMinutes();
    if (nowM >= H0*60) tl += `<div class="tl-now" style="top:${top(nowM)}px"></div>`;
  }
  blocks.forEach(b=>{
    const end = b.end_min > b.start_min ? b.end_min : 1440;
    const h = Math.max(20, top(end)-top(b.start_min)-2);
    const c = blockColor(b);
    const t = BLOCK_TYPES[b.type]||BLOCK_TYPES.event;
    tl += `<div class="tl-block" data-id="${b.id}" role="button" tabindex="0" style="top:${top(b.start_min)+1}px;height:${h}px;
      background:${c}22;border-left-color:${c}">
      <b>${blockIco(b)} ${esc(b.title||t.label)}</b>
      ${h>34?`<span>${minToHM(b.start_min)}–${minToHM(b.end_min)}${b.notes?" · "+esc(b.notes):""}</span>`:""}</div>`;
  });
  tl += `</div>`;
  const empty = blocks.length ? "" : `<div class="section-empty" style="text-align:center;padding-top:10px">Noch keine Blöcke – mit + einen anlegen (Arbeit, Termin, Fahrt …)</div>`;

  el.innerHTML = `<div class="plan-day">` + nav + strip + banner + tl + empty + `<div style="height:8px"></div></div>`
    + `<div class="plan-week card">${planWeekHtml()}</div>`
    + `<div class="plan-month"><div class="card">${planMonthHtml()}</div><div class="card">${planUpcomingHtml()}</div></div>`;
  wirePlanPanels(el);

  $$(".weekstrip button", el).forEach(b=>b.onclick=()=>{ S.planDate=b.dataset.d; renderPlan(); });
  const shift = days => { const d=new Date(S.planDate+"T12:00:00"); d.setDate(d.getDate()+days); S.planDate=dayKey(d); renderPlan(); };
  $("#pl_prev").onclick = ()=>shift(-1);
  $("#pl_next").onclick = ()=>shift(1);
  $("#pl_today").onclick = ()=>{ S.planDate=dayKey(new Date()); renderPlan(); };
  $$(".tl-block, .tl-allday", el).forEach(x=>x.onclick=()=>{
    const b=S.timeBlocks.find(y=>y.id===x.dataset.id); if(b) openBlockForm(b);
  });
}

// Mehrtägige Blöcke (z.B. Flug Mi 17:45 → Do 15:00) in Tages-Blöcke aufteilen
function splitBlockRows(base, startDate, endDate, startMin, endMin){
  if (!endDate || endDate <= startDate)
    return [{ ...base, date:startDate, start_min:startMin, end_min:endMin }];
  const rows = [{ ...base, date:startDate, start_min:startMin, end_min:1439 }];
  const d = new Date(startDate+"T12:00:00");
  for (let i=0; i<14; i++){
    d.setDate(d.getDate()+1);
    const k = dayKey(d);
    if (k < endDate){ rows.push({ ...base, date:k, start_min:0, end_min:1439 }); } // Zwischentage = ganztägig
    else { rows.push({ ...base, date:k, start_min:0, end_min:endMin }); break; }   // Ankunftstag bis Endzeit
  }
  return rows;
}

function openBlockForm(b){
  const isNew = !b;
  b = b || { date:S.planDate||dayKey(new Date()), type:"event", start_min:540, end_min:600, title:"", notes:"", color:"" };
  const typeOpts = Object.entries(BLOCK_TYPES).map(([k,v])=>
    `<option value="${k}" ${b.type===k?"selected":""}>${v.ico} ${v.label}</option>`).join("");
  const colorBtns = Object.entries(BLOCK_PALETTE).map(([k,v])=>
    `<button type="button" class="cbtn ${b.color===k?"on":""}" data-c="${k}" style="width:30px;height:30px;border-radius:50%;
     border:3px solid ${b.color===k?"#fff":"transparent"};background:${v};cursor:pointer"></button>`).join("");
  openModal(`
    <h3>${isNew?"Neuer Block":"Block bearbeiten"}</h3>
    <label>Titel</label><input id="b_title" value="${esc(b.title)}" placeholder="z.B. Zahnarzt, Büro, Zugfahrt…">
    <div class="mrow">
      <div><label>Datum</label><input type="date" id="b_date" value="${b.date}"></div>
      <div><label>Art</label><select id="b_type">${typeOpts}</select></div>
    </div>
    <div class="mrow">
      <div><label>Von</label><input type="time" id="b_start" value="${minToHM(b.start_min)}"></div>
      <div><label>Bis</label><input type="time" id="b_end" value="${minToHM(b.end_min)}"></div>
    </div>
    <label>Endet an anderem Tag? (z.B. Nachtflug)</label>
    <input type="date" id="b_dateEnd" value="${b.date}">
    <label>Eigene Farbe (optional)</label>
    <div style="display:flex;gap:7px;flex-wrap:wrap;padding:4px 0">${colorBtns}</div>
    <label>Notiz</label><input id="b_notes" value="${esc(b.notes)}">
    <div style="height:18px"></div>
    <button class="btn" id="b_save">${isNew?"Anlegen":"Speichern"}</button>
    ${isNew?"":`<div style="height:8px"></div><button class="btn danger" id="b_del">Löschen</button>`}
  `);
  let color = b.color||"";
  $$(".cbtn").forEach(x=>x.onclick=()=>{
    color = (color===x.dataset.c) ? "" : x.dataset.c;
    $$(".cbtn").forEach(y=>y.style.border=`3px solid ${color===y.dataset.c?"#fff":"transparent"}`);
  });
  const hmToMin = v => { const [h,m]=v.split(":").map(Number); return h*60+(m||0); };
  $("#b_save").onclick = async ()=>{
    const row = {
      date: $("#b_date").value, title: $("#b_title").value.trim(),
      type: $("#b_type").value, notes: $("#b_notes").value, color,
      start_min: hmToMin($("#b_start").value||"09:00"), end_min: hmToMin($("#b_end").value||"10:00"),
    };
    if (!row.date) return toast("Bitte Datum wählen.", true);
    const endDate = $("#b_dateEnd").value || row.date;
    if (endDate < row.date) return toast("Ende-Datum liegt vor dem Beginn.", true);
    if (endDate > row.date){
      // Mehrtägig: in Tages-Blöcke aufteilen (Tag 1 bis Mitternacht, Ankunftstag ab 00:00)
      const rows = splitBlockRows({ title:row.title, type:row.type, notes:row.notes, color:row.color },
        row.date, endDate, row.start_min, row.end_min);
      let error = null;
      if (isNew) ({ error } = await sb.from("time_blocks").insert(rows));
      else {
        ({ error } = await sb.from("time_blocks").update(rows[0]).eq("id", b.id));
        if (!error) ({ error } = await sb.from("time_blocks").insert(rows.slice(1)));
      }
      if (error) return toast("Fehler: "+error.message, true);
      S.planDate = row.date; closeModal();
      toast(`Über ${rows.length} Tage angelegt ✓`); loadAll(); return;
    }
    if (row.end_min <= row.start_min && row.type!=="sleep") return toast("Ende muss nach Beginn liegen.", true);
    const q = isNew ? sb.from("time_blocks").insert(row) : sb.from("time_blocks").update(row).eq("id", b.id);
    const { error } = await q;
    if (error) return toast("Fehler: "+error.message+(error.message.includes("time_blocks")?" – update-kalender.sql ausführen!":""), true);
    S.planDate = row.date;
    closeModal(); loadAll();
  };
  if (!isNew) armDelete($("#b_del"), async ()=>{
    const { error } = await sb.from("time_blocks").delete().eq("id", b.id);
    if (error) return toast("Löschen fehlgeschlagen: "+error.message, true);
    closeModal(); toast("Gelöscht"); loadAll();
  });
}

// ============================================================
// 💬 Assistent (OpenAI, Key bleibt lokal auf dem Gerät)
// ============================================================
const AI_TOOLS = [
  { type:"function", function:{ name:"create_task",
    description:"Neue Aufgabe anlegen",
    parameters:{ type:"object", properties:{
      title:{type:"string"}, duration_minutes:{type:"integer",description:"geschätzte Dauer, Standard 15"},
      location:{type:"string",description:"Ort/Liste, muss einer der vorhandenen Orte sein"},
      kind:{type:"string",enum:["oneOff","recurring"]},
      recurrence:{type:"string",enum:["daily","weekly","customDays"]},
      custom_recurrence_days:{type:"integer"},
      is_priority:{type:"boolean"},
      due_date:{type:"string",description:"YYYY-MM-DD, optional"},
      scheduled_date:{type:"string",description:"YYYY-MM-DD - Tag, an dem die Aufgabe/Erinnerung ansteht. Aufgabe erscheint erst ab dem VORTAG in den Listen."},
      scheduled_time:{type:"string",description:"HH:MM - Uhrzeit am scheduled_date. Löst zu dieser Zeit eine Push-Erinnerung mit Erledigt-Button aus."},
      notes:{type:"string"}, tags:{type:"array",items:{type:"string"}},
    }, required:["title"] } } },
  { type:"function", function:{ name:"create_appointment",
    description:"Termin/Zeitblock im Kalender anlegen. Ohne start/end = ganztägiger Termin.",
    parameters:{ type:"object", properties:{
      date:{type:"string",description:"YYYY-MM-DD"},
      end_date:{type:"string",description:"YYYY-MM-DD – NUR wenn der Termin an einem anderen Tag endet (Nachtflug, mehrtägige Reise)"},
      title:{type:"string"},
      start:{type:"string",description:"HH:MM, weglassen für ganztägig"}, end:{type:"string",description:"HH:MM, weglassen für ganztägig"},
      type:{type:"string",enum:["work","home","travel","event","routine","free","sleep"],description:"Standard: event"},
      notes:{type:"string"},
    }, required:["date","title"] } } },
  { type:"function", function:{ name:"update_appointment",
    description:"Bestehenden Termin ändern (bei Korrekturen/Nachträgen IMMER das statt create_appointment!). Findet den Termin per Titel (unscharf) und Datum.",
    parameters:{ type:"object", properties:{
      title:{type:"string",description:"Titel des bestehenden Termins"},
      date:{type:"string",description:"YYYY-MM-DD des bestehenden Termins"},
      new_title:{type:"string"}, new_date:{type:"string",description:"YYYY-MM-DD"},
      new_start:{type:"string",description:"HH:MM"}, new_end:{type:"string",description:"HH:MM"},
      all_day:{type:"boolean",description:"true = ganztägig machen"},
      new_type:{type:"string",enum:["work","home","travel","event","routine","free","sleep"]},
      notes:{type:"string"},
    }, required:["title","date"] } } },
  { type:"function", function:{ name:"update_task",
    description:"Bestehende Aufgabe ändern (bei Korrekturen IMMER das statt create_task!). Findet die Aufgabe per Titel (unscharf).",
    parameters:{ type:"object", properties:{
      title:{type:"string",description:"Titel der bestehenden Aufgabe"},
      new_title:{type:"string"}, duration_minutes:{type:"integer"}, location:{type:"string"},
      is_priority:{type:"boolean"}, due_date:{type:"string",description:"YYYY-MM-DD"},
      scheduled_date:{type:"string",description:"YYYY-MM-DD"}, scheduled_time:{type:"string",description:"HH:MM"},
      notes:{type:"string"},
    }, required:["title"] } } },
  { type:"function", function:{ name:"add_work_entry",
    description:"Arbeitszeit-Eintrag nachtragen. Ohne account = Hauptjob (Fleischmann); Nebenkonten (Mozarteumorchester, Hipper Machines) haben ein eigenes Zeitkonto ohne Soll.",
    parameters:{ type:"object", properties:{
      date:{type:"string",description:"YYYY-MM-DD"},
      start:{type:"string",description:"HH:MM"}, end:{type:"string",description:"HH:MM"},
      break_minutes:{type:"integer"}, notes:{type:"string"},
      account:{type:"string",description:"Zeitkonto, z.B. Mozarteumorchester oder Hipper Machines – weglassen für den Hauptjob"},
    }, required:["date","start","end"] } } },
  { type:"function", function:{ name:"add_absence",
    description:"Urlaub, Krankstand oder Feiertag eintragen – Werktage zählen als Soll-Gutschrift bei der Arbeitszeit",
    parameters:{ type:"object", properties:{
      start_date:{type:"string",description:"YYYY-MM-DD"},
      end_date:{type:"string",description:"YYYY-MM-DD, leer = nur ein Tag"},
      kind:{type:"string",enum:["urlaub","krank","feiertag"]},
    }, required:["start_date"] } } },
  { type:"function", function:{ name:"complete_task",
    description:"Eine Aufgabe als erledigt abhaken (per Titel, unscharfe Suche)",
    parameters:{ type:"object", properties:{ title:{type:"string"} }, required:["title"] } } },
  { type:"function", function:{ name:"delete_appointment",
    description:"Termin/Zeitblock löschen (per Titel und Datum)",
    parameters:{ type:"object", properties:{
      title:{type:"string"}, date:{type:"string",description:"YYYY-MM-DD"} }, required:["title","date"] } } },
];

// Kompakte Arbeitszeit-Zusammenfassung für den Assistenten
function workStatsSummary(){
  const mode = getSetting("workTargetMode","month");
  const target = mode==="week" ? getSetting("weeklyTargetMinutes",2310) : getSetting("monthlyTargetMinutes",4800);
  const curKey = periodKeyOf(new Date(), mode);
  const accs = workAccounts();
  const mainE = S.workEntries.filter(w=>entryAcc(w)===accs[0]); // Soll/Saldo nur für den Hauptjob
  const absAll = getAbsences();
  const workedThis = mainE.filter(w=>periodKeyOf(w.start_time,mode)===curKey).reduce((a,w)=>a+workedMinutes(w),0);
  const absThis = absAll.filter(a=>periodKeyOf(a.date+"T12:00:00",mode)===curKey).reduce((a,x)=>a+(x.min||0),0);
  const byPeriod = {};
  mainE.filter(w=>w.end_time).forEach(w=>{ const k=periodKeyOf(w.start_time,mode); if(k!==curKey) byPeriod[k]=(byPeriod[k]||0)+workedMinutes(w); });
  absAll.forEach(a=>{ const k=periodKeyOf(a.date+"T12:00:00",mode); if(k!==curKey) byPeriod[k]=(byPeriod[k]||0)+(a.min||0); });
  const balance = Object.values(byPeriod).reduce((a,v)=>a+(v-target),0);
  const todayMin = mainE.filter(w=>isToday(w.start_time)).reduce((a,w)=>a+workedMinutes(w),0);
  const wkKey = periodKeyOf(new Date(),"week");
  const weekMin = mainE.filter(w=>periodKeyOf(w.start_time,"week")===wkKey).reduce((a,w)=>a+workedMinutes(w),0);
  const mKey = periodKeyOf(new Date(),"month");
  const sides = accs.slice(1).map(a=>({ name:a,
    month: S.workEntries.filter(w=>entryAcc(w)===a && periodKeyOf(w.start_time,"month")===mKey).reduce((s,w)=>s+workedMinutes(w),0) }));
  return { mode, target, workedThis, absThis, balance, todayMin, weekMin, main:accs[0], sides };
}

function aiContext(){
  const today = new Date();
  const dk = dayKey(today);
  const openTasks = S.tasks.filter(t=>!t.is_archived && !isCompletedToday(t)).slice(0,60)
    .map(t=>`- ${t.title} (${t.location||"?"}${t.is_priority?", ⭐":""}${t.due_date?", fällig "+dayKey(new Date(t.due_date)):""})`).join("\n");
  const week = [];
  for (let i=0;i<7;i++){ const d=new Date(); d.setDate(d.getDate()+i); const k=dayKey(d);
    const bl=blocksFor(k); if(bl.length) week.push(`${k} (${WEEKDAYS_DE[d.getDay()]}): `+bl.map(b=>`${minToHM(b.start_min)}-${minToHM(b.end_min)} ${b.title||b.type}`).join("; ")); }

  // Live-Daten für Auskünfte
  const ws = workStatsSummary();
  const runE = runningEntry();
  const doneToday = S.completions.filter(c=>isToday(c.completed_at));
  const byDayC = {}; S.completions.forEach(c=>{ byDayC[dayKey(new Date(c.completed_at))]=1; });
  let stk=0; const sdd=new Date(); if(!byDayC[dayKey(sdd)]) sdd.setDate(sdd.getDate()-1);
  while(byDayC[dayKey(sdd)]){ stk++; sdd.setDate(sdd.getDate()-1); }
  const li = levelInfo();
  const upAbs = getAbsences().filter(a=>a.date>=dk).sort((a,b)=>a.date<b.date?-1:1).slice(0,14);
  const dataBlock = `LIVE-DATEN (für Auskünfte – nutze diese Zahlen, rate nie):
- Arbeitszeit ${ws.main} heute: ${fmtMin(ws.todayMin)}${runE?` (läuft gerade seit ${fmtTime(new Date(runE.start_time))} auf Konto ${entryAcc(runE)})`:""} · diese Woche: ${fmtMin(ws.weekMin)}
- Nebenkonten diesen Monat: ${ws.sides.map(s=>`${s.name} ${fmtMin(s.month)}`).join(" · ")||"keine"}
- ${ws.mode==="week"?"Wochen":"Monats"}-Soll: ${fmtMin(ws.target)} · aktuelle Periode: ${fmtMin(ws.workedThis+ws.absThis)}${ws.absThis?` (davon Urlaub/Abwesenheit ${fmtMin(ws.absThis)})`:""} · Überstunden-Saldo: ${ws.balance>=0?"+":""}${fmtMin(ws.balance)}
- Heute erledigt: ${doneToday.length} Aufgabe(n) (${fmtMin(doneToday.reduce((a,c)=>a+(c.minutes||0),0))})${doneToday.length?": "+doneToday.slice(0,8).map(c=>c.title).join(", "):""}
- Streak: ${stk} Tag(e) · Level ${li.level} · ${li.xp.toLocaleString("de-DE")} XP
- Kommende Abwesenheiten: ${upAbs.length?upAbs.map(a=>`${a.date} (${a.kind})`).join(", "):"keine"}`;

  return `Du bist der persönliche Assistent der deutschsprachigen To-Do-App "Procrastination Lists" von Finn.
Heute ist ${today.toLocaleDateString("de-DE",{weekday:"long",day:"2-digit",month:"2-digit",year:"numeric"})} (${dk}), Uhrzeit ${fmtTime(today)}.
Du kannst per Tools Aufgaben, Termine (Zeitblöcke) und Arbeitszeiten anlegen, Aufgaben abhaken und Termine löschen.
Du bist außerdem AUSKUNFT: Fragen wie "Was steht morgen an?", "Wie viel hab ich diese Woche gearbeitet?", "Wie ist mein Saldo?", "Was hab ich heute geschafft?" beantwortest du direkt und konkret mit den Zahlen aus LIVE-DATEN, den offenen Aufgaben und dem Kalender unten – ohne Tool-Aufruf. Sei dabei ein echter Assistent: Fasse zusammen, denk mit (z.B. "dein Tag ist eng, die 3 Aufgaben passen zwischen 14 und 16 Uhr") und schlag proaktiv Nächstes vor, wenn es hilft.
Relative Datumsangaben ("morgen", "Freitag") immer in konkrete Daten umrechnen. Bei fehlender Endzeit eines Termins nimm 1 Stunde.
ERINNERUNGEN ("erinnere mich am X um Y an Z"): create_task mit scheduled_date + scheduled_time und is_priority=true. Die App blendet sie automatisch erst ab dem Vortag ein und schickt zur Uhrzeit eine Push-Nachricht. WICHTIG: Eine Erinnerung für HEUTE ist SOFORT sichtbar und der Push kommt heute zur Uhrzeit – sag dann NIE "erscheint ab morgen". Übernimm die Sichtbarkeits-Info wörtlich aus dem Tool-Ergebnis.
KORREKTUREN: Wenn sich eine Nachricht auf einen gerade angelegten/besprochenen Eintrag bezieht ("bis 23 Uhr", "doch ohne Uhrzeit", "verschieb auf Montag"), IMMER update_appointment/update_task verwenden – NIE einen zweiten Eintrag anlegen.
Termin ohne Uhrzeit ("nur Hinweis, dass er kommt"): create_appointment OHNE start/end -> ganztägig.
REISEN ("Freitag Flug nach Wien 14 Uhr", "Montag mit dem Zug nach Salzburg"): create_appointment mit type=travel und Titel mit Verkehrsmittel + Ziel, z.B. "Flug nach Wien" oder "Zug Salzburg → Wien". Das Ziel steuert dann automatisch Wetter-Woche und 📍-Anzeige.
Endet eine Reise an einem ANDEREN Tag (Nachtflug: "Mittwoch 17:45 Abflug, Ankunft Donnerstag 15:00"): zusätzlich end_date setzen – start=Abflugzeit, end=Ankunftszeit (Ortszeit).
URLAUB/KRANK ("ich bin nächste Woche auf Urlaub", "war gestern krank"): add_absence – Werktage zählen automatisch als Arbeitszeit-Gutschrift.
Verfügbare Orte/Listen: ${S.locations.map(l=>l.name).join(", ")}. Wenn kein Ort passt, nimm "To-Do".
Antworte kurz, freundlich, auf Deutsch. Fasse nach Tool-Aufrufen knapp zusammen, was du angelegt hast.

Offene Aufgaben:
${openTasks||"(keine)"}

Kalender der nächsten 7 Tage:
${week.join("\n")||"(leer)"}`;
}

async function aiExecTool(name, args){
  const hm = v => { const [h,m]=String(v||"0:0").split(":").map(Number); return h*60+(m||0); };
  try {
    if (name==="create_task"){
      const row = { title:args.title, duration_minutes:args.duration_minutes||15,
        location: S.locations.some(l=>l.name===(args.location||""))?args.location:(S.locations.find(l=>l.name==="To-Do")?.name||S.locations[0]?.name||""),
        kind:args.kind||"oneOff", recurrence:args.recurrence||"daily",
        custom_recurrence_days:args.custom_recurrence_days||2,
        is_priority:!!args.is_priority, notes:args.notes||"", tags:args.tags||[],
        due_date: args.due_date ? new Date(args.due_date+"T23:59:00").toISOString() : null };
      let info = `Aufgabe "${args.title}" angelegt (${row.location})`;
      if (args.scheduled_date){
        row.scheduled_date = args.scheduled_date + "T" + (args.scheduled_time||"09:00") + ":00";
        row.has_scheduled_time = !!args.scheduled_time;
        // Erst am Vortag in den Listen auftauchen
        const prev = new Date(args.scheduled_date+"T00:00:00"); prev.setDate(prev.getDate()-1);
        row.start_date = dayKey(prev) + "T00:00:00";
        const sofort = args.scheduled_date <= dayKey(new Date());
        info = `Erinnerung "${args.title}" für ${args.scheduled_date}${args.scheduled_time?" "+args.scheduled_time:""} – ${sofort?"ab sofort in der Liste sichtbar":"erscheint ab "+dayKey(prev)}${args.scheduled_time?", Push um "+args.scheduled_time:""}`;
      }
      const { error } = await sb.from("tasks").insert(row);
      if (error) throw error;
      return { ok:true, info };
    }
    if (name==="create_appointment"){
      const allDay = !args.start && !args.end;
      if (!allDay && args.end_date && args.end_date > args.date){
        // Mehrtägig (Nachtflug etc.): in Tages-Blöcke aufteilen
        const rows = splitBlockRows({ title:args.title, type:args.type||"event", notes:args.notes||"", color:"" },
          args.date, args.end_date, hm(args.start), hm(args.end||args.start));
        const { error } = await sb.from("time_blocks").insert(rows);
        if (error) throw error;
        return { ok:true, info:`"${args.title}": ${args.date} ${minToHM(hm(args.start))} bis ${args.end_date} ${minToHM(hm(args.end||args.start))} angelegt` };
      }
      const row = { date:args.date, title:args.title, type:args.type||"event",
        start_min: allDay ? 0 : hm(args.start), end_min: allDay ? 1439 : hm(args.end||args.start),
        notes:args.notes||"", color:"" };
      if (!allDay && row.end_min<=row.start_min) row.end_min = row.start_min+60;
      const { error } = await sb.from("time_blocks").insert(row);
      if (error) throw error;
      return { ok:true, info: allDay ? `Termin "${args.title}" am ${args.date} (ganztägig)` : `Termin "${args.title}" am ${args.date} ${minToHM(row.start_min)}–${minToHM(row.end_min)}` };
    }
    if (name==="update_appointment"){
      const q = (args.title||"").toLowerCase();
      const b = S.timeBlocks.find(x=>x.date===args.date && (x.title||"").toLowerCase().includes(q))
        || S.timeBlocks.find(x=>(x.title||"").toLowerCase().includes(q));
      if (!b) return { ok:false, info:`Kein Termin "${args.title}" gefunden.` };
      const upd = {};
      if (args.new_title) upd.title = args.new_title;
      if (args.new_date) upd.date = args.new_date;
      if (args.all_day){ upd.start_min = 0; upd.end_min = 1439; }
      else {
        if (args.new_start) upd.start_min = hm(args.new_start);
        if (args.new_end) upd.end_min = hm(args.new_end);
      }
      if (args.new_type) upd.type = args.new_type;
      if (args.notes !== undefined) upd.notes = args.notes;
      const { error } = await sb.from("time_blocks").update(upd).eq("id", b.id);
      if (error) throw error;
      const s = upd.start_min ?? b.start_min, e2 = upd.end_min ?? b.end_min;
      return { ok:true, info:`Termin "${upd.title||b.title}" geändert: ${upd.date||b.date} ${args.all_day?"(ganztägig)":minToHM(s)+"–"+minToHM(e2)}` };
    }
    if (name==="update_task"){
      const q = (args.title||"").toLowerCase();
      const t = S.tasks.find(x=>!x.is_archived && x.title.toLowerCase().includes(q));
      if (!t) return { ok:false, info:`Keine Aufgabe "${args.title}" gefunden.` };
      const upd = {};
      if (args.new_title) upd.title = args.new_title;
      if (args.duration_minutes) upd.duration_minutes = args.duration_minutes;
      if (args.location && S.locations.some(l=>l.name===args.location)) upd.location = args.location;
      if (args.is_priority !== undefined) upd.is_priority = !!args.is_priority;
      if (args.due_date) upd.due_date = new Date(args.due_date+"T23:59:00").toISOString();
      if (args.notes !== undefined) upd.notes = args.notes;
      if (args.scheduled_date){
        upd.scheduled_date = args.scheduled_date + "T" + (args.scheduled_time||"09:00") + ":00";
        upd.has_scheduled_time = !!args.scheduled_time;
        const prev = new Date(args.scheduled_date+"T00:00:00"); prev.setDate(prev.getDate()-1);
        upd.start_date = dayKey(prev) + "T00:00:00";
      }
      const { error } = await sb.from("tasks").update(upd).eq("id", t.id);
      if (error) throw error;
      return { ok:true, info:`Aufgabe "${upd.title||t.title}" aktualisiert` };
    }
    if (name==="add_work_entry"){
      const st = new Date(`${args.date}T${args.start}:00`), en = new Date(`${args.date}T${args.end}:00`);
      let accV = null;
      if (args.account){
        const m = workAccounts().find(a=>a.toLowerCase().includes(String(args.account).toLowerCase()));
        if (m && m !== workAccounts()[0]) accV = m;
      }
      const { error } = await sb.from("work_entries").insert({ start_time:st.toISOString(), end_time:en.toISOString(),
        break_minutes:args.break_minutes||0, notes:args.notes||"", account: accV });
      if (error) throw error;
      return { ok:true, info:`Arbeitszeit ${args.date} ${args.start}–${args.end} eingetragen (${accV||workAccounts()[0]})` };
    }
    if (name==="add_absence"){
      const from = args.start_date, to = args.end_date || args.start_date;
      const min = absDayMinutesDefault();
      const list = getAbsences().slice(); let n = 0;
      const d = new Date(from+"T12:00:00"), end = new Date(to+"T12:00:00");
      while (d <= end && n < 400){
        const k = dayKey(d), dow = d.getDay();
        if (dow>=1 && dow<=5 && !list.some(a=>a.date===k)){
          list.push({ id:crypto.randomUUID(), date:k, kind:args.kind||"urlaub", min }); n++;
        }
        d.setDate(d.getDate()+1);
      }
      await saveAbsences(list);
      return { ok:true, info:`${n} Abwesenheitstag${n!==1?"e":""} (${args.kind||"urlaub"}) eingetragen: ${from}${to!==from?" bis "+to:""}` };
    }
    if (name==="complete_task"){
      const q = (args.title||"").toLowerCase();
      const t = S.tasks.find(x=>!x.is_archived && !isCompletedToday(x) && x.title.toLowerCase().includes(q));
      if (!t) return { ok:false, info:`Keine offene Aufgabe gefunden, die zu "${args.title}" passt.` };
      await completeTask(t);
      return { ok:true, info:`"${t.title}" abgehakt` };
    }
    if (name==="delete_appointment"){
      const q = (args.title||"").toLowerCase();
      const b = S.timeBlocks.find(x=>x.date===args.date && (x.title||"").toLowerCase().includes(q));
      if (!b) return { ok:false, info:`Kein Termin "${args.title}" am ${args.date} gefunden.` };
      const { error } = await sb.from("time_blocks").delete().eq("id", b.id);
      if (error) throw error;
      return { ok:true, info:`Termin "${b.title}" am ${args.date} gelöscht` };
    }
    return { ok:false, info:"Unbekanntes Tool" };
  } catch(e){ return { ok:false, info:"Fehler: "+(e.message||e) }; }
}

function openChat(){
  openModal(`
    <h3 style="margin-bottom:10px">💬 Assistent</h3>
    <div class="chatwrap">
      <div class="chatlog" id="chatLog"></div>
      <div class="chatinput">
        <button id="chatMic" style="background:var(--card2);color:var(--text)" title="Sprechen" aria-label="Sprechen">🎤</button>
        <input id="chatIn" placeholder="Tippen oder 🎤 sprechen…" autocomplete="off">
        <button id="chatSend">➤</button>
      </div>
    </div>
  `);
  renderChat();
  $("#chatMic").onclick = toggleVoice;
  $("#chatSend").onclick = sendChat;
  $("#chatIn").addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); sendChat(); } });
  if (!localStorage.getItem("wopAiKey")){
    $("#chatLog").innerHTML = `<div class="cmsg sys" style="margin-top:20px">Der Assistent braucht einmalig deinen OpenAI API-Key.</div>
      <button class="btn" id="chatKeyBtn" style="margin-top:10px">🔑 Key jetzt hinterlegen</button>`;
    $("#chatKeyBtn").onclick = ()=>{ closeModal(); openSettings();
      setTimeout(()=>{ const k=$("#s_aikey"); if(k){ k.scrollIntoView({block:"center"}); k.focus(); } }, 250); };
    return;
  } else if (!S.chat.length){
    S.chat.push({ role:"bot", text:"Hi Finn! Was soll ich für dich eintragen? Termine, Aufgaben oder Arbeitszeiten – sag's einfach. 😊" });
    renderChat();
  }
  setTimeout(()=>$("#chatIn") && $("#chatIn").focus(), 150);
}

// Schwebende Assistenten-Leiste: einmalig verdrahten (statisches Markup in index.html)
function wireChatBar(){
  const bar = $("#chatBar"); if (!bar) return;
  $("#chatMic").onclick = toggleVoice;
  $("#chatSend").onclick = sendChat;
  $("#chatIn").addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); sendChat(); } });
  $("#chatIn").addEventListener("focus", ()=>{
    if (!localStorage.getItem("wopAiKey")) toast("Für den Assistenten erst den OpenAI-Key in ⚙️ speichern.");
  });
  $("#chatPanelClose").onclick = ()=>$("#chatPanel").classList.add("hidden");
}

function renderChat(){
  const log = $("#chatLog"); if (!log) return;
  // Antworten-Panel automatisch aufklappen, sobald es etwas zu zeigen gibt
  const panel = $("#chatPanel");
  if (panel && (S.chat.length || S.chatBusy)) panel.classList.remove("hidden");
  log.innerHTML = S.chat.map(m=>{
    const cls = m.role==="user"?"user":m.role==="act"?"act":m.role==="sys"?"sys":"bot";
    return `<div class="cmsg ${cls}">${esc(m.text)}</div>`;
  }).join("") + (S.chatBusy?`<div class="typing">Assistent denkt…</div>`:"");
  log.scrollTop = log.scrollHeight;
}

async function sendChat(){
  const inp = $("#chatIn");
  const text = inp.value.trim();
  if (!text || S.chatBusy) return;
  const key = localStorage.getItem("wopAiKey");
  if (!key){ toast("Erst API-Key in ⚙️ Einstellungen speichern.", true); return; }
  inp.value = "";
  S.chat.push({ role:"user", text });
  S.chatBusy = true; renderChat();

  // Nachrichtenverlauf für die API (nur user/bot-Texte)
  const msgs = [{ role:"system", content: aiContext() }];
  S.chat.filter(m=>m.role==="user"||m.role==="bot").slice(-12)
    .forEach(m=>msgs.push({ role: m.role==="user"?"user":"assistant", content:m.text }));

  try {
    let rounds = 0, didWrite = false;
    while (rounds++ < 5){
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method:"POST",
        headers:{ "Authorization":"Bearer "+key, "Content-Type":"application/json" },
        body: JSON.stringify({ model:"gpt-4o-mini", messages:msgs, tools:AI_TOOLS, tool_choice:"auto", temperature:0.3 })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message||"API-Fehler");
      const msg = d.choices[0].message;
      msgs.push(msg);
      if (msg.tool_calls && msg.tool_calls.length){
        for (const tc of msg.tool_calls){
          let args={}; try{ args=JSON.parse(tc.function.arguments||"{}"); }catch(e){}
          const res = await aiExecTool(tc.function.name, args);
          if (res.ok){ didWrite = true; S.chat.push({ role:"act", text:"✓ "+res.info }); renderChat(); }
          msgs.push({ role:"tool", tool_call_id:tc.id, content: JSON.stringify(res) });
        }
        continue; // nächste Runde: Modell fasst zusammen
      }
      S.chat.push({ role:"bot", text: msg.content || "Erledigt." });
      break;
    }
    if (didWrite) loadAll();
  } catch(e){
    S.chat.push({ role:"sys", text:"⚠️ "+(e.message||"Verbindung fehlgeschlagen") });
  }
  S.chatBusy = false; renderChat();
}

// ============================================================
// Routinen (Orte mit 🔁 – Checkliste, resettet täglich)
// ============================================================
function routineMeta(name){
  const n = name.toLowerCase();
  if (n.includes("morning")||n.includes("morgen")) return { ico:"🌅", color:"#ff9f43" };
  if (n.includes("workout")||n.includes("sport"))  return { ico:"🏃", color:"#3ddc84" };
  if (n.includes("skincare")||n.includes("pflege"))return { ico:"✨", color:"#f48fb1" };
  if (n.includes("evening")||n.includes("abend"))  return { ico:"🌙", color:"#7986cb" };
  return { ico:"🔁", color:"#38d4c3" };
}
function routineTasksFor(name){
  const filtered = S.tasks.filter(t => !t.is_archived && isActiveWeekday(t) &&
    (t.location||"").trim().toLowerCase() === name.trim().toLowerCase());
  const open = filtered.filter(t=>!isCompletedToday(t)).sort((a,b)=>(a.sort_order-b.sort_order)||a.title.localeCompare(b.title));
  const done = filtered.filter(isCompletedToday).sort((a,b)=>(a.sort_order-b.sort_order)||a.title.localeCompare(b.title));
  return open.concat(done);
}

// Skincare steckt in Morgen- UND Abendroutine (kein eigenes Kärtchen)
const isSkincareLoc = name => /skincare|pflege/i.test(name);
function mergedRoutineTasks(name){
  let ts = routineTasksFor(name);
  if (/evening|abend|morning|morgen/i.test(name)){
    // Alle Skincare-Aufgaben dazu – egal ob der Ort ein Routine-Flag hat oder nicht
    const skinc = S.tasks.filter(t=>!t.is_archived && isActiveWeekday(t) && isSkincareLoc(t.location||""));
    skinc.forEach(t=>{ if (!ts.some(x=>x.id===t.id)) ts.push(t); });
    ts = ts.filter(t=>!isCompletedToday(t)).concat(ts.filter(isCompletedToday));
  }
  return ts;
}
// Karte zeigen? Fertige Routinen verschwinden; Abend erst ab 21 Uhr; Skincare nie eigenständig
function routineCardVisible(l, tasks){
  if (!tasks.length) return false;
  if (tasks.every(isCompletedToday)) return false;
  const n = l.name.toLowerCase();
  if (isSkincareLoc(n)) return false;
  if (/evening|abend/.test(n)) return new Date().getHours() >= 21;
  return true;
}

function routineCardsHtml(){
  const locs = routineLocations();
  if (!locs.length) return "";
  const cards = locs.map(l=>{
    const tasks = mergedRoutineTasks(l.name);
    if (!routineCardVisible(l, tasks)) return "";
    const done = tasks.filter(isCompletedToday).length;
    const all = done===tasks.length;
    const m = routineMeta(l.name);
    return `<div class="card routinecard" data-loc="${esc(l.name)}" role="button" tabindex="0" style="margin:0;cursor:pointer;border-left:4px solid ${m.color}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <b style="font-size:14px">${m.ico} ${esc(l.name)}</b>
        <span style="font-size:12.5px;font-weight:800;color:${all?"var(--green)":m.color}">${all?"✓ fertig":done+"/"+tasks.length}</span>
      </div>
      <div class="subprog" style="margin-top:9px"><div style="width:${tasks.length?100*done/tasks.length:0}%;background:${m.color}"></div></div>
    </div>`;
  }).filter(Boolean);
  if (!cards.length) return "";
  return `<div class="homehead"><h2>🔁 Routinen</h2></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:4px">${cards.join("")}</div>`;
}

function openRoutine(name){
  const tasks = mergedRoutineTasks(name);
  const m = routineMeta(name);
  const done = tasks.filter(isCompletedToday).length;
  const all = tasks.length && done===tasks.length;
  const rows = tasks.map(t=>{
    const d = isCompletedToday(t);
    const eff = effCompletedToday(t);
    return `<div class="subrow ${d?"on":""}" data-id="${t.id}" style="padding:10px 0;font-size:15px;border-bottom:1px solid var(--line)">
      <span class="box" style="width:24px;height:24px;min-width:24px;border-radius:50%;font-size:13px">✓</span>
      <span style="flex:1">${esc(t.title)}</span>
      <span style="font-size:12px;color:var(--dim)">${t.repeat_count>1?`${eff}/${t.repeat_count}× · `:""}${fmtMin(t.duration_minutes)}</span>
    </div>`;
  }).join("");
  openModal(`
    <h3>${m.ico} ${esc(name)}</h3>
    ${ all ? `<div class="msg ok" style="display:block;text-align:center">🎉 Alles erledigt – stark!</div>`
      : `<div style="display:flex;align-items:center;gap:10px;margin-top:6px">
          <span style="font-size:13px;color:var(--dim)">${done} von ${tasks.length}</span>
          <div class="subprog" style="flex:1;margin:0"><div style="width:${tasks.length?100*done/tasks.length:0}%;background:${m.color}"></div></div>
        </div>` }
    <div style="margin-top:10px">${rows || `<div class="section-empty">Keine Schritte – lege Aufgaben mit Ort „${esc(name)}" an.</div>`}</div>
    <div style="height:14px"></div>
    ${ tasks.filter(t=>!isCompletedToday(t)).length ? `<button class="btn" id="rt_start" style="background:${m.color};color:#0d1017">▶ Der Reihe nach starten</button><div style="height:8px"></div>` : "" }
    <button class="btn sec" id="rt_add">+ Schritt hinzufügen</button>
  `);
  const rs = $("#rt_start");
  if (rs) rs.onclick = ()=>{
    const queue = tasks.filter(t=>!isCompletedToday(t)).map(t=>t.id);
    closeModal();
    startFocusTask(queue[0], { queue: queue.slice(1), label: name });
  };
  $$("#modalBox .subrow").forEach(row=>{
    row.onclick = async ()=>{
      const t = S.tasks.find(x=>x.id===row.dataset.id);
      if (!t) return;
      if (isCompletedToday(t)) await uncompleteToday(t); else await completeTask(t);
      openRoutine(name); // Ansicht aktualisieren
    };
  });
  $("#rt_add").onclick = ()=>{ closeModal(); S.locFilter=name; openTaskForm(null); };
}

// ============================================================
// 🔔 Push-Benachrichtigungen (Web Push)
// ============================================================
const VAPID_PUBLIC_KEY = "BLdwfKKcOwvbxe72eJdsXwe8XgFmH4dWnH1BNYeKnvTBsOGmxGkXk6rNfLjK84Wu9ffQHEdNNwscNN9uOJiSr4M";

function b64ToU8(base64){
  const pad = "=".repeat((4 - base64.length % 4) % 4);
  const b = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b); const arr = new Uint8Array(raw.length);
  for (let i=0;i<raw.length;i++) arr[i]=raw.charCodeAt(i);
  return arr;
}

// Hat sich der VAPID-Key geändert? Dann das Geräte-Abo automatisch erneuern.
let _pushMigrated = false;
async function migratePushKey(){
  if (_pushMigrated) return; _pushMigrated = true;
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (!sub || !sub.options || !sub.options.applicationServerKey) return;
    const cur = new Uint8Array(sub.options.applicationServerKey);
    const want = b64ToU8(VAPID_PUBLIC_KEY);
    if (cur.length === want.length && cur.every((v,i)=>v===want[i])) return; // alles aktuell
    await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
    const s2 = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: want });
    const j = s2.toJSON();
    await sb.from("push_subscriptions").upsert({ endpoint:s2.endpoint, p256dh:j.keys.p256dh, auth:j.keys.auth,
      device: navigator.userAgent.slice(0,120) }, { onConflict:"endpoint" });
    toast("🔔 Push-Abo erneuert (neuer Schlüssel)");
  } catch(e){ console.warn("Push-Key-Migration fehlgeschlagen:", e); }
}

async function pushStatus(){
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return "off";
    const sub = await reg.pushManager.getSubscription();
    return sub ? "on" : "off";
  } catch(e){ return "unsupported"; }
}

async function enablePush(){
  try {
    if (!("PushManager" in window)){
      const isiOS = /iphone|ipad/i.test(navigator.userAgent);
      toast(isiOS ? "Am iPhone/iPad zuerst die App zum Home-Bildschirm hinzufügen und von dort öffnen." : "Dieser Browser unterstützt keine Push-Nachrichten.", true);
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted"){ toast("Benachrichtigungen wurden nicht erlaubt.", true); return; }
    const reg = await navigator.serviceWorker.ready;
    // Altes Abo (evtl. mit altem Schlüssel) immer erst sauber entfernen
    const old = await reg.pushManager.getSubscription();
    if (old){ try { await sb.from("push_subscriptions").delete().eq("endpoint", old.endpoint); await old.unsubscribe(); } catch(e){} }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToU8(VAPID_PUBLIC_KEY),
    });
    const j = sub.toJSON();
    const { error } = await sb.from("push_subscriptions").upsert(
      { endpoint: sub.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
        device: navigator.userAgent.slice(0,120) }, { onConflict: "endpoint" });
    if (error) throw error;
    toast("🔔 Benachrichtigungen auf diesem Gerät aktiv!");
  } catch(e){ toast("Aktivierung fehlgeschlagen: "+(e.message||e), true); }
  renderNotifySettings();
}

async function disablePush(){
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  if (sub){
    await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  }
  toast("Benachrichtigungen auf diesem Gerät aus.");
  renderNotifySettings();
}

// Test-Push über die Edge Function: prüft die komplette Kette (Function → VAPID → Abo → Gerät)
async function sendTestPush(btn){
  btn.disabled = true; const orig = btn.textContent; btn.textContent = "Sende…";
  try {
    const { data } = await sb.auth.getSession();
    const token = data && data.session && data.session.access_token;
    if (!token) throw new Error("keine Session");
    const r = await fetch(`${SUPABASE_URL}/functions/v1/push?action=test`, {
      method: "POST", headers: { Authorization: "Bearer " + token } });
    const d = await r.json().catch(()=>null);
    if (r.ok && d && d.delivered > 0)
      toast(`✅ An ${d.delivered} Gerät${d.delivered>1?"e":""} gesendet – gleich müsste es klingeln!`);
    else if (r.ok && d && d.devices === 0)
      toast("Kein Gerät angemeldet – Push oben zuerst aktivieren.", true);
    else if (r.ok && d)
      toast(`0 zugestellt, ${d.failed} fehlgeschlagen${d.lastError?": "+d.lastError:" – VAPID-Key/Abos prüfen."}`, true);
    else if (r.status === 404)
      toast("Edge Function antwortet nicht – neu deployen (edge-function-push.ts)!", true);
    else
      toast(`Test fehlgeschlagen (${r.status}) – Edge Function schon neu deployed?`, true);
  } catch(e){ toast("Test fehlgeschlagen: " + (e.message||e), true); }
  btn.disabled = false; btn.textContent = orig;
}

async function renderNotifySettings(){
  const box = $("#s_notifyBox"); if (!box) return;
  const status = await pushStatus();
  const digestOn = getSetting("notifyDigestEnabled", false);
  const digestMin = getSetting("notifyDigestMin", 480);
  const alarmsOn = getSetting("notifyBlockAlarms", true);
  const lead = getSetting("notifyBlockLead", 30);
  const weeklyOn = getSetting("notifyWeeklyEnabled", true);
  const weeklyMin = getSetting("notifyWeeklyMin", 1080);
  const briefOn = getSetting("notifyBriefEnabled", true);
  const briefMin = getSetting("notifyBriefMin", 420);
  const hmv = m => `${pad(Math.floor(m/60))}:${pad(m%60)}`;
  const routines = S.locations.filter(l=>l.is_routine);

  box.innerHTML = `
    ${ status==="unsupported" ? `<div class="section-empty">Auf iPhone/iPad: App zuerst über Teilen → „Zum Home-Bildschirm" installieren und von dort öffnen – dann geht's.</div>` : `
    <div class="switch"><label>${status==="on"?"✅ Aktiv auf diesem Gerät":"Auf diesem Gerät aktivieren"}</label>
      <button class="toggle ${status==="on"?"on":""}" id="n_toggle"></button></div>` }
    <button class="btn small sec" id="n_test" style="margin:6px 0 10px">🔔 Test-Push senden</button>
    <div class="switch"><label>📋 Tages-Überblick (fällige Aufgaben)</label>
      <button class="toggle ${digestOn?"on":""}" id="n_digest"></button></div>
    <div class="mrow" ${digestOn?"":'style="display:none"'} id="n_digestrow">
      <div><label>Uhrzeit</label><input type="time" id="n_digesttime" value="${hmv(digestMin)}"></div><div></div>
    </div>
    <div class="switch"><label>📌 Termin-Alarme (Termine & Fahrten)</label>
      <button class="toggle ${alarmsOn?"on":""}" id="n_alarms"></button></div>
    <div class="mrow" ${alarmsOn?"":'style="display:none"'} id="n_leadrow">
      <div><label>Vorlauf (Minuten)</label><input type="number" min="0" id="n_lead" value="${lead}"></div><div></div>
    </div>
    <div class="switch"><label>🌅 Morgen-Briefing (Wetter, Termine, Frosch)</label>
      <button class="toggle ${briefOn?"on":""}" id="n_brief"></button></div>
    <div class="mrow" ${briefOn?"":'style="display:none"'} id="n_briefrow">
      <div><label>Uhrzeit</label><input type="time" id="n_brieftime" value="${hmv(briefMin)}"></div><div></div>
    </div>
    <div class="switch"><label>🌙 Sonntags-Review (Wochenrückblick)</label>
      <button class="toggle ${weeklyOn?"on":""}" id="n_weekly"></button></div>
    <div class="mrow" ${weeklyOn?"":'style="display:none"'} id="n_weeklyrow">
      <div><label>Uhrzeit (Sonntag)</label><input type="time" id="n_weeklytime" value="${hmv(weeklyMin)}"></div><div></div>
    </div>
    ${ routines.length ? `<label style="margin-top:14px">Routine-Erinnerungen</label>` + routines.map(l=>`
      <div class="switch" data-loc="${l.id}">
        <label>${routineMeta(l.name).ico} ${esc(l.name)}</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="time" class="n_rtime" data-loc="${l.id}" value="${hmv(l.routine_notify_min??420)}" style="width:auto" ${l.routine_notify_enabled?"":"disabled"}>
          <button class="toggle n_rtoggle ${l.routine_notify_enabled?"on":""}" data-loc="${l.id}"></button>
        </div>
      </div>`).join("") : "" }
  `;

  const hmToMin = v => { const [h,m]=v.split(":").map(Number); return h*60+(m||0); };
  const nt = $("#n_toggle");
  if (nt) nt.onclick = ()=> nt.classList.contains("on") ? disablePush() : enablePush();
  const tb = $("#n_test");
  if (tb) tb.onclick = ()=>sendTestPush(tb);
  $("#n_digest").onclick = async e=>{
    await saveSetting("notifyDigestEnabled", !digestOn); renderNotifySettings();
  };
  const dt = $("#n_digesttime");
  if (dt) dt.onchange = ()=>saveSetting("notifyDigestMin", hmToMin(dt.value));
  $("#n_alarms").onclick = async ()=>{ await saveSetting("notifyBlockAlarms", !alarmsOn); renderNotifySettings(); };
  $("#n_brief").onclick = async ()=>{ await saveSetting("notifyBriefEnabled", !briefOn); renderNotifySettings(); };
  const btI = $("#n_brieftime");
  if (btI) btI.onchange = ()=>saveSetting("notifyBriefMin", hmToMin(btI.value));
  $("#n_weekly").onclick = async ()=>{ await saveSetting("notifyWeeklyEnabled", !weeklyOn); renderNotifySettings(); };
  const wtI = $("#n_weeklytime");
  if (wtI) wtI.onchange = ()=>saveSetting("notifyWeeklyMin", hmToMin(wtI.value));
  const ld = $("#n_lead");
  if (ld) ld.onchange = ()=>saveSetting("notifyBlockLead", Math.max(0,+ld.value||30));
  $$(".n_rtoggle").forEach(b=>b.onclick = async ()=>{
    const l = S.locations.find(x=>x.id===b.dataset.loc);
    await sb.from("locations").update({ routine_notify_enabled: !l.routine_notify_enabled }).eq("id", l.id);
    await loadAll(); renderNotifySettings();
  });
  $$(".n_rtime").forEach(inp=>inp.onchange = async ()=>{
    await sb.from("locations").update({ routine_notify_min: hmToMin(inp.value) }).eq("id", inp.dataset.loc);
    loadAll();
  });
}

// ============================================================
// 🌙 Morgen planen – abends Aufgaben für den Folgetag auswählen
// ============================================================
function openPlanTomorrow(){
  const tom = new Date(Date.now()+86400000);
  const tomKey = dayKey(tom);
  const tomWeekday = tom.getDay()+1;
  const candidates = S.tasks.filter(t => !t.is_archived && !isRoutineTask(t))
    .filter(t => {
      const days = t.active_weekdays||[];
      return !days.length || days.includes(tomWeekday); // morgen überhaupt aktiv?
    })
    .sort((a,b) => {
      const aSel = a.scheduled_date && dayKey(new Date(a.scheduled_date))===tomKey ? 1:0;
      const bSel = b.scheduled_date && dayKey(new Date(b.scheduled_date))===tomKey ? 1:0;
      return (bSel-aSel) || (b.is_priority-a.is_priority) || (overdueDays(b)-overdueDays(a));
    });
  const selected = new Set(candidates.filter(t => t.scheduled_date && dayKey(new Date(t.scheduled_date))===tomKey).map(t=>t.id));
  const original = new Set(selected);

  const savedFrog = getSetting("frog", null);
  let frogSel = (savedFrog && savedFrog.date===tomKey) ? savedFrog.taskId : null;
  const rowHtml = t => {
    const on = selected.has(t.id);
    return `<div class="subrow ${on?"on":""}" data-id="${t.id}" style="padding:10px 0;font-size:15px;border-bottom:1px solid var(--line)">
      <span class="box" style="width:24px;height:24px;min-width:24px;border-radius:7px;font-size:13px">✓</span>
      <span style="flex:1">${t.is_priority?"★ ":""}${esc(t.title)}</span>
      <span style="font-size:12px;color:var(--dim)">${esc(t.location||"")} · ${fmtMin(t.duration_minutes)}</span>
      <button class="iconbtn frogbtn" data-frog="${t.id}" title="Frosch des Tages" style="padding:4px 6px;font-size:16px;opacity:${frogSel===t.id?1:.3}">🐸</button>
    </div>`;
  };
  const totalMin = () => candidates.filter(t=>selected.has(t.id)).reduce((a,t)=>a+t.duration_minutes,0);

  openModal(`
    <h3>🌙 Morgen planen</h3>
    <p style="color:var(--dim);font-size:13.5px;margin:4px 0 10px">
      ${tom.toLocaleDateString("de-DE",{weekday:"long",day:"numeric",month:"long"})} –
      Wähle aus, was du morgen erledigen willst. Die Auswahl steht dir morgen ganz oben in „Als Nächstes".</p>
    <style>#pt_list .subrow.on span{text-decoration:none;color:var(--text);}</style>
    <div style="position:sticky;top:-20px;background:var(--bg2);padding:6px 0;z-index:5;font-size:13px;font-weight:700" id="pt_count"></div>
    <div id="pt_list">${candidates.map(rowHtml).join("") || `<div class="section-empty">Keine offenen Aufgaben.</div>`}</div>
    <label>🧠 Brain Dump – alles raus aus dem Kopf (eine Zeile = eine neue Aufgabe für morgen)</label>
    <textarea id="pt_dump" rows="3" placeholder="Paket abholen&#10;Mama zurückrufen&#10;…"></textarea>
    <div style="height:16px"></div>
    <button class="btn" id="pt_save">Plan speichern</button>
  `);
  const updateCount = ()=>{ $("#pt_count").textContent = `${selected.size} ausgewählt · ca. ${fmtMin(totalMin())}`; };
  updateCount();
  $$("#pt_list .subrow").forEach(row=>{
    const fb = $(".frogbtn", row);
    fb.onclick = (e)=>{
      e.stopPropagation();
      frogSel = (frogSel===fb.dataset.frog) ? null : fb.dataset.frog;
      if (frogSel) selected.add(row.dataset.id), row.classList.add("on");
      $$("#pt_list .frogbtn").forEach(x=>x.style.opacity = (frogSel===x.dataset.frog) ? 1 : .3);
      updateCount();
    };
    row.onclick = (e)=>{
      if (e.target.closest(".frogbtn")) return;
      const id = row.dataset.id;
      selected.has(id) ? selected.delete(id) : selected.add(id);
      if (!selected.has(id) && frogSel===id){ frogSel=null; $(".frogbtn",row).style.opacity=.3; }
      row.classList.toggle("on", selected.has(id));
      updateCount();
    };
  });
  $("#pt_save").onclick = async ()=>{
    const btn = $("#pt_save"); btn.disabled = true; btn.textContent = "Speichere…";
    const jobs = [];
    for (const t of candidates){
      const now = selected.has(t.id), was = original.has(t.id);
      if (now && !was)
        jobs.push(sb.from("tasks").update({ scheduled_date: tomKey+"T09:00:00", has_scheduled_time:false }).eq("id", t.id));
      if (!now && was)
        jobs.push(sb.from("tasks").update({ scheduled_date: null, has_scheduled_time:false }).eq("id", t.id));
    }
    // Brain Dump: jede Zeile -> neue To-Do-Aufgabe für morgen
    const dumpLines = ($("#pt_dump").value||"").split("\n").map(x=>x.trim()).filter(Boolean);
    for (const line of dumpLines){
      jobs.push(sb.from("tasks").insert({ title: line, duration_minutes: 15,
        location: todoLocationName(), kind:"oneOff",
        scheduled_date: tomKey+"T09:00:00", has_scheduled_time:false }));
    }
    const res = await Promise.all(jobs);
    const err = res.find(r=>r.error);
    if (err){ toast("Speichern fehlgeschlagen: "+err.error.message, true); btn.disabled=false; btn.textContent="Plan speichern"; return; }
    await saveSetting("frog", frogSel ? { date: tomKey, taskId: frogSel } : null);
    closeModal();
    toast(`🌙 ${selected.size + dumpLines.length} Aufgabe${(selected.size+dumpLines.length)===1?"":"n"} für morgen geplant${frogSel?" · 🐸 Frosch gesetzt":""}`);
    loadAll();
  };
}

// ============================================================
// ☑️ To-Do-Panel am Heute-Screen (rechts auf Mac/iPad, unten am iPhone)
// ============================================================
// ============================================================
// ▶️ NOW: Abarbeitungs-Reihenfolge für heute (Drag & Drop, synchron via settings)
// ============================================================
function getNowList(){ const l = getSetting("nowList", []); return Array.isArray(l) ? l : []; }
async function saveNowList(l){ S.settings.nowList = l; await saveSetting("nowList", l); }

function nowCardHtml(){
  // Einträge, deren Aufgabe es nicht mehr gibt (erledigt & archiviert), fliegen aus der Anzeige
  const list = getNowList().filter(it => !it.taskId || S.tasks.some(t=>t.id===it.taskId && !t.is_archived));
  const rows = list.map((it, i)=>{
    const t = it.taskId ? S.tasks.find(x=>x.id===it.taskId) : null;
    const done = t ? isCompletedToday(t) : !!it.done;
    return `<div class="nowrow ${done?"pdone":""}" data-nid="${esc(it.id)}">
      <span class="nowgrip" data-grip="${esc(it.id)}" aria-label="Verschieben">⠿</span>
      <span class="nownum">${i+1}</span>
      <button class="chk ${done?"on":""}" data-nowchk="${esc(it.id)}" aria-label="Erledigt">✓</button>
      <span class="pt">${esc(t ? t.title : (it.text||""))}</span>
      ${t?`<span style="font-size:11px;color:var(--dim2);white-space:nowrap">${fmtMin(t.duration_minutes)}</span>
        <button class="iconbtn nowplay" data-play="${t.id}" style="padding:2px 6px;font-size:13px" aria-label="Fokus starten">▶</button>`:""}
      <button class="iconbtn nowdel" data-del="${esc(it.id)}" style="padding:2px 6px;color:var(--dim2);font-size:13px" aria-label="Entfernen">✕</button>
    </div>`;
  }).join("");
  return `<div class="card" id="nowCard" style="border-left:4px solid var(--green)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <b style="font-size:14px">▶️ Now – der Reihe nach</b>
      <button class="btn small sec" id="nowPick" style="width:auto;padding:6px 12px">＋ Aufgaben</button>
    </div>
    <div id="nowRows">${rows}</div>
    ${rows?"":`<div class="section-empty" style="padding:4px 0">Deine Reihenfolge für jetzt: ＋ Aufgaben wählen oder unten eigenen Punkt tippen.</div>`}
    <input id="nowAdd" placeholder="＋ Eigener Punkt, Enter…" autocomplete="off" enterkeyhint="done"
      style="margin-top:6px;background:transparent;border:none;border-top:1px dashed var(--line);border-radius:0;padding:8px 2px 2px;font-size:13.5px">
  </div>`;
}

function openNowPicker(){
  const inList = new Set(getNowList().map(it=>it.taskId).filter(Boolean));
  const cats = {};
  S.tasks.filter(t=>!t.is_archived && !isRoutineTask(t) && !isCompletedToday(t) && startReached(t))
    .forEach(t=>{ const k=t.location||"Sonstiges"; (cats[k]=cats[k]||[]).push(t); });
  openModal(`<h3>▶️ Now zusammenstellen</h3>
    <div style="font-size:12.5px;color:var(--dim)">Antippen = rein/raus. Sortieren dann per ⠿ auf der Karte.</div>` +
    Object.entries(cats).map(([loc,arr])=>`
      <label style="margin-top:12px">${esc(loc)}</label>
      ${arr.map(t=>`<div class="subrow nowpick ${inList.has(t.id)?"on":""}" data-tid="${t.id}">
        <span class="box">✓</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title)}</span>
        <span style="font-size:11px;color:var(--dim2)">${fmtMin(t.duration_minutes)}</span></div>`).join("")}`).join("") +
    `<div style="height:14px"></div><button class="btn" id="nowPickDone">Fertig</button>`);
  $$(".nowpick").forEach(r=>r.onclick = ()=>{
    const tid = r.dataset.tid;
    let l = getNowList();
    if (l.some(it=>it.taskId===tid)) l = l.filter(it=>it.taskId!==tid);
    else l.push({ id: uid(), taskId: tid });
    S.settings.nowList = l; saveSetting("nowList", l);
    r.classList.toggle("on");
  });
  $("#nowPickDone").onclick = ()=>{ closeModal(); renderAll(); };
}

function wireNowCard(root){
  const card = $("#nowCard", root); if (!card) return;
  $("#nowPick", card).onclick = openNowPicker;
  const add = $("#nowAdd", card);
  add.addEventListener("keydown", async e=>{
    if (e.key !== "Enter") return;
    e.preventDefault();
    const text = add.value.trim(); if (!text) return;
    add.value = "";
    const l = getNowList(); l.push({ id: uid(), text });
    await saveNowList(l); renderAll();
    setTimeout(()=>{ const ni=$("#nowAdd"); if(ni) ni.focus(); }, 50);
  });
  $$("[data-nowchk]", card).forEach(b=>b.onclick = async (e)=>{
    e.stopPropagation();
    const l = getNowList(); const it = l.find(x=>x.id===b.dataset.nowchk); if (!it) return;
    if (it.taskId){
      const t = S.tasks.find(x=>x.id===it.taskId); if (!t) return;
      if (isCompletedToday(t)) uncompleteToday(t);
      else { celebrate(e.currentTarget, xpForCompletion(t.duration_minutes, t.is_priority)); completeTask(t); }
    } else {
      it.done = !it.done; await saveNowList(l); renderAll();
    }
  });
  $$("[data-del]", card).forEach(b=>b.onclick = async (e)=>{
    e.stopPropagation();
    await saveNowList(getNowList().filter(x=>x.id!==b.dataset.del)); renderAll();
  });
  $$("[data-play]", card).forEach(b=>b.onclick = (e)=>{ e.stopPropagation(); startFocusTask(b.dataset.play); });
  // Drag & Drop am ⠿-Griff (Pointer Events: Maus + Touch)
  const wrap = $("#nowRows", card);
  $$(".nowgrip", card).forEach(g=>{
    g.addEventListener("pointerdown", e=>{
      e.preventDefault();
      const row = g.closest(".nowrow");
      row.classList.add("dragging");
      try { g.setPointerCapture(e.pointerId); } catch(_){}
      const move = ev=>{
        const others = [...wrap.querySelectorAll(".nowrow")].filter(r=>r!==row);
        for (const r of others){
          const rect = r.getBoundingClientRect();
          if (ev.clientY < rect.top + rect.height/2){ wrap.insertBefore(row, r); return; }
        }
        wrap.appendChild(row);
      };
      const up = async ()=>{
        g.removeEventListener("pointermove", move);
        g.removeEventListener("pointerup", up);
        g.removeEventListener("pointercancel", up);
        row.classList.remove("dragging");
        const old = getNowList();
        const order = [...wrap.querySelectorAll(".nowrow")].map(r=>old.find(x=>x.id===r.dataset.nid)).filter(Boolean);
        // nicht angezeigte Einträge (archivierte Tasks) hinten anhängen, damit nichts verloren geht
        old.forEach(x=>{ if (!order.includes(x)) order.push(x); });
        await saveNowList(order); renderAll();
      };
      g.addEventListener("pointermove", move);
      g.addEventListener("pointerup", up);
      g.addEventListener("pointercancel", up);
    });
  });
}

// Voller Now-Tab: Karte + Fortschritt/Restzeit
function renderNow(){
  const el = $("#view-now"); if (!el || S.tab!=="now") return;
  const list = getNowList().filter(it => !it.taskId || S.tasks.some(t=>t.id===it.taskId && !t.is_archived));
  const isDone = it => { const t = it.taskId ? S.tasks.find(x=>x.id===it.taskId) : null;
    return t ? isCompletedToday(t) : !!it.done; };
  const doneN = list.filter(isDone).length;
  const openMin = list.reduce((a,it)=>{
    if (isDone(it)) return a;
    const t = it.taskId ? S.tasks.find(x=>x.id===it.taskId) : null;
    return a + (t ? (t.duration_minutes||0) : 0);
  }, 0);
  el.innerHTML = `
    <div class="homehead" style="margin-top:2px"><h2>▶️ Der Reihe nach</h2>
      <span style="font-size:12px;color:var(--dim);font-weight:700">${list.length?`${doneN}/${list.length} erledigt${openMin?` · noch ~${fmtMin(openMin)}`:""}`:""}</span></div>
    ${nowCardHtml()}
    ${list.length && doneN===list.length ? `<div class="card" style="text-align:center;color:var(--green);font-weight:700">🎉 Alles abgearbeitet – stark!</div>` : ""}`;
  wireNowCard(el);
}

// ============================================================
// 🍅 Pomodoro-Widget am Home (25/5): Extra-XP pro geschaffter Runde + Tageszähler
// ============================================================
let _pomoTick = null;
// Läuft synchron über alle Geräte (settings "pomoRun" statt localStorage)
const deviceId = (()=>{ let d = localStorage.getItem("wopDeviceId");
  if (!d){ d = uid(); localStorage.setItem("wopDeviceId", d); } return d; })();
const getPomoW = () => getSetting("pomoRun", null);
const setPomoW = p => { S.settings.pomoRun = p; saveSetting("pomoRun", p); };
function pomoTodayCount(){ const l = getSetting("pomoLog", {}); return (l && l[dayKey(new Date())]) || 0; }
async function awardPomodoro(){
  const l = getSetting("pomoLog", {}) || {}, k = dayKey(new Date());
  const pruned = {};
  Object.keys(l).sort().slice(-30).forEach(x=>pruned[x]=l[x]);
  pruned[k] = (pruned[k]||0) + 1;
  await saveSetting("pomoLog", pruned);
  await saveSetting("xpBonus", (getSetting("xpBonus",0)||0) + 25);
  try { if (navigator.vibrate) navigator.vibrate([90,60,90]); } catch(e){}
  toast("🍅 Pomodoro geschafft! +25 XP");
}
function pomoWidgetHtml(){
  const p = getPomoW();
  const n = pomoTodayCount();
  let inner;
  if (p){
    const total = (p.phase==="break" ? 5 : 25) * 60;
    const left = Math.max(0, total - Math.floor((Date.now()-p.start)/1000));
    inner = `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <div>
        <div id="pomoTime" style="font-size:26px;font-weight:800;font-variant-numeric:tabular-nums">${pad(Math.floor(left/60))}:${pad(left%60)}</div>
        <div style="font-size:11.5px;color:var(--dim)">${p.phase==="break"?"☕️ Pause":"🔥 Fokus-Runde"}</div>
      </div>
      <button class="btn small sec" id="pomoStop">Abbrechen</button></div>`;
  } else {
    inner = `<button class="btn small" id="pomoStart" style="width:100%">▶ 25 Min starten</button>`;
  }
  return `<div class="card" id="pomoCard" style="border-left:4px solid #ff6347">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <b style="font-size:13.5px">🍅 Pomodoro</b>
      <span style="font-size:11.5px;color:var(--dim);font-weight:700">heute: ${n} 🍅</span>
    </div>${inner}</div>`;
}
function wirePomoWidget(root){
  clearInterval(_pomoTick); _pomoTick = null;
  const card = $("#pomoCard", root); if (!card) return;
  const st = $("#pomoStart", card);
  if (st) st.onclick = ()=>{ setPomoW({ phase:"work", start:Date.now(), by:deviceId }); renderHome(); };
  const sp = $("#pomoStop", card);
  if (sp) sp.onclick = ()=>{ setPomoW(null); renderHome(); };
  const p = getPomoW();
  if (!p) return;
  _pomoTick = setInterval(async ()=>{
    const cur = getPomoW(); if (!cur){ clearInterval(_pomoTick); return; }
    const total = (cur.phase==="break" ? 5 : 25) * 60;
    const left = Math.max(0, total - Math.floor((Date.now()-cur.start)/1000));
    const tEl = document.getElementById("pomoTime");
    if (tEl) tEl.textContent = `${pad(Math.floor(left/60))}:${pad(left%60)}`;
    if (left > 0) return;
    // Übergang macht das Gerät, das gestartet hat (sonst doppelte XP von mehreren Geräten).
    // Fallback: ist das Startgerät weg, übernimmt jedes andere nach 60s.
    const owner = !cur.by || cur.by === deviceId;
    if (!owner && left > -60) return;
    clearInterval(_pomoTick); _pomoTick = null;
    if (cur.phase === "work"){
      await awardPomodoro();               // Runde voll → Zähler + Extra-XP
      setPomoW({ phase:"break", start:Date.now(), by:cur.by||deviceId });
    } else {
      setPomoW(null);
      toast("☕️ Pause vorbei – bereit für die nächste Runde!");
    }
    if (S.tab==="home") renderHome();
  }, 1000);
}

// ============================================================
// 💊 Medikamente: Zeile erscheint ab der eingestellten Uhrzeit, verschwindet nach dem Abhaken
// ============================================================
function getMeds(){ const m = getSetting("meds", []); return Array.isArray(m) ? m : []; }
function medsLog(){ const l = getSetting("medsLog", {}); return l && typeof l === "object" ? l : {}; }
async function logMedTaken(id){
  const l = medsLog(), k = dayKey(new Date());
  const cur = new Set(l[k] || []); cur.add(id);
  const pruned = {};
  Object.keys(l).sort().slice(-7).forEach(x=>pruned[x]=l[x]); // alte Tage aufräumen
  pruned[k] = [...cur];
  await saveSetting("medsLog", pruned);
}
function medsCardHtml(){
  const meds = getMeds(); if (!meds.length) return "";
  const taken = new Set(medsLog()[dayKey(new Date())] || []);
  const nowM = new Date().getHours()*60 + new Date().getMinutes();
  const hm2 = v => { const [a,b] = String(v||"0:0").split(":").map(Number); return a*60+(b||0); };
  const due = meds.filter(m=>!taken.has(m.id) && nowM >= hm2(m.time))
    .sort((a,b)=>hm2(a.time)-hm2(b.time));
  if (!due.length) return ""; // alles genommen bzw. noch nicht so weit → Karte weg
  return `<div class="card" id="medsCard" style="border-left:4px solid var(--red)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <b style="font-size:13.5px">💊 Medikamente</b>
      <button id="medsGear" class="iconbtn" style="padding:2px 6px;font-size:13px" aria-label="Medikamente verwalten">⚙️</button>
    </div>
    ${due.map(m=>`<div class="todorow" style="padding:7px 0">
      <button class="chk medchk" data-med="${esc(m.id)}" style="width:24px;height:24px;min-width:24px;margin:0;font-size:12px" aria-label="Genommen">✓</button>
      <span class="tt">${esc(m.name)}</span>
      <span style="font-size:11.5px;color:var(--dim2);font-variant-numeric:tabular-nums">${esc(m.time||"")}</span>
    </div>`).join("")}
  </div>`;
}
function wireMeds(root){
  const card = $("#medsCard", root); if (!card) return;
  $$(".medchk", card).forEach(b=>b.onclick = async (e)=>{
    celebrate(e.currentTarget);
    await logMedTaken(b.dataset.med);
    toast("💊 Genommen ✓");
    setTimeout(renderHome, 450);
  });
  $("#medsGear", card).onclick = openMedsForm;
}
function openMedsForm(){
  const meds = getMeds();
  const row = m => `<div class="mrow" data-mid="${esc(m.id)}" style="align-items:center">
    <div><input class="med-name" value="${esc(m.name)}" placeholder="z.B. Vitamin D"></div>
    <div style="display:flex;gap:6px;align-items:center">
      <input type="time" class="med-time" value="${esc(m.time||"08:00")}">
      <button class="iconbtn med-del" aria-label="Löschen">🗑</button>
    </div></div>`;
  openModal(`
    <h3>💊 Medikamente</h3>
    <div style="font-size:12.5px;color:var(--dim);margin-bottom:8px">Jede Zeile taucht am Homescreen ab ihrer Uhrzeit auf und verschwindet nach dem Abhaken bis zum nächsten Tag.</div>
    <div id="medList">${meds.map(row).join("") || ""}</div>
    <button class="btn sec" id="med_add">＋ Medikament hinzufügen</button>
    <div style="height:12px"></div>
    <button class="btn" id="med_save">Speichern</button>
  `);
  const wireDel = ()=>$$("#medList .med-del").forEach(b=>b.onclick = ()=>b.closest(".mrow").remove());
  wireDel();
  $("#med_add").onclick = ()=>{
    $("#medList").insertAdjacentHTML("beforeend", row({ id: uid(), name:"", time:"08:00" }));
    wireDel();
    const inputs = $$("#medList .med-name"); inputs[inputs.length-1].focus();
  };
  $("#med_save").onclick = async ()=>{
    const list = $$("#medList .mrow").map(r=>({
      id: r.dataset.mid, name: $(".med-name", r).value.trim(), time: $(".med-time", r).value || "08:00",
    })).filter(m=>m.name);
    await saveSetting("meds", list);
    closeModal(); toast("Gespeichert"); renderHome();
  };
}

function todoLocationName(){
  const l = S.locations.find(x=>!x.is_routine && x.name.toLowerCase()==="to-do")
    || S.locations.find(x=>!x.is_routine && x.name.toLowerCase().includes("to"))
    || S.locations.find(x=>!x.is_routine);
  return l ? l.name : "To-Do";
}
function todoPanelHtml(){
  const locName = todoLocationName();
  const items = S.tasks.filter(t=>!t.is_archived && (t.location||"")===locName && startReached(t));
  const open = items.filter(t=>!isCompletedToday(t))
    .sort((a,b)=>(b.is_priority-a.is_priority)||(overdueDays(b)-overdueDays(a)));
  const done = items.filter(isCompletedToday);
  const frog = getSetting("frog", null);
  const isFrogToday = t => frog && frog.date===dayKey(new Date()) && frog.taskId===t.id;
  const row = t => `<div class="todorow ${isCompletedToday(t)?"tdone":""}" data-id="${t.id}">
    <button class="chk ${isCompletedToday(t)?"on":""}" style="width:24px;height:24px;min-width:24px;margin:0;font-size:12px" aria-label="Erledigt">✓</button>
    <span class="tt" role="button" tabindex="0">${t.is_priority?"★ ":""}${esc(t.title)}</span>
    <button class="iconbtn todofrog" data-frog="${t.id}" title="Heute als Frosch" style="padding:2px 4px;font-size:15px;opacity:${isFrogToday(t)?1:.25}">🐸</button>
    <span style="font-size:11.5px;color:var(--dim2)">${fmtMin(t.duration_minutes)}</span>
  </div>`;
  return `<div class="card" id="todoPanel" style="border-left:4px solid var(--accent)">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <b style="font-size:14px">☑️ ${esc(locName)}</b>
      <span style="font-size:11.5px;color:var(--dim2);font-weight:700">${open.length} offen</span>
    </div>
    <div class="quickadd">
      <input id="todoQuick" placeholder="Schnell hinzufügen…" autocomplete="off" enterkeyhint="done">
      <button id="todoQuickAdd" aria-label="Hinzufügen">+</button>
    </div>
    ${open.map(row).join("") || `<div class="section-empty" style="padding:8px 0">Alles leer – nice! ✨</div>`}
    ${(()=>{
      // ⏳ Liegt schon lange: Aufgaben aus anderen Kategorien, die seit ≥14 Tagen offen sind
      const age = t => Math.floor((Date.now() - new Date(t.last_done_at || t.created_at || Date.now()))/86400000);
      const stale = S.tasks.filter(t=>!t.is_archived && !isCompletedToday(t) && startReached(t)
          && (t.location||"")!==locName && !isRoutineTask(t) && t.kind!=="recurring" && age(t)>=14)
        .sort((a,b)=>age(b)-age(a)).slice(0,5);
      return stale.length ? `<div style="margin-top:10px;padding-top:8px;border-top:1px dashed var(--line)">
        <div style="font-size:10.5px;font-weight:800;color:var(--amber);letter-spacing:.05em;text-transform:uppercase;margin-bottom:4px">⏳ Liegt schon lange</div>
        ${stale.map(t=>`<div class="todorow" data-id="${t.id}">
          <button class="chk" style="width:24px;height:24px;min-width:24px;margin:0;font-size:12px" aria-label="Erledigt">✓</button>
          <span class="tt" role="button" tabindex="0">${esc(t.title)}</span>
          <span style="font-size:10.5px;color:var(--dim2);white-space:nowrap">${age(t)} T · ${esc((t.location||"").slice(0,14))}</span>
        </div>`).join("")}</div>` : "";
    })()}
    ${done.length?`<div style="margin-top:6px;opacity:.55">${done.slice(0,5).map(row).join("")}</div>`:""}
  </div>`;
}
function wireTodoPanel(root){
  const panel = $("#todoPanel", root); if (!panel) return;
  const input = $("#todoQuick", panel);
  const add = async ()=>{
    const title = input.value.trim(); if (!title) return;
    input.value=""; input.focus();
    const { error } = await sb.from("tasks").insert({
      title, duration_minutes:15, location: todoLocationName(), kind:"oneOff" });
    if (error) return toast("Anlegen fehlgeschlagen: "+error.message, true);
    toast("✓ Hinzugefügt");
    await loadAll();
    // Fokus nach dem Neu-Rendern zurück ins Eingabefeld (Mac: mehrere hintereinander tippen)
    const ni = $("#todoQuick"); if (ni) ni.focus();
  };
  $("#todoQuickAdd", panel).onclick = add;
  input.addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); add(); } });
  $$(".todorow", panel).forEach(r=>{
    const t = S.tasks.find(x=>x.id===r.dataset.id); if(!t) return;
    $(".chk", r).onclick = (e)=>{ e.stopPropagation();
      if (isCompletedToday(t)) uncompleteToday(t);
      else { celebrate(e.currentTarget, xpForCompletion(t.duration_minutes, t.is_priority)); completeTask(t); } };
    $(".tt", r).onclick = ()=>openTaskForm(t);
    const fb = $(".todofrog", r);
    if (fb) fb.onclick = async (e)=>{ e.stopPropagation(); await setTodayFrog(t.id); };
  });
}

// ============================================================
// ⭐ XP & Level
// ============================================================
function xpForCompletion(minutes, isPriority){
  return 10 + Math.min(minutes||0, 120) * 2 + (isPriority ? 15 : 0);
}
function totalXP(){
  const base = getSetting("xpBase", 0) || 0;
  const bonus = getSetting("xpBonus", 0) || 0; // z.B. 🍅-Pomodoro-Belohnungen
  return base + bonus + S.completions.reduce((a,c)=>a + 10 + Math.min(c.minutes||0,120)*2, 0);
}
function levelInfo(){
  const xp = totalXP();
  const level = Math.floor(Math.sqrt(xp/60)) + 1;          // Level 1 ab 0 XP
  const prevReq = 60*(level-1)*(level-1);
  const nextReq = 60*level*level;
  const pct = Math.min(100, 100*(xp-prevReq)/Math.max(1,(nextReq-prevReq)));
  return { xp, level, nextReq, pct };
}
function xpLineHtml(){
  const li = levelInfo();
  return `<div class="xpline">
    <b>⭐ Level ${li.level}</b>
    <div class="xpbar"><div style="width:${li.pct}%"></div></div>
    <span><b>${li.xp.toLocaleString("de-DE")}</b> XP</span>
    <div class="xpnext">Noch ${(li.nextReq-li.xp).toLocaleString("de-DE")} XP bis Level ${li.level+1} · ${Math.round(li.pct)} %</div>
  </div>`;
}

// ---------- Abhak-Feier: Pop, Ring, Partikel, +XP ----------
function celebrate(btn, xp){
  if (!btn || !btn.isConnected) return;
  try { if (navigator.vibrate) navigator.vibrate(12); } catch(e){}
  btn.classList.add("on","anim");
  btn.style.position = btn.style.position || "relative";
  const colors = ["#3ddc84","#ffd54f","#8b7bff","#43d3ce"];
  for (let i=0;i<6;i++){
    const p = document.createElement("span");
    p.className = "chkparticle";
    const ang = (i/6)*Math.PI*2 + Math.random()*0.6;
    const dist = 16 + Math.random()*10;
    p.style.setProperty("--px", Math.cos(ang)*dist+"px");
    p.style.setProperty("--py", Math.sin(ang)*dist+"px");
    p.style.background = colors[i%colors.length];
    btn.appendChild(p);
  }
  if (xp){
    const f = document.createElement("span");
    f.className = "xpfloat";
    f.textContent = "+"+xp+" XP";
    btn.appendChild(f);
  }
}

// ============================================================
// 🐸 Frosch des Tages
// ============================================================
function todayFrog(){
  const f = getSetting("frog", null);
  if (!f || f.date !== dayKey(new Date())) return null;
  const t = S.tasks.find(x=>x.id===f.taskId && !x.is_archived);
  return (t && !isCompletedToday(t)) ? t : null;
}
function frogCardHtml(){
  const t = todayFrog();
  if (!t) return "";
  return `<div class="card frogcard">
    <div style="font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--green)">🐸 Frosch des Tages</div>
    <div style="font-family:var(--font-display);font-size:17px;font-weight:700;margin:7px 0 4px">${esc(t.title)}</div>
    <div style="font-size:12.5px;color:var(--dim);margin-bottom:12px">${fmtMin(t.duration_minutes)}${t.location?" · "+esc(t.location):""} — die eine Sache, nach der der Tag ein Erfolg ist.</div>
    <button class="btn" data-frogstart="${t.id}">▶ Jetzt angehen</button>
  </div>`;
}


async function setTodayFrog(taskId){
  const today = dayKey(new Date());
  const f = getSetting("frog", null);
  const same = f && f.date===today && f.taskId===taskId;
  await saveSetting("frog", same ? null : { date: today, taskId });
  toast(same ? "Frosch entfernt" : "🐸 Frosch des Tages gesetzt!");
  renderAll();
}

// ============================================================
// 🎯 Fokus-Modus (mit "Nur 5 Minuten" und Routine-Warteschlange)
// ============================================================
let _focusTimer = null;
const getFocus = () => { try { return JSON.parse(localStorage.getItem("wopFocus")||"null"); } catch(e){ return null; } };
const setFocusState = f => f ? localStorage.setItem("wopFocus", JSON.stringify(f)) : localStorage.removeItem("wopFocus");

function startFocusTask(taskId, opts={}){
  const t = S.tasks.find(x=>x.id===taskId);
  if (!t) return;
  _focusDomKey = null;
  setFocusState({ taskId, start: Date.now(), startedAt: Date.now(), five: !!opts.five,
    queue: opts.queue||[], label: opts.label||"", askedFive:false });
  showFocus();
}
function stopFocus(){
  _focusDomKey = null;
  setFocusState(null);
  clearInterval(_focusTimer); _focusTimer = null;
  $("#focusView").classList.add("hidden");
  document.body.style.overflow = "";
  renderAll();
}
function showFocus(){
  const f = getFocus(); if (!f) return;
  $("#focusView").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  clearInterval(_focusTimer);
  renderFocus();
  _focusTimer = setInterval(renderFocus, 1000);
}
let _focusDomKey = null;
function renderFocus(){
  const f = getFocus(); if (!f) return stopFocus();
  const t = S.tasks.find(x=>x.id===f.taskId);
  const el = $("#focusView");
  if (!t){ stopFocus(); return; }
  const elapsed = Math.floor((Date.now()-f.start)/1000);
  const mm = Math.floor(elapsed/60), ss = elapsed%60;
  const onBreak = f.pomo && f.phase==="break";
  const targetMin = f.pomo ? (onBreak ? 5 : 25) : (f.five ? 5 : Math.max(1, t.duration_minutes));
  const pct = Math.min(100, 100*elapsed/(targetMin*60));
  const over = elapsed > targetMin*60;
  const fiveChoice = !f.pomo && f.five && over && !f.askedFive;
  const pomoWorkDone = f.pomo && !onBreak && over && !f.askedPomo;
  const pomoBreakDone = f.pomo && onBreak && over;

  // Nur bei Zustandswechsel den DOM neu bauen – sonst nur Timer/Balken updaten.
  // (Voll-Rerender jede Sekunde würde Taps verschlucken, die genau dann passieren.)
  const domKey = [f.taskId, f.five, fiveChoice, f.queue.length, over, (!f.five && elapsed<60),
    !!f.pomo, f.phase||"", f.round||0, pomoWorkDone, pomoBreakDone].join("|");
  if (domKey === _focusDomKey){
    const tm = $(".focus-timer", el); if (tm) tm.textContent = `${pad(mm)}:${pad(ss)}`;
    const sub = $(".focus-sub", el);
    if (sub) sub.textContent = over ? `+${fmtMin(Math.ceil(elapsed/60 - targetMin))} über Plan (${fmtMin(targetMin)})` : `Ziel: ${fmtMin(targetMin)}`;
    const bar = $(".focus-bar>div", el); if (bar) bar.style.width = pct+"%";
    return;
  }
  _focusDomKey = domKey;

  if (pomoWorkDone || pomoBreakDone){ try { if (navigator.vibrate) navigator.vibrate([80,60,80]); } catch(e){} }
  if (pomoWorkDone && !f.pomoAwarded){ f.pomoAwarded = true; setFocusState(f); awardPomodoro(); }

  const kicker = f.pomo ? `🍅 Pomodoro · Runde ${f.round||1}${onBreak?" · ☕️ Pause":""}`
    : f.label ? `${esc(f.label)} · noch ${f.queue.length+1} Schritt${f.queue.length?"e":""}`
    : (f.five?"Nur 5 Minuten":"Fokus");
  el.innerHTML = `
    <div class="focus-kicker">${kicker}</div>
    <div class="focus-title">${onBreak ? "☕️ Kurze Pause" : esc(t.title)}</div>
    <div class="focus-timer">${pad(mm)}:${pad(ss)}</div>
    <div class="focus-sub">${over?`+${fmtMin(Math.ceil(elapsed/60 - targetMin))} über Plan (${fmtMin(targetMin)})`:`Ziel: ${fmtMin(targetMin)}`}</div>
    <div class="focus-bar"><div style="width:${pct}%"></div></div>
    ${pomoWorkDone ? `<div class="focus-choice">
      <b>🍅 Runde ${f.round||1} geschafft!</b>
      <div style="font-size:13px;color:var(--dim);margin:6px 0 12px">25 Minuten voll – gönn dir 5 Minuten Pause.</div>
      <button class="btn" id="fc_break">☕️ 5 Min Pause</button>
      <div style="height:8px"></div>
      <button class="btn sec" id="fc_keepgoing">🔥 Ohne Pause weiter</button>
      <div style="height:8px"></div>
      <button class="btn sec" id="fc_done2">✓ Aufgabe fertig</button>
    </div>` : pomoBreakDone ? `<div class="focus-choice">
      <b>☕️ Pause vorbei!</b>
      <div style="font-size:13px;color:var(--dim);margin:6px 0 12px">Weiter mit „${esc(t.title)}"?</div>
      <button class="btn" id="fc_nextround">🍅 Runde ${(f.round||1)+1} starten</button>
      <div style="height:8px"></div>
      <button class="btn sec" id="fc_done2">✓ Aufgabe fertig</button>
      <div style="height:8px"></div>
      <button class="btn sec" id="fc_stopnow">Genug für jetzt</button>
    </div>` : fiveChoice ? `<div class="focus-choice">
      <b>5 Minuten geschafft! 💪</b>
      <div style="font-size:13px;color:var(--dim);margin:6px 0 12px">Du bist drin – weitermachen? Oder ehrenvoll aufhören, zählt beides.</div>
      <button class="btn" id="fc_more">🔥 Weitermachen</button>
      <div style="height:8px"></div>
      <button class="btn sec" id="fc_enough">Genug für heute</button>
    </div>` : `<div class="focus-btns">
      ${onBreak ? "" : `<button class="btn" id="fc_done" style="background:var(--green);color:#08351d">✓ Fertig!</button>`}
      ${!f.five && !f.pomo && elapsed<60 ? `<button class="btn sec" id="fc_five">⏱ Nur 5 Minuten draus machen</button>` : ""}
      ${!f.five && !f.pomo && elapsed<60 ? `<button class="btn sec" id="fc_pomo">🍅 Pomodoro (25/5)</button>` : ""}
      <button class="btn sec" id="fc_cancel">Abbrechen</button>
    </div>`}
  `;

  const finish = async ()=>{
    const spent = Math.max(1, Math.round((Date.now()-(f.startedAt||f.start))/60000));
    clearInterval(_focusTimer);
    await completeTask(t, spent);
    const queue = (f.queue||[]).filter(id=>{
      const q = S.tasks.find(x=>x.id===id);
      return q && !isCompletedToday(q);
    });
    if (queue.length){
      startFocusTask(queue[0], { queue: queue.slice(1), label: f.label });
    } else {
      setFocusState(null);
      $("#focusView").classList.add("hidden");
      document.body.style.overflow = "";
      if (f.label) toast(`🎉 ${f.label} komplett geschafft!`);
      renderAll();
    }
  };
  const done = $("#fc_done"); if (done) done.onclick = finish;
  const done2 = $("#fc_done2"); if (done2) done2.onclick = finish;
  const five = $("#fc_five");
  if (five) five.onclick = ()=>{ const x=getFocus(); x.five=true; setFocusState(x); renderFocus(); };
  const cancel = $("#fc_cancel");
  if (cancel) cancel.onclick = stopFocus;
  // Pomodoro
  const pomoBtn = $("#fc_pomo");
  if (pomoBtn) pomoBtn.onclick = ()=>{ const x=getFocus(); x.pomo=true; x.phase="work"; x.round=1;
    x.start=Date.now(); x.startedAt=x.startedAt||f.start; x.askedPomo=false; setFocusState(x); renderFocus(); };
  const brk = $("#fc_break");
  if (brk) brk.onclick = ()=>{ const x=getFocus(); x.phase="break"; x.start=Date.now(); x.askedPomo=false; x.pomoAwarded=false; setFocusState(x); renderFocus(); };
  const keep = $("#fc_keepgoing");
  if (keep) keep.onclick = ()=>{ const x=getFocus(); x.askedPomo=true; setFocusState(x); renderFocus(); };
  const nxt = $("#fc_nextround");
  if (nxt) nxt.onclick = ()=>{ const x=getFocus(); x.phase="work"; x.round=(x.round||1)+1;
    x.start=Date.now(); x.askedPomo=false; x.pomoAwarded=false; setFocusState(x); renderFocus(); };
  const stopNow = $("#fc_stopnow");
  if (stopNow) stopNow.onclick = ()=>{ toast(`🍅 ${getFocus()?.round||1} Runde(n) – sauber!`); stopFocus(); };
  const more = $("#fc_more");
  if (more) more.onclick = ()=>{ const x=getFocus(); x.five=false; x.askedFive=true; setFocusState(x); renderFocus(); };
  const enough = $("#fc_enough");
  if (enough) enough.onclick = ()=>{ toast("5 Minuten sind 5 Minuten mehr als nichts. 👏"); stopFocus(); };
}

// ============================================================
// 📒 Post-it am Heute-Screen: Zeilen-Notizen, abhakbar, → To-Do
// ============================================================
function getNotes(){
  let list = getSetting("homeNotesList", null);
  if (!Array.isArray(list)){
    // Migration: alter Freitext -> Zeilen
    const oldText = getSetting("homeNotes", "");
    list = String(oldText||"").split("\n").map(s=>s.trim()).filter(Boolean)
      .map(text=>({ id: uid(), text, done:false }));
  }
  return list;
}
async function saveNotes(list){ await saveSetting("homeNotesList", list); }

// Abgehakte Notizen beim nächsten Seiten-Laden endgültig entfernen
let _notesPurged = false;
function purgeDoneNotes(){
  if (_notesPurged || !S.settings) return;
  _notesPurged = true;
  const list = getNotes();
  const keep = list.filter(n=>!n.done);
  if (keep.length !== list.length) saveNotes(keep);
}

function postitHtml(){
  const notes = getNotes();
  const rows = notes.map(n=>`
    <div class="noterow" data-note="${esc(n.id)}" style="display:flex;align-items:center;gap:9px;padding:6px 0;border-bottom:1px dashed rgba(255,213,79,.25)">
      <button class="chk notechk ${n.done?"on":""}" style="width:21px;height:21px;min-width:21px;margin:0;font-size:11px" aria-label="Abhaken">✓</button>
      <span style="flex:1;font-size:14.5px;line-height:1.4;${n.done?"text-decoration:line-through;color:var(--dim2);":""}">${esc(n.text)}</span>
      <button class="iconbtn notemenu" style="padding:4px 8px;font-size:15px;color:var(--dim2)" aria-label="Optionen">⋯</button>
    </div>
    <div class="noteactions hidden" data-for="${esc(n.id)}" style="display:flex;gap:8px;padding:6px 0 8px 30px">
      <button class="btn small sec note-todo">↑ Zur To-Do</button>
      <button class="btn small sec note-del" style="color:var(--red)">🗑 Löschen</button>
    </div>`).join("");
  return `<div class="card" id="postit" style="background:linear-gradient(180deg,rgba(255,213,79,.14),rgba(255,213,79,.05)),var(--card);border-color:rgba(255,213,79,.35)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <b style="font-size:13.5px">📒 Notizzettel</b>
      <span id="postitState" style="font-size:11px;color:var(--dim2)"></span>
    </div>
    <input id="postitInput" placeholder="Notiz tippen, Enter = nächste Zeile…" autocomplete="off" enterkeyhint="next"
      style="background:transparent;border:none;border-bottom:1px dashed rgba(255,213,79,.4);border-radius:0;padding:6px 2px;font-size:14.5px">
    <div id="noteList">${rows || `<div class="section-empty" style="padding:8px 0 2px">Kopf leeren – einfach lostippen ✍️</div>`}</div>
  </div>`;
}
function wirePostit(root){
  const panel = $("#postit", root); if (!panel) return;
  const input = $("#postitInput", panel);
  const stateEl = $("#postitState", panel);
  const flash = txt => { if(stateEl){ stateEl.textContent = txt; setTimeout(()=>{ if(stateEl.isConnected) stateEl.textContent=""; }, 1800); } };

  input.addEventListener("keydown", async e=>{
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = input.value.trim();
    if (!v){ input.blur(); flash("✓ fertig"); return; }   // Doppel-Enter = fertig
    const list = getNotes();
    list.push({ id: uid(), text: v, done:false });
    input.value = "";
    await saveNotes(list);
    renderHome();
    const ni = $("#postitInput"); if (ni) ni.focus();      // direkt nächste Zeile
  });

  $$(".noterow", panel).forEach(row=>{
    const id = row.dataset.note;
    $(".notechk", row).onclick = async (e)=>{
      e.stopPropagation();
      const list = getNotes();
      const n = list.find(x=>x.id===id); if (!n) return;
      n.done = !n.done;
      if (n.done) celebrate(e.currentTarget, 0);
      await saveNotes(list);
      setTimeout(renderHome, n.done ? 450 : 0);
    };
    $(".notemenu", row).onclick = (e)=>{
      e.stopPropagation();
      const act = $(`.noteactions[data-for="${CSS.escape(id)}"]`, panel);
      if (act) act.classList.toggle("hidden");
    };
  });
  $$(".noteactions", panel).forEach(act=>{
    const id = act.dataset.for;
    $(".note-todo", act).onclick = async ()=>{
      const list = getNotes();
      const n = list.find(x=>x.id===id); if (!n) return;
      const { error } = await sb.from("tasks").insert({ title: n.text, duration_minutes: 15,
        location: todoLocationName(), kind: "oneOff" });
      if (error) return toast("Fehler: "+error.message, true);
      await saveNotes(list.filter(x=>x.id!==id));
      toast("↑ In die To-Do-Liste verschoben");
      loadAll();
    };
    $(".note-del", act).onclick = async ()=>{
      await saveNotes(getNotes().filter(x=>x.id!==id));
      renderHome();
    };
  });
}

// ============================================================
// 🎤 Sprach-Eingabe (Safari/Chrome-Erkennung, sonst Whisper)
// ============================================================
let _voiceRec = null, _mediaRec = null, _voiceChunks = [];
function voiceBtnState(active){
  const b = $("#chatMic"); if (!b) return;
  b.textContent = active ? "⏹" : "🎤";
  b.style.background = active ? "var(--red)" : "var(--card2)";
  b.style.color = active ? "#fff" : "var(--text)";
  b.classList.toggle("miclive", !!active);
  const inp = $("#chatIn");
  if (inp){
    if (active){ if(!inp.dataset.ph) inp.dataset.ph = inp.placeholder;
      inp.placeholder = "🔴 Ich höre zu … ⏹ tippen = fertig & senden"; }
    else if (inp.dataset.ph) inp.placeholder = inp.dataset.ph;
  }
}
function toggleVoice(){
  if (_voiceRec || _mediaRec) return stopVoice(); // 2. Tipp = Stopp → sendet automatisch
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR){
    _voiceRec = new SR();
    _voiceRec.lang = "de-DE";
    _voiceRec.interimResults = true; // live mittippen, damit man sieht, dass es läuft
    let finalText = "";
    _voiceRec.onresult = e=>{
      let interim = "";
      for (let i=e.resultIndex; i<e.results.length; i++){
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript + " ";
        else interim += e.results[i][0].transcript;
      }
      const inp = $("#chatIn"); if (inp) inp.value = (finalText + interim).trim();
    };
    _voiceRec.onerror = e=>{
      const wasDenied = e.error==="not-allowed";
      _voiceRec = null; voiceBtnState(false);
      if (wasDenied) toast("Mikrofon nicht erlaubt.", true);
      else if (e.error==="no-speech") toast("Nichts gehört – tipp 🎤 und sprich einfach los.");
      else whisperRecord(); // Fallback über OpenAI
    };
    _voiceRec.onend = ()=>{
      // Ende = Stopp-Tipp ODER kurze Sprechpause → automatisch senden
      _voiceRec = null; voiceBtnState(false);
      const inp = $("#chatIn");
      if (inp && inp.value.trim()) sendChat();
    };
    try { _voiceRec.start(); voiceBtnState(true); }
    catch(e){ _voiceRec = null; whisperRecord(); }
  } else {
    whisperRecord();
  }
}
function stopVoice(){
  if (_voiceRec){
    try{ _voiceRec.stop(); } // onend sendet dann automatisch
    catch(e){ _voiceRec=null; voiceBtnState(false); }
  }
  if (_mediaRec && _mediaRec.state!=="inactive") _mediaRec.stop(); // onstop transkribiert & sendet
}
async function whisperRecord(){
  const key = localStorage.getItem("wopAiKey");
  if (!key) return toast("Für Sprache erst den OpenAI-Key in ⚙️ speichern.", true);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    _voiceChunks = [];
    _mediaRec = new MediaRecorder(stream);
    _mediaRec.ondataavailable = e=>{ if (e.data.size) _voiceChunks.push(e.data); };
    _mediaRec.onstop = async ()=>{
      stream.getTracks().forEach(tr=>tr.stop());
      voiceBtnState(false);
      const blob = new Blob(_voiceChunks, { type: _mediaRec.mimeType || "audio/webm" });
      _mediaRec = null;
      if (blob.size < 1500) return;
      toast("Transkribiere…");
      try {
        const fd = new FormData();
        fd.append("file", blob, "audio.webm");
        fd.append("model", "whisper-1");
        fd.append("language", "de");
        const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method:"POST", headers:{ "Authorization":"Bearer "+key }, body: fd });
        const d = await r.json();
        if (d.error) throw new Error(d.error.message);
        const inp = $("#chatIn");
        if (inp && d.text){ inp.value = d.text.trim(); sendChat(); }
      } catch(e){ toast("Transkription fehlgeschlagen: "+(e.message||e), true); }
    };
    _mediaRec.start();
    voiceBtnState(true);
    toast("🔴 Aufnahme läuft – ⏹ tippen, wenn du fertig bist. Gesendet wird automatisch.");
  } catch(e){ toast("Mikrofon nicht verfügbar: "+(e.message||e), true); }
}

// ============================================================
// 🌤 Wetter-Woche mit Reise-Logik
// (Fahrt-Blöcke wie "Salzburg → Wien" verschieben den Wetter-Ort)
// ============================================================
function travelDest(title){
  if (!title) return null;
  let parts = String(title).split(/→|->|➔|⇒/);
  if (parts.length > 1) return parts[parts.length-1].trim().replace(/[^\p{L} .-]/gu,"").trim() || null;
  const m = String(title).match(/nach\s+([\p{L} .-]+)/iu);
  return m ? m[1].trim() : null;
}
async function geocodeCity(name){
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem("wopCityCache")||"{}"); } catch(e){}
  const k = name.toLowerCase();
  if (cache[k]) return cache[k];
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=de&format=json`);
    const d = await r.json();
    if (d.results && d.results[0]){
      const c = { lat:+d.results[0].latitude.toFixed(3), lon:+d.results[0].longitude.toFixed(3), name:d.results[0].name };
      cache[k] = c;
      localStorage.setItem("wopCityCache", JSON.stringify(cache));
      return c;
    }
  } catch(e){}
  return null;
}
let _weekWx = { sig:"", ts:0, html:"" };
async function fillWeekWeather(){
  const el = $("#weekWeather"); if (!el) return;
  const base = await effectiveGeo(); // Basis = aktueller Aufenthaltsort (inkl. vergangener Reisen)
  if (!base){
    el.innerHTML = `<b style="font-size:13.5px">🌤 Wetter-Woche</b>
      <div class="section-empty">Oben zuerst den Wetter-Standort aktivieren.</div>`;
    return;
  }
  // Reiseplan der nächsten 7 Tage als Cache-Schlüssel
  const travelSig = [];
  for (let i=0;i<7;i++){
    const d = new Date(); d.setDate(d.getDate()+i);
    blocksFor(dayKey(d)).filter(b=>b.type==="travel").forEach(b=>travelSig.push(dayKey(d)+b.title));
  }
  const sig = base.lat+","+base.lon+"|"+travelSig.join(";");
  if (_weekWx.html && _weekWx.sig===sig && Date.now()-_weekWx.ts < 30*60000){
    el.innerHTML = _weekWx.html; wireWeekWeather(el); return;
  }

  // Ort pro Tag bestimmen (Fahrt-Ziel gilt ab dem Reisetag)
  let cur = { lat:base.lat, lon:base.lon, name: base.name||"Standort" };
  const days = [];
  for (let i=0;i<7;i++){
    const d = new Date(); d.setDate(d.getDate()+i);
    const dk = dayKey(d);
    for (const tb of blocksFor(dk).filter(b=>b.type==="travel").sort((a,b)=>a.start_min-b.start_min)){
      const dest = travelDest(tb.title);
      if (dest){ const g = await geocodeCity(dest); if (g) cur = g; }
    }
    days.push({ d, dk, loc: cur });
  }
  // Wetter je Ort (dedupliziert) holen
  const uniq = {};
  days.forEach(x=>{ uniq[x.loc.lat+","+x.loc.lon] = x.loc; });
  const wx = {};
  await Promise.all(Object.entries(uniq).map(async ([k,loc])=>{
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=8`);
      const d = await r.json();
      const map = {};
      (d.daily && d.daily.time || []).forEach((t,i)=>{ map[t] = { max:d.daily.temperature_2m_max[i],
        min:d.daily.temperature_2m_min[i], rain:d.daily.precipitation_probability_max[i], code:d.daily.weather_code[i] }; });
      wx[k] = map;
    } catch(e){ wx[k] = null; }
  }));

  const rows = days.map((x,i)=>{
    const m = wx[x.loc.lat+","+x.loc.lon];
    const v = m && m[x.dk];
    const [ico] = v ? (WMO[v.code]||["🌡"]) : ["·"];
    const locChanged = i>0 && days[i-1].loc.name !== x.loc.name;
    const showLoc = i===0 || locChanged;
    return `<div class="wwrow ${i===0?"today":""}">
      <span class="wwd">${i===0?"Heute":(i===1?"Morgen":WEEKDAYS_DE[x.d.getDay()]+" "+x.d.getDate()+".")}</span>
      <span class="wwi">${ico}</span>
      <span class="wwt">${v?Math.round(v.max)+"°":"–"}<em>${v?"/"+Math.round(v.min)+"°":""}</em></span>
      <span class="wwm">${v&&v.rain?"☔️ "+v.rain+"%":""}${showLoc?`${v&&v.rain?"<br>":""}<span class="wwl">${locChanged?"✈️ ":"📍 "}${esc(x.loc.name)}</span>`:""}</span>
    </div>`;
  }).join("");
  const html = `<b style="font-size:13.5px">🌤 Wetter-Woche</b><div style="margin-top:6px">${rows}</div>
    <div style="font-size:10.5px;color:var(--dim2);margin-top:8px">✈️ = Ort wechselt laut Kalender (Fahrt-Block „A → B")</div>`;
  _weekWx = { sig, ts: Date.now(), html };
  el.innerHTML = html;
  wireWeekWeather(el);
}
function wireWeekWeather(el){ /* aktuell keine Interaktionen nötig */ }

// ============================================================
// 📅 "Geplant"-Karte links: Heute / Woche / Monat
// ============================================================
function plannedCardHtml(){
  const mode = localStorage.getItem("wopPlannedView") || "today";
  const seg = `<div class="seg" id="plSeg" style="margin:8px 0 8px;padding:2px">
    ${[["today","Heute"],["week","Woche"],["month","Monat"]].map(([v,l])=>
      `<button data-v="${v}" class="${mode===v?"active":""}" style="padding:6px 0;font-size:12px">${l}</button>`).join("")}
  </div>`;
  const blockRow = b => {
    const t = BLOCK_TYPES[b.type]||BLOCK_TYPES.event;
    const bAllDay = b.start_min<=0 && (b.end_min>=1439 || b.end_min<=60);
    if (bAllDay) return `<div class="planrow" data-pblock="${b.id}" role="button" tabindex="0" style="padding:7px 0">
      <span class="ptime" style="min-width:40px">📅</span>
      <span style="width:8px;height:8px;min-width:8px;border-radius:50%;background:${blockColor(b)}"></span>
      <span class="pt" style="font-size:13.5px">${blockIco(b)} ${esc(b.title||t.label)}</span>
      <span class="pm">ganztägig</span></div>`;
    return `<div class="planrow" data-pblock="${b.id}" role="button" tabindex="0" style="padding:7px 0">
      <span class="ptime" style="min-width:40px">${minToHM(b.start_min)}</span>
      <span style="width:8px;height:8px;min-width:8px;border-radius:50%;background:${blockColor(b)}"></span>
      <span class="pt" style="font-size:13.5px">${blockIco(b)} ${esc(b.title||t.label)}</span>
      <span class="pm">${minToHM(b.end_min)}</span>
    </div>`;
  };
  let body = "";

  if (mode === "today"){
    const blocks = blocksFor(dayKey(new Date())).filter(b=>b.type!=="sleep");
    body = blocks.map(blockRow).join("") || `<div class="section-empty" style="padding:6px 0">Heute keine Termine 🎈</div>`;
  }
  else if (mode === "week"){
    const parts = [];
    for (let i=0;i<7;i++){
      const d = new Date(); d.setDate(d.getDate()+i);
      const blocks = blocksFor(dayKey(d)).filter(b=>b.type!=="sleep");
      if (!blocks.length) continue;
      parts.push(`<div style="font-size:11px;font-weight:800;color:${i===0?"var(--accent2)":"var(--dim2)"};
        text-transform:uppercase;letter-spacing:.06em;margin:${parts.length?"10px":"0"} 0 2px">
        ${i===0?"Heute":i===1?"Morgen":WEEKDAYS_DE[d.getDay()]+", "+d.getDate()+"."}</div>` + blocks.map(blockRow).join(""));
    }
    body = parts.join("") || `<div class="section-empty" style="padding:6px 0">Diese Woche ist frei 🎈</div>`;
  }
  else { // month
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    const lead = (first.getDay()+6)%7; // Montag-basiert
    let cells = `<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;text-align:center">`;
    ["Mo","Di","Mi","Do","Fr","Sa","So"].forEach(w=>cells+=`<div style="font-size:9.5px;font-weight:800;color:var(--dim2);padding:2px 0">${w}</div>`);
    for (let i=0;i<lead;i++) cells += `<div></div>`;
    for (let day=1; day<=daysInMonth; day++){
      const d = new Date(now.getFullYear(), now.getMonth(), day);
      const dk = dayKey(d);
      const blocks = blocksFor(dk).filter(b=>b.type!=="sleep");
      const isT = dk===dayKey(now);
      const dots = blocks.slice(0,3).map(b=>`<i style="width:4px;height:4px;border-radius:50%;background:${blockColor(b)}"></i>`).join("");
      cells += `<div data-pday="${dk}" role="button" tabindex="0" style="padding:4px 0 3px;border-radius:8px;cursor:pointer;
        ${isT?"background:var(--card2);":""}${blocks.length?"":"opacity:.55;"}">
        <div style="font-size:12px;font-weight:${isT?"800":"600"};color:${isT?"var(--accent2)":"var(--text)"}">${day}</div>
        <div style="display:flex;gap:2px;justify-content:center;height:5px;margin-top:1px">${dots}</div>
      </div>`;
    }
    cells += `</div>`;
    body = `<div style="font-size:12px;font-weight:700;color:var(--dim);margin-bottom:4px;text-transform:capitalize">
      ${now.toLocaleDateString("de-DE",{month:"long",year:"numeric"})}</div>` + cells
      + `<div style="font-size:10.5px;color:var(--dim2);margin-top:7px">Tag antippen → öffnet den Plan</div>`;
  }

  return `<div class="card" id="plannedCard">
    <b style="font-size:13.5px">📅 Geplant</b>${seg}${body}
  </div>`;
}
function wirePlannedCard(root){
  const card = $("#plannedCard", root); if (!card) return;
  $$("#plSeg button", card).forEach(b=>b.onclick = ()=>{
    localStorage.setItem("wopPlannedView", b.dataset.v);
    renderHome();
  });
  $$("[data-pblock]", card).forEach(r=>r.onclick = ()=>{
    const b = S.timeBlocks.find(x=>x.id===r.dataset.pblock);
    if (b) openBlockForm(b);
  });
  $$("[data-pday]", card).forEach(c=>c.onclick = ()=>{
    S.planDate = c.dataset.pday;
    switchTab("plan");
  });
}

// ============================================================
// Plan-Desktop: Wochen- und Monats-Panel
// ============================================================
function planWeekHtml(){
  const sel = new Date(S.planDate+"T12:00:00");
  const mon = new Date(sel); mon.setDate(mon.getDate() - ((mon.getDay()+6)%7));
  const H0 = 5, H1 = 24, PXH = 34;
  const height = (H1-H0)*PXH;
  const top = m => Math.max(0, Math.min(height, (m/60-H0)*PXH));
  const todayKey = dayKey(new Date());

  let head = `<div class="wk-head" style="grid-template-columns:34px repeat(7,1fr)"><div></div>`;
  let cols = `<div class="wk-grid" style="grid-template-columns:34px repeat(7,1fr)">`;
  // Stunden-Spalte
  let gutter = `<div style="position:relative;height:${height}px">`;
  for (let hh=H0+1; hh<H1; hh++)
    gutter += `<div style="position:absolute;top:${(hh-H0)*PXH-7}px;right:4px;font-size:9.5px;color:var(--dim2)">${pad(hh)}</div>`;
  gutter += `</div>`;
  cols += gutter;
  for (let i=0;i<7;i++){
    const d = new Date(mon); d.setDate(d.getDate()+i);
    const dk = dayKey(d);
    head += `<button data-wd="${dk}" class="${dk===S.planDate?"sel":""} ${dk===todayKey?"today":""}">
      <span>${WEEKDAYS_DE[d.getDay()]}</span><b>${d.getDate()}</b></button>`;
    let col = `<div class="wk-col" data-wcol="${dk}" style="height:${height}px">`;
    for (let hh=H0+1; hh<H1; hh++) col += `<div class="wk-hline" style="top:${(hh-H0)*PXH}px;${hh%2?"opacity:.5;":""}"></div>`;
    if (dk===todayKey){
      const nowM = new Date().getHours()*60+new Date().getMinutes();
      if (nowM>=H0*60) col += `<div style="position:absolute;left:0;right:0;top:${top(nowM)}px;border-top:1.5px solid var(--red);z-index:5"></div>`;
    }
    blocksFor(dk).forEach(b=>{
      const bAllDay = b.start_min<=0 && (b.end_min>=1439 || b.end_min<=60);
      if (bAllDay && b.type!=="sleep"){
        const c2 = blockColor(b);
        col += `<div class="wk-block" data-wb="${b.id}" style="top:2px;height:15px;background:${c2}33;border-left-color:${c2}">
          <b>${esc(b.title||"Termin")}</b></div>`;
        return;
      }
      const endEff = b.end_min > b.start_min ? b.end_min : 1440;
      const t0 = top(b.start_min), t1 = top(endEff);
      const c = blockColor(b);
      const bt = BLOCK_TYPES[b.type]||BLOCK_TYPES.event;
      col += `<div class="wk-block" data-wb="${b.id}" style="top:${t0+1}px;height:${Math.max(16,t1-t0-2)}px;
        background:${c}26;border-left-color:${c}">
        <b>${esc(b.title||bt.label)}</b>${(t1-t0)>26?`<span style="opacity:.75">${minToHM(b.start_min)}</span>`:""}</div>`;
    });
    col += `</div>`;
    cols += col;
  }
  head += `</div>`; cols += `</div>`;
  const kw = (d=>{const x=new Date(d);x.setDate(x.getDate()+3-((x.getDay()+6)%7));const w1=new Date(x.getFullYear(),0,4);return 1+Math.round(((x-w1)/86400000-3+((w1.getDay()+6)%7))/7);})(sel);
  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
    <b style="font-size:13.5px">📆 Woche ${kw}</b>
    <span style="font-size:11px;color:var(--dim2)">${mon.getDate()}.${mon.getMonth()+1}. – ${new Date(mon.getTime()+6*864e5).getDate()}.${new Date(mon.getTime()+6*864e5).getMonth()+1}.</span>
  </div>` + head + cols;
}

function planMonthHtml(){
  const sel = new Date(S.planDate+"T12:00:00");
  const y = sel.getFullYear(), m = sel.getMonth();
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const lead = (new Date(y, m, 1).getDay()+6)%7;
  const todayKey = dayKey(new Date());
  let cells = `<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;text-align:center">`;
  ["Mo","Di","Mi","Do","Fr","Sa","So"].forEach(w=>cells+=`<div style="font-size:9.5px;font-weight:800;color:var(--dim2);padding:2px 0">${w}</div>`);
  for (let i=0;i<lead;i++) cells += `<div></div>`;
  for (let day=1; day<=daysInMonth; day++){
    const dk = dayKey(new Date(y, m, day));
    const blocks = blocksFor(dk).filter(b=>b.type!=="sleep");
    const isSel = dk===S.planDate, isT = dk===todayKey;
    const dots = blocks.slice(0,3).map(b=>`<i style="width:4px;height:4px;border-radius:50%;background:${blockColor(b)}"></i>`).join("");
    cells += `<div data-mday="${dk}" role="button" tabindex="0" style="padding:4px 0 3px;border-radius:8px;cursor:pointer;
      ${isSel?"background:var(--accent);":""}${isT&&!isSel?"background:var(--card2);":""}">
      <div style="font-size:12px;font-weight:${isT||isSel?"800":"600"};color:${isSel?"#fff":isT?"var(--accent2)":"var(--text)"}">${day}</div>
      <div style="display:flex;gap:2px;justify-content:center;height:5px;margin-top:1px">${dots}</div></div>`;
  }
  cells += `</div>`;
  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
    <button class="iconbtn" data-mnav="-1" style="padding:4px 10px">‹</button>
    <b style="font-size:13px;text-transform:capitalize">${sel.toLocaleDateString("de-DE",{month:"long",year:"numeric"})}</b>
    <button class="iconbtn" data-mnav="1" style="padding:4px 10px">›</button>
  </div>` + cells;
}

function wirePlanPanels(el){
  $$("[data-pblock]", el).forEach(r=>r.onclick = ()=>{
    const b = S.timeBlocks.find(x=>x.id===r.dataset.pblock); if (b) openBlockForm(b);
  });
  $$("[data-wd]", el).forEach(b=>b.onclick = ()=>{ S.planDate = b.dataset.wd; renderPlan(); });
  $$("[data-wb]", el).forEach(x=>x.onclick = ()=>{
    const b = S.timeBlocks.find(y=>y.id===x.dataset.wb); if (b) openBlockForm(b);
  });
  $$("[data-wcol]", el).forEach(c=>c.ondblclick = ()=>{ S.planDate = c.dataset.wcol; openBlockForm(null); });
  $$("[data-mday]", el).forEach(c=>c.onclick = ()=>{ S.planDate = c.dataset.mday; renderPlan(); });
  $$("[data-mnav]", el).forEach(b=>b.onclick = ()=>{
    const d = new Date(S.planDate+"T12:00:00");
    d.setMonth(d.getMonth() + parseInt(b.dataset.mnav));
    S.planDate = dayKey(d); renderPlan();
  });
}

// Rechte Plan-Spalte: die nächsten Termine (14 Tage)
function planUpcomingHtml(){
  const items = [];
  for (let i=0;i<14 && items.length<8;i++){
    const d = new Date(); d.setDate(d.getDate()+i);
    const dk = dayKey(d);
    blocksFor(dk).filter(b=>b.type!=="sleep").forEach(b=>{
      if (items.length<8) items.push({ d:new Date(d), dk, b });
    });
  }
  if (!items.length) return `<b style="font-size:13.5px">🔜 Demnächst</b>
    <div class="section-empty" style="padding:8px 0 2px">Nichts geplant in den nächsten 2 Wochen.</div>`;
  const rows = items.map(({d,dk,b})=>{
    const c = blockColor(b);
    const t = BLOCK_TYPES[b.type]||BLOCK_TYPES.event;
    const bAllDay = b.start_min<=0 && (b.end_min>=1439 || b.end_min<=60);
    const when = dk===dayKey(new Date()) ? "Heute" : WEEKDAYS_DE[d.getDay()]+" "+d.getDate()+".";
    return `<div class="planrow" data-pblock="${b.id}" role="button" tabindex="0" style="padding:7px 0">
      <span class="ptime" style="min-width:52px;font-size:11px">${when}</span>
      <span style="width:8px;height:8px;min-width:8px;border-radius:50%;background:${c}"></span>
      <span class="pt" style="font-size:13px">${blockIco(b)} ${esc(b.title||t.label)}</span>
      <span class="pm">${bAllDay?"ganztägig":minToHM(b.start_min)}</span>
    </div>`;
  }).join("");
  return `<b style="font-size:13.5px">🔜 Demnächst</b><div style="margin-top:4px">${rows}</div>`;
}

// ============================================================
// 💬 Chat als feste Karte am Home
// ============================================================
function homeChatHtml(){
  return `<div class="card" id="homeChat" style="border-left:4px solid var(--purple)">
    <b style="font-size:13.5px">💬 Assistent</b>
    <div class="chatlog" id="chatLog" style="height:auto;max-height:300px;min-height:60px;margin-top:8px"></div>
    <div class="chatinput" style="margin-top:8px">
      <button id="chatMic" style="background:var(--card2);color:var(--text)" title="Sprechen" aria-label="Sprechen">🎤</button>
      <input id="chatIn" placeholder="z.B. Freitag 14 Uhr Zahnarzt…" autocomplete="off">
      <button id="chatSend" aria-label="Senden">➤</button>
    </div>
  </div>`;
}
function wireHomeChat(root){
  const card = $("#homeChat", root); if (!card) return;
  if (!localStorage.getItem("wopAiKey")){
    $("#chatLog", card).innerHTML = `<div class="cmsg sys">Der Assistent braucht einmalig deinen OpenAI API-Key.</div>
      <button class="btn small" id="chatKeyBtn" style="align-self:flex-start;margin-top:6px">🔑 Key hinterlegen</button>`;
    const kb = $("#chatKeyBtn", card);
    if (kb) kb.onclick = ()=>{ openSettings();
      setTimeout(()=>{ const k=$("#s_aikey"); if(k){ k.scrollIntoView({block:"center"}); k.focus(); } }, 250); };
  } else {
    if (!S.chat.length) S.chat.push({ role:"bot", text:"Hi Finn! Sag mir, was ich eintragen soll – Termine, Aufgaben, Arbeitszeiten. 😊" });
    renderChat();
  }
  $("#chatMic", card).onclick = toggleVoice;
  $("#chatSend", card).onclick = sendChat;
  $("#chatIn", card).addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); sendChat(); } });
}
