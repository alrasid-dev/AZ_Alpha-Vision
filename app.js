// ============================
// AZ ALPHA VISION 2026 — CORE
// (auth / watchlist / admin / payments now run on real Supabase — everything else unchanged)
// ============================

const SUPABASE_URL = "https://riktmjqbixqlqwqwqoyc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_TMew47Ce-t8NuuJ-4Mpw5w_sa6ckPjf";
// مفتاح VAPID العام فقط؛ المفتاح الخاص يبقى داخل Supabase Edge Function Secrets.
const WEB_PUSH_PUBLIC_KEY =
  "BNk6hCs1rlvB-_8NSo0cxXNLR964XlRSwVE6THODXYwST84y8OMfzY_EsIkwnpTzQV8c4XY_whs4C1SBaphooIM";
const PUSH_KEY_VERSION = "2026-08-vapid-2";
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    experimental: { passkey: true },
  },
});

let currentUser = null,
  currentProfile = null,
  chartInstance = null,
  watchlist = [],
  screenerResults = [],
  isScanning = false,
  marketPulseTimer = null,
  stockTableTimer = null;
let activePresetKey = null;

// ===== UTILS =====
function toast(msg, type = "success") {
  const stack = document.getElementById("toastStack");
  const el = document.createElement("div");
  el.className =
    "toast-item " +
    (type === "error" ? "error" : type === "warn" ? "warn" : "success");
  const icon = type === "success" ? "✅" : type === "error" ? "❌" : "⚠️";
  el.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-120%)";
    setTimeout(() => el.remove(), 300);
  }, 4000);
}
function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
// ينظّف نصوصًا واردة من قاعدة البيانات (إعلانات الأدمن، تذاكر الدعم) قد تحتوي أحيانًا
// على تسلسلات هروب حرفية مثل \n أو \r بدل سطر فعلي، فتظهر للمستخدم كرموز غريبة.
function normalizeDbText(s) {
  return String(s ?? "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function withTimeout(promise, ms = 15000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), ms),
    ),
  ]);
}

// ===== LOCAL CACHE (screener results / weekly picks only — not accounts, not security-sensitive) =====
const LocalCache = {
  getScreener: () => {
    try {
      return JSON.parse(localStorage.getItem("az_screener_cache"));
    } catch {
      return null;
    }
  },
  setScreener: (c) =>
    localStorage.setItem("az_screener_cache", JSON.stringify(c)),
  getPicks: () => {
    try {
      return JSON.parse(localStorage.getItem("az_weekly_picks"));
    } catch {
      return null;
    }
  },
  setPicks: (p) => localStorage.setItem("az_weekly_picks", JSON.stringify(p)),
};

// ===== AUTH (Supabase) =====
function switchAuth(mode) {
  document
    .getElementById("loginCard")
    .classList.toggle("hidden", mode === "register");
  document
    .getElementById("registerCard")
    .classList.toggle("hidden", mode === "login");
  document.getElementById("loginError").textContent = "";
  document.getElementById("regError").textContent = "";
}

function translateAuthError(msg) {
  if (/invalid login credentials/i.test(msg)) return "بيانات غير صحيحة";
  if (/email not confirmed/i.test(msg))
    return "يرجى تأكيد بريدك الإلكتروني من الرسالة المرسلة إليك";
  if (/already registered|user already exists/i.test(msg))
    return "البريد مستخدم مسبقاً";
  if (/password/i.test(msg)) return "كلمة المرور غير صالحة (8 أحرف على الأقل)";
  return msg;
}

async function handleRegister() {
  const name = document.getElementById("regName").value.trim();
  const email = document.getElementById("regEmail").value.trim().toLowerCase();
  const pass = document.getElementById("regPassword").value;
  const err = document.getElementById("regError");
  if (!name || !email || !pass) {
    err.textContent = "املأ جميع الحقول";
    return;
  }
  if (pass.length < 8) {
    err.textContent = "8 أحرف على الأقل";
    return;
  }
  if (!email.includes("@")) {
    err.textContent = "بريد غير صالح";
    return;
  }

  const { data, error } = await sb.auth.signUp({
    email,
    password: pass,
    options: { data: { name } },
  });
  if (error) {
    err.textContent = translateAuthError(error.message);
    return;
  }

  if (data.session) {
    await loadSessionAndEnter();
  } else {
    // لا توجد موافقة إدارية بعد التسجيل. قد يطلب Supabase تأكيد البريد فقط.
    toast(
      "✅ تم إنشاء الحساب. تحقق من بريدك إذا طلب النظام ذلك، ثم سجّل الدخول.",
      "success",
    );
    switchAuth("login");
    document.getElementById("loginEmail").value = email;
  }
}

function passkeySupported() {
  return (
    window.isSecureContext &&
    !!window.PublicKeyCredential &&
    !!sb.auth?.signInWithPasskey
  );
}
function passkeyErrorMessage(error) {
  const msg = String(error?.message || error || "");
  if (/cancel|abort|notallowed/i.test(msg))
    return "تم إلغاء عملية البصمة أو لم تتم الموافقة عليها";
  if (/passkey_disabled/i.test(msg))
    return "يجب تفعيل Passkeys أولًا من Supabase → Authentication → Passkeys";
  if (/not supported|secure context/i.test(msg))
    return "هذا المتصفح أو الرابط لا يدعم Passkey؛ استخدم HTTPS ومتصفحًا حديثًا";
  return "تعذر استخدام مفتاح المرور: " + (msg || "خطأ غير معروف");
}
async function handlePasskeyLogin() {
  const err = document.getElementById("loginError");
  if (!passkeySupported()) {
    err.textContent =
      "مفتاح المرور يحتاج HTTPS ومتصفحًا حديثًا وميزة Passkeys مفعّلة في Supabase";
    return;
  }
  try {
    err.textContent = "تحقق من البصمة أو Face ID أو قفل الجهاز…";
    const { error } = await withTimeout(sb.auth.signInWithPasskey(), 30000);
    if (error) {
      err.textContent = passkeyErrorMessage(error);
      return;
    }
    await withTimeout(loadSessionAndEnter(), 20000);
  } catch (e) {
    console.error("passkey login error:", e);
    err.textContent = passkeyErrorMessage(e);
  }
}
async function registerPasskeyForCurrentUser() {
  if (!currentUser)
    return toast(
      "سجّل الدخول بكلمة المرور أولًا، ثم فعّل مفتاح المرور من زر أعلى الصفحة",
      "warn",
    );
  if (!passkeySupported() || !sb.auth?.registerPasskey)
    return toast(
      "ميزة Passkey غير متاحة؛ تأكد من HTTPS وتفعيلها في Supabase",
      "warn",
    );
  try {
    const { data, error } = await withTimeout(sb.auth.registerPasskey(), 30000);
    if (error) throw error;
    toast(
      "✅ تم تسجيل مفتاح المرور. يمكنك استخدام البصمة أو Face ID في الدخول القادم",
    );
    return data;
  } catch (e) {
    console.error("passkey registration error:", e);
    toast(passkeyErrorMessage(e), "error");
  }
}
async function handleLogin() {
  const email = document
    .getElementById("loginEmail")
    .value.trim()
    .toLowerCase();
  const pass = document.getElementById("loginPassword").value;
  const err = document.getElementById("loginError");
  try {
    err.textContent = "جارٍ التحقق من بيانات الدخول…";
    const { error } = await withTimeout(
      sb.auth.signInWithPassword({ email, password: pass }),
      15000,
    );
    if (error) {
      err.textContent = translateAuthError(error.message);
      return;
    }
    await withTimeout(loadSessionAndEnter(), 20000);
  } catch (e) {
    console.error("login timeout/error:", e);
    err.textContent =
      e?.message === "TIMEOUT"
        ? "انتهت مهلة الاتصال بـSupabase؛ تحقق من الإنترنت ثم أعد المحاولة"
        : "تعذر إكمال الدخول: " + (e?.message || "خطأ غير معروف");
  }
}
async function requestPasswordReset() {
  const email = document
    .getElementById("loginEmail")
    .value.trim()
    .toLowerCase();
  const err = document.getElementById("loginError");
  if (!email || !email.includes("@")) {
    err.textContent = "اكتب بريدك الإلكتروني أولاً";
    return;
  }
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) {
    err.textContent = "تعذر إرسال رابط الاستعادة: " + error.message;
    return;
  }
  err.style.color = "var(--accent-green)";
  err.textContent = "تم إرسال رابط استعادة كلمة المرور إلى بريدك الإلكتروني";
}
async function completePasswordRecovery() {
  const next = prompt("أدخل كلمة المرور الجديدة (8 أحرف على الأقل):");
  if (next === null) return;
  const confirmNext = prompt("أعد كتابة كلمة المرور الجديدة:");
  if (next.length < 8 || next !== confirmNext) {
    toast("كلمتا المرور غير متطابقتين أو أقل من 8 أحرف", "error");
    return;
  }
  const { error } = await sb.auth.updateUser({ password: next });
  if (error) {
    toast("تعذر تحديث كلمة المرور: " + error.message, "error");
    return;
  }
  toast("✅ تم تغيير كلمة المرور بنجاح");
  history.replaceState({}, document.title, window.location.pathname);
  await loadSessionAndEnter();
}
async function loadSessionAndEnter() {
  const err = document.getElementById("loginError");
  try {
    err.textContent = "جارٍ تحميل الحساب…";
    const {
      data: { user },
      error: userError,
    } = await withTimeout(sb.auth.getUser(), 10000);
    if (userError) throw userError;
    if (!user) {
      err.textContent = "انتهت الجلسة، أعد تسجيل الدخول";
      return;
    }
    const { data: profileData, error } = await withTimeout(
      sb.from("profiles").select("*").eq("id", user.id).single(),
      10000,
    );
    if (error || !profileData) throw error || new Error("PROFILE_NOT_FOUND");
    // تم إلغاء نظام موافقة المسؤول؛ الحساب يدخل مباشرة بعد نجاح المصادقة.
    // نعتبر السجلات القديمة غير المحدثة مفعّلة في الواجهة، وتُصلح قاعدة البيانات عبر ملف SQL المرفق.
    profileData.approved = true;
    // استخدم let/نسخة قابلة للتحديث؛ كان const يسبب توقف الدخول عند تحديث trial_end.
    let profile = await ensureTrialPeriod(profileData);
    if (
      profile.trial_end &&
      new Date(profile.trial_end).getTime() < Date.now() &&
      profile.role !== "admin"
    ) {
      profile.subscription_status = "expired";
    }
    err.textContent = "";
    await initApp(user, profile);
  } catch (e) {
    console.error("loadSessionAndEnter error:", e);
    err.textContent =
      e?.message === "PROFILE_NOT_FOUND"
        ? "لم يتم العثور على ملف الحساب؛ تواصل مع المسؤول"
        : "تعذر إكمال تسجيل الدخول: " + (e?.message || "خطأ غير معروف");
  }
}

function handleLogout() {
  sb.auth.signOut();
  currentUser = null;
  currentProfile = null;
  watchlist = [];
  document.getElementById("appContainer").classList.remove("active");
  document.getElementById("authScreen").style.display = "flex";
  document.getElementById("waitingScreen").classList.remove("active");
  toast("👋 تم تسجيل الخروج");
}

// ===== NOTIFICATIONS: WEB PUSH + EMAIL PREFERENCES =====
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((ch) => ch.charCodeAt(0)));
}
function isPushSupported() {
  return Boolean(
    window.isSecureContext &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window,
  );
}
async function registerPushWorker() {
  if (!isPushSupported()) throw new Error("المتصفح لا يدعم Web Push");
  try {
    // register() قد يُرجع تسجيلاً لا يزال في حالة installing/waiting فقط؛ استدعاء
    // pushManager.subscribe() في هذه اللحظة يفشل بخطأ "no active Service Worker".
    // navigator.serviceWorker.ready لا يتحقق إلا بعد أن يصبح الووركر "نشطاً" فعلياً.
    await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    return await navigator.serviceWorker.ready;
  } catch (error) {
    console.warn("تعذر تسجيل Service Worker:", error);
    throw new Error("تعذر تسجيل عامل الخدمة (Service Worker) الخاص بالإشعارات");
  }
}

// يحاول الاشتراك في Push مع إعادة محاولة صامتة (بلا أي نافذة خطأ للمستخدم) إذا لم
// يكن الووركر قد أصبح نشطاً بعد بسبب تأخير طبيعي في التفعيل (مثلاً أول تحميل للصفحة).
async function subscribeToPush(registration, options, attemptsLeft = 3) {
  try {
    return await registration.pushManager.subscribe(options);
  } catch (error) {
    const message = String(error?.message || "");
    const isNotActiveYet = /no active service worker/i.test(message) || error?.name === "InvalidStateError";
    if (!isNotActiveYet || attemptsLeft <= 0) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const freshRegistration = await navigator.serviceWorker.ready;
    return subscribeToPush(freshRegistration, options, attemptsLeft - 1);
  }
}
async function savePushDevice(subscription) {
  if (!currentUser || !subscription?.endpoint) return;
  const { error } = await sb.from("notification_push_devices").upsert(
    {
      user_id: currentUser.id,
      endpoint: subscription.endpoint,
      push_subscription: subscription.toJSON(),
      push_enabled: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "endpoint" },
  );
  if (error) throw error;
}
function setBrowserNotificationControl(enabled, supported = true) {
  const button = document.getElementById("notificationToggleBtn");
  if (!button) return;
  const active = Boolean(enabled && supported);
  button.dataset.enabled = active ? "1" : "0";
  button.setAttribute("aria-pressed", String(active));
  button.setAttribute("aria-label", active ? "إيقاف إشعارات المتصفح" : "تفعيل إشعارات المتصفح");
  button.title = active ? "إيقاف إشعارات المتصفح" : "تفعيل إشعارات المتصفح";
  button.innerHTML = active
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg><span class="sr-only">مفعلة</span>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M4 4l16 16"/></svg><span class="sr-only">متوقفة</span>';
  button.classList.toggle("is-enabled", active);
}

async function refreshBrowserNotificationControl() {
  try {
    if (!isPushSupported()) return setBrowserNotificationControl(false, false);
    const enabled =
      localStorage.getItem("az_push_enabled") !== "0" &&
      Notification.permission === "granted";
    setBrowserNotificationControl(enabled, true);
  } catch (error) {
    console.warn("تعذر تحديث زر حالة الإشعارات:", error);
  }
}

async function disableBrowserNotifications() {
  try {
    localStorage.setItem("az_push_enabled", "0");
    const registration = await navigator.serviceWorker.getRegistration("./");
    const subscription = await registration?.pushManager?.getSubscription();
    if (subscription && currentUser) {
      await sb.from("notification_push_devices").update({ push_enabled: false, updated_at: new Date().toISOString() }).eq("user_id", currentUser.id).eq("endpoint", subscription.endpoint);
      await subscription.unsubscribe().catch(() => {});
    }
    setBrowserNotificationControl(false, true);
    toast("تم إيقاف إشعارات المتصفح لهذا الجهاز", "info");
  } catch (error) {
    console.warn("تعذر إيقاف إشعارات المتصفح:", error);
    toast("تعذر إيقاف الإشعارات؛ تحقق من إعدادات المتصفح", "warn");
  }
}

async function toggleBrowserNotifications() {
  const button = document.getElementById("notificationToggleBtn");
  if (button?.dataset.enabled === "1") return disableBrowserNotifications();
  return enableBrowserNotifications();
}

async function syncExistingPushSubscription() {
  try {
    if (
      !currentUser ||
      localStorage.getItem("az_push_enabled") === "0" ||
      !isPushSupported() ||
      Notification.permission !== "granted"
    ) {
      await refreshBrowserNotificationControl();
      return;
    }
    const registration = await registerPushWorker();
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription)
      subscription = await subscribeToPush(registration, {
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(WEB_PUSH_PUBLIC_KEY),
      });
    await savePushDevice(subscription);
    await refreshBrowserNotificationControl();
  } catch (error) {
    // إعادة تحديث الاشتراك في الخلفية عملية صامتة بطبيعتها؛ لا نُظهر أي نافذة خطأ للمستخدم هنا.
    console.warn("تعذر تحديث اشتراك Push في الخلفية:", error);
    await refreshBrowserNotificationControl();
  }
}
if ("serviceWorker" in navigator)
  navigator.serviceWorker.addEventListener("message", (event) => {
    try {
      if (event.data?.type === "az-push-subscription-change")
        syncExistingPushSubscription();
    } catch (error) {
      console.warn("تعذر معالجة رسالة تغيير اشتراك Push:", error);
    }
  });
async function enableBrowserNotifications() {
  try {
    if (!currentUser)
      return toast("سجّل الدخول أولًا لتفعيل الإشعارات", "warn");
    if (!isPushSupported())
      return toast(
        "متصفحك أو الاتصال الحالي (يتطلب HTTPS) لا يدعم إشعارات الويب",
        "warn",
      );
    localStorage.setItem("az_push_enabled", "1");
    const permission = await Notification.requestPermission();
    if (permission !== "granted")
      return toast("لم يتم السماح بإشعارات المتصفح", "warn");
    const registration = await registerPushWorker();
    let subscription = await registration.pushManager.getSubscription();
    if (
      subscription &&
      localStorage.getItem("az_push_key_version") !== PUSH_KEY_VERSION
    ) {
      await subscription.unsubscribe().catch(() => {});
      subscription = null;
    }
    if (!subscription)
      subscription = await subscribeToPush(registration, {
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(WEB_PUSH_PUBLIC_KEY),
      });
    localStorage.setItem("az_push_key_version", PUSH_KEY_VERSION);
    await savePushDevice(subscription);
    const btn = document.getElementById("enablePushBtn");
    if (btn) btn.textContent = "إشعارات المتصفح مفعّلة";
    setBrowserNotificationControl(true, true);
    toast("تم تفعيل إشعارات المتصفح خارج الموقع");
  } catch (e) {
    localStorage.setItem("az_push_enabled", "0");
    console.error(e);
    setBrowserNotificationControl(false, true);
    // "no active Service Worker" يعني فقط أن التفعيل ما زال قيد الإنجاز رغم إعادة المحاولات
    // الصامتة؛ نطلب من المستخدم إعادة المحاولة بلطف بدل رسالة خطأ تقنية مخيفة.
    const isNotActiveYet = /no active service worker/i.test(String(e?.message || "")) || e?.name === "InvalidStateError";
    toast(
      isNotActiveYet
        ? "الموقع لا يزال يهيّئ نظام الإشعارات؛ يرجى الضغط على الزر مجددًا بعد لحظات"
        : "تعذر تفعيل إشعارات المتصفح: " + (e?.message || "تحقق من إعدادات الموقع"),
      "warn",
    );
  }
}
async function saveEmailAlerts() {
  try {
    if (!currentUser) return toast("سجّل الدخول أولًا", "warn");
    const email = String(
      document.getElementById("alertEmail")?.value || currentUser.email || "",
    )
      .trim()
      .toLowerCase();
    if (!email.includes("@")) return toast("أدخل بريدًا صحيحًا", "warn");
    const { error } = await sb.from("notification_subscriptions").upsert(
      {
        user_id: currentUser.id,
        email,
        email_enabled: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw error;
    const toggle = document.getElementById("emailAlertsToggle");
    if (toggle) toggle.checked = true;
    toast("تم حفظ بريد التنبيهات؛ سيبدأ الإرسال بعد إعداد مزود البريد الخلفي");
  } catch (e) {
    console.error(e);
    toast(
      "تعذر حفظ بريد التنبيهات: " + (e?.message || "خطأ غير معروف"),
      "error",
    );
  }
}
async function toggleEmailAlerts(enabled) {
  try {
    if (!currentUser) {
      const toggle = document.getElementById("emailAlertsToggle");
      if (toggle) toggle.checked = false;
      return toast("سجّل الدخول أولًا", "warn");
    }
    const emailInput = document.getElementById("alertEmail");
    const email = String(emailInput?.value || currentUser.email || "")
      .trim()
      .toLowerCase();
    if (enabled && !email.includes("@")) {
      const toggle = document.getElementById("emailAlertsToggle");
      if (toggle) toggle.checked = false;
      return toast("أدخل بريد التنبيهات ثم اضغط حفظ البريد", "warn");
    }
    const { error } = await sb.from("notification_subscriptions").upsert(
      {
        user_id: currentUser.id,
        email: email || null,
        email_enabled: Boolean(enabled),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw error;
    toast(
      enabled
        ? "تم تفعيل إشعارات البريد الإلكتروني"
        : "تم إيقاف إشعارات البريد الإلكتروني",
    );
  } catch (e) {
    console.error(e);
    const toggle = document.getElementById("emailAlertsToggle");
    if (toggle) toggle.checked = !enabled;
    toast(
      "تعذر تحديث إعداد البريد: " + (e?.message || "خطأ غير معروف"),
      "error",
    );
  }
}
async function togglePriceAlerts(enabled) {
  try {
    if (!currentUser) {
      const toggle = document.getElementById("priceAlertsToggle");
      if (toggle) toggle.checked = false;
      return toast("سجّل الدخول أولًا", "warn");
    }
    const { error } = await sb.from("notification_subscriptions").upsert(
      {
        user_id: currentUser.id,
        price_alerts_enabled: Boolean(enabled),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw error;
    toast(
      enabled
        ? "تم تفعيل تنبيهات حركة السعر ±2%"
        : "تم إيقاف تنبيهات حركة السعر",
    );
  } catch (e) {
    console.error(e);
    const toggle = document.getElementById("priceAlertsToggle");
    if (toggle) toggle.checked = !enabled;
    toast(
      "تعذر تحديث تنبيهات الأسعار: " +
        (e?.message || "نفّذ ملف price_alerts.sql أولًا"),
      "error",
    );
  }
}
async function loadEmailAlertPreference() {
  if (!currentUser || !sb) return;
  const { data, error } = await sb
    .from("notification_subscriptions")
    .select("email,email_enabled,price_alerts_enabled")
    .eq("user_id", currentUser.id)
    .maybeSingle();
  if (error) {
    console.warn("تعذر تحميل إعداد تنبيه السعر:", error.message);
    return;
  }
  const input = document.getElementById("alertEmail");
  const emailToggle = document.getElementById("emailAlertsToggle");
  const priceToggle = document.getElementById("priceAlertsToggle");
  if (data) {
    if (input && data.email) input.value = data.email;
    if (emailToggle) emailToggle.checked = data.email_enabled === true;
    if (priceToggle) priceToggle.checked = data.price_alerts_enabled !== false;
  }
}
async function saveDisplayName() {
  try {
    if (!currentUser) return toast("سجّل الدخول أولًا", "warn");
    const input = document.getElementById("displayNameInput");
    const name = String(input?.value || "").trim();
    if (name.length < 2 || name.length > 80)
      return toast("اكتب اسمًا بين حرفين و80 حرفًا", "warn");
    const { error } = await sb
      .from("profiles")
      .update({ name })
      .eq("id", currentUser.id);
    if (error) throw error;
    if (currentProfile) currentProfile.name = name;
    const nameEl = document.getElementById("userName");
    if (nameEl) nameEl.textContent = name;
    const avatar = document.getElementById("userAvatar");
    if (avatar) avatar.textContent = name.charAt(0).toUpperCase();
    toast("تم حفظ اسم العرض");
  } catch (e) {
    console.error(e);
    toast("تعذر حفظ الاسم: " + (e?.message || "خطأ غير معروف"), "error");
  }
}

const AZ_AI_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/az-ai`;
let azAiHistory = [];
function openAzAi() {
  const modal = document.getElementById("azAiModal");
  if (!modal) return;
  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
  setTimeout(() => document.getElementById("azAiInput")?.focus(), 80);
}
function closeAzAi() {
  const modal = document.getElementById("azAiModal");
  if (!modal) return;
  modal.classList.remove("active");
  modal.setAttribute("aria-hidden", "true");
}
function cleanAzAiText(text) {
  return String(text || "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^[\-•]\s*/gm, "• ")
    .replace(/`/g, "")
    .trim();
}
function appendAzAiMessage(role, text) {
  const box = document.getElementById("azAiMessages");
  if (!box) return;
  const item = document.createElement("div");
  item.className = `az-ai-message ${role}`;
  item.textContent = cleanAzAiText(text);
  box.appendChild(item);
  box.scrollTop = box.scrollHeight;
  return item;
}
function azBeeLocalAnswer(question) {
  const q = String(question || "").toLowerCase();
  const map = [
    [/محاك|محفظ|10,?000|افتراض/, "المحاكي محفظة تعليمية مشتركة بقيمة 10,000 دولار افتراضية. افتح تبويب المحفظة لمتابعة المراكز والصفقات. لا يوجد تنفيذ حقيقي ولا توصية مالية."],
    [/تحليل|مؤشر|rsi|فيبون|smc/, "التحليل الفني في تبويب «التحليل» بعد الرئيسية مباشرة: متوسطات، RSI، فيبوناتشي وأدوات القراءة. المؤشر أداة وصف لا أمر تداول."],
    [/إشعار|تنبيه|push|خلف/, "فعّل زر الجرس في الشريط العلوي بعد تسجيل الدخول وعلى رابط HTTPS. بعد السماح، تصل التنبيهات عبر خدمة الويب حتى لو أُغلقت الصفحة على أندرويد كروم، وعلى iOS بعد إضافة المنصة للشاشة الرئيسية (iOS 16.4+)."],
    [/مسوق|تسويق|تويتر|تغريد/, "لوحة المسوق الذكي تقرأ الأخبار وصفقات المحاكي وتقويم الأرباح ثم تصوغ تشويقاً غير مباشر مع رابط التسجيل في نهاية التحديث. النشر على X يبقى مسودة ما لم يُفعَّل وضع النشر."],
    [/اشترك|تسجيل|حساب|ترقي/, "أنشئ حساباً من شاشة التسجيل أو من رابط ?register=1. الترقية من زر الاشتراك عند الحاجة. للدعم: @azalphavision و azalphavision2026@gmail.com من تبويب الدعم في نهاية القائمة."],
    [/دعم|تذاكر|اكس|بريد/, "الدعم آخر خيار في القائمة والتذييل: تذكرة داخل المنصة، أو X @azalphavision، أو البريد azalphavision2026@gmail.com."],
    [/ثيم|فاتح|داكن|ليل/, "بدّل الثيم من أيقونة الشمس/القمر في الشريط العلوي. الوضع الداكن المؤسسي هو الافتراضي، والفاتح رخامي هادئ للبيئات الإدارية."],
    [/ماسح|فلتر|ترشيح/, "الفلترة والماسح والترشيحات تعرض إشارات تعليمية من بيانات المنصة. ظهور رمز لا يعني شراء."],
  ];
  for (const [re, answer] of map) if (re.test(q)) return answer;
  return "فتحت المعرفة المحلية فوراً. الرئيسية للعمل والتحليل أولاً، ثم المسوق، والدعم آخر القائمة. اسأل عن تبويب محدد أو رمز سهم لشرح تعليمي من بيانات المنصة المتاحة.";
}
// تفتح النحلة تلقائياً مع أول دخول فعلي للمستخدم فقط (لا تتكرر بعدها أبداً)، وتعطي
// تقريراً تعليمياً مبسطاً ثم تسأله "وش تحتاج؟" لتوجيهه لأقرب تبويب مفيد.
function maybeAutoOpenAzAiWelcome(shownOtherModal) {
  if (!currentUser || shownOtherModal) return;
  const key = `az_ai_welcomed_${currentUser.id}`;
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, "1");
  setTimeout(() => {
    const picksCount = Array.isArray(SIGNALS_CACHE) ? SIGNALS_CACHE.length : 0;
    const watchCount = Array.isArray(watchlist) ? watchlist.length : 0;
    const report =
      picksCount > 0
        ? `رصد الماسح حتى الآن ${picksCount} إشارة نشطة عبر القوالب المتاحة${watchCount ? `، وقائمتك تتابع ${watchCount} رمز` : ""}.`
        : "الماسح يجهّز الإشارات الآن؛ افتح تبويب «الماسح» أو «الترشيحات» بعد لحظات.";
    openAzAi();
    appendAzAiMessage(
      "assistant",
      `أهلاً بك في AZ Alpha Vision 👋 أنا AZ، مساعدك التعليمي.\n${report}\nأقدر أشرح لك الماسح، الترشيحات، المحاكي الافتراضي، أو الإشعارات. وش تحتاج؟`,
    );
  }, 900);
}
async function askAzBeePrompt(text) {
  const input = document.getElementById("azAiInput");
  if (input) input.value = text;
  openAzAi();
  return askAzAi();
}
async function askAzAi(event) {
  event?.preventDefault();
  const input = document.getElementById("azAiInput");
  const question = String(input?.value || "").trim();
  if (!question) return;
  if (input) input.value = "";
  appendAzAiMessage("user", question);
  azAiHistory.push({ role: "user", content: question });
  const instant = azBeeLocalAnswer(question);
  const loading = appendAzAiMessage("assistant", instant);
  loading?.classList.add("az-bee-instant");
  try {
    const { data, error } = await sb.functions.invoke("az-ai", {
      body: { messages: azAiHistory, mode: "bee" },
    });
    if (error || !data?.answer) return;
    loading.textContent = cleanAzAiText(data.answer);
    azAiHistory.push({ role: "assistant", content: data.answer });
  } catch (error) {
    azAiHistory.push({ role: "assistant", content: instant });
    console.warn("المساعد السحابي غير متاح؛ بقيت الإجابة الفورية:", error);
  }
}

function marketerRegisterUrl() {
  return `${location.origin}${location.pathname}?register=1&utm_source=app&utm_medium=marketer&utm_campaign=soft`;
}
async function safeSelect(table, columns, orderCol) {
  try {
    let q = sb.from(table).select(columns).limit(8);
    if (orderCol) q = q.order(orderCol, { ascending: false });
    const { data, error } = await q;
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}
function composeSoftSellPreview({ news, earnings, trades }) {
  const n = news[0];
  const e = earnings[0];
  const t = trades[0];
  let hook = "المحرك التعليمي يراجع الإشارات بهدوء قبل أي خطوة داخل المحاكي الافتراضي.";
  if (n?.title) hook = `متابعة تعليمية لخبر ${n.symbol || ""}: ${String(n.title).slice(0, 90)}. الفهم أولاً، بلا توصية.`;
  else if (e?.symbol) hook = `على تقويم الأرباح: ${e.symbol} قريب من موعد نتائج. راقب السياق داخل المنصة دون توقع الرقم.`;
  else if (t?.symbol) hook = `المحاكي سجّل ${t.action === "buy" ? "دخولاً تعليمياً" : "خروجاً تعليمياً"} على ${t.symbol}. التجربة افتراضية بالكامل.`;
  return `${hook}\n\n#تعلم_التداول #AZAlphaVision\nجرّب المحاكي التعليمي مجاناً وسجّل من هنا:\n${marketerRegisterUrl()}`;
}
async function refreshMarketerDashboard() {
  const preview = document.getElementById("mkLivePreview");
  if (preview) preview.textContent = "جارٍ مزامنة الأخبار والتقويم وصفقات المحاكي…";
  const [news, earnings, trades, posts, tasks] = await Promise.all([
    safeSelect("company_news", "id,symbol,title,published_at,source_url", "published_at"),
    safeSelect("earnings_events", "id,symbol,event_date,source_url", "event_date"),
    safeSelect("shared_virtual_trades", "id,symbol,action,qty,price,created_at", "created_at"),
    safeSelect("marketing_posts", "id,event_type,symbol,status,tweet_text,created_at", "created_at"),
    safeSelect("platform_tasks", "id,title,due_at,symbol", "due_at"),
  ]);
  const setTxt = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  };
  setTxt("mkNewsCount", news.length);
  setTxt("mkEarnCount", earnings.length + tasks.length);
  setTxt("mkTradeCount", trades.length);
  setTxt("mkPostCount", posts.length);
  if (preview) preview.textContent = composeSoftSellPreview({ news, earnings, trades });
  const cal = document.getElementById("mkCalendarList");
  if (cal) {
    const rows = [
      ...tasks.map((x) => ({ when: x.due_at, title: x.title, sub: x.symbol || "مهمة منصة" })),
      ...earnings.map((x) => ({ when: x.event_date, title: `أرباح ${x.symbol}`, sub: "تقويم تعليمي" })),
    ].slice(0, 8);
    cal.innerHTML = rows.length
      ? rows.map((r) => `<article><b>${escapeHtml(r.title)}</b><small>${escapeHtml(String(r.sub))} · ${escapeHtml(r.when ? new Date(r.when).toLocaleDateString("ar-SA") : "")}</small></article>`).join("")
      : "لا توجد أحداث ظاهرة بعد.";
  }
  const list = document.getElementById("mkPostsList");
  if (list) {
    list.innerHTML = posts.length
      ? posts.map((p) => `<article><b>${escapeHtml(p.symbol || p.event_type || "مسودة")}</b> · ${escapeHtml(p.status || "")}<small>${escapeHtml(String(p.tweet_text || "").slice(0, 180))}</small></article>`).join("")
      : "لا توجد مسودات ظاهرة بهذه الجلسة. المشغّل الخلفي يخزّنها عند تشغيل Render/GitHub.";
  }
}

const AZ_RELEASE_VERSION = "2026.08-simulator-context-earnings";
// تُعلَّم كمُشاهدة فور العرض (وليس فقط عند الضغط على "فهمت") لضمان ظهورها مرة واحدة
// بالفعل ولو أغلق المستخدم الصفحة أو بدّل التبويب دون الضغط على الزر.
function showReleaseNotesIfNeeded() {
  if (!currentUser) return false;
  const key = `az_release_seen_${currentUser.id}_${AZ_RELEASE_VERSION}`;
  if (localStorage.getItem(key)) return false;
  localStorage.setItem(key, "1");
  const modal = document.getElementById("releaseNotesModal");
  const version = document.getElementById("releaseNotesVersion");
  if (version) version.textContent = AZ_RELEASE_VERSION;
  if (modal) {
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
  }
  return true;
}
function acknowledgeReleaseNotes() {
  if (currentUser)
    localStorage.setItem(
      `az_release_seen_${currentUser.id}_${AZ_RELEASE_VERSION}`,
      "1",
    );
  const modal = document.getElementById("releaseNotesModal");
  if (modal) {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }
}

const NEWS_CATEGORY_LABELS = {
  earnings: "أرباح",
  dividend: "توزيعات",
  filing: "إفصاح",
  positive: "إيجابي",
  negative: "سلبي",
  general: "عام",
};
const NEWS_IMPACT_LABELS = {
  positive: "إيجابي محتمل",
  negative: "سلبي محتمل",
  neutral: "محايد",
};
function newsImpactVisual(news) {
  if (news?.impact === "positive") return { key: "positive", label: "إيجابي" };
  if (news?.impact === "negative") return { key: "negative", label: "سلبي" };
  if (
    news?.is_material ||
    ["earnings", "dividend", "filing"].includes(news?.category)
  )
    return { key: "caution", label: "مهم للمتابعة" };
  return { key: "neutral", label: "محايد" };
}
function escapeNewsText(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[ch],
  );
}
function formatNewsAge(value) {
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return "";
  const mins = Math.max(0, Math.round((Date.now() - t.getTime()) / 60000));
  if (mins < 60) return `منذ ${mins} دقيقة`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `منذ ${hours} ساعة`;
  return t.toLocaleDateString("ar-SA", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
function platformRelevantSymbols() {
  const items = new Map();
  const add = (symbol, source) => {
    const key = String(symbol || "")
      .trim()
      .toUpperCase();
    if (!key) return;
    if (!items.has(key)) items.set(key, new Set());
    items.get(key).add(source);
  };
  Object.keys(virtualTrader?.positions || {}).forEach((symbol) =>
    add(symbol, "محفظة المحاكي"),
  );
  (LocalCache.getPicks() || []).forEach((item) =>
    add(item.symbol, "ترشيحات الأسبوع"),
  );
  (Array.isArray(SIGNALS_CACHE) ? SIGNALS_CACHE : [])
    .filter((item) => Number(item?.entry_score || 0) > 0)
    .slice(0, 14)
    .forEach((item) => add(item.symbol, "ترشيحات المحاكي"));
  (Array.isArray(screenerResults) ? screenerResults : [])
    .slice(0, 14)
    .forEach((item) => add(item.symbol, "فلترة الأسهم"));
  return items;
}
function trackedSourcesText(value) {
  return Array.isArray(value) && value.length
    ? value.join(" · ")
    : "ترشيحات المنصة";
}
async function refreshCompanyNews() {
  const box = document.getElementById("companyNewsList");
  if (!box || !sb) return;
  const tracked = platformRelevantSymbols();
  const symbols = [...tracked.keys()];
  if (!symbols.length) {
    box.innerHTML =
      '<div class="news-empty">لا توجد مراكز أو ترشيحات فعّالة بعد. سيعرض المحاكي الأخبار بعد تشغيل الماسح أو فتح مركز محاكى.</div>';
    return;
  }
  box.innerHTML = cardSkeleton(3);
  try {
    const { data, error } = await sb
      .from("company_news")
      .select(
        "symbol,company_name,title,summary,source_name,source_url,published_at,category,impact,impact_reason,is_material",
      )
      .in("symbol", symbols)
      .order("published_at", { ascending: false })
      .limit(30);
    if (error) throw error;
    if (!data?.length) {
      box.innerHTML =
        '<div class="news-empty">لا توجد أخبار محفوظة لهذه الترشيحات بعد. سيظهر المحتوى بعد تشغيل جامع الأخبار الخلفي.</div>';
      return;
    }
    box.innerHTML = data
      .map((n) => {
        const visual = newsImpactVisual(n);
        const sources = trackedSourcesText([
          ...(tracked.get(String(n.symbol || "").toUpperCase()) || []),
        ]);
        return `<article class="news-item impact-${visual.key}"><div class="news-symbol">${escapeNewsText(n.symbol)}</div><div><div class="news-item-title">${escapeNewsText(n.title)}</div><div class="news-item-sub">${escapeNewsText(n.source_name || "مصدر عام")} · ${formatNewsAge(n.published_at)} · ${escapeNewsText(sources)} · ${escapeNewsText(n.impact_reason || "")}</div><a class="news-source" href="${escapeNewsText(n.source_url)}" target="_blank" rel="noopener noreferrer">فتح المصدر ↗</a></div><div class="news-item-side"><span class="news-category">${NEWS_CATEGORY_LABELS[n.category] || "عام"}</span><br><span class="news-impact ${visual.key}">${visual.label}</span></div></article>`;
      })
      .join("");
  } catch (error) {
    console.warn("تعذر تحميل أخبار الشركات:", error);
    box.innerHTML =
      '<div class="news-empty">تعذر تحميل الأخبار الآن. تحقق من نشر جدول company_news وتشغيل التحديث الخلفي.</div>';
  }
}

function earningsCountdown(value) {
  const date = new Date(value);
  const days = Math.ceil((date.getTime() - Date.now()) / 86400000);
  if (days < 0) return "تم الموعد";
  if (days === 0) return "اليوم";
  if (days === 1) return "غدًا";
  return `بعد ${days} أيام`;
}
function earningsEstimateText(event) {
  const average = Number(event?.analyst_eps_avg);
  if (!Number.isFinite(average)) return "لا يتوفر إجماع EPS من المصدر حاليًا";
  const low = Number(event?.analyst_eps_low);
  const high = Number(event?.analyst_eps_high);
  const range =
    Number.isFinite(low) && Number.isFinite(high)
      ? ` · النطاق $${low.toFixed(2)}–$${high.toFixed(2)}`
      : "";
  const count = Number(event?.analyst_count);
  const analysts =
    Number.isFinite(count) && count > 0 ? ` · ${count} محلل` : "";
  const periodMap = {
    "0q": "الربع القادم",
    "+1q": "الربع اللاحق",
    "0y": "السنة الحالية",
    "+1y": "السنة القادمة",
  };
  const period =
    periodMap[String(event?.estimate_period || "")] || "الفترة القادمة";
  return `متوسط تقدير EPS (${period}): $${average.toFixed(2)}${range}${analysts}`;
}
async function refreshEarningsCalendar() {
  const box = document.getElementById("earningsList");
  if (!box || !sb) return;
  const tracked = platformRelevantSymbols();
  const symbols = [...tracked.keys()];
  if (!symbols.length) {
    box.innerHTML =
      '<div class="earnings-empty">لا توجد مراكز أو ترشيحات فعّالة لعرض تقويم أرباحها.</div>';
    return;
  }
  box.innerHTML = cardSkeleton(3);
  try {
    const { data, error } = await sb
      .from("earnings_events")
      .select(
        "symbol,company_name,event_date,source_name,source_url,analyst_eps_avg,analyst_eps_low,analyst_eps_high,analyst_count,estimate_period,tracking_sources,estimates_fetched_at",
      )
      .in("symbol", symbols)
      .gte("event_date", new Date(Date.now() - 86400000).toISOString())
      .lte("event_date", new Date(Date.now() + 45 * 86400000).toISOString())
      .order("event_date", { ascending: true })
      .limit(28);
    if (error) throw error;
    if (!data?.length) {
      box.innerHTML =
        '<div class="earnings-empty">لا توجد مواعيد أرباح قريبة لهذه الترشيحات بعد. سيظهر التقويم بعد تشغيل جامع الأرباح الخلفي.</div>';
      return;
    }
    box.innerHTML = data
      .map((e) => {
        const localSources = [
          ...(tracked.get(String(e.symbol || "").toUpperCase()) || []),
        ];
        const sources = trackedSourcesText([
          ...new Set([...(e.tracking_sources || []), ...localSources]),
        ]);
        return `<article class="earnings-item"><div class="earnings-symbol">${escapeHtml(e.symbol)}</div><div class="earnings-date">${earningsCountdown(e.event_date)}<br><span class="text-muted">${new Date(e.event_date).toLocaleDateString("ar-SA", { year: "numeric", month: "short", day: "numeric" })}</span></div><div class="earnings-estimate">${escapeHtml(earningsEstimateText(e))}</div><div class="earnings-source">${escapeHtml(sources)} · <a class="news-source" href="${escapeHtml(e.source_url || "#")}" target="_blank" rel="noopener noreferrer">مصدر البيانات</a></div></article>`;
      })
      .join("");
  } catch (error) {
    console.warn("تعذر تحميل تقويم الأرباح:", error);
    box.innerHTML =
      '<div class="earnings-empty">تعذر تحميل التقويم. نفّذ ملف earnings_estimates.sql ثم شغّل مهمة تحديث الأرباح.</div>';
  }
}

// ===== APP INIT =====
function placeVirtualPortfolioSummary() {
  const mount = document.getElementById("virtualPortfolioSummary");
  const summary = document.querySelector(".sidebar .sidebar-global-stats");
  if (mount && summary && !mount.contains(summary)) mount.appendChild(summary);
}

function formatPulsePrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number >= 1000
    ? number.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : number.toFixed(2);
}
function deterministicMarketBrief(rows) {
  const bySymbol = Object.fromEntries(
    (rows || []).map((row) => [String(row.symbol || ""), row]),
  );
  const equityMoves = ["^DJI", "^IXIC"]
    .map((symbol) => Number(bySymbol[symbol]?.change_pct))
    .filter(Number.isFinite);
  const average = equityMoves.length
    ? equityMoves.reduce((sum, value) => sum + value, 0) / equityMoves.length
    : null;
  const vix = Number(bySymbol["^VIX"]?.price);
  const tone =
    average == null
      ? "محايد"
      : average > 0.35
        ? "يميل للإيجابية"
        : average < -0.35
          ? "يميل للحذر"
          : "متوازن";
  const risk =
    Number.isFinite(vix) && vix >= 25
      ? "ومستوى التذبذب مرتفع"
      : Number.isFinite(vix) && vix < 16
        ? "والتذبذب منخفض نسبيًا"
        : "والتذبذب ضمن نطاق متوسط";
  return `قراءة تعليمية: مزاج السوق ${tone} ${risk}. راقب تغير المؤشرات وبيانات الشركات قبل تفسير أي إشارة.`;
}
async function loadMarketPulse() {
  const grid = document.getElementById("marketPulseGrid");
  const brief = document.getElementById("marketDailyBrief");
  if (!grid) return;
  try {
    const { data, error } = await sb
      .from("market_pulse")
      .select("*")
      .order("asset_type")
      .order("symbol");
    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) {
      grid.innerHTML =
        '<div class="market-pulse-empty">تُجهز مؤشرات السوق في الخلفية. ستظهر هنا بعد أول دورة تحديث موثوقة.</div>';
      if (brief)
        brief.textContent =
          "قراءة AZ ai اليومية تحتاج مؤشرات سوق محدثة؛ لا يتم إنشاء قراءة من دون بيانات.";
      return;
    }
    grid.innerHTML = rows
      .map((row) => {
        const change = Number(row.change_pct);
        const direction =
          change > 0 ? "text-green" : change < 0 ? "text-red" : "text-muted";
        const sign = change > 0 ? "+" : "";
        return `<article class="market-pulse-item"><span>${escapeHtml(row.label_ar || row.symbol)}</span><strong class="font-mono">${formatPulsePrice(row.price)}</strong><small class="${direction}">${Number.isFinite(change) ? `${sign}${change.toFixed(2)}%` : "—"}</small></article>`;
      })
      .join("");
    const fallback = deterministicMarketBrief(rows);
    if (brief) brief.textContent = fallback;
    const dayKey = `az_market_brief_${new Date().toISOString().slice(0, 10)}`;
    if (!sessionStorage.getItem(dayKey)) {
      sessionStorage.setItem(dayKey, "pending");
      try {
        const prompt = `اكتب قراءة يومية تعليمية قصيرة جدًا من جملتين فقط، بالاعتماد الحصري على هذه المؤشرات وتاريخ تحديثها. لا تتنبأ ولا تقدم توصية ولا تضف أي رقم غير موجود: ${JSON.stringify(rows.map((r) => ({ name: r.label_ar, price: r.price, change_pct: r.change_pct, updated_at: r.updated_at })))}`;
        const { data: aiData, error: aiError } = await sb.functions.invoke(
          "az-ai",
          { body: { messages: [{ role: "user", content: prompt }] } },
        );
        if (aiError || !aiData?.answer)
          throw aiError || new Error("لا توجد قراءة");
        if (brief) brief.textContent = `AZ ai: ${cleanAzAiText(aiData.answer)}`;
        sessionStorage.setItem(dayKey, "done");
      } catch (error) {
        sessionStorage.removeItem(dayKey);
        console.warn("تعذر إنشاء قراءة السوق اليومية:", error);
      }
    }
  } catch (error) {
    console.warn("تعذر تحميل نبض السوق:", error);
    grid.innerHTML =
      '<div class="market-pulse-empty">تعذر تحميل نبض السوق الآن؛ ستبقى الشاشة خالية من الأرقام غير الموثقة.</div>';
    if (brief) brief.textContent = "لا تتوفر قراءة سوق موثقة الآن.";
  }
}
async function requestSymbolResearch(symbol) {
  if (!currentUser || !symbol) return;
  try {
    const { error } = await sb.from("research_requests").upsert(
      {
        user_id: currentUser.id,
        symbol,
        requested_at: new Date().toISOString(),
        status: "active",
      },
      { onConflict: "user_id,symbol" },
    );
    if (error) throw error;
  } catch (error) {
    // الجدول يضاف مع الإصدار؛ فشل التسجيل لا يمنع سؤال AZ ai عن البيانات الموجودة.
    console.warn("تعذر تسجيل طلب البحث الخلفي:", error);
  }
}
async function initApp(user, profile) {
  currentUser = user;
  currentProfile = profile;
  document.getElementById("authScreen").style.display = "none";
  document.getElementById("waitingScreen").classList.remove("active");
  document.getElementById("appContainer").classList.add("active");
  placeVirtualPortfolioSummary();
  initPremiumShell();
  document.getElementById("userName").textContent =
    profile.name || profile.email;
  document.getElementById("userAvatar").textContent = (
    profile.name || profile.email
  )
    .charAt(0)
    .toUpperCase();
  const displayNameInput = document.getElementById("displayNameInput");
  if (displayNameInput) displayNameInput.value = profile.name || "";
  if (profile.role === "admin") {
    document.getElementById("adminTabBtn").classList.remove("hidden");
    const broadcastCard = document.getElementById("ownerBroadcastCard");
    if (broadcastCard) broadcastCard.style.display = "block";
    refreshAdminData();
  }
  ensureEducationConsent();
  await loadWatchlist();
  await loadMySupportTickets();
  await loadEmailAlertPreference();
  syncExistingPushSubscription();
  const showedAnnouncement = await loadActiveOwnerAnnouncement();
  const showedReleaseNotes = showReleaseNotesIfNeeded();
  maybeAutoOpenAzAiWelcome(showedAnnouncement || showedReleaseNotes);
  updateTrial();
  updateSitePerformance();
  setInterval(updateTrial, 60000);
  document.getElementById("liveTime").textContent =
    new Date().toLocaleTimeString("ar-SA");
  setInterval(
    () =>
      (document.getElementById("liveTime").textContent =
        new Date().toLocaleTimeString("ar-SA")),
    1000,
  );
  setTimeout(() => initChart(), 100);
  // الماسح الحقيقي والصفقات يعملان في الخلفية. المتصفح يقرأ الحالة المشتركة فقط.
  subscribeSignalRealtime();
  await loadVirtualTrader();
  await loadSignalsData(true);
  await loadMarketPulse();
  runScanner();
  if (marketPulseTimer) clearInterval(marketPulseTimer);
  marketPulseTimer = setInterval(() => {
    loadMarketPulse();
    loadWatchlist();
  }, 5 * 60 * 1000);
  if (stockTableTimer) clearInterval(stockTableTimer);
  stockTableTimer = setInterval(() => runScanner(), 5 * 60 * 1000);
  openTabFromHash();
  await refreshCompanyNews();
  await refreshEarningsCalendar();
  if (window.companyNewsTimer) clearInterval(window.companyNewsTimer);
  window.companyNewsTimer = setInterval(
    () => {
      refreshCompanyNews();
      refreshEarningsCalendar();
    },
    10 * 60 * 1000,
  );
  if (!virtualTraderTimer)
    virtualTraderTimer = setInterval(
      () => syncVirtualTraderFromServer(),
      5 * 60 * 1000,
    );
  const c = LocalCache.getScreener();
  if (c && c.t > Date.now() - 86400000) {
    screenerResults = (c.r || []).filter(isCommonStockRow);
    LocalCache.setScreener({ t: Date.now(), r: screenerResults });
    renderScreener();
  }
}

// ===== WATCHLIST (Supabase — syncs across devices now) =====
async function loadWatchlist() {
  const { data, error } = await sb
    .from("watchlist")
    .select("*")
    .eq("user_id", currentUser.id);
  if (error) {
    console.error("watchlist load error", error);
    toast("تعذر تحميل المحفظة: " + error.message, "error");
    try {
      watchlist = JSON.parse(
        localStorage.getItem(`az_watchlist_${currentUser.id}`) || "[]",
      );
    } catch {
      watchlist = [];
    }
  } else {
    watchlist = (data || [])
      .map((r) => ({
        id: r.id,
        symbol: String(r.symbol || "").toUpperCase(),
        entry_price: Number(r.entry_price ?? r.price ?? 0),
        qty: Number(r.qty) || 1,
        added: new Date(r.added_at || r.created_at || Date.now()).getTime(),
      }))
      .filter((r) => r.symbol)
      .sort((a, b) => a.added - b.added);
    localStorage.setItem(
      `az_watchlist_${currentUser.id}`,
      JSON.stringify(watchlist),
    );
  }
  renderWatchlist();
  renderPortfolio();
}
async function addToWatchlist(symbolInputId = "addSymbolInput", entryInputId = "addEntryPrice") {
  const symbolInput = document.getElementById(symbolInputId);
  const entryInput = document.getElementById(entryInputId);
  const sym = String(symbolInput?.value || "")
    .toUpperCase()
    .trim();
  if (!/^[A-Z][A-Z.\-]{0,9}$/.test(sym)) {
    toast("أدخل رمز سهم صحيحًا مثل AAPL", "error");
    return;
  }
  if (watchlist.some((x) => x.symbol === sym)) {
    toast("السهم موجود مسبقًا في قائمة المراقبة", "warn");
    return;
  }
  let referencePrice = Number.parseFloat(entryInput?.value || "");
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    try {
      const fetched = await fetchPrice(sym);
      referencePrice = Number.isFinite(fetched) && fetched > 0 ? fetched : 0;
    } catch (_) {
      referencePrice = 0;
    }
  }
  const localItem = {
    id: `local-${Date.now()}`,
    symbol: sym,
    entry_price: referencePrice,
    qty: 1,
    added: Date.now(),
  };
  const { data: inserted, error } = await sb
    .from("watchlist")
    .insert({
      user_id: currentUser.id,
      symbol: sym,
      entry_price: referencePrice,
      qty: 1,
    })
    .select()
    .single();
  if (error) {
    watchlist = [...watchlist, localItem];
    localStorage.setItem(
      `az_watchlist_${currentUser.id}`,
      JSON.stringify(watchlist),
    );
    await renderWatchlist();
    requestSymbolResearch(sym);
    toast("أضيف السهم محليًا، وستتم مزامنته عند عودة الاتصال", "warn");
    return;
  }
  localItem.id = inserted?.id || localItem.id;
  localStorage.setItem(
    `az_watchlist_${currentUser.id}`,
    JSON.stringify([...watchlist, localItem]),
  );
  if (symbolInput) symbolInput.value = "";
  if (entryInput) entryInput.value = "";
  await loadWatchlist();
  requestSymbolResearch(sym);
  toast(`تمت إضافة ${sym} للمراقبة والتنبيهات`, "success");
}
async function removeFromWatchlist(sym) {
  const item = watchlist.find((x) => x.symbol === sym);
  if (!item) return;
  const { error } = await sb.from("watchlist").delete().eq("id", item.id);
  if (error) {
    toast("تعذر الحذف: " + error.message, "error");
    return;
  }
  const remaining = watchlist.filter((x) => x.symbol !== sym);
  localStorage.setItem(
    `az_watchlist_${currentUser.id}`,
    JSON.stringify(remaining),
  );
  await loadWatchlist();
  toast(`🗑️ حُذف ${sym}`);
}

async function renderWatchlist() {
  const containers = [
    document.getElementById("watchlistContainer"),
    document.getElementById("dashboardWatchlistBody"),
  ].filter(Boolean);
  containers.forEach((container) => {
    container.innerHTML = "";
  });
  if (watchlist.length === 0) {
    containers.forEach((container) => {
      container.innerHTML =
        '<div class="empty-state" style="padding:20px;font-size:12px;">لا توجد أسهم متابعة</div>';
    });
    updateStats(0, 0, 0, 0, 0);
    return;
  }
  const prices = await Promise.all(watchlist.map((w) => fetchPrice(w.symbol)));
  let wins = 0,
    losses = 0,
    totalPnl = 0,
    totalInvested = 0,
    totalCurrent = 0;
  watchlist.forEach((item, i) => {
    const p = prices[i];
    const hasPrice = Number.isFinite(p) && p > 0;
    const qty = item.qty || 1;
    const reference = Number(item.entry_price || 0);
    const hasReference = Number.isFinite(reference) && reference > 0;
    const invested = hasReference ? reference * qty : 0;
    const current = hasPrice ? p * qty : null;
    const pnl = hasPrice && hasReference ? current - invested : null;
    const pct = pnl !== null && invested > 0 ? (pnl / invested) * 100 : null;
    if (hasPrice && hasReference) {
      totalPnl += pnl;
      totalInvested += invested;
      totalCurrent += current;
      pnl >= 0 ? wins++ : losses++;
    }
    const priceCell = hasPrice
      ? `$${p.toFixed(2)}`
      : '<span class="text-muted">بانتظار السعر</span>';
    const pnlCell =
      pnl !== null
        ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pct.toFixed(1)}%)`
        : "تنبيهات مفعلة";
    const referenceText = hasReference
      ? `مرجع $${reference.toFixed(2)} × ${qty}`
      : "متابعة وتنبيهات فقط";
    const rowHtml = `<div class="watch-item"><div class="watch-item-top"><span class="sym">${escapeHtml(item.symbol)}</span><span class="price ${hasPrice && pnl !== null ? (pnl >= 0 ? "text-green" : "text-red") : "text-muted"}">${priceCell}</span></div><div class="meta"><span>${referenceText}</span><span class="pnl ${pnl !== null ? (pnl >= 0 ? "text-green" : "text-red") : "text-cyan"}">${pnlCell}</span></div><button class="del" type="button" aria-label="إزالة ${escapeHtml(item.symbol)}" onclick="removeFromWatchlist('${escapeHtml(item.symbol)}')">×</button></div>`;
    containers.forEach((container) => {
      container.insertAdjacentHTML("beforeend", rowHtml);
    });
  });
  updateStats(wins, losses, totalPnl, totalInvested, totalCurrent);
}
function updateStats(w, l, pnl, invested, current) {
  if (!document.getElementById("winRecs")) {
    if (typeof renderVirtualTrader === "function") renderVirtualTrader();
    return;
  }
  document.getElementById("winRecs").textContent = w;
  document.getElementById("loseRecs").textContent = l;
  const pnlEl = document.getElementById("recReturn");
  const pctEl = document.getElementById("recReturnPct");
  const invEl = document.getElementById("totalInvested");
  const curEl = document.getElementById("totalCurrent");
  pnlEl.textContent = (pnl >= 0 ? "+" : "") + "$" + Math.abs(pnl).toFixed(2);
  pnlEl.className = "val " + (pnl >= 0 ? "pos" : "neg");
  const pct = invested > 0 ? (pnl / invested) * 100 : 0;
  pctEl.textContent = (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
  pctEl.className = "val " + (pct >= 0 ? "pos" : "neg");
  invEl.textContent = "$" + (invested || 0).toFixed(2);
  curEl.textContent = "$" + (current || 0).toFixed(2);
}
async function renderPortfolio() {
  const tb = document.getElementById("portfolioTableBody");
  tb.innerHTML = "";
  if (watchlist.length === 0) {
    tb.innerHTML =
      '<tr><td colspan="8" class="text-muted" style="text-align:center;padding:40px;">لا توجد صفقات</td></tr>';
    return;
  }
  const prices = await Promise.all(watchlist.map((w) => fetchPrice(w.symbol)));
  let totalPnl = 0,
    totalInvested = 0,
    totalCurrent = 0;
  watchlist.forEach((item, i) => {
    const p = prices[i];
    const hasPrice = Number.isFinite(p) && p > 0;
    const qty = Number(item.qty || 1);
    const entry = Number(item.entry_price || 0);
    const invested = entry > 0 ? entry * qty : 0;
    const current = hasPrice ? p * qty : null;
    const pnl = hasPrice && entry > 0 ? current - invested : null;
    const pct = pnl !== null && invested > 0 ? (pnl / invested) * 100 : null;
    const matchedPick = (LocalCache.getPicks() || []).find((pick) => pick.symbol === item.symbol);
    const guidePrice = Number(matchedPick?.entryPrice || 0);
    const statusLabel = !hasPrice ? "بانتظار السعر" : !entry ? "مراقبة" : pnl >= 0 ? "ارتفاع" : "تراجع";
    const statusClass = !hasPrice || !entry ? "text-muted" : pnl >= 0 ? "text-green" : "text-red";
    totalInvested += invested;
    if (hasPrice) {
      totalPnl += pnl;
      totalCurrent += current;
    }
    const currentCell = hasPrice
      ? `$${p.toFixed(2)}`
      : '<span class="text-muted">بانتظار السعر</span>';
    const pnlCell = pnl !== null ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : "—";
    const pctCell = pct !== null ? `${pct.toFixed(2)}%` : "—";
    const guideCell = guidePrice > 0 ? `$${guidePrice.toFixed(2)} تقريبًا` : "تُحدد مع اكتمال الإشارة";
    tb.innerHTML += `<tr><td><div class="sym">${escapeHtml(item.symbol)}</div><div class="sym-sub ${statusClass}">${statusLabel} · ${qty} سهم</div></td><td class="font-mono">${entry > 0 ? `$${entry.toFixed(2)}` : "—"}<div class="sym-sub">منطقة الدخول: ${guideCell}</div></td><td class="font-mono">${currentCell}</td><td class="font-mono ${pnl !== null ? (pnl >= 0 ? "text-green" : "text-red") : "text-muted"}">${pnlCell}</td><td class="font-mono ${pct !== null ? (pct >= 0 ? "text-green" : "text-red") : "text-muted"}">${pctCell}</td><td class="font-mono">$${invested.toFixed(2)}</td><td class="font-mono text-cyan">${hasPrice ? `$${current.toFixed(2)}` : "—"}</td><td><button type="button" class="watch-remove" aria-label="إزالة ${escapeHtml(item.symbol)}" onclick="removeFromWatchlist('${escapeHtml(item.symbol)}')">إزالة</button></td></tr>`;
  });
  if (watchlist.length > 0) {
    const totalPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
    tb.innerHTML += `<tr style="border-top:2px solid var(--border); background:rgba(0,240,255,0.03);"><td colspan="3" style="font-weight:700;">الإجمالي</td><td class="font-mono ${totalPnl >= 0 ? "text-green" : "text-red"}" style="font-weight:700;">${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}</td><td class="font-mono ${totalPct >= 0 ? "text-green" : "text-red"}" style="font-weight:700;">${totalPct.toFixed(2)}%</td><td class="font-mono">$${totalInvested.toFixed(2)}</td><td class="font-mono text-cyan" style="font-weight:700;">$${totalCurrent.toFixed(2)}</td><td></td></tr>`;
  }
}

// ===== TRIAL =====
function updateTrial() {
  if (!currentProfile) return;
  const b = document.getElementById("trialBadge");
  const btn = document.getElementById("upgradeBtn");
  if (currentProfile.role === "admin") {
    b.textContent = "أدمن";
    b.classList.remove("expired");
    btn.style.display = "none";
    return;
  }
  if (!currentProfile.trial_end) {
    b.textContent = "بانتظار التفعيل";
    b.classList.add("expired");
    btn.style.display = "none";
    return;
  }
  const diff = new Date(currentProfile.trial_end).getTime() - Date.now();
  if (diff <= 0) {
    b.textContent = "منتهي";
    b.classList.add("expired");
    btn.style.display = "inline-block";
  } else {
    const d = Math.ceil(diff / 86400000);
    b.textContent = d + " يوم متبقي";
    b.classList.remove("expired");
    btn.style.display = "inline-block";
    btn.textContent = "عرض الاشتراك والتجديد";
  }
}
function openUpgradeModal() {
  document.getElementById("upgradeModal").classList.add("active");
}
function closeUpgradeModal() {
  document.getElementById("upgradeModal").classList.remove("active");
}

const SUBSCRIPTION_PLANS = {
  monthly: {
    name: "شهر واحد",
    days: 30,
    amount: 499,
    oldAmount: 713,
    discount: 30,
  },
  quarterly: {
    name: "ثلاثة أشهر",
    days: 90,
    amount: 1399,
    oldAmount: 2332,
    discount: 40,
  },
};
async function selectSubscriptionPlan(planCode) {
  const plan = SUBSCRIPTION_PLANS[planCode];
  if (!plan || !currentUser) {
    toast("سجّل الدخول أولًا لاختيار الباقة", "warn");
    return;
  }
  const { data, error } = await sb.functions.invoke("get-payment-details");
  if (error || !data?.iban) {
    toast("تعذر تحميل بيانات التحويل؛ حاول لاحقًا", "error");
    return;
  }
  const modal = document.getElementById("upgradeModal");
  const box = modal?.querySelector(".modal-box");
  if (!box) return;
  box.innerHTML = `<h2>${escapeHtml(plan.name)} — ${plan.amount} ريال</h2>
      <div class="sub">السعر السابق ${plan.oldAmount} ريال — خصم ${plan.discount}% — التفعيل بعد تحقق المسؤول من وصول المبلغ.</div>
      <div class="pay-option"><div class="pay-title">🏦 ${escapeHtml(data.bank)}</div><div class="pay-desc">المستفيد: ${escapeHtml(data.beneficiary)}</div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:12px"><input id="paymentIban" readonly value="${escapeHtml(data.iban)}" style="flex:1;font-family:var(--font-mono);direction:ltr"><button class="btn-modal btn-modal-confirm" onclick="copyPaymentIban()">نسخ الآيبان</button></div></div>
      <div class="pay-option"><label class="pay-desc">رقم العملية أو مرجع التحويل (اختياري)</label><input id="transferReference" placeholder="أدخل رقم العملية" style="width:100%;margin-top:8px;padding:10px;border-radius:8px;background:rgba(255,255,255,.04);color:inherit;border:1px solid var(--border)"></div>
      <button class="btn-modal btn-modal-confirm" onclick="submitManualTransferOrder('${planCode}')">إرسال طلب المراجعة</button>
      <button class="btn-modal btn-modal-cancel" onclick="closeUpgradeModal()">إلغاء</button>`;
}
async function copyPaymentIban() {
  const input = document.getElementById("paymentIban");
  if (!input) return;
  await navigator.clipboard.writeText(input.value);
  toast("تم نسخ الآيبان", "success");
}
async function submitManualTransferOrder(planCode) {
  const plan = SUBSCRIPTION_PLANS[planCode];
  if (!plan || !currentUser) return;
  const transferReference =
    document.getElementById("transferReference")?.value?.trim() || null;
  const { error } = await sb.from("manual_transfer_orders").insert({
    user_id: currentUser.id,
    plan_code: planCode,
    amount_sar: plan.amount,
    transfer_reference: transferReference,
  });
  if (error) {
    toast("تعذر إرسال طلب التحويل: " + error.message, "error");
    return;
  }
  toast("تم استلام طلب التحويل — بانتظار مراجعة المسؤول", "success");
  closeUpgradeModal();
}

// ===== ADMIN (Supabase) =====
async function refreshAdminData() {
  if (!currentProfile || currentProfile.role !== "admin") return;
  const { data: users, error } = await sb
    .from("profiles")
    .select("*")
    .order("created_at", { ascending: false });
  if (error || !users) {
    toast("تعذر تحميل بيانات الأدمن: " + (error?.message || ""), "error");
    return;
  }

  document.getElementById("totalUsers").textContent = users.length;
  await loadBroadcastUsers();
  const targetSelect = document.getElementById("broadcastTargetUser");
  if (targetSelect)
    targetSelect.innerHTML =
      '<option value="">اختر مستخدمًا</option>' +
      users
        .map(
          (u) =>
            `<option value="${u.id}">${escapeHtml(u.name || u.email || u.id)}${u.id === currentUser.id ? " — حسابك" : ""}</option>`,
        )
        .join("");
  // نظام الموافقة الإدارية ملغى؛ جميع الحسابات المصادق عليها تظهر مفعّلة.
  document.getElementById("pendingUsers").textContent = "0";
  document.getElementById("activeUsers").textContent = users.filter(
    (u) => !u.trial_end || new Date(u.trial_end).getTime() > Date.now(),
  ).length;
  document.getElementById("expiredUsers").textContent = users.filter(
    (u) => u.trial_end && new Date(u.trial_end).getTime() <= Date.now(),
  ).length;

  const { data: wl } = await sb.from("watchlist").select("user_id");
  const wlCount = {};
  (wl || []).forEach(
    (w) => (wlCount[w.user_id] = (wlCount[w.user_id] || 0) + 1),
  );

  const tb = document.getElementById("adminTableBody");
  tb.innerHTML = "";
  users.forEach((u) => {
    const st =
      u.trial_end && new Date(u.trial_end).getTime() <= Date.now()
        ? '<span class="badge" style="background:var(--accent-red-dim);color:var(--accent-red);border:1px solid rgba(255,23,68,0.15);">منتهي</span>'
        : '<span class="badge" style="background:var(--accent-green-dim);color:var(--accent-green);border:1px solid rgba(0,230,118,0.15);">نشط</span>';
    const td = u.trial_end
      ? Math.ceil((new Date(u.trial_end).getTime() - Date.now()) / 86400000)
      : null;
    const tt =
      u.role === "admin"
        ? "غير محدود"
        : td !== null
          ? td > 0
            ? td + " يوم"
            : "منتهي"
          : "جارٍ إعداد التجربة";
    let act = "";
    if (u.role === "admin")
      act =
        '<span style="color:var(--accent-purple);font-size:11px;">🛡️ مسؤول</span>';
    else
      act =
        '<span style="color:var(--accent-green);font-size:11px;">✓ مفعل تلقائيًا</span>';
    tb.innerHTML += `<tr><td style="font-weight:600;">${escapeHtml(u.name || "-")}</td><td style="font-size:11px;color:var(--text-muted);">${escapeHtml(u.email)}</td><td>${st}</td><td style="font-size:11px;">${tt}</td><td class="font-mono text-cyan">${wlCount[u.id] || 0}</td><td>${act}</td></tr>`;
  });

  await refreshUpgradeRequests();
  await refreshSupportTickets();
}

const TICKET_STATUS_LABEL = {
  open: "مفتوحة",
  in_progress: "قيد المعالجة",
  resolved: "تم الحل",
  closed: "مغلقة",
};
const TICKET_PRIORITY_LABEL = {
  normal: "عادية",
  high: "مهمة",
  urgent: "عاجلة",
};
function ticketBadge(status) {
  const color =
    status === "open"
      ? "var(--accent-gold)"
      : status === "in_progress"
        ? "var(--accent-cyan)"
        : status === "resolved"
          ? "var(--accent-green)"
          : "var(--text-muted)";
  return `<span class="badge" style="color:${color};border:1px solid ${color};background:transparent;">${escapeHtml(TICKET_STATUS_LABEL[status] || status)}</span>`;
}
async function submitSupportTicket() {
  const subject = document.getElementById("ticketSubject")?.value.trim();
  const message = document.getElementById("ticketMessage")?.value.trim();
  const priority = document.getElementById("ticketPriority")?.value || "normal";
  if (!subject || subject.length < 3 || !message || message.length < 5) {
    toast("اكتب عنوانًا وتفاصيل كافية للتذكرة", "warn");
    return;
  }
  const { data: ticket, error } = await sb
    .from("support_tickets")
    .insert({ user_id: currentUser.id, subject, message, priority })
    .select("id")
    .single();
  if (error) {
    toast("تعذر إرسال التذكرة: " + error.message, "error");
    return;
  }
  document.getElementById("ticketSubject").value = "";
  document.getElementById("ticketMessage").value = "";
  toast("✅ تم إرسال التذكرة للمسؤول");
  const { error: notifyError } = await sb.functions.invoke(
    "notify-support-ticket",
    { body: { ticketId: ticket.id } },
  );
  if (notifyError) {
    console.error("support email notification error:", notifyError);
    toast("تم حفظ التذكرة، لكن تعذر إرسال بريد التنبيه للمسؤول حاليًا", "warn");
  }
  await loadMySupportTickets();
}
async function loadMySupportTickets() {
  const tb = document.getElementById("myTicketsBody");
  if (!tb || !currentUser) return;
  const { data, error } = await sb
    .from("support_tickets")
    .select("*")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false });
  if (error) {
    tb.innerHTML = `<tr><td colspan="5" class="text-muted">تعذر تحميل التذاكر</td></tr>`;
    return;
  }
  if (!data?.length) {
    tb.innerHTML =
      '<tr><td colspan="5" class="text-muted" style="padding:20px;text-align:center;">لا توجد تذاكر حتى الآن</td></tr>';
    return;
  }
  tb.innerHTML = data
    .map(
      (t) =>
        `<tr><td>${new Date(t.created_at).toLocaleString("ar-SA")}</td><td>${escapeHtml(t.subject)}<div class="text-muted" style="font-size:11px;white-space:pre-wrap;">${escapeHtml(normalizeDbText(t.message))}</div></td><td>${escapeHtml(TICKET_PRIORITY_LABEL[t.priority] || t.priority)}</td><td>${ticketBadge(t.status)}</td><td style="white-space:pre-wrap;">${escapeHtml(normalizeDbText(t.admin_reply) || "بانتظار رد المسؤول")}</td></tr>`,
    )
    .join("");
}
async function refreshSupportTickets() {
  const tb = document.getElementById("adminTicketsBody");
  if (!tb || !currentProfile || currentProfile.role !== "admin") return;
  const { data: tickets, error } = await sb
    .from("support_tickets")
    .select("*")
    .order("created_at", { ascending: false });
  if (error || !tickets?.length) {
    tb.innerHTML =
      '<tr><td colspan="6" class="text-muted" style="padding:20px;text-align:center;">لا توجد تذاكر دعم</td></tr>';
    return;
  }
  const ids = [...new Set(tickets.map((t) => t.user_id))];
  const { data: profs } = await sb
    .from("profiles")
    .select("id,name,email")
    .in("id", ids);
  const map = Object.fromEntries((profs || []).map((p) => [p.id, p]));
  tb.innerHTML = tickets
    .map((t) => {
      const p = map[t.user_id] || {};
      return `<tr><td>${escapeHtml(p.name || p.email || "-")}</td><td><strong>${escapeHtml(t.subject)}</strong><div class="text-muted" style="font-size:11px;white-space:pre-wrap;">${escapeHtml(normalizeDbText(t.message))}</div></td><td>${escapeHtml(TICKET_PRIORITY_LABEL[t.priority] || t.priority)}</td><td>${ticketBadge(t.status)}</td><td>${new Date(t.created_at).toLocaleDateString("ar-SA")}</td><td><button class="admin-btn btn-approve" onclick="replySupportTicket('${t.id}')">رد</button><button class="admin-btn" onclick="setSupportStatus('${t.id}','in_progress')">قيد المعالجة</button><button class="admin-btn btn-approve" onclick="setSupportStatus('${t.id}','resolved')">حل</button></td></tr>`;
    })
    .join("");
}
async function replySupportTicket(id) {
  const reply = prompt("اكتب ردك على التذكرة:");
  if (reply === null) return;
  if (reply.trim().length < 2) {
    toast("الرد قصير جدًا", "warn");
    return;
  }
  const { error } = await sb
    .from("support_tickets")
    .update({
      admin_reply: reply.trim(),
      status: "in_progress",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) {
    toast("تعذر حفظ الرد: " + error.message, "error");
    return;
  }
  toast("✅ تم إرسال الرد");
  refreshSupportTickets();
}
async function setSupportStatus(id, status) {
  const { error } = await sb
    .from("support_tickets")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    toast("تعذر تحديث الحالة: " + error.message, "error");
    return;
  }
  toast("✅ تم تحديث حالة التذكرة");
  refreshSupportTickets();
}

async function approveUser(uid) {
  if (!confirm("قبول المستخدم وتفعيل تجربة 60 يوماً؟")) return;
  const { error } = await sb.rpc("approve_new_user", { target_user_id: uid });
  if (error) {
    toast("تعذرت الموافقة: " + error.message, "error");
    return;
  }
  toast("✅ تم القبول");
  refreshAdminData();
}

async function refreshUpgradeRequests() {
  const tb = document.getElementById("upgradeRequestsBody");
  if (!tb) return;
  const { data: reqs, error } = await sb
    .from("upgrade_requests")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error || !reqs || !reqs.length) {
    tb.innerHTML =
      '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:20px;">لا توجد طلبات معلقة</td></tr>';
    return;
  }

  const userIds = [...new Set(reqs.map((r) => r.user_id))];
  const { data: profs } = await sb
    .from("profiles")
    .select("id,name,email")
    .in("id", userIds);
  const profMap = Object.fromEntries((profs || []).map((p) => [p.id, p]));

  tb.innerHTML = "";
  for (const r of reqs) {
    const p = profMap[r.user_id] || {};
    const { data: signed } = await sb.storage
      .from("receipts")
      .createSignedUrl(r.receipt_path, 3600);
    const link = signed
      ? `<a class="receipt-link" href="${signed.signedUrl}" target="_blank">عرض الإيصال</a>`
      : "—";
    tb.innerHTML += `<tr><td>${escapeHtml(p.name || "-")}</td><td style="font-size:11px;color:var(--text-muted);">${escapeHtml(p.email || "-")}</td><td style="font-size:11px;">${new Date(r.created_at).toLocaleDateString("ar-SA")}</td><td>${link}</td><td><button class="admin-btn btn-approve" onclick="reviewUpgrade('${r.id}','approved')">قبول</button><button class="admin-btn btn-reject" onclick="reviewUpgrade('${r.id}','rejected')">رفض</button></td></tr>`;
  }
}

async function reviewUpgrade(requestId, status) {
  if (
    !confirm(
      status === "approved"
        ? "تفعيل اشتراك شهري لمدة 30 يومًا لهذا المستخدم؟"
        : "رفض الطلب؟",
    )
  )
    return;
  const { error } = await sb.rpc("review_upgrade_request", {
    request_id: requestId,
    new_status: status,
    extend_days: 30,
  });
  if (error) {
    toast("فشل الإجراء: " + error.message, "error");
    return;
  }
  toast(status === "approved" ? "✅ تم التفعيل" : "❌ تم الرفض");
  refreshAdminData();
}

// ===== OWNER BROADCASTS =====
async function loadBroadcastUsers() {
  const select = document.getElementById("broadcastTargetUser");
  if (!select || !currentProfile || currentProfile.role !== "admin") return;
  select.innerHTML = '<option value="">جارٍ تحميل المستخدمين...</option>';
  const { data, error } = await sb
    .from("profiles")
    .select("id,name,email")
    .order("created_at", { ascending: false });
  if (error) {
    select.innerHTML = '<option value="">تعذر تحميل المستخدمين</option>';
    console.warn("broadcast users", error);
    return;
  }
  const users = data || [];
  select.innerHTML = users.length
    ? '<option value="">اختر مستخدمًا</option>' +
      users
        .map(
          (u) =>
            `<option value="${u.id}">${escapeHtml(u.name || u.email || `مستخدم ${String(u.id).slice(0, 8)}`)}${u.id === currentUser.id ? " — حسابك" : ""}${u.email && u.name ? ` — ${escapeHtml(u.email)}` : ""}</option>`,
        )
        .join("")
    : '<option value="">لا يوجد مستخدمون</option>';
}
async function toggleBroadcastAudience() {
  const type = document.getElementById("broadcastAudience")?.value || "all";
  const wrap = document.getElementById("broadcastUserWrap");
  if (wrap) wrap.style.display = type === "user" ? "block" : "none";
  if (type === "user") await loadBroadcastUsers();
}

async function publishOwnerBroadcast() {
  if (!currentProfile || currentProfile.role !== "admin")
    return toast("هذه الأداة متاحة للمالك فقط", "error");
  const title = String(
    document.getElementById("broadcastTitle")?.value || "",
  ).trim();
  const body = String(
    document.getElementById("broadcastBody")?.value || "",
  ).trim();
  if (title.length < 2 || body.length < 2)
    return toast("أدخل عنوانًا ونصًا للإشعار", "warn");
  const audienceType =
    document.getElementById("broadcastAudience")?.value || "all";
  const targetUserId =
    document.getElementById("broadcastTargetUser")?.value || null;
  if (audienceType === "user" && !targetUserId)
    return toast("اختر المستخدم المحدد أولًا", "warn");
  const file = document.getElementById("broadcastImage")?.files?.[0];
  let imageUrl = null;
  try {
    if (file) {
      if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024)
        return toast("الصورة يجب أن تكون أقل من 5MB", "warn");
      const path = `${currentUser.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const upload = await sb.storage
        .from("broadcast-media")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upload.error) throw upload.error;
      imageUrl = sb.storage.from("broadcast-media").getPublicUrl(path)
        .data.publicUrl;
    }
    const endsValue = document.getElementById("broadcastEndsAt")?.value;
    const payload = {
      created_by: currentUser.id,
      title,
      body,
      image_url: imageUrl,
      audience_type: audienceType,
      target_user_id: audienceType === "user" ? targetUserId : null,
      popup_enabled: !!document.getElementById("broadcastPopup")?.checked,
      push_enabled: !!document.getElementById("broadcastPush")?.checked,
      email_enabled: !!document.getElementById("broadcastEmail")?.checked,
      ends_at: endsValue ? new Date(endsValue).toISOString() : null,
      status: "published",
      published_at: new Date().toISOString(),
    };
    const { data, error } = await sb
      .from("admin_broadcasts")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw error;
    toast("تم نشر الإعلان وحفظه بنجاح", "success");
    ["broadcastTitle", "broadcastBody", "broadcastEndsAt"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    const img = document.getElementById("broadcastImage");
    if (img) img.value = "";
    if (payload.push_enabled || payload.email_enabled) {
      const { data: sessionData } = await sb.auth.getSession();
      await fetch(`${SUPABASE_URL}/functions/v1/send-admin-broadcast`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${sessionData?.session?.access_token || ""}`,
        },
        body: JSON.stringify({ broadcast_id: data.id }),
      });
    }
  } catch (e) {
    console.error("owner broadcast error", e);
    toast("تعذر إرسال الإعلان: " + (e?.message || "خطأ غير معروف"), "error");
  }
}
function closeOwnerAnnouncement() {
  const modal = document.getElementById("ownerAnnouncementModal");
  if (modal) {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }
}
async function loadActiveOwnerAnnouncement() {
  const { data, error } = await sb
    .from("admin_broadcasts")
    .select("id,title,body,image_url")
    .eq("status", "published")
    .eq("popup_enabled", true)
    .lte("starts_at", new Date().toISOString())
    .or(`audience_type.eq.all,target_user_id.eq.${currentUser.id}`)
    .or(`ends_at.is.null,ends_at.gt.${new Date().toISOString()}`)
    .order("published_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const seenKey = currentUser ? `az_broadcast_seen_${currentUser.id}_${data?.id || ""}` : "";
  if (error || !data || (seenKey && localStorage.getItem(seenKey))) return false;
  document.getElementById("ownerAnnouncementTitle").textContent =
    normalizeDbText(data.title);
  document.getElementById("ownerAnnouncementBody").textContent =
    normalizeDbText(data.body);
  const img = document.getElementById("ownerAnnouncementImage");
  if (img) {
    img.style.display = data.image_url ? "block" : "none";
    img.src = data.image_url || "";
  }
  const modal = document.getElementById("ownerAnnouncementModal");
  if (modal) {
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
  }
  if (seenKey) localStorage.setItem(seenKey, "1");
  return true;
}

// ===== OWNERSHIP / COPY DETERRENCE =====
(function installOwnershipNotice() {
  document.addEventListener("contextmenu", (event) => {
    if (!event.target.closest('input,textarea,[contenteditable="true"]'))
      event.preventDefault();
  });
  document.addEventListener("keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      ["c", "u", "s"].includes(event.key.toLowerCase()) &&
      !event.target.closest('input,textarea,[contenteditable="true"]')
    )
      event.preventDefault();
  });
})();

// ===== SESSION RESTORE ON LOAD =====
document.addEventListener("DOMContentLoaded", async () => {
  sb.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY")
      setTimeout(() => completePasswordRecovery(), 0);
  });
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (session) await loadSessionAndEnter();
  else if (new URLSearchParams(window.location.search).get("register") === "1")
    switchAuth("register");
});

// ===== 800+ STOCK UNIVERSE (fetch_market_data.py fetches real data for exactly this list — keep both in sync) =====
const STOCK_UNIVERSE = [
  "AAPL",
  "MSFT",
  "GOOGL",
  "GOOG",
  "AMZN",
  "NVDA",
  "META",
  "TSLA",
  "AVGO",
  "PEP",
  "COST",
  "ADBE",
  "NFLX",
  "AMD",
  "INTC",
  "CSCO",
  "CRM",
  "ACN",
  "TXN",
  "QCOM",
  "AMAT",
  "INTU",
  "ADP",
  "MU",
  "LRCX",
  "KLAC",
  "MRVL",
  "NXPI",
  "SNPS",
  "CDNS",
  "ANSS",
  "PTC",
  "FTNT",
  "PANW",
  "CRWD",
  "SNOW",
  "PLTR",
  "DDOG",
  "NET",
  "OKTA",
  "ZS",
  "SPLK",
  "VEEV",
  "WDAY",
  "NOW",
  "TEAM",
  "DOCU",
  "ZM",
  "U",
  "RBLX",
  "ABNB",
  "UBER",
  "LYFT",
  "DASH",
  "SQ",
  "PYPL",
  "SHOP",
  "SPOT",
  "TWLO",
  "SNAP",
  "PINS",
  "MTCH",
  "BMBL",
  "RDFN",
  "Z",
  "OPEN",
  "EXPE",
  "BKNG",
  "TRIP",
  "GDRX",
  "RXRX",
  "TDOC",
  "AMGN",
  "GILD",
  "BIIB",
  "REGN",
  "VRTX",
  "ILMN",
  "DXCM",
  "TMO",
  "DHR",
  "ISRG",
  "ZBH",
  "BSX",
  "ABT",
  "SYK",
  "BDX",
  "MDT",
  "EW",
  "HOLX",
  "IDXX",
  "WAT",
  "A",
  "MTD",
  "PKI",
  "BRKR",
  "WST",
  "COO",
  "ALGN",
  "SGEN",
  "MRNA",
  "BNTX",
  "NVAX",
  "JNJ",
  "MRK",
  "PFE",
  "ABBV",
  "BMY",
  "LLY",
  "NVO",
  "AZN",
  "GSK",
  "SNY",
  "RPRX",
  "VTRS",
  "CTLT",
  "DVA",
  "FMS",
  "UHS",
  "CYH",
  "LPNT",
  "HCA",
  "THC",
  "MPW",
  "OHI",
  "WELL",
  "VTR",
  "PEAK",
  "HCP",
  "SBRA",
  "HR",
  "RHP",
  "SLG",
  "BXP",
  "VNO",
  "ARE",
  "QTS",
  "DLR",
  "CCI",
  "AMT",
  "SBAC",
  "WY",
  "RYN",
  "PCH",
  "CLF",
  "NUE",
  "STLD",
  "MT",
  "X",
  "RS",
  "CMC",
  "TMST",
  "ATI",
  "KALU",
  "SCHN",
  "WOR",
  "ZEUS",
  "ASTL",
  "CENX",
  "AA",
  "KGC",
  "NEM",
  "GOLD",
  "AEM",
  "FNV",
  "WPM",
  "RGLD",
  "OR",
  "AUY",
  "EGO",
  "AGI",
  "BTG",
  "HL",
  "CDE",
  "PAAS",
  "SSRM",
  "MAG",
  "SVM",
  "EXK",
  "GPL",
  "LODE",
  "TRX",
  "THM",
  "NGD",
  "MUX",
  "GORO",
  "DRD",
  "SA",
  "SAND",
  "ORLA",
  "FVI",
  "SILV",
  "AG",
  "FSM",
  "HYMC",
  "GROY",
  "MTA",
  "REVG",
  "OSK",
  "NAV",
  "WNC",
  "PACCAR",
  "CMI",
  "PCAR",
  "REV",
  "MGA",
  "LEA",
  "ALV",
  "GNTX",
  "DLPH",
  "BWA",
  "TEN",
  "VC",
  "AXL",
  "MOD",
  "SMP",
  "DORM",
  "STRT",
  "SUP",
  "CTB",
  "GT",
  "RGR",
  "SWBI",
  "VSTO",
  "AOUT",
  "POWW",
  "RBC",
  "TWI",
  "CUB",
  "KWR",
  "HAYN",
  "FUBO",
  "AMC",
  "BBBY",
  "GME",
  "M",
  "NOK",
  "PFE",
  "BAC",
  "C",
  "WFC",
  "CSCO",
  "INTC",
  "AMD",
  "MU",
  "T",
  "VZ",
  "TMUS",
  "CMCSA",
  "SIRI",
  "TWLO",
  "RIVN",
  "LCID",
  "PLUG",
  "FSLR",
  "ENPH",
  "SPWR",
  "NIO",
  "XPEV",
  "BYND",
  "JMIA",
  "SKLZ",
  "U",
  "CRNC",
  "DOCU",
  "ZM",
  "WORK",
  "DKNG",
  "RBLX",
  "ABNB",
  "UBER",
  "WBD",
  "PARA",
  "FOXA",
  "NWSA",
  "NYT",
  "META",
  "SNAP",
  "PINS",
  "MTCH",
  "BMBL",
  "RDFN",
  "Z",
  "OPEN",
  "EXPE",
  "BKNG",
  "TRIP",
  "UBER",
  "LYFT",
  "DASH",
  "GDRX",
  "RXRX",
  "TDOC",
  "AMZN",
  "WMT",
  "TGT",
  "KSS",
  "JCP",
  "BIG",
  "RAD",
  "DPZ",
  "PZZA",
  "YUM",
  "MCD",
  "CMG",
  "MRNA",
  "BNTX",
  "NVAX",
  "AZN",
  "GSK",
  "ILMN",
  "DXCM",
  "TMO",
  "DHR",
  "BRKR",
  "VEEV",
  "CDNS",
  "SNPS",
  "ANSS",
  "ADSK",
  "ADBE",
  "INTU",
  "NOW",
  "CRM",
  "TEAM",
  "WORK",
  "FSLY",
  "FTNT",
  "PANW",
  "NET",
  "ZS",
  "OKTA",
  "PSTG",
  "MDB",
  "DDOG",
  "CONN",
  "IOT",
  "AI",
  "SOUN",
  "NVDA",
  "CRWD",
  "HUBS",
  "TWLO",
  "S",
  "ZUO",
  "EGHT",
  "AVGO",
  "MRVL",
  "TXN",
  "ADI",
  "QCOM",
  "NXPI",
  "SWKS",
  "QRVO",
  "TECH",
  "AMD",
  "INTC",
  "MU",
  "NTAP",
  "PSTG",
  "WDC",
  "STX",
  "SE",
  "PINS",
  "TTD",
  "MGNI",
  "PUBM",
  "CMPR",
  "LDI",
  "BIGC",
  "ETSY",
  "WISH",
  "CART",
  "EBAY",
  "AMZN",
  "WMT",
  "TGT",
  "ROST",
  "TJX",
  "BOOT",
  "BKE",
  "DDS",
  "M",
  "JWN",
  "GES",
  "ANF",
  "URBN",
  "ZUMZ",
  "CPRI",
  "PVH",
  "RL",
  "KORS",
  "COH",
  "OXM",
  "SHOO",
  "CWH",
  "GIII",
  "LEVI",
  "SCVL",
  "HIBB",
  "GPS",
  "DBI",
  "KTB",
  "CAL",
  "CROX",
  "WHR",
  "ARHS",
  "WSM",
  "RH",
  "BYON",
  "NWHM",
  "TDOC",
  "MDU",
  "LNT",
  "CMS",
  "D",
  "ED",
  "ES",
  "EIX",
  "EXC",
  "FE",
  "DTE",
  "XEL",
  "AEP",
  "PEG",
  "ETR",
  "NEE",
  "SO",
  "DUK",
  "BK",
  "RY",
  "TD",
  "PNC",
  "USB",
  "TFC",
  "COF",
  "SYF",
  "ALLY",
  "DFS",
  "FITB",
  "KEY",
  "HBAN",
  "ZION",
  "CMA",
  "PB",
  "TCF",
  "UMB",
  "IBKR",
  "SCHW",
  "MS",
  "GS",
  "JPM",
  "C",
  "BAC",
  "WFC",
  "MTB",
  "PPBI",
  "FRC",
  "WAL",
  "PACW",
  "SIVB",
  "MUFG",
  "SMFG",
  "JEF",
  "RJF",
  "FHI",
  "NTRS",
  "STT",
  "RF",
  "VLY",
  "TBBK",
  "BSBR",
  "ITUB",
  "BBD",
  "SBS",
  "ABEV",
  "BRFS",
  "ERJ",
  "GOL",
  "AZUL",
  "BZ",
  "VALE",
  "GGB",
  "CSAN",
  "RAD",
  "SU",
  "HMC",
  "TM",
  "STLA",
  "F",
  "GM",
  "TSLA",
  "RIVN",
  "LCID",
  "NIO",
  "XPEV",
  "BYD",
  "HOG",
  "PII",
  "NTLA",
  "BEAM",
  "CRSP",
  "NKTR",
  "AZN",
  "GSK",
  "MRNA",
  "BNTX",
  "NVAX",
  "JNJ",
  "MRK",
  "PFE",
  "ABBV",
  "BMY",
  "GILD",
  "AMGN",
  "BIIB",
  "REGN",
  "VRTX",
  "QRTEA",
  "TDOC",
  "HUM",
  "UNH",
  "CNC",
  "ANTM",
  "WBA",
  "CVS",
  "TGT",
  "AAP",
  "KMX",
  "AZO",
  "ORLY",
  "GPC",
  "PAG",
  "GPI",
  "ABG",
  "SAH",
  "LAD",
  "MUSA",
  "BC",
  "ALSN",
  "OSK",
  "REV",
  "PATK",
  "BLD",
  "OC",
  "LPX",
  "BECN",
  "EPC",
  "BUR",
  "CARR",
  "AA",
  "ALB",
  "AA",
  "FMC",
  "ECL",
  "DD",
  "DOW",
  "RPM",
  "SHW",
  "PPG",
  "HXL",
  "WLK",
  "CE",
  "LYB",
  "EMN",
  "ALB",
  "NTR",
  "CTVA",
  "BA",
  "RTX",
  "LMT",
  "NOC",
  "GD",
  "LHX",
  "AXE",
  "MRCY",
  "HXL",
  "TEL",
  "APH",
  "ROL",
  "HII",
  "SPR",
  "WWD",
  "CW",
  "NOC",
  "GD",
  "RTX",
  "LMT",
  "BHE",
  "PNR",
  "ITW",
  "GWW",
  "FAST",
  "SNA",
  "LECO",
  "CAT",
  "DE",
  "CNHI",
  "AGCO",
  "TEX",
  "MTW",
  "ASTE",
  "POWL",
  "DORM",
  "WNC",
  "SUPV",
  "HTZ",
  "CAR",
  "AAL",
  "DAL",
  "UAL",
  "JBLU",
  "ALK",
  "SAVE",
  "HA",
  "ASIX",
  "AHCO",
  "MDT",
  "BSX",
  "ABT",
  "SYK",
  "BDX",
  "BAX",
  "DHR",
  "TMO",
  "ZBH",
  "CNMD",
  "VAR",
  "ANIK",
  "ATRC",
  "BDX",
  "BSX",
  "MDT",
  "SYK",
  "ABT",
  "ZBH",
  "TMO",
  "DHR",
  "NEO",
  "LIVN",
  "NVRO",
  "SIBN",
  "HOLX",
  "NOVT",
  "TWST",
  "ATOM",
  "EXAS",
  "QGEN",
  "NEO",
  "FMI",
  "GH",
  "EXEL",
  "AUTL",
  "ALXN",
  "CBM",
  "IOVA",
  "BMRN",
  "DAWN",
  "CYTK",
  "ACAD",
  "CNCE",
  "ARNA",
  "EYPT",
  "ACHV",
  "ADVM",
  "AGEN",
  "ALLO",
  "ALXN",
  "AMRN",
  "AMRS",
  "ARPO",
  "AVRO",
  "BGNE",
  "BHVN",
  "BLUE",
  "CALA",
  "CLVS",
  "CRIS",
  "CRMD",
  "CRTX",
  "CTMX",
  "CVAC",
  "CYRX",
  "DVAX",
  "EIGR",
  "EMRA",
  "EPZM",
  "ESPR",
  "EVFN",
  "FBIO",
  "FGEN",
  "FOLD",
  "GERN",
  "GLUE",
  "HARP",
  "HGEN",
  "HLGN",
  "IMGN",
  "IMTX",
  "INO",
  "JAGX",
  "KALA",
  "KPTI",
  "LGVN",
  "LOGC",
  "LXRX",
  "MBIO",
  "MESO",
  "MGNX",
  "MRNS",
  "MVC",
  "NDVA",
  "OCGN",
  "OLMA",
  "ONCE",
  "ORGS",
  "PDSB",
  "PTC",
  "RAPT",
  "REPL",
  "REPT",
  "SAGE",
  "SCPH",
  "SGEN",
  "SLNO",
  "SRPT",
  "STOK",
  "TAK",
  "TCBP",
  "TCRX",
  "TH",
  "TKAI",
  "TLSA",
  "URGN",
  "VANI",
  "VERU",
  "VIRC",
  "VIRX",
  "VSTM",
  "XBIT",
  "XENE",
  "XNCR",
  "ZLAB",
  "ALT",
  "AMC",
  "CWH",
  "DDS",
  "GES",
  "HIBB",
  "JWN",
  "KSS",
  "M",
  "URBN",
  "WISH",
  "GME",
  "BBBY",
  "M",
  "JCP",
  "BIG",
  "RAD",
  "KSS",
  "JWN",
  "ANF",
  "GES",
  "HIBB",
  "URBN",
  "ZUMZ",
  "CHS",
  "CWH",
  "DDS",
  "GES",
  "JWN",
  "KSS",
  "M",
  "URBN",
  "WISH",
  "GME",
  "BBBY",
  "SOFI",
  "AFRM",
  "UPST",
  "HOOD",
  "COIN",
  "PLTR",
  "SNOW",
  "DDOG",
  "NET",
  "CRWD",
  "OKTA",
  "ZS",
  "S",
  "MDB",
  "ESTC",
  "SMAR",
  "ASAN",
  "MNDY",
  "AI",
  "SOUN",
  "BBAI",
  "AMST",
  "DUOT",
  "LTRX",
  "RXT",
  "SSTI",
  "VRNS",
  "RPD",
  "TENB",
  "CYBR",
  "QLYS",
  "SUMO",
  "DOMO",
  "PLAN",
  "MOND",
  "BABA",
  "JD",
  "PDD",
  "NTES",
  "BIDU",
  "TCEHY",
  "TCOM",
  "VIPS",
  "MOMO",
  "YY",
  "HUYA",
  "DOYU",
  "FUTU",
  "TIGR",
  "LU",
  "FINV",
  "QFIN",
  "LX",
  "YRD",
  "JT",
  "PPDF",
  "XYF",
  "LI",
  "FSR",
  "GOEV",
  "MULN",
  "NKLA",
  "WKHS",
  "RIDE",
  "QS",
  "SPWR",
  "SEDG",
  "RUN",
  "NOVA",
  "CWEN",
  "AY",
  "SRE",
  "WEC",
  "ATO",
  "SWX",
  "NFG",
  "OGS",
  "SR",
  "SPH",
  "FGP",
  "APU",
  "SUG",
  "CMLP",
  "DPM",
  "EPD",
  "ETP",
  "KMP",
  "MMP",
  "MWE",
  "BPL",
  "BWP",
  "CPNO",
  "DCP",
  "ENLK",
  "EXLP",
  "GLP",
  "HEP",
  "MMLP",
  "NS",
  "OKS",
  "PAA",
  "SXL",
  "TCP",
  "TLP",
  "WES",
  "WPZ",
  "XTEX",
  "APL",
  "ATLS",
  "EEP",
  "ETP",
  "GEL",
  "CGC",
  "TLRY",
  "ACB",
  "CRON",
  "SNDL",
  "GTBIF",
  "TCNNF",
  "CURLF",
  "CRLBF",
  "PLNHF",
  "VRNOF",
  "GDNSF",
  "AYRWF",
  "JUSHF",
  "MSOS",
  "MJ",
  "YOLO",
  "POTX",
  "THCX",
  "TOKE",
  "ACT",
  "SPCE",
  "RKLB",
  "ASTS",
  "MNTS",
  "VORB",
  "REDWIRE",
  "SATL",
  "BKSY",
  "MYNA",
  "SPIR",
  "ASTR",
  "LLAP",
  "SIDU",
  "SATS",
  "GSAT",
  "IRDM",
  "VSAT",
  "MAXR",
  "DDD",
  "SSYS",
  "DM",
  "MKFG",
  "VLD",
  "MTLS",
  "NNDM",
  "XONE",
  "PRLB",
  "ATVI",
  "EA",
  "TTWO",
  "PLTK",
  "SCPL",
  "GLUU",
  "ZNGA",
  "XOM",
  "CVX",
  "COP",
  "EOG",
  "SLB",
  "OXY",
  "MPC",
  "VLO",
  "PSX",
  "MRO",
  "DVN",
  "FANG",
  "PXD",
  "OVV",
  "APA",
  "CHRD",
  "SM",
  "MTDR",
  "PE",
  "GPOR",
  "RRC",
  "AR",
  "SWN",
  "CTRA",
  "EQT",
  "CNX",
  "RICE",
  "NFG",
  "UPS",
  "FDX",
  "CHRW",
  "EXPD",
  "XPO",
  "SAIA",
  "ODFL",
  "LSTR",
  "ARCB",
  "HTLD",
  "MRTN",
  "WERN",
  "KNX",
  "JBHT",
  "SWFT",
  "CGNX",
  "ZTO",
  "YMM",
  "DIDI",
  "GRUB",
  "TKAY",
  "GETR",
  "DADA",
  "GOGO",
  "ATSG",
  "ABSTS",
  "AIR",
  "AIRT",
  "MOS",
  "CF",
  "GE",
  "HON",
  "MMM",
];
const UNIQUE_STOCKS = [...new Set(STOCK_UNIVERSE)];

const SECTOR_MAP = {}; // لم يعد يُستخدَم لتصنيف الفحص (ذلك يأتي الآن من Finviz عبر market_fundamentals.sector) — أُبقي فارغًا عمدًا؛ محفوظ فقط لتفادي كسر أي مرجع قديم متبقٍّ.
const SECTOR_LABELS = {
  tech: "تكنولوجيا",
  consumer: "استهلاكي",
  industrial: "صناعي",
  healthcare: "صحية",
  energy: "طاقة",
  finance: "مالي",
  communication: "اتصالات",
  materials: "مواد أساسية",
  utilities: "مرافق",
  reits: "عقارات",
  other: "أخرى",
};
const KNOWN_SECTOR_TICKERS = {
  AAPL: "tech",
  MSFT: "tech",
  GOOGL: "tech",
  GOOG: "tech",
  AMZN: "consumer",
  NVDA: "tech",
  TSLA: "consumer",
  META: "communication",
  AMD: "tech",
  NFLX: "communication",
  CRM: "tech",
  SHOP: "tech",
  UBER: "industrial",
  ABNB: "consumer",
  COIN: "finance",
  ROKU: "communication",
  SNAP: "communication",
  PINS: "communication",
  CRWD: "tech",
  PLTR: "tech",
  SNOW: "tech",
  DDOG: "tech",
  NET: "tech",
  OKTA: "tech",
  ZS: "tech",
  FSLR: "energy",
  ENPH: "energy",
  SOFI: "finance",
  HOOD: "finance",
  AI: "tech",
  MU: "tech",
  AVGO: "tech",
  INTC: "tech",
  QCOM: "tech",
  AMAT: "tech",
  COST: "consumer",
  WMT: "consumer",
  HD: "consumer",
  NKE: "consumer",
  SBUX: "consumer",
  DIS: "communication",
  V: "finance",
  MA: "finance",
  JPM: "finance",
  BAC: "finance",
  XOM: "energy",
  CVX: "energy",
  CAT: "industrial",
  BA: "industrial",
  GE: "industrial",
  JNJ: "healthcare",
  PFE: "healthcare",
  UNH: "healthcare",
  LLY: "healthcare",
};
function classifySector(row) {
  const sym = String(row?.symbol || "").toUpperCase();
  if (KNOWN_SECTOR_TICKERS[sym]) return KNOWN_SECTOR_TICKERS[sym];
  const raw = String(row?.sector || row?.finviz_sector || "")
    .trim()
    .toLowerCase();
  if (SECTOR_LABELS[raw] && raw !== "other") return raw;
  if (/technolog|software|semiconductor|internet|electronic|computer|cloud|chip/.test(raw))
    return "tech";
  if (/consumer|retail|staples|discretionary/.test(raw)) return "consumer";
  if (/industrial|manufactur|aerospace/.test(raw)) return "industrial";
  if (/health|biotech|pharma/.test(raw)) return "healthcare";
  if (/energy|oil|gas|solar/.test(raw)) return "energy";
  if (/financ|bank|insurance/.test(raw)) return "finance";
  if (/communicat|media|telecom/.test(raw)) return "communication";
  if (/material|mining|metal|chemical/.test(raw)) return "materials";
  if (/utilit/.test(raw)) return "utilities";
  if (/real estate|reit/.test(raw)) return "reits";
  const text = [row?.industry, row?.company, row?.finviz_sector]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/software|semiconductor|chip|cloud|internet|cyber|computer|electronic|technology|network|data|saas/.test(text))
    return "tech";
  if (/retail|consumer|apparel|restaurant|food|beverage|cosmetic/.test(text))
    return "consumer";
  if (/industrial|manufactur|machinery|aerospace|defense|construction|transport|logistics|airline/.test(text))
    return "industrial";
  if (/healthcare|health care|biotech|pharma|therapeutic|medical|hospital/.test(text))
    return "healthcare";
  if (/energy|oil|gas|petroleum|solar|utilities|electric/.test(text)) return "energy";
  if (/bank|banc|financial|insurance|capital/.test(text)) return "finance";
  if (/telecom|communication|media|broadcast/.test(text)) return "communication";
  if (/mining|metal|steel|chemical|materials/.test(text)) return "materials";
  if (/real estate|property|reit/.test(text)) return "reits";
  return raw && raw !== "other" ? raw : "other";
}
function sectorLabel(key) {
  return SECTOR_LABELS[key] || key || "—";
}
function formatShareVolume(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

const EXCLUDED_SYMBOLS = new Set([
  "DDV",
  "CCDE",
  "CCODA",
  "AASYS",
  "CCRSR",
  "AAI",
  "AAIRG",
  "AAMRZ",
  "AAOUT",
  "AAPEI",
  "BBKKT",
  "BRBI",
  "WD",
  "LUCK",
  "TAL",
  "EDU",
  "GSX",
  "STG",
  "FANH",
  "QTT",
  "UXIN",
  "SOGO",
  "QFIN",
  "FINV",
  "YRD",
  "JT",
  "PPDF",
  "XYF",
  "NIO",
  "XPEV",
  "LI",
  "BYD",
  "F",
  "GM",
  "HOG",
  "PII",
  "NKLA",
  "WKHS",
  "RIDE",
  "GOEV",
  "MULN",
  "FSR",
  "LCID",
  "RIVN",
  "AMC",
  "GME",
  "BBBY",
  "M",
  "JCP",
  "BIG",
  "RAD",
  "EXPR",
  "KOSS",
  "NAKD",
  "SNDL",
  "TLRY",
  "ACB",
  "CRON",
  "OGI",
  "HEXO",
  "CGC",
  "JAGX",
  "INO",
  "OCGN",
  "OLMA",
  "ONCE",
  "ORGS",
  "PDSB",
  "RAPT",
  "REPL",
  "REPT",
  "SCPH",
  "SLNO",
  "TCRX",
  "TKAI",
  "TLSA",
  "URGN",
  "VANI",
  "VERU",
  "VIRC",
  "VIRX",
  "VSTM",
  "XBIT",
  "XENE",
  "XNCR",
  "ZLAB",
  "ALT",
  "ACHV",
  "ADVM",
  "AMRS",
  "ARPO",
  "AVRO",
  "BGNE",
  "BHVN",
  "BLUE",
  "CALA",
  "CLVS",
  "CRIS",
  "CRMD",
  "CRTX",
  "CTMX",
  "CVAC",
  "CYRX",
  "DVAX",
  "EIGR",
  "EMRA",
  "EPZM",
  "ESPR",
  "EVFN",
  "FBIO",
  "FGEN",
  "FOLD",
  "GERN",
  "GLUE",
  "HARP",
  "HGEN",
  "HLGN",
  "IMGN",
  "IMTX",
  "KALA",
  "KPTI",
  "LGVN",
  "LOGC",
  "LXRX",
  "MBIO",
  "MESO",
  "MGNX",
  "MRNS",
  "MVC",
  "NDVA",
  "CGC",
  "TLRY",
  "ACB",
  "CRON",
  "SNDL",
  "GTBIF",
  "TCNNF",
  "CURLF",
  "CRLBF",
  "PLNHF",
  "VRNOF",
  "GDNSF",
  "AYRWF",
  "JUSHF",
  "MSOS",
  "MJ",
  "YOLO",
  "POTX",
  "THCX",
  "TOKE",
  "ACT",
  "SPCE",
  "RKLB",
  "ASTS",
  "MNTS",
  "VORB",
  "REDWIRE",
  "SATL",
  "BKSY",
  "MYNA",
  "SPIR",
  "ASTR",
  "LLAP",
  "SIDU",
]);

const LIVE_TRACKED = [
  "AAPL",
  "MSFT",
  "GOOGL",
  "AMZN",
  "NVDA",
  "TSLA",
  "META",
  "AMD",
  "NFLX",
  "CRM",
  "SHOP",
  "SQ",
  "UBER",
  "ABNB",
  "COIN",
  "ROKU",
  "SNAP",
  "PINS",
  "ETSY",
  "TWLO",
  "DDOG",
  "NET",
  "OKTA",
  "ZS",
  "CRWD",
  "PLTR",
  "SNOW",
  "FSLR",
  "ENPH",
  "RUN",
  "U",
  "RBLX",
  "SOFI",
  "AFRM",
  "HOOD",
  "UPST",
  "AI",
  "SOUN",
  "BBAI",
  "PLUG",
  "QS",
  "SPCE",
  "RKLB",
  "ASTS",
  "LLAP",
  "BABA",
  "JD",
  "PDD",
  "FUTU",
  "TIGR",
];

// ===== MAIN CHART =====
// لا نعرض أي شموع مصطنعة. الرسم لا يظهر إلا عندما تتوفر سلسلة OHLC فعلية للرمز المختار.
function initChart() {
  const box = document.getElementById("chartBox");
  const cont = document.getElementById("chartContainer");
  if (!box || !cont) return;
  if (chartInstance) {
    chartInstance.remove();
    chartInstance = null;
  }
  cont.innerHTML =
    '<div class="chart-empty-state"><span class="chart-empty-icon">⌁</span><strong>الرسم البياني ينتظر بيانات تاريخية فعلية</strong><p>اختر سهمًا من الجدول لعرض الشموع والمؤشرات عند توفر بيانات OHLC الموثوقة.</p></div>';
}

const PREMIUM_PAGE_TITLES = {
  stocks: "الرئيسية",
  portfolio: "المحفظة",
  screener: "فلترة الأسهم",
  signals: "الماسح والتنبيهات",
  picks: "ترشيحات الأسبوع",
  indicators: "التحليل الفني",
  course: "الدورة التعليمية",
  marketer: "المسوق الذكي",
  support: "الدعم والتذاكر",
  admin: "لوحة الإدارة",
};
function applyAzTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("az_theme", next);
  } catch {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", next === "light" ? "#f4f1ea" : "#071018");
  const btn = document.getElementById("themeToggleBtn");
  if (btn) btn.setAttribute("aria-label", next === "light" ? "التبديل إلى الداكن" : "التبديل إلى الفاتح");
}
function toggleAzTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  applyAzTheme(current === "light" ? "dark" : "light");
}
function initAzTheme() {
  let saved = "dark";
  try {
    saved = localStorage.getItem("az_theme") || "dark";
  } catch {}
  applyAzTheme(saved);
}
function initPremiumShell() {
  const mount = document.getElementById("premiumNavMount");
  const tabs = document.querySelector(".tabs-wrap");
  if (mount && tabs && !mount.contains(tabs)) mount.appendChild(tabs);
  const active =
    document.querySelector(".tab-btn.active")?.dataset?.tab || "stocks";
  const title = document.getElementById("currentPageTitle");
  if (title) title.textContent = PREMIUM_PAGE_TITLES[active] || "الرئيسية";
  initAzTheme();
  initSignalGrid();
  renderInAppNotificationCenter();
}

const SIGNAL_GRID_LAYOUT_KEY = "az_signal_grid_layout_v1";
// الترتيب ثابت للمستخدم العادي؛ أدوات السحب وتغيير الحجم أزيلت لتجنب التداخل خصوصًا على الجوال.
const SIGNAL_GRID_CUSTOMIZATION_ENABLED = false;
let signalGridObserver = null;
function renderSignalGridPicks() {
  const body = document.getElementById("dashboardPicksBody");
  if (!body) return;
  const trades = Array.isArray(virtualTrader?.trades)
    ? virtualTrader.trades.slice(0, 8)
    : [];
  if (!trades.length) {
    body.innerHTML =
      '<tr><td colspan="3" class="grid-empty-cell">لا توجد صفقات محاكية بعد</td></tr>';
    return;
  }
  body.innerHTML = trades
    .map((t) => {
      const sym = String(t.symbol || "—").toUpperCase();
      const qty = Number(t.qty) || 0;
      const pos = virtualTrader.positions?.[sym];
      const pct =
        t.action === "sell" && Number(t.entryPrice)
          ? (Number(t.price) / Number(t.entryPrice) - 1) * 100
          : t.action === "buy" && pos && Number(pos.entryPrice)
            ? (Number(pos.lastPrice || pos.entryPrice) / Number(pos.entryPrice) - 1) *
              100
            : 0;
      const cls = movementClass(pct);
      return `<tr><td><strong class="font-mono">${escapeHtml(sym)}</strong><small class="sym-sub">${t.action === "buy" ? "شراء" : "بيع"}</small></td><td class="font-mono">${qty}</td><td class="${cls} font-mono">${movementSign(pct)}${pct.toFixed(2)}%</td></tr>`;
    })
    .join("");
}
function syncSignalGridFeed(sourceId, targetId, maxItems = 3) {
  const source = document.getElementById(sourceId);
  const target = document.getElementById(targetId);
  if (!source || !target) return;
  const items = [...source.children].slice(0, maxItems);
  target.innerHTML = items.length
    ? items.map((item) => item.outerHTML).join("")
    : '<div class="grid-feed-empty">ستظهر البيانات المرتبطة بالمنصة هنا عند توفرها.</div>';
}
function syncSignalGridFeeds() {
  renderSignalGridPicks();
  syncSignalGridFeed("companyNewsList", "dashboardNewsList", 3);
  syncSignalGridFeed("earningsList", "dashboardEarningsList", 3);
}
function createSignalWidget(key, title, subtitle, nodes, className = "") {
  const widget = document.createElement("section");
  widget.className = `signal-widget ${className}`.trim();
  widget.dataset.widget = key;
  widget.dataset.size = "normal";
  const heading = document.createElement("header");
  heading.className = "signal-widget-head";
  heading.innerHTML = `<span class="widget-grip" title="اسحب لترتيب الوحدة"><i></i><i></i><i></i><i></i><i></i><i></i></span><div><small>${escapeHtml(subtitle || "AZ ALPHA VISION")}</small><h3>${escapeHtml(title)}</h3></div><button class="widget-expand" type="button" aria-label="تغيير حجم الوحدة"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/></svg></button>`;
  widget.appendChild(heading);
  nodes.filter(Boolean).forEach((node) => widget.appendChild(node));
  return widget;
}
function mountSignalGridDashboard() {
  const grid = document.getElementById("signalGridDashboard");
  const tab = document.getElementById("tab-stocks");
  if (!grid || !tab || grid.dataset.mounted === "1") return;
  const observatory = tab.querySelector(".decision-observatory");
  const surface = observatory?.querySelector(".observatory-surface");
  const metrics = observatory?.querySelector(".decision-metrics");
  const thread = observatory?.querySelector(".decision-thread");
  const market = tab.querySelector(".market-canvas");
  const stream = tab.querySelector(".market-stream");
  const watchPanel = document.createElement("div");
  watchPanel.className = "signal-watchlist-panel";
  watchPanel.innerHTML =
    '<div class="signal-watchlist-note">متابعة شخصية — تنبيهات السعر والأخبار، دون تنفيذ صفقة.</div><form class="dashboard-watch-add" onsubmit="event.preventDefault(); addToWatchlist(\'dashboardWatchSymbol\', \'dashboardWatchEntry\')"><input id="dashboardWatchSymbol" type="text" maxlength="10" autocomplete="off" placeholder="رمز السهم مثل AAPL" aria-label="رمز السهم"><input id="dashboardWatchEntry" type="hidden" value=""><button type="submit">إضافة للمتابعة</button></form><div id="dashboardWatchlistBody"></div>';
  const aiPanel = document.createElement("div");
  aiPanel.className = "signal-ai-panel";
  aiPanel.innerHTML = `<div class="ai-orb"><span>AZ</span></div><p>اقرأ الإشارة والخبر والمخاطر من بيانات المنصة المتاحة.</p><button type="button" onclick="openAzAi()">افتح AZ ai <svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M3 12h4M17 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/><circle cx="12" cy="12" r="3.5"/></svg></button>`;
  const picksPanel = document.createElement("div");
  picksPanel.className = "signal-grid-table";
  picksPanel.innerHTML = `<table><thead><tr><th>الرمز</th><th>العدد</th><th>النسبة</th></tr></thead><tbody id="dashboardPicksBody"><tr><td colspan="3" class="grid-empty-cell">جارٍ قراءة سجل الصفقات</td></tr></tbody></table><button class="widget-link" type="button" onclick="switchTab('portfolio')">عرض سجل المحاكي <span>←</span></button>`;
  const newsPanel = document.createElement("div");
  newsPanel.className = "signal-grid-feed";
  newsPanel.id = "dashboardNewsList";
  newsPanel.innerHTML =
    '<div class="grid-feed-empty">جارٍ تحميل الأخبار المرتبطة</div>';
  const earningsPanel = document.createElement("div");
  earningsPanel.className = "signal-grid-feed";
  earningsPanel.id = "dashboardEarningsList";
  earningsPanel.innerHTML =
    '<div class="grid-feed-empty">جارٍ تحميل تقويم الأرباح</div>';
  const reset = document.createElement("button");
  reset.id = "resetSignalGrid";
  reset.type = "button";
  reset.className = "grid-reset";
  reset.textContent = "استعادة ترتيب الوحدات";
  const widgets = [
    createSignalWidget(
      "market",
      "السوق",
      "LIVE MARKET",
      [market],
      "widget-market",
    ),
    createSignalWidget(
      "signal",
      "إشارة اليوم",
      "SIGNAL CORE",
      [surface, thread],
      "widget-signal",
    ),
    createSignalWidget(
      "portfolio",
      "المحفظة الافتراضية",
      "VIRTUAL PORTFOLIO",
      [metrics],
      "widget-portfolio",
    ),
    createSignalWidget(
      "picks",
      "سجل صفقات المحاكي",
      "TRADE LEDGER",
      [picksPanel],
      "widget-picks",
    ),
    createSignalWidget(
      "ai",
      "AZ ai",
      "CONTEXTUAL COPILOT",
      [aiPanel],
      "widget-ai",
    ),
    createSignalWidget(
      "earnings",
      "الأرباح القادمة",
      "EARNINGS CLOCK",
      [earningsPanel],
      "widget-earnings",
    ),
    createSignalWidget(
      "news",
      "مزاج الأخبار",
      "NEWS LENS",
      [newsPanel],
      "widget-news",
    ),
    createSignalWidget(
      "watch",
      "قائمة المراقبة",
      "WATCHLIST",
      [watchPanel],
      "widget-watch",
    ),
  ];
  widgets.forEach((widget) => grid.appendChild(widget));
  grid.appendChild(reset);
  observatory?.remove();
  grid.dataset.mounted = "1";
}
function signalGridStorageKey() {
  return `${SIGNAL_GRID_LAYOUT_KEY}_${currentUser?.id || "local"}`;
}
function initSignalGrid() {
  mountSignalGridDashboard();
  const grid = document.getElementById("signalGridDashboard");
  if (!grid || grid.dataset.ready === "1") {
    syncSignalGridFeeds();
    return;
  }
  grid.dataset.ready = "1";
  let layout = {};
  try {
    layout = JSON.parse(localStorage.getItem(signalGridStorageKey()) || "{}");
  } catch (_) {
    layout = {};
  }
  const widgets = () => [
    ...grid.querySelectorAll(".signal-widget[data-widget]"),
  ];
  const save = () => {
    const next = {};
    widgets().forEach((widget, index) => {
      next[widget.dataset.widget] = {
        order: index,
        size: widget.dataset.size || "normal",
      };
    });
    localStorage.setItem(signalGridStorageKey(), JSON.stringify(next));
  };
  if (SIGNAL_GRID_CUSTOMIZATION_ENABLED) {
    widgets()
      .sort(
        (a, b) =>
          (layout[a.dataset.widget]?.order ?? 99) -
          (layout[b.dataset.widget]?.order ?? 99),
      )
      .forEach((widget) => grid.appendChild(widget));
    widgets().forEach((widget) => {
      widget.dataset.size =
        layout[widget.dataset.widget]?.size || widget.dataset.size || "normal";
      widget.draggable = true;
      widget.addEventListener("dragstart", (event) => {
        grid.dataset.dragging = widget.dataset.widget;
        event.dataTransfer.effectAllowed = "move";
        widget.classList.add("is-dragging");
      });
      widget.addEventListener("dragend", () => {
        widget.classList.remove("is-dragging");
        delete grid.dataset.dragging;
        save();
      });
      widget.addEventListener("dragover", (event) => event.preventDefault());
      widget.addEventListener("drop", (event) => {
        event.preventDefault();
        const dragged = grid.querySelector(
          `[data-widget="${grid.dataset.dragging || ""}"]`,
        );
        if (dragged && dragged !== widget) grid.insertBefore(dragged, widget);
        save();
      });
    });
    grid.querySelectorAll(".widget-expand").forEach((button) =>
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const widget = button.closest(".signal-widget");
        const sequence = ["normal", "wide", "tall"];
        widget.dataset.size =
          sequence[
            (sequence.indexOf(widget.dataset.size || "normal") + 1) %
              sequence.length
          ];
        button.setAttribute("aria-label", "تغيير حجم الوحدة");
        save();
      }),
    );
    document
      .getElementById("resetSignalGrid")
      ?.addEventListener("click", () => {
        localStorage.removeItem(signalGridStorageKey());
        location.reload();
      });
  } else {
    widgets().forEach((widget) => {
      widget.draggable = false;
    });
  }
  const news = document.getElementById("companyNewsList");
  const earnings = document.getElementById("earningsList");
  if (!signalGridObserver && (news || earnings)) {
    signalGridObserver = new MutationObserver(syncSignalGridFeeds);
    if (news)
      signalGridObserver.observe(news, { childList: true, subtree: true });
    if (earnings)
      signalGridObserver.observe(earnings, { childList: true, subtree: true });
  }
  syncSignalGridFeeds();
}
let inAppNotificationFilter = "all";
function inAppNotificationStateKey() {
  return `az_inapp_notification_state_v1_${currentUser?.id || "local"}`;
}
function getInAppNotificationState() {
  try {
    return JSON.parse(
      localStorage.getItem(inAppNotificationStateKey()) || "{}",
    );
  } catch (_) {
    return {};
  }
}
function saveInAppNotificationState(state) {
  localStorage.setItem(inAppNotificationStateKey(), JSON.stringify(state));
}
function collectInAppNotifications() {
  const activity = [];
  const trades = Array.isArray(virtualTrader?.trades)
    ? virtualTrader.trades.slice(0, 12)
    : [];
  trades.forEach((trade) =>
    activity.push({
      id: `trade:${trade.id || `${trade.symbol}:${trade.at}:${trade.action}`}`,
      category: "portfolio",
      route: "portfolio",
      at: trade.at,
      title: `${trade.action === "buy" ? "عملية محاكاة جديدة" : "إغلاق مركز محاكى"} — ${trade.symbol}`,
      body: `${trade.action === "buy" ? "تم تسجيل الدخول الافتراضي" : "تم تسجيل البيع الافتراضي"} بسعر $${Number(trade.price || 0).toFixed(2)}`,
    }),
  );
  if (virtualTrader?.lastRun)
    activity.push({
      id: `run:${virtualTrader.lastRun}`,
      category: "system",
      route: "portfolio",
      at: virtualTrader.lastRun,
      title: "تحديث المحاكي",
      body:
        virtualTrader?.runInfo?.run_note || "تمت مزامنة حالة المحفظة المشتركة.",
    });
  (Array.isArray(SIGNALS_ALERTS) ? SIGNALS_ALERTS : [])
    .slice(0, 12)
    .forEach((alert) =>
      activity.push({
        id: `signal:${alert.id || `${alert.symbol}:${alert.ts}:${alert.type}`}`,
        category: "market",
        route: "signals",
        at: alert.ts || alert.updated_at,
        title: `إشارة سوق — ${alert.symbol || "—"}`,
        body: String(
          alert.message || alert.reason || "تحديث إشارة تعليمية من الماسح.",
        ),
      }),
    );
  return activity
    .filter((item) => item.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
function toggleNotificationCenter() {
  const panel = document.getElementById("notificationCenter");
  if (!panel) return;
  const open = panel.classList.toggle("open");
  panel.setAttribute("aria-hidden", String(!open));
  if (open) renderInAppNotificationCenter();
}
function setInAppNotificationFilter(filter) {
  inAppNotificationFilter = ["all", "market", "portfolio", "system"].includes(
    filter,
  )
    ? filter
    : "all";
  renderInAppNotificationCenter();
}
function markInAppNotificationRead(id, route = "") {
  const state = getInAppNotificationState();
  state[id] = true;
  saveInAppNotificationState(state);
  renderInAppNotificationCenter();
  if (route) {
    switchTab(route);
    const panel = document.getElementById("notificationCenter");
    panel?.classList.remove("open");
    panel?.setAttribute("aria-hidden", "true");
  }
}
function markAllInAppNotificationsRead() {
  const state = getInAppNotificationState();
  collectInAppNotifications().forEach((item) => {
    state[item.id] = true;
  });
  saveInAppNotificationState(state);
  renderInAppNotificationCenter();
}
function renderInAppNotificationCenter() {
  const list = document.getElementById("inAppNotifications");
  const badge = document.getElementById("notificationBadge");
  if (!list) return;
  const state = getInAppNotificationState();
  const allActivity = collectInAppNotifications();
  const unread = allActivity.filter((item) => !state[item.id]);
  const visible =
    inAppNotificationFilter === "all"
      ? allActivity
      : allActivity.filter((item) => item.category === inAppNotificationFilter);
  document
    .querySelectorAll("[data-notification-filter]")
    .forEach((button) =>
      button.classList.toggle(
        "active",
        button.dataset.notificationFilter === inAppNotificationFilter,
      ),
    );
  if (!visible.length) {
    list.innerHTML =
      '<div class="notification-empty">لا توجد مستجدات ضمن هذا القسم.</div>';
  } else {
    list.innerHTML = visible
      .slice(0, 30)
      .map((item) => {
        const read = Boolean(state[item.id]);
        const safeId = encodeURIComponent(item.id);
        return `<button class="in-app-notification ${read ? "is-read" : "is-unread"}" type="button" onclick="markInAppNotificationRead(decodeURIComponent('${safeId}'),'${item.route}')"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p><small>${new Date(item.at).toLocaleString("ar-SA")}</small></button>`;
      })
      .join("");
  }
  if (badge) {
    badge.hidden = unread.length === 0;
    badge.textContent = String(Math.min(unread.length, 9));
  }
}
async function quickStockSearch(event) {
  if (event.key !== "Enter") return;
  const input = event.currentTarget;
  const query = String(input?.value || "").trim();
  if (!query) return;
  const symbolMatch = query.toUpperCase().match(/\b[A-Z]{1,10}\b/);
  const symbol = symbolMatch?.[0] || "";
  if (symbol) {
    requestSymbolResearch(symbol);
    const addInput = document.getElementById("addSymbolInput");
    if (addInput) addInput.value = symbol;
  }
  openAzAi();
  const aiInput = document.getElementById("azAiInput");
  if (aiInput) {
    aiInput.value = symbol
      ? `حلل ${symbol} من البيانات المتاحة، واذكر ما يحتاج إلى تحديث أو تحقق.`
      : query;
    await askAzAi();
  }
  if (input) input.value = "";
}
function openTabFromHash() {
  if (!currentUser) return;
  const id = String(window.location.hash || "")
    .replace(/^#/, "")
    .trim();
  if (id && document.getElementById("tab-" + id)) switchTab(id);
}
window.addEventListener("hashchange", openTabFromHash);

function switchTab(id) {
  document
    .querySelectorAll(".tab-panel")
    .forEach((el) => el.classList.add("hidden"));
  document
    .querySelectorAll(".tab-btn")
    .forEach((el) => el.classList.remove("active"));
  const panel = document.getElementById("tab-" + id);
  const btn = document.querySelector(`.tab-btn[data-tab="${id}"]`);
  if (panel) panel.classList.remove("hidden");
  if (btn) btn.classList.add("active");
  const title = document.getElementById("currentPageTitle");
  if (title) title.textContent = PREMIUM_PAGE_TITLES[id] || "الرئيسية";

  const chartBox = document.getElementById("chartBox");
  if (chartBox) {
    if (id === "stocks") {
      chartBox.style.display = "block";
      if (chartInstance)
        setTimeout(
          () =>
            chartInstance.resize(chartBox.clientWidth, chartBox.clientHeight),
          50,
        );
    } else {
      chartBox.style.display = "none";
    }
  }

  if (id === "stocks") {
    runScanner();
  }
  if (id === "screener" && !screenerResults.length) {
    document.getElementById("screenerTableBody").innerHTML =
      '<tr><td colspan="13" style="text-align:center;color:var(--text-muted);padding:40px;">اضغط "بدء الفلترة" للبحث في 800+ سهم</td></tr>';
  }
  if (id === "signals") {
    loadSignalsData()
      .then(() => {
        const tb = document.getElementById("signalsTableBody");
        if (tb && /اختر فلتر/.test(tb.textContent || "")) runSignalScan("all");
      })
      .catch(() => {});
  }
  if (id === "admin" && currentProfile && currentProfile.role === "admin")
    refreshAdminData();
  if (id === "indicators") {
    setTimeout(() => {
      initIndicatorChart();
      updateChartIndicators();
    }, 50);
  }
  if (id === "portfolio") {
    renderPortfolio();
  }
  if (id === "picks") {
    updateSitePerformance();
  }
  if (id === "marketer") {
    refreshMarketerDashboard();
  }
  renderInAppNotificationCenter();
}

// ===== INDICATORS (Fib / SMC / ATR — still overlaid on the decorative chart above, unchanged logic) =====
let indicatorState = {
  fib: { active: false, settings: {} },
  lux: { active: false, settings: {} },
  atr: { active: false, settings: {} },
};
let chartOverlays = { fib: [], lux: [], atr: [] };

const defaultSettings = {
  fib: {
    swings: 5,
    depth: 8,
    extendLeft: true,
    extendRight: false,
    showPrices: true,
    levelsMode: "all",
    labels: "right",
    bgOpacity: 85,
    levels: [
      0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.414, 1.618, 2, 2.24,
    ],
  },
  lux: {
    mode: "historical",
    style: "colored",
    colorCandles: false,
    showInternal: true,
    showSwing: true,
    bullishColor: "#00e676",
    bearishColor: "#ff1744",
    confluence: false,
    labelSize: "small",
  },
  atr: {
    cciPeriod: 20,
    multiplier: 2,
    atrPeriod: 14,
    source: "close",
    bullColor: "#00e676",
    bearColor: "#ff1744",
    lineWidth: 2,
  },
};

function openIndicatorModal(id) {
  document.getElementById(id + "Modal").classList.add("active");
}
function closeIndicatorModal(id) {
  document.getElementById(id + "Modal").classList.remove("active");
}
function selectColor(el, target) {
  el.parentElement
    .querySelectorAll(".color-dot")
    .forEach((d) => d.classList.remove("selected"));
  el.classList.add("selected");
  if (!window._colorPickers) window._colorPickers = {};
  window._colorPickers[target] = el.dataset.color;
}
function toggleIndicator(id) {
  indicatorState[id].active = !indicatorState[id].active;
  const btn = document.getElementById(id + "ToggleBtn");
  const badge = document.getElementById(id + "Badge");
  if (indicatorState[id].active) {
    btn.textContent = "⏹️ إيقاف";
    btn.classList.add("active");
    badge.style.display = "inline-flex";
    toast("✅ مؤشر " + id.toUpperCase() + " مفعل");
  } else {
    btn.textContent = "▶️ تفعيل";
    btn.classList.remove("active");
    badge.style.display = "none";
    toast("⏹️ مؤشر " + id.toUpperCase() + " متوقف");
  }
  updateChartIndicators();
}
function saveIndicatorSettings(id) {
  const s = {};
  if (id === "fib") {
    s.swings = parseInt(document.getElementById("fibSwings").value);
    s.depth = parseInt(document.getElementById("fibDepth").value);
    s.extendLeft = document
      .getElementById("fibExtendLeft")
      .classList.contains("active");
    s.extendRight = document
      .getElementById("fibExtendRight")
      .classList.contains("active");
    s.showPrices = document
      .getElementById("fibShowPrices")
      .classList.contains("active");
    s.levelsMode = document.getElementById("fibLevelsMode").value;
    s.labels = document.getElementById("fibLabels").value;
    s.bgOpacity = parseInt(document.getElementById("fibBgOpacity").value);
    s.levels = Array.from(
      document.querySelectorAll("#fibLevelChecks input:checked"),
    ).map((i) => parseFloat(i.value));
  } else if (id === "lux") {
    s.mode = document.getElementById("luxMode").value;
    s.style = document.getElementById("luxStyle").value;
    s.colorCandles = document
      .getElementById("luxColorCandles")
      .classList.contains("active");
    s.showInternal = document
      .getElementById("luxShowInternal")
      .classList.contains("active");
    s.showSwing = document
      .getElementById("luxShowSwing")
      .classList.contains("active");
    s.bullishColor = window._colorPickers?.luxBullishColor || "#00e676";
    s.bearishColor = window._colorPickers?.luxBearishColor || "#ff1744";
    s.confluence = document
      .getElementById("luxConfluence")
      .classList.contains("active");
    s.labelSize = document.getElementById("luxLabelSize").value;
  } else if (id === "atr") {
    s.cciPeriod = parseInt(document.getElementById("atrCCIPeriod").value);
    s.multiplier = parseFloat(document.getElementById("atrMultiplier").value);
    s.atrPeriod = parseInt(document.getElementById("atrPeriod").value);
    s.source = document.getElementById("atrSource").value;
    s.bullColor = window._colorPickers?.atrBullColor || "#00e676";
    s.bearColor = window._colorPickers?.atrBearColor || "#ff1744";
    s.lineWidth = parseInt(document.getElementById("atrLineWidth").value);
  }
  indicatorState[id].settings = {
    ...(indicatorState[id].settings || defaultSettings[id]),
    ...s,
  };
  closeIndicatorModal(id);
  if (indicatorState[id].active) {
    updateChartIndicators();
    toast("💾 تم حفظ إعدادات " + id.toUpperCase());
  } else {
    toast("💾 تم الحفظ — فعّل المؤشر للتطبيق");
  }
}
function clearAllIndicators() {
  ["fib", "lux", "atr"].forEach((id) => {
    indicatorState[id].active = false;
    document.getElementById(id + "ToggleBtn").textContent = "▶️ تفعيل";
    document.getElementById(id + "ToggleBtn").classList.remove("active");
    document.getElementById(id + "Badge").style.display = "none";
  });
  updateChartIndicators();
  toast("🗑️ تم مسح جميع المؤشرات");
}
function clearChartOverlays(id) {
  if (!window.indicatorChart) return;
  chartOverlays[id].forEach((o) => {
    try {
      window.indicatorChart.removeSeries(o);
    } catch (e) {}
  });
  chartOverlays[id] = [];
}
function updateChartIndicators() {
  if (!window.indicatorChart) return;
  const series = window.indicatorChart.serieses()[0];
  if (!series) return;
  const data = series.data();
  if (!data || data.length < 20) return;
  ["fib", "lux", "atr"].forEach(clearChartOverlays);
  if (indicatorState.fib.active) applyFibonacci(data);
  if (indicatorState.lux.active) applyLuxAlgoSMC(data);
  if (indicatorState.atr.active) applyATRMoreno(data);
}
function applyFibonacci(data) {
  const s = { ...defaultSettings.fib, ...indicatorState.fib.settings };
  const len = data.length;
  const lookback = Math.min(len, 60);
  const slice = data.slice(len - lookback);
  let high = -Infinity,
    low = Infinity,
    highIdx = 0,
    lowIdx = 0;
  slice.forEach((d, i) => {
    if (d.high > high) {
      high = d.high;
      highIdx = i;
    }
    if (d.low < low) {
      low = d.low;
      lowIdx = i;
    }
  });
  const diff = high - low;
  const trend = highIdx > lowIdx ? "up" : "down";
  const startPrice = trend === "up" ? low : high;
  const startTime = trend === "up" ? slice[lowIdx].time : slice[highIdx].time;
  const endTime = trend === "up" ? slice[highIdx].time : slice[lowIdx].time;
  const colors = [
    "#00f0ff",
    "#00e676",
    "#ffd700",
    "#ff9100",
    "#ff1744",
    "#b829dd",
    "#2196f3",
    "#9c27b0",
    "#ff5722",
    "#795548",
    "#607d8b",
    "#e91e63",
  ];
  s.levels.forEach((lvl, i) => {
    const price =
      trend === "up" ? startPrice + diff * lvl : startPrice - diff * lvl;
    if (price <= 0) return;
    const line = window.indicatorChart.addLineSeries({
      color: colors[i % colors.length],
      lineWidth: 1,
      lastValueVisible: s.showPrices,
      title: "Fib " + lvl,
      priceLineVisible: false,
    });
    const lineData = [];
    if (s.extendLeft) {
      const first = data[0];
      lineData.push({ time: first.time, value: price });
    }
    lineData.push(
      { time: startTime, value: price },
      { time: endTime, value: price },
    );
    if (s.extendRight) {
      const last = data[data.length - 1];
      lineData.push({ time: last.time, value: price });
    }
    line.setData(lineData);
    chartOverlays.fib.push(line);
  });
}
function applyATRMoreno(data) {
  const s = { ...defaultSettings.atr, ...indicatorState.atr.settings };
  const len = data.length;
  const per = s.atrPeriod;
  const cciPer = s.cciPeriod;
  if (len < Math.max(per, cciPer) + 5) return;
  const src = data.map((d) => {
    if (s.source === "high") return d.high;
    if (s.source === "low") return d.low;
    if (s.source === "hl2") return (d.high + d.low) / 2;
    if (s.source === "ohlc4") return (d.open + d.high + d.low + d.close) / 4;
    return d.close;
  });
  const atr = [];
  for (let i = 0; i < len; i++) {
    if (i === 0) {
      atr.push(data[0].high - data[0].low);
      continue;
    }
    const tr = Math.max(
      data[i].high - data[i].low,
      Math.abs(data[i].high - data[i - 1].close),
      Math.abs(data[i].low - data[i - 1].close),
    );
    atr.push(tr);
  }
  const atrSmooth = [];
  for (let i = 0; i < len; i++) {
    if (i < per) {
      atrSmooth.push(atr[i]);
      continue;
    }
    let sum = 0;
    for (let j = 0; j < per; j++) sum += atr[i - j];
    atrSmooth.push(sum / per);
  }
  const cci = [];
  for (let i = 0; i < len; i++) {
    if (i < cciPer) {
      cci.push(0);
      continue;
    }
    let sum = 0;
    for (let j = 0; j < cciPer; j++) sum += src[i - j];
    const ma = sum / cciPer;
    let md = 0;
    for (let j = 0; j < cciPer; j++) md += Math.abs(src[i - j] - ma);
    md = md / cciPer;
    cci.push(md === 0 ? 0 : (src[i] - ma) / (0.015 * md));
  }
  const upLine = [],
    dnLine = [];
  for (let i = Math.max(per, cciPer); i < len; i++) {
    const up = src[i] + atrSmooth[i] * s.multiplier;
    const dn = src[i] - atrSmooth[i] * s.multiplier;
    upLine.push({ time: data[i].time, value: up });
    dnLine.push({ time: data[i].time, value: dn });
  }
  const bull = window.indicatorChart.addLineSeries({
    color: s.bullColor,
    lineWidth: s.lineWidth,
    lastValueVisible: false,
    title: "ATR Up",
  });
  const bear = window.indicatorChart.addLineSeries({
    color: s.bearColor,
    lineWidth: s.lineWidth,
    lastValueVisible: false,
    title: "ATR Down",
  });
  bull.setData(upLine);
  bear.setData(dnLine);
  chartOverlays.atr.push(bull, bear);
}
function applyLuxAlgoSMC(data) {
  const s = { ...defaultSettings.lux, ...indicatorState.lux.settings };
  const len = data.length;
  if (len < 10) return;
  const swings = [];
  const swingSize = 3;
  for (let i = swingSize; i < len - swingSize; i++) {
    const isHigh =
      data[i].high > data[i - 1].high &&
      data[i].high > data[i - 2].high &&
      data[i].high > data[i + 1].high &&
      data[i].high > data[i + 2].high;
    const isLow =
      data[i].low < data[i - 1].low &&
      data[i].low < data[i - 2].low &&
      data[i].low < data[i + 1].low &&
      data[i].low < data[i + 2].low;
    if (isHigh)
      swings.push({ time: data[i].time, value: data[i].high, type: "high" });
    if (isLow)
      swings.push({ time: data[i].time, value: data[i].low, type: "low" });
  }
  if (s.showSwing && swings.length >= 2) {
    const lineData = swings.map((sw) => ({ time: sw.time, value: sw.value }));
    const color =
      s.style === "colored"
        ? swings[swings.length - 1].type === "high"
          ? s.bearishColor
          : s.bullishColor
        : "#00f0ff";
    const swingLine = window.indicatorChart.addLineSeries({
      color: color,
      lineWidth: 2,
      lastValueVisible: false,
      title: "SMC Swing",
    });
    swingLine.setData(lineData);
    chartOverlays.lux.push(swingLine);
  }
  if (s.showInternal) {
    const internal = [];
    const intSize = 2;
    for (let i = intSize; i < len - intSize; i++) {
      const isHigh =
        data[i].high > data[i - 1].high && data[i].high > data[i + 1].high;
      const isLow =
        data[i].low < data[i - 1].low && data[i].low < data[i + 1].low;
      if (isHigh) internal.push({ time: data[i].time, value: data[i].high });
      if (isLow) internal.push({ time: data[i].time, value: data[i].low });
    }
    if (internal.length >= 2) {
      const intLine = window.indicatorChart.addLineSeries({
        color: s.bullishColor,
        lineWidth: 1,
        lineStyle: 2,
        lastValueVisible: false,
        title: "SMC Internal",
      });
      intLine.setData(internal);
      chartOverlays.lux.push(intLine);
    }
  }
}
function initIndicatorChart() {
  const box = document.getElementById("chartBoxIndicators");
  const cont = document.getElementById("chartContainerIndicators");
  if (!box || !cont || box.clientWidth === 0) return;
  if (window.indicatorChart) {
    window.indicatorChart.remove();
    window.indicatorChart = null;
  }
  window.indicatorChart = LightweightCharts.createChart(cont, {
    width: cont.clientWidth,
    height: cont.clientHeight,
    layout: { background: { color: "transparent" }, textColor: "#6b7280" },
    grid: {
      vertLines: { color: "rgba(255,255,255,0.03)" },
      horzLines: { color: "rgba(255,255,255,0.03)" },
    },
    timeScale: { timeVisible: true, borderColor: "rgba(255,255,255,0.06)" },
    rightPriceScale: { borderColor: "rgba(255,255,255,0.06)" },
    crosshair: {
      mode: 1,
      vertLine: { color: "#00f0ff", width: 1, style: 2 },
      horzLine: { color: "#00f0ff", width: 1, style: 2 },
    },
  });
  const series = window.indicatorChart.addCandlestickSeries({
    upColor: "#00e676",
    downColor: "#ff1744",
    borderUpColor: "#00e676",
    borderDownColor: "#ff1744",
    wickUpColor: "#00e676",
    wickDownColor: "#ff1744",
  });
  const data = [];
  let v = 100;
  for (let i = 60; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const o = v + (Math.random() - 0.5) * 3;
    const c = o + (Math.random() - 0.5) * 4;
    const h = Math.max(o, c) + Math.random() * 2;
    const l = Math.min(o, c) - Math.random() * 2;
    v = c;
    data.push({
      time: d.toISOString().split("T")[0],
      open: +o.toFixed(2),
      high: +h.toFixed(2),
      low: +l.toFixed(2),
      close: +c.toFixed(2),
    });
  }
  series.setData(data);
  window.indicatorChart.timeScale().fitContent();
  window.addEventListener("resize", () => {
    if (window.indicatorChart && cont)
      window.indicatorChart.resize(cont.clientWidth, cont.clientHeight);
  });
}
const EXCLUDED_SECTOR_RE =
  /financial|finance|bank|banc|insurance|insur|capital|credit|mortgage|broker|asset management|investment|reinsurance|real estate|property|properties|reit|healthcare|health care|biotech|biotechnology|pharma|therapeutic|medical|energy|oil|gas|petroleum|coal|solar|utilities/i;
const NON_COMMON_INSTRUMENT_RE =
  /etf|exchange[ -]?traded|etn|closed[ -]?end|warrant|unit|preferred|fund|trust|spac|rights|note|depositary|acquisition|bond|convertible|royalty|partnership|limited partnership|adr/i;
const GENERAL_MARKET_RULE = Object.freeze({
  minPrice: 5,
  maxPrice: 70,
  exchanges: new Set(["NYSE", "NASDAQ"]),
});

function isCommonStockRow(row) {
  const symbol = String(row?.symbol || "")
    .trim()
    .toUpperCase();
  const exchange = String(row?.exchange || "")
    .trim()
    .toUpperCase();
  const text = [
    row?.industry,
    row?.company,
    row?.sector,
    row?.finviz_sector,
    row?.security_type,
    row?.quote_type,
    row?.asset_type,
  ]
    .map((v) => String(v || "").toLowerCase())
    .join(" ");
  if (!symbol || EXCLUDED_SYMBOLS.has(symbol)) return false;
  if (!GENERAL_MARKET_RULE.exchanges.has(exchange)) return false;
  if (NON_COMMON_INSTRUMENT_RE.test(text) || EXCLUDED_SECTOR_RE.test(text))
    return false;
  if (/[.\-\^]/.test(symbol)) return false;
  const price = Number(row?.price || 0);
  return (
    price >= GENERAL_MARKET_RULE.minPrice &&
    price <= GENERAL_MARKET_RULE.maxPrice
  );
}

// إشارات screener_signals تأتي من مجمّع خلفي تحقق من NYSE/NASDAQ؛ قد تتأخر حقول الإثراء في الجلسة.
// لا نسقط الإشارة الصحيحة لمجرد أن جدول الأساسيات لم يُحدّث في اللحظة نفسها.
function isStoredSignalCommonStock(row) {
  const symbol = String(row?.symbol || "")
    .trim()
    .toUpperCase();
  const text = [
    row?.industry,
    row?.company,
    row?.sector,
    row?.finviz_sector,
    row?.security_type,
    row?.quote_type,
    row?.asset_type,
  ]
    .map((v) => String(v || "").toLowerCase())
    .join(" ");
  const price = Number(row?.price || 0);
  if (!symbol || EXCLUDED_SYMBOLS.has(symbol) || /[.\-\^]/.test(symbol))
    return false;
  if (NON_COMMON_INSTRUMENT_RE.test(text) || EXCLUDED_SECTOR_RE.test(text))
    return false;
  if (row?.exchange) return isCommonStockRow(row);
  return (
    price >= GENERAL_MARKET_RULE.minPrice &&
    price <= GENERAL_MARKET_RULE.maxPrice
  );
}

// حارس مستوحى من SMC: بنية صاعدة أو ارتداد قريب من المتوسط، مع منع مطاردة السعر.
// لا يدّعي حساب Order Block حقيقيًا لأن قاعدة البيانات الحالية لا تحفظ OHLC/سيولة مؤسسية.
function technicalEntryGuard(row) {
  const price = Number(row?.price);
  const sma20 = Number(row?.sma20),
    sma50 = Number(row?.sma50),
    sma200 = Number(row?.sma200);
  const rsi = Number(row?.rsi14 ?? row?.rsi);
  const change = Number(row?.change_pct ?? row?.change ?? 0);
  const distance20 = Number(row?.distance_from_sma20);
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(sma20) ||
    !Number.isFinite(sma50)
  )
    return { allow: false, reason: "بيانات المتوسطات غير مكتملة" };
  const chase =
    (Number.isFinite(rsi) && rsi >= 68) ||
    change >= 5 ||
    (Number.isFinite(distance20) && distance20 > 8) ||
    price > sma20 * 1.08;
  const structure =
    (price >= sma20 && sma20 >= sma50) ||
    (Number.isFinite(sma200) &&
      price >= sma200 &&
      price <= sma50 * 1.02 &&
      (!Number.isFinite(rsi) || rsi < 60));
  if (chase)
    return {
      allow: false,
      reason: "انتظار تراجع: تشبع/ارتفاع حديث أو ابتعاد عن الدعم",
    };
  if (!structure)
    return {
      allow: false,
      reason: "لا يوجد تأكيد هيكل صاعد أو ارتداد من منطقة طلب",
    };
  return { allow: true, reason: "SMC مفتوح: هيكل صاعد قرب الدعم دون مطاردة" };
}

// ===== REAL MARKET DATA (Supabase — replaces the old fake REAL_PRICES/getLivePrice/fetchYahooData) =====
// أربعة حقول لا مصدر حقيقي لها بعد فعُطِّلت في الواجهة بدل أن تُحاكى: توصية المحللين، Beta،
// Float، مفاجأة الأرباح. حين يتوفر مصدر حقيقي لها لاحقًا، أضِفها لجدول market_fundamentals
// وأعد تفعيل حقول الفلترة المقابلة في index.html (ابحث عن "🚧" هناك).

let _universeCache = null; // { t: timestamp, rows: [...] } لتفادي إعادة الجلب الكامل كل ثانية

function mapMarketRow(fund, tech) {
  const price = tech?.price ?? fund?.price ?? null;
  const sma20 = tech?.sma20 ?? null;
  const sma50 = tech?.sma50 ?? null;
  const sma200 = tech?.sma200 ?? null;
  const distanceFromSma20 = tech?.distance_from_sma20 ?? null;
  const distanceFromSma50 = tech?.distance_from_sma50 ?? null;
  const distanceFromSma200 = tech?.distance_from_sma200 ?? null;
  const prevSma20 = tech?.prev_sma20 ?? null;
  const prevSma50 = tech?.prev_sma50 ?? null;
  const prevSma200 = tech?.prev_sma200 ?? null;
  const sma20CrossUp =
    [prevSma20, prevSma50, sma20, sma50].every((v) =>
      Number.isFinite(Number(v)),
    ) &&
    Number(prevSma20) <= Number(prevSma50) &&
    Number(sma20) > Number(sma50);
  const sma50CrossUp =
    [prevSma50, prevSma200, sma50, sma200].every((v) =>
      Number.isFinite(Number(v)),
    ) &&
    Number(prevSma50) <= Number(prevSma200) &&
    Number(sma50) > Number(sma200);
  const growth = fund?.eps_growth_this_year ?? null;
  const eps = fund?.eps_ttm ?? fund?.eps_diluted ?? fund?.eps ?? null;
  const profitable =
    eps != null ? Number(eps) > 0 : fund?.pe != null && Number(fund.pe) > 0;
  const ltDebt = fund?.lt_debt_equity ?? null;
  const rsi = tech?.rsi14 ?? null;
  const relVolume = tech?.rel_volume ?? null;
  const relVolume9 = tech?.rel_volume_9 ?? null;
  const hasIssues =
    EXCLUDED_SYMBOLS.has(fund.symbol) || (ltDebt !== null && ltDebt > 0.5);
  const hasPlan = growth !== null ? growth > 0 : null;

  let score = 0;
  if (price !== null && sma50 !== null && price > sma50) score += 2;
  if (price !== null && sma200 !== null && price > sma200) score += 2;
  if (rsi !== null && rsi > 50 && rsi < 70) score += 1;
  if ((tech?.change_pct ?? 0) > 0) score += 1;
  if ((relVolume ?? 0) > 1.5) score += 1;
  if (growth !== null && growth > 15) score += 1;
  if (ltDebt !== null && ltDebt < 0.3) score += 1;
  const grade =
    score >= 7
      ? "A"
      : score >= 5
        ? "B"
        : score >= 3
          ? "C"
          : score >= 1
            ? "D"
            : "F";

  return {
    symbol: fund.symbol,
    company: fund.company,
    price,
    change: tech?.change_pct ?? null,
    volume: tech?.volume ?? 0,
    avgVolume: tech?.avg_volume ?? 0,
    avgVolume9: tech?.avg_volume_9 ?? 0,
    relVolume: relVolume ?? 1,
    relVolume9: relVolume9 ?? 1,
    sma20,
    sma50,
    sma200,
    distanceFromSma20,
    distanceFromSma50,
    distanceFromSma200,
    prevSma20,
    prevSma50,
    prevSma200,
    sma20CrossUp,
    sma50CrossUp,
    rsi,
    atr: tech?.atr14 ?? null,
    sector: classifySector({
      symbol: fund.symbol,
      sector: fund.sector,
      finviz_sector: fund.finviz_sector,
      industry: fund.industry,
      company: fund.company,
    }),
    pe: fund.pe,
    pb: fund.pb,
    growth,
    eps,
    profitable,
    epsNext: fund.eps_growth_next_year,
    eps5y: fund.eps_growth_5y,
    epsGrowthQtr: fund.eps_growth_qtr,
    ltDebt,
    debtRatio: ltDebt,
    perfWeek: tech?.perf_week ?? null,
    hasIssues,
    hasPlan,
    missedEarnings: false,
    exchange: String(fund.exchange || "").toUpperCase(),
    industry: fund.industry || "",
    company: fund.company || "",
    finviz_sector: fund.finviz_sector || "",
    grade,
    score,
    // غير مربوطة ببيانات حقيقية بعد (انظر التعليق أعلى الملف) — الفلاتر المقابلة معطّلة بالواجهة
    analystScore: null,
    beta: null,
    floatShares: null,
    earnSurprise: null,
    revSurprise: null,
  };
}

async function fetchAllRows(table, pageSize = 1000) {
  const all = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sb
      .from(table)
      .select("*")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return all;
}
async function fetchUniverse(forceRefresh = false) {
  if (
    !forceRefresh &&
    _universeCache &&
    Date.now() - _universeCache.t < 5 * 60000
  ) {
    return _universeCache.rows;
  }
  let fundRows, techRows;
  try {
    [fundRows, techRows] = await Promise.all([
      fetchAllRows("market_fundamentals"),
      fetchAllRows("market_technicals"),
    ]);
  } catch (e) {
    toast("تعذر تحميل بيانات الماسح: " + (e?.message || ""), "error");
    return [];
  }
  const techMap = Object.fromEntries(
    (techRows || []).map((t) => [t.symbol, t]),
  );
  const rows = (fundRows || [])
    .map((f) => mapMarketRow(f, techMap[f.symbol]))
    .filter((r) => {
      const sector = String(r.sector || "").toLowerCase();
      const liquid =
        Number(r.price || 0) >= GENERAL_MARKET_RULE.minPrice &&
        Number(r.price || 0) <= GENERAL_MARKET_RULE.maxPrice;
      const ordinary = ![
        "finance",
        "financial",
        "financials",
        "reits",
      ].includes(sector);
      return liquid && ordinary && isCommonStockRow(r);
    });
  _universeCache = { t: Date.now(), rows };
  return rows;
}

async function fetchPrice(sym) {
  const { data: live } = await sb
    .from("live_quotes")
    .select("price")
    .eq("symbol", sym)
    .maybeSingle();
  if (live && live.price != null) return Number(live.price);
  const { data: tech } = await sb
    .from("market_technicals")
    .select("price")
    .eq("symbol", sym)
    .maybeSingle();
  return tech && tech.price != null ? Number(tech.price) : null;
}
// ===== LIVE STOCKS TAB (now: live_quotes for price, market_technicals for signal context) =====
async function runScanner() {
  document.getElementById("lastUpdate").textContent = "جاري التحديث...";
  const tb = document.getElementById("stockTableBody");
  tb.innerHTML = tableSkeleton(7, 4);

  const { data: liveRows } = await sb
    .from("live_quotes")
    .select("*")
    .limit(5000);
  const universe = await fetchUniverse();
  const universeMap = Object.fromEntries(universe.map((r) => [r.symbol, r]));
  const liveMap = Object.fromEntries(
    (liveRows || []).map((r) => [r.symbol, r]),
  );

  const results = universe.map((base) => {
    const sym = String(base.symbol || "").toUpperCase();
    const live = liveMap[sym];
    if (!base) return null;
    if (!isCommonStockRow(base)) return null;
    const price = live?.price ?? base?.price ?? null;
    if (
      price == null ||
      price < GENERAL_MARKET_RULE.minPrice ||
      price > GENERAL_MARKET_RULE.maxPrice
    )
      return null;
    const change = live?.change_pct ?? base?.change ?? null;
    const volume = Number(live?.volume || 0) || Number(base?.volume || 0) || Number(base?.avgVolume || 0) || 0;
    if (price == null) return null;
    return {
      symbol: sym,
      price,
      change: change ?? 0,
      volume,
      rsi: base?.rsi ?? null,
      sma50: base?.sma50 ?? null,
      sma200: base?.sma200 ?? null,
      sector: classifySector(base),
    };
  }).filter(Boolean);

  let html = "";
  results.forEach((d) => {
    let sig = "متابعة",
      cls = "badge-hold";
    if (d.rsi != null && d.rsi < 30 && d.change > 0) {
      sig = "شراء قوي";
      cls = "badge-strong-buy";
    } else if (d.rsi != null && d.rsi > 70 && d.change < 0) {
      sig = "بيع قوي";
      cls = "badge-strong-sell";
    } else if (
      d.sma50 != null &&
      d.sma200 != null &&
      d.price > d.sma50 &&
      d.price > d.sma200 &&
      d.change > 2
    ) {
      sig = "دخول";
      cls = "badge-buy";
    } else if (
      d.sma50 != null &&
      d.sma200 != null &&
      d.price < d.sma50 &&
      d.price < d.sma200 &&
      d.change < -2
    ) {
      sig = "خروج";
      cls = "badge-sell";
    }
    const vf = formatShareVolume(d.volume);
    const rsiTxt = d.rsi != null ? d.rsi.toFixed(1) : "—";
    html += `<tr><td><div class="sym">${d.symbol}</div></td><td class="font-mono">$${d.price.toFixed(2)}</td><td class="font-mono ${d.change >= 0 ? "text-green" : "text-red"}">${d.change >= 0 ? "+" : ""}${d.change.toFixed(2)}%</td><td class="font-mono text-muted">${vf}</td><td class="font-mono">${rsiTxt}</td><td><span class="badge ${cls}">${sig}</span></td><td><span style="color:var(--accent-cyan);cursor:pointer;font-size:16px;" onclick="quickAdd('${d.symbol}',${d.price})">+</span></td></tr>`;
  });
  tb.innerHTML =
    html ||
    '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:30px;">لا بيانات بعد — تحقق أن Actions البيانات عملت مرة واحدة على الأقل</td></tr>';
  document.getElementById("lastUpdate").textContent =
    new Date().toLocaleTimeString("ar-SA");
}

let signalRealtimeChannel = null;
function subscribeSignalRealtime() {
  if (signalRealtimeChannel) return;
  signalRealtimeChannel = sb
    .channel("az-alpha-signal-realtime")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "screener_alerts" },
      () => {
        SIGNALS_CACHE_AT = 0;
        loadSignalsData(true);
      },
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "screener_signals" },
      () => {
        SIGNALS_CACHE_AT = 0;
        loadSignalsData(true);
      },
    )
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn("Realtime غير متاح؛ سيستمر التحديث الدوري كل 15 ثانية.");
      }
    });
}

function quickAdd(sym, price) {
  document.getElementById("addSymbolInput").value = sym;
  document.getElementById("addEntryPrice").value = price.toFixed(2);
  switchTab("stocks");
  toast(`تم تحديد ${sym} — اضغط إضافة`);
}

// ===== SHARE TO X (auto-hashtags for marketer reach) =====
function shareStockToX(symbol, price, label) {
  const sym = String(symbol || "")
    .toUpperCase()
    .trim();
  if (!sym) return;
  const priceNum = Number(price);
  const priceText =
    Number.isFinite(priceNum) && priceNum > 0
      ? ` عند $${priceNum.toFixed(2)}`
      : "";
  const prefix = label ? `${label} ` : "";
  const hashtags = [
    `#${sym.replace(/[^A-Z0-9]/g, "")}`,
    "#الأسهم_الأمريكية",
    "#تحليل_فني",
    "#StockMarket",
    "#AZAlphaVision",
  ].join(" ");
  const text = `${prefix}$${sym}${priceText} — رصدها ماسح AZ Alpha Vision 📊🔍\n\n${hashtags}`;
  const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank", "noopener,noreferrer,width=600,height=520");
  if (typeof toast === "function") toast("🐦 جاري فتح نافذة المشاركة على X");
}

// ===== SCREENER (826 stock universe — one bulk query instead of per-ticker batches) =====
async function runScreener() {
  if (isScanning) return;
  isScanning = true;
  const btn = document.getElementById("scanBtn");
  btn.disabled = true;
  btn.textContent = "⏳ جاري الفلترة...";

  const filters = {
    price: document.getElementById("fPrice").value,
    change: document.getElementById("fChange").value,
    sector: document.getElementById("fSector").value,
    rsi: document.getElementById("fRSI").value,
    sma50: document.getElementById("fSMA50").value,
    sma200: document.getElementById("fSMA200").value,
    grade: document.getElementById("fGrade").value,
    relVol: document.getElementById("fRelVol").value,
    limit: parseInt(document.getElementById("fLimit").value),
    pb: document.getElementById("fPB").value,
    epsGrowth: document.getElementById("fEPSGrowth").value,
    epsNext: document.getElementById("fEPSNext").value,
    eps5y: document.getElementById("fEPS5Y").value,
    ltDebt: document.getElementById("fLTDebt").value,
    perfWeek: document.getElementById("fPerfWeek").value,
    sma20: document.getElementById("fSMA20").value,
    curVol: document.getElementById("fCurVol").value,
  };

  const tb = document.getElementById("screenerTableBody");
  const bar = document.getElementById("scanBar");
  const track = document.getElementById("scanProgress");
  const meta = document.getElementById("scanMeta");
  tb.innerHTML = tableSkeleton(13, 5);
  track.classList.add("active");
  bar.style.width = "40%";

  const universe = await fetchUniverse();
  bar.style.width = "80%";

  const filtered = universe.filter((d) => {
    if (
      d.price == null ||
      d.price < GENERAL_MARKET_RULE.minPrice ||
      d.price > GENERAL_MARKET_RULE.maxPrice
    )
      return false;
    if (
      d.sector === "healthcare" ||
      d.sector === "energy" ||
      d.sector === "reits"
    )
      return false;
    if (d.hasIssues) return false;
    if (d.hasPlan === false) return false;

    if (filters.price !== "any") {
      if (filters.price === "5to70" && (d.price < 5 || d.price > 70))
        return false;
      if (filters.price === "under5" && d.price >= 5) return false;
      if (filters.price === "5to20" && (d.price < 5 || d.price > 20))
        return false;
      if (filters.price === "20to70" && (d.price < 20 || d.price > 70))
        return false;
      if (
        filters.price === "50to100" ||
        filters.price === "over100" ||
        filters.price === "5to50" ||
        filters.price === "20to50"
      )
        return false; // قاعدة الماسح العامة: الحد الأعلى 70 دولارًا
    }
    if (filters.change !== "any" && d.change != null) {
      if (filters.change === "up" && d.change <= 0) return false;
      if (filters.change === "up3" && d.change < 3) return false;
      if (filters.change === "up5" && d.change < 5) return false;
      if (filters.change === "down" && d.change >= 0) return false;
    }
    if (filters.sector !== "any" && d.sector !== filters.sector) return false;
    if (filters.rsi !== "any" && d.rsi != null) {
      if (filters.rsi === "oversold" && d.rsi >= 30) return false;
      if (filters.rsi === "neutral" && (d.rsi < 30 || d.rsi > 70)) return false;
      if (filters.rsi === "overbought" && d.rsi <= 70) return false;
    }
    if (filters.sma50 !== "any" && d.sma50 != null) {
      if (filters.sma50 === "above" && d.price <= d.sma50) return false;
      if (filters.sma50 === "below" && d.price >= d.sma50) return false;
    }
    if (filters.sma200 !== "any" && d.sma200 != null) {
      if (filters.sma200 === "above" && d.price <= d.sma200) return false;
      if (filters.sma200 === "below" && d.price >= d.sma200) return false;
    }
    if (filters.sma20 !== "any" && d.sma20 != null) {
      if (filters.sma20 === "above" && d.price <= d.sma20) return false;
      if (filters.sma20 === "below" && d.price >= d.sma20) return false;
    }
    const relVol = Number(d.relVolume ?? 0);
    if (filters.relVol !== "any") {
      const t = { over1: 1, over2: 2, over3: 3 };
      if (relVol < t[filters.relVol]) return false;
    }
    if (filters.pb !== "any" && d.pb != null) {
      if (filters.pb === "under1" && d.pb >= 1) return false;
      if (filters.pb === "1to3" && (d.pb < 1 || d.pb > 3)) return false;
      if (filters.pb === "3to5" && (d.pb < 3 || d.pb > 5)) return false;
      if (filters.pb === "over5" && d.pb <= 5) return false;
    }
    if (filters.epsGrowth !== "any" && d.growth != null) {
      const min = { over15: 15, over30: 30, over50: 50 }[filters.epsGrowth];
      if (d.growth <= min) return false;
    }
    if (filters.epsNext !== "any" && d.epsNext != null) {
      const min = { over15: 15, over30: 30, over50: 50 }[filters.epsNext];
      if (d.epsNext <= min) return false;
    }
    if (filters.eps5y !== "any" && d.eps5y != null) {
      const min = { over15: 15, over30: 30 }[filters.eps5y];
      if (d.eps5y <= min) return false;
    }
    if (filters.ltDebt !== "any" && d.ltDebt != null) {
      if (filters.ltDebt === "under0.3" && d.ltDebt >= 0.3) return false;
      if (filters.ltDebt === "under0.6" && d.ltDebt >= 0.6) return false;
      if (filters.ltDebt === "under1" && d.ltDebt >= 1) return false;
      if (filters.ltDebt === "over1" && d.ltDebt <= 1) return false;
    }
    if (filters.perfWeek !== "any" && d.perfWeek != null) {
      if (filters.perfWeek === "up" && d.perfWeek <= 0) return false;
      if (filters.perfWeek === "up5" && d.perfWeek < 5) return false;
      if (filters.perfWeek === "up10" && d.perfWeek < 10) return false;
      if (filters.perfWeek === "down" && d.perfWeek >= 0) return false;
    }
    if (filters.curVol !== "any") {
      const t = {
        over100k: 100000,
        over500k: 500000,
        over1m: 1000000,
        over5m: 5000000,
      };
      if ((d.volume ?? 0) < t[filters.curVol]) return false;
    }
    if (filters.grade !== "any") {
      if (filters.grade === "a" && d.grade !== "A") return false;
      if (filters.grade === "ab" && d.grade !== "A" && d.grade !== "B")
        return false;
      if (filters.grade === "abc" && !["A", "B", "C"].includes(d.grade))
        return false;
    }
    return true;
  });

  filtered.sort(
    (a, b) => b.score - a.score || (b.change ?? 0) - (a.change ?? 0),
  );
  screenerResults = filtered.slice(0, filters.limit);
  LocalCache.setScreener({ t: Date.now(), r: screenerResults });

  bar.style.width = "100%";
  setTimeout(() => track.classList.remove("active"), 300);
  btn.disabled = false;
  btn.textContent = "🔍 بدء الفلترة";
  meta.innerHTML = `<span class="text-green">تم تحديث الأسهم المؤهلة من الماسح</span>`;
  renderScreener();
  toast(`تم العثور على ${screenerResults.length} سهم مطابق للفلتر المعروض`);
  isScanning = false;
  // الفلترة اليدوية محلية للاستكشاف؛ لا تغيّر الترشيحات المشتركة أو المحاكي الخلفي.
}

function renderScreener() {
  const tb = document.getElementById("screenerTableBody");
  tb.innerHTML = "";
  if (!screenerResults.length) {
    tb.innerHTML =
      '<tr><td colspan="13" style="text-align:center;color:var(--text-muted);padding:40px;">لا توجد نتائج</td></tr>';
    return;
  }
  screenerResults.forEach((d, i) => {
    let sig = "متابعة",
      cls = "badge-hold";
    const entryGuard = technicalEntryGuard(d);
    if (d.rsi != null && d.rsi < 30 && d.change > 0 && entryGuard.allow) {
      sig = "شراء مشروط";
      cls = "badge-strong-buy";
    } else if (d.rsi != null && d.rsi > 70 && d.change < 0) {
      sig = "بيع قوي";
      cls = "badge-strong-sell";
    } else if (
      d.sma50 != null &&
      d.sma200 != null &&
      d.price > d.sma50 &&
      d.price > d.sma200 &&
      d.change > 2 &&
      entryGuard.allow
    ) {
      sig = "دخول مشروط";
      cls = "badge-buy";
    } else if (
      d.sma50 != null &&
      d.sma200 != null &&
      d.price < d.sma50 &&
      d.price < d.sma200 &&
      d.change < -2
    ) {
      sig = "خروج";
      cls = "badge-sell";
    }
    const vf = formatShareVolume(d.volume || d.avgVolume);
    const gc =
      d.grade === "A"
        ? "badge-a"
        : d.grade === "B"
          ? "badge-b"
          : d.grade === "C"
            ? "badge-c"
            : d.grade === "D"
              ? "badge-d"
              : "badge-f";
    const debtColor =
      d.ltDebt == null
        ? "text-muted"
        : d.ltDebt < 0.3
          ? "text-green"
          : d.ltDebt < 0.5
            ? "text-gold"
            : "text-red";
    tb.innerHTML += `<tr><td class="font-mono">${i + 1}</td><td><div class="sym">${d.symbol}</div></td><td class="font-mono">$${d.price.toFixed(2)}</td><td class="font-mono ${(d.change ?? 0) >= 0 ? "text-green" : "text-red"}">${(d.change ?? 0) >= 0 ? "+" : ""}${(d.change ?? 0).toFixed(2)}%</td><td class="font-mono text-muted">${vf}</td><td>${sectorLabel(d.sector)}</td><td class="font-mono">${d.rsi != null ? d.rsi.toFixed(1) : "—"}</td><td class="font-mono text-cyan">${d.growth != null ? d.growth.toFixed(1) + "%" : "—"}</td><td class="font-mono">${d.pe != null ? d.pe.toFixed(1) : "—"}</td><td class="font-mono ${debtColor}">${d.ltDebt != null ? (d.ltDebt * 100).toFixed(1) + "%" : "—"}</td><td><span class="badge ${gc}">${d.grade}</span></td><td><span class="badge ${cls}">${sig}</span></td><td><div class="row-actions"><button type="button" class="icon-btn row-action-btn" title="إضافة سريعة" onclick="quickAdd('${d.symbol}',${d.price})">+</button></div></td></tr>`;
  });
}

function clearScreener() {
  activePresetKey = null;
  [
    "fPrice",
    "fChange",
    "fSector",
    "fRSI",
    "fSMA50",
    "fSMA200",
    "fGrade",
    "fPB",
    "fEPSGrowth",
    "fEPSNext",
    "fEPS5Y",
    "fLTDebt",
    "fPerfWeek",
    "fSMA20",
    "fCurVol",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "any";
  });
  const relVolEl = document.getElementById("fRelVol");
  if (relVolEl) relVolEl.value = "any";
  const priceEl = document.getElementById("fPrice");
  if (priceEl) priceEl.value = "5to70";
  document.getElementById("fLimit").value = "100";
  document.getElementById("screenerTableBody").innerHTML =
    '<tr><td colspan="13" style="text-align:center;color:var(--text-muted);padding:40px;">اضغط "بدء الفلترة" للبحث</td></tr>';
  document.getElementById("scanMeta").innerHTML = "";
  toast("🗑️ تم مسح الفلاتر");
}

function loadPreset(p) {
  activePresetKey = p;
  const presets = {
    growth: {
      price: "5to20",
      volume: "over300k",
      change: "up",
      sector: "any",
      rsi: "neutral",
      sma50: "above",
      sma200: "above",
      grade: "ab",
      relVol: "over1",
      limit: "100",
      pb: "any",
      epsGrowth: "over15",
      epsNext: "over15",
      eps5y: "any",
      ltDebt: "under0.6",
      perfWeek: "any",
      sma20: "any",
      curVol: "any",
    },
    value: {
      price: "5to70",
      volume: "over100k",
      change: "any",
      sector: "any",
      rsi: "oversold",
      sma50: "any",
      sma200: "any",
      grade: "any",
      relVol: "any",
      limit: "100",
      pb: "under1",
      epsGrowth: "any",
      epsNext: "any",
      eps5y: "any",
      ltDebt: "under0.6",
      perfWeek: "any",
      sma20: "any",
      curVol: "any",
    },
    momentum: {
      price: "5to20",
      volume: "over500k",
      change: "up5",
      sector: "any",
      rsi: "neutral",
      sma50: "above",
      sma200: "above",
      grade: "a",
      relVol: "over2",
      limit: "100",
      pb: "any",
      epsGrowth: "over30",
      epsNext: "over30",
      eps5y: "any",
      ltDebt: "any",
      perfWeek: "up5",
      sma20: "above",
      curVol: "over500k",
    },
    breakout: {
      price: "5to20",
      volume: "over1m",
      change: "up3",
      sector: "any",
      rsi: "neutral",
      sma50: "above",
      sma200: "below",
      grade: "ab",
      relVol: "over2",
      limit: "100",
      pb: "any",
      epsGrowth: "over15",
      epsNext: "any",
      eps5y: "any",
      ltDebt: "any",
      perfWeek: "up10",
      sma20: "above",
      curVol: "over1m",
    },
    swing: {
      price: "5to20",
      volume: "over300k",
      change: "any",
      sector: "any",
      rsi: "oversold",
      sma50: "below",
      sma200: "any",
      grade: "ab",
      relVol: "over1",
      limit: "100",
      pb: "any",
      epsGrowth: "over15",
      epsNext: "over15",
      eps5y: "any",
      ltDebt: "under0.6",
      perfWeek: "down",
      sma20: "below",
      curVol: "any",
    },
    dividend: {
      price: "20to70",
      volume: "over300k",
      change: "any",
      sector: "any",
      rsi: "neutral",
      sma50: "above",
      sma200: "above",
      grade: "ab",
      relVol: "any",
      limit: "100",
      pb: "any",
      epsGrowth: "any",
      epsNext: "any",
      eps5y: "any",
      ltDebt: "under0.3",
      perfWeek: "any",
      sma20: "above",
      curVol: "any",
    },
    penny: {
      price: "5to20",
      volume: "over100k",
      change: "up",
      sector: "any",
      rsi: "any",
      sma50: "any",
      sma200: "any",
      grade: "any",
      relVol: "over1",
      limit: "100",
      pb: "any",
      epsGrowth: "any",
      epsNext: "any",
      eps5y: "any",
      ltDebt: "any",
      perfWeek: "up",
      sma20: "any",
      curVol: "over100k",
    },
    opp_buy_dip: {
      price: "20to50",
      volume: "over300k",
      change: "down",
      sector: "any",
      rsi: "oversold",
      sma50: "below",
      sma200: "above",
      grade: "ab",
      relVol: "over1",
      limit: "100",
      pb: "1to3",
      epsGrowth: "over15",
      epsNext: "over15",
      eps5y: "over15",
      ltDebt: "under0.6",
      perfWeek: "down",
      sma20: "below",
      curVol: "any",
    },
    opp_earnings: {
      price: "any",
      volume: "over300k",
      change: "up3",
      sector: "any",
      rsi: "neutral",
      sma50: "above",
      sma200: "any",
      grade: "a",
      relVol: "over2",
      limit: "100",
      pb: "any",
      epsGrowth: "over30",
      epsNext: "over30",
      eps5y: "over15",
      ltDebt: "under0.6",
      perfWeek: "up5",
      sma20: "above",
      curVol: "over500k",
    },
    opp_low_float: {
      price: "5to20",
      volume: "over500k",
      change: "up",
      sector: "any",
      rsi: "any",
      sma50: "any",
      sma200: "any",
      grade: "any",
      relVol: "over2",
      limit: "100",
      pb: "any",
      epsGrowth: "any",
      epsNext: "any",
      eps5y: "any",
      ltDebt: "any",
      perfWeek: "up",
      sma20: "any",
      curVol: "over500k",
    },
    opp_analyst: {
      price: "any",
      volume: "over300k",
      change: "up",
      sector: "any",
      rsi: "neutral",
      sma50: "above",
      sma200: "above",
      grade: "a",
      relVol: "over1",
      limit: "100",
      pb: "any",
      epsGrowth: "over15",
      epsNext: "over15",
      eps5y: "over15",
      ltDebt: "under0.6",
      perfWeek: "up",
      sma20: "above",
      curVol: "any",
    },
    opp_debt_free: {
      price: "any",
      volume: "over100k",
      change: "any",
      sector: "any",
      rsi: "any",
      sma50: "any",
      sma200: "any",
      grade: "ab",
      relVol: "any",
      limit: "100",
      pb: "any",
      epsGrowth: "over15",
      epsNext: "over15",
      eps5y: "over15",
      ltDebt: "under0.3",
      perfWeek: "any",
      sma20: "any",
      curVol: "any",
    },
    opp_undervalued: {
      price: "5to70",
      volume: "over100k",
      change: "any",
      sector: "any",
      rsi: "oversold",
      sma50: "below",
      sma200: "below",
      grade: "any",
      relVol: "any",
      limit: "100",
      pb: "under1",
      epsGrowth: "over15",
      epsNext: "over15",
      eps5y: "over15",
      ltDebt: "under0.6",
      perfWeek: "down",
      sma20: "below",
      curVol: "any",
    },
    opp_tech_bounce: {
      price: "5to20",
      volume: "over500k",
      change: "up3",
      sector: "tech",
      rsi: "oversold",
      sma50: "below",
      sma200: "above",
      grade: "ab",
      relVol: "over2",
      limit: "100",
      pb: "any",
      epsGrowth: "over30",
      epsNext: "over30",
      eps5y: "over15",
      ltDebt: "under0.6",
      perfWeek: "up5",
      sma20: "below",
      curVol: "over500k",
    },
  };
  const originalPreset = presets[p];
  if (!originalPreset) return;
  const s = { ...originalPreset };
  // قاعدة الماسح العام أعلى من أي قالب: لا يُسمح بأقل من 5 أو أكثر من 70 دولارًا.
  if (["under5", "50to100", "over100", "5to50"].includes(s.price))
    s.price = "5to70";
  if (s.price === "20to50") s.price = "20to70";
  Object.entries(s).forEach(([key, val]) => {
    const idMap = {
      price: "fPrice",
      volume: "fCurVol",
      change: "fChange",
      sector: "fSector",
      rsi: "fRSI",
      sma50: "fSMA50",
      sma200: "fSMA200",
      grade: "fGrade",
      relVol: "fRelVol",
      limit: "fLimit",
      pb: "fPB",
      epsGrowth: "fEPSGrowth",
      epsNext: "fEPSNext",
      eps5y: "fEPS5Y",
      ltDebt: "fLTDebt",
      perfWeek: "fPerfWeek",
      sma20: "fSMA20",
      curVol: "fCurVol",
    };
    const el = document.getElementById(idMap[key]);
    if (el) el.value = val;
  });
  const names = {
    growth: "نمو",
    value: "قيمة",
    momentum: "زخم",
    breakout: "اختراق",
    swing: "سوينج",
    dividend: "توزيعات",
    penny: "Penny",
    opp_buy_dip: "شراء التراجع",
    opp_earnings: "مفاجأة أرباح",
    opp_low_float: "Float منخفض",
    opp_analyst: "توصية محللين",
    opp_debt_free: "خالٍ من الديون",
    opp_undervalued: "أقل من قيمته",
    opp_tech_bounce: "ارتداد تقني",
  };
  toast(`✅ فلتر ${names[p] || p} محمل — جاري الفلترة...`);
  setTimeout(() => runScreener(), 200);
}

// ===== WEEKLY PICKS =====
function updateWeeklyScanMeta(status = "اكتمل الفحص") {
  const meta = document.getElementById("weeklyScanMeta");
  if (!meta) return;
  const now = new Date();
  const statusEl = document.getElementById("weeklyScanStatus");
  if (statusEl) {
    statusEl.innerHTML = `<strong style="color:var(--accent-cyan);">آخر فحص:</strong> ${now.toLocaleString("ar-SA")} — ${status}`;
  } else {
    meta.innerHTML = `<strong style="color:var(--accent-cyan);">آخر فحص:</strong> ${now.toLocaleString("ar-SA")} — ${status}`;
  }
}
function weeklySignalDetails(row) {
  const raw = row?.entry_signals ?? row?.entrySignals ?? {};
  if (Array.isArray(raw))
    return raw.filter(Boolean).map((k) => SIG_LABEL[k] || k);
  if (raw && typeof raw === "object")
    return Object.entries(raw)
      .filter(([, on]) => Boolean(on))
      .map(([k]) => SIG_LABEL[k] || k);
  return [];
}

// وسوم مختصرة لعرضها في عمود السبب بدل الجمل الطويلة، مع إبقاء evidence الوصفي لتلميح الفأرة ولوحة AZ ai.
const EVIDENCE_SHORT_TAG = {
  "توافق فني مرتفع": "فني قوي",
  "توافق فني جيد": "فني",
  "نمو ربحية متاح": "نمو",
  "نمو متوقع متاح": "نمو متوقع",
  "مديونية منضبطة": "ديون منضبطة",
  "تقييم سعري متوازن": "قيمة",
  "سيولة داعمة": "سيولة",
};
// تصنيف قوة الفرضية A–D بحسب عدد نقاط البيانات الفعلية المتوفرة للسهم (لا علاقة له بدرجة التوصية نفسها).
function assessmentDataGrade(row) {
  const points = [
    row?.grade,
    row?.bestEntryScore ?? row?.entry_score,
    row?.growth ?? row?.eps_growth_this_year,
    row?.epsNext ?? row?.eps_growth_next_year,
    row?.ltDebt ?? row?.lt_debt_equity,
    row?.pb,
    row?.relVolume ?? row?.rel_volume ?? row?.rel_volume_9,
  ];
  const available = points.filter((v) => {
    if (v === undefined || v === null || v === "") return false;
    return typeof v === "string" ? true : Number.isFinite(Number(v));
  }).length;
  if (available >= 6) return "A";
  if (available >= 4) return "B";
  if (available >= 2) return "C";
  return "D";
}
function weeklyCompanyAssessment(row) {
  // تقييم تعليمي مركب: جودة الاتجاه والأساسيات والسيولة، لا توصية استثمارية.
  let rawScore = 48;
  const evidence = [];
  const grade = String(row?.grade || "").toUpperCase();
  const entryScore = Number(row?.bestEntryScore ?? row?.entry_score ?? 0);
  const growth = Number(row?.growth ?? row?.eps_growth_this_year);
  const nextGrowth = Number(row?.epsNext ?? row?.eps_growth_next_year);
  const debt = Number(row?.ltDebt ?? row?.lt_debt_equity);
  const pb = Number(row?.pb);
  const relativeVolume = Number(
    row?.relVolume ?? row?.rel_volume ?? row?.rel_volume_9,
  );
  if (grade === "A" || entryScore >= 4) {
    rawScore += 18;
    evidence.push("توافق فني مرتفع");
  } else if (grade === "B" || entryScore >= 3) {
    rawScore += 11;
    evidence.push("توافق فني جيد");
  }
  if (Number.isFinite(growth) && growth >= 15) {
    rawScore += 9;
    evidence.push("نمو ربحية متاح");
  }
  if (Number.isFinite(nextGrowth) && nextGrowth >= 15) {
    rawScore += 6;
    evidence.push("نمو متوقع متاح");
  }
  if (Number.isFinite(debt) && debt <= 0.6) {
    rawScore += 7;
    evidence.push("مديونية منضبطة");
  }
  if (Number.isFinite(pb) && pb > 0 && pb <= 3) {
    rawScore += 4;
    evidence.push("تقييم سعري متوازن");
  }
  if (Number.isFinite(relativeVolume) && relativeVolume >= 1.5) {
    rawScore += 5;
    evidence.push("سيولة داعمة");
  }
  const plan = weeklyEntryPlan(row);
  if (plan.avoid) rawScore -= 13;
  rawScore = Math.max(0, Math.min(100, Math.round(rawScore)));
  const label =
    rawScore >= 78 ? "قوي" : rawScore >= 62 ? "متوازن" : "للمتابعة";
  const dataGrade = assessmentDataGrade(row);
  // تحويل من 0-100 إلى 0-10 بمنزلة عشرية واحدة (مثال: 53 → 5.3) لتبسيط القراءة.
  const score = Math.round(rawScore) / 10;
  return { score, rawScore, label, evidence, plan, dataGrade };
}
function weeklyReason(row) {
  const assessment = row.companyAssessment || weeklyCompanyAssessment(row);
  const technical = [...(row.signalNames || [])].filter(Boolean);
  const tags = [];
  const primaryEvidence = assessment.evidence[0];
  if (primaryEvidence)
    tags.push(EVIDENCE_SHORT_TAG[primaryEvidence] || primaryEvidence);
  technical.forEach((name) => {
    if (tags.length < 2 && !tags.includes(name)) tags.push(name);
  });
  if (tags.length < 2 && assessment.evidence[1]) {
    const secondary = assessment.evidence[1];
    const shortSecondary = EVIDENCE_SHORT_TAG[secondary] || secondary;
    if (!tags.includes(shortSecondary)) tags.push(shortSecondary);
  }
  if (!tags.length && assessment.plan?.avoid) tags.push("بانتظار تأكيد");
  return tags.length ? `(${tags.slice(0, 2).join(" + ")})` : "(توافق عام)";
}
function weeklyEntryPlan(row) {
  const price = Number(row?.price);
  if (!Number.isFinite(price) || price <= 0)
    return {
      price: null,
      label: "لا يوجد سعر كافٍ",
      reason: "بيانات السعر غير كافية",
      avoid: true,
    };
  const guard = technicalEntryGuard(row);
  const sma20 = Number(row?.sma20),
    sma50 = Number(row?.sma50),
    rsi = Number(row?.rsi14),
    change = Number(row?.change ?? row?.change_pct ?? 0);
  const supports = [sma20, sma50]
    .filter((v) => Number.isFinite(v) && v > 0 && v <= price * 1.08)
    .sort((a, b) => b - a);
  const support = supports[0] || null;
  const reasons = [guard.reason];
  if (Number.isFinite(rsi) && rsi >= 68) reasons.push("RSI في تشبع شرائي");
  if (change >= 5) reasons.push(`ارتفاع حديث ${change.toFixed(1)}%`);
  if (Number.isFinite(sma20) && sma20 > 0 && price > sma20 * 1.08)
    reasons.push("السعر بعيد عن SMA20");
  if (support)
    reasons.push(
      `منطقة دعم قرب SMA${support === sma20 ? "20" : "50"} عند $${support.toFixed(2)}`,
    );
  if (!guard.allow) {
    const target = support ? Math.min(price, support * 1.01) : price * 0.97;
    return {
      price: Math.max(5, Number(target.toFixed(2))),
      label: "انتظار تأكيد/تراجع",
      reason: reasons.join("؛ "),
      avoid: true,
    };
  }
  const target = support ? Math.min(price, support * 1.02) : price;
  reasons.push("لا توجد مطاردة واضحة للسعر");
  return {
    price: Number(target.toFixed(2)),
    label: "دخول عند التأكيد",
    reason: reasons.join("؛ "),
    avoid: false,
  };
}

async function runWeeklyScan() {
  const tb = document.getElementById("picksCards");
  const watchTb = document.getElementById("watchPicksCards");
  if (!tb) return;
  updateWeeklyScanMeta("جارٍ تحديث الترشيحات من بيانات الماسح");
  tb.innerHTML = '<div class="picks-card-empty">جارٍ تجهيز الترشيحات…</div>';
  if (watchTb) watchTb.innerHTML = '<div class="picks-card-empty">جارٍ تجهيز المتابعة…</div>';

  try {
    // المصدر المشترك هو كل صفوف screener_signals التي ينتجها محرك القوالب الخلفي، لا آخر فلتر فتَحه مستخدم.
    if (!Array.isArray(SIGNALS_CACHE)) await loadSignalsData(true);
    let universe = [];
    try {
      universe = (await fetchUniverse(true)) || [];
    } catch (error) {
      console.warn(
        "تعذر جلب الكون الكامل؛ سيتم استخدام إشارات الماسح المخزنة.",
        error,
      );
      universe = Array.isArray(SIGNALS_CACHE) ? SIGNALS_CACHE : [];
    }
    const universeMap = Object.fromEntries(
      universe.map((row) => [String(row.symbol || "").toUpperCase(), row]),
    );
    const merged = new Map();
    const signalRows = Array.isArray(SIGNALS_CACHE) ? SIGNALS_CACHE : [];

    signalRows.forEach((row) => {
      const symbol = String(row?.symbol || "")
        .trim()
        .toUpperCase();
      const base = universeMap[symbol] || null;
      const entryScore = Number(row?.entry_score ?? row?.entryScore ?? 0);
      const preset = String(row?.preset || "").trim();
      const price = Number(row?.price ?? base?.price);
      const source = { ...(base || {}), ...row, symbol, price };
      const sourceSafe = isStoredSignalCommonStock(source);
      if (!sourceSafe || entryScore <= 0) return;
      let item = merged.get(symbol);
      if (!item) {
        item = {
          ...source,
          symbol,
          price,
          presets: new Set(),
          signalNames: new Set(),
          tiers: new Set(),
          bestEntryScore: 0,
          totalEntryScore: 0,
        };
        merged.set(symbol, item);
      }
      if (preset) item.presets.add(preset);
      item.bestEntryScore = Math.max(item.bestEntryScore, entryScore);
      item.totalEntryScore += entryScore;
      const tier = String(row?.entry_tier ?? row?.entryTier ?? "").trim();
      if (tier) item.tiers.add(tier);
      weeklySignalDetails(row).forEach((name) => item.signalNames.add(name));
    });

    const candidates = [...merged.values()]
      .map((item) => {
        const templateCount = item.presets.size;
        const signalCount = item.signalNames.size;
        const bestTier =
          [...item.tiers].sort(
            (a, b) =>
              (({ صريح: 3, مؤكد: 2, دخول: 1 })[b] || 0) -
              ({ صريح: 3, مؤكد: 2, دخول: 1 }[a] || 0),
          )[0] || "إشارة";
        item.templateCount = templateCount;
        item.signalCount = signalCount;
        item.bestTier = bestTier;
        item.companyAssessment = weeklyCompanyAssessment(item);
        item.entryPlan = item.companyAssessment.plan;
        item.aiReason = weeklyReason(item);
        // نخفض ترتيب السهم إذا كان في تشبع شرائي أو بعيدًا عن منطقة الدعم؛ يبقى للمتابعة بدل مطاردة السعر.
        item.pickScore =
          templateCount * 10 +
          item.bestEntryScore * 4 +
          signalCount * 2 +
          item.totalEntryScore +
          item.companyAssessment.score -
          (item.entryPlan.avoid ? 8 : 0);
        return item;
      })
      .sort(
        (a, b) =>
          b.pickScore - a.pickScore ||
          b.templateCount - a.templateCount ||
          b.bestEntryScore - a.bestEntryScore ||
          (b.change ?? 0) - (a.change ?? 0),
      );

    // «متابعة» ناتجة من مطابقة جزئية للقوالب: ظاهرة للتعلم ولا تصلح تلقائيًا للدخول أو التداول.
    const actionable = candidates.filter((item) => !item.tiers.has("مراقبة"));
    const monitoring = candidates.filter((item) => item.tiers.has("مراقبة"));
    const top = actionable.slice(0, 7);
    const watch = [...actionable.slice(7), ...monitoring].slice(0, 7);
    tb.innerHTML = "";
    if (watchTb) watchTb.innerHTML = "";
    if (!top.length) {
      LocalCache.setPicks([]);
      renderSignalGridPicks();
      document.getElementById("sitePicksCount").textContent = "0";
      document.getElementById("siteAvgReturn").textContent = "0.00%";
      document.getElementById("siteWinRate").textContent = "0%";
      document.getElementById("sitePicksDesc").textContent = watch.length
        ? `لا توجد منطقة دخول مؤكدة الآن؛ توجد ${watch.length} أسهم للمراقبة من جميع القوالب.`
        : "لا توجد إشارة دخول أو سهم متابعة مؤهل من القوالب حاليًا.";
      updateWeeklyScanMeta(
        watch.length
          ? "اكتمل الفحص — أسهم تحت المراقبة حتى تتأكد منطقة الدخول"
          : "اكتمل الفحص — لا توجد إشارة دخول من القوالب",
      );
      tb.innerHTML =
        '<div class="picks-card-empty">لا توجد إشارة دخول مؤكدة حاليًا؛ لا يتم ملء الترشيحات بصفقات افتراضية غير مكتملة.</div>';
    }

    updateWeeklyScanMeta(`اكتمل الفحص — تم اختيار الترشيحات والمتابعة`);
    const nowIso = new Date().toISOString();
    LocalCache.setPicks(
      top.map((s) => ({
        symbol: s.symbol,
        price: s.price,
        entryPrice: s.entryPlan?.price ?? s.price,
        entryStatus: s.entryPlan?.label,
        entryReason: s.entryPlan?.reason,
        exchange: s.exchange,
        industry: s.industry,
        company: s.company,
        companyRating: s.companyAssessment?.score,
        companyRatingLabel: s.companyAssessment?.label,
        aiReason: s.aiReason,
        presets: [...s.presets],
        date: nowIso.split("T")[0],
        scannedAt: nowIso,
        score: s.pickScore,
      })),
    );
    renderSignalGridPicks();
    updateSitePerformance();
    refreshCompanyNews();
    refreshEarningsCalendar();

    const renderRow = (s, i, watchOnly = false) => {
      const assessment = s.companyAssessment || weeklyCompanyAssessment(s);
      const plan = s.entryPlan || assessment.plan || weeklyEntryPlan(s);
      const entryText = plan.price
        ? `$${plan.price.toFixed(2)} — ${plan.label}`
        : "غير متاح";
      const badge = watchOnly
        ? "للمتابعة"
        : s.bestTier === "صريح"
          ? "إشارة صريحة"
          : s.bestTier === "مؤكد"
            ? "إشارة مؤكدة"
            : "إشارة دخول";
      const ratingClass =
        assessment.rawScore >= 78
          ? "text-green"
          : assessment.rawScore >= 62
            ? "text-cyan"
            : "text-gold";
      const gradeBadgeClass = `badge-${String(assessment.dataGrade || "D").toLowerCase()}`;
      const reason = sigEsc(s.aiReason || weeklyReason(s));
      const gold = !watchOnly && i === 0;
      return `<article class="pick-card${gold ? " pick-card-gold" : ""}${watchOnly ? " pick-card-watch" : ""}" title="${sigEsc(`${watchOnly ? "متابعة" : "ترشيح"}: ${reason}`)}">
        <header>
          <span class="pick-rank">${gold ? "↑" : i + 1}</span>
          <strong class="pick-sym">${sigEsc(s.symbol)}</strong>
          ${gold ? '<span class="gold-flag">السهم الذهبي</span>' : ""}
          ${watchOnly ? "" : '<span class="ai-follow">متابعة AZ أولاً</span>'}
        </header>
        <div class="pick-metrics">
          <div><small>التقييم</small><b class="${ratingClass}">${assessment.score.toFixed(1)}/10</b> <span class="badge ${gradeBadgeClass} rating-grade-badge">${assessment.dataGrade}</span></div>
          <div><small>السعر</small><b class="font-mono">$${Number(s.price).toFixed(2)}</b></div>
          <div><small>المنطقة</small><b>${sigEsc(entryText)}</b></div>
        </div>
        <p class="pick-reason">${reason}</p>
        <footer><span class="pick-badge">${badge}</span><small>${assessment.label}</small></footer>
      </article>`;
    };
    top.forEach((s, i) => {
      tb.innerHTML += renderRow(s, i, false);
    });
    if (watchTb) {
      if (!watch.length)
        watchTb.innerHTML =
          '<div class="picks-card-empty">لا توجد أسهم إضافية للمتابعة حاليًا</div>';
      else
        watch.forEach((s, i) => {
          watchTb.innerHTML += renderRow(s, i, true);
        });
    }
    syncGoldenOrbit();
    toast(`تم اختيار ${top.length} ترشيحات و${watch.length} للمتابعة`);
  } catch (error) {
    console.error("تعذر تحديث ترشيحات الأسبوع:", error);
    updateWeeklyScanMeta(
      "تعذر التحديث الآن — سيتم استخدام آخر نتائج موثوقة عند المحاولة التالية",
    );
      tb.innerHTML =
        '<div class="picks-card-empty">تعذر تحديث الترشيحات الآن. تحقق من اتصال بيانات الماسح ثم أعد المحاولة.</div>';
    if (watchTb)
      watchTb.innerHTML =
        '<div class="picks-card-empty">لا تتوفر قائمة متابعة حاليًا.</div>';
  }
}

async function updateSitePerformance() {
  let picks = LocalCache.getPicks();
  if (!picks) return;
  // الترشيحات القديمة بلا exchange/industry غير موثوقة؛ تُمسح بدل عرض رموز أدوات مالية.
  if (
    picks.some(
      (p) =>
        !["NYSE", "NASDAQ"].includes(String(p.exchange || "").toUpperCase()),
    )
  ) {
    LocalCache.setPicks([]);
    renderSignalGridPicks();
    document.getElementById("sitePicksCount").textContent = "0";
    document.getElementById("sitePicksDesc").textContent =
      "تم حذف ترشيحات قديمة غير موثوقة؛ شغّل مسح الأسبوع لإنشاء قائمة جديدة.";
    return;
  }
  picks = picks.filter((p) => isCommonStockRow(p));
  LocalCache.setPicks(picks);
  renderSignalGridPicks();
  document.getElementById("sitePicksCount").textContent = picks.length;

  const prices = await Promise.all(picks.map((p) => fetchPrice(p.symbol)));
  let totalReturn = 0,
    wins = 0,
    counted = 0;
  picks.forEach((p, i) => {
    const current = prices[i];
    if (current == null) return;
    const ret = ((current - p.price) / p.price) * 100;
    totalReturn += ret;
    counted++;
    if (ret > 0) wins++;
  });
  const avgReturn = counted > 0 ? totalReturn / counted : 0;
  const winRate = counted > 0 ? (wins / counted) * 100 : 0;

  const avgEl = document.getElementById("siteAvgReturn");
  avgEl.textContent = (avgReturn >= 0 ? "+" : "") + avgReturn.toFixed(2) + "%";
  avgEl.className = "val " + (avgReturn >= 0 ? "pos" : "neg");
  document.getElementById("siteWinRate").textContent = winRate.toFixed(0) + "%";
  document.getElementById("sitePicksDesc").innerHTML = `
        <strong style="color:var(--accent-cyan);">📅 آخر تحديث:</strong> ${picks[0]?.date || "--"}<br>
        العائد محسوب من سعر الترشيح إلى آخر سعر حقيقي متوفر
    `;
}

// ===== 🎯 الماسح والتنبيهات (محرك التوافق الحقيقي — من نفس بيانات Supabase) =====
let SIGNALS_CACHE = null,
  SIGNALS_ALERTS = null,
  SIGNALS_PERF = null,
  SIGNALS_CACHE_AT = 0;
let signalChartInstance = null;

const SIG_TIER_COLOR = {
  صريح: "badge-strong-buy",
  مؤكد: "badge-buy",
  دخول: "badge-hold",
  مراقبة: "badge-hold",
};
const SIG_TIER_COLOR_EXIT = {
  صريح: "badge-strong-sell",
  مؤكد: "badge-sell",
  خروج: "badge-hold",
};
const SIG_LABEL = {
  fibonacci: "فيبوناتشي",
  smc_atr: "SMC+ATR",
  candlestick: "شمعة",
  volume: "حجم",
  template_progress: "تقدم القالب",
};
const SIG_PRESET_LABEL = {
  military: "توافق المؤشرات الأربعة",
  quality_value: "قيمة وربحية",
  growth: "نمو الأرباح",
  growth_beta: "زخم سعري وحجم",
  value: "قيمة مغرية",
  momentum: "زخم سعري",
  breakout: "اختراق",
  swing: "سوينج",
  dividend: "توزيعات",
  penny: "سيولة وحركة",
  opp_buy_dip: "شراء التراجع",
  opp_earnings: "مفاجأة أرباح",
  opp_low_float: "حجم متسارع",
  opp_analyst: "اتجاه قوي",
  opp_debt_free: "دين منخفض",
  opp_undervalued: "أقل من قيمته",
  opp_tech_bounce: "ارتداد تقني",
};
let signalAudioContext = null;
function playSignalAlertSound() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  try {
    signalAudioContext ||= new AudioCtx();
    if (signalAudioContext.state === "suspended") signalAudioContext.resume();
    const now = signalAudioContext.currentTime;
    [0, 0.18, 0.36].forEach((offset, i) => {
      const oscillator = signalAudioContext.createOscillator();
      const gain = signalAudioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = i === 2 ? 1046 : 880;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.16, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.14);
      oscillator.connect(gain).connect(signalAudioContext.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.15);
    });
  } catch (e) {
    console.warn("تعذر تشغيل صوت التنبيه", e);
  }
}
function playNewSignalAlertSound(alerts) {
  const latest = alerts?.[0];
  if (!latest) return;
  const key = String(
    latest.id || `${latest.ts}:${latest.symbol}:${latest.type}`,
  );
  const previous = localStorage.getItem("az_last_signal_alert");
  localStorage.setItem("az_last_signal_alert", key);
  const age = Date.now() - new Date(latest.ts).getTime();
  if (previous !== key && age >= 0 && age < 15 * 60 * 1000)
    playSignalAlertSound();
}

function sigEsc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

async function loadSignalsData(force = false) {
  if (!force && SIGNALS_CACHE && Date.now() - SIGNALS_CACHE_AT < 10 * 1000)
    return; // احتياطي سريع عند تعذر أحداث Realtime
  const meta = document.getElementById("signalsMeta");
  meta.innerHTML = "جاري التحميل من قاعدة البيانات...";
  try {
    const [
      { data: sig, error: e1 },
      { data: alerts, error: e2 },
      { data: perf, error: e3 },
      { data: fundamentals, error: e4 },
      { data: technicals, error: e5 },
    ] = await Promise.all([
      sb
        .from("screener_signals")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(10000),
      sb
        .from("screener_alerts")
        .select("*")
        .order("ts", { ascending: false })
        .limit(100),
      sb.from("screener_performance").select("*"),
      sb
        .from("market_fundamentals")
        .select("symbol,price,exchange,industry,company,finviz_sector,sector"),
      sb
        .from("market_technicals")
        .select(
          "symbol,price,change_pct,rsi14,sma20,sma50,sma200,distance_from_sma20,distance_from_sma50,distance_from_sma200",
        ),
    ]);
    if (e1) throw e1;
    if (e4) throw e4;
    if (e5) throw e5;
    const fundMap = Object.fromEntries(
      (fundamentals || []).map((f) => [
        String(f.symbol || "").toUpperCase(),
        f,
      ]),
    );
    const techMap = Object.fromEntries(
      (technicals || []).map((t) => [String(t.symbol || "").toUpperCase(), t]),
    );
    const withContext = (row) => {
      const symbol = String(row?.symbol || "")
        .trim()
        .toUpperCase();
      const fund = fundMap[symbol] || {};
      const tech = techMap[symbol] || {};
      return {
        ...fund,
        ...tech,
        ...row,
        symbol,
        price: row?.price ?? tech?.price ?? fund?.price,
      };
    };
    const validSignalRow = (row) => isStoredSignalCommonStock(row);
    const storedSignals = (sig || []).map(withContext);
    SIGNALS_CACHE = storedSignals.filter(
      (row) => Number(row?.entry_score ?? row?.entryScore ?? 0) > 0 && validSignalRow(row),
    );
    if (!SIGNALS_CACHE.length && storedSignals.length) {
      meta.innerHTML = `تم تحميل ${storedSignals.length} إشارة، لكن لم تجتز حارس السهم/السعر — راجع مصدر السعر أو نوع الأداة`;
    }
    // تنبيهات الخروج تبقى ظاهرة، أما دخول غير آمن/بعد ارتفاع حاد فيتحول إلى متابعة فقط.
    SIGNALS_ALERTS = (alerts || [])
      .map(withContext)
      .filter(validSignalRow)
      .filter((a) => a.type !== "entry" || technicalEntryGuard(a).allow);
    playNewSignalAlertSound(SIGNALS_ALERTS);
    SIGNALS_PERF = perf || [];
    SIGNALS_CACHE_AT = Date.now();
    meta.innerHTML = `آخر تحديث: <span>${SIGNALS_CACHE[0] ? new Date(SIGNALS_CACHE[0].updated_at).toLocaleString("ar-SA") : "--"}</span> — تم تحميل ${SIGNALS_CACHE.length} إشارة من جميع القوالب النشطة`;
    renderSignalAlerts();
    renderSignalPerformance("month");
    if (!window.__weeklyRefreshQueued) {
      window.__weeklyRefreshQueued = true;
      setTimeout(() => {
        window.__weeklyRefreshQueued = false;
        runWeeklyScan();
      }, 0);
    }
  } catch (err) {
    meta.innerHTML =
      "<b style='color:var(--accent-red);'>تعذر تحميل بيانات الماسح — تأكد أن fetch_screener_signals.py عمل مرة واحدة على الأقل.</b>";
    console.error(err);
  }
}

function runSignalScan(presetKey = "all") {
  if (!Array.isArray(SIGNALS_CACHE)) return;
  const showingAll = presetKey === "all";
  // الأزرار السريعة تُحوّل إلى مجموعات من القوالب التي ينتجها المحرك الخلفي فعلًا.
  const presetGroups = {
    military: ["momentum", "breakout", "opp_analyst", "opp_tech_bounce"],
    quality_value: ["value", "opp_undervalued", "opp_debt_free"],
    growth_beta: ["momentum", "opp_earnings", "opp_low_float"],
  };
  const allowedPresets = presetGroups[presetKey] || [presetKey];
  const stocks = SIGNALS_CACHE.filter(
    (s) => showingAll || allowedPresets.includes(s.preset),
  ).sort(
    (a, b) =>
      (Number(b.entry_score) || 0) - (Number(a.entry_score) || 0) ||
      String(a.symbol).localeCompare(String(b.symbol)),
  );
  const label = showingAll
    ? "جميع القوالب الخلفية"
    : SIG_PRESET_LABEL[presetKey] || presetKey;
  document.getElementById("signalsMeta").innerHTML =
    `${label} — أسهم بإشارة: <span>${stocks.length}</span>`;
  renderSignalsTable(stocks);
  renderAZAssistant(stocks[0], presetKey);
}

function renderAZAssistant(stock, presetKey) {
  const box = document.getElementById("azAssistantBox");
  if (!box) return;
  if (!stock) {
    box.innerHTML =
      "<strong>AZ</strong> — لا توجد إشارة مؤهلة في هذا القالب حاليًا.";
    return;
  }
  const signals = stock.entry_signals || {};
  const active = Object.entries(signals)
    .filter(([, on]) => on)
    .map(([key]) => SIG_LABEL[key] || key);
  const tier = stock.entry_tier || "دون إشارة";
  const price = Number(stock.price);
  const priceText = Number.isFinite(price)
    ? `$${price.toFixed(2)}`
    : "غير متاح";
  const plan = weeklyEntryPlan(stock);
  const assessment = weeklyCompanyAssessment({
    ...stock,
    bestEntryScore: stock.entry_score,
  });
  const templateLabel =
    presetKey === "all"
      ? "المصدر الموحد لجميع القوالب"
      : SIG_PRESET_LABEL[presetKey] || presetKey;
  const timing = plan.avoid
    ? "المنصة تصنفه للمتابعة حتى يصل إلى منطقة الدخول أو يتأكد الاتجاه؛ لا ملاحقة للسعر."
    : "منطقة الدخول التعليمية متوافقة حاليًا مع الحارس الفني.";
  const reason = weeklyReason({
    ...stock,
    presets: new Set([stock.preset]),
    signalNames: new Set(active),
    companyAssessment: assessment,
  });
  box.innerHTML = `<strong>AZ ai</strong> — ${sigEsc(stock.symbol)} عند سعر مرجعي ${priceText}. التقييم التعليمي: <b>${assessment.score.toFixed(1)}/10 (${assessment.label})</b> — قوة الفرضية: <b>${assessment.dataGrade}</b>. السبب: ${sigEsc(reason)}. المصدر: ${sigEsc(templateLabel)}. ${timing}<div id="azNews" style="margin-top:12px;color:var(--text-muted);">جاري جلب الأخبار المرتبطة بالرمز...</div>`;
  loadAZNews(stock.symbol, stock.company || stock.name || stock.symbol);
}

function azNewsTone(title, snippet = "") {
  const text = `${title} ${snippet}`.toLowerCase();
  const positive =
    /earnings beat|profit|revenue growth|upgrade|partnership|contract|approval|award|record|raises guidance|beats estimates|نمو الأرباح|أرباح|ترقية|عقد|موافقة|شراكة/.test(
      text,
    );
  const negative =
    /loss|layoff|downgrade|lawsuit|investigation|warning|bankruptcy|default|misses estimates|cuts guidance|offering|dilution|خسارة|تسريح|دعوى|تحقيق|إفلاس|تحذير|طرح أسهم/.test(
      text,
    );
  return positive && !negative
    ? "إيجابي"
    : negative && !positive
      ? "سلبي"
      : "مختلط/محايد";
}

async function loadAZNews(symbol, company) {
  const target = document.getElementById("azNews");
  if (!target) return;
  const query = encodeURIComponent(
    `"${symbol}" OR "${String(company)
      .replace(/[^a-zA-Z0-9 .&-]/g, " ")
      .trim()}"`,
  );
  const endpoint = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=artlist&maxrecords=5&timespan=7d&sort=datedesc&format=json`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const articles = Array.isArray(data.articles) ? data.articles : [];
    if (!articles.length) {
      target.innerHTML = `<strong>أخبار AZ:</strong> لا توجد أخبار موثوقة مرتبطة بـ ${sigEsc(symbol)} خلال آخر 7 أيام. <small>المصدر: GDELT</small>`;
      return;
    }
    target.innerHTML = `<strong>أخبار AZ — آخر 7 أيام</strong><div style="margin-top:8px;display:grid;gap:6px;">${articles
      .map((article) => {
        const title = sigEsc(article.title || "خبر بلا عنوان");
        const url = /^https?:\/\//i.test(String(article.url || ""))
          ? String(article.url)
          : "#";
        const tone = azNewsTone(article.title || "", article.seendate || "");
        const date = String(article.seendate || "").replace(
          /(\d{4})(\d{2})(\d{2}).*/,
          "$1-$2-$3",
        );
        return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:var(--text-main);text-decoration:none;border-bottom:1px solid var(--border);padding:5px 0;">${title} <span class="text-muted">(${tone} — ${sigEsc(date)})</span></a>`;
      })
      .join(
        "",
      )}</div><small>المصدر المجاني: GDELT؛ افتح الرابط لقراءة النص الكامل.</small>`;
  } catch (err) {
    target.innerHTML = `<strong>أخبار AZ:</strong> تعذر جلب الأخبار الآن. لا تُستخدم الأخبار كإشارة مستقلة. <small>المصدر: GDELT</small>`;
  }
}

function sigDots(signals, isEntry) {
  if (!signals) return "";
  return Object.entries(signals)
    .map(
      ([k, on]) =>
        `<span title="${SIG_LABEL[k] || k}" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-left:3px;background:${on ? (isEntry ? "var(--accent-green)" : "var(--accent-red)") : "var(--text-dim)"};"></span>`,
    )
    .join("");
}

function renderSignalsTable(stocks) {
  const tb = document.getElementById("signalsTableBody");
  if (!stocks.length) {
    tb.innerHTML =
      '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:30px;">لا أسهم بلغت أولي (2/4 إشارات) ضمن هذا الفلتر حاليًا</td></tr>';
    return;
  }
  tb.innerHTML = stocks
    .map((s) => {
      const entryPlan = weeklyEntryPlan(s);
      const entryBadge =
        s.entry_tier && Number.isFinite(Number(s.price)) && Number(s.price) > 0
          ? `<span class="badge ${SIG_TIER_COLOR[s.entry_tier]}">${sigEsc(s.entry_tier)} (${Number(s.entry_score)}/4)</span><div class="text-muted signal-entry-hint">$${Number(s.price).toFixed(2)} → $${entryPlan.price?.toFixed(2) || "—"}</div>`
          : '<span class="text-muted">—</span>';
      const exitBadge =
        s.exit_tier && Number.isFinite(Number(s.price)) && Number(s.price) > 0
          ? `<span class="badge ${SIG_TIER_COLOR_EXIT[s.exit_tier]}">${sigEsc(s.exit_tier)} (${Number(s.exit_score)}/4)</span>`
          : '<span class="text-muted">—</span>';
      return `<tr>
            <td class="sym">${sigEsc(s.symbol)}</td>
            <td class="font-mono">$${Number(s.price).toFixed(2)}</td>
            <td class="font-mono">${s.pe != null ? Number(s.pe).toFixed(1) : "—"}</td>
            <td>${entryBadge}<div style="margin-top:4px;">${sigDots(s.entry_signals, true)}</div></td>
            <td>${exitBadge}<div style="margin-top:4px;">${sigDots(s.exit_signals, false)}</div></td>
        </tr>`;
    })
    .join("");
}

function renderSignalAlerts() {
  const tb = document.getElementById("signalsAlertsBody");
  if (!tb) return;
  if (!SIGNALS_ALERTS || !SIGNALS_ALERTS.length) {
    tb.innerHTML =
      '<div class="text-muted" style="text-align:center;padding:20px;">لا تنبيهات مسجّلة بعد</div>';
    return;
  }
  tb.innerHTML = SIGNALS_ALERTS.map((a) => {
    const isEntry = a.type === "entry";
    const symbol = String(a.symbol || "")
      .trim()
      .toUpperCase();
    const context =
      SIGNALS_CACHE?.find(
        (s) => String(s.symbol).toUpperCase() === symbol,
      ) || a;
    const entryPlan = isEntry
      ? weeklyEntryPlan({ ...context, price: a.price ?? context.price })
      : null;
    const badge = isEntry
      ? SIG_TIER_COLOR[a.tier]
      : SIG_TIER_COLOR_EXIT[a.tier];
    const priceNum = Number(a.price);
    const priceText = Number.isFinite(priceNum)
      ? `$${priceNum.toFixed(2)}`
      : "—";
    const hint = isEntry
      ? `مقترح: $${entryPlan?.price?.toFixed(2) || "—"}`
      : "خروج تعليمي";
    return `<article class="alert-card">
      <div class="alert-card-top"><strong class="sym">${sigEsc(symbol || "—")}</strong><span class="badge ${badge}">${isEntry ? "دخول" : "خروج"} ${sigEsc(a.tier || "")} (${a.score}/4)</span></div>
      <div class="alert-card-meta">${new Date(a.ts).toLocaleString("ar-SA")} · ${SIG_PRESET_LABEL[a.preset] || sigEsc(a.preset || "")}</div>
      <div class="alert-card-price">${priceText} — ${sigEsc(hint)}</div>
    </article>`;
  }).join("");
}

function renderSignalPerformance(granularity) {
  document
    .querySelectorAll('[id^="sigPerfTab_"]')
    .forEach((b) => b.classList.remove("active"));
  const btn = document.getElementById("sigPerfTab_" + granularity);
  if (btn) btn.classList.add("active");

  const container = document.getElementById("signalPerformanceBody");
  if (!SIGNALS_PERF) {
    container.innerHTML = "";
    return;
  }
  const rows = SIGNALS_PERF.filter((p) => p.granularity === granularity).sort(
    (a, b) => a.period.localeCompare(b.period),
  );

  if (!rows.length) {
    container.innerHTML = `<p class="text-muted" style="text-align:center;padding:20px;">لا صفقات مُقفلة بعد لعرض أداء ${granularity === "month" ? "شهري" : granularity === "quarter" ? "ربعي" : granularity === "half" ? "نصف سنوي" : "سنوي"} — تتراكم مع كل تشغيل مجدول.</p>`;
    return;
  }
  container.innerHTML = `
        <table class="data-table">
            <thead><tr><th>الفترة</th><th>الصفقات</th><th>نسبة الربح</th><th>متوسط العائد</th><th>الإجمالي</th></tr></thead>
            <tbody>${rows
              .map((r) => {
                const cls = r.total_return_pct >= 0 ? "text-green" : "text-red";
                return `<tr><td class="font-mono">${r.period}</td><td>${r.trades}</td><td>${r.win_rate}%</td><td class="${cls}">${r.avg_return_pct >= 0 ? "+" : ""}${r.avg_return_pct}%</td><td class="${cls} font-mono">${r.total_return_pct >= 0 ? "+" : ""}${r.total_return_pct}%</td></tr>`;
              })
              .join("")}</tbody>
        </table>`;
}

async function openSignalChart(symbol) {
  const modal = document.getElementById("signalChartModal");
  const title = document.getElementById("signalChartTitle");
  const cont = document.getElementById("signalChartContainer");
  title.textContent = symbol + " — الفاصل اليومي";
  modal.classList.add("active");
  cont.innerHTML = "";

  const { data, error } = await sb
    .from("screener_charts")
    .select("data")
    .eq("symbol", symbol)
    .maybeSingle();
  if (error || !data || !data.data || !data.data.length) {
    cont.innerHTML =
      '<p class="text-muted" style="text-align:center;padding:40px;">لا بيانات شارت محفوظة لهذا الرمز بعد.</p>';
    return;
  }
  if (signalChartInstance) {
    signalChartInstance.remove();
    signalChartInstance = null;
  }
  signalChartInstance = LightweightCharts.createChart(cont, {
    width: cont.clientWidth,
    height: 360,
    layout: { background: { color: "transparent" }, textColor: "#6b7280" },
    grid: {
      vertLines: { color: "rgba(255,255,255,0.03)" },
      horzLines: { color: "rgba(255,255,255,0.03)" },
    },
    timeScale: { borderColor: "rgba(255,255,255,0.06)" },
  });
  const series = signalChartInstance.addCandlestickSeries({
    upColor: "#00e676",
    downColor: "#ff1744",
    borderUpColor: "#00e676",
    borderDownColor: "#ff1744",
    wickUpColor: "#00e676",
    wickDownColor: "#ff1744",
  });
  series.setData(
    data.data.map(([time, open, high, low, close]) => ({
      time,
      open,
      high,
      low,
      close,
    })),
  );
  signalChartInstance.timeScale().fitContent();
}

// ===== EDUCATION, SIMULATION CONSENT & 60-DAY TRIAL =====
const TRIAL_DAYS = 30;
function ensureEducationConsent() {
  // بعد موافقة الحساب مرة واحدة لا نعرض الإقرار في تسجيلات الدخول اللاحقة.
  const localKey = `az_education_consent_${currentUser?.id || "guest"}`;
  const raw = localStorage.getItem(localKey);
  let localAccepted = false;
  try {
    localAccepted = JSON.parse(raw || "null")?.accepted === "accepted";
  } catch {
    localAccepted = raw === "accepted";
  }
  const profileAccepted =
    currentProfile?.age_confirmed === true &&
    !!currentProfile?.education_consent_at;
  if (localAccepted || profileAccepted) return true;
  const modal = document.getElementById("educationDisclaimerModal");
  if (modal) modal.classList.add("active");
  return false;
}
async function acceptEducationConsent() {
  const age = document.getElementById("consentAge18")?.checked;
  const simulation = document.getElementById("consentSimulation")?.checked;
  const education = document.getElementById("consentEducation")?.checked;
  if (!age || !simulation || !education) {
    toast("يجب تأكيد جميع بنود الإقرار قبل المتابعة", "warn");
    return;
  }
  const key = `az_education_consent_${currentUser?.id || "guest"}`;
  localStorage.setItem(
    key,
    JSON.stringify({
      accepted: "accepted",
      age18: true,
      at: new Date().toISOString(),
    }),
  );
  if (currentUser?.id) {
    // يعمل حتى لو لم تُضف أعمدة الموافقة بعد؛ لا يمنع دخول المستخدم عند اختلاف المخطط.
    const consentAt = new Date().toISOString();
    const { error: consentError } = await sb
      .from("profiles")
      .update({ age_confirmed: true, education_consent_at: consentAt })
      .eq("id", currentUser.id);
    if (!consentError && currentProfile) {
      currentProfile.age_confirmed = true;
      currentProfile.education_consent_at = consentAt;
    }
  }
  document
    .getElementById("educationDisclaimerModal")
    ?.classList.remove("active");
  toast("تم قبول الإقرار التعليمي والمحاكاة");
}
function closeEducationDisclaimer() {
  toast("لا يمكن استخدام المنصة دون قبول الإقرار التعليمي", "warn");
}
async function ensureTrialPeriod(profile) {
  if (!profile || profile.role === "admin" || profile.trial_end) return profile;
  const base = profile.created_at ? new Date(profile.created_at) : new Date();
  const end = new Date(base.getTime() + TRIAL_DAYS * 86400000).toISOString();
  const { error } = await sb
    .from("profiles")
    .update({ trial_end: end })
    .eq("id", profile.id);
  if (!error) profile.trial_end = end;
  else console.warn("تعذر إنشاء فترة التجربة تلقائيًا:", error.message);
  return profile;
}
const COURSE_LESSONS = [
  {
    title: "مقدمة: ما هي المحاكاة؟",
    body: "<p>هذه المنصة بيئة تعليمية تحاكي قراءة السوق ولا تنفذ أوامر شراء أو بيع حقيقية. الهدف هو التدريب على بناء الفرضية وقياسها، لا تقديم توصية.</p><p><strong>مثال تطبيقي:</strong> سجّل سبب اختيار سهم افتراضي، مستوى الدخول الافتراضي، نقطة الإلغاء، ثم راقب النتيجة دون أموال حقيقية.</p>",
    source: "SEC Investor.gov — https://www.investor.gov/",
  },
  {
    title: "قراءة السعر والاتجاه",
    body: "<p>تعلّم الفرق بين الاتجاه الصاعد والهابط والجانبي، وكيف تستخدم القمم والقيعان بدل مطاردة حركة قصيرة.</p><p><strong>تمرين:</strong> حدّد آخر قمتين وقاعين على الرسم، واكتب هل البنية تصنع قممًا أعلى أم أدنى.</p>",
    source:
      "CME Group — Technical Analysis https://www.cmegroup.com/education.html",
  },
  {
    title: "الدعم والمقاومة",
    body: "<p>الدعم منطقة يزداد فيها اهتمام المشترين، والمقاومة منطقة يزداد فيها ضغط البائعين. لا تُعامل الخط كحقيقة دقيقة؛ استخدم منطقة وسيناريو إلغاء.</p><p><strong>مثال:</strong> إذا كُسر الدعم وأغلق السعر تحته، اكتب سيناريو عدم استمرار الفكرة بدل افتراض الارتداد.</p>",
    source: "CFA Institute — Technical Analysis https://rpc.cfainstitute.org/",
  },
  {
    title: "المتوسطات المتحركة",
    body: "<p>تُستخدم SMA20 وSMA50 وSMA200 لوصف الاتجاه والزخم، وليست ضمانًا للنتيجة. تقاطع المتوسطات إشارة متأخرة ويجب دمجه مع السعر وإدارة المخاطر.</p><p><strong>تمرين:</strong> قارن السعر مع SMA50 وسجّل ما إذا كان الاتجاه متوافقًا أو متعارضًا.</p>",
    source:
      "CFA Institute — Investment Foundations https://www.cfainstitute.org/insights",
  },
  {
    title: "RSI والزخم",
    body: "<p>يقيس RSI زخم الحركة ضمن نطاق. التشبع لا يعني أن السعر سينعكس فورًا؛ قد يبقى السهم في حالة زخم فترة طويلة.</p><p><strong>مثال:</strong> لا تستخدم RSI وحده؛ اكتب تأكيدًا إضافيًا من بنية السعر قبل تسجيل فرضية محاكاة.</p>",
    source:
      "Fidelity Learning Center — RSI https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/RSI",
  },
  {
    title: "الحجم والسيولة",
    body: "<p>الحجم يساعد على فهم قابلية تنفيذ الفكرة نظريًا، لكن بيانات المنصة قد تكون متأخرة أو محدودة. لذلك لا نعرض المحاكاة على أنها سعر تنفيذ حقيقي.</p><p><strong>تمرين:</strong> قارن حجم اليوم بمتوسطه وسجّل ملاحظة عن السيولة دون تحويلها إلى وعد بالربح.</p>",
    source:
      "FINRA — Investing Basics https://www.finra.org/investors/investing",
  },
  {
    title: "إدارة المخاطر",
    body: "<p>حدّد قبل أي تجربة افتراضية: نقطة الإلغاء، حجم الصفقة الافتراضي، والخسارة الافتراضية المقبولة. لا تستخدم مالًا لا تستطيع تحمل خسارته في الواقع.</p><p><strong>مثال:</strong> اكتب خطة تتوقف عند تحقق شرط الإلغاء بدل تعديل الخطة بعد ظهور الخسارة.</p>",
    source:
      "SEC — Investor Alerts https://www.investor.gov/introduction-investing",
  },
  {
    title: "بناء خطة اختبار",
    body: "<p>الخطة القابلة للاختبار تحتوي على شروط دخول وخروج ومدة وبيانات ونتيجة. لا تخلط بين نتيجة تجربة قصيرة وصلاحية استراتيجية طويلة.</p><p><strong>مشروع الدورة:</strong> أنشئ عشر فرضيات محاكاة، سجّلها، ثم قيّم الالتزام والنتيجة والمتوسط والانحراف.</p>",
    source:
      "CFA Institute — Portfolio Management https://www.cfainstitute.org/",
  },
  {
    title: "فهم الإشارات والماسح",
    body: "<p>الإشارة داخل AZ Alpha Vision وصف تعليمي آلي، وليست أمرًا أو توصية. قد تفشل بسبب نقص البيانات أو تأخرها أو تغير السوق.</p><p><strong>تمرين:</strong> افتح سبب الإشارة، تحقق من السعر والاتجاه والبيانات، ثم اكتب سبب قبولها أو رفضها في دفتر التدريب.</p>",
    source:
      "SEC — Day Trading Risk Disclosure https://www.sec.gov/investor/pubs/daytips.htm",
  },
  {
    title: "اختبار نهائي وقواعد الاستخدام",
    body: "<p>لا تنتقل من المحاكاة إلى المال الحقيقي لمجرد ظهور نتائج إيجابية. راجع التكاليف والضرائب والملاءمة والمخاطر واستشر مختصًا مرخصًا عند الحاجة.</p><p><strong>الاختبار:</strong> اشرح الفرق بين البيانات النظرية والسعر القابل للتنفيذ، وبين الإشارة التعليمية والتوصية المالية.</p>",
    source: "FINRA — Smart Investing https://www.finra.org/investors",
  },
];
function renderCourseLesson(index = 0) {
  const lesson =
    COURSE_LESSONS[Math.max(0, Math.min(index, COURSE_LESSONS.length - 1))];
  const title = document.getElementById("courseLessonTitle");
  const body = document.getElementById("courseLessonBody");
  const source = document.getElementById("courseLessonSource");
  const count = document.getElementById("courseLessonCount");
  if (!title || !body) return;
  title.textContent = lesson.title;
  body.innerHTML = lesson.body;
  source.innerHTML = `<strong>مصدر للمطالعة:</strong> <a href="${lesson.source.split(" — ")[1] || "#"}" target="_blank" rel="noopener">${lesson.source.split(" — ")[0]}</a>`;
  count.textContent = `الدرس ${index + 1} من ${COURSE_LESSONS.length}`;
  document.getElementById("coursePrev").disabled = index === 0;
  document.getElementById("courseNext").disabled =
    index === COURSE_LESSONS.length - 1;
  document.getElementById("courseLessonIndex").value = index;
}
function openCourse() {
  document.getElementById("courseModal")?.classList.add("active");
  renderCourseLesson(0);
}
function closeCourse() {
  document.getElementById("courseModal")?.classList.remove("active");
}
function courseMove(delta) {
  renderCourseLesson(
    Number(document.getElementById("courseLessonIndex").value || 0) + delta,
  );
}

const PLATFORM_GUIDE = {
  stocks: {
    title: "الأسهم الحية",
    body: "<p>تعرض هذه الصفحة الأسعار والاتجاه والحجم وقراءة الإشارة التعليمية من بيانات السوق المتاحة.</p><p><strong>طريقة الاستخدام:</strong> اختر السهم لمراجعة السعر والتغير وRSI، ثم انتقل إلى الفلترة قبل تسجيل أي فرضية محاكاة.</p>",
  },
  trader: {
    title: "المتداول الافتراضي",
    body: "<p>هذا محاكي تداول افتراضي مشترك برصيد تعليمي. ينفذ صفقات داخل المحاكاة فقط، ولا يتصل بوسيط ولا يستخدم أموالًا حقيقية.</p><p><strong>المتابعة:</strong> راجع سعر الدخول، سبب الصفقة، المركز المفتوح، والربح أو الخسارة المسجلة.</p>",
  },
  screener: {
    title: "فلترة الأسهم",
    body: "<p>تجمع الفلترة نتائج القوالب والشروط المحددة، ثم تستبعد الأدوات غير المناسبة مثل الصناديق والأدوات غير العادية.</p><p><strong>مهم:</strong> ظهور السهم في الفلترة لا يعني شراءً؛ القرار النهائي يمر عبر السعر المقترح والحارس الفني.</p>",
  },
  signals: {
    title: "الماسح والتنبيهات",
    body: "<p>يعرض الإشارة ودرجتها والسعر الحالي والسعر المقترح والسبب الفني.</p><p><strong>تنبيه الاقتراب:</strong> يصدر عندما يقترب السعر من منطقة الدخول، بينما لا يحدث الشراء إلا عند تحقق الشروط التنفيذية.</p>",
  },
  picks: {
    title: "ترشيحات الأسبوع",
    body: "<p>هذه قائمة تعليمية ناتجة من نتائج الفلترة والقوالب المؤهلة، وتعرض أفضل الفرص وقائمة المتابعة.</p><p>الترشيحات ليست توصية أو ضمانًا للنتيجة.</p>",
  },
  indicators: {
    title: "المؤشرات",
    body: "<p>تساعد SMA20 وSMA50 وSMA200 وRSI وSMC-inspired على وصف الاتجاه والزخم ومناطق الاهتمام.</p><p>المؤشر أداة مساعدة وليس وعدًا بالاتجاه أو الربح.</p>",
  },
  course: {
    title: "الدورة التعليمية",
    body: '<p>تقدم دروسًا عن قراءة السعر والاتجاه والدعم والمقاومة وإدارة المخاطر واختبار الفرضيات.</p><button class="preset-btn" type="button" onclick="closePlatformGuide();openCourse();">فتح الدورة التعليمية</button>',
  },
  marketer: {
    title: "المسوق الذكي",
    body: "<p>يقرأ المسوق أخبار المنصة وصفقات المحاكي وتقويم الأرباح، ثم يصوغ تشويقاً تعليمياً غير مباشر مع رابط التسجيل في نهاية التحديث.</p><p>لا ينشر توصيات مالية. وضع النشر الافتراضي مسودة حتى يُفعَّل يدوياً.</p>",
  },
  support: {
    title: "الدعم الفني",
    body: "<p>آخر خيار في القائمة والتذييل. تواصل عبر @azalphavision أو azalphavision2026@gmail.com، أو أرسل تذكرة من داخل المنصة.</p>",
  },
};
function openPlatformGuide() {
  const modal = document.getElementById("platformGuideModal");
  if (!modal) return;
  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
  backToGuideCards();
}
function closePlatformGuide() {
  const modal = document.getElementById("platformGuideModal");
  if (!modal) return;
  modal.classList.remove("active");
  modal.setAttribute("aria-hidden", "true");
}
function backToGuideCards() {
  const cards = document.getElementById("platformGuideCards");
  const detail = document.getElementById("platformGuideDetail");
  if (cards) cards.hidden = false;
  if (detail) detail.hidden = true;
}
function showGuideDetail(key) {
  const item = PLATFORM_GUIDE[key];
  if (!item) return;
  const cards = document.getElementById("platformGuideCards");
  const detail = document.getElementById("platformGuideDetail");
  if (!detail) return;
  if (cards) cards.hidden = true;
  detail.hidden = false;
  document.getElementById("platformGuideDetailTitle").textContent = item.title;
  document.getElementById("platformGuideDetailBody").innerHTML = item.body;
}
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePlatformGuide();
});

// دليل تثبيت PWA على iOS/iPadOS (بديل مجاني 100% عن Apple App Store)
function isIosDevice() {
  const ua = navigator.userAgent || "";
  const isIphoneIpad = /iPad|iPhone|iPod/.test(ua);
  const isIpadOsDesktopUa =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return isIphoneIpad || isIpadOsDesktopUa;
}
function isRunningStandalone() {
  return (
    window.navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches
  );
}
function openIosInstallGuide() {
  const modal = document.getElementById("iosInstallModal");
  if (!modal) return;
  modal.classList.add("active");
  modal.setAttribute("aria-hidden", "false");
}
function closeIosInstallGuide() {
  const modal = document.getElementById("iosInstallModal");
  if (modal) {
    modal.classList.remove("active");
    modal.setAttribute("aria-hidden", "true");
  }
  try {
    if (document.getElementById("iosInstallDontShow")?.checked) {
      localStorage.setItem("az_ios_install_dismissed", "1");
    }
  } catch (e) {}
}
function initIosInstallGuide() {
  if (!isIosDevice() || isRunningStandalone()) return;
  const fab = document.getElementById("androidInstallFab");
  if (fab) {
    fab.removeAttribute("download");
    fab.setAttribute("href", "#");
    fab.setAttribute("aria-label", "تثبيت التطبيق على الشاشة الرئيسية");
    fab.addEventListener("click", (e) => {
      e.preventDefault();
      openIosInstallGuide();
    });
  }
  let dismissed = false;
  try {
    dismissed = localStorage.getItem("az_ios_install_dismissed") === "1";
  } catch (e) {}
  if (!dismissed) {
    setTimeout(openIosInstallGuide, 2200);
  }
}
document.addEventListener("DOMContentLoaded", initIosInstallGuide);

// بطاقة تحميل تطبيق الأندرويد (APK) في الصفحة الرئيسية — رابط مباشر من GitHub Releases مجاناً 100%.
function dismissAndroidDownloadCard() {
  const card = document.getElementById("androidDownloadCard");
  if (card) card.style.display = "none";
  try {
    localStorage.setItem("az_android_card_dismissed", "1");
  } catch (e) {}
}
function initAndroidDownloadCard() {
  const card = document.getElementById("androidDownloadCard");
  if (!card) return;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem("az_android_card_dismissed") === "1";
  } catch (e) {}
  if (dismissed) {
    card.style.display = "none";
    return;
  }
  const ua = navigator.userAgent || "";
  if (/Android/i.test(ua)) {
    const btn = document.getElementById("androidDownloadBtn");
    if (btn) btn.querySelector("span").textContent = "تحميل الآن على جهازك (APK)";
  }
}
document.addEventListener("DOMContentLoaded", initAndroidDownloadCard);

// ضابط أولي للرموز: لا يُقبل الرمز إلا إذا وُجد في بيانات السوق الموثوقة وله سعر موجب.
async function isTradableMarketSymbol(symbol) {
  const s = String(symbol || "")
    .trim()
    .toUpperCase();
  if (!s || EXCLUDED_SYMBOLS.has(s)) return false;
  const { data, error } = await sb
    .from("market_fundamentals")
    .select("symbol,price,exchange,industry,company,finviz_sector,sector")
    .eq("symbol", s)
    .maybeSingle();
  if (error || !data) return false;
  const exchange = String(data.exchange || "").toUpperCase();
  const text = [data.industry, data.company, data.finviz_sector, data.sector]
    .map((v) => String(v || "").toLowerCase())
    .join(" ");
  return (
    Number(data.price) > 0 &&
    ["NYSE", "NASDAQ"].includes(exchange) &&
    !EXCLUDED_SYMBOLS.has(s) &&
    !/etf|reit|closed[ -]?end|warrant|unit|preferred|fund|trust|spac|rights|note|depositary|acquisition/.test(
      text,
    ) &&
    !EXCLUDED_SECTOR_RE.test(text)
  );
}
const originalAddToWatchlist = addToWatchlist;
addToWatchlist = async function () {
  const sym = document
    .getElementById("addSymbolInput")
    .value.trim()
    .toUpperCase();
  if (!(await isTradableMarketSymbol(sym))) {
    toast("هذا الرمز غير موجود كسهم عادي قابل للتداول في قاعدة السوق", "error");
    return;
  }
  return originalAddToWatchlist();
};

// ===== VIRTUAL TRADER — EDUCATIONAL SIMULATION ONLY =====
const VIRTUAL_STARTING_CASH = 10000;
const VIRTUAL_MAX_POSITION_PCT = 0.2;
let virtualTrader = {
  cash: VIRTUAL_STARTING_CASH,
  positions: {},
  trades: [],
  startedAt: null,
  lastRun: null,
  runInfo: null,
};
let virtualTraderTimer = null;
let virtualTraderLoaded = false;
function virtualTraderKey() {
  return `az_virtual_trader_${currentUser?.id || "guest"}`;
}
function saveVirtualTrader() {
  localStorage.setItem(virtualTraderKey(), JSON.stringify(virtualTrader));
}
function loadVirtualTrader() {
  // المصدر الوحيد للمحاكي هو Supabase؛ لا تعاد تهيئة الحالة عند تبديل التبويب.
  if (!virtualTraderLoaded) {
    virtualTrader = {
      cash: VIRTUAL_STARTING_CASH,
      positions: {},
      trades: [],
      startedAt: null,
      lastRun: null,
      runInfo: null,
    };
    virtualTraderLoaded = true;
  }
  renderVirtualTrader();
  return syncVirtualTraderFromServer();
}
async function syncVirtualTraderFromServer() {
  if (!currentUser?.id || !sb) return;
  const [sharedPortfolioRes, sharedPositionsRes, sharedTradesRes, userPortfolioRes, userPositionsRes, userTradesRes, runRes] = await Promise.all([
    sb.from("shared_virtual_portfolios").select("*").eq("simulation_id", "global").maybeSingle(),
    sb.from("shared_virtual_positions").select("*").eq("simulation_id", "global").order("updated_at", { ascending: false }),
    sb.from("shared_virtual_trades").select("*").eq("simulation_id", "global").order("created_at", { ascending: false }).limit(100),
    sb.from("virtual_portfolios").select("*").eq("user_id", currentUser.id).maybeSingle(),
    sb.from("virtual_positions").select("*").eq("user_id", currentUser.id).order("updated_at", { ascending: false }),
    sb.from("virtual_trades").select("*").eq("user_id", currentUser.id).order("created_at", { ascending: false }).limit(100),
    sb.from("virtual_trader_runs").select("started_at,status,market_open,candidate_count,entry_candidates,near_entries,blocked_by_plan,blocked_by_price,run_note").order("started_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const sharedPositions = !sharedPositionsRes.error && Array.isArray(sharedPositionsRes.data) ? sharedPositionsRes.data : [];
  const sharedTrades = !sharedTradesRes.error && Array.isArray(sharedTradesRes.data) ? sharedTradesRes.data : [];
  const userPositions = !userPositionsRes.error && Array.isArray(userPositionsRes.data) ? userPositionsRes.data : [];
  const userTrades = !userTradesRes.error && Array.isArray(userTradesRes.data) ? userTradesRes.data : [];
  const positionsData = sharedPositions.length ? sharedPositions : userPositions;
  const tradesData = sharedTrades.length ? sharedTrades : userTrades;
  const portfolio = (sharedPortfolioRes.data && !sharedPortfolioRes.error && !sharedPositionsRes.error)
    ? sharedPortfolioRes.data
    : (userPortfolioRes.data || sharedPortfolioRes.data || { cash: VIRTUAL_STARTING_CASH });
  if (sharedPortfolioRes.error && userPortfolioRes.error && sharedPositionsRes.error && userPositionsRes.error && sharedTradesRes.error && userTradesRes.error) {
    console.warn("تعذر مزامنة جداول المحاكي:", sharedPortfolioRes.error || userPortfolioRes.error);
    return;
  }
  const positions = Object.fromEntries(
    positionsData.map((p) => [String(p.symbol).toUpperCase(), {
      symbol: p.symbol,
      qty: Number(p.qty),
      entryPrice: Number(p.entry_price),
      lastPrice: Number(p.last_price || p.entry_price),
      tier: p.entry_tier || p.tier || "Entry",
      reason: p.reason || "",
      enteredAt: p.entered_at,
    }]),
  );
  const trades = tradesData.map((t) => ({
    id: t.id,
    symbol: t.symbol,
    action: t.action,
    qty: Number(t.qty),
    price: Number(t.price),
    entryPrice: t.entry_price == null ? null : Number(t.entry_price),
    tier: t.tier || t.entry_tier || "Entry",
    pnl: t.pnl == null ? null : Number(t.pnl),
    reason: t.reason || "",
    at: t.created_at,
  }));
  const runInfo = runRes.error ? null : runRes.data;
  virtualTraderLoaded = true;
  const hydrated = Object.keys(positions).length
    ? positions
    : openPositionsFromTrades(trades);
  virtualTrader = {
    cash: Number(portfolio.cash ?? VIRTUAL_STARTING_CASH),
    positions: hydrated,
    trades,
    startedAt: portfolio.created_at || null,
    lastRun: trades[0]?.at || runInfo?.started_at || null,
    runInfo,
  };
  renderVirtualTrader();
}
function openPositionsFromTrades(trades) {
  const book = new Map();
  const chronological = [...(trades || [])].sort(
    (a, b) => new Date(a.at || 0) - new Date(b.at || 0),
  );
  for (const t of chronological) {
    const sym = String(t.symbol || "").toUpperCase();
    if (!sym) continue;
    const qty = Number(t.qty) || 0;
    const price = Number(t.price) || 0;
    if (t.action === "buy" && qty > 0 && price > 0) {
      const prev = book.get(sym);
      if (prev) {
        const newQty = prev.qty + qty;
        const entry = (prev.entryPrice * prev.qty + price * qty) / newQty;
        book.set(sym, {
          ...prev,
          qty: newQty,
          entryPrice: entry,
          lastPrice: price,
        });
      } else {
        book.set(sym, {
          symbol: sym,
          qty,
          entryPrice: price,
          lastPrice: price,
          tier: t.tier || "Entry",
          reason: t.reason || "",
          enteredAt: t.at,
        });
      }
    } else if (t.action === "sell") {
      book.delete(sym);
    }
  }
  return Object.fromEntries(book);
}

async function refreshVirtualTraderFromServer() {
  return syncVirtualTraderFromServer();
}
function virtualPrice(row) {
  const p = Number(row?.price ?? row?.current_price ?? row?.last_price);
  return Number.isFinite(p) && p > 0 ? p : null;
}
function virtualSignalKind(row) {
  return String(
    row?.signal ||
      row?.type ||
      row?.action ||
      row?.direction ||
      row?.entry_signal ||
      row?.entrySignal ||
      row?.entry_tier ||
      row?.exit_tier ||
      "",
  ).toLowerCase();
}
function virtualTierScore(row, action = "buy") {
  return Number(
    action === "sell"
      ? (row?.exit_score ?? row?.exitScore ?? row?.score ?? 0)
      : (row?.entry_score ?? row?.entryScore ?? row?.signal_score ?? 0),
  );
}
function virtualReason(row, action) {
  const symbol = String(row?.symbol || "").toUpperCase();
  const company = String(
    row?.company || row?.name || row?.company_name || symbol,
  );
  const price = virtualPrice(row);
  const grade = virtualGrade(row);
  const source =
    String(row?.source || "").includes("filter_scan") &&
    String(row?.source || "").includes("final_scan")
      ? "الماسحين"
      : String(row?.source || "").includes("filter_scan")
        ? "ماسح الفلاتر"
        : "الماسح النهائي";
  const tier = virtualTierLabel(row, action);
  const raw =
    row?.[action === "buy" ? "entry_signals" : "exit_signals"] ?? row?.signals;
  const signals = Array.isArray(raw)
    ? raw.filter(Boolean)
    : raw && typeof raw === "object"
      ? Object.entries(raw)
          .filter(([, v]) => Boolean(v))
          .map(
            ([k]) =>
              ({
                fibonacci: "فيبوناتشي",
                smc_atr: "SMC+ATR",
                candlestick: "الشموع",
                volume: "الحجم",
              })[k] || k,
          )
      : [];
  const text = signals.length
    ? signals.join("، ")
    : row?.reason || row?.catalyst || "توافق شروط الإشارة";
  if (action === "buy")
    return `دخلت ${company} (${symbol}) عند $${Number(price || 0).toFixed(2)}؛ السبب: ${tier} وتقييم ${grade} من ${source} — ${text}`;
  return `خرجت من ${company} (${symbol}) عند $${Number(price || 0).toFixed(2)}؛ السبب: ${tier} من ${source} — ${text}`;
}
function virtualTierLabel(row, action) {
  const n = Math.max(
    1,
    Math.min(
      4,
      Math.round(virtualTierScore(row, action)) ||
        (Array.isArray(row?.signals) ? row.signals.length : 1),
    ),
  );
  if (n >= 3) return action === "buy" ? "دخول صريح" : "خروج صريح";
  if (n === 2) return action === "buy" ? "دخول مؤكد" : "خروج مؤكد";
  return action === "buy" ? "دخول" : "خروج";
}
function virtualRealizedPnl() {
  return (virtualTrader.trades || [])
    .filter((t) => t.action === "sell")
    .reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
}
function virtualUnrealizedPnl() {
  return Object.values(virtualTrader.positions || {}).reduce((sum, p) => {
    const last = Number(p.lastPrice || p.entryPrice);
    const entry = Number(p.entryPrice);
    return sum + (last - entry) * Number(p.qty);
  }, 0);
}
function virtualMarkToMarketPnl() {
  // الربح/الخسارة من حركة السعر فقط — شراء الأسهم تحويل نقد↔أصل وليس خسارة.
  return virtualRealizedPnl() + virtualUnrealizedPnl();
}
function virtualEquity() {
  return VIRTUAL_STARTING_CASH + virtualMarkToMarketPnl();
}
function virtualExecuteBuy(row) {
  const symbol = String(row?.symbol || "").toUpperCase();
  const price = virtualPrice(row);
  if (!symbol || !price || virtualTrader.positions[symbol]) return false;
  const allocation = Math.min(
    virtualTrader.cash * VIRTUAL_MAX_POSITION_PCT,
    virtualTrader.cash,
  );
  const qty = Math.floor(allocation / price);
  if (qty < 1) return false;
  const tier = virtualTierLabel(row, "buy");
  virtualTrader.cash -= qty * price;
  virtualTrader.positions[symbol] = {
    symbol,
    qty,
    entryPrice: price,
    lastPrice: price,
    tier,
    reason: virtualReason(row, "buy"),
    enteredAt: new Date().toISOString(),
  };
  virtualTrader.trades.unshift({
    id: `${Date.now()}-buy-${symbol}`,
    symbol,
    action: "buy",
    qty,
    price,
    tier,
    reason: virtualReason(row, "buy"),
    at: new Date().toISOString(),
  });
  return true;
}
function virtualExecuteSell(row) {
  const symbol = String(row?.symbol || "").toUpperCase();
  const price = virtualPrice(row);
  const pos = virtualTrader.positions[symbol];
  if (!symbol || !price || !pos) return false;
  const proceeds = Number(pos.qty) * price;
  const pnl = proceeds - Number(pos.qty) * Number(pos.entryPrice);
  const tier = virtualTierLabel(row, "sell");
  virtualTrader.cash += proceeds;
  virtualTrader.trades.unshift({
    id: `${Date.now()}-sell-${symbol}`,
    symbol,
    action: "sell",
    qty: pos.qty,
    price,
    tier,
    pnl,
    reason: virtualReason(row, "sell"),
    at: new Date().toISOString(),
  });
  delete virtualTrader.positions[symbol];
  return true;
}
function virtualFilterSignalRow(row) {
  const price = virtualPrice(row);
  const change = Number(row?.change ?? row?.change_pct ?? 0);
  const rsi = Number(row?.rsi);
  const aboveTrend =
    Number.isFinite(Number(row?.sma50)) &&
    Number.isFinite(Number(row?.sma200)) &&
    price > Number(row.sma50) &&
    price > Number(row.sma200) &&
    change > 2;
  const belowTrend =
    Number.isFinite(Number(row?.sma50)) &&
    Number.isFinite(Number(row?.sma200)) &&
    price < Number(row.sma50) &&
    price < Number(row.sma200) &&
    change < -2;
  const strongBuy = Number.isFinite(rsi) && rsi < 30 && change > 0;
  const strongSell = Number.isFinite(rsi) && rsi > 70 && change < 0;
  const isBuy = strongBuy || aboveTrend;
  const isSell = strongSell || belowTrend;
  if (!isBuy && !isSell) return null;
  const signal = isBuy
    ? strongBuy
      ? "شراء قوي"
      : "دخول"
    : strongSell
      ? "بيع قوي"
      : "خروج";
  const score = Math.max(
    1,
    Number(row?.score) || (strongBuy || strongSell ? 3 : 1),
  );
  return {
    ...row,
    signal,
    source: "filter_scan",
    entry_score: isBuy ? score : 0,
    exit_score: isSell ? score : 0,
    entry_tier: isBuy ? (score >= 3 ? "Explicit" : "Entry") : null,
    exit_tier: isSell ? (score >= 3 ? "Explicit" : "Exit") : null,
    reason: `فرصة من ماسح الفلاتر: ${signal}`,
  };
}
function virtualRowsFromSignals() {
  // يجمع المتداول الافتراضي بين الماسح النهائي وماسح الفلاتر.
  // عند تكرار الرمز نحتفظ بسجل واحد ونضم مصدرَي الفرصة ودرجاتهما.
  const merged = new Map();
  const add = (row, source) => {
    const symbol = String(row?.symbol || "").toUpperCase();
    const price = virtualPrice(row);
    if (!symbol || !price || !isCommonStockRow({ ...row, symbol, price }))
      return;
    const current = merged.get(symbol);
    if (!current) {
      merged.set(symbol, { ...row, symbol, source });
      return;
    }
    merged.set(symbol, {
      ...current,
      ...row,
      symbol,
      source: `${current.source}+${source}`,
      entry_score: Math.max(
        Number(current.entry_score || 0),
        Number(row.entry_score || 0),
      ),
      exit_score: Math.max(
        Number(current.exit_score || 0),
        Number(row.exit_score || 0),
      ),
      entry_tier: current.entry_tier || row.entry_tier,
      exit_tier: current.exit_tier || row.exit_tier,
      reason: [current.reason, row.reason].filter(Boolean).join("؛ "),
    });
  };
  (Array.isArray(SIGNALS_CACHE) ? SIGNALS_CACHE : []).forEach((row) =>
    add(row, "final_scan"),
  );
  (Array.isArray(screenerResults) ? screenerResults : [])
    .map(virtualFilterSignalRow)
    .filter(Boolean)
    .forEach((row) => add(row, "filter_scan"));
  return [...merged.values()].filter(
    (row) =>
      Number(row.entry_score || 0) > 0 || Number(row.exit_score || 0) > 0,
  );
}
function virtualGrade(row) {
  const explicit = String(row?.grade ?? row?.Grade ?? row?.rating ?? "")
    .trim()
    .toUpperCase();
  if (["A", "B", "C", "D", "F"].includes(explicit)) return explicit;
  const score = Number(row?.entry_score ?? row?.entryScore ?? row?.score ?? 0);
  // محرك الإشارات النهائي لا يرسل grade؛ نطابق درجات التوافق مع تصنيف الفرص.
  return score >= 4 ? "A" : score >= 3 ? "B" : score >= 2 ? "C" : "D";
}
function virtualBuyEligible(row) {
  return ["A", "B"].includes(virtualGrade(row));
}
function runVirtualTrader(mode = "manual") {
  // التشغيل والتنفيذ في Supabase/GitHub Actions فقط؛ هذه الدالة تحدّث العرض ولا تنفذ أوامر.
  syncVirtualTraderFromServer();
  if (mode === "manual") toast("جارٍ مزامنة حالة المحاكي من الخلفية", "info");
}
function resetVirtualTrader() {
  toast(
    "إعادة ضبط المحاكي تتم من الخادم مع حفظ السجل السابق؛ لا تُحذف الصفقات من الواجهة.",
    "info",
  );
  syncVirtualTraderFromServer();
}
function tableSkeleton(columns, rows = 3) {
  return Array.from(
    { length: rows },
    () =>
      `<tr class="skeleton-row"><td colspan="${columns}"><span class="skeleton-line"></span></td></tr>`,
  ).join("");
}
function cardSkeleton(rows = 3) {
  return Array.from(
    { length: rows },
    () =>
      '<div class="skeleton-card"><span class="skeleton-line"></span><span class="skeleton-line short"></span></div>',
  ).join("");
}
function movementClass(value) {
  const n = Number(value);
  return n > 0 ? "text-green" : n < 0 ? "text-red" : "text-neutral";
}
function movementSign(value) {
  const n = Number(value);
  return n > 0 ? "+" : "";
}
function renderVirtualTrader() {
  const invested = Object.values(virtualTrader.positions).reduce(
    (sum, p) => sum + Number(p.qty) * Number(p.entryPrice),
    0,
  );
  const unrealized = virtualUnrealizedPnl();
  const sells = virtualTrader.trades.filter((t) => t.action === "sell");
  const realized = virtualRealizedPnl();
  const pnl = realized + unrealized;
  const equity = VIRTUAL_STARTING_CASH + pnl;
  const returnPct = (pnl / VIRTUAL_STARTING_CASH) * 100;
  const winRate = sells.length
    ? (sells.filter((t) => Number(t.pnl) > 0).length / sells.length) * 100
    : null;
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  set("vtCash", `$${Number(virtualTrader.cash || 0).toFixed(2)}`);
  set("vtEquity", `$${VIRTUAL_STARTING_CASH.toFixed(2)}`);
  set("vtMarkValue", `$${equity.toFixed(2)}`);
  set("vtInvested", `$${invested.toFixed(2)}`);
  set("vtPnl", `${movementSign(pnl)}$${pnl.toFixed(2)}`);
  set("vtReturnPct", `${movementSign(returnPct)}${returnPct.toFixed(2)}%`);
  set("vtRealizedPnl", `${movementSign(realized)}$${realized.toFixed(2)}`);
  set(
    "vtUnrealizedPnl",
    `${movementSign(unrealized)}$${unrealized.toFixed(2)}`,
  );
  set("vtWinRate", winRate == null ? "—" : `${winRate.toFixed(1)}%`);
  set("vtOpenPositions", String(Object.keys(virtualTrader.positions).length));
  const posBody = document.getElementById("virtualPositionsBody");
  if (posBody) {
    const positions = Object.values(virtualTrader.positions);
    posBody.innerHTML = positions.length
      ? positions
          .map((p) => {
            const last = Number(p.lastPrice || p.entryPrice);
            const upnl = (last - Number(p.entryPrice)) * Number(p.qty);
            const pct = Number(p.entryPrice)
              ? (last / Number(p.entryPrice) - 1) * 100
              : 0;
            return `<tr title="${escapeHtml(p.reason || "")}"><td class="font-mono">${escapeHtml(p.symbol)}</td><td>${p.qty}</td><td>$${Number(p.entryPrice).toFixed(2)}</td><td>$${last.toFixed(2)}</td><td class="${movementClass(upnl)}">${movementSign(upnl)}$${upnl.toFixed(2)}</td><td class="${movementClass(pct)}">${movementSign(pct)}${pct.toFixed(2)}%</td><td>${escapeHtml(p.tier)}</td></tr>`;
          })
          .join("")
      : '<tr><td colspan="7" class="empty-cell text-muted" style="text-align:center;padding:28px;">لا توجد مراكز مفتوحة حاليًا</td></tr>';
  }
  const tradeBody = document.getElementById("virtualTradesBody");
  if (tradeBody)
    tradeBody.innerHTML = virtualTrader.trades.length
      ? virtualTrader.trades
          .slice(0, 20)
          .map((t) => {
            const pos = virtualTrader.positions[String(t.symbol || "").toUpperCase()];
            const pnlValue =
              t.action === "buy"
                ? pos
                  ? (Number(pos.lastPrice || pos.entryPrice) - Number(pos.entryPrice)) *
                    Number(t.qty)
                  : 0
                : t.pnl == null
                  ? null
                  : Number(t.pnl);
            const pct =
              t.action === "sell" && t.entryPrice
                ? (Number(t.price) / Number(t.entryPrice) - 1) * 100
                : t.action === "buy" && pos && Number(pos.entryPrice)
                  ? (Number(pos.lastPrice || pos.entryPrice) / Number(pos.entryPrice) - 1) * 100
                  : 0;
            const pnlClass =
              pnlValue == null ? "text-neutral" : movementClass(pnlValue);
            const pctClass = pct == null ? "text-neutral" : movementClass(pct);
            return `<tr title="${escapeHtml(t.reason || "")}"><td>${new Date(t.at).toLocaleString("ar-SA")}</td><td class="font-mono">${escapeHtml(t.symbol)}</td><td class="${t.action === "buy" ? "text-green" : "text-red"}">${t.action === "buy" ? "شراء محاكى" : "بيع محاكى"}</td><td>${t.qty}</td><td>$${Number(t.price).toFixed(2)}</td><td class="${pnlClass}">${pnlValue == null ? "—" : `${movementSign(pnlValue)}$${pnlValue.toFixed(2)}`}</td><td class="${pctClass}">${pct == null ? "—" : `${movementSign(pct)}${pct.toFixed(2)}%`}</td><td>${escapeHtml(t.tier)}</td></tr>`;
          })
          .join("")
      : '<tr><td colspan="8" class="empty-cell text-muted" style="text-align:center;padding:28px;">لا توجد عمليات محاكية مسجلة بعد</td></tr>';
  const runInfo = virtualTrader.runInfo;
  const runTime = virtualTrader.lastRun
    ? new Date(virtualTrader.lastRun).toLocaleString("ar-SA")
    : null;
  const status = runInfo
    ? `${runInfo.run_note || "اكتملت متابعة المحاكي"}${runTime ? ` · آخر فحص: ${runTime}` : ""}`
    : runTime
      ? `آخر متابعة: ${runTime}`
      : "لم تبدأ المتابعة الآلية بعد";
  set("virtualTraderStatus", status);
  ["vtPnl", "vtReturnPct", "vtRealizedPnl", "vtUnrealizedPnl"].forEach((id) => {
    const el = document.getElementById(id);
    if (el)
      el.className = `val ${movementClass(Number(String(el.textContent || "").replace(/[$,%+ ]/g, "")))}`;
  });
  renderSignalGridPicks();
}

// ===== SIGNAL-FIRST OVERVIEW MIRROR =====
function syncOverviewMetrics() {
  const copy = (sourceId, targetId, fallback = "—") => {
    const source = document.getElementById(sourceId);
    const target = document.getElementById(targetId);
    if (target) target.textContent = source?.textContent || fallback;
  };
  copy("vtEquity", "overviewEquity", "$10,000.00");
  copy("vtPnl", "overviewPnl", "$0.00");
  copy("vtReturnPct", "overviewReturn", "0.00%");
  copy("vtOpenPositions", "overviewPositions", "0");
  [
    "overviewPnl",
    "overviewReturn",
    "vtPnl",
    "vtReturnPct",
    "vtRealizedPnl",
    "vtUnrealizedPnl",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const numeric = parseFloat(
      String(el.textContent || "").replace(/[$,%+ ]/g, ""),
    );
    el.classList.remove("text-green", "text-red", "text-neutral", "pos", "neg");
    if (Number.isFinite(numeric)) el.classList.add(movementClass(numeric));
  });
  const positionSymbols = Object.keys(virtualTrader?.positions || {});
  const latest = virtualTrader?.trades?.[0];
  const signal = document.getElementById("overviewSignal");
  const entry = document.getElementById("overviewEntry");
  const position = document.getElementById("overviewPosition");
  const result = document.getElementById("overviewResult");
  if (signal)
    signal.textContent = positionSymbols.length
      ? `مركز مفتوح: ${positionSymbols.join("، ")}`
      : "لا توجد إشارة دخول جديدة";
  if (entry)
    entry.textContent =
      latest?.action === "buy"
        ? `دخول عند $${Number(latest.price || 0).toFixed(2)}`
        : "السعر المقترح";
  if (position)
    position.textContent = positionSymbols.length
      ? `${positionSymbols.length} مركز مشترك`
      : "لا توجد مراكز مفتوحة";
  if (result)
    result.textContent =
      latest?.action === "sell" ? "آخر نتيجة: بيع محاكى" : "قياس الأداء مستمر";
  syncGoldenOrbit();
}
function syncGoldenOrbit() {
  const ticker = document.getElementById("orbitGoldTicker");
  const pulse = document.getElementById("orbitMarketPulse");
  const alerts = document.getElementById("orbitAlertCount");
  const strip = document.getElementById("goldWatchStrip");
  const picks = Array.isArray(LocalCache.getPicks()) ? LocalCache.getPicks() : [];
  const gold = picks[0];
  const positionSymbols = Object.keys(virtualTrader?.positions || {});
  const signalCount = Array.isArray(SIGNALS_ALERTS) ? SIGNALS_ALERTS.length : 0;
  if (ticker) {
    ticker.textContent = gold?.symbol
      ? `السهم الذهبي ${gold.symbol}`
      : positionSymbols[0]
        ? `متابعة ${positionSymbols[0]}`
        : "بانتظار السهم الذهبي";
  }
  if (pulse) {
    pulse.classList.toggle("is-live", Boolean(gold || positionSymbols.length));
    pulse.title = gold ? "متابعة لحظية للسهم الذهبي" : "المؤشر في وضع الانتظار";
  }
  if (alerts) alerts.textContent = `${signalCount} تنبيه`;
  if (strip) {
    if (!gold) {
      strip.hidden = true;
      strip.innerHTML = "";
      return;
    }
    const price = Number(gold.price);
    const entry = Number(gold.entryPrice);
    strip.hidden = false;
    strip.innerHTML = `<span class="gold-chip">↑ السهم الذهبي</span><strong>${escapeHtml(gold.symbol)}</strong><span>${Number.isFinite(price) ? `$${price.toFixed(2)}` : "—"}</span><span>${Number.isFinite(entry) ? `منطقة $${entry.toFixed(2)}` : (gold.entryStatus || "متابعة")}</span><button type="button" onclick="switchTab('picks')">عرض الترشيح</button>`;
  }
}
const _renderVirtualTraderForOverview = renderVirtualTrader;
renderVirtualTrader = function () {
  _renderVirtualTraderForOverview();
  syncOverviewMetrics();
};

// إعادة توجيه وظائف الواجهة القديمة إلى المتداول الافتراضي.
const _oldRenderPortfolio =
  typeof renderPortfolio === "function" ? renderPortfolio : null;
renderPortfolio = function () {
  loadVirtualTrader();
  renderVirtualTrader();
};
const _oldLoadWatchlist = loadWatchlist;
loadWatchlist = async function () {
  await _oldLoadWatchlist();
  loadVirtualTrader();
};
const _oldSwitchTab = switchTab;
switchTab = function (id) {
  const result = _oldSwitchTab(id);
  if (id === "portfolio") {
    loadVirtualTrader();
    renderVirtualTrader();
  }
  return result;
};
