/* Wheel of Procrastination – Web (Listen + Arbeitszeit + Statistik) */
"use strict";

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
      const { error: wErr } = await sb.from("work_entries").insert({ start_time:start.toISOString(), end_time:end.toISOString(), notes:"Task: "+t.title });
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

  const active = tasks.filter(t=>isActiveWeekday(t));
  const inactive = tasks.filter(t=>!isActiveWeekday(t));
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
    // Nach Ort/Kategorie gruppieren (Reihenfolge wie in den Einstellungen)
    const palette = LOC_PALETTE;
    const locSection = (name, color, arr) => {
      if (!arr.length) return "";
      const collapsed = S.collapsed.has(name);
      return `<div class="locsec" data-sec="${esc(name)}" role="button" tabindex="0">
        <span class="dot" style="background:${color}"></span>
        <h2>${esc(name)}</h2><span class="cnt">${arr.length}</span><span class="arr">${collapsed?"▸":"▾"}</span></div>`
        + (collapsed ? "" : arr.map(taskRow).join(""));
    };
    S.locations.forEach((l,i)=>{
      html += locSection(l.name, palette[i%palette.length], openRest.filter(t=>(t.location||"")===l.name));
    });
    const noLoc = openRest.filter(t=>!S.locations.some(l=>l.name===(t.location||"")));
    html += locSection("Sonstiges", "#5c6579", noLoc);
  } else {
    html += section("Offen", openRest);
  }
  html += section("Nicht heute", inactive);
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
  ["home","tasks","plan","work","stats","archive"].forEach(v=>$("#view-"+v).classList.toggle("hidden", v!==tab));
  $("#pageTitle").textContent = {home:"Heute",tasks:"Aufgaben",plan:"Plan",work:"Arbeitszeit",stats:"Statistik",archive:"Archiv"}[tab];
  $("#fab").classList.toggle("hidden", tab==="stats" || tab==="archive");
  renderAll();
}

function renderAll(){
  if (S.tab==="home") renderHome();
  if (S.tab==="plan") renderPlan();
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
  $("#btnChat").onclick = openChat;
  $("#btnSettings").onclick = openSettings;
  initRealtime();
  loadAll().then(()=>{ if (getFocus()) showFocus(); });
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

  const run = runningEntry();
  const closed = S.workEntries.filter(w=>w.end_time);
  const thisPeriod = S.workEntries.filter(w => periodKeyOf(w.start_time, mode)===curKey);
  const workedThis = thisPeriod.reduce((a,w)=>a+workedMinutes(w), 0);

  // Überstunden-Saldo: abgeschlossene Perioden (ohne aktuelle)
  const byPeriod = {};
  closed.forEach(w=>{ const k=periodKeyOf(w.start_time, mode); if(k!==curKey) byPeriod[k]=(byPeriod[k]||0)+workedMinutes(w); });
  const balance = Object.values(byPeriod).reduce((a,v)=>a+(v-target), 0);

  // Stempeluhr-Anzeige
  let clockHtml;
  if (run){
    const mins = workedMinutes(run);
    const onBreak = !!run.break_started_at;
    clockHtml = `<div class="card clockcard">
      <div class="big">${fmtMin(mins)}</div>
      <div class="state">${onBreak?"⏸ Pause läuft":"🟢 Eingestempelt"} seit ${fmtTime(new Date(run.start_time))}${run.break_minutes?` · Pausen: ${fmtMin(run.break_minutes)}`:""}</div>
      <div class="clockbtns">
        <button class="btn sec" id="w_break">${onBreak?"▶️ Pause beenden":"⏸ Pause"}</button>
        <button class="btn" id="w_out" style="background:var(--red)">⏹ Ausstempeln</button>
      </div></div>`;
  } else {
    clockHtml = `<div class="card clockcard">
      <div class="big">–</div><div class="state">Nicht eingestempelt</div>
      <div class="clockbtns"><button class="btn" id="w_in" style="background:var(--green);color:#08351d">▶️ Einstempeln</button></div></div>`;
  }

  // Zielfortschritt
  const pct = target>0 ? Math.min(100, 100*workedThis/target) : 0;
  const over = workedThis>=target;
  const periodLabel = mode==="week" ? "Diese Woche" : "Dieser Monat";
  const targetHtml = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <b>${periodLabel}</b>
      <span style="font-variant-numeric:tabular-nums">${fmtMin(workedThis)} / ${fmtMin(target)}</span></div>
    <div class="progressbar"><div class="${over?"over":""}" style="width:${pct}%"></div></div>
    <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--dim)">
      <span>${over?`🎉 +${fmtMin(workedThis-target)} über Soll`:`Noch ${fmtMin(target-workedThis)}`}</span>
      <span>Saldo: <b style="color:${balance>=0?"var(--green)":"var(--red)"}">${balance>=0?"+":""}${fmtMin(balance)}</b></span>
    </div></div>`;

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
        inner = `<div style="margin-top:8px;border-top:1px solid var(--line);padding-top:4px">` +
          arr.map(w=>`<div class="wt-entry" data-id="${w.id}" role="button" tabindex="0">
            <div><div class="t">${fmtDateShort(new Date(w.start_time))} · ${fmtTime(new Date(w.start_time))}–${fmtTime(new Date(w.end_time))}${w.break_minutes?` <span class="n">(P: ${fmtMin(w.break_minutes)})</span>`:""}</div>
            ${w.notes?`<div class="n">${esc(w.notes)}</div>`:""}</div>
            <div class="dur">${fmtMin(workedMinutes(w))}</div></div>`).join("") + `</div>`;
      }
      return `<div class="card histcard" data-k="${k}" style="cursor:pointer">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <b style="font-size:14px">${open?"▾":"▸"} ${label(k)}</b>
          <span style="font-variant-numeric:tabular-nums;font-size:13.5px"><b>${fmtMin(sum)}</b>
          <span style="color:${diff>=0?"var(--green)":"var(--red)"};margin-left:8px">${diff>=0?"+":""}${fmtMin(diff)}</span></span>
        </div>${inner}</div>`;
    }).join("");
  }

  el.innerHTML = clockHtml + targetHtml +
    `<button class="btn sec" id="w_settings" style="margin-bottom:4px">⚙️ Sollzeit einstellen (${mode==="week"?"Woche":"Monat"})</button>` +
    listHtml + histHtml;

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
      const { error } = await sb.from("work_entries").insert({ start_time:new Date().toISOString() });
      if (error) return toast("Einstempeln fehlgeschlagen: "+error.message, true);
      toast("Eingestempelt – viel Erfolg!"); loadAll();
    };
  }
  $("#w_settings").onclick = openWorkSettings;
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
    <label>Notiz</label><input id="we_notes" value="${esc(w?w.notes:"")}" placeholder="optional">
    <div style="height:18px"></div>
    <button class="btn" id="we_save">Speichern</button>
    ${isNew?"":`<div style="height:8px"></div><button class="btn danger" id="we_del">Eintrag löschen</button>`}
  `);
  $("#we_save").onclick = async ()=>{
    const start = new Date($("#we_start").value), end = new Date($("#we_end").value);
    if (!(start<end)) return toast("Ende muss nach Beginn liegen.", true);
    const row = { start_time:start.toISOString(), end_time:end.toISOString(),
      break_minutes:Math.max(0,+$("#we_break").value||0), notes:$("#we_notes").value };
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
    <h2>Top-Aufgaben · 30 Tage</h2>
    <div class="card">${ top.length ? top.map(([n,v])=>
      `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line);font-size:14.5px">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:10px">${esc(n)}</span><b>${v}×</b></div>`).join("")
      : `<div class="section-empty">Noch keine Daten – leg los! 💪</div>`}</div>
    <div class="card" style="text-align:center;color:var(--dim);font-size:13px">Insgesamt ${totalN} Erledigungen aufgezeichnet</div>
  `;
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
    <button class="btn sec" id="s_import">📥 iOS-Backup importieren (.json)</button>
    <input type="file" id="s_importfile" accept=".json,application/json" class="hidden">
    <div style="height:8px"></div>
    <button class="btn sec" id="s_archive">🗂 Archiv öffnen</button>
    <label>💬 Assistent – OpenAI API-Key (bleibt nur auf diesem Gerät)</label>
    <input type="password" id="s_aikey" placeholder="sk-…" value="${esc(localStorage.getItem("wopAiKey")||"")}">
    <div style="height:8px"></div>
    <button class="btn sec" id="s_savekey">Key speichern</button>
    <div style="height:20px"></div>
    <div class="card" style="font-size:13px;color:var(--dim)">Angemeldet als <b style="color:var(--text)">${esc(S.user.email)}</b></div>
    <button class="btn danger" id="s_logout">Abmelden</button>
  `);
  renderNotifySettings();
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

async function importBackup(json){
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
let weatherCache = null; // {ts, data}

async function fetchWeather(){
  const loc = JSON.parse(localStorage.getItem("wopGeo")||"null");
  if (!loc) return null;
  if (weatherCache && Date.now()-weatherCache.ts < 30*60000) return weatherCache.data;
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`+
      `&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m`+
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=2`;
    const r = await fetch(u); const d = await r.json();
    weatherCache = { ts: Date.now(), data: d };
    return d;
  } catch(e){ return null; }
}
function askGeo(){
  if (!navigator.geolocation) return openCityPicker();
  navigator.geolocation.getCurrentPosition(p=>{
    localStorage.setItem("wopGeo", JSON.stringify({lat:+p.coords.latitude.toFixed(3), lon:+p.coords.longitude.toFixed(3), name:"Mein Standort"}));
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
        localStorage.setItem("wopGeo", JSON.stringify({lat:+c.latitude.toFixed(3), lon:+c.longitude.toFixed(3), name:c.name}));
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
    const endEff = b.end_min > b.start_min ? b.end_min : 1440;
    const past = endEff < nowM;
    return `<div class="planrow ${past?"pdone":""}" data-block="${b.id}">
      <span class="ptime">${minToHM(b.start_min)}</span>
      <span class="pt">${t.ico} ${esc(b.title||t.label)}</span>
      <span class="pm">bis ${minToHM(b.end_min)}</span></div>`;
  }).join("");
}

const routineLocations = () => S.locations.filter(l=>l.is_routine);
const isRoutineTask = t => routineLocations().some(l=>l.name.toLowerCase()===(t.location||"").toLowerCase());

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
      items.push({ t, done:false, time:null, sort: 2000 - (t.is_priority?500:0) - overdueDays(t) });
    } else if (done){
      items.push({ t, done:true, time:null, sort: 5000 });
    }
  });
  items.sort((a,b)=>a.sort-b.sort);
  return items;
}

// "Als Nächstes" in Kategorie-Häppchen (max 3 pro Kategorie) statt einer Wand
function homeGroupedPlan(openPlan, planRow){
  if (!openPlan.length) return "";
  const PER_CAT = 3;
  const groups = [];
  S.locations.filter(l=>!l.is_routine).forEach((l,i)=>{
    const arr = openPlan.filter(p=>(p.t.location||"")===l.name);
    if (arr.length) groups.push({ name:l.name, color:LOC_PALETTE[i%LOC_PALETTE.length], arr });
  });
  const rest = openPlan.filter(p=>!S.locations.some(l=>!l.is_routine && l.name===(p.t.location||"")));
  if (rest.length) groups.push({ name:"Sonstiges", color:"#7e88a0", arr:rest });
  return groups.map(g=>`<div class="card" style="border-left:4px solid ${g.color}">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
      <b style="font-size:13px">${esc(g.name)}</b>
      <span style="font-size:11.5px;color:var(--dim2);font-weight:700">${g.arr.length}</span>
    </div>
    ${g.arr.slice(0,PER_CAT).map(planRow).join("")}
    ${g.arr.length>PER_CAT?`<div style="text-align:center;padding-top:6px"><a class="homeMoreCat" data-loc="${esc(g.name)}" style="color:var(--accent2);font-size:12px;font-weight:700;cursor:pointer">＋ ${g.arr.length-PER_CAT} weitere ›</a></div>`:""}
  </div>`).join("");
}

async function renderHome(){
  const el = $("#view-home");
  if (!el || S.tab!=="home") return;

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

  const planRow = p => {
    const t = p.t;
    const bits = [];
    bits.push(fmtMin(t.duration_minutes));
    if (t.location) bits.push(esc(t.location));
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
      <div class="card" id="weekWeather"><b style="font-size:13.5px">🌤 Wetter-Woche</b><div class="section-empty">lädt…</div></div>
      ${plannedCardHtml()}
    </div>
    <div class="home-main">
    <div class="hero">
      <div class="greet">${greetingText()}, Finn! 👋</div>
      <div class="date">${dateStr}</div>
      ${streak>0?`<div class="streakline">🔥 ${streak} Tage-Streak – weiter so!</div>`:""}
      ${xpLineHtml()}
    </div>
    ${frogCardHtml()}

    <div class="card" id="weatherCard"><div class="section-empty">Wetter lädt…</div></div>

    <div class="homegrid">
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
    </div>

    ${ routineCardsHtml() }
    ${ homeBlockRows() ? `<div class="homehead"><h2>📅 Termine heute</h2><a id="homeToPlan">Zum Plan ›</a></div>
    <div class="card">${homeBlockRows()}</div>` : "" }
    <div class="homehead"><h2>📋 Als Nächstes</h2><div>
      <a id="homeRandom" title="Zufällig eine wählen" style="margin-right:14px">🎲 Zufall</a>
      <a id="homeToTasks">Alle Aufgaben ›</a></div></div>
    ${ homeGroupedPlan(openPlan, planRow) || `<div class="card"><div class="section-empty">${totalN?"Alles erledigt – stark! 🎉":"Heute steht nichts an. Genieß den Tag ☕️"}</div></div>` }
    <button class="btn sec" id="planTomorrow" style="margin-top:2px">🌙 Morgen planen</button>
    ${donePlan.length?`<div class="card" style="opacity:.65;margin-top:10px">${donePlan.map(planRow).join("")}</div>`:""}
    </div>
    <div class="home-side">${todoPanelHtml()}${postitHtml()}</div>
  `;
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
  const geo = localStorage.getItem("wopGeo");
  if (!geo){
    wc.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <div style="font-size:14px;color:var(--dim)">🌤 Wetter anzeigen?</div>
      <div style="display:flex;gap:8px">
        <button class="btn small sec" id="btnGeo">📍 Standort</button>
        <button class="btn small" id="btnCity">🏙 Ort eingeben</button></div></div>`;
    $("#btnGeo").onclick = askGeo;
    $("#btnCity").onclick = openCityPicker;
  } else {
    const w = await fetchWeather();
    if (!w || !w.current){ wc.innerHTML = `<div class="section-empty">Wetter gerade nicht verfügbar.</div>`; }
    else {
      const [ico,txt] = WMO[w.current.weather_code] || ["🌡","–"];
      const dmax = Math.round(w.daily.temperature_2m_max[0]), dmin = Math.round(w.daily.temperature_2m_min[0]);
      const rain = w.daily.precipitation_probability_max[0];
      const [ico2] = WMO[w.daily.weather_code[1]] || ["–"];
      const locName = (JSON.parse(geo)||{}).name || "";
      wc.innerHTML = `<div class="weather">
        <div class="wico">${ico}</div>
        <div><div class="wtemp">${Math.round(w.current.temperature_2m)}°</div><div class="wdesc">${txt}${locName?" · "+esc(locName):""}</div></div>
        <div class="wmeta">H ${dmax}° · T ${dmin}°<br>☔️ ${rain??0}% · 💨 ${Math.round(w.current.wind_speed_10m)} km/h<br>Morgen: ${ico2} ${Math.round(w.daily.temperature_2m_max[1])}°</div>
      </div>
      <div style="text-align:right;margin-top:6px"><a style="font-size:11.5px;color:var(--dim2);cursor:pointer" id="wChange">Standort ändern</a></div>`;
      $("#wChange").onclick = openCityPicker;
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

  // Timeline 05–24 Uhr (Blöcke davor werden geklemmt), 1h = 44px
  const H0=5, PXH=44, top = m => Math.max(0,(m/60-H0))*PXH;
  const blocks = blocksFor(S.planDate);
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
      <b>${t.ico} ${esc(b.title||t.label)}</b>
      ${h>34?`<span>${minToHM(b.start_min)}–${minToHM(b.end_min)}${b.notes?" · "+esc(b.notes):""}</span>`:""}</div>`;
  });
  tl += `</div>`;
  const empty = blocks.length ? "" : `<div class="section-empty" style="text-align:center;padding-top:10px">Noch keine Blöcke – mit + einen anlegen (Arbeit, Termin, Fahrt …)</div>`;

  el.innerHTML = nav + strip + tl + empty + `<div style="height:8px"></div>`;

  $$(".weekstrip button", el).forEach(b=>b.onclick=()=>{ S.planDate=b.dataset.d; renderPlan(); });
  const shift = days => { const d=new Date(S.planDate+"T12:00:00"); d.setDate(d.getDate()+days); S.planDate=dayKey(d); renderPlan(); };
  $("#pl_prev").onclick = ()=>shift(-1);
  $("#pl_next").onclick = ()=>shift(1);
  $("#pl_today").onclick = ()=>{ S.planDate=dayKey(new Date()); renderPlan(); };
  $$(".tl-block", el).forEach(x=>x.onclick=()=>{
    const b=S.timeBlocks.find(y=>y.id===x.dataset.id); if(b) openBlockForm(b);
  });
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
      notes:{type:"string"}, tags:{type:"array",items:{type:"string"}},
    }, required:["title"] } } },
  { type:"function", function:{ name:"create_appointment",
    description:"Termin/Zeitblock im Kalender anlegen",
    parameters:{ type:"object", properties:{
      date:{type:"string",description:"YYYY-MM-DD"},
      title:{type:"string"},
      start:{type:"string",description:"HH:MM"}, end:{type:"string",description:"HH:MM"},
      type:{type:"string",enum:["work","home","travel","event","routine","free","sleep"],description:"Standard: event"},
      notes:{type:"string"},
    }, required:["date","title","start","end"] } } },
  { type:"function", function:{ name:"add_work_entry",
    description:"Arbeitszeit-Eintrag nachtragen",
    parameters:{ type:"object", properties:{
      date:{type:"string",description:"YYYY-MM-DD"},
      start:{type:"string",description:"HH:MM"}, end:{type:"string",description:"HH:MM"},
      break_minutes:{type:"integer"}, notes:{type:"string"},
    }, required:["date","start","end"] } } },
  { type:"function", function:{ name:"complete_task",
    description:"Eine Aufgabe als erledigt abhaken (per Titel, unscharfe Suche)",
    parameters:{ type:"object", properties:{ title:{type:"string"} }, required:["title"] } } },
  { type:"function", function:{ name:"delete_appointment",
    description:"Termin/Zeitblock löschen (per Titel und Datum)",
    parameters:{ type:"object", properties:{
      title:{type:"string"}, date:{type:"string",description:"YYYY-MM-DD"} }, required:["title","date"] } } },
];

function aiContext(){
  const today = new Date();
  const dk = dayKey(today);
  const openTasks = S.tasks.filter(t=>!t.is_archived && !isCompletedToday(t)).slice(0,60)
    .map(t=>`- ${t.title} (${t.location||"?"}${t.is_priority?", ⭐":""}${t.due_date?", fällig "+dayKey(new Date(t.due_date)):""})`).join("\n");
  const week = [];
  for (let i=0;i<7;i++){ const d=new Date(); d.setDate(d.getDate()+i); const k=dayKey(d);
    const bl=blocksFor(k); if(bl.length) week.push(`${k} (${WEEKDAYS_DE[d.getDay()]}): `+bl.map(b=>`${minToHM(b.start_min)}-${minToHM(b.end_min)} ${b.title||b.type}`).join("; ")); }
  return `Du bist der Assistent der deutschsprachigen To-Do-App "Procrastination Lists" von Finn.
Heute ist ${today.toLocaleDateString("de-DE",{weekday:"long",day:"2-digit",month:"2-digit",year:"numeric"})} (${dk}), Uhrzeit ${fmtTime(today)}.
Du kannst per Tools Aufgaben, Termine (Zeitblöcke) und Arbeitszeiten anlegen, Aufgaben abhaken und Termine löschen.
Relative Datumsangaben ("morgen", "Freitag") immer in konkrete Daten umrechnen. Bei fehlender Endzeit eines Termins nimm 1 Stunde.
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
      const { error } = await sb.from("tasks").insert(row);
      if (error) throw error;
      return { ok:true, info:`Aufgabe "${args.title}" angelegt (${row.location})` };
    }
    if (name==="create_appointment"){
      const row = { date:args.date, title:args.title, type:args.type||"event",
        start_min:hm(args.start), end_min:hm(args.end), notes:args.notes||"", color:"" };
      const { error } = await sb.from("time_blocks").insert(row);
      if (error) throw error;
      return { ok:true, info:`Termin "${args.title}" am ${args.date} ${args.start}–${args.end}` };
    }
    if (name==="add_work_entry"){
      const st = new Date(`${args.date}T${args.start}:00`), en = new Date(`${args.date}T${args.end}:00`);
      const { error } = await sb.from("work_entries").insert({ start_time:st.toISOString(), end_time:en.toISOString(),
        break_minutes:args.break_minutes||0, notes:args.notes||"" });
      if (error) throw error;
      return { ok:true, info:`Arbeitszeit ${args.date} ${args.start}–${args.end} eingetragen` };
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

function renderChat(){
  const log = $("#chatLog"); if (!log) return;
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

// Skincare steckt in der Abendroutine (kein eigenes Kärtchen)
const isSkincareLoc = name => /skincare|pflege/i.test(name);
function mergedRoutineTasks(name){
  let ts = routineTasksFor(name);
  if (/evening|abend/i.test(name)){
    S.locations.filter(l=>l.is_routine && isSkincareLoc(l.name))
      .forEach(l=>{ ts = ts.concat(routineTasksFor(l.name)); });
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
const VAPID_PUBLIC_KEY = "BHWmrGuXg9qtBkjJiNrtvx03b70TiZwDlAJIyCItZH8rBfOJAJA7M64stnC3wxe-kHOHrCpRUcdqWw4qadE-rdY";

function b64ToU8(base64){
  const pad = "=".repeat((4 - base64.length % 4) % 4);
  const b = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b); const arr = new Uint8Array(raw.length);
  for (let i=0;i<raw.length;i++) arr[i]=raw.charCodeAt(i);
  return arr;
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

async function renderNotifySettings(){
  const box = $("#s_notifyBox"); if (!box) return;
  const status = await pushStatus();
  const digestOn = getSetting("notifyDigestEnabled", false);
  const digestMin = getSetting("notifyDigestMin", 480);
  const alarmsOn = getSetting("notifyBlockAlarms", true);
  const lead = getSetting("notifyBlockLead", 30);
  const hmv = m => `${pad(Math.floor(m/60))}:${pad(m%60)}`;
  const routines = S.locations.filter(l=>l.is_routine);

  box.innerHTML = `
    ${ status==="unsupported" ? `<div class="section-empty">Auf iPhone/iPad: App zuerst über Teilen → „Zum Home-Bildschirm" installieren und von dort öffnen – dann geht's.</div>` : `
    <div class="switch"><label>${status==="on"?"✅ Aktiv auf diesem Gerät":"Auf diesem Gerät aktivieren"}</label>
      <button class="toggle ${status==="on"?"on":""}" id="n_toggle"></button></div>` }
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
  $("#n_digest").onclick = async e=>{
    await saveSetting("notifyDigestEnabled", !digestOn); renderNotifySettings();
  };
  const dt = $("#n_digesttime");
  if (dt) dt.onchange = ()=>saveSetting("notifyDigestMin", hmToMin(dt.value));
  $("#n_alarms").onclick = async ()=>{ await saveSetting("notifyBlockAlarms", !alarmsOn); renderNotifySettings(); };
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
  return base + S.completions.reduce((a,c)=>a + 10 + Math.min(c.minutes||0,120)*2, 0);
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
  setFocusState({ taskId, start: Date.now(), five: !!opts.five,
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
  const targetMin = f.five ? 5 : Math.max(1, t.duration_minutes);
  const pct = Math.min(100, 100*elapsed/(targetMin*60));
  const over = elapsed > targetMin*60;
  const fiveChoice = f.five && over && !f.askedFive;

  // Nur bei Zustandswechsel den DOM neu bauen – sonst nur Timer/Balken updaten.
  // (Voll-Rerender jede Sekunde würde Taps verschlucken, die genau dann passieren.)
  const domKey = [f.taskId, f.five, fiveChoice, f.queue.length, over, (!f.five && elapsed<60)].join("|");
  if (domKey === _focusDomKey){
    const tm = $(".focus-timer", el); if (tm) tm.textContent = `${pad(mm)}:${pad(ss)}`;
    const sub = $(".focus-sub", el);
    if (sub) sub.textContent = over ? `+${fmtMin(Math.ceil(elapsed/60 - targetMin))} über Plan (${fmtMin(targetMin)})` : `Ziel: ${fmtMin(targetMin)}`;
    const bar = $(".focus-bar>div", el); if (bar) bar.style.width = pct+"%";
    return;
  }
  _focusDomKey = domKey;

  el.innerHTML = `
    ${f.label?`<div class="focus-kicker">${esc(f.label)} · noch ${f.queue.length+1} Schritt${f.queue.length?"e":""}</div>`:`<div class="focus-kicker">${f.five?"Nur 5 Minuten":"Fokus"}</div>`}
    <div class="focus-title">${esc(t.title)}</div>
    <div class="focus-timer">${pad(mm)}:${pad(ss)}</div>
    <div class="focus-sub">${over?`+${fmtMin(Math.ceil(elapsed/60 - targetMin))} über Plan (${fmtMin(targetMin)})`:`Ziel: ${fmtMin(targetMin)}`}</div>
    <div class="focus-bar"><div style="width:${pct}%"></div></div>
    ${fiveChoice ? `<div class="focus-choice">
      <b>5 Minuten geschafft! 💪</b>
      <div style="font-size:13px;color:var(--dim);margin:6px 0 12px">Du bist drin – weitermachen? Oder ehrenvoll aufhören, zählt beides.</div>
      <button class="btn" id="fc_more">🔥 Weitermachen</button>
      <div style="height:8px"></div>
      <button class="btn sec" id="fc_enough">Genug für heute</button>
    </div>` : `<div class="focus-btns">
      <button class="btn" id="fc_done" style="background:var(--green);color:#08351d">✓ Fertig!</button>
      ${!f.five && elapsed<60 ? `<button class="btn sec" id="fc_five">⏱ Nur 5 Minuten draus machen</button>` : ""}
      <button class="btn sec" id="fc_cancel">Abbrechen</button>
    </div>`}
  `;

  const done = $("#fc_done");
  if (done) done.onclick = async ()=>{
    const spent = Math.max(1, Math.round((Date.now()-f.start)/60000));
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
  const five = $("#fc_five");
  if (five) five.onclick = ()=>{ const x=getFocus(); x.five=true; setFocusState(x); renderFocus(); };
  const cancel = $("#fc_cancel");
  if (cancel) cancel.onclick = stopFocus;
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
  b.textContent = active ? "⏺" : "🎤";
  b.style.background = active ? "var(--red)" : "var(--card2)";
  b.style.color = active ? "#fff" : "var(--text)";
}
function toggleVoice(){
  if (_voiceRec || _mediaRec) return stopVoice();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR){
    _voiceRec = new SR();
    _voiceRec.lang = "de-DE";
    _voiceRec.interimResults = false;
    _voiceRec.onresult = e=>{
      const text = e.results[0][0].transcript;
      _voiceRec = null; voiceBtnState(false);
      const inp = $("#chatIn"); if (inp){ inp.value = text; sendChat(); }
    };
    _voiceRec.onerror = e=>{
      _voiceRec = null; voiceBtnState(false);
      if (e.error==="not-allowed") toast("Mikrofon nicht erlaubt.", true);
      else whisperRecord(); // Fallback über OpenAI
    };
    _voiceRec.onend = ()=>{ if (_voiceRec){ _voiceRec = null; voiceBtnState(false); } };
    try { _voiceRec.start(); voiceBtnState(true); toast("🎤 Sprich – ich höre zu…"); }
    catch(e){ _voiceRec = null; whisperRecord(); }
  } else {
    whisperRecord();
  }
}
function stopVoice(){
  if (_voiceRec){ try{ _voiceRec.stop(); }catch(e){} _voiceRec=null; voiceBtnState(false); }
  if (_mediaRec && _mediaRec.state!=="inactive") _mediaRec.stop(); // onstop transkribiert
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
    toast("⏺ Aufnahme läuft – zum Stoppen nochmal tippen");
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
  let base = null;
  try { base = JSON.parse(localStorage.getItem("wopGeo")||"null"); } catch(e){}
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
    return `<div class="planrow" data-pblock="${b.id}" role="button" tabindex="0" style="padding:7px 0">
      <span class="ptime" style="min-width:40px">${minToHM(b.start_min)}</span>
      <span style="width:8px;height:8px;min-width:8px;border-radius:50%;background:${blockColor(b)}"></span>
      <span class="pt" style="font-size:13.5px">${esc(b.title||t.label)}</span>
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
