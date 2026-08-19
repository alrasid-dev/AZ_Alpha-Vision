// ============================
// AZ ALPHA VISION 2026 — CORE
// (auth / watchlist / admin / payments now run on real Supabase — everything else unchanged)
// ============================

const SUPABASE_URL = "https://riktmjqbixqlqwqwqoyc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_TMew47Ce-t8NuuJ-4Mpw5w_sa6ckPjf";
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null, currentProfile = null, chartInstance = null, watchlist = [], screenerResults = [], isScanning = false;

// ===== UTILS =====
function toast(msg, type='success') {
    const stack = document.getElementById('toastStack');
    const el = document.createElement('div');
    el.className = 'toast-item ' + (type==='error'?'error':type==='warn'?'warn':'success');
    const icon = type==='success'?'✅':type==='error'?'❌':'⚠️';
    el.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
    stack.appendChild(el);
    setTimeout(()=>{ el.style.opacity='0'; el.style.transform='translateX(-120%)'; setTimeout(()=>el.remove(),300); }, 4000);
}
function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function withTimeout(promise, ms = 15000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))
    ]);
}

// ===== LOCAL CACHE (screener results / weekly picks only — not accounts, not security-sensitive) =====
const LocalCache = {
    getScreener: () => { try { return JSON.parse(localStorage.getItem('az_screener_cache')); } catch { return null; } },
    setScreener: (c) => localStorage.setItem('az_screener_cache', JSON.stringify(c)),
    getPicks: () => { try { return JSON.parse(localStorage.getItem('az_weekly_picks')); } catch { return null; } },
    setPicks: (p) => localStorage.setItem('az_weekly_picks', JSON.stringify(p)),
};

// ===== AUTH (Supabase) =====
function switchAuth(mode) {
    document.getElementById('loginCard').classList.toggle('hidden', mode==='register');
    document.getElementById('registerCard').classList.toggle('hidden', mode==='login');
    document.getElementById('loginError').textContent='';
    document.getElementById('regError').textContent='';
}

function translateAuthError(msg) {
    if (/invalid login credentials/i.test(msg)) return 'بيانات غير صحيحة';
    if (/email not confirmed/i.test(msg)) return 'يرجى تأكيد بريدك الإلكتروني من الرسالة المرسلة إليك';
    if (/already registered|user already exists/i.test(msg)) return 'البريد مستخدم مسبقاً';
    if (/password/i.test(msg)) return 'كلمة المرور غير صالحة (8 أحرف على الأقل)';
    return msg;
}

async function handleRegister() {
    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim().toLowerCase();
    const pass = document.getElementById('regPassword').value;
    const err = document.getElementById('regError');
    if (!name || !email || !pass) { err.textContent = 'املأ جميع الحقول'; return; }
    if (pass.length < 8) { err.textContent = '8 أحرف على الأقل'; return; }
    if (!email.includes('@')) { err.textContent = 'بريد غير صالح'; return; }

    const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { name } } });
    if (error) { err.textContent = translateAuthError(error.message); return; }

    if (data.session) {
        await loadSessionAndEnter();
    } else {
        toast('✅ تم التسجيل — تحقق من بريدك لتأكيد الحساب، ثم انتظر موافقة المسؤول', 'warn');
        document.getElementById('authScreen').style.display = 'none';
        document.getElementById('waitingScreen').classList.add('active');
    }
}

async function handleLogin() {
    const email = document.getElementById('loginEmail').value.trim().toLowerCase();
    const pass = document.getElementById('loginPassword').value;
    const err = document.getElementById('loginError');
    try {
        err.textContent = 'جارٍ التحقق من بيانات الدخول…';
        const { error } = await withTimeout(sb.auth.signInWithPassword({ email, password: pass }), 15000);
        if (error) { err.textContent = translateAuthError(error.message); return; }
        await withTimeout(loadSessionAndEnter(), 20000);
    } catch (e) {
        console.error('login timeout/error:', e);
        err.textContent = e?.message === 'TIMEOUT'
            ? 'انتهت مهلة الاتصال بـSupabase؛ تحقق من الإنترنت ثم أعد المحاولة'
            : 'تعذر إكمال الدخول: ' + (e?.message || 'خطأ غير معروف');
    }
}
async function requestPasswordReset() {
    const email = document.getElementById('loginEmail').value.trim().toLowerCase();
    const err = document.getElementById('loginError');
    if (!email || !email.includes('@')) { err.textContent = 'اكتب بريدك الإلكتروني أولاً'; return; }
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) { err.textContent = 'تعذر إرسال رابط الاستعادة: ' + error.message; return; }
    err.style.color = 'var(--accent-green)';
    err.textContent = 'تم إرسال رابط استعادة كلمة المرور إلى بريدك الإلكتروني';
}
async function completePasswordRecovery() {
    const next = prompt('أدخل كلمة المرور الجديدة (8 أحرف على الأقل):');
    if (next === null) return;
    const confirmNext = prompt('أعد كتابة كلمة المرور الجديدة:');
    if (next.length < 8 || next !== confirmNext) { toast('كلمتا المرور غير متطابقتين أو أقل من 8 أحرف', 'error'); return; }
    const { error } = await sb.auth.updateUser({ password: next });
    if (error) { toast('تعذر تحديث كلمة المرور: ' + error.message, 'error'); return; }
    toast('✅ تم تغيير كلمة المرور بنجاح');
    history.replaceState({}, document.title, window.location.pathname);
    await loadSessionAndEnter();
}
async function loadSessionAndEnter() {
    const err = document.getElementById('loginError');
    try {
        err.textContent = 'جارٍ تحميل الحساب…';
        const { data: { user }, error: userError } = await withTimeout(sb.auth.getUser(), 10000);
        if (userError) throw userError;
        if (!user) { err.textContent = 'انتهت الجلسة، أعد تسجيل الدخول'; return; }
        const { data: profileData, error } = await withTimeout(sb.from('profiles').select('*').eq('id', user.id).single(), 10000);
        if (error || !profileData) throw error || new Error('PROFILE_NOT_FOUND');
        if (!profileData.approved && profileData.role !== 'admin') {
            document.getElementById('authScreen').style.display = 'none';
            document.getElementById('waitingScreen').classList.add('active');
            return;
        }
        // استخدم let/نسخة قابلة للتحديث؛ كان const يسبب توقف الدخول عند تحديث trial_end.
        let profile = await ensureTrialPeriod(profileData);
        if (profile.trial_end && new Date(profile.trial_end).getTime() < Date.now() && profile.role !== 'admin') {
            profile.subscription_status = 'expired';
        }
        err.textContent = '';
        await initApp(user, profile);
    } catch (e) {
        console.error('loadSessionAndEnter error:', e);
        err.textContent = e?.message === 'PROFILE_NOT_FOUND'
            ? 'لم يتم العثور على ملف الحساب؛ تواصل مع المسؤول'
            : 'تعذر إكمال تسجيل الدخول: ' + (e?.message || 'خطأ غير معروف');
    }
}

function handleLogout() {
    sb.auth.signOut();
    currentUser = null; currentProfile = null; watchlist = [];
    document.getElementById('appContainer').classList.remove('active');
    document.getElementById('authScreen').style.display = 'flex';
    document.getElementById('waitingScreen').classList.remove('active');
    toast('👋 تم تسجيل الخروج');
}

// ===== APP INIT =====
async function initApp(user, profile) {
    currentUser = user;
    currentProfile = profile;
    document.getElementById('authScreen').style.display='none';
    document.getElementById('waitingScreen').classList.remove('active');
    document.getElementById('appContainer').classList.add('active');
    document.getElementById('userName').textContent = profile.name || profile.email;
    document.getElementById('userAvatar').textContent = (profile.name || profile.email).charAt(0).toUpperCase();
    if (profile.role === 'admin') { document.getElementById('adminTabBtn').classList.remove('hidden'); refreshAdminData(); }
    ensureEducationConsent();
    await loadWatchlist();
    await loadMySupportTickets();
    updateTrial(); updateSitePerformance(); setInterval(updateTrial, 60000);
    document.getElementById('liveTime').textContent = new Date().toLocaleTimeString('ar-SA');
    setInterval(()=>document.getElementById('liveTime').textContent = new Date().toLocaleTimeString('ar-SA'), 1000);
    setTimeout(()=>initChart(), 100);
    runScanner(); setInterval(runScanner, 15000);
    subscribeSignalRealtime();
    const c = LocalCache.getScreener(); if (c && c.t > Date.now()-86400000) { screenerResults = c.r; renderScreener(); }
}

// ===== WATCHLIST (Supabase — syncs across devices now) =====
async function loadWatchlist() {
    const { data, error } = await sb.from('watchlist').select('*').eq('user_id', currentUser.id);
    if (error) {
        console.error('watchlist load error', error);
        toast('تعذر تحميل المحفظة: ' + error.message, 'error');
        try { watchlist = JSON.parse(localStorage.getItem(`az_watchlist_${currentUser.id}`) || '[]'); } catch { watchlist = []; }
    } else {
        watchlist = (data || []).map(r => ({
            id: r.id, symbol: String(r.symbol || '').toUpperCase(),
            entry_price: Number(r.entry_price ?? r.price ?? 0), qty: Number(r.qty) || 1,
            added: new Date(r.added_at || r.created_at || Date.now()).getTime()
        })).filter(r => r.symbol && r.entry_price > 0).sort((a,b) => a.added - b.added);
        localStorage.setItem(`az_watchlist_${currentUser.id}`, JSON.stringify(watchlist));
    }
    renderWatchlist(); renderPortfolio();
}
async function addToWatchlist() {
    const sym = document.getElementById('addSymbolInput').value.toUpperCase().trim();
    const ep = parseFloat(document.getElementById('addEntryPrice').value);
    if (!sym || !ep || ep<=0) { toast('أدخل رمز وسعر صحيح','error'); return; }
    if (watchlist.find(x=>x.symbol===sym)) { toast('السهم موجود','warn'); return; }
    const { data: inserted, error } = await sb.from('watchlist').insert({ user_id: currentUser.id, symbol: sym, entry_price: ep, qty: 1 }).select().single();
    const localItem = { id: inserted?.id || `local-${Date.now()}`, symbol: sym, entry_price: ep, qty: 1, added: Date.now() };
    if (error) {
        const localItems = [...watchlist.filter(x => x.symbol !== sym), localItem];
        watchlist = localItems;
        localStorage.setItem(`az_watchlist_${currentUser.id}`, JSON.stringify(localItems));
        renderWatchlist(); renderPortfolio();
        toast('تمت الإضافة محليًا؛ أصلح سياسات watchlist في Supabase للمزامنة', 'warn');
        return;
    }
    const localItems = [...watchlist.filter(x => x.symbol !== sym), localItem];
    localStorage.setItem(`az_watchlist_${currentUser.id}`, JSON.stringify(localItems));
    document.getElementById('addSymbolInput').value=''; document.getElementById('addEntryPrice').value='';
    await loadWatchlist();
    toast(`✅ أضيف ${sym}`);
}
async function removeFromWatchlist(sym) {
    const item = watchlist.find(x=>x.symbol===sym);
    if (!item) return;
    const { error } = await sb.from('watchlist').delete().eq('id', item.id);
    if (error) { toast('تعذر الحذف: ' + error.message, 'error'); return; }
    const remaining = watchlist.filter(x => x.symbol !== sym);
    localStorage.setItem(`az_watchlist_${currentUser.id}`, JSON.stringify(remaining));
    await loadWatchlist();
    toast(`🗑️ حُذف ${sym}`);
}

async function renderWatchlist() {
    const c = document.getElementById('watchlistContainer'); c.innerHTML='';
    if (watchlist.length===0) { c.innerHTML='<div class="empty-state" style="padding:20px;font-size:12px;">لا توجد أسهم</div>'; updateStats(0,0,0,0,0); return; }
    const prices = await Promise.all(watchlist.map(w=>fetchPrice(w.symbol)));
    let wins=0, losses=0, totalPnl=0, totalInvested=0, totalCurrent=0;
    watchlist.forEach((item,i)=>{
        const p=prices[i];
        const hasPrice = Number.isFinite(p) && p > 0;
        const qty=item.qty||1;
        const invested=item.entry_price*qty;
        const current=hasPrice ? p*qty : null;
        const pnl=hasPrice ? current-invested : null;
        const pct=hasPrice && invested > 0 ? (pnl/invested)*100 : null;
        if (hasPrice) { totalPnl+=pnl; totalInvested+=invested; totalCurrent+=current; pnl>=0?wins++:losses++; }
        else { totalInvested+=invested; }
        const priceCell = hasPrice ? `$${p.toFixed(2)}` : '<span class="text-muted">بانتظار السعر</span>';
        const pnlCell = hasPrice ? `${pnl>=0?'+':''}$${pnl.toFixed(2)} (${pct.toFixed(1)}%)` : '—';
        c.innerHTML+=`<div class="watch-item"><div style="display:flex;justify-content:space-between;align-items:center;"><span class="sym">${escapeHtml(item.symbol)}</span><span class="price ${hasPrice ? (pnl>=0?'text-green':'text-red') : 'text-muted'}">${priceCell}</span></div><div class="meta"><span>دخول $${item.entry_price.toFixed(2)} × ${qty}</span><span class="pnl ${hasPrice ? (pnl>=0?'text-green':'text-red') : 'text-muted'}">${pnlCell}</span></div><span class="del" onclick="removeFromWatchlist('${escapeHtml(item.symbol)}')">×</span></div>`;
    });
    updateStats(wins,losses,totalPnl,totalInvested,totalCurrent);
}
function updateStats(w,l,pnl,invested,current) {
    document.getElementById('winRecs').textContent=w;
    document.getElementById('loseRecs').textContent=l;
    const pnlEl=document.getElementById('recReturn');
    const pctEl=document.getElementById('recReturnPct');
    const invEl=document.getElementById('totalInvested');
    const curEl=document.getElementById('totalCurrent');
    pnlEl.textContent=(pnl>=0?'+':'')+'$'+Math.abs(pnl).toFixed(2);
    pnlEl.className='val '+(pnl>=0?'pos':'neg');
    const pct = invested > 0 ? (pnl/invested)*100 : 0;
    pctEl.textContent=(pct>=0?'+':'')+pct.toFixed(2)+'%';
    pctEl.className='val '+(pct>=0?'pos':'neg');
    invEl.textContent='$'+(invested||0).toFixed(2);
    curEl.textContent='$'+(current||0).toFixed(2);
}
async function renderPortfolio() {
    const tb = document.getElementById('portfolioTableBody'); tb.innerHTML='';
    if (watchlist.length===0) { tb.innerHTML='<tr><td colspan="8" class="text-muted" style="text-align:center;padding:40px;">لا توجد صفقات</td></tr>'; return; }
    const prices = await Promise.all(watchlist.map(w=>fetchPrice(w.symbol)));
    let totalPnl=0, totalInvested=0, totalCurrent=0;
    watchlist.forEach((item,i)=>{
        const p=prices[i];
        const hasPrice = Number.isFinite(p) && p > 0;
        const qty=item.qty||1;
        const invested=item.entry_price*qty;
        const current=hasPrice ? p*qty : null;
        const pnl=hasPrice ? current-invested : null;
        const pct=hasPrice && invested > 0 ? (pnl/invested)*100 : null;
        totalInvested+=invested;
        if (hasPrice) { totalPnl+=pnl; totalCurrent+=current; }
        const currentCell = hasPrice ? `$${p.toFixed(2)}` : '<span class="text-muted">بانتظار السعر</span>';
        const pnlCell = hasPrice ? `${pnl>=0?'+':''}$${pnl.toFixed(2)}` : '—';
        const pctCell = hasPrice ? `${pct.toFixed(2)}%` : '—';
        tb.innerHTML+=`<tr><td><div class="sym">${escapeHtml(item.symbol)}</div><div class="sym-sub">${qty} سهم</div></td><td class="font-mono">$${item.entry_price.toFixed(2)}</td><td class="font-mono">${currentCell}</td><td class="font-mono ${hasPrice ? (pnl>=0?'text-green':'text-red') : 'text-muted'}">${pnlCell}</td><td class="font-mono ${hasPrice ? (pnl>=0?'text-green':'text-red') : 'text-muted'}">${pctCell}</td><td class="font-mono">$${invested.toFixed(2)}</td><td class="font-mono text-cyan">${hasPrice ? `$${current.toFixed(2)}` : '—'}</td><td><span style="color:var(--text-dim);cursor:pointer;font-size:16px;" onclick="removeFromWatchlist('${escapeHtml(item.symbol)}')">×</span></td></tr>`;
    });
    if (watchlist.length > 0) {
        const totalPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
        tb.innerHTML += `<tr style="border-top:2px solid var(--border); background:rgba(0,240,255,0.03);"><td colspan="3" style="font-weight:700;">الإجمالي</td><td class="font-mono ${totalPnl>=0?'text-green':'text-red'}" style="font-weight:700;">${totalPnl>=0?'+':''}$${totalPnl.toFixed(2)}</td><td class="font-mono ${totalPct>=0?'text-green':'text-red'}" style="font-weight:700;">${totalPct.toFixed(2)}%</td><td class="font-mono">$${totalInvested.toFixed(2)}</td><td class="font-mono text-cyan" style="font-weight:700;">$${totalCurrent.toFixed(2)}</td><td></td></tr>`;
    }
}

// ===== TRIAL =====
function updateTrial() {
    if (!currentProfile) return;
    const b = document.getElementById('trialBadge');
    const btn = document.getElementById('upgradeBtn');
    if (currentProfile.role === 'admin') { b.textContent='أدمن'; b.classList.remove('expired'); btn.style.display='none'; return; }
    if (!currentProfile.trial_end) { b.textContent='بانتظار التفعيل'; b.classList.add('expired'); btn.style.display='none'; return; }
    const diff = new Date(currentProfile.trial_end).getTime() - Date.now();
    if (diff<=0) { b.textContent='منتهي'; b.classList.add('expired'); btn.style.display='inline-block'; }
    else { const d=Math.ceil(diff/86400000); b.textContent=d+' يوم متبقي'; b.classList.remove('expired'); btn.style.display='inline-block'; btn.textContent='أرغب بالترقية والاستمرار بالتعلم'; }
}
function openUpgradeModal(){document.getElementById('upgradeModal').classList.add('active');}
function closeUpgradeModal(){document.getElementById('upgradeModal').classList.remove('active');}

async function submitBankTransfer(){
    const f=document.getElementById('receiptUpload');
    if(!f.files||!f.files.length){toast('ارفع الإيصال أولاً','warn');return;}
    const file = f.files[0];
    const path = `${currentUser.id}/${Date.now()}_${file.name}`;
    const { error: upErr } = await sb.storage.from('receipts').upload(path, file);
    if (upErr) { toast('تعذر رفع الإيصال: ' + upErr.message, 'error'); return; }
    const { error: insErr } = await sb.from('upgrade_requests').insert({ user_id: currentUser.id, receipt_path: path });
    if (insErr) { toast('تعذر إرسال الطلب: ' + insErr.message, 'error'); return; }
    toast('✅ تم استلام طلب الترقية — بانتظار مراجعة المسؤول');
    closeUpgradeModal();
    f.value = '';
}

// ===== ADMIN (Supabase) =====
async function refreshAdminData() {
    if(!currentProfile||currentProfile.role!=='admin')return;
    const { data: users, error } = await sb.from('profiles').select('*').order('created_at', { ascending:false });
    if (error || !users) { toast('تعذر تحميل بيانات الأدمن: ' + (error?.message||''), 'error'); return; }

    document.getElementById('totalUsers').textContent=users.length;
    document.getElementById('pendingUsers').textContent=users.filter(u=>!u.approved).length;
    document.getElementById('activeUsers').textContent=users.filter(u=>u.approved&&(!u.trial_end||new Date(u.trial_end).getTime()>Date.now())).length;
    document.getElementById('expiredUsers').textContent=users.filter(u=>u.approved&&u.trial_end&&new Date(u.trial_end).getTime()<=Date.now()).length;

    const { data: wl } = await sb.from('watchlist').select('user_id');
    const wlCount = {};
    (wl||[]).forEach(w=>wlCount[w.user_id]=(wlCount[w.user_id]||0)+1);

    const tb = document.getElementById('adminTableBody'); tb.innerHTML='';
    users.forEach(u=>{
        const st=!u.approved?'<span class="badge" style="background:rgba(255,215,0,0.1);color:var(--accent-gold);border:1px solid rgba(255,215,0,0.15);">معلق</span>':(u.trial_end&&new Date(u.trial_end).getTime()<=Date.now())?'<span class="badge" style="background:var(--accent-red-dim);color:var(--accent-red);border:1px solid rgba(255,23,68,0.15);">منتهي</span>':'<span class="badge" style="background:var(--accent-green-dim);color:var(--accent-green);border:1px solid rgba(0,230,118,0.15);">نشط</span>';
        const td = u.trial_end ? Math.ceil((new Date(u.trial_end).getTime()-Date.now())/86400000) : null;
        const tt = u.role==='admin' ? 'غير محدود' : (td!==null ? (td>0?td+' يوم':'منتهي') : 'لم يُفعَّل بعد');
        let act='';
        if(!u.approved&&u.role!=='admin')act=`<button class="admin-btn btn-approve" onclick="approveUser('${u.id}')">قبول</button>`;
        else if(u.role==='admin')act='<span style="color:var(--accent-purple);font-size:11px;">🛡️ مسؤول</span>';
        else act='<span style="color:var(--accent-green);font-size:11px;">✓ مفعل</span>';
        tb.innerHTML+=`<tr><td style="font-weight:600;">${escapeHtml(u.name||'-')}</td><td style="font-size:11px;color:var(--text-muted);">${escapeHtml(u.email)}</td><td>${st}</td><td style="font-size:11px;">${tt}</td><td class="font-mono text-cyan">${wlCount[u.id]||0}</td><td>${act}</td></tr>`;
    });

    await refreshUpgradeRequests();
    await refreshSupportTickets();
}

const TICKET_STATUS_LABEL = { open: 'مفتوحة', in_progress: 'قيد المعالجة', resolved: 'تم الحل', closed: 'مغلقة' };
const TICKET_PRIORITY_LABEL = { normal: 'عادية', high: 'مهمة', urgent: 'عاجلة' };
function ticketBadge(status) {
    const color = status === 'open' ? 'var(--accent-gold)' : status === 'in_progress' ? 'var(--accent-cyan)' : status === 'resolved' ? 'var(--accent-green)' : 'var(--text-muted)';
    return `<span class="badge" style="color:${color};border:1px solid ${color};background:transparent;">${TICKET_STATUS_LABEL[status] || status}</span>`;
}
async function submitSupportTicket() {
    const subject = document.getElementById('ticketSubject')?.value.trim();
    const message = document.getElementById('ticketMessage')?.value.trim();
    const priority = document.getElementById('ticketPriority')?.value || 'normal';
    if (!subject || subject.length < 3 || !message || message.length < 5) { toast('اكتب عنوانًا وتفاصيل كافية للتذكرة', 'warn'); return; }
    const { error } = await sb.from('support_tickets').insert({ user_id: currentUser.id, subject, message, priority });
    if (error) { toast('تعذر إرسال التذكرة: ' + error.message, 'error'); return; }
    document.getElementById('ticketSubject').value = '';
    document.getElementById('ticketMessage').value = '';
    toast('✅ تم إرسال التذكرة للمسؤول');
    await loadMySupportTickets();
}
async function loadMySupportTickets() {
    const tb = document.getElementById('myTicketsBody');
    if (!tb || !currentUser) return;
    const { data, error } = await sb.from('support_tickets').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: false });
    if (error) { tb.innerHTML = `<tr><td colspan="5" class="text-muted">تعذر تحميل التذاكر</td></tr>`; return; }
    if (!data?.length) { tb.innerHTML = '<tr><td colspan="5" class="text-muted" style="padding:20px;text-align:center;">لا توجد تذاكر حتى الآن</td></tr>'; return; }
    tb.innerHTML = data.map(t => `<tr><td>${new Date(t.created_at).toLocaleString('ar-SA')}</td><td>${escapeHtml(t.subject)}<div class="text-muted" style="font-size:11px;white-space:pre-wrap;">${escapeHtml(t.message)}</div></td><td>${TICKET_PRIORITY_LABEL[t.priority] || t.priority}</td><td>${ticketBadge(t.status)}</td><td style="white-space:pre-wrap;">${escapeHtml(t.admin_reply || 'بانتظار رد المسؤول')}</td></tr>`).join('');
}
async function refreshSupportTickets() {
    const tb = document.getElementById('adminTicketsBody');
    if (!tb || !currentProfile || currentProfile.role !== 'admin') return;
    const { data: tickets, error } = await sb.from('support_tickets').select('*').order('created_at', { ascending: false });
    if (error || !tickets?.length) { tb.innerHTML = '<tr><td colspan="6" class="text-muted" style="padding:20px;text-align:center;">لا توجد تذاكر دعم</td></tr>'; return; }
    const ids = [...new Set(tickets.map(t => t.user_id))];
    const { data: profs } = await sb.from('profiles').select('id,name,email').in('id', ids);
    const map = Object.fromEntries((profs || []).map(p => [p.id, p]));
    tb.innerHTML = tickets.map(t => {
        const p = map[t.user_id] || {};
        return `<tr><td>${escapeHtml(p.name || p.email || '-')}</td><td><strong>${escapeHtml(t.subject)}</strong><div class="text-muted" style="font-size:11px;white-space:pre-wrap;">${escapeHtml(t.message)}</div></td><td>${TICKET_PRIORITY_LABEL[t.priority] || t.priority}</td><td>${ticketBadge(t.status)}</td><td>${new Date(t.created_at).toLocaleDateString('ar-SA')}</td><td><button class="admin-btn btn-approve" onclick="replySupportTicket('${t.id}')">رد</button><button class="admin-btn" onclick="setSupportStatus('${t.id}','in_progress')">قيد المعالجة</button><button class="admin-btn btn-approve" onclick="setSupportStatus('${t.id}','resolved')">حل</button></td></tr>`;
    }).join('');
}
async function replySupportTicket(id) {
    const reply = prompt('اكتب ردك على التذكرة:');
    if (reply === null) return;
    if (reply.trim().length < 2) { toast('الرد قصير جدًا', 'warn'); return; }
    const { error } = await sb.from('support_tickets').update({ admin_reply: reply.trim(), status: 'in_progress', updated_at: new Date().toISOString() }).eq('id', id);
    if (error) { toast('تعذر حفظ الرد: ' + error.message, 'error'); return; }
    toast('✅ تم إرسال الرد'); refreshSupportTickets();
}
async function setSupportStatus(id, status) {
    const { error } = await sb.from('support_tickets').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) { toast('تعذر تحديث الحالة: ' + error.message, 'error'); return; }
    toast('✅ تم تحديث حالة التذكرة'); refreshSupportTickets();
}

async function approveUser(uid) {
    if(!confirm('قبول المستخدم وتفعيل تجربة 60 يوماً؟'))return;
    const { error } = await sb.rpc('approve_new_user', { target_user_id: uid });
    if (error) { toast('تعذرت الموافقة: ' + error.message, 'error'); return; }
    toast('✅ تم القبول'); refreshAdminData();
}

async function refreshUpgradeRequests() {
    const tb = document.getElementById('upgradeRequestsBody');
    if (!tb) return;
    const { data: reqs, error } = await sb.from('upgrade_requests').select('*').eq('status','pending').order('created_at',{ascending:true});
    if (error || !reqs || !reqs.length) { tb.innerHTML='<tr><td colspan="5" class="text-muted" style="text-align:center;padding:20px;">لا توجد طلبات معلقة</td></tr>'; return; }

    const userIds = [...new Set(reqs.map(r=>r.user_id))];
    const { data: profs } = await sb.from('profiles').select('id,name,email').in('id', userIds);
    const profMap = Object.fromEntries((profs||[]).map(p=>[p.id,p]));

    tb.innerHTML='';
    for (const r of reqs) {
        const p = profMap[r.user_id] || {};
        const { data: signed } = await sb.storage.from('receipts').createSignedUrl(r.receipt_path, 3600);
        const link = signed ? `<a class="receipt-link" href="${signed.signedUrl}" target="_blank">عرض الإيصال</a>` : '—';
        tb.innerHTML+=`<tr><td>${escapeHtml(p.name||'-')}</td><td style="font-size:11px;color:var(--text-muted);">${escapeHtml(p.email||'-')}</td><td style="font-size:11px;">${new Date(r.created_at).toLocaleDateString('ar-SA')}</td><td>${link}</td><td><button class="admin-btn btn-approve" onclick="reviewUpgrade('${r.id}','approved')">قبول</button><button class="admin-btn btn-reject" onclick="reviewUpgrade('${r.id}','rejected')">رفض</button></td></tr>`;
    }
}

async function reviewUpgrade(requestId, status) {
    if(!confirm(status==='approved' ? 'تفعيل اشتراك شهري لمدة 30 يومًا لهذا المستخدم؟' : 'رفض الطلب؟'))return;
    const { error } = await sb.rpc('review_upgrade_request', { request_id: requestId, new_status: status, extend_days: 30 });
    if (error) { toast('فشل الإجراء: ' + error.message, 'error'); return; }
    toast(status==='approved' ? '✅ تم التفعيل' : '❌ تم الرفض');
    refreshAdminData();
}

// ===== SESSION RESTORE ON LOAD =====
document.addEventListener('DOMContentLoaded', async () => {
    sb.auth.onAuthStateChange((event) => {
        if (event === 'PASSWORD_RECOVERY') setTimeout(() => completePasswordRecovery(), 0);
    });
    const { data: { session } } = await sb.auth.getSession();
    if (session) await loadSessionAndEnter();
});

// ===== 800+ STOCK UNIVERSE (fetch_market_data.py fetches real data for exactly this list — keep both in sync) =====
const STOCK_UNIVERSE = [
    'AAPL','MSFT','GOOGL','GOOG','AMZN','NVDA','META','TSLA','AVGO','PEP','COST','ADBE','NFLX','AMD','INTC','CSCO','CRM','ACN','TXN','QCOM',
    'AMAT','INTU','ADP','MU','LRCX','KLAC','MRVL','NXPI','SNPS','CDNS','ANSS','PTC','FTNT','PANW','CRWD','SNOW','PLTR','DDOG','NET','OKTA',
    'ZS','SPLK','VEEV','WDAY','NOW','TEAM','DOCU','ZM','U','RBLX','ABNB','UBER','LYFT','DASH','SQ','PYPL','SHOP','SPOT','TWLO','SNAP','PINS',
    'MTCH','BMBL','RDFN','Z','OPEN','EXPE','BKNG','TRIP','GDRX','RXRX','TDOC','AMGN','GILD','BIIB','REGN','VRTX','ILMN','DXCM','TMO','DHR',
    'ISRG','ZBH','BSX','ABT','SYK','BDX','MDT','EW','HOLX','IDXX','WAT','A','MTD','PKI','BRKR','WST','COO','ALGN','SGEN','MRNA','BNTX',
    'NVAX','JNJ','MRK','PFE','ABBV','BMY','LLY','NVO','AZN','GSK','SNY','RPRX','VTRS','CTLT','DVA','FMS','UHS','CYH','LPNT','HCA','THC',
    'MPW','OHI','WELL','VTR','PEAK','HCP','SBRA','HR','RHP','SLG','BXP','VNO','ARE','QTS','DLR','CCI','AMT','SBAC','WY','RYN','PCH',
    'CLF','NUE','STLD','MT','X','RS','CMC','TMST','ATI','KALU','SCHN','WOR','ZEUS','ASTL','CENX','AA','KGC','NEM','GOLD','AEM','FNV',
    'WPM','RGLD','OR','AUY','EGO','AGI','BTG','HL','CDE','PAAS','SSRM','MAG','SVM','EXK','GPL','LODE','TRX','THM','NGD','MUX','GORO',
    'DRD','SA','SAND','ORLA','FVI','SILV','AG','FSM','HYMC','GROY','MTA','REVG','OSK','NAV','WNC','PACCAR','CMI','PCAR','REV','MGA',
    'LEA','ALV','GNTX','DLPH','BWA','TEN','VC','AXL','MOD','SMP','DORM','STRT','SUP','CTB','GT','RGR','SWBI','VSTO','AOUT','POWW','RBC',
    'TWI','CUB','KWR','HAYN','FUBO','AMC','BBBY','GME','M','NOK','PFE','BAC','C','WFC','CSCO','INTC','AMD','MU','T','VZ','TMUS','CMCSA',
    'SIRI','TWLO','RIVN','LCID','PLUG','FSLR','ENPH','SPWR','NIO','XPEV','BYND','JMIA','SKLZ','U','CRNC','DOCU','ZM','WORK','DKNG','RBLX',
    'ABNB','UBER','WBD','PARA','FOXA','NWSA','NYT','META','SNAP','PINS','MTCH','BMBL','RDFN','Z','OPEN','EXPE','BKNG','TRIP','UBER','LYFT',
    'DASH','GDRX','RXRX','TDOC','AMZN','WMT','TGT','KSS','JCP','BIG','RAD','DPZ','PZZA','YUM','MCD','CMG','MRNA','BNTX','NVAX','AZN',
    'GSK','ILMN','DXCM','TMO','DHR','BRKR','VEEV','CDNS','SNPS','ANSS','ADSK','ADBE','INTU','NOW','CRM','TEAM','WORK','FSLY','FTNT','PANW',
    'NET','ZS','OKTA','PSTG','MDB','DDOG','CONN','IOT','AI','SOUN','NVDA','CRWD','HUBS','TWLO','S','ZUO','EGHT','AVGO','MRVL','TXN','ADI',
    'QCOM','NXPI','SWKS','QRVO','TECH','AMD','INTC','MU','NTAP','PSTG','WDC','STX','SE','PINS','TTD','MGNI','PUBM','CMPR','LDI','BIGC',
    'ETSY','WISH','CART','EBAY','AMZN','WMT','TGT','ROST','TJX','BOOT','BKE','DDS','M','JWN','GES','ANF','URBN','ZUMZ','CPRI','PVH','RL',
    'KORS','COH','OXM','SHOO','CWH','GIII','LEVI','SCVL','HIBB','GPS','DBI','KTB','CAL','CROX','WHR','ARHS','WSM','RH','BYON','NWHM',
    'TDOC','MDU','LNT','CMS','D','ED','ES','EIX','EXC','FE','DTE','XEL','AEP','PEG','ETR','NEE','SO','DUK','BK','RY','TD','PNC','USB',
    'TFC','COF','SYF','ALLY','DFS','FITB','KEY','HBAN','ZION','CMA','PB','TCF','UMB','IBKR','SCHW','MS','GS','JPM','C','BAC','WFC','MTB',
    'PPBI','FRC','WAL','PACW','SIVB','MUFG','SMFG','JEF','RJF','FHI','NTRS','STT','RF','VLY','TBBK','BSBR','ITUB','BBD','SBS','ABEV',
    'BRFS','ERJ','GOL','AZUL','BZ','VALE','GGB','CSAN','RAD','SU','HMC','TM','STLA','F','GM','TSLA','RIVN','LCID','NIO','XPEV','BYD',
    'HOG','PII','NTLA','BEAM','CRSP','NKTR','AZN','GSK','MRNA','BNTX','NVAX','JNJ','MRK','PFE','ABBV','BMY','GILD','AMGN','BIIB','REGN',
    'VRTX','QRTEA','TDOC','HUM','UNH','CNC','ANTM','WBA','CVS','TGT','AAP','KMX','AZO','ORLY','GPC','PAG','GPI','ABG','SAH','LAD','MUSA',
    'BC','ALSN','OSK','REV','PATK','BLD','OC','LPX','BECN','EPC','BUR','CARR','AA','ALB','AA','FMC','ECL','DD','DOW','RPM','SHW','PPG',
    'HXL','WLK','CE','LYB','EMN','ALB','NTR','CTVA','BA','RTX','LMT','NOC','GD','LHX','AXE','MRCY','HXL','TEL','APH','ROL','HII','SPR',
    'WWD','CW','NOC','GD','RTX','LMT','BHE','PNR','ITW','GWW','FAST','SNA','LECO','CAT','DE','CNHI','AGCO','TEX','MTW','ASTE','POWL',
    'DORM','WNC','SUPV','HTZ','CAR','AAL','DAL','UAL','JBLU','ALK','SAVE','HA','ASIX','AHCO','MDT','BSX','ABT','SYK','BDX','BAX','DHR',
    'TMO','ZBH','CNMD','VAR','ANIK','ATRC','BDX','BSX','MDT','SYK','ABT','ZBH','TMO','DHR','NEO','LIVN','NVRO','SIBN','HOLX','NOVT',
    'TWST','ATOM','EXAS','QGEN','NEO','FMI','GH','EXEL','AUTL','ALXN','CBM','IOVA','BMRN','DAWN','CYTK','ACAD','CNCE','ARNA','EYPT',
    'ACHV','ADVM','AGEN','ALLO','ALXN','AMRN','AMRS','ARPO','AVRO','BGNE','BHVN','BLUE','CALA','CLVS','CRIS','CRMD','CRTX','CTMX','CVAC',
    'CYRX','DVAX','EIGR','EMRA','EPZM','ESPR','EVFN','FBIO','FGEN','FOLD','GERN','GLUE','HARP','HGEN','HLGN','IMGN','IMTX','INO','JAGX',
    'KALA','KPTI','LGVN','LOGC','LXRX','MBIO','MESO','MGNX','MRNS','MVC','NDVA','OCGN','OLMA','ONCE','ORGS','PDSB','PTC','RAPT','REPL',
    'REPT','SAGE','SCPH','SGEN','SLNO','SRPT','STOK','TAK','TCBP','TCRX','TH','TKAI','TLSA','URGN','VANI','VERU','VIRC','VIRX','VSTM',
    'XBIT','XENE','XNCR','ZLAB','ALT','AMC','CWH','DDS','GES','HIBB','JWN','KSS','M','URBN','WISH','GME','BBBY','M','JCP','BIG','RAD',
    'KSS','JWN','ANF','GES','HIBB','URBN','ZUMZ','CHS','CWH','DDS','GES','JWN','KSS','M','URBN','WISH','GME','BBBY','SOFI','AFRM','UPST',
    'HOOD','COIN','PLTR','SNOW','DDOG','NET','CRWD','OKTA','ZS','S','MDB','ESTC','SMAR','ASAN','MNDY','AI','SOUN','BBAI','AMST','DUOT',
    'LTRX','RXT','SSTI','VRNS','RPD','TENB','CYBR','QLYS','SUMO','DOMO','PLAN','MOND','BABA','JD','PDD','NTES','BIDU','TCEHY','TCOM',
    'VIPS','MOMO','YY','HUYA','DOYU','FUTU','TIGR','LU','FINV','QFIN','LX','YRD','JT','PPDF','XYF','LI','FSR','GOEV','MULN','NKLA','WKHS',
    'RIDE','QS','SPWR','SEDG','RUN','NOVA','CWEN','AY','SRE','WEC','ATO','SWX','NFG','OGS','SR','SPH','FGP','APU','SUG','CMLP','DPM',
    'EPD','ETP','KMP','MMP','MWE','BPL','BWP','CPNO','DCP','ENLK','EXLP','GLP','HEP','MMLP','NS','OKS','PAA','SXL','TCP','TLP','WES',
    'WPZ','XTEX','APL','ATLS','EEP','ETP','GEL','CGC','TLRY','ACB','CRON','SNDL','GTBIF','TCNNF','CURLF','CRLBF','PLNHF','VRNOF','GDNSF',
    'AYRWF','JUSHF','MSOS','MJ','YOLO','POTX','THCX','TOKE','ACT','SPCE','RKLB','ASTS','MNTS','VORB','REDWIRE','SATL','BKSY','MYNA','SPIR',
    'ASTR','LLAP','SIDU','SATS','GSAT','IRDM','VSAT','MAXR','DDD','SSYS','DM','MKFG','VLD','MTLS','NNDM','XONE','PRLB','ATVI','EA','TTWO',
    'PLTK','SCPL','GLUU','ZNGA','XOM','CVX','COP','EOG','SLB','OXY','MPC','VLO','PSX','MRO','DVN','FANG','PXD','OVV','APA','CHRD','SM',
    'MTDR','PE','GPOR','RRC','AR','SWN','CTRA','EQT','CNX','RICE','NFG','UPS','FDX','CHRW','EXPD','XPO','SAIA','ODFL','LSTR','ARCB','HTLD',
    'MRTN','WERN','KNX','JBHT','SWFT','CGNX','ZTO','YMM','DIDI','GRUB','TKAY','GETR','DADA','GOGO','ATSG','ABSTS','AIR','AIRT','MOS','CF',
    'GE','HON','MMM'
];
const UNIQUE_STOCKS = [...new Set(STOCK_UNIVERSE)];

const SECTOR_MAP = {}; // لم يعد يُستخدَم لتصنيف الفحص (ذلك يأتي الآن من Finviz عبر market_fundamentals.sector) — أُبقي فارغًا عمدًا؛ محفوظ فقط لتفادي كسر أي مرجع قديم متبقٍّ.

const EXCLUDED_SYMBOLS = new Set([
    'DDV',
    'LUCK','TAL','EDU','GSX','STG','FANH','QTT','UXIN','SOGO','QFIN','FINV','YRD','JT','PPDF','XYF',
    'NIO','XPEV','LI','BYD','F','GM','HOG','PII','NKLA','WKHS','RIDE','GOEV','MULN','FSR','LCID','RIVN',
    'AMC','GME','BBBY','M','JCP','BIG','RAD','EXPR','KOSS','NAKD','SNDL','TLRY','ACB','CRON','OGI','HEXO','CGC',
    'JAGX','INO','OCGN','OLMA','ONCE','ORGS','PDSB','RAPT','REPL','REPT','SCPH','SLNO','TCRX','TKAI','TLSA','URGN','VANI','VERU','VIRC','VIRX','VSTM','XBIT','XENE','XNCR','ZLAB','ALT','ACHV','ADVM','AMRS','ARPO','AVRO','BGNE','BHVN','BLUE','CALA','CLVS','CRIS','CRMD','CRTX','CTMX','CVAC','CYRX','DVAX','EIGR','EMRA','EPZM','ESPR','EVFN','FBIO','FGEN','FOLD','GERN','GLUE','HARP','HGEN','HLGN','IMGN','IMTX','KALA','KPTI','LGVN','LOGC','LXRX','MBIO','MESO','MGNX','MRNS','MVC','NDVA',
    'CGC','TLRY','ACB','CRON','SNDL','GTBIF','TCNNF','CURLF','CRLBF','PLNHF','VRNOF','GDNSF','AYRWF','JUSHF','MSOS','MJ','YOLO','POTX','THCX','TOKE','ACT',
    'SPCE','RKLB','ASTS','MNTS','VORB','REDWIRE','SATL','BKSY','MYNA','SPIR','ASTR','LLAP','SIDU'
]);

const LIVE_TRACKED = ['AAPL','MSFT','GOOGL','AMZN','NVDA','TSLA','META','AMD','NFLX','CRM','SHOP','SQ','UBER','ABNB','COIN','ROKU','SNAP','PINS','ETSY','TWLO','DDOG','NET','OKTA','ZS','CRWD','PLTR','SNOW','FSLR','ENPH','RUN','U','RBLX','SOFI','AFRM','HOOD','UPST','AI','SOUN','BBAI','PLUG','QS','SPCE','RKLB','ASTS','LLAP','BABA','JD','PDD','FUTU','TIGR'];

// ===== MAIN CHART (still a generic decorative candle view, not yet wired to per-symbol real OHLC — noted as a remaining item) =====
function initChart() {
    const box = document.getElementById('chartBox');
    const cont = document.getElementById('chartContainer');
    if (!box || !cont || box.clientWidth === 0) return;
    if (chartInstance) { chartInstance.remove(); chartInstance = null; }
    chartInstance = LightweightCharts.createChart(cont, {
        width: cont.clientWidth, height: cont.clientHeight,
        layout: { background: { color: 'transparent' }, textColor: '#6b7280' },
        grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
        timeScale: { timeVisible: true, borderColor: 'rgba(255,255,255,0.06)' },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
        crosshair: { mode: 1, vertLine: { color: '#00f0ff', width: 1, style: 2 }, horzLine: { color: '#00f0ff', width: 1, style: 2 } }
    });
    const series = chartInstance.addCandlestickSeries({
        upColor: '#00e676', downColor: '#ff1744',
        borderUpColor: '#00e676', borderDownColor: '#ff1744',
        wickUpColor: '#00e676', wickDownColor: '#ff1744'
    });
    const data = []; let v = 100;
    for (let i = 60; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate()-i);
        const o = v + (Math.random()-0.5)*3;
        const c = o + (Math.random()-0.5)*4;
        const h = Math.max(o,c) + Math.random()*2;
        const l = Math.min(o,c) - Math.random()*2;
        v = c;
        data.push({ time: d.toISOString().split('T')[0], open: +o.toFixed(2), high: +h.toFixed(2), low: +l.toFixed(2), close: +c.toFixed(2) });
    }
    series.setData(data); chartInstance.timeScale().fitContent();
    window.addEventListener('resize', () => { if(chartInstance&&cont)chartInstance.resize(cont.clientWidth,cont.clientHeight); });
}

function switchTab(id) {
    document.querySelectorAll('.tab-panel').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    const panel = document.getElementById('tab-' + id);
    const btn = document.querySelector(`.tab-btn[data-tab="${id}"]`);
    if (panel) panel.classList.remove('hidden');
    if (btn) btn.classList.add('active');

    const chartBox = document.getElementById('chartBox');
    if (chartBox) {
        if (id === 'stocks') {
            chartBox.style.display = 'block';
            if (chartInstance) setTimeout(()=>chartInstance.resize(chartBox.clientWidth, chartBox.clientHeight), 50);
        } else {
            chartBox.style.display = 'none';
        }
    }

    if (id === 'screener' && !screenerResults.length) {
        document.getElementById('screenerTableBody').innerHTML = '<tr><td colspan="13" style="text-align:center;color:var(--text-muted);padding:40px;">اضغط "بدء الفلترة" للبحث في 800+ سهم</td></tr>';
    }
    if (id === 'signals') { loadSignalsData(); }
    if (id === 'admin' && currentProfile && currentProfile.role === 'admin') refreshAdminData();
    if (id === 'indicators') { setTimeout(() => { initIndicatorChart(); updateChartIndicators(); }, 50); }
    if (id === 'portfolio') { renderPortfolio(); }
    if (id === 'picks') { updateSitePerformance(); }
}

// ===== INDICATORS (Fib / SMC / ATR — still overlaid on the decorative chart above, unchanged logic) =====
let indicatorState = {
    fib: { active: false, settings: {} },
    lux: { active: false, settings: {} },
    atr: { active: false, settings: {} }
};
let chartOverlays = { fib: [], lux: [], atr: [] };

const defaultSettings = {
    fib: { swings:5, depth:8, extendLeft:true, extendRight:false, showPrices:true, levelsMode:'all', labels:'right', bgOpacity:85, levels:[0,0.236,0.382,0.5,0.618,0.786,1,1.272,1.414,1.618,2,2.24] },
    lux: { mode:'historical', style:'colored', colorCandles:false, showInternal:true, showSwing:true, bullishColor:'#00e676', bearishColor:'#ff1744', confluence:false, labelSize:'small' },
    atr: { cciPeriod:20, multiplier:2, atrPeriod:14, source:'close', bullColor:'#00e676', bearColor:'#ff1744', lineWidth:2 }
};

function openIndicatorModal(id) { document.getElementById(id+'Modal').classList.add('active'); }
function closeIndicatorModal(id) { document.getElementById(id+'Modal').classList.remove('active'); }
function selectColor(el, target) {
    el.parentElement.querySelectorAll('.color-dot').forEach(d=>d.classList.remove('selected'));
    el.classList.add('selected');
    if(!window._colorPickers) window._colorPickers={};
    window._colorPickers[target] = el.dataset.color;
}
function toggleIndicator(id) {
    indicatorState[id].active = !indicatorState[id].active;
    const btn = document.getElementById(id+'ToggleBtn');
    const badge = document.getElementById(id+'Badge');
    if(indicatorState[id].active) {
        btn.textContent = '⏹️ إيقاف'; btn.classList.add('active');
        badge.style.display = 'inline-flex';
        toast('✅ مؤشر '+id.toUpperCase()+' مفعل');
    } else {
        btn.textContent = '▶️ تفعيل'; btn.classList.remove('active');
        badge.style.display = 'none';
        toast('⏹️ مؤشر '+id.toUpperCase()+' متوقف');
    }
    updateChartIndicators();
}
function saveIndicatorSettings(id) {
    const s = {};
    if(id==='fib') {
        s.swings = parseInt(document.getElementById('fibSwings').value);
        s.depth = parseInt(document.getElementById('fibDepth').value);
        s.extendLeft = document.getElementById('fibExtendLeft').classList.contains('active');
        s.extendRight = document.getElementById('fibExtendRight').classList.contains('active');
        s.showPrices = document.getElementById('fibShowPrices').classList.contains('active');
        s.levelsMode = document.getElementById('fibLevelsMode').value;
        s.labels = document.getElementById('fibLabels').value;
        s.bgOpacity = parseInt(document.getElementById('fibBgOpacity').value);
        s.levels = Array.from(document.querySelectorAll('#fibLevelChecks input:checked')).map(i=>parseFloat(i.value));
    } else if(id==='lux') {
        s.mode = document.getElementById('luxMode').value;
        s.style = document.getElementById('luxStyle').value;
        s.colorCandles = document.getElementById('luxColorCandles').classList.contains('active');
        s.showInternal = document.getElementById('luxShowInternal').classList.contains('active');
        s.showSwing = document.getElementById('luxShowSwing').classList.contains('active');
        s.bullishColor = window._colorPickers?.luxBullishColor || '#00e676';
        s.bearishColor = window._colorPickers?.luxBearishColor || '#ff1744';
        s.confluence = document.getElementById('luxConfluence').classList.contains('active');
        s.labelSize = document.getElementById('luxLabelSize').value;
    } else if(id==='atr') {
        s.cciPeriod = parseInt(document.getElementById('atrCCIPeriod').value);
        s.multiplier = parseFloat(document.getElementById('atrMultiplier').value);
        s.atrPeriod = parseInt(document.getElementById('atrPeriod').value);
        s.source = document.getElementById('atrSource').value;
        s.bullColor = window._colorPickers?.atrBullColor || '#00e676';
        s.bearColor = window._colorPickers?.atrBearColor || '#ff1744';
        s.lineWidth = parseInt(document.getElementById('atrLineWidth').value);
    }
    indicatorState[id].settings = {...(indicatorState[id].settings||defaultSettings[id]), ...s};
    closeIndicatorModal(id);
    if(indicatorState[id].active) { updateChartIndicators(); toast('💾 تم حفظ إعدادات '+id.toUpperCase()); }
    else { toast('💾 تم الحفظ — فعّل المؤشر للتطبيق'); }
}
function clearAllIndicators() {
    ['fib','lux','atr'].forEach(id=>{
        indicatorState[id].active = false;
        document.getElementById(id+'ToggleBtn').textContent = '▶️ تفعيل';
        document.getElementById(id+'ToggleBtn').classList.remove('active');
        document.getElementById(id+'Badge').style.display = 'none';
    });
    updateChartIndicators();
    toast('🗑️ تم مسح جميع المؤشرات');
}
function clearChartOverlays(id) {
    if(!window.indicatorChart) return;
    chartOverlays[id].forEach(o=>{ try{ window.indicatorChart.removeSeries(o); }catch(e){} });
    chartOverlays[id] = [];
}
function updateChartIndicators() {
    if(!window.indicatorChart) return;
    const series = window.indicatorChart.serieses()[0];
    if(!series) return;
    const data = series.data();
    if(!data || data.length < 20) return;
    ['fib','lux','atr'].forEach(clearChartOverlays);
    if(indicatorState.fib.active) applyFibonacci(data);
    if(indicatorState.lux.active) applyLuxAlgoSMC(data);
    if(indicatorState.atr.active) applyATRMoreno(data);
}
function applyFibonacci(data) {
    const s = {...defaultSettings.fib, ...indicatorState.fib.settings};
    const len = data.length;
    const lookback = Math.min(len, 60);
    const slice = data.slice(len - lookback);
    let high = -Infinity, low = Infinity, highIdx = 0, lowIdx = 0;
    slice.forEach((d,i)=>{ if(d.high>high){high=d.high; highIdx=i;} if(d.low<low){low=d.low; lowIdx=i;} });
    const diff = high - low;
    const trend = highIdx > lowIdx ? 'up' : 'down';
    const startPrice = trend==='up' ? low : high;
    const startTime = trend==='up' ? slice[lowIdx].time : slice[highIdx].time;
    const endTime = trend==='up' ? slice[highIdx].time : slice[lowIdx].time;
    const colors = ['#00f0ff','#00e676','#ffd700','#ff9100','#ff1744','#b829dd','#2196f3','#9c27b0','#ff5722','#795548','#607d8b','#e91e63'];
    s.levels.forEach((lvl, i) => {
        const price = trend==='up' ? startPrice + diff * lvl : startPrice - diff * lvl;
        if(price <= 0) return;
        const line = window.indicatorChart.addLineSeries({ color: colors[i % colors.length], lineWidth: 1, lastValueVisible: s.showPrices, title: 'Fib '+lvl, priceLineVisible: false });
        const lineData = [];
        if(s.extendLeft) { const first = data[0]; lineData.push({time:first.time, value:price}); }
        lineData.push({time:startTime, value:price}, {time:endTime, value:price});
        if(s.extendRight) { const last = data[data.length-1]; lineData.push({time:last.time, value:price}); }
        line.setData(lineData);
        chartOverlays.fib.push(line);
    });
}
function applyATRMoreno(data) {
    const s = {...defaultSettings.atr, ...indicatorState.atr.settings};
    const len = data.length;
    const per = s.atrPeriod; const cciPer = s.cciPeriod;
    if(len < Math.max(per, cciPer) + 5) return;
    const src = data.map(d => {
        if(s.source==='high') return d.high;
        if(s.source==='low') return d.low;
        if(s.source==='hl2') return (d.high+d.low)/2;
        if(s.source==='ohlc4') return (d.open+d.high+d.low+d.close)/4;
        return d.close;
    });
    const atr = [];
    for(let i=0;i<len;i++){
        if(i===0){atr.push(data[0].high-data[0].low);continue;}
        const tr = Math.max(data[i].high-data[i].low, Math.abs(data[i].high-data[i-1].close), Math.abs(data[i].low-data[i-1].close));
        atr.push(tr);
    }
    const atrSmooth = [];
    for(let i=0;i<len;i++){
        if(i<per){atrSmooth.push(atr[i]);continue;}
        let sum=0; for(let j=0;j<per;j++) sum+=atr[i-j];
        atrSmooth.push(sum/per);
    }
    const cci = [];
    for(let i=0;i<len;i++){
        if(i<cciPer){cci.push(0);continue;}
        let sum=0; for(let j=0;j<cciPer;j++) sum+=src[i-j];
        const ma=sum/cciPer;
        let md=0; for(let j=0;j<cciPer;j++) md+=Math.abs(src[i-j]-ma);
        md=md/cciPer;
        cci.push(md===0?0:(src[i]-ma)/(0.015*md));
    }
    const upLine = [], dnLine = [];
    for(let i=Math.max(per,cciPer);i<len;i++){
        const up = src[i] + atrSmooth[i]*s.multiplier;
        const dn = src[i] - atrSmooth[i]*s.multiplier;
        upLine.push({time:data[i].time, value:up}); dnLine.push({time:data[i].time, value:dn});
    }
    const bull = window.indicatorChart.addLineSeries({ color: s.bullColor, lineWidth: s.lineWidth, lastValueVisible:false, title:'ATR Up' });
    const bear = window.indicatorChart.addLineSeries({ color: s.bearColor, lineWidth: s.lineWidth, lastValueVisible:false, title:'ATR Down' });
    bull.setData(upLine); bear.setData(dnLine);
    chartOverlays.atr.push(bull, bear);
}
function applyLuxAlgoSMC(data) {
    const s = {...defaultSettings.lux, ...indicatorState.lux.settings};
    const len = data.length;
    if(len < 10) return;
    const swings = [];
    const swingSize = 3;
    for(let i=swingSize;i<len-swingSize;i++){
        const isHigh = data[i].high > data[i-1].high && data[i].high > data[i-2].high && data[i].high > data[i+1].high && data[i].high > data[i+2].high;
        const isLow = data[i].low < data[i-1].low && data[i].low < data[i-2].low && data[i].low < data[i+1].low && data[i].low < data[i+2].low;
        if(isHigh) swings.push({time:data[i].time, value:data[i].high, type:'high'});
        if(isLow) swings.push({time:data[i].time, value:data[i].low, type:'low'});
    }
    if(s.showSwing && swings.length >= 2){
        const lineData = swings.map(sw=>({time:sw.time, value:sw.value}));
        const color = s.style==='colored' ? (swings[swings.length-1].type==='high'?s.bearishColor:s.bullishColor) : '#00f0ff';
        const swingLine = window.indicatorChart.addLineSeries({ color: color, lineWidth: 2, lastValueVisible:false, title:'SMC Swing' });
        swingLine.setData(lineData);
        chartOverlays.lux.push(swingLine);
    }
    if(s.showInternal){
        const internal = [];
        const intSize = 2;
        for(let i=intSize;i<len-intSize;i++){
            const isHigh = data[i].high > data[i-1].high && data[i].high > data[i+1].high;
            const isLow = data[i].low < data[i-1].low && data[i].low < data[i+1].low;
            if(isHigh) internal.push({time:data[i].time, value:data[i].high});
            if(isLow) internal.push({time:data[i].time, value:data[i].low});
        }
        if(internal.length >= 2){
            const intLine = window.indicatorChart.addLineSeries({ color: s.bullishColor, lineWidth: 1, lineStyle: 2, lastValueVisible:false, title:'SMC Internal' });
            intLine.setData(internal);
            chartOverlays.lux.push(intLine);
        }
    }
}
function initIndicatorChart() {
    const box = document.getElementById('chartBoxIndicators');
    const cont = document.getElementById('chartContainerIndicators');
    if (!box || !cont || box.clientWidth === 0) return;
    if (window.indicatorChart) { window.indicatorChart.remove(); window.indicatorChart = null; }
    window.indicatorChart = LightweightCharts.createChart(cont, {
        width: cont.clientWidth, height: cont.clientHeight,
        layout: { background: { color: 'transparent' }, textColor: '#6b7280' },
        grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
        timeScale: { timeVisible: true, borderColor: 'rgba(255,255,255,0.06)' },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
        crosshair: { mode: 1, vertLine: { color: '#00f0ff', width: 1, style: 2 }, horzLine: { color: '#00f0ff', width: 1, style: 2 } }
    });
    const series = window.indicatorChart.addCandlestickSeries({
        upColor: '#00e676', downColor: '#ff1744', borderUpColor: '#00e676', borderDownColor: '#ff1744', wickUpColor: '#00e676', wickDownColor: '#ff1744'
    });
    const data = []; let v = 100;
    for (let i = 60; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate()-i);
        const o = v + (Math.random()-0.5)*3;
        const c = o + (Math.random()-0.5)*4;
        const h = Math.max(o,c) + Math.random()*2;
        const l = Math.min(o,c) - Math.random()*2;
        v = c;
        data.push({ time: d.toISOString().split('T')[0], open: +o.toFixed(2), high: +h.toFixed(2), low: +l.toFixed(2), close: +c.toFixed(2) });
    }
    series.setData(data); window.indicatorChart.timeScale().fitContent();
    window.addEventListener('resize', () => { if(window.indicatorChart&&cont)window.indicatorChart.resize(cont.clientWidth,cont.clientHeight); });
}
// ===== REAL MARKET DATA (Supabase — replaces the old fake REAL_PRICES/getLivePrice/fetchYahooData) =====
// أربعة حقول لا مصدر حقيقي لها بعد فعُطِّلت في الواجهة بدل أن تُحاكى: توصية المحللين، Beta،
// Float، مفاجأة الأرباح. حين يتوفر مصدر حقيقي لها لاحقًا، أضِفها لجدول market_fundamentals
// وأعد تفعيل حقول الفلترة المقابلة في index.html (ابحث عن "🚧" هناك).

let _universeCache = null; // { t: timestamp, rows: [...] } لتفادي إعادة الجلب الكامل كل ثانية

function mapMarketRow(fund, tech) {
    const price = tech?.price ?? fund?.price ?? null;
    const sma50 = tech?.sma50 ?? null;
    const sma200 = tech?.sma200 ?? null;
    const growth = fund?.eps_growth_this_year ?? null;
    const ltDebt = fund?.lt_debt_equity ?? null;
    const rsi = tech?.rsi14 ?? null;
    const relVolume = tech?.rel_volume ?? null;
    const relVolume9 = tech?.rel_volume_9 ?? null;
    const hasIssues = EXCLUDED_SYMBOLS.has(fund.symbol) || (ltDebt !== null && ltDebt > 0.5);
    const hasPlan = growth !== null ? growth > 0 : null;

    let score = 0;
    if (price !== null && sma50 !== null && price > sma50) score += 2;
    if (price !== null && sma200 !== null && price > sma200) score += 2;
    if (rsi !== null && rsi > 50 && rsi < 70) score += 1;
    if ((tech?.change_pct ?? 0) > 0) score += 1;
    if ((relVolume ?? 0) > 1.5) score += 1;
    if (growth !== null && growth > 15) score += 1;
    if (ltDebt !== null && ltDebt < 0.3) score += 1;
    const grade = score >= 7 ? 'A' : score >= 5 ? 'B' : score >= 3 ? 'C' : score >= 1 ? 'D' : 'F';

    return {
        symbol: fund.symbol, company: fund.company,
        price, change: tech?.change_pct ?? null,
        volume: tech?.volume ?? 0, avgVolume: tech?.avg_volume ?? 0, avgVolume9: tech?.avg_volume_9 ?? 0, relVolume: relVolume ?? 1, relVolume9: relVolume9 ?? 1,
        sma20: tech?.sma20 ?? null, sma50, sma200, rsi, atr: tech?.atr14 ?? null,
        sector: fund.sector, pe: fund.pe, pb: fund.pb,
        growth, epsNext: fund.eps_growth_next_year, eps5y: fund.eps_growth_5y, epsGrowthQtr: fund.eps_growth_qtr,
        ltDebt, debtRatio: ltDebt,
        perfWeek: tech?.perf_week ?? null,
        hasIssues, hasPlan, missedEarnings: false,
        grade, score,
        // غير مربوطة ببيانات حقيقية بعد (انظر التعليق أعلى الملف) — الفلاتر المقابلة معطّلة بالواجهة
        analystScore: null, beta: null, floatShares: null, earnSurprise: null, revSurprise: null,
    };
}

async function fetchAllRows(table, pageSize=1000) {
    const all = [];
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await sb.from(table).select('*').range(from, from + pageSize - 1);
        if (error) throw error;
        all.push(...(data || []));
        if (!data || data.length < pageSize) break;
    }
    return all;
}
async function fetchUniverse(forceRefresh=false) {
    if (!forceRefresh && _universeCache && Date.now() - _universeCache.t < 5 * 60000) {
        return _universeCache.rows;
    }
    let fundRows, techRows;
    try {
        [fundRows, techRows] = await Promise.all([fetchAllRows('market_fundamentals'), fetchAllRows('market_technicals')]);
    } catch (e) {
        toast('تعذر تحميل بيانات الماسح: ' + (e?.message || ''), 'error'); return [];
    }
    const techMap = Object.fromEntries((techRows || []).map(t => [t.symbol, t]));
    const rows = (fundRows || []).map(f => mapMarketRow(f, techMap[f.symbol])).filter(r => {
        const sector = String(r.sector || '').toLowerCase();
        const liquid = Number(r.price || 0) >= 5 && Number(r.price || 0) <= 50;
        const ordinary = !['finance', 'financial', 'financials', 'reits'].includes(sector);
        const tradable = !EXCLUDED_SYMBOLS.has(String(r.symbol || '').toUpperCase());
        return liquid && ordinary && tradable;
    });
    _universeCache = { t: Date.now(), rows };
    return rows;
}

async function fetchPrice(sym) {
    const { data: live } = await sb.from('live_quotes').select('price').eq('symbol', sym).maybeSingle();
    if (live && live.price != null) return Number(live.price);
    const { data: tech } = await sb.from('market_technicals').select('price').eq('symbol', sym).maybeSingle();
    return tech && tech.price != null ? Number(tech.price) : null;
}
// ===== LIVE STOCKS TAB (now: live_quotes for price, market_technicals for signal context) =====
async function runScanner() {
    document.getElementById('lastUpdate').textContent = 'جاري التحديث...';
    const tb = document.getElementById('stockTableBody');
    tb.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:30px;">جاري تحميل البيانات...</td></tr>';

    const { data: liveRows } = await sb.from('live_quotes').select('*').in('symbol', LIVE_TRACKED);
    const universe = await fetchUniverse();
    const universeMap = Object.fromEntries(universe.map(r => [r.symbol, r]));
    const liveMap = Object.fromEntries((liveRows || []).map(r => [r.symbol, r]));

    const bannedSectors = new Set(['finance', 'financial', 'financials', 'healthcare', 'energy', 'reits']);
    const results = LIVE_TRACKED.map(sym => {
        const base = universeMap[sym];
        const live = liveMap[sym];
        if (!base && !live) return null;
        const price = live?.price ?? base?.price ?? null;
        if (price == null || price < 5 || price > 50) return null;
        const change = live?.change_pct ?? base?.change ?? null;
        const volume = live?.volume ?? base?.volume ?? null;
        if (price == null) return null;
        return { symbol: sym, price, change: change ?? 0, volume: volume ?? 0,
                 rsi: base?.rsi ?? null, sma50: base?.sma50 ?? null, sma200: base?.sma200 ?? null,
                 sector: base?.sector ?? 'other' };
    }).filter(d => d && !bannedSectors.has(d.sector));

    let html = '';
    results.forEach(d => {
        let sig = 'متابعة', cls = 'badge-hold';
        if (d.rsi != null && d.rsi < 30 && d.change > 0) { sig = 'شراء قوي'; cls = 'badge-strong-buy'; }
        else if (d.rsi != null && d.rsi > 70 && d.change < 0) { sig = 'بيع قوي'; cls = 'badge-strong-sell'; }
        else if (d.sma50 != null && d.sma200 != null && d.price > d.sma50 && d.price > d.sma200 && d.change > 2) { sig = 'دخول'; cls = 'badge-buy'; }
        else if (d.sma50 != null && d.sma200 != null && d.price < d.sma50 && d.price < d.sma200 && d.change < -2) { sig = 'خروج'; cls = 'badge-sell'; }
        const vf = d.volume >= 1000000 ? (d.volume/1000000).toFixed(2)+'M' : (d.volume/1000).toFixed(1)+'K';
        const rsiTxt = d.rsi != null ? d.rsi.toFixed(1) : '—';
        html += `<tr><td><div class="sym">${d.symbol}</div></td><td class="font-mono">$${d.price.toFixed(2)}</td><td class="font-mono ${d.change>=0?'text-green':'text-red'}">${d.change>=0?'+':''}${d.change.toFixed(2)}%</td><td class="font-mono text-muted">${vf}</td><td class="font-mono">${rsiTxt}</td><td><span class="badge ${cls}">${sig}</span></td><td><span style="color:var(--accent-cyan);cursor:pointer;font-size:16px;" onclick="quickAdd('${d.symbol}',${d.price})">+</span></td></tr>`;
    });
    tb.innerHTML = html || '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:30px;">لا بيانات بعد — تحقق أن Actions البيانات عملت مرة واحدة على الأقل</td></tr>';
    document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString('ar-SA');
}

let signalRealtimeChannel = null;
function subscribeSignalRealtime() {
    if (signalRealtimeChannel) return;
    signalRealtimeChannel = sb.channel('az-alpha-signal-realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'screener_alerts' }, () => {
            SIGNALS_CACHE_AT = 0;
            loadSignalsData(true);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'screener_signals' }, () => {
            SIGNALS_CACHE_AT = 0;
            loadSignalsData(true);
        })
        .subscribe((status) => {
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                console.warn('Realtime غير متاح؛ سيستمر التحديث الدوري كل 15 ثانية.');
            }
        });
}


function quickAdd(sym, price) {
    document.getElementById('addSymbolInput').value = sym;
    document.getElementById('addEntryPrice').value = price.toFixed(2);
    switchTab('stocks');
    toast(`تم تحديد ${sym} — اضغط إضافة`);
}

// ===== SCREENER (826 stock universe — one bulk query instead of per-ticker batches) =====
async function runScreener() {
    if (isScanning) return;
    isScanning = true;
    const btn = document.getElementById('scanBtn'); btn.disabled = true; btn.textContent = '⏳ جاري الفلترة...';

    const filters = {
        price: document.getElementById('fPrice').value,
        change: document.getElementById('fChange').value, sector: document.getElementById('fSector').value,
        rsi: document.getElementById('fRSI').value, sma50: document.getElementById('fSMA50').value,
        sma200: document.getElementById('fSMA200').value, grade: document.getElementById('fGrade').value,
        relVol: document.getElementById('fRelVol').value, limit: parseInt(document.getElementById('fLimit').value),
        pb: document.getElementById('fPB').value, epsGrowth: document.getElementById('fEPSGrowth').value,
        epsNext: document.getElementById('fEPSNext').value, eps5y: document.getElementById('fEPS5Y').value,
        ltDebt: document.getElementById('fLTDebt').value, perfWeek: document.getElementById('fPerfWeek').value,
        sma20: document.getElementById('fSMA20').value, curVol: document.getElementById('fCurVol').value,
    };

    const tb = document.getElementById('screenerTableBody');
    const bar = document.getElementById('scanBar'); const track = document.getElementById('scanProgress'); const meta = document.getElementById('scanMeta');
    tb.innerHTML = '<tr><td colspan="13" style="text-align:center;color:var(--text-muted);padding:40px;">⏳ جاري التحميل من قاعدة البيانات...</td></tr>';
    track.classList.add('active'); bar.style.width = '40%';

    const universe = await fetchUniverse();
    bar.style.width = '80%';

    const filtered = universe.filter(d => {
        if (d.price == null) return false;
        if (d.sector === 'healthcare' || d.sector === 'energy' || d.sector === 'reits') return false;
        if (d.hasIssues) return false;
        if (d.hasPlan === false) return false;

        if (filters.price !== 'any') {
            if (filters.price === '5to50' && (d.price < 5 || d.price > 50)) return false;
            if (filters.price === 'under5' && d.price >= 5) return false;
            if (filters.price === '5to20' && (d.price < 5 || d.price > 20)) return false;
            if (filters.price === '20to50' && (d.price < 20 || d.price > 50)) return false;
            if (filters.price === '50to100' && (d.price < 50 || d.price > 100)) return false;
            if (filters.price === 'over100' && d.price <= 100) return false;
        }
        if (filters.change !== 'any' && d.change != null) {
            if (filters.change === 'up' && d.change <= 0) return false;
            if (filters.change === 'up3' && d.change < 3) return false;
            if (filters.change === 'up5' && d.change < 5) return false;
            if (filters.change === 'down' && d.change >= 0) return false;
        }
        if (filters.sector !== 'any' && d.sector !== filters.sector) return false;
        if (filters.rsi !== 'any' && d.rsi != null) {
            if (filters.rsi === 'oversold' && d.rsi >= 30) return false;
            if (filters.rsi === 'neutral' && (d.rsi < 30 || d.rsi > 70)) return false;
            if (filters.rsi === 'overbought' && d.rsi <= 70) return false;
        }
        if (filters.sma50 !== 'any' && d.sma50 != null) {
            if (filters.sma50 === 'above' && d.price <= d.sma50) return false;
            if (filters.sma50 === 'below' && d.price >= d.sma50) return false;
        }
        if (filters.sma200 !== 'any' && d.sma200 != null) {
            if (filters.sma200 === 'above' && d.price <= d.sma200) return false;
            if (filters.sma200 === 'below' && d.price >= d.sma200) return false;
        }
        if (filters.sma20 !== 'any' && d.sma20 != null) {
            if (filters.sma20 === 'above' && d.price <= d.sma20) return false;
            if (filters.sma20 === 'below' && d.price >= d.sma20) return false;
        }
        const relVol = Number(d.relVolume ?? 0);
        if (filters.relVol !== 'any') {
            const t = { over1:1, over2:2, over3:3 };
            if (relVol < t[filters.relVol]) return false;
        }
        if (filters.pb !== 'any' && d.pb != null) {
            if (filters.pb === 'under1' && d.pb >= 1) return false;
            if (filters.pb === '1to3' && (d.pb < 1 || d.pb > 3)) return false;
            if (filters.pb === '3to5' && (d.pb < 3 || d.pb > 5)) return false;
            if (filters.pb === 'over5' && d.pb <= 5) return false;
        }
        if (filters.epsGrowth !== 'any' && d.growth != null) {
            const min = { over15:15, over30:30, over50:50 }[filters.epsGrowth];
            if (d.growth <= min) return false;
        }
        if (filters.epsNext !== 'any' && d.epsNext != null) {
            const min = { over15:15, over30:30, over50:50 }[filters.epsNext];
            if (d.epsNext <= min) return false;
        }
        if (filters.eps5y !== 'any' && d.eps5y != null) {
            const min = { over15:15, over30:30 }[filters.eps5y];
            if (d.eps5y <= min) return false;
        }
        if (filters.ltDebt !== 'any' && d.ltDebt != null) {
            if (filters.ltDebt === 'under0.3' && d.ltDebt >= 0.3) return false;
            if (filters.ltDebt === 'under0.6' && d.ltDebt >= 0.6) return false;
            if (filters.ltDebt === 'under1' && d.ltDebt >= 1) return false;
            if (filters.ltDebt === 'over1' && d.ltDebt <= 1) return false;
        }
        if (filters.perfWeek !== 'any' && d.perfWeek != null) {
            if (filters.perfWeek === 'up' && d.perfWeek <= 0) return false;
            if (filters.perfWeek === 'up5' && d.perfWeek < 5) return false;
            if (filters.perfWeek === 'up10' && d.perfWeek < 10) return false;
            if (filters.perfWeek === 'down' && d.perfWeek >= 0) return false;
        }
        if (filters.curVol !== 'any') {
            const t = { over100k:100000, over500k:500000, over1m:1000000, over5m:5000000 };
            if ((d.volume ?? 0) < t[filters.curVol]) return false;
        }
        if (filters.grade !== 'any') {
            if (filters.grade === 'a' && d.grade !== 'A') return false;
            if (filters.grade === 'ab' && d.grade !== 'A' && d.grade !== 'B') return false;
            if (filters.grade === 'abc' && !['A','B','C'].includes(d.grade)) return false;
        }
        return true;
    });

    filtered.sort((a,b) => b.score - a.score || (b.change ?? 0) - (a.change ?? 0));
    screenerResults = filtered.slice(0, filters.limit);
    LocalCache.setScreener({ t: Date.now(), r: screenerResults });

    bar.style.width = '100%';
    setTimeout(() => track.classList.remove('active'), 300);
    btn.disabled = false; btn.textContent = '🔍 بدء الفلترة';
    meta.innerHTML = `<span>إجمالي القاعدة: ${universe.length}</span><span class="text-green">النتائج: ${screenerResults.length}</span>`;
    renderScreener();
    toast(`✅ ${screenerResults.length} سهم مطابق`);
    isScanning = false;
}

function renderScreener() {
    const tb = document.getElementById('screenerTableBody'); tb.innerHTML = '';
    if (!screenerResults.length) { tb.innerHTML = '<tr><td colspan="13" style="text-align:center;color:var(--text-muted);padding:40px;">لا توجد نتائج</td></tr>'; return; }
    const sn = { tech:'تكنولوجيا', finance:'مالي', healthcare:'صحية', consumer:'استهلاكي', industrial:'صناعي', energy:'طاقة', reits:'عقارات', other:'أخرى' };
    screenerResults.forEach((d,i) => {
        let sig = 'متابعة', cls = 'badge-hold';
        if (d.rsi != null && d.rsi < 30 && d.change > 0) { sig = 'شراء'; cls = 'badge-strong-buy'; }
        else if (d.rsi != null && d.rsi > 70 && d.change < 0) { sig = 'بيع'; cls = 'badge-strong-sell'; }
        else if (d.sma50 != null && d.sma200 != null && d.price > d.sma50 && d.price > d.sma200 && d.change > 2) { sig = 'دخول'; cls = 'badge-buy'; }
        else if (d.sma50 != null && d.sma200 != null && d.price < d.sma50 && d.price < d.sma200 && d.change < -2) { sig = 'خروج'; cls = 'badge-sell'; }
        const vf = (d.volume ?? 0) >= 1000000 ? (d.volume/1000000).toFixed(2)+'M' : ((d.volume ?? 0)/1000).toFixed(1)+'K';
        const gc = d.grade==='A'?'badge-a':d.grade==='B'?'badge-b':d.grade==='C'?'badge-c':d.grade==='D'?'badge-d':'badge-f';
        const debtColor = d.ltDebt == null ? 'text-muted' : d.ltDebt < 0.3 ? 'text-green' : d.ltDebt < 0.5 ? 'text-gold' : 'text-red';
        tb.innerHTML += `<tr><td class="font-mono">${i+1}</td><td><div class="sym">${d.symbol}</div><div class="sym-sub">${escapeHtml(d.company||'')}</div></td><td class="font-mono">$${d.price.toFixed(2)}</td><td class="font-mono ${(d.change??0)>=0?'text-green':'text-red'}">${(d.change??0)>=0?'+':''}${(d.change??0).toFixed(2)}%</td><td class="font-mono text-muted">${vf}</td><td>${sn[d.sector]||d.sector}</td><td class="font-mono">${d.rsi!=null?d.rsi.toFixed(1):'—'}</td><td class="font-mono text-cyan">${d.growth!=null?d.growth.toFixed(1)+'%':'—'}</td><td class="font-mono">${d.pe!=null?d.pe.toFixed(1):'—'}</td><td class="font-mono ${debtColor}">${d.ltDebt!=null?(d.ltDebt*100).toFixed(1)+'%':'—'}</td><td><span class="badge ${gc}">${d.grade}</span></td><td><span class="badge ${cls}">${sig}</span></td><td><span style="color:var(--accent-cyan);cursor:pointer;font-size:16px;" onclick="quickAdd('${d.symbol}',${d.price})">+</span></td></tr>`;
    });
}

function clearScreener() {
    ['fPrice','fChange','fSector','fRSI','fSMA50','fSMA200','fGrade','fPB','fEPSGrowth','fEPSNext','fEPS5Y','fLTDebt','fPerfWeek','fSMA20','fCurVol'].forEach(id=>{
        const el = document.getElementById(id); if (el) el.value = 'any';
    });
    const relVolEl = document.getElementById('fRelVol'); if (relVolEl) relVolEl.value = 'any';
    const priceEl = document.getElementById('fPrice'); if (priceEl) priceEl.value = '5to50';
    document.getElementById('fLimit').value='100';
    document.getElementById('screenerTableBody').innerHTML='<tr><td colspan="13" style="text-align:center;color:var(--text-muted);padding:40px;">اضغط "بدء الفلترة" للبحث</td></tr>';
    document.getElementById('scanMeta').innerHTML='';
    toast('🗑️ تم مسح الفلاتر');
}

function loadPreset(p) {
    const presets = {
        growth: { price:'5to20', volume:'over300k', change:'up', sector:'any', rsi:'neutral', sma50:'above', sma200:'above', grade:'ab', relVol:'over1', limit:'100', pb:'any', epsGrowth:'over15', epsNext:'over15', eps5y:'any', ltDebt:'under0.6', perfWeek:'any', sma20:'any', curVol:'any' },
        value: { price:'under5', volume:'over100k', change:'any', sector:'any', rsi:'oversold', sma50:'any', sma200:'any', grade:'any', relVol:'any', limit:'100', pb:'under1', epsGrowth:'any', epsNext:'any', eps5y:'any', ltDebt:'under0.6', perfWeek:'any', sma20:'any', curVol:'any' },
        momentum: { price:'5to20', volume:'over500k', change:'up5', sector:'any', rsi:'neutral', sma50:'above', sma200:'above', grade:'a', relVol:'over2', limit:'100', pb:'any', epsGrowth:'over30', epsNext:'over30', eps5y:'any', ltDebt:'any', perfWeek:'up5', sma20:'above', curVol:'over500k' },
        breakout: { price:'5to20', volume:'over1m', change:'up3', sector:'any', rsi:'neutral', sma50:'above', sma200:'below', grade:'ab', relVol:'over2', limit:'100', pb:'any', epsGrowth:'over15', epsNext:'any', eps5y:'any', ltDebt:'any', perfWeek:'up10', sma20:'above', curVol:'over1m' },
        swing: { price:'5to20', volume:'over300k', change:'any', sector:'any', rsi:'oversold', sma50:'below', sma200:'any', grade:'ab', relVol:'over1', limit:'100', pb:'any', epsGrowth:'over15', epsNext:'over15', eps5y:'any', ltDebt:'under0.6', perfWeek:'down', sma20:'below', curVol:'any' },
        dividend: { price:'20to50', volume:'over300k', change:'any', sector:'any', rsi:'neutral', sma50:'above', sma200:'above', grade:'ab', relVol:'any', limit:'100', pb:'any', epsGrowth:'any', epsNext:'any', eps5y:'any', ltDebt:'under0.3', perfWeek:'any', sma20:'above', curVol:'any' },
        penny: { price:'under5', volume:'over100k', change:'up', sector:'any', rsi:'any', sma50:'any', sma200:'any', grade:'any', relVol:'over1', limit:'100', pb:'any', epsGrowth:'any', epsNext:'any', eps5y:'any', ltDebt:'any', perfWeek:'up', sma20:'any', curVol:'over100k' },
        opp_buy_dip: { price:'20to50', volume:'over300k', change:'down', sector:'any', rsi:'oversold', sma50:'below', sma200:'above', grade:'ab', relVol:'over1', limit:'100', pb:'1to3', epsGrowth:'over15', epsNext:'over15', eps5y:'over15', ltDebt:'under0.6', perfWeek:'down', sma20:'below', curVol:'any' },
        opp_earnings: { price:'any', volume:'over300k', change:'up3', sector:'any', rsi:'neutral', sma50:'above', sma200:'any', grade:'a', relVol:'over2', limit:'100', pb:'any', epsGrowth:'over30', epsNext:'over30', eps5y:'over15', ltDebt:'under0.6', perfWeek:'up5', sma20:'above', curVol:'over500k' },
        opp_low_float: { price:'5to20', volume:'over500k', change:'up', sector:'any', rsi:'any', sma50:'any', sma200:'any', grade:'any', relVol:'over2', limit:'100', pb:'any', epsGrowth:'any', epsNext:'any', eps5y:'any', ltDebt:'any', perfWeek:'up', sma20:'any', curVol:'over500k' },
        opp_analyst: { price:'any', volume:'over300k', change:'up', sector:'any', rsi:'neutral', sma50:'above', sma200:'above', grade:'a', relVol:'over1', limit:'100', pb:'any', epsGrowth:'over15', epsNext:'over15', eps5y:'over15', ltDebt:'under0.6', perfWeek:'up', sma20:'above', curVol:'any' },
        opp_debt_free: { price:'any', volume:'over100k', change:'any', sector:'any', rsi:'any', sma50:'any', sma200:'any', grade:'ab', relVol:'any', limit:'100', pb:'any', epsGrowth:'over15', epsNext:'over15', eps5y:'over15', ltDebt:'under0.3', perfWeek:'any', sma20:'any', curVol:'any' },
        opp_undervalued: { price:'under5', volume:'over100k', change:'any', sector:'any', rsi:'oversold', sma50:'below', sma200:'below', grade:'any', relVol:'any', limit:'100', pb:'under1', epsGrowth:'over15', epsNext:'over15', eps5y:'over15', ltDebt:'under0.6', perfWeek:'down', sma20:'below', curVol:'any' },
        opp_tech_bounce: { price:'5to20', volume:'over500k', change:'up3', sector:'tech', rsi:'oversold', sma50:'below', sma200:'above', grade:'ab', relVol:'over2', limit:'100', pb:'any', epsGrowth:'over30', epsNext:'over30', eps5y:'over15', ltDebt:'under0.6', perfWeek:'up5', sma20:'below', curVol:'over500k' }
    };
    const s = presets[p]; if(!s) return;
    Object.entries(s).forEach(([key, val]) => {
        const idMap = { price:'fPrice', volume:'fVolume', change:'fChange', sector:'fSector', rsi:'fRSI', sma50:'fSMA50', sma200:'fSMA200', grade:'fGrade', relVol:'fRelVol', limit:'fLimit', pb:'fPB', epsGrowth:'fEPSGrowth', epsNext:'fEPSNext', eps5y:'fEPS5Y', ltDebt:'fLTDebt', perfWeek:'fPerfWeek', sma20:'fSMA20', curVol:'fCurVol' };
        const el = document.getElementById(idMap[key]);
        if (el) el.value = val;
    });
    const names = {growth:'نمو',value:'قيمة',momentum:'زخم',breakout:'اختراق',swing:'سوينج',dividend:'توزيعات',penny:'Penny',
        opp_buy_dip:'شراء التراجع',opp_earnings:'مفاجأة أرباح',opp_low_float:'Float منخفض',
        opp_analyst:'توصية محللين',opp_debt_free:'خالٍ من الديون',opp_undervalued:'أقل من قيمته',opp_tech_bounce:'ارتداد تقني'};
    toast(`✅ فلتر ${names[p]||p} محمل — جاري الفلترة...`);
    setTimeout(()=>runScreener(), 200);
}

// ===== WEEKLY PICKS =====
async function runWeeklyScan() {
    const tb = document.getElementById('picksTableBody');
    tb.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:40px;">🔄 جاري الترشيح من قاعدة البيانات...</td></tr>';

    const universe = await fetchUniverse();
    const candidates = universe.filter(d =>
        d.price != null && d.price >= 5 && d.price <= 50 &&
        !['finance','financial','financials','healthcare','energy','reits'].includes(d.sector) &&
        (d.sma50 == null || d.price <= d.sma50 * 0.8) &&
        d.growth != null && d.growth > 0 &&
        !d.hasIssues && d.hasPlan !== false
    );

    candidates.forEach(d => {
        let score = 0;
        if (d.sma50!=null && d.price>d.sma50) score+=2;
        if (d.sma200!=null && d.price>d.sma200) score+=2;
        if (d.rsi!=null && d.rsi>40 && d.rsi<60) score+=1;
        if ((d.change??0)>0) score+=1;
        if ((d.relVolume??0)>1) score+=1;
        if (d.ltDebt!=null && d.ltDebt<0.3) score+=2;
        if (d.growth!=null && d.growth>15) score+=2;
        if (d.pe!=null && d.pe>5 && d.pe<25) score+=1;
        if (d.growth!=null && d.pe!=null && d.growth>d.pe) score+=1;
        if (d.pb!=null && d.pb<3) score+=1;
        d.pickScore = score;
    });

    candidates.sort((a,b)=>b.pickScore-a.pickScore);
    const top = candidates.slice(0,10);

    tb.innerHTML = '';
    if (!top.length) {
        LocalCache.setPicks([]);
        document.getElementById('sitePicksCount').textContent = '0';
        document.getElementById('siteAvgReturn').textContent = '0.00%';
        document.getElementById('siteWinRate').textContent = '0%';
        document.getElementById('sitePicksDesc').textContent = 'لا توجد ترشيحات تحقق شروط السعر وSMA50 وفلاتر Finviz الحالية.';
        tb.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:40px;">❌ لا توجد ترشيحات مطابقة لشروط 5–50 وSMA50 وفلاتر Finviz</td></tr>';
        toast('لم توجد ترشيحات مطابقة للشروط الحالية', 'warn');
        return;
    }

    const pickData = top.map(s => ({ symbol: s.symbol, price: s.price, date: new Date().toISOString().split('T')[0], score: s.pickScore }));
    LocalCache.setPicks(pickData);
    updateSitePerformance();

    const sn = { tech:'تكنولوجيا', finance:'مالي', healthcare:'صحية', consumer:'استهلاكي', industrial:'صناعي', energy:'طاقة', reits:'عقارات', other:'أخرى' };
    top.forEach((s,i) => {
        const grade = s.pickScore>=10?'⭐ ممتاز':s.pickScore>=7?'✅ جيد':'📊 مقبول';
        const gc = s.pickScore>=10?'var(--accent-green)':s.pickScore>=7?'var(--accent-cyan)':'var(--accent-gold)';
        tb.innerHTML += `<tr><td class="font-mono">${i+1}</td><td><div class="sym">${s.symbol}</div></td><td class="font-mono">$${s.price.toFixed(2)}</td><td>${sn[s.sector]||s.sector}</td><td class="font-mono ${s.ltDebt!=null&&s.ltDebt<0.3?'text-green':'text-gold'}">${s.ltDebt!=null?(s.ltDebt*100).toFixed(1)+'%':'—'}</td><td class="font-mono text-cyan">${s.growth!=null?s.growth.toFixed(1)+'%':'—'}</td><td class="font-mono text-green">${s.growth!=null?s.growth.toFixed(1)+'%':'—'}</td><td><span style="background:${gc};color:#000;padding:4px 12px;border-radius:12px;font-weight:700;font-size:11px;">${grade}</span></td></tr>`;
    });
    toast(`✅ ${top.length} ترشيح أسبوعي`);
}

async function updateSitePerformance() {
    const picks = LocalCache.getPicks();
    if (!picks) return;
    document.getElementById('sitePicksCount').textContent = picks.length;

    const prices = await Promise.all(picks.map(p => fetchPrice(p.symbol)));
    let totalReturn = 0, wins = 0, counted = 0;
    picks.forEach((p, i) => {
        const current = prices[i];
        if (current == null) return;
        const ret = ((current - p.price) / p.price) * 100;
        totalReturn += ret; counted++;
        if (ret > 0) wins++;
    });
    const avgReturn = counted > 0 ? totalReturn / counted : 0;
    const winRate = counted > 0 ? (wins / counted) * 100 : 0;

    const avgEl = document.getElementById('siteAvgReturn');
    avgEl.textContent = (avgReturn >= 0 ? '+' : '') + avgReturn.toFixed(2) + '%';
    avgEl.className = 'val ' + (avgReturn >= 0 ? 'pos' : 'neg');
    document.getElementById('siteWinRate').textContent = winRate.toFixed(0) + '%';
    document.getElementById('sitePicksDesc').innerHTML = `
        <strong style="color:var(--accent-cyan);">📅 آخر تحديث:</strong> ${picks[0]?.date || '--'}<br>
        العائد محسوب من سعر الترشيح إلى آخر سعر حقيقي متوفر
    `;
}

// ===== 🎯 الماسح والتنبيهات (محرك التوافق الحقيقي — من نفس بيانات Supabase) =====
let SIGNALS_CACHE = null, SIGNALS_ALERTS = null, SIGNALS_PERF = null, SIGNALS_CACHE_AT = 0;
let signalChartInstance = null;

const SIG_TIER_COLOR = { 'صريح': 'badge-strong-buy', 'أقوى': 'badge-buy', 'أولي': 'badge-hold' };
const SIG_TIER_COLOR_EXIT = { 'صريح': 'badge-strong-sell', 'أقوى': 'badge-sell', 'أولي': 'badge-hold' };
const SIG_LABEL = { fibonacci: 'فيبوناتشي', smc_atr: 'SMC+ATR', candlestick: 'شمعة', volume: 'حجم' };
const SIG_PRESET_LABEL = { military: 'العسكري', quality_value: 'قيمة ونوعية', growth: 'نمو-Float', growth_beta: 'نمو-Beta' };
let signalAudioContext = null;
function playSignalAlertSound() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    try {
        signalAudioContext ||= new AudioCtx();
        if (signalAudioContext.state === 'suspended') signalAudioContext.resume();
        const now = signalAudioContext.currentTime;
        [0, 0.18, 0.36].forEach((offset, i) => {
            const oscillator = signalAudioContext.createOscillator();
            const gain = signalAudioContext.createGain();
            oscillator.type = 'sine';
            oscillator.frequency.value = i === 2 ? 1046 : 880;
            gain.gain.setValueAtTime(0.0001, now + offset);
            gain.gain.exponentialRampToValueAtTime(0.16, now + offset + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.14);
            oscillator.connect(gain).connect(signalAudioContext.destination);
            oscillator.start(now + offset);
            oscillator.stop(now + offset + 0.15);
        });
    } catch (e) { console.warn('تعذر تشغيل صوت التنبيه', e); }
}
function playNewSignalAlertSound(alerts) {
    const latest = alerts?.[0];
    if (!latest) return;
    const key = String(latest.id || `${latest.ts}:${latest.symbol}:${latest.type}`);
    const previous = localStorage.getItem('az_last_signal_alert');
    localStorage.setItem('az_last_signal_alert', key);
    const age = Date.now() - new Date(latest.ts).getTime();
    if (previous !== key && age >= 0 && age < 15 * 60 * 1000) playSignalAlertSound();
}

function sigEsc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function loadSignalsData(force = false) {
    if (!force && SIGNALS_CACHE && Date.now() - SIGNALS_CACHE_AT < 10 * 1000) return; // احتياطي سريع عند تعذر أحداث Realtime
    const meta = document.getElementById('signalsMeta');
    meta.innerHTML = 'جاري التحميل من قاعدة البيانات...';
    try {
        const [{ data: sig, error: e1 }, { data: alerts, error: e2 }, { data: perf, error: e3 }] = await Promise.all([
            sb.from('screener_signals').select('*'),
            sb.from('screener_alerts').select('*').order('ts', { ascending: false }).limit(100),
            sb.from('screener_performance').select('*'),
        ]);
        if (e1) throw e1;
        const blocked = new Set(['DDV']);
        SIGNALS_CACHE = (sig || []).filter(s => !blocked.has(String(s.symbol || '').toUpperCase()));
        SIGNALS_ALERTS = (alerts || []).filter(a => !blocked.has(String(a.symbol || '').toUpperCase()));
        playNewSignalAlertSound(SIGNALS_ALERTS);
        SIGNALS_PERF = perf || [];
        SIGNALS_CACHE_AT = Date.now();
        meta.innerHTML = `آخر تحديث: <span>${SIGNALS_CACHE[0] ? new Date(SIGNALS_CACHE[0].updated_at).toLocaleString('ar-SA') : '--'}</span> — اختر فلترًا لعرض النتائج`;
        renderSignalAlerts();
        renderSignalPerformance('month');
    } catch (err) {
        meta.innerHTML = "<b style='color:var(--accent-red);'>تعذر تحميل بيانات الماسح — تأكد أن fetch_screener_signals.py عمل مرة واحدة على الأقل.</b>";
        console.error(err);
    }
}

function runSignalScan(presetKey) {
    if (!SIGNALS_CACHE) return;
    const stocks = SIGNALS_CACHE
        .filter(s => s.preset === presetKey)
        .sort((a, b) => (b.entry_score || 0) - (a.entry_score || 0));

    document.getElementById('signalsMeta').innerHTML = `${SIG_PRESET_LABEL[presetKey] || presetKey} — أسهم بإشارة تنبيه: <span>${stocks.length}</span>`;
    renderSignalsTable(stocks);
}

function sigDots(signals, isEntry) {
    if (!signals) return '';
    return Object.entries(signals).map(([k, on]) =>
        `<span title="${SIG_LABEL[k] || k}" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-left:3px;background:${on ? (isEntry ? 'var(--accent-green)' : 'var(--accent-red)') : 'var(--text-dim)'};"></span>`
    ).join('');
}

function renderSignalsTable(stocks) {
    const tb = document.getElementById('signalsTableBody');
    if (!stocks.length) {
        tb.innerHTML = '<tr><td colspan="7" class="text-muted" style="text-align:center;padding:30px;">لا أسهم بلغت أولي (2/4 إشارات) ضمن هذا الفلتر حاليًا</td></tr>';
        return;
    }
    tb.innerHTML = stocks.map(s => {
        const entryBadge = s.entry_tier ? `<span class="badge ${SIG_TIER_COLOR[s.entry_tier]}">دخول ${s.entry_tier} (${s.entry_score}/4)</span>` : '<span class="text-muted">—</span>';
        const exitBadge = s.exit_tier ? `<span class="badge ${SIG_TIER_COLOR_EXIT[s.exit_tier]}">خروج ${s.exit_tier} (${s.exit_score}/4)</span>` : '<span class="text-muted">—</span>';
        return `<tr>
            <td class="sym">${sigEsc(s.symbol)}</td>
            <td>${sigEsc(s.company)}</td>
            <td class="font-mono">$${Number(s.price).toFixed(2)}</td>
            <td class="font-mono">${s.pe != null ? Number(s.pe).toFixed(1) : '—'}</td>
            <td>${entryBadge}<div style="margin-top:4px;">${sigDots(s.entry_signals, true)}</div></td>
            <td>${exitBadge}<div style="margin-top:4px;">${sigDots(s.exit_signals, false)}</div></td>
            <td><button class="btn-ind" onclick="openSignalChart('${sigEsc(s.symbol)}')">📈</button></td>
        </tr>`;
    }).join('');
}

function renderSignalAlerts() {
    const tb = document.getElementById('signalsAlertsBody');
    if (!SIGNALS_ALERTS || !SIGNALS_ALERTS.length) {
        tb.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:20px;">لا تنبيهات مسجّلة بعد</td></tr>';
        return;
    }
    tb.innerHTML = SIGNALS_ALERTS.map(a => {
        const isEntry = a.type === 'entry';
        const badge = isEntry ? SIG_TIER_COLOR[a.tier] : SIG_TIER_COLOR_EXIT[a.tier];
        return `<tr>
            <td class="text-muted" style="font-size:11px;">${new Date(a.ts).toLocaleString('ar-SA')}</td>
            <td class="sym">${sigEsc(a.symbol)}</td>
            <td style="font-size:11px;">${SIG_PRESET_LABEL[a.preset] || sigEsc(a.preset)}</td>
            <td><span class="badge ${badge}">${isEntry ? 'دخول' : 'خروج'} ${a.tier} (${a.score}/4)</span></td>
            <td class="font-mono">$${Number(a.price).toFixed(2)}</td>
        </tr>`;
    }).join('');
}

function renderSignalPerformance(granularity) {
    document.querySelectorAll('[id^="sigPerfTab_"]').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('sigPerfTab_' + granularity);
    if (btn) btn.classList.add('active');

    const container = document.getElementById('signalPerformanceBody');
    if (!SIGNALS_PERF) { container.innerHTML = ''; return; }
    const rows = SIGNALS_PERF.filter(p => p.granularity === granularity).sort((a, b) => a.period.localeCompare(b.period));

    if (!rows.length) {
        container.innerHTML = `<p class="text-muted" style="text-align:center;padding:20px;">لا صفقات مُقفلة بعد لعرض أداء ${granularity === 'month' ? 'شهري' : granularity === 'quarter' ? 'ربعي' : granularity === 'half' ? 'نصف سنوي' : 'سنوي'} — تتراكم مع كل تشغيل مجدول.</p>`;
        return;
    }
    container.innerHTML = `
        <table class="data-table">
            <thead><tr><th>الفترة</th><th>الصفقات</th><th>نسبة الربح</th><th>متوسط العائد</th><th>الإجمالي</th></tr></thead>
            <tbody>${rows.map(r => {
                const cls = r.total_return_pct >= 0 ? 'text-green' : 'text-red';
                return `<tr><td class="font-mono">${r.period}</td><td>${r.trades}</td><td>${r.win_rate}%</td><td class="${cls}">${r.avg_return_pct >= 0 ? '+' : ''}${r.avg_return_pct}%</td><td class="${cls} font-mono">${r.total_return_pct >= 0 ? '+' : ''}${r.total_return_pct}%</td></tr>`;
            }).join('')}</tbody>
        </table>`;
}

async function openSignalChart(symbol) {
    const modal = document.getElementById('signalChartModal');
    const title = document.getElementById('signalChartTitle');
    const cont = document.getElementById('signalChartContainer');
    title.textContent = symbol + ' — الفاصل اليومي';
    modal.classList.add('active');
    cont.innerHTML = '';

    const { data, error } = await sb.from('screener_charts').select('data').eq('symbol', symbol).maybeSingle();
    if (error || !data || !data.data || !data.data.length) {
        cont.innerHTML = '<p class="text-muted" style="text-align:center;padding:40px;">لا بيانات شارت محفوظة لهذا الرمز بعد.</p>';
        return;
    }
    if (signalChartInstance) { signalChartInstance.remove(); signalChartInstance = null; }
    signalChartInstance = LightweightCharts.createChart(cont, {
        width: cont.clientWidth, height: 360,
        layout: { background: { color: 'transparent' }, textColor: '#6b7280' },
        grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
        timeScale: { borderColor: 'rgba(255,255,255,0.06)' },
    });
    const series = signalChartInstance.addCandlestickSeries({
        upColor: '#00e676', downColor: '#ff1744', borderUpColor: '#00e676', borderDownColor: '#ff1744',
        wickUpColor: '#00e676', wickDownColor: '#ff1744'
    });
    series.setData(data.data.map(([time, open, high, low, close]) => ({ time, open, high, low, close })));
    signalChartInstance.timeScale().fitContent();
}


// ===== EDUCATION, SIMULATION CONSENT & 60-DAY TRIAL =====
const TRIAL_DAYS = 60;
function ensureEducationConsent() {
    const key = `az_education_consent_${currentUser?.id || 'guest'}`;
    if (localStorage.getItem(key) === 'accepted') return true;
    const modal = document.getElementById('educationDisclaimerModal');
    if (modal) modal.classList.add('active');
    return false;
}
async function acceptEducationConsent() {
    const age = document.getElementById('consentAge18')?.checked;
    const simulation = document.getElementById('consentSimulation')?.checked;
    const education = document.getElementById('consentEducation')?.checked;
    if (!age || !simulation || !education) {
        toast('يجب تأكيد جميع بنود الإقرار قبل المتابعة', 'warn');
        return;
    }
    const key = `az_education_consent_${currentUser?.id || 'guest'}`;
    localStorage.setItem(key, JSON.stringify({ accepted: 'accepted', age18: true, at: new Date().toISOString() }));
    if (currentUser?.id) {
        // يعمل حتى لو لم تُضف أعمدة الموافقة بعد؛ لا يمنع دخول المستخدم عند اختلاف المخطط.
        await sb.from('profiles').update({ age_confirmed: true, education_consent_at: new Date().toISOString() }).eq('id', currentUser.id);
    }
    document.getElementById('educationDisclaimerModal')?.classList.remove('active');
    toast('تم قبول الإقرار التعليمي والمحاكاة');
}
function closeEducationDisclaimer() {
    toast('لا يمكن استخدام المنصة دون قبول الإقرار التعليمي', 'warn');
}
async function ensureTrialPeriod(profile) {
    if (!profile || profile.role === 'admin' || profile.trial_end) return profile;
    const base = profile.created_at ? new Date(profile.created_at) : new Date();
    const end = new Date(base.getTime() + TRIAL_DAYS * 86400000).toISOString();
    const { error } = await sb.from('profiles').update({ trial_end: end }).eq('id', profile.id);
    if (!error) profile.trial_end = end;
    else console.warn('تعذر إنشاء فترة التجربة تلقائيًا:', error.message);
    return profile;
}
const COURSE_LESSONS = [
    { title: 'مقدمة: ما هي المحاكاة؟', body: '<p>هذه المنصة بيئة تعليمية تحاكي قراءة السوق ولا تنفذ أوامر شراء أو بيع حقيقية. الهدف هو التدريب على بناء الفرضية وقياسها، لا تقديم توصية.</p><p><strong>مثال تطبيقي:</strong> سجّل سبب اختيار سهم افتراضي، مستوى الدخول الافتراضي، نقطة الإلغاء، ثم راقب النتيجة دون أموال حقيقية.</p>', source: 'SEC Investor.gov — https://www.investor.gov/' },
    { title: 'قراءة السعر والاتجاه', body: '<p>تعلّم الفرق بين الاتجاه الصاعد والهابط والجانبي، وكيف تستخدم القمم والقيعان بدل مطاردة حركة قصيرة.</p><p><strong>تمرين:</strong> حدّد آخر قمتين وقاعين على الرسم، واكتب هل البنية تصنع قممًا أعلى أم أدنى.</p>', source: 'CME Group — Technical Analysis https://www.cmegroup.com/education.html' },
    { title: 'الدعم والمقاومة', body: '<p>الدعم منطقة يزداد فيها اهتمام المشترين، والمقاومة منطقة يزداد فيها ضغط البائعين. لا تُعامل الخط كحقيقة دقيقة؛ استخدم منطقة وسيناريو إلغاء.</p><p><strong>مثال:</strong> إذا كُسر الدعم وأغلق السعر تحته، اكتب سيناريو عدم استمرار الفكرة بدل افتراض الارتداد.</p>', source: 'CFA Institute — Technical Analysis https://rpc.cfainstitute.org/' },
    { title: 'المتوسطات المتحركة', body: '<p>تُستخدم SMA20 وSMA50 وSMA200 لوصف الاتجاه والزخم، وليست ضمانًا للنتيجة. تقاطع المتوسطات إشارة متأخرة ويجب دمجه مع السعر وإدارة المخاطر.</p><p><strong>تمرين:</strong> قارن السعر مع SMA50 وسجّل ما إذا كان الاتجاه متوافقًا أو متعارضًا.</p>', source: 'CFA Institute — Investment Foundations https://www.cfainstitute.org/insights' },
    { title: 'RSI والزخم', body: '<p>يقيس RSI زخم الحركة ضمن نطاق. التشبع لا يعني أن السعر سينعكس فورًا؛ قد يبقى السهم في حالة زخم فترة طويلة.</p><p><strong>مثال:</strong> لا تستخدم RSI وحده؛ اكتب تأكيدًا إضافيًا من بنية السعر قبل تسجيل فرضية محاكاة.</p>', source: 'Fidelity Learning Center — RSI https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/RSI' },
    { title: 'الحجم والسيولة', body: '<p>الحجم يساعد على فهم قابلية تنفيذ الفكرة نظريًا، لكن بيانات المنصة قد تكون متأخرة أو محدودة. لذلك لا نعرض المحاكاة على أنها سعر تنفيذ حقيقي.</p><p><strong>تمرين:</strong> قارن حجم اليوم بمتوسطه وسجّل ملاحظة عن السيولة دون تحويلها إلى وعد بالربح.</p>', source: 'FINRA — Investing Basics https://www.finra.org/investors/investing' },
    { title: 'إدارة المخاطر', body: '<p>حدّد قبل أي تجربة افتراضية: نقطة الإلغاء، حجم الصفقة الافتراضي، والخسارة الافتراضية المقبولة. لا تستخدم مالًا لا تستطيع تحمل خسارته في الواقع.</p><p><strong>مثال:</strong> اكتب خطة تتوقف عند تحقق شرط الإلغاء بدل تعديل الخطة بعد ظهور الخسارة.</p>', source: 'SEC — Investor Alerts https://www.investor.gov/introduction-investing' },
    { title: 'بناء خطة اختبار', body: '<p>الخطة القابلة للاختبار تحتوي على شروط دخول وخروج ومدة وبيانات ونتيجة. لا تخلط بين نتيجة تجربة قصيرة وصلاحية استراتيجية طويلة.</p><p><strong>مشروع الدورة:</strong> أنشئ عشر فرضيات محاكاة، سجّلها، ثم قيّم الالتزام والنتيجة والمتوسط والانحراف.</p>', source: 'CFA Institute — Portfolio Management https://www.cfainstitute.org/' },
    { title: 'فهم الإشارات والماسح', body: '<p>الإشارة داخل AZ Alpha Vision وصف تعليمي آلي، وليست أمرًا أو توصية. قد تفشل بسبب نقص البيانات أو تأخرها أو تغير السوق.</p><p><strong>تمرين:</strong> افتح سبب الإشارة، تحقق من السعر والاتجاه والبيانات، ثم اكتب سبب قبولها أو رفضها في دفتر التدريب.</p>', source: 'SEC — Day Trading Risk Disclosure https://www.sec.gov/investor/pubs/daytips.htm' },
    { title: 'اختبار نهائي وقواعد الاستخدام', body: '<p>لا تنتقل من المحاكاة إلى المال الحقيقي لمجرد ظهور نتائج إيجابية. راجع التكاليف والضرائب والملاءمة والمخاطر واستشر مختصًا مرخصًا عند الحاجة.</p><p><strong>الاختبار:</strong> اشرح الفرق بين البيانات النظرية والسعر القابل للتنفيذ، وبين الإشارة التعليمية والتوصية المالية.</p>', source: 'FINRA — Smart Investing https://www.finra.org/investors' }
];
function renderCourseLesson(index = 0) {
    const lesson = COURSE_LESSONS[Math.max(0, Math.min(index, COURSE_LESSONS.length - 1))];
    const title = document.getElementById('courseLessonTitle');
    const body = document.getElementById('courseLessonBody');
    const source = document.getElementById('courseLessonSource');
    const count = document.getElementById('courseLessonCount');
    if (!title || !body) return;
    title.textContent = lesson.title;
    body.innerHTML = lesson.body;
    source.innerHTML = `<strong>مصدر للمطالعة:</strong> <a href="${lesson.source.split(' — ')[1] || '#'}" target="_blank" rel="noopener">${lesson.source.split(' — ')[0]}</a>`;
    count.textContent = `الدرس ${index + 1} من ${COURSE_LESSONS.length}`;
    document.getElementById('coursePrev').disabled = index === 0;
    document.getElementById('courseNext').disabled = index === COURSE_LESSONS.length - 1;
    document.getElementById('courseLessonIndex').value = index;
}
function openCourse() { document.getElementById('courseModal')?.classList.add('active'); renderCourseLesson(0); }
function closeCourse() { document.getElementById('courseModal')?.classList.remove('active'); }
function courseMove(delta) { renderCourseLesson(Number(document.getElementById('courseLessonIndex').value || 0) + delta); }

// ضابط أولي للرموز: لا يُقبل الرمز إلا إذا وُجد في بيانات السوق الموثوقة وله سعر موجب.
async function isTradableMarketSymbol(symbol) {
    const s = String(symbol || '').trim().toUpperCase();
    if (!s || EXCLUDED_SYMBOLS.has(s)) return false;
    const { data, error } = await sb.from('market_fundamentals').select('symbol,price,exchange,industry').eq('symbol', s).maybeSingle();
    if (error || !data) return false;
    const exchange = String(data.exchange || '').toUpperCase();
    const industry = String(data.industry || '').toLowerCase();
    return Number(data.price) > 0 && ['NYSE','NASDAQ'].includes(exchange) && !/etf|reit|closed end|warrant|unit|preferred|fund|trust/.test(industry);
}
const originalAddToWatchlist = addToWatchlist;
addToWatchlist = async function() {
    const sym = document.getElementById('addSymbolInput').value.trim().toUpperCase();
    if (!(await isTradableMarketSymbol(sym))) { toast('هذا الرمز غير موجود كسهم عادي قابل للتداول في قاعدة السوق', 'error'); return; }
    return originalAddToWatchlist();
};
