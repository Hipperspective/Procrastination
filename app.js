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

// ---------- State ----------
const S = {
  user: null,
  tasks: [], locations: [], completions: [], workEntries: [], settings: {}, timeBlocks: [],
  planDate: null, chat: [], chatBusy: false,
  locFilter: "ALLE", tagFilter: null, tab: "home",
  expanded: new Set(),   // task ids with open subtasks
  tickTimer: null,
};

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
const daysBetween = (a,b) => Math.floor((startOfDay(b)-startOfDay(a))/86400000);
const esc = s => String(s??"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())+Math.random());

function toast(msg, isErr){
  let t = $("#toastEl");
  if(!t){ t=document.createElement("div"); t.id="toastEl";
    t.style.cssText="position:fixed;left:50%;transform:translateX(-50%);bottom:calc(96px + env(safe-area-inset-bottom,0px));background:#2a3348;color:#fff;padding:10px 18px;border-radius:12px;font-size:14px;z-index:200;transition:opacity .3s;max-width:85%;text-align:center;";
    document.body.appendChild(t); }
  t.textContent = msg; t.style.background = isErr ? "#8c2f39" : "#2a3348";
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
    sb.from("work_entries").select("*").order("start_time",{ascending:false}).limit(500),
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
function initRealtime(){
  sb.channel("sync-all")
    .on("postgres_changes", { event:"*", schema:"public" }, scheduleReload)
    .subscribe(status=>{
      if (status==="SUBSCRIBED") setSync("ok","synchron (live)");
    });
  document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) loadAll(); });
}

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
async function completeTask(t){
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
  // Optimistisch lokal
  Object.assign(t, upd);
  renderAll();
  const { error } = await sb.from("tasks").update(upd).eq("id", t.id);
  if (error){ toast("Speichern fehlgeschlagen: "+error.message, true); return; }
  await sb.from("completions").insert({ task_id:t.id, title:t.title, minutes:t.duration_minutes });
  // Arbeitszeit automatisch buchen, wenn der Ort ein Arbeitsort ist
  const loc = S.locations.find(l => l.name.toLowerCase() === (t.location||"").toLowerCase());
  if (loc && loc.is_work_location){
    const end = new Date();
    const start = new Date(end - Math.max(1,t.duration_minutes)*60000);
    await sb.from("work_entries").insert({ start_time:start.toISOString(), end_time:end.toISOString(), notes:"Task: "+t.title });
    toast(`✓ Erledigt – ${fmtMin(t.duration_minutes)} Arbeitszeit gebucht`);
  } else {
    toast(fullyDone ? "✓ Erledigt!" : `✓ ${count}/${t.repeat_count} geschafft`);
  }
  loadAll();
}

async function uncompleteToday(t){
  const upd = { completed_today_count:0, last_repeat_completed_at:null, last_done_at:null,
    last_completed_count_reset:new Date().toISOString(), is_archived:false };
  Object.assign(t, upd); renderAll();
  await sb.from("tasks").update(upd).eq("id", t.id);
  // letzte heutige Completion(s) dieses Tasks entfernen
  const todayStart = startOfDay(new Date()).toISOString();
  await sb.from("completions").delete().eq("task_id", t.id).gte("completed_at", todayStart);
  loadAll();
}

async function toggleSubtask(t, subId){
  const subs = (t.subtasks||[]).map(s => s.id===subId ? {...s, done:!s.done} : s);
  t.subtasks = subs; renderAll();
  await sb.from("tasks").update({ subtasks: subs }).eq("id", t.id);
}

// ---------- Rendering: Aufgaben ----------
function visibleTasks(){
  return S.tasks.filter(t => !t.is_archived)
    .filter(t => S.locFilter==="ALLE" || (t.location||"") === S.locFilter)
    .filter(t => !S.tagFilter || (t.tags||[]).some(x => x.toLowerCase()===S.tagFilter.toLowerCase()));
}

function renderLocationChips(){
  const counts = {};
  S.tasks.filter(t=>!t.is_archived).forEach(t=>{ counts[t.location||""] = (counts[t.location||""]||0)+1; });
  const el = $("#locChips");
  const chips = [{name:"ALLE", label:"Alle", n:S.tasks.filter(t=>!t.is_archived).length}]
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
    <div class="main">
      <div class="title">${esc(t.title)}</div>
      <div class="meta">${meta.join(" ")}</div>
      ${subHtml}
    </div>
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
  html += section("🔥 Jetzt fällig", dueNow);
  if (S.locFilter==="ALLE"){
    // Nach Ort/Kategorie gruppieren (Reihenfolge wie in den Einstellungen)
    const palette = ["#6c8cff","#3ddc84","#ff9f43","#b58cff","#38d4c3","#ffd54f","#f48fb1","#ff5d6c","#7986cb","#a1887f"];
    const locSection = (name, color, arr) => arr.length ? `
      <div class="locsec"><span class="dot" style="background:${color}"></span>
      <h2>${esc(name)}</h2><span class="cnt">${arr.length}</span></div>` + arr.map(taskRow).join("") : "";
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
  el.innerHTML = html;

  // Events
  $$(".task", el).forEach(row => {
    const t = S.tasks.find(x=>x.id===row.dataset.id);
    $(".chk", row).onclick = (e)=>{ e.stopPropagation();
      if (isCompletedToday(t)){ if(confirm("Erledigung von heute zurücknehmen?")) uncompleteToday(t); }
      else completeTask(t);
    };
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
      <div class="main"><div class="title">${esc(t.title)}</div>
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
    $("[data-act=del]",row).onclick = async ()=>{
      if(!confirm(`„${t.title}" endgültig löschen?`)) return;
      await sb.from("tasks").delete().eq("id",t.id); loadAll();
    };
  });
}

// ---------- Modal-Grundgerüst ----------
function openModal(html){
  $("#modalBox").innerHTML = html;
  $("#modalBg").classList.add("open");
}
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
  $("#fab").onclick = ()=>{ if(S.tab==="work") openWorkEntryForm(null); else if(S.tab==="plan") openBlockForm(null); else openTaskForm(null); };
  $("#btnChat").onclick = openChat;
  $("#btnSettings").onclick = openSettings;
  initRealtime();
  loadAll();
  // Ticker für laufende Stempeluhr & Cooldowns
  S.tickTimer = setInterval(()=>{ if(S.tab==="work") renderWork(); if(S.tab==="home") renderHome(); }, 30000);
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
    <div style="height:18px"></div>
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
  if (!isNew) $("#f_del").onclick = async ()=>{
    if (!confirm(`„${t.title}" löschen?`)) return;
    await sb.from("tasks").delete().eq("id", t.id);
    closeModal(); loadAll();
  };
}

// ============================================================
// Arbeitszeit
// ============================================================
function runningEntry(){ return S.workEntries.find(w=>!w.end_time); }
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
      arr.map(w=>`<div class="wt-entry" data-id="${w.id}">
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
          arr.map(w=>`<div class="wt-entry" data-id="${w.id}">
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
      if (run.break_started_at){
        const add = Math.max(0, Math.round((Date.now()-new Date(run.break_started_at))/60000));
        await sb.from("work_entries").update({ break_minutes:(run.break_minutes||0)+add, break_started_at:null }).eq("id",run.id);
      } else {
        await sb.from("work_entries").update({ break_started_at:new Date().toISOString() }).eq("id",run.id);
      }
      loadAll();
    };
    $("#w_out").onclick = async ()=>{
      let brk = run.break_minutes||0;
      if (run.break_started_at) brk += Math.max(0, Math.round((Date.now()-new Date(run.break_started_at))/60000));
      await sb.from("work_entries").update({ end_time:new Date().toISOString(), break_minutes:brk, break_started_at:null }).eq("id",run.id);
      toast("Ausgestempelt ✓"); loadAll();
    };
  } else {
    $("#w_in").onclick = async ()=>{
      await sb.from("work_entries").insert({ start_time:new Date().toISOString() });
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
  if (!isNew) $("#we_del").onclick = async ()=>{
    if(!confirm("Eintrag löschen?")) return;
    await sb.from("work_entries").delete().eq("id",w.id); closeModal(); loadAll();
  };
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
      <div class="stat"><div class="v">${weekN}</div><div class="l">Diese Woche</div></div>
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
      <div class="n">${l.is_work_location?"💼 Arbeitsort (Tasks buchen Arbeitszeit)":""}</div></div>
      <div>
        <button class="iconbtn" data-act="work" title="Arbeitsort umschalten">💼</button>
        <button class="iconbtn" data-act="del" title="Löschen">🗑</button>
      </div>
    </div>`).join("");
  openModal(`
    <h3>Einstellungen</h3>
    <label>Orte / Listen</label>
    <div class="card" style="margin-top:4px">${locRows||"<div class='section-empty'>Keine Orte.</div>"}</div>
    <div class="mrow"><input id="s_newloc" placeholder="Neuer Ort…"><button class="btn small sec" id="s_addloc" style="width:auto">+</button></div>
    <div style="height:20px"></div>
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
    $("[data-act=work]",row).onclick = async ()=>{
      await sb.from("locations").update({is_work_location:!l.is_work_location}).eq("id",l.id);
      await loadAll(); openSettings();
    };
    $("[data-act=del]",row).onclick = async ()=>{
      if(!confirm(`Ort „${l.name}" löschen? (Aufgaben bleiben erhalten)`)) return;
      await sb.from("locations").delete().eq("id",l.id);
      await loadAll(); openSettings();
    };
  });
  $("#s_addloc").onclick = async ()=>{
    const v=$("#s_newloc").value.trim(); if(!v) return;
    await sb.from("locations").insert({name:v, sort_order:S.locations.length});
    await loadAll(); openSettings();
  };
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
      time_blocks.push({ id: lc(tb.id), date: dk, title: tb.title||"",
        type: typeMap[tb.typeRaw]||"event", start_min: tb.startTime||0, end_min: tb.endTime||0,
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
    const past = b.end_min < nowM;
    return `<div class="planrow ${past?"pdone":""}" data-block="${b.id}">
      <span class="ptime">${minToHM(b.start_min)}</span>
      <span class="pt">${t.ico} ${esc(b.title||t.label)}</span>
      <span class="pm">bis ${minToHM(b.end_min)}</span></div>`;
  }).join("");
}

function homePlanItems(){
  // Heutiger Plan: geplante Aufgaben (mit/ohne Uhrzeit), Fällige, Prioritäten
  const items = [];
  const active = S.tasks.filter(t=>!t.is_archived && isActiveWeekday(t) && startReached(t));
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
    if (t.location) bits.push("📍 "+esc(t.location));
    if (!p.done && t.repeat_count>1) bits.push(`${effCompletedToday(t)}/${t.repeat_count}×`);
    const st = taskDueState(t);
    if (!p.done && st.label && st.cls) bits.push(`<span class="${st.cls}">${st.label}</span>`);
    return `<div class="planrow ${p.done?"pdone":""}" data-id="${t.id}">
      <span class="ptime">${p.time || (p.done?"✓":(t.is_priority?"★":"•"))}</span>
      <span class="pt">${esc(t.title)}</span>
      <span class="pm">${bits.join(" · ")}</span></div>`;
  };

  el.innerHTML = `
    <div class="hero">
      <div class="greet">${greetingText()}, Finn! 👋</div>
      <div class="date">${dateStr}</div>
      ${streak>0?`<div class="streakline">🔥 ${streak} Tage-Streak – weiter so!</div>`:""}
    </div>

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

    ${ homeBlockRows() ? `<div class="homehead"><h2>📅 Termine heute</h2><a id="homeToPlan">Zum Plan ›</a></div>
    <div class="card">${homeBlockRows()}</div>` : "" }
    <div class="homehead"><h2>📋 Aufgaben</h2><a id="homeToTasks">Alle Aufgaben ›</a></div>
    <div class="card">${ openPlan.length ? openPlan.map(planRow).join("")
      : `<div class="section-empty">${totalN?"Alles erledigt – stark! 🎉":"Heute steht nichts an. Genieß den Tag ☕️"}</div>`}</div>
    ${donePlan.length?`<div class="card" style="opacity:.65">${donePlan.map(planRow).join("")}</div>`:""}
  `;

  $("#homeToTasks").onclick = ()=>switchTab("tasks");
  const hp = $("#homeToPlan"); if (hp) hp.onclick = ()=>{ S.planDate=dayKey(new Date()); switchTab("plan"); };
  $$("[data-block]", el).forEach(row=>row.onclick=()=>{
    const b=S.timeBlocks.find(x=>x.id===row.dataset.block); if(b) openBlockForm(b);
  });
  $("#homeWork").onclick = ()=>switchTab("work");
  $$(".planrow[data-id]", el).forEach(row=>{
    row.onclick = ()=>{ const t=S.tasks.find(x=>x.id===row.dataset.id); if(t) openTaskForm(t); };
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
      <div style="text-align:right;margin-top:6px"><a style="font-size:11.5px;color:var(--dim2);cursor:pointer" id="wChange">Ort ändern</a></div>`;
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
    tl += `<div class="tl-block" data-id="${b.id}" style="top:${top(b.start_min)+1}px;height:${h}px;
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
  if (!isNew) $("#b_del").onclick = async ()=>{
    if(!confirm("Block löschen?")) return;
    await sb.from("time_blocks").delete().eq("id", b.id); closeModal(); loadAll();
  };
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
        <input id="chatIn" placeholder="z.B. Freitag 14 Uhr Zahnarzt eintragen…" autocomplete="off">
        <button id="chatSend">➤</button>
      </div>
    </div>
  `);
  renderChat();
  $("#chatSend").onclick = sendChat;
  $("#chatIn").addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); sendChat(); } });
  if (!localStorage.getItem("wopAiKey")){
    S.chat.push({ role:"sys", text:"Hinterlege zuerst deinen OpenAI API-Key unter ⚙️ Einstellungen." });
    renderChat();
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
