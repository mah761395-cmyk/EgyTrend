/**
 * EgyTrend — ADMIN PANEL (server-gated asset).
 *
 * This file is NOT part of the public site bundle. It is served only by
 * GET /api/admin/panel.js, which requires a verified staff session
 * (httpOnly cookie signed by SESSION_SECRET). A visitor or a logged-in
 * regular user gets 401 and never receives this code.
 *
 * It is loaded on demand by the public bundle through loadAdminPanel(), and
 * it registers itself on window.__egytrendAdminPanel. All admin API calls go
 * through admFetch() (defined in the public bundle) and are re-authorised by
 * the server on every single request.
 *
 * Generated from the former inline block by scripts/extract-admin-panel.mjs —
 * edit here, not in index.html.
 */
(function () {
  "use strict";
  var MARKUP = "<!-- Admin -->\n<div id=\"adm\">\n  <div class=\"adm-hdr\">\n    <div class=\"row\"><span style=\"font-size:17px;\">⚙️</span><div style=\"color:var(--g);font-weight:800;font-size:14px;\">لوحة التحكم</div></div>\n    <button class=\"r-btn rej\" onclick=\"closeAdm()\">خروج ✕</button>\n  </div>\n  <div class=\"adm-stats\" id=\"adm-stats\"></div>\n  <div class=\"adm-tabs\" style=\"overflow-x:auto;\">\n    <button class=\"adm-tab active\" data-tab=\"dash\" onclick=\"admTab('dash')\">📊 الإحصائيات</button>\n    <button class=\"adm-tab\" data-tab=\"users\" onclick=\"admTab('users')\">👥 المستخدمون</button>\n    <button class=\"adm-tab\" data-tab=\"reqs\" onclick=\"admTab('reqs')\">💰 الدفعات</button>\n    <button class=\"adm-tab\" data-tab=\"articles\" onclick=\"admTab('articles')\">📰 الأخبار</button>\n    <button class=\"adm-tab\" data-tab=\"sources\" onclick=\"admTab('sources')\">🔗 المصادر</button>\n    <button class=\"adm-tab\" data-tab=\"plans\" onclick=\"admTab('plans')\">💎 الاشتراكات</button>\n    <button class=\"adm-tab\" data-tab=\"coupons\" onclick=\"admTab('coupons')\">🎟️ الكوبونات</button>\n    <button class=\"adm-tab\" data-tab=\"employees\" onclick=\"admTab('employees')\">👨‍💼 الموظفون</button>\n    <button class=\"adm-tab\" data-tab=\"aiconfig\" onclick=\"admTab('aiconfig')\">🤖 إدارة AI</button>\n    <button class=\"adm-tab\" data-tab=\"audit\" onclick=\"admTab('audit')\">📋 سجل العمليات</button>\n    <button class=\"adm-tab\" data-tab=\"opps\" onclick=\"admTab('opps')\">💡 الفرص</button>\n  </div>\n  <div class=\"adm-body\" id=\"adm-body\"></div>\n</div>";

  /* Injected on first mount so the panel markup never ships with the page. */
  function mountAdminPanel() {
    var existing = document.getElementById("adm");
    if (existing) return existing;
    var host = document.createElement("div");
    host.innerHTML = MARKUP;
    var el = host.firstElementChild;
    document.body.appendChild(el);
    return el;
  }

  window.__egytrendAdminPanel = {
    mount: mountAdminPanel,
    open: function () {
      mountAdminPanel();
      document.getElementById("adm").classList.add("open");
      /* Probe the session once so the UI knows which tabs the logged-in staff
       * member may open (fine-grained permissions can narrow the role). */
      await admFetchSession();
      renderAdmStats();
      admTab("dash");
    },
    close: function () {
      var a = document.getElementById("adm");
      if (a) a.classList.remove("open");
    },
  };
})();

/* ────────────────── dashboard (verbatim from the former inline block) ────────────────── */
/* ═══════════════════ ADMIN ═══════════════════ */
/* ══════════════════════════════════════════════════════════════
   ADMIN DASHBOARD — FULL PRODUCTION SYSTEM
══════════════════════════════════════════════════════════════ */

async async function openAdm(){document.getElementById("adm").classList.add("open");await admFetchSession();renderAdmStats();admTab("dash");}
function closeAdm(){document.getElementById("adm").classList.remove("open");}

async function renderAdmStats(){
  let allU=[],reqs=[];
  try{allU=await loadAdminUsers();const r=await admFetch("/api/admin/requests");const d=await r.json();reqs=d.requests||[];}catch{}
  const pending=reqs.filter(r=>r.status==="pending");
  document.getElementById("adm-stats").innerHTML=[
    {l:"مستخدمون",v:allU.length,c:"#3b82f6"},{l:"VIP نشط",v:allU.filter(u=>u.plan==="vip").length,c:"#f59e0b"},
    {l:"معلّقة",v:pending.length,c:"#ef4444"},{l:"طلبات",v:reqs.length,c:"#10b981"},
  ].map(s=>`<div class="astat"><div class="astat-v" style="color:${s.c};">${s.v}</div><div class="astat-l">${s.l}</div></div>`).join("");
}

const ADM_TABS=["dash","users","reqs","articles","sources","plans","coupons","employees","aiconfig","audit"];

/* Permission store — populated by /me on panel open. A null list means the
 * role alone decides (backward compatible). */
const ADM_PERMISSION_STORE={permission:"granted",permissions:null};

async function admFetchSession(repo){
  /* /api/admin/me must run with the staff cookie; it returns the actor and
   * the effective permission list for every sensitive read route. */
  try{
    const r=await fetch("/api/admin/me",{credentials:"same-origin"});
    if(!r.ok) return;
    const j=await r.json();
    if(j.status!=="ok") return;
    const perms=j.permissions;
    const isSuperAdmin=j.actor?.role==="super_admin";
    ADM_PERMISSION_STORE.permission=isSuperAdmin?"granted":(Array.isArray(perms)?perms:[]).length?"denied":"granted";
    ADM_PERMISSION_STORE.permissions=isSuperAdmin?[...ADM_PERMISSIONS]:(Array.isArray(perms)?perms:[]);
    /* One page can hold many sensitive reads; a rejection on the previously
     * loaded tab is already handled by admTab(), so prune the visible tabs. */
    Object.keys(ADM_TAB_PERMS).forEach(k=>{
      const t=document.querySelector(`.adm-tab[data-tab="${k}"]`);
      if(t&&ADM_TAB_PERMS[k]!==null&&ADM_PERMISSION_STORE.permissions&&!ADM_PERMISSION_STORE.permissions.includes(ADM_TAB_PERMS[k])) {
        t.style.display="none";
      } else {
        t.style.display="";
      }
    });
  }catch{
    /* offline / panel not ready yet — treat as unrestricted, the server will
     * still 403 on any sensitive read. */
  }
}

async function admTab(tab){
  document.querySelectorAll(".adm-tab").forEach(t=>t.classList.toggle("active",t.dataset.tab===tab));
  if(tab!=="dash"){
    const perm=ADM_TAB_PERMS[tab];
    if(perm!==null&&ADM_PERMISSION_STORE.permission==="denied"&&ADM_PERMISSION_STORE.permissions&&!ADM_PERMISSION_STORE.permissions.includes(perm)){
      /* The requested tab needs a permission the user no longer has — silently
elevate to the overview instead of a 403 everywhere. */
      const fallback=Object.entries(ADM_TAB_PERMS).find(([,p])=>!p||ADM_PERMISSION_STORE.permissions.includes(p));
      if(fallback) tab=fallback[0];
      else return; // truly locked out: overview has no sensitive data
    }
  }
  const el=document.getElementById("adm-body");
  el.innerHTML=`<div class="empty"><div style="font-size:22px;margin-bottom:8px;">⏳</div><div>جارٍ التحميل...</div></div>`;
  const fns={dash:renderAdmDash,users:renderAdmUsers,reqs:renderAdmReqs,articles:renderAdmArticles,
    sources:renderAdmSources,plans:renderAdmPlans,coupons:renderAdmCoupons,
    employees:renderAdmEmployees,aiconfig:renderAdmAIConfig,audit:renderAdmAudit,opps:renderAdmOpps};
  if(fns[tab]) fns[tab](el);
}

/* ─── Helpers ─── */
function aCard(title,val,color,sub=""){
  return `<div style="background:var(--s1);border:1px solid var(--b1);border-radius:14px;padding:14px 16px;flex:1;min-width:120px;">
    <div style="color:${color};font-size:22px;font-weight:900;font-family:var(--mono);">${val}</div>
    <div style="color:var(--t3);font-size:11px;font-weight:700;margin-top:3px;">${title}</div>
    ${sub?`<div style="color:var(--t5);font-size:9px;margin-top:2px;">${sub}</div>`:""}
  </div>`;
}
function aRow(label,val){return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--b1);"><span style="color:var(--t3);font-size:12px;">${label}</span><span style="color:var(--t2);font-size:12px;font-weight:700;">${val}</span></div>`;}
function aSection(title,content){return `<div style="margin-bottom:18px;"><div style="color:var(--t2);font-weight:800;font-size:13px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--b1);">${title}</div>${content}</div>`;}
function aFormRow(...html){return `<div style="display:grid;grid-template-columns:${html.length>1?"1fr ".repeat(html.length).trim():"1fr"};gap:7px;margin-bottom:7px;">${html.join("")}</div>`;}
function aIn(id,ph,extra=""){return `<input id="${id}" placeholder="${ph}" class="a-in" ${extra} />`;}
function aSel(id,opts,extra=""){return `<select id="${id}" class="a-in" ${extra}>${opts.map(o=>`<option value="${o.v}">${o.l}</option>`).join("")}</select>`;}
function aBtn(label,onclick,color="var(--g)"){return `<button class="btn btn-sm" style="background:${color};color:#000;font-weight:700;border:none;padding:8px 14px;border-radius:9px;cursor:pointer;width:100%;margin-top:9px;font-family:var(--sans);" onclick="${onclick}">${label}</button>`;}
function aBadge(label,bg,fg="#fff"){return `<span class="bdg" style="background:${bg};color:${fg};">${label}</span>`;}
function vG(id){return (document.getElementById(id)||{}).value||"";}
async function loadAdminUsers(){
  const r=await admFetch("/api/admin/users");
  const d=await r.json();
  if(!r.ok||d.status!=="ok")throw new Error(d.message||"failed");
  return d.users||[];
}

/* ─── Dashboard ─── */
async function renderAdmDash(el){
  let users=[],reqs=[];
  try{users=await loadAdminUsers();const r=await admFetch("/api/admin/requests");const d=await r.json();reqs=d.requests||[];}catch{}
  const vipCount=users.filter(u=>u.plan==="vip").length;
  const pendingCount=reqs.filter(r=>r.status==="pending").length;
  let serverStats={employees:0,plans:0,coupons:0,auditLogs:0,aiUsage30d:0};
  let recentAudit=[];
  try{
    const r=await admFetch("/api/admin/stats");
    const j=await r.json();
    if(j.status==="ok"){serverStats=j.stats;recentAudit=j.recentAudit||[];}
  }catch{}

  el.innerHTML=`
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
    ${aCard("المستخدمون الكل",users.length,"#3b82f6")}
    ${aCard("VIP نشط",vipCount,"#f59e0b")}
    ${aCard("طلبات معلّقة",pendingCount,"#ef4444")}
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;">
    ${aCard("الموظفون",serverStats.employees,"#8b5cf6")}
    ${aCard("خطط الاشتراك",serverStats.plans,"#10b981")}
    ${aCard("الكوبونات",serverStats.coupons,"#06b6d4")}
    ${aCard("AI (30 يوم)",serverStats.aiUsage30d,"#f59e0b")}
  </div>
  ${aSection("📋 آخر العمليات",recentAudit.length?recentAudit.map(l=>`
    <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--b1);">
      <div><div style="color:var(--t2);font-size:11.5px;font-weight:700;">${sanitize(String(l.action||""))}</div>
      <div style="color:var(--t4);font-size:10px;">${sanitize(String(l.actorName||""))} · ${sanitize(String(l.target||""))}</div></div>
      <div style="color:var(--t5);font-size:9px;font-family:var(--mono);">${l.createdAt?new Date(l.createdAt).toLocaleString("ar-EG"):""}</div>
    </div>`).join(""):`<div class="empty" style="padding:20px;font-size:12px;">لا توجد عمليات بعد</div>`)}
  `;
}

/* ─── Users ─── */
async function renderAdmUsers(el){
  let users=[];
  try{
    const r=await admFetch("/api/admin/users");
    const d=await r.json();
    if(!r.ok||d.status!=="ok")throw new Error(d.message||"failed");
    users=d.users||[];
  }catch(e){
    el.innerHTML=`<div class="empty" style="color:var(--dn);">⚠️ تعذر تحميل المستخدمين</div>`;
    return;
  }
  let userSearch="";
  const render=()=>{
    const filtered=userSearch?users.filter(u=>(u.name||"").includes(userSearch)||(u.phone||"").includes(userSearch)):users;
    document.getElementById("adm-users-list").innerHTML=filtered.length?filtered.map(u=>`
      <div style="background:var(--s1);border:1px solid var(--b1);border-radius:12px;padding:11px 13px;margin-bottom:7px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="flex:1;">
            <div style="color:var(--t2);font-weight:700;font-size:13px;">${sanitize(u.name||"")}</div>
            <div style="color:var(--t4);font-size:10.5px;font-family:var(--mono);margin-top:2px;">${sanitize(u.phone||"")}</div>
            <div style="margin-top:5px;display:flex;gap:4px;flex-wrap:wrap;">
              ${u.plan==="vip"?aBadge("⭐ VIP","var(--aud)","var(--au)"):aBadge("مجاني","var(--s2)","var(--t4)")}
               ${u.status==="banned"?aBadge("🚫 محظور","var(--dnd)","var(--dn)"):""}
               ${u.vipExpiresAt?aBadge("حتى "+new Date(u.vipExpiresAt).toLocaleDateString("ar-EG"),"var(--bld)","#93c5fd"):""}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:5px;align-items:flex-end;">
            ${u.plan!=="vip"&&u.plan!=="admin"?`<button class="r-btn app" style="font-size:10px;" onclick="admUserAction('upgrade_vip','${sanitize(u.phone)}','${sanitize(u.name||"")}')">⭐ ترقية VIP</button>`:`<button class="r-btn" style="font-size:10px;background:var(--s2);color:var(--t4);border:1px solid var(--b1);" onclick="admUserAction('downgrade_vip','${sanitize(u.phone)}','${sanitize(u.name||"")}')">↓ إلغاء VIP</button>`}
             ${u.status==="banned"?`<button class="r-btn app" style="font-size:10px;" onclick="admUserAction('unban_user','${sanitize(u.phone)}','${sanitize(u.name||"")}')">✓ فك الحظر</button>`:`<button class="r-btn rej" style="font-size:10px;" onclick="admUserAction('ban_user','${sanitize(u.phone)}','${sanitize(u.name||"")}')">🚫 حظر</button>`}
          </div>
        </div>
      </div>`).join(""):
      `<div class="empty"><div style="font-size:26px;margin-bottom:7px;">👥</div><div>لا يوجد مستخدمون</div></div>`;
  };
  el.innerHTML=`
    <input id="adm-user-search" placeholder="🔍 البحث بالاسم أو الهاتف..." class="a-in" style="width:100%;box-sizing:border-box;margin-bottom:12px;" oninput="userSearch=this.value;render()">
    <div style="color:var(--t4);font-size:11px;margin-bottom:10px;">${users.length} مستخدم مسجّل</div>
    <div id="adm-users-list"></div>`;
  document.getElementById("adm-user-search").addEventListener("input",e=>{userSearch=e.target.value;render();});
  render();
}

async function admUserAction(action,phone,name){
  const labels={upgrade_vip:"ترقية VIP",downgrade_vip:"إلغاء VIP",ban_user:"حظر",unban_user:"فك الحظر"};
  if(!confirm(`${labels[action]} للمستخدم: ${name}؟`)) return;
  try{
    const r=await admFetch("/api/admin/users/action",{method:"POST",body:JSON.stringify({action,phone,name})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||d.status!=="ok"){showToast("❌ "+(d.message||"تعذر تحديث المستخدم"));return;}
  }catch(e){showToast("❌ "+String(e.message||e));return;}
  showToast("✅ تم: "+labels[action]);
  admTab("users");
}

/* ─── Payment Requests ─── */
async function renderAdmReqs(el){
  el.innerHTML=`<div class="empty"><div style="font-size:22px;">⏳</div><div>جارٍ التحميل...</div></div>`;
  let reqs=[];
  try{
    const r=await admFetch("/api/admin/requests");
    const j=await r.json();
    if(r.ok&&j.status==="ok") reqs=j.requests||[];
    else throw new Error(j.message||"failed");
    // Merge local requests not yet synced to server
    const localReqs=DB.g("reqs",[]);
    localReqs.forEach(lr=>{if(!reqs.find(sr=>sr.id===lr.id))reqs.push({...lr,createdAt:lr.at});});
    reqs.sort((a,b)=>new Date(b.createdAt||b.at)-new Date(a.createdAt||a.at));
  }catch{
    reqs=DB.g("reqs",[]).map(r=>({...r,createdAt:r.at}));
  }
  if(!reqs.length){el.innerHTML=`<div class="empty"><div style="font-size:28px;margin-bottom:7px;">📋</div><div>لا توجد طلبات</div></div>`;return;}
  const pend=reqs.filter(r=>r.status==="pending");
  const oldPend=pend.filter(r=>(Date.now()-new Date(r.createdAt||r.at).getTime())>3600000);
  let banner="";
  if(oldPend.length){
    banner=`<div class="pay-pulse" style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.35);border-radius:12px;padding:10px 14px;margin-bottom:12px;color:var(--dn);font-weight:800;font-size:12px;">🚨 ${oldPend.length} طلب بانتظار المراجعة لأكثر من ساعة — راجعها الآن</div>`;
  }
  el.innerHTML=banner+reqs.map(req=>{
    const pendMs=req.status==="pending"?Date.now()-new Date(req.createdAt||req.at).getTime():0;
    const isOld=pendMs>3600000;
    const mm=Math.floor(pendMs/60000);
    const waitTxt=req.status==="pending"?(mm<1?"أقل من دقيقة":mm<60?`منذ ${mm} دقيقة`:`منذ ${Math.floor(mm/60)} س${mm%60?` و${mm%60} د`:""}`):"";
    const methodBadges={vodafone:"🔴 فودافون كاش",orange:"🟠 أورنج كاش",etisalat:"🟢 اتصالات كاش",instapay:"💳 إنستاباي"};
    return `
    <div class="req-c ${req.status}${isOld?" adm-old":""}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <div>
          <div style="color:var(--t2);font-weight:700;font-size:13px;">${sanitize(req.name)}</div>
          <div style="color:var(--t4);font-size:10.5px;font-family:var(--mono);">${sanitize(req.phone)}</div>
          <div style="display:flex;gap:4px;margin-top:5px;flex-wrap:wrap;">
            <span class="bdg" style="background:var(--aud);color:var(--au);">${PLANS[req.planKey]?.l||sanitize(req.planKey)} — ${req.price||""} ج</span>
            <span class="bdg" style="background:var(--bld);color:#93c5fd;">${methodBadges[req.payMethod]||sanitize(req.payMethod||"")}</span>
            <span class="bdg" style="background:var(--s1);color:var(--t4);font-family:var(--mono);font-size:9px;">TX:${sanitize(req.tx)}</span>
            ${req.status==="pending"?`<span class="bdg ${isOld?"pay-pulse":""}" style="background:${isOld?"rgba(239,68,68,.12)":"rgba(245,158,11,.1)"};color:${isOld?"var(--dn)":"var(--au)"};">⏱ ${waitTxt}</span>`:""}
          </div>
          <div style="color:var(--t5);font-size:9.5px;margin-top:3px;">${new Date(req.createdAt||req.at).toLocaleString("ar-EG")}</div>
          ${req.proofImage
            ?`<div style="margin-top:7px;"><img src="${req.proofImage}" alt="إثبات الدفع" style="max-height:130px;max-width:100%;border-radius:9px;cursor:zoom-in;border:1px solid var(--b1);" onclick="viewProof(this.src)"/>${req.proofName?`<div style="color:var(--t5);font-size:9.5px;margin-top:3px;">📎 ${sanitize(req.proofName)}</div>`:""}</div>`
            :`<div style="margin-top:7px;color:var(--dn);font-size:10px;">⚠️ لا يوجد إثبات مرفق بهذا الطلب</div>`}
        </div>
        <div style="display:flex;gap:4px;">
          ${req.status==="pending"
            ?`<button class="r-btn app" onclick="admApp('${sanitize(req.id)}')">✓ قبول</button><button class="r-btn rej" onclick="admRej('${sanitize(req.id)}')">✕ رفض</button>`
            :`<span class="bdg" style="background:${req.status==="approved"?"var(--gd)":"var(--dnd)"};color:${req.status==="approved"?"var(--g)":"var(--dn)"};">${req.status==="approved"?"✓ مقبول":"✕ مرفوض"}</span>`}
        </div>
      </div>
    </div>`;}).join("");
}

/* ─── Articles ─── */
async function renderAdmArticles(el){
  el.innerHTML=`
    <div style="background:var(--s1);border:1px solid var(--b1);border-radius:12px;padding:13px;margin-bottom:14px;">
      <div style="color:var(--g);font-weight:800;font-size:12.5px;margin-bottom:10px;">✍️ نشر / تعديل خبر</div>
      ${aFormRow(aIn("aart-title","عنوان الخبر *","maxlength='300' style='width:100%'"))}
      <textarea id="aart-desc" placeholder="موجز الخبر *" maxlength="1500" class="a-in" style="width:100%;box-sizing:border-box;margin-bottom:7px;min-height:70px;font-family:inherit;"></textarea>
      ${aFormRow(
        aSel("aart-cat",[{v:"egypt",l:"🇪🇬 مصر"},{v:"global",l:"🌍 عالمي"},{v:"stocks",l:"📈 بورصة"},{v:"crypto",l:"₿ كريبتو"}]),
        aIn("aart-link","رابط المصدر (اختياري)")
      )}
      ${aFormRow(aIn("aart-thumb","رابط صورة (اختياري)","style='width:100%'"))}
      <div style="display:flex;gap:7px;margin-top:5px;align-items:center;">
        <input type="datetime-local" id="aart-sched" class="a-in" style="flex:1;" title="جدولة النشر (اتركه فارغاً للنشر الفوري)"/>
        <label style="color:var(--t3);font-size:11px;display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" id="aart-feat" style="accent-color:var(--au);"/> مميّز ⭐</label>
      </div>
      ${aBtn("📢 نشر الخبر","saveAdmArticle()")}
    </div>
    <div id="aart-list"><div class="empty"><div style="font-size:24px;">⏳</div><div>جارٍ التحميل...</div></div></div>`;
  let articles=[];
  try{
    const r=await admFetch("/api/admin/articles");
    const j=await r.json();
    if(!r.ok||j.status!=="ok") throw new Error(j.message||"failed");
    articles=j.articles||[];
  }catch(e){
    document.getElementById("aart-list").innerHTML=`<div class="empty" style="color:var(--dn);">⚠️ ${sanitize(String(e.message||e))}</div>`;
    return;
  }
  if(!articles.length){
    document.getElementById("aart-list").innerHTML=`<div class="empty"><div style="font-size:28px;margin-bottom:7px;">✍️</div><div>لم تنشر أخباراً بعد</div></div>`;
    return;
  }
  document.getElementById("aart-list").innerHTML=articles.map(a=>`
    <div style="background:var(--s1);border:1px solid var(--b1);border-radius:12px;padding:11px 13px;margin-bottom:7px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:5px;"><span style="font-size:13px;">${a.srcIcon||"✍️"}</span><div style="color:var(--t2);font-weight:700;font-size:13px;line-height:1.5;">${sanitize(a.title)}</div></div>
          <div style="color:var(--t4);font-size:11px;margin-top:4px;line-height:1.7;">${sanitize((a.description||"").slice(0,140))}</div>
          <div style="color:var(--t5);font-size:9.5px;margin-top:5px;font-family:var(--mono);">${new Date(a.pubDate).toLocaleString("ar-EG")} · ${sanitize(a.cat)}</div>
        </div>
        <button class="r-btn rej" onclick="delAdmArticle('${sanitize(a.id)}')">حذف</button>
      </div>
    </div>`).join("");
}

async function saveAdmArticle(){
  const schedVal=vG("aart-sched");
  const body={
    title:vG("aart-title"),description:vG("aart-desc"),
    cat:vG("aart-cat"),link:vG("aart-link")||"#",
    thumbnail:vG("aart-thumb")||undefined,
    ...(schedVal?{scheduledAt:new Date(schedVal).toISOString()}:{}),
    featured:document.getElementById("aart-feat")?.checked||false,
  };
  try{
    const r=await admFetch("/api/admin/articles",{method:"POST",body:JSON.stringify(body)});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر النشر"));return;}
    showToast("✅ تم نشر الخبر"+(schedVal?" (مجدوَل)":""));
    ["aart-title","aart-desc","aart-link","aart-thumb","aart-sched"].forEach(id=>{const el=document.getElementById(id);if(el)el.value="";});
    if(document.getElementById("aart-feat"))document.getElementById("aart-feat").checked=false;
    fetchAllNews(true);admTab("articles");
  }catch(e){showToast("❌ "+String(e.message||e));}
}

async function delAdmArticle(id){
  if(!confirm("حذف هذا الخبر؟")) return;
  try{
    const r=await admFetch(`/api/admin/articles/${encodeURIComponent(id)}`,{method:"DELETE"});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر الحذف"));return;}
    showToast("✅ تم الحذف");fetchAllNews(true);admTab("articles");
  }catch(e){showToast("❌ "+String(e.message||e));}
}

/* ─── Sources ─── */
async function renderAdmSources(el){
  const ok=Object.values(srcStatus).filter(s=>s==="ok").length;
  const err=Object.values(srcStatus).filter(s=>s==="error").length;
  el.innerHTML=`
    <div style="display:flex;gap:6px;margin-bottom:13px;flex-wrap:wrap;">
      <span class="bdg" style="background:var(--gd);color:var(--g);">✓ ${ok} نشط</span>
      ${err?`<span class="bdg" style="background:var(--dnd);color:var(--dn);">✕ ${err} خطأ</span>`:""}
      <span class="bdg" style="background:var(--bld);color:#93c5fd;font-family:var(--mono);">${allArts.length} خبر</span>
    </div>
    <div style="background:var(--s1);border:1px solid var(--b1);border-radius:12px;padding:12px;margin-bottom:14px;">
      <div style="color:var(--g);font-weight:800;font-size:12.5px;margin-bottom:9px;">➕ إضافة مصدر RSS</div>
      ${aFormRow(aIn("asrc-id","معرّف فريد (a-z)","maxlength='40'"),aIn("asrc-name","الاسم الظاهر","maxlength='60'"))}
      ${aFormRow(aIn("asrc-icon","📰 إيموجي","maxlength='6' value='📰'"),aIn("asrc-color","#10b981","maxlength='7' value='#10b981'"))}
      ${aFormRow(
        aSel("asrc-lang",[{v:"ar",l:"عربي"},{v:"en",l:"English"}]),
        aSel("asrc-cat",[{v:"egypt",l:"مصر"},{v:"global",l:"عالمي"},{v:"stocks",l:"بورصة"},{v:"crypto",l:"كريبتو"}])
      )}
      ${aFormRow(aIn("asrc-url","https://example.com/feed.xml","style='width:100%'"))}
      ${aBtn("حفظ المصدر ✓","saveAdmSource()")}
    </div>
    <div id="asrc-list"><div class="empty"><div style="font-size:24px;">⏳</div><div>جارٍ التحميل...</div></div></div>`;
  try{
    const r=await admFetch("/api/admin/sources");
    const j=await r.json();
    if(!r.ok||j.status!=="ok") throw new Error(j.message||"failed");
    document.getElementById("asrc-list").innerHTML=j.sources.map(s=>{
      const st=srcStatus[s.id];
      const bg=st==="ok"?"var(--gd)":st==="error"?"var(--dnd)":"var(--s1)";
      const fg=st==="ok"?"var(--g)":st==="error"?"var(--dn)":"var(--t4)";
      return `<div style="background:var(--s1);border:1px solid var(--b1);border-radius:11px;padding:10px 12px;margin-bottom:6px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:6px;">${sanitize(s.icon)}<div>
              <div style="color:var(--t2);font-size:12.5px;font-weight:700;">${sanitize(s.name)}</div>
              <div style="color:var(--t4);font-size:9px;font-family:var(--mono);">${sanitize(s.id)} · ${s.lang==="ar"?"عربي":"English"} · ${s.cat}</div>
              <div style="color:var(--t5);font-size:8.5px;font-family:var(--mono);overflow-wrap:break-word;margin-top:2px;">${sanitize(s.url)}</div>
            </div></div>
          </div>
          <div style="display:flex;flex-direction:column;gap:5px;align-items:flex-end;">
            <span class="bdg" style="background:${bg};color:${fg};">${st==="ok"?"✓ نشط":st==="error"?"✕ خطأ":"⏳"}</span>
            <button class="r-btn rej" onclick="delAdmSource('${sanitize(s.id)}')">حذف</button>
          </div>
        </div>
      </div>`;}).join("");
  }catch(e){
    document.getElementById("asrc-list").innerHTML=`<div class="empty" style="color:var(--dn);">⚠️ ${sanitize(String(e.message||e))}</div>`;
  }
}

async function saveAdmSource(){
  const body={id:vG("asrc-id"),name:vG("asrc-name"),icon:vG("asrc-icon")||"📰",color:vG("asrc-color"),lang:vG("asrc-lang"),cat:vG("asrc-cat"),url:vG("asrc-url")};
  try{
    const r=await admFetch("/api/admin/sources",{method:"POST",body:JSON.stringify(body)});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر الحفظ"));return;}
    showToast("✅ تم حفظ المصدر");await syncSources();admTab("sources");
  }catch(e){showToast("❌ "+String(e.message||e));}
}

async function delAdmSource(id){
  if(!confirm(`حذف المصدر "${id}"؟`)) return;
  try{
    const r=await admFetch(`/api/admin/sources/${encodeURIComponent(id)}`,{method:"DELETE"});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر الحذف"));return;}
    showToast("✅ تم الحذف");await syncSources();admTab("sources");
  }catch(e){showToast("❌ "+String(e.message||e));}
}

/* ─── Subscription Plans ─── */
async function renderAdmPlans(el){
  el.innerHTML=`
    <div style="background:var(--s1);border:1px solid var(--b1);border-radius:12px;padding:13px;margin-bottom:14px;">
      <div style="color:var(--au);font-weight:800;font-size:12.5px;margin-bottom:10px;">💳 إعدادات وسائل الدفع</div>
      <div style="color:var(--t4);font-size:10.5px;margin-bottom:10px;">فعّل كل وسيلة واضبط رقمها — تظهر فورًا للمستخدمين في صفحة الاشتراك. للإنستاباي يمكن كتابة IBAN أو عنوان محفظة.</div>
      <div id="aps-methods"></div>
      ${aBtn("حفظ إعدادات الوسائل ✓","savePaySettings()")}
      <div id="aps-msg" style="color:var(--t5);font-size:10px;margin-top:6px;"></div>
    </div>
    <div style="background:var(--s1);border:1px solid var(--b1);border-radius:12px;padding:13px;margin-bottom:14px;">
      <div style="color:var(--g);font-weight:800;font-size:12.5px;margin-bottom:10px;">💎 إضافة خطة اشتراك</div>
      ${aFormRow(aIn("apl-key","مفتاح (monthly, yearly...)","maxlength='40'"),aIn("apl-name","الاسم بالعربية","maxlength='100'"))}
      ${aFormRow(aIn("apl-price","السعر (جنيه)","type='number' min='0'"),aIn("apl-dur","المدة (شهور)","type='number' min='1'"))}
      ${aFormRow(aIn("apl-badge","شارة (مثل: الأشهر)","maxlength='50'"))}
      <textarea id="apl-features" placeholder="المزايا (سطر لكل ميزة)" class="a-in" style="width:100%;box-sizing:border-box;margin-bottom:7px;min-height:60px;font-family:inherit;"></textarea>
      ${aBtn("حفظ الخطة ✓","saveAdmPlan()")}
    </div>
    <div id="apl-list"><div class="empty"><div style="font-size:24px;">⏳</div></div></div>`;
  await loadPaySettings();
  await loadAdmPlans();
}
const APS_METHODS=[
  {id:"vodafone",label:"🔴 فودافون كاش",key:"payment_vodafone_number",wallet:true},
  {id:"orange",label:"🟠 أورنج كاش",key:"payment_orange_number",wallet:true},
  {id:"etisalat",label:"🟢 اتصالات كاش",key:"payment_etisalat_number",wallet:true},
  {id:"instapay",label:"💳 إنستاباي",key:"payment_instapay_number",wallet:false},
];
async function loadPaySettings(){
  try{
    const r=await admFetch("/api/admin/settings/payment");
    const j=await r.json();
    if(!r.ok||j.status!=="ok") return;
    const box=document.getElementById("aps-methods");if(!box)return;
    const st=j.settings||{};
    box.innerHTML=APS_METHODS.map(m=>`
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
        <label style="display:flex;align-items:center;gap:6px;min-width:150px;color:var(--t2);font-size:12px;font-weight:700;cursor:pointer;">
          <input type="checkbox" id="aps-en-${m.id}" ${st[m.key.replace("_number","_enabled")]!=="0"?"checked":""} style="width:16px;height:16px;accent-color:var(--au);"/> ${m.label}
        </label>
        <input id="aps-${m.id}" class="a-in" style="flex:1;min-width:170px;direction:ltr;text-align:left;" placeholder="رقم ${m.label}" value="${sanitize(String(st[m.key]||""))}"/>
      </div>`).join("");
  }catch(e){}
}
async function savePaySettings(){
  const body={};
  for(const m of APS_METHODS){
    const en=document.getElementById(`aps-en-${m.id}`);
    const num=(document.getElementById(`aps-${m.id}`)?.value||"").trim();
    body[m.key.replace("_number","_enabled")]=en&&en.checked?"1":"0";
    body[m.key]=num;
    if(en&&en.checked&&m.wallet&&!/^01[0-9]{9}$/.test(num)){showToast(`⚠️ رقم ${m.label} يجب أن يكون 11 رقمًا يبدأ بـ 01`);return;}
    if(en&&en.checked&&!m.wallet&&(num.length<5||num.length>60)){showToast("⚠️ أدخل عنوان إنستاباي صحيح");return;}
  }
  if(!APS_METHODS.some(m=>{const en=body[m.key.replace("_number","_enabled")];return en==="1"&&body[m.key];})){showToast("⚠️ فعّل وسيلة دفع واحدة على الأقل");return;}
  try{
    const r=await admFetch("/api/admin/settings/payment",{method:"PUT",body:JSON.stringify(body)});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر الحفظ"));return;}
    showToast("✅ تم الحفظ — الوسائل تظهر للمستخدمين فورًا");
  }catch(e){showToast("❌ "+String(e.message||e));}
}

async function loadAdmPlans(){
  try{
    const r=await admFetch("/api/admin/plans");
    const j=await r.json();
    if(!r.ok||j.status!=="ok") throw new Error(j.message||"failed");
    const el=document.getElementById("apl-list");
    if(!el) return;
    el.innerHTML=j.plans.length?j.plans.map(p=>`
      <div style="background:var(--s1);border:1px solid var(--b1);border-radius:12px;padding:12px 14px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="flex:1;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
              <div style="color:var(--t2);font-weight:800;font-size:13px;">${sanitize(p.nameAr)}</div>
              ${p.badge?aBadge(sanitize(p.badge),"var(--aud)","var(--au)"):""}
              ${p.isActive?aBadge("نشطة","var(--gd)","var(--g)"):aBadge("معطّلة","var(--dnd)","var(--dn)")}
            </div>
            <div style="color:var(--t3);font-size:11px;font-family:var(--mono);">${sanitize(p.key)} · ${p.price} ج / ${p.durationMonths} شهر</div>
            ${p.features&&p.features.length?`<div style="color:var(--t4);font-size:10px;margin-top:4px;">${p.features.map(f=>`✓ ${sanitize(f)}`).join(" · ")}</div>`:""}
          </div>
          <div style="display:flex;flex-direction:column;gap:5px;">
            <button class="r-btn" style="font-size:10px;background:var(--s1);color:var(--t2);" onclick="editAdmPlanPrice(${p.id},${p.price},'${sanitize(p.key)}')">✏️ السعر</button>
            <button class="r-btn" style="font-size:10px;background:${p.isActive?"var(--dnd)":"var(--gd)"};color:${p.isActive?"var(--dn)":"var(--g)"};" onclick="toggleAdmPlan(${p.id},${!p.isActive})">${p.isActive?"تعطيل":"تفعيل"}</button>
            <button class="r-btn rej" style="font-size:10px;" onclick="delAdmPlan(${p.id},'${sanitize(p.nameAr)}')">حذف</button>
          </div>
        </div>
      </div>`).join(""):`<div class="empty" style="padding:20px;"><div style="font-size:26px;">💎</div><div>لا توجد خطط بعد</div></div>`;
  }catch(e){const el=document.getElementById("apl-list");if(el)el.innerHTML=`<div class="empty" style="color:var(--dn);">⚠️ ${sanitize(String(e.message||e))}</div>`;}
}

async function editAdmPlanPrice(id,cur,key){
  const v=prompt(`سعر الخطة «${key}» (جنيه):`,cur);
  if(v===null)return;
  const price=Number(v);
  if(!Number.isFinite(price)||price<0){showToast("⚠️ سعر غير صحيح");return;}
  try{
    const r=await admFetch(`/api/admin/plans/${id}`,{method:"PUT",body:JSON.stringify({price})});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر التحديث"));return;}
    showToast("✅ تم تحديث السعر — ظهر للمستخدمين فورًا");
    await loadAdmPlans();
  }catch(e){showToast("❌ "+String(e.message||e));}
}

async function saveAdmPlan(){
  const feats=vG("apl-features").split("\n").map(f=>f.trim()).filter(Boolean);
  const body={key:vG("apl-key"),nameAr:vG("apl-name"),price:Number(vG("apl-price")),durationMonths:Number(vG("apl-dur")),badge:vG("apl-badge")||undefined,features:feats};
  try{
    const r=await admFetch("/api/admin/plans",{method:"POST",body:JSON.stringify(body)});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر الحفظ"));return;}
    showToast("✅ تم إضافة الخطة");
    ["apl-key","apl-name","apl-price","apl-dur","apl-badge","apl-features"].forEach(id=>{const el=document.getElementById(id);if(el)el.value="";});
    await loadAdmPlans();
  }catch(e){showToast("❌ "+String(e.message||e));}
}

async function toggleAdmPlan(id,isActive){
  try{
    const r=await admFetch(`/api/admin/plans/${id}`,{method:"PUT",body:JSON.stringify({isActive})});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر التحديث"));return;}
    showToast("✅ تم التحديث");await loadAdmPlans();
  }catch(e){showToast("❌ "+String(e.message||e));}
}

async function delAdmPlan(id,name){
  if(!confirm(`حذف خطة "${name}"؟`)) return;
  try{
    const r=await admFetch(`/api/admin/plans/${id}`,{method:"DELETE"});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر الحذف"));return;}
    showToast("✅ تم الحذف");await loadAdmPlans();
  }catch(e){showToast("❌ "+String(e.message||e));}
}

/* ─── Coupons ─── */
async function renderAdmCoupons(el){
  el.innerHTML=`
    <div style="background:var(--s1);border:1px solid var(--b1);border-radius:12px;padding:13px;margin-bottom:14px;">
      <div style="color:var(--g);font-weight:800;font-size:12.5px;margin-bottom:10px;">🎟️ إنشاء كوبون خصم</div>
      ${aFormRow(aIn("acp-code","كود الكوبون (مثل: SAVE50)","maxlength='40' style='text-transform:uppercase'"),
        aSel("acp-type",[{v:"percent",l:"خصم % نسبة"},{v:"fixed",l:"خصم ثابت (جنيه)"}]))}
      ${aFormRow(aIn("acp-val","قيمة الخصم","type='number' min='1'"),aIn("acp-uses","الحد الأقصى للاستخدام (فارغ = بلا حد)","type='number' min='1'"))}
      ${aFormRow(
        `<div><label style="color:var(--t4);font-size:10px;display:block;margin-bottom:3px;">تاريخ البداية</label><input type="datetime-local" id="acp-start" class="a-in" /></div>`,
        `<div><label style="color:var(--t4);font-size:10px;display:block;margin-bottom:3px;">تاريخ الانتهاء</label><input type="datetime-local" id="acp-end" class="a-in" /></div>`
      )}
      ${aBtn("إنشاء الكوبون ✓","saveAdmCoupon()")}
    </div>
    <div id="acp-list"><div class="empty"><div style="font-size:24px;">⏳</div></div></div>`;
  await loadAdmCoupons();
}

async function loadAdmCoupons(){
  try{
    const r=await admFetch("/api/admin/coupons");
    const j=await r.json();
    if(!r.ok||j.status!=="ok") throw new Error(j.message||"failed");
    const el=document.getElementById("acp-list");
    if(!el) return;
    const now=Date.now();
    el.innerHTML=j.coupons.length?j.coupons.map(c=>{
      const expired=c.expiresAt&&new Date(c.expiresAt)<new Date();
      const notStarted=c.startsAt&&new Date(c.startsAt)>new Date();
      const limitReached=c.maxUses&&c.usedCount>=c.maxUses;
      const statusLabel=!c.isActive?"معطّل":expired?"منتهي":notStarted?"لم يبدأ":limitReached?"استُنفد":"✓ نشط";
      const statusBg=!c.isActive||expired||limitReached?"var(--dnd)":notStarted?"var(--bld)":"var(--gd)";
      const statusFg=!c.isActive||expired||limitReached?"var(--dn)":notStarted?"#93c5fd":"var(--g)";
      return `<div style="background:var(--s1);border:1px solid var(--b1);border-radius:12px;padding:12px 14px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="flex:1;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
              <code style="color:var(--g);font-size:13px;font-weight:800;font-family:var(--mono);">${sanitize(c.code)}</code>
              ${aBadge(statusLabel,statusBg,statusFg)}
            </div>
            <div style="color:var(--t3);font-size:11px;">خصم: <strong>${c.discountValue}${c.discountType==="percent"?"%":" ج"}</strong> · استُخدم: ${c.usedCount||0}${c.maxUses?"/"+c.maxUses:""}</div>
            ${c.expiresAt?`<div style="color:var(--t5);font-size:9.5px;margin-top:3px;font-family:var(--mono);">ينتهي: ${new Date(c.expiresAt).toLocaleDateString("ar-EG")}</div>`:""}
          </div>
          <div style="display:flex;flex-direction:column;gap:5px;">
            <button class="r-btn" style="font-size:10px;background:${c.isActive?"var(--dnd)":"var(--gd)"};color:${c.isActive?"var(--dn)":"var(--g)"};" onclick="toggleAdmCoupon(${c.id},${!c.isActive})">${c.isActive?"تعطيل":"تفعيل"}</button>
            <button class="r-btn rej" style="font-size:10px;" onclick="delAdmCoupon(${c.id},'${sanitize(c.code)}')">حذف</button>
          </div>
        </div>
      </div>`;}).join(""):`<div class="empty" style="padding:20px;"><div style="font-size:26px;">🎟️</div><div>لا توجد كوبونات بعد</div></div>`;
  }catch(e){const el=document.getElementById("acp-list");if(el)el.innerHTML=`<div class="empty" style="color:var(--dn);">⚠️ ${sanitize(String(e.message||e))}</div>`;}
}

async function saveAdmCoupon(){
  const startVal=vG("acp-start");const endVal=vG("acp-end");const usesVal=vG("acp-uses");
  const body={code:vG("acp-code").toUpperCase(),discountType:vG("acp-type"),discountValue:Number(vG("acp-val")),
    ...(usesVal?{maxUses:Number(usesVal)}:{}),
    ...(startVal?{startsAt:new Date(startVal).toISOString()}:{}),
    ...(endVal?{expiresAt:new Date(endVal).toISOString()}:{})};
  try{
    const r=await admFetch("/api/admin/coupons",{method:"POST",body:JSON.stringify(body)});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر الإنشاء"));return;}
    showToast("✅ تم إنشاء الكوبون");
    ["acp-code","acp-val","acp-uses","acp-start","acp-end"].forEach(id=>{const el=document.getElementById(id);if(el)el.value="";});
    await loadAdmCoupons();
  }catch(e){showToast("❌ "+String(e.message||e));}
}

async function toggleAdmCoupon(id,isActive){
  try{
    const r=await admFetch(`/api/admin/coupons/${id}`,{method:"PUT",body:JSON.stringify({isActive})});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر"));return;}
    showToast("✅ تم");await loadAdmCoupons();
  }catch(e){showToast("❌ "+String(e.message||e));}
}

async function delAdmCoupon(id,code){
  if(!confirm(`حذف الكوبون "${code}"؟`)) return;
  try{
    const r=await admFetch(`/api/admin/coupons/${id}`,{method:"DELETE"});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر"));return;}
    showToast("✅ تم الحذف");await loadAdmCoupons();
  }catch(e){showToast("❌ "+String(e.message||e));}
}

/* ─── Employees ─── */
const ROLE_LABELS={"super_admin":"سوبر أدمن","admin":"أدمن","editor":"محرر","analyst":"محلل","support":"دعم فني","marketing":"تسويق"};
const ROLE_COLORS={"super_admin":"#8b5cf6","admin":"#ef4444","editor":"#10b981","analyst":"#3b82f6","support":"#f59e0b","marketing":"#ec4899"};

/* Fine-grained employee permissions (enforced server-side on every admin
 * request). An empty selection means "whatever the role allows"; a non-empty
 * selection narrows it. super_admin is never restricted. */
const ADM_PERM_OPTS=[
  {k:"users",l:"👥 المستخدمون"},
  {k:"payments",l:"💰 الدفعات"},
  {k:"content",l:"📰 الأخبار والمصادر"},
  {k:"plans",l:"💎 الاشتراكات"},
  {k:"coupons",l:"🎟️ الكوبونات"},
  {k:"employees",l:"👨‍💼 الموظفون"},
  {k:"ai",l:"🤖 إدارة AI"},
  {k:"settings",l:"⚙️ إعدادات الدفع"},
  {k:"audit",l:"📋 سجل العمليات"},
  {k:"opportunities",l:"💡 الفرص"},
];
const PERM_LABELS=Object.fromEntries(ADM_PERM_OPTS.map(p=>[p.k,p.l]));

/* Tab → permission required to show it (empty list = role decides only, like
 * the server). The server never over-restricts: employees without a list see
 * every tab their role allows. */
const ADM_TAB_PERMS={
  dash: null,        // overview — always visible to any staff
  users: "users",
  reqs: "payments",
  articles: "content",
  sources: "content",
  plans: "plans",
  coupons: "coupons",
  employees: "employees",
  aiconfig: "ai",
  audit: "audit",
  opps: "opportunities",
};

async function renderAdmEmployees(el){
  el.innerHTML=`
    <div style="background:var(--s1);border:1px solid var(--b1);border-radius:12px;padding:13px;margin-bottom:14px;">
      <div style="color:var(--g);font-weight:800;font-size:12.5px;margin-bottom:10px;">👨‍💼 إضافة موظف جديد</div>
      ${aFormRow(aIn("aemp-name","الاسم الكامل","maxlength='100'"),aIn("aemp-email","البريد الإلكتروني","type='email'"))}
      ${aFormRow(
        aSel("aemp-role",[
          {v:"editor",l:"📝 محرر"},{v:"analyst",l:"📊 محلل"},{v:"support",l:"🎧 دعم فني"},
          {v:"marketing",l:"📣 تسويق"},{v:"admin",l:"🔴 أدمن"},{v:"super_admin",l:"👑 سوبر أدمن"}
        ]),
        aIn("aemp-pass","كلمة المرور (8+ أحرف)","type='password' minlength='8'")
      )}
      <div style="color:var(--t4);font-size:10px;font-weight:700;margin:10px 0 6px;">🔐 صلاحيات مفصّلة — اتركها فارغة لمنح كل صلاحيات الدور</div>
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:4px;">
        ${ADM_PERM_OPTS.map(p=>`<label class="a-in" style="display:flex;align-items:center;gap:4px;width:auto;font-size:10.5px;color:var(--t3);padding:5px 8px;cursor:pointer;"><input type="checkbox" class="aemp-perm" value="${p.k}"/> ${p.l}</label>`).join("")}
      </div>
      ${aBtn("إضافة الموظف ✓","saveAdmEmployee()")}
    </div>
    <div id="aemp-list"><div class="empty"><div style="font-size:24px;">⏳</div></div></div>`;
  await loadAdmEmployees();
}

async function loadAdmEmployees(){
  try{
    const r=await admFetch("/api/admin/employees");
    const j=await r.json();
    if(!r.ok||j.status!=="ok") throw new Error(j.message||"failed");
    const el=document.getElementById("aemp-list");
    if(!el) return;
    el.innerHTML=j.employees.length?j.employees.map(emp=>`
      <div style="background:var(--s1);border:1px solid var(--b1);border-radius:12px;padding:12px 14px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="flex:1;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
              <div style="width:32px;height:32px;border-radius:50%;background:${ROLE_COLORS[emp.role]||"#64748b"}22;border:1px solid ${ROLE_COLORS[emp.role]||"#64748b"}44;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">
                ${emp.role==="super_admin"?"👑":emp.role==="admin"?"🔴":emp.role==="editor"?"📝":emp.role==="analyst"?"📊":emp.role==="support"?"🎧":"📣"}
              </div>
              <div>
                <div style="color:var(--t2);font-weight:700;font-size:13px;">${sanitize(emp.name)}</div>
                <div style="color:var(--t4);font-size:10px;font-family:var(--mono);">${sanitize(emp.email)}</div>
              </div>
            </div>
            <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:5px;">
              ${aBadge(ROLE_LABELS[emp.role]||emp.role,ROLE_COLORS[emp.role]+"22",ROLE_COLORS[emp.role]||"#fff")}
              ${emp.status==="active"?aBadge("نشط","var(--gd)","var(--g)"):aBadge("معطّل","var(--dnd)","var(--dn)")}
              ${(Array.isArray(emp.permissions)&&emp.permissions.length)?emp.permissions.map(p=>aBadge(PERM_LABELS[p]||p,"var(--s2)","var(--t3)")).join(""):""}
            </div>
            ${emp.lastLogin?`<div style="color:var(--t5);font-size:9px;margin-top:5px;font-family:var(--mono);">آخر دخول: ${new Date(emp.lastLogin).toLocaleString("ar-EG")}</div>`:""}
          </div>
          <div style="display:flex;flex-direction:column;gap:5px;">
            <button class="r-btn" style="font-size:10px;" onclick="editAdmEmployeePerms(${emp.id},'${sanitize(emp.name)}',${JSON.stringify(Array.isArray(emp.permissions)?emp.permissions:[]).replace(/"/g,"&quot;")})">🔐 صلاحيات</button>
            <button class="r-btn" style="font-size:10px;background:${emp.status==="active"?"var(--dnd)":"var(--gd)"};color:${emp.status==="active"?"var(--dn)":"var(--g)"};" onclick="toggleAdmEmployee(${emp.id},'${emp.status==="active"?"inactive":"active"}')">${emp.status==="active"?"تعطيل":"تفعيل"}</button>
            <button class="r-btn rej" style="font-size:10px;" onclick="delAdmEmployee(${emp.id},'${sanitize(emp.name)}')">حذف</button>
          </div>
        </div>
      </div>`).join(""):`<div class="empty" style="padding:20px;"><div style="font-size:26px;">👨‍💼</div><div>لا يوجد موظفون بعد</div></div>`;
  }catch(e){const el=document.getElementById("aemp-list");if(el)el.innerHTML=`<div class="empty" style="color:var(--dn);">⚠️ ${sanitize(String(e.message||e))}</div>`;}
}

async function saveAdmEmployee(){
  const body={name:vG("aemp-name"),email:vG("aemp-email"),role:vG("aemp-role"),password:vG("aemp-pass")};
  /* Selected fine-grained permissions (empty array = role defaults). */
  body.permissions=[...document.querySelectorAll(".aemp-perm:checked")].map(i=>i.value);
  if(!body.name||!body.email||!body.password){showToast("❌ يرجى ملء جميع الحقول");return;}
  try{
    const r=await admFetch("/api/admin/employees",{method:"POST",body:JSON.stringify(body)});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر الإضافة"));return;}
    showToast("✅ تم إضافة الموظف");
    ["aemp-name","aemp-email","aemp-pass"].forEach(id=>{const el=document.getElementById(id);if(el)el.value="";});
    document.querySelectorAll(".aemp-perm").forEach(c=>{c.checked=false;});
    await loadAdmEmployees();
  }catch(e){showToast("❌ "+String(e.message||e));}
}

/* Edit an existing employee's fine-grained permissions (server enforces them
 * on every request, so this takes effect immediately). */
function editAdmEmployeePerms(id,name,current){
  const cur=new Set(Array.isArray(current)?current:[]);
  const ov=document.createElement("div");
  ov.id="aemp-perm-ov";
  ov.style.cssText="position:fixed;inset:0;z-index:900;background:rgba(3,7,18,.92);display:flex;align-items:center;justify-content:center;padding:16px;";
  ov.innerHTML=`<div style="background:var(--ink2);border:1px solid var(--b1);border-radius:16px;padding:16px;max-width:440px;width:100%;max-height:85vh;overflow-y:auto;">
    <div style="color:var(--t2);font-weight:800;font-size:13px;margin-bottom:4px;">🔐 صلاحيات ${sanitize(name)}</div>
    <div style="color:var(--t5);font-size:10px;line-height:1.8;margin-bottom:10px;">اتركها كلها فارغة لمنح كل صلاحيات الدور. عند تحديد أي صلاحية يصبح الموظف مقيّداً بها فقط (يتحقق منها السيرفر في كل طلب).</div>
    ${ADM_PERM_OPTS.map(p=>`<label style="display:flex;align-items:center;gap:7px;padding:7px 0;border-bottom:1px solid var(--b1);color:var(--t3);font-size:12px;cursor:pointer;"><input type="checkbox" class="aemp-perm-e" value="${p.k}" ${cur.has(p.k)?"checked":""}/> ${p.l}</label>`).join("")}
    <div style="display:flex;gap:8px;margin-top:12px;">
      <button class="btn btn-g btn-sm" style="flex:1;padding:10px;" onclick="saveAdmEmployeePerms(${id})">💾 حفظ</button>
      <button class="btn btn-sm" style="flex:1;padding:10px;background:var(--s1);color:var(--t4);" onclick="document.getElementById('aemp-perm-ov').remove()">إلغاء</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
}

async function saveAdmEmployeePerms(id){
  const permissions=[...document.querySelectorAll(".aemp-perm-e:checked")].map(i=>i.value);
  try{
    const r=await admFetch(`/api/admin/employees/${id}`,{method:"PUT",body:JSON.stringify({permissions})});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر التحديث"));return;}
    document.getElementById("aemp-perm-ov")?.remove();
    showToast("✅ تم تحديث الصلاحيات");
    await loadAdmEmployees();
  }catch(e){showToast("❌ "+String(e.message||e));}
}

async function toggleAdmEmployee(id,status){
  try{
    const r=await admFetch(`/api/admin/employees/${id}`,{method:"PUT",body:JSON.stringify({status})});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر"));return;}
    showToast("✅ تم");await loadAdmEmployees();
  }catch(e){showToast("❌ "+String(e.message||e));}
}

async function delAdmEmployee(id,name){
  if(!confirm(`حذف الموظف "${name}"؟ هذا لا يمكن التراجع عنه.`)) return;
  try{
    const r=await admFetch(`/api/admin/employees/${id}`,{method:"DELETE"});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر"));return;}
    showToast("✅ تم الحذف");await loadAdmEmployees();
  }catch(e){showToast("❌ "+String(e.message||e));}
}

/* ─── AI Config ─── */
async function renderAdmAIConfig(el){
  el.innerHTML=`<div class="empty"><div style="font-size:22px;">⏳</div></div>`;
  let cfg={analyzerEnabled:true,summaryEnabled:true,rewriterEnabled:true,dailyRequestLimit:1000};
  let usage={totalRequests:0,byType:[],topUsers:[]};
  try{
    const [r1,r2]=await Promise.all([admFetch("/api/admin/ai-config"),admFetch("/api/admin/ai-usage?days=30")]);
    const j1=await r1.json();const j2=await r2.json();
    if(j1.status==="ok"&&j1.config)cfg={...cfg,...j1.config};
    if(j2.status==="ok")usage=j2;
  }catch{}

  el.innerHTML=`
    ${aSection("🔧 إعدادات المساعد الذكي",`
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${["analyzerEnabled:🤖 محلل الأخبار","summaryEnabled:📄 تلخيص الأخبار","rewriterEnabled:✍️ إعادة صياغة"].map(s=>{
          const[k,l]=s.split(":");
          return `<label style="display:flex;justify-content:space-between;align-items:center;background:var(--s2);border-radius:10px;padding:10px 13px;cursor:pointer;">
            <span style="color:var(--t2);font-size:13px;">${l}</span>
            <input type="checkbox" id="aicfg-${k}" ${cfg[k]?"checked":""} style="width:18px;height:18px;accent-color:var(--g);cursor:pointer;" onchange="saveAICfgToggle('${k}',this.checked)"/>
          </label>`;}).join("")}
        <div style="display:flex;align-items:center;gap:10px;background:var(--s2);border-radius:10px;padding:10px 13px;">
          <span style="color:var(--t2);font-size:13px;flex:1;">📊 حد الطلبات اليومي</span>
          <input type="number" id="aicfg-limit" value="${cfg.dailyRequestLimit||1000}" min="0" max="100000" class="a-in" style="width:90px;text-align:center;" />
          <button class="r-btn app" style="font-size:11px;" onclick="saveAICfgLimit()">حفظ</button>
        </div>
      </div>
    `)}
    ${aSection("📊 إحصائيات الاستخدام (30 يوم)",`
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
        ${aCard("إجمالي الطلبات",usage.totalRequests,"#10b981","آخر 30 يوم")}
      </div>
      ${usage.topUsers&&usage.topUsers.length?`
        <div style="color:var(--t3);font-size:11.5px;font-weight:700;margin-bottom:7px;">🏆 الأكثر استخداماً</div>
        ${usage.topUsers.slice(0,5).map(u=>`
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--b1);">
            <span style="color:var(--t3);font-size:11px;font-family:var(--mono);">${sanitize(String(u.user_id||"غير معروف").slice(-6))}</span>
            <span style="color:var(--au);font-weight:700;font-size:11px;">${u.count} طلب</span>
          </div>`).join("")}`:""}
    `)}
    ${aSection("🤖 تقارير AI يدوية",`
      <button class="btn btn-g btn-sm" id="adm-ai-btn" onclick="genAdmReport()">🤖 أنشئ ملخص السوق اليوم</button>
      <div id="adm-ai-res" style="display:none;background:var(--gd2);border:1px solid rgba(16,185,129,.14);border-radius:14px;padding:17px;margin-top:12px;">
        <div style="color:var(--g);font-size:10px;font-weight:700;margin-bottom:10px;">✅ ملخص ${new Date().toLocaleDateString("ar-EG")}</div>
        <div id="adm-ai-txt" style="color:var(--t2);font-size:13px;line-height:1.9;direction:rtl;white-space:pre-line;"></div>
      </div>
    `)}
  `;
}

async function saveAICfgToggle(key,val){
  try{
    const r=await admFetch("/api/admin/ai-config",{method:"PUT",body:JSON.stringify({[key]:val})});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر"));return;}
    showToast("✅ تم التحديث");
  }catch(e){showToast("❌ "+String(e.message||e));}
}

async function saveAICfgLimit(){
  const v=Number(document.getElementById("aicfg-limit")?.value||1000);
  try{
    const r=await admFetch("/api/admin/ai-config",{method:"PUT",body:JSON.stringify({dailyRequestLimit:v})});
    const j=await r.json();
    if(!r.ok||j.status!=="ok"){showToast("❌ "+(j.message||"تعذر"));return;}
    showToast("✅ تم حفظ الحد اليومي");
  }catch(e){showToast("❌ "+String(e.message||e));}
}

async function genAdmReport(){
  const btn=document.getElementById("adm-ai-btn");if(!btn)return;
  btn.innerHTML='<div class="sp sp-g sp-sm"></div> جارٍ...';btn.disabled=true;
  try{
    const hl=allArts.slice(0,8).map(a=>`${a.srcName}: ${a.title}`).join("\n");
    const txt=await callAI({
      max_tokens:800,system:"أنت محلل اقتصادي. أنشئ ملخصاً يومياً شاملاً للأسواق.",
      messages:[{role:"user",content:`ملخص شامل للأسواق ليوم ${new Date().toLocaleDateString("ar-EG")} بناءً على:\n${hl}`}]
    });
    document.getElementById("adm-ai-txt").textContent=txt;
    document.getElementById("adm-ai-res").style.display="block";
  }catch{if(document.getElementById("adm-ai-txt"))document.getElementById("adm-ai-txt").textContent="❌ تعذر الاتصال.";}
  btn.innerHTML="🤖 إعادة التوليد";btn.disabled=false;
}

/* ─── Audit Logs ─── */
let auditPage=0;
async function renderAdmAudit(el){
  auditPage=0;
  el.innerHTML=`
    <div style="display:flex;gap:7px;margin-bottom:12px;">
      <input id="aadit-search" placeholder="🔍 بحث بالمنفذ أو الهدف..." class="a-in" style="flex:1;" oninput="auditPage=0;loadAdmAudit()" />
      <select id="aadit-action" class="a-in" style="flex:1;" onchange="auditPage=0;loadAdmAudit()">
        <option value="">كل العمليات</option>
        <option value="login">تسجيل دخول</option>
        <option value="create_employee">إضافة موظف</option>
        <option value="delete_employee">حذف موظف</option>
        <option value="update_employee">تعديل موظف</option>
        <option value="create_plan">إضافة خطة</option>
        <option value="delete_plan">حذف خطة</option>
        <option value="create_coupon">إنشاء كوبون</option>
        <option value="upsert_article">نشر خبر</option>
        <option value="delete_article">حذف خبر</option>
        <option value="upgrade_vip">ترقية VIP</option>
        <option value="ban_user">حظر مستخدم</option>
        <option value="update_ai_config">تعديل AI</option>
      </select>
    </div>
    <div id="aadit-list"><div class="empty"><div style="font-size:22px;">⏳</div></div></div>
    <div id="aadit-pager" style="display:flex;gap:8px;justify-content:center;margin-top:12px;"></div>`;
  await loadAdmAudit();
}

async function loadAdmAudit(){
  const search=vG("aadit-search");const action=vG("aadit-action");
  const el=document.getElementById("aadit-list");
  if(!el)return;
  el.innerHTML=`<div class="empty"><div style="font-size:22px;margin-bottom:7px;">⏳</div><div>جارٍ التحميل...</div></div>`;
  try{
    const params=new URLSearchParams({page:auditPage,limit:25});
    if(search)params.set("search",search);if(action)params.set("action",action);
    const r=await admFetch("/api/admin/audit-logs?"+params);
    const j=await r.json();
    if(!r.ok||j.status!=="ok") throw new Error(j.message||"failed");

    const ACTION_ICONS={"login":"🔑","create_employee":"👤+","delete_employee":"👤-","update_employee":"👤✎","create_plan":"💎+","delete_plan":"💎-","update_plan":"💎✎","create_coupon":"🎟️+","delete_coupon":"🎟️-","upsert_article":"📰+","delete_article":"📰-","upgrade_vip":"⭐","downgrade_vip":"⭐-","ban_user":"🚫","unban_user":"✓","upsert_source":"🔗+","delete_source":"🔗-","update_ai_config":"🤖","update_coupon":"🎟️✎"};

    el.innerHTML=j.logs.length?j.logs.map(l=>`
      <div style="background:var(--s1);border:1px solid var(--b1);border-radius:10px;padding:10px 12px;margin-bottom:6px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="flex:1;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:14px;">${ACTION_ICONS[l.action]||"⚙️"}</span>
              <div>
                <span style="color:var(--t2);font-size:12px;font-weight:700;">${sanitize(String(l.action||""))}</span>
                ${l.target?`<span style="color:var(--t4);font-size:11px;"> → ${sanitize(String(l.target))}</span>`:""}
              </div>
            </div>
            <div style="color:var(--t4);font-size:10px;margin-top:4px;">
              <span style="color:${ROLE_COLORS[l.actorRole]||"var(--t4)"};">${sanitize(String(l.actorName||""))}</span>
              ${l.actorRole?` · <span style="color:var(--t5);">${ROLE_LABELS[l.actorRole]||l.actorRole}</span>`:""}
              ${l.ip?` · <span style="font-family:var(--mono);color:var(--t5);">${sanitize(String(l.ip))}</span>`:""}
            </div>
          </div>
          <div style="color:var(--t5);font-size:9px;font-family:var(--mono);white-space:nowrap;">${l.createdAt?new Date(l.createdAt).toLocaleString("ar-EG"):""}</div>
        </div>
      </div>`).join(""):`<div class="empty" style="padding:20px;"><div style="font-size:26px;">📋</div><div>لا توجد عمليات</div></div>`;

    const total=j.total||0;const pages=Math.ceil(total/25);
    const pager=document.getElementById("aadit-pager");
    if(pager)pager.innerHTML=pages>1?`
      <button class="r-btn" ${auditPage<=0?"disabled":""} onclick="auditPage--;loadAdmAudit()">◀ السابق</button>
      <span style="color:var(--t4);font-size:11px;">${auditPage+1} / ${pages}</span>
      <button class="r-btn" ${auditPage>=pages-1?"disabled":""} onclick="auditPage++;loadAdmAudit()">التالي ▶</button>`:"";
  }catch(e){el.innerHTML=`<div class="empty" style="color:var(--dn);">⚠️ ${sanitize(String(e.message||e))}</div>`;}
}

/* ─── admApp / admRej — server + localStorage ─── */
async function admApp(id){
  try{
    const r=await admFetch(`/api/admin/requests/${encodeURIComponent(id)}`,{method:"PUT",body:JSON.stringify({status:"approved"})});
    const j=await r.json();
    if(!r.ok){showToast("❌ "+(j.message||"تعذر التحديث"));return;}
  }catch(e){showToast("❌ "+String(e.message||e));return;}
  showToast("✅ تم قبول الطلب وتفعيل VIP من الخادم");
  renderAdmStats();admTab("reqs");
}
async function admRej(id){
  const reason=prompt("سبب الرفض (يظهر للمستخدم مع حالته):")||"";
  try{
    const r=await admFetch(`/api/admin/requests/${encodeURIComponent(id)}`,{method:"PUT",body:JSON.stringify({status:"rejected",notes:reason})});
    const j=await r.json();
    if(!r.ok){showToast("❌ "+(j.message||"تعذر التحديث"));return;}
  }catch(e){showToast("❌ "+String(e.message||e));return;}
  const reqs=DB.g("reqs",[]);const req=reqs.find(r=>r.id===id);
  if(req){req.status="rejected";DB.s("reqs",reqs);}
  admTab("reqs");showToast("❌ تم رفض الطلب");
}

/* ────────────────── opportunities admin (verbatim) ────────────────── */
/* ═══════════════════ ADMIN OPPORTUNITIES ═══════════════════ */
async function renderAdmOpps(){
  const el=document.getElementById("adm-body");
  el.innerHTML=`<div style="padding:14px;">
    <div class="row between" style="margin-bottom:10px;">
      <div style="color:var(--t2);font-weight:800;">💡 إدارة الفرص الاستثمارية</div>
      <button class="btn btn-g btn-sm" onclick="openAddOppForm()">+ إضافة</button>
    </div>
    <div style="background:rgba(139,92,246,.07);border:1px solid rgba(139,92,246,.2);border-radius:12px;padding:11px 13px;margin-bottom:12px;">
      <div style="color:#c084fc;font-size:11.5px;font-weight:700;margin-bottom:6px;">🤖 توليد AI تلقائي</div>
      <div style="color:var(--t4);font-size:10.5px;margin-bottom:9px;line-height:1.6;">يقرأ بيانات السوق الحالية والأخبار ويولّد 8 فرص جديدة. يُغلق الفرص القديمة التلقائية ويضيف الجديدة.</div>
      <button class="btn btn-sm" style="background:rgba(139,92,246,.15);border:1px solid rgba(139,92,246,.3);color:#c084fc;width:100%;padding:8px;" id="ai-gen-opps-btn" onclick="generateAIOpps()">🤖 توليد فرص بـ AI الآن</button>
      <div id="ai-gen-status" style="display:none;color:var(--t4);font-size:10px;margin-top:7px;text-align:center;"></div>
    </div>
    <div id="adm-opps-form"></div>
    <div id="adm-opps-list"><div class="sp sp-g" style="margin:20px auto;display:block;"></div></div>
  </div>`;
  await loadAdmOpps();
}

async function generateAIOpps(){
  const btn=document.getElementById("ai-gen-opps-btn");
  const status=document.getElementById("ai-gen-status");
  if(btn)btn.disabled=true,btn.textContent="⏳ جاري التوليد...";
  if(status){status.style.display="block";status.textContent="يقرأ بيانات السوق والأخبار...";}
  try{
    const r=await admFetch("/api/opportunities/generate",{method:"POST",body:JSON.stringify({})});
    const d=await r.json();
    if(d.status==="ok"){
      if(status)status.textContent=`✅ تم إضافة ${d.inserted} فرصة جديدة (أُغلق ${d.closedOld} قديمة)`;
      if(btn)btn.textContent="🤖 توليد فرص بـ AI الآن";
      await loadAdmOpps();
    } else {
      if(status)status.textContent=`⚠️ خطأ: ${d.message}`;
      if(btn)btn.textContent="🤖 توليد فرص بـ AI الآن";
    }
  }catch(e){
    if(status)status.textContent="⚠️ فشل الاتصال بـ AI";
    if(btn)btn.textContent="🤖 توليد فرص بـ AI الآن";
  } finally {
    if(btn)btn.disabled=false;
  }
}

async function loadAdmOpps(){
  const el=document.getElementById("adm-opps-list");if(!el)return;
  try{
    const r=await admFetch("/api/opportunities");
    const d=await r.json();
    const all=(d.opportunities||[]);
    if(!all.length){el.innerHTML=`<div style="text-align:center;padding:20px;color:var(--t4);font-size:12px;">لا توجد فرص بعد</div>`;return;}
    el.innerHTML=all.map(o=>{
      const t=OPP_TYPES[o.type]||{l:o.type,c:"#64748b"};
      return`<div style="background:var(--s1);border:1px solid var(--b1);border-radius:12px;padding:12px;margin-bottom:9px;">
        <div class="row between">
          <div><span style="color:${t.c};font-size:10px;font-weight:700;">${t.l}</span> · <span style="color:var(--t4);font-size:10px;">${o.market}</span>
          ${o.featured?` · <span style="color:var(--au);font-size:10px;">⭐ مميزة</span>`:""}
          ${o.vipOnly?` · <span style="color:#a78bfa;font-size:10px;">VIP</span>`:""}
          <span style="color:${o.status==="active"?"var(--g)":o.status==="coming"?"var(--au)":"var(--dn)"};font-size:10px;margin-right:6px;">● ${o.status==="active"?"نشطة":o.status==="coming"?"قادمة":"مغلقة"}</span></div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm" style="background:rgba(59,130,246,.1);color:#93c5fd;font-size:10px;padding:3px 8px;" onclick="openEditOppForm('${o.id}')">تعديل</button>
            <button class="btn btn-sm rej" style="font-size:10px;padding:3px 8px;" onclick="deleteOpp('${o.id}')">حذف</button>
          </div>
        </div>
        <div style="color:var(--t2);font-size:12px;font-weight:700;margin-top:5px;">${o.title}</div>
        <div style="color:var(--t4);font-size:11px;margin-top:3px;">${(o.summary||"").slice(0,80)}${o.summary?.length>80?"...":""}</div>
      </div>`;
    }).join("");
  }catch(e){el.innerHTML=`<div style="color:var(--dn);font-size:12px;padding:14px;">خطأ في تحميل الفرص</div>`;}
}

function openAddOppForm(existing=null){
  const el=document.getElementById("adm-opps-form");if(!el)return;
  const o=existing||{};
  el.innerHTML=`<div class="adm-opp-form">
    <div style="color:var(--g);font-weight:700;font-size:13px;margin-bottom:12px;">${existing?"✏️ تعديل فرصة":"➕ إضافة فرصة جديدة"}</div>
    <input class="a-in" id="of-title" placeholder="عنوان الفرصة *" value="${o.title||""}" style="margin-bottom:7px;"/>
    <textarea class="a-in" id="of-summary" placeholder="ملخص سريع *" style="margin-bottom:7px;height:70px;resize:none;">${o.summary||""}</textarea>
    <textarea class="a-in" id="of-details" placeholder="تفاصيل إضافية (اختياري)" style="margin-bottom:7px;height:80px;resize:none;">${o.details||""}</textarea>
    <div class="adm-opp-grid">
      <select class="a-in" id="of-type" style="margin-bottom:7px;">
        ${Object.entries(OPP_TYPES).map(([k,v])=>`<option value="${k}" ${o.type===k?"selected":""}>${v.l}</option>`).join("")}
      </select>
      <select class="a-in" id="of-market" style="margin-bottom:7px;">
        ${Object.entries(OPP_MARKETS).map(([k,v])=>`<option value="${k}" ${o.market===k?"selected":""}>${v} ${k}</option>`).join("")}
      </select>
      <input class="a-in" id="of-ret" placeholder="العائد المتوقع" value="${o.expectedReturn||""}" style="margin-bottom:7px;"/>
      <input class="a-in" id="of-sector" placeholder="القطاع" value="${o.sector||""}" style="margin-bottom:7px;"/>
      <input class="a-in" id="of-dur" placeholder="مدة الاستثمار" value="${o.duration||""}" style="margin-bottom:7px;"/>
      <input class="a-in" id="of-deadline" placeholder="الموعد النهائي (مثال: 30 يونيو 2026)" value="${o.deadline||""}" style="margin-bottom:7px;"/>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
      <div style="font-size:11px;color:var(--t3);">درجة المخاطرة:</div>
      ${[1,2,3,4,5].map(i=>`<label style="display:flex;align-items:center;gap:3px;font-size:11px;color:var(--t3);cursor:pointer;"><input type="radio" name="of-risk" value="${i}" ${(o.riskLevel||3)===i?"checked":""}> ${i}</label>`).join("")}
    </div>
    <div style="display:flex;gap:14px;margin-bottom:10px;flex-wrap:wrap;">
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--t3);cursor:pointer;"><input type="checkbox" id="of-featured" ${o.featured?"checked":""}> ⭐ مميزة</label>
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--t3);cursor:pointer;"><input type="checkbox" id="of-vip" ${o.vipOnly?"checked":""}> 🔒 VIP فقط</label>
    </div>
    <select class="a-in" id="of-status" style="margin-bottom:10px;">
      <option value="active" ${(o.status||"active")==="active"?"selected":""}>نشطة</option>
      <option value="coming" ${o.status==="coming"?"selected":""}>قادمة</option>
      <option value="closed" ${o.status==="closed"?"selected":""}>مغلقة</option>
    </select>
    <div style="display:flex;gap:7px;">
      <button class="btn btn-g btn-full" style="padding:10px;" onclick="submitOppForm('${o.id||""}')">${existing?"💾 حفظ التعديلات":"✅ إضافة الفرصة"}</button>
      <button class="btn btn-sm" style="background:var(--s1);color:var(--t4);" onclick="document.getElementById('adm-opps-form').innerHTML=''">إلغاء</button>
    </div>
  </div>`;
}

function openEditOppForm(id){
  const o=oppsData.find(x=>x.id===id)||{id};
  if(!o.title){admFetch(`/api/opportunities`).then(r=>r.json()).then(d=>{const found=d.opportunities?.find(x=>x.id===id);if(found)openAddOppForm(found);});}
  else openAddOppForm(o);
}

async function submitOppForm(existingId){
  const title=document.getElementById("of-title")?.value.trim();
  const summary=document.getElementById("of-summary")?.value.trim();
  if(!title||!summary){showToast("⚠️ العنوان والملخص مطلوبان");return;}
  const risk=document.querySelector("input[name='of-risk']:checked")?.value||"3";
  const body={
    title,summary,
    details:document.getElementById("of-details")?.value.trim()||null,
    type:document.getElementById("of-type")?.value||"stock",
    market:document.getElementById("of-market")?.value||"egypt",
    expectedReturn:document.getElementById("of-ret")?.value.trim()||null,
    sector:document.getElementById("of-sector")?.value.trim()||null,
    duration:document.getElementById("of-dur")?.value.trim()||null,
    deadline:document.getElementById("of-deadline")?.value.trim()||null,
    riskLevel:parseInt(risk),
    status:document.getElementById("of-status")?.value||"active",
    featured:document.getElementById("of-featured")?.checked||false,
    vipOnly:document.getElementById("of-vip")?.checked||false,
  };
  try{
    const url=existingId?`/api/opportunities/${existingId}`:"/api/opportunities";
    const method=existingId?"PUT":"POST";
    const r=await admFetch(url,{method,body:JSON.stringify(body)});
    const d=await r.json();
    if(d.status==="ok"){
      showToast(existingId?"✅ تم تحديث الفرصة":"✅ تمت إضافة الفرصة");
      document.getElementById("adm-opps-form").innerHTML="";
      await loadAdmOpps();
    }else showToast("❌ خطأ: "+d.message);
  }catch(e){showToast("❌ خطأ في الاتصال بالسيرفر");}
}

async function deleteOpp(id){
  if(!confirm("هل تريد حذف هذه الفرصة؟"))return;
  try{
    const r=await admFetch(`/api/opportunities/${id}`,{method:"DELETE"});
    const d=await r.json();
    if(d.status==="ok"){showToast("🗑️ تم حذف الفرصة");await loadAdmOpps();}
    else showToast("❌ "+d.message);
  }catch(e){showToast("❌ خطأ في الاتصال");}
}
