// DK Digital Agency v2 — frontend logic (vanilla JS, Bengali UI)
const state = { user: null, paymentNumber: '01833990497', services: [], orderServiceId: null, adminChatUser: null };

const ORDER_LABEL = {
  awaiting_price: 'দামের জন্য অপেক্ষা',
  awaiting_payment: 'পেমেন্টের অপেক্ষা',
  in_progress: 'কাজ চলছে',
  completed: 'সম্পন্ন',
  cancelled: 'বাতিল',
};
const DEP_LABEL = { pending: 'অপেক্ষমাণ', approved: 'অনুমোদিত', rejected: 'বাতিল' };
const TX_LABEL = { deposit: 'ডিপোজিট', order_payment: 'অর্ডার পেমেন্ট', refund: 'টাকা ফেরত', adjustment: 'ব্যালেন্স সমন্বয়' };

function taka(n) { return '৳' + Number(n).toLocaleString('en-US'); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function contactOf(u) { return u.phone || u.email || ''; }
function fmtDate(s) {
  try {
    const d = new Date(s);
    if (isNaN(d)) return s;
    return d.toLocaleString('bn-BD', { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return s; }
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'কিছু একটা ভুল হয়েছে');
  return data;
}

// ---------- Navigation ----------
let msgPollTimer = null;
function go(view) {
  if ((view === 'wallet' || view === 'deposit' || view === 'orders' || view === 'messages') && !state.user) {
    toast('প্রথমে লগইন করুন'); view = 'login';
  }
  if (view === 'admin' && (!state.user || state.user.role !== 'admin')) {
    toast('শুধু অ্যাডমিনের জন্য'); view = 'home';
  }
  stopMsgPolling();
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById('view-' + view).classList.remove('hidden');
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
  if (view === 'wallet') loadWallet();
  if (view === 'orders') loadOrders();
  if (view === 'admin') loadAdmin();
  if (view === 'messages') { loadMessages(); startMsgPolling(); }
  if (view === 'deposit') document.getElementById('pay-number').textContent = state.paymentNumber;
  window.scrollTo(0, 0);
}

function renderAuth() {
  const chip = document.getElementById('balance-chip');
  const navAuth = document.getElementById('nav-auth');
  const navAdmin = document.getElementById('nav-admin');
  const msgBadge = document.getElementById('msg-badge');
  if (state.user) {
    chip.classList.remove('hidden');
    document.getElementById('balance-val').textContent = Number(state.user.balance).toLocaleString('en-US');
    navAuth.textContent = '🚪 লগআউট';
    navAuth.onclick = doLogout;
    navAdmin.classList.toggle('hidden', state.user.role !== 'admin');
    if (state.user.role === 'customer') refreshUnreadBadge();
    else msgBadge.classList.add('hidden');
  } else {
    chip.classList.add('hidden');
    navAuth.textContent = '🔑 লগইন';
    navAuth.onclick = () => go('login');
    navAdmin.classList.add('hidden');
    msgBadge.classList.add('hidden');
  }
}

async function refreshMe() {
  try {
    const d = await api('/api/me');
    state.user = d.user;
    state.paymentNumber = d.payment_number;
  } catch { state.user = null; }
  renderAuth();
}

async function refreshUnreadBadge() {
  try {
    const d = await api('/api/messages/unread-count');
    const b = document.getElementById('msg-badge');
    b.textContent = d.unread;
    b.classList.toggle('hidden', !d.unread);
  } catch {}
}

// ---------- Auth ----------
async function doLogin() {
  const identifier = document.getElementById('login-id').value.trim();
  const pin = document.getElementById('login-pin').value.trim();
  try {
    const d = await api('/api/login', { method: 'POST', body: JSON.stringify({ identifier, pin }) });
    state.user = d.user;
    renderAuth();
    toast('স্বাগতম, ' + d.user.name + '!');
    go(d.user.role === 'admin' ? 'admin' : 'home');
    if (d.user.role === 'admin') loadAdmin();
    refreshMe();
  } catch (e) { toast(e.message); }
}
async function doRegister() {
  const name = document.getElementById('reg-name').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const pin = document.getElementById('reg-pin').value.trim();
  try {
    const d = await api('/api/register', { method: 'POST', body: JSON.stringify({ name, phone, email, pin }) });
    state.user = d.user;
    renderAuth();
    toast('অ্যাকাউন্ট তৈরি হয়েছে! স্বাগতম, ' + d.user.name);
    go('home');
  } catch (e) { toast(e.message); }
}
async function doLogout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  stopMsgPolling();
  renderAuth();
  go('home');
  toast('লগআউট হয়েছে');
}

// ---------- Services / home ----------
async function loadServices() {
  state.services = await api('/api/services');
  document.getElementById('service-list').innerHTML = state.services.map(s => `
    <div class="service-card">
      <div class="service-num">${s.id}</div>
      <div class="service-name">${esc(s.name)}</div>
      <button class="btn primary inline" onclick="startOrder(${s.id})">অর্ডার</button>
    </div>`).join('');
}
function startOrder(id) {
  if (!state.user) { toast('প্রথমে লগইন করুন'); go('login'); return; }
  state.orderServiceId = id;
  const s = state.services.find(x => x.id === id);
  document.getElementById('order-service-name').textContent = s.name;
  document.getElementById('order-desc').value = '';
  go('orderform');
}
async function submitOrder() {
  const description = document.getElementById('order-desc').value.trim();
  try {
    await api('/api/orders', { method: 'POST', body: JSON.stringify({ service_id: state.orderServiceId, description }) });
    toast('অর্ডার জমা হয়েছে! অ্যাডমিন দাম জানাবেন।');
    go('orders');
  } catch (e) { toast(e.message); }
}

// ---------- Wallet ----------
async function loadWallet() {
  try {
    const d = await api('/api/wallet');
    document.getElementById('wallet-balance').textContent = Number(d.balance).toLocaleString('en-US');
    document.getElementById('tx-list').innerHTML = d.transactions.length ? d.transactions.map(t => `
      <div class="item"><div class="row">
        <div><b>${esc(TX_LABEL[t.type] || t.type)}</b><br><span class="muted">${esc(t.description)}</span><br><span class="muted small">${fmtDate(t.created_at)}</span></div>
        <div class="${t.amount >= 0 ? 'amt-plus' : 'amt-minus'}">${t.amount >= 0 ? '+' : ''}${taka(t.amount)}</div>
      </div></div>`).join('') : '<div class="empty">এখনো কোনো লেনদেন নেই</div>';
    document.getElementById('dep-list').innerHTML = d.deposits.length ? d.deposits.map(x => `
      <div class="item"><div class="row">
        <div><b>${esc(x.method)}</b> — ${taka(x.amount)}<br><span class="muted">TrxID: ${esc(x.trxid)}</span><br><span class="muted small">${fmtDate(x.created_at)}</span></div>
        <span class="badge ${x.status}">${DEP_LABEL[x.status]}</span>
      </div></div>`).join('') : '<div class="empty">কোনো ডিপোজিট অনুরোধ নেই</div>';
  } catch (e) { toast(e.message); }
}
function copyPayNumber() {
  navigator.clipboard.writeText(state.paymentNumber).then(() => toast('নম্বর কপি হয়েছে'));
}
async function submitDeposit() {
  const method = document.getElementById('dep-method').value;
  const amount = Number(document.getElementById('dep-amount').value);
  const trxid = document.getElementById('dep-trxid').value.trim();
  try {
    await api('/api/deposits', { method: 'POST', body: JSON.stringify({ method, amount, trxid }) });
    toast('ডিপোজিট অনুরোধ জমা হয়েছে! অনুমোদনের অপেক্ষা করুন।');
    document.getElementById('dep-amount').value = '';
    document.getElementById('dep-trxid').value = '';
    go('wallet');
  } catch (e) { toast(e.message); }
}

// ---------- My orders ----------
async function loadOrders() {
  try {
    const rows = await api('/api/orders');
    document.getElementById('order-list').innerHTML = rows.length ? rows.map(o => `
      <div class="item">
        <div class="row"><b>অর্ডার #${o.id}</b><span class="badge ${o.status}">${ORDER_LABEL[o.status]}</span></div>
        <div style="margin-top:6px"><b>${esc(o.service_name)}</b></div>
        <div class="muted">${esc(o.description)}</div>
        ${o.price ? `<div style="margin-top:6px">দাম: <b>${taka(o.price)}</b></div>` : ''}
        <div class="muted small">${fmtDate(o.created_at)}</div>
        <div class="actions">
          ${o.status === 'awaiting_payment' ? `<button class="btn success inline" onclick="confirmOrder(${o.id})">✅ কনফার্ম ও পে করুন (${taka(o.price)})</button>` : ''}
          ${(o.status === 'awaiting_price' || o.status === 'awaiting_payment') ? `<button class="btn danger inline" onclick="cancelOrder(${o.id})">বাতিল করুন</button>` : ''}
        </div>
      </div>`).join('') : '<div class="empty">এখনো কোনো অর্ডার নেই — হোম থেকে সার্ভিস অর্ডার করুন</div>';
  } catch (e) { toast(e.message); }
}
async function confirmOrder(id) {
  if (!confirm('ওয়ালেট থেকে টাকা কেটে অর্ডারটি কনফার্ম করবেন?')) return;
  try {
    await api('/api/orders/' + id + '/confirm', { method: 'POST' });
    toast('পেমেন্ট সম্পন্ন! কাজ শুরু হবে।');
    refreshMe(); loadOrders();
  } catch (e) {
    toast(e.message);
    if (e.message.includes('ব্যালেন্স')) go('deposit');
  }
}
async function cancelOrder(id) {
  if (!confirm('অর্ডারটি বাতিল করবেন?')) return;
  try { await api('/api/orders/' + id + '/cancel', { method: 'POST' }); toast('অর্ডার বাতিল হয়েছে'); loadOrders(); }
  catch (e) { toast(e.message); }
}

// ---------- Messaging (customer) ----------
function renderChat(box, msgs, mine) {
  box.innerHTML = msgs.length ? msgs.map(m => `
    <div class="chat-msg ${m.sender === mine ? 'mine' : 'theirs'}">
      <div class="chat-text">${esc(m.text)}</div>
      <div class="chat-time">${fmtDate(m.created_at)}</div>
    </div>`).join('') : '<div class="empty">এখনো কোনো মেসেজ নেই — নিচে লিখে পাঠান</div>';
  box.scrollTop = box.scrollHeight;
}
async function loadMessages() {
  try {
    const msgs = await api('/api/messages');
    renderChat(document.getElementById('chat-box'), msgs, 'customer');
    refreshUnreadBadge();
  } catch (e) { toast(e.message); }
}
async function sendMessage() {
  const input = document.getElementById('chat-text');
  const text = input.value.trim();
  if (!text) return;
  try {
    await api('/api/messages', { method: 'POST', body: JSON.stringify({ text }) });
    input.value = '';
    loadMessages();
  } catch (e) { toast(e.message); }
}
function startMsgPolling() {
  stopMsgPolling();
  msgPollTimer = setInterval(() => {
    if (!document.getElementById('view-messages').classList.contains('hidden')) loadMessages();
    else if (state.adminChatUser) loadAdminChat(state.adminChatUser, true);
  }, 10000);
}
function stopMsgPolling() {
  if (msgPollTimer) { clearInterval(msgPollTimer); msgPollTimer = null; }
}

// ---------- Admin ----------
function adminTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-body').forEach(b => b.classList.add('hidden'));
  document.getElementById('admin-' + tab).classList.remove('hidden');
  if (tab === 'dep') loadAdminDeposits();
  if (tab === 'ord') loadAdminOrders();
  if (tab === 'msg') loadAdminMsgList();
  if (tab === 'cus') loadAdminCustomers();
  if (tab === 'set') loadAdminSettings();
}
async function refreshAdminOverview() {
  const s = await api('/api/admin/overview');
  document.getElementById('admin-stats').innerHTML = `
    <div class="stat"><b>${s.pending_deposits}</b><span>ডিপোজিট অপেক্ষা</span></div>
    <div class="stat"><b>${s.awaiting_price}</b><span>দাম বাকি</span></div>
    <div class="stat"><b>${s.in_progress}</b><span>কাজ চলছে</span></div>
    <div class="stat"><b>${s.awaiting_payment}</b><span>পেমেন্ট বাকি</span></div>
    <div class="stat"><b>${s.completed}</b><span>সম্পন্ন</span></div>
    <div class="stat"><b>${s.customers}</b><span>কাস্টমার</span></div>
    <div class="stat"><b>${s.unread_messages}</b><span>অপঠিত মেসেজ</span></div>
    <div class="stat"><b>${taka(s.total_wallet)}</b><span>মোট ওয়ালেট</span></div>`;
  const b = document.getElementById('admin-msg-badge');
  b.textContent = s.unread_messages;
  b.classList.toggle('hidden', !s.unread_messages);
}
async function loadAdmin() {
  try {
    await refreshAdminOverview();
    adminTab('dep');
  } catch (e) { toast(e.message); }
}
async function loadAdminDeposits() {
  const rows = await api('/api/admin/deposits?status=pending');
  const el = document.getElementById('admin-dep-list');
  el.innerHTML = rows.length ? rows.map(d => `
    <div class="item">
      <div class="row"><b>${esc(d.name)}</b><span class="badge pending">অপেক্ষমাণ</span></div>
      <div class="muted">${esc(contactOf(d))} • ${esc(d.method)} • TrxID: <b>${esc(d.trxid)}</b></div>
      <div>পরিমাণ: <b>${taka(d.amount)}</b> • <span class="muted small">${fmtDate(d.created_at)}</span></div>
      <div class="actions">
        <button class="btn success inline" onclick="decideDeposit(${d.id}, 'approve')">✅ অনুমোদন</button>
        <button class="btn danger inline" onclick="decideDeposit(${d.id}, 'reject')">❌ বাতিল</button>
      </div>
    </div>`).join('') : '<div class="empty">কোনো ডিপোজিট অপেক্ষায় নেই</div>';
}
async function decideDeposit(id, action) {
  try {
    await api('/api/admin/deposits/' + id + '/' + action, { method: 'POST' });
    toast(action === 'approve' ? 'ডিপোজিট অনুমোদিত — ব্যালেন্সে টাকা যোগ হয়েছে' : 'ডিপোজিট বাতিল হয়েছে');
    loadAdmin();
  } catch (e) { toast(e.message); }
}
async function loadAdminOrders() {
  const f = document.getElementById('admin-order-filter').value;
  const rows = await api('/api/admin/orders' + (f ? '?status=' + f : ''));
  document.getElementById('admin-order-list').innerHTML = rows.length ? rows.map(o => `
    <div class="item">
      <div class="row"><b>অর্ডার #${o.id} — ${esc(o.name)}</b><span class="badge ${o.status}">${ORDER_LABEL[o.status]}</span></div>
      <div class="muted">${esc(contactOf(o))}</div>
      <div style="margin-top:6px"><b>${esc(o.service_name)}</b></div>
      <div class="muted">${esc(o.description)}</div>
      ${o.price ? `<div style="margin-top:6px">দাম: <b>${taka(o.price)}</b></div>` : ''}
      <div class="muted small">${fmtDate(o.created_at)}</div>
      <div class="actions">
        ${o.status === 'awaiting_price' ? `<input class="price-input" id="price-${o.id}" type="number" min="1" placeholder="দাম (৳)"><button class="btn primary inline" onclick="setPrice(${o.id})">দাম বসান</button>` : ''}
        ${o.status === 'in_progress' ? `<button class="btn success inline" onclick="completeOrder(${o.id})">✅ সম্পন্ন করুন</button>` : ''}
        ${['awaiting_price', 'awaiting_payment', 'in_progress'].includes(o.status) ? `<button class="btn danger inline" onclick="adminCancelOrder(${o.id})">বাতিল</button>` : ''}
      </div>
    </div>`).join('') : '<div class="empty">কোনো অর্ডার নেই</div>';
}
async function setPrice(id) {
  const price = Number(document.getElementById('price-' + id).value);
  try { await api('/api/admin/orders/' + id + '/set-price', { method: 'POST', body: JSON.stringify({ price }) }); toast('দাম বসানো হয়েছে'); loadAdmin(); }
  catch (e) { toast(e.message); }
}
async function completeOrder(id) {
  try { await api('/api/admin/orders/' + id + '/complete', { method: 'POST' }); toast('অর্ডার সম্পন্ন!'); loadAdmin(); }
  catch (e) { toast(e.message); }
}
async function adminCancelOrder(id) {
  if (!confirm('অর্ডারটি বাতিল করবেন? (পেমেন্ট হয়ে থাকলে টাকা ফেরত যাবে)')) return;
  try { await api('/api/admin/orders/' + id + '/cancel', { method: 'POST' }); toast('অর্ডার বাতিল হয়েছে'); loadAdmin(); }
  catch (e) { toast(e.message); }
}
async function loadAdminCustomers() {
  const rows = await api('/api/admin/customers');
  document.getElementById('admin-cus-list').innerHTML = rows.length ? rows.map(c => `
    <div class="item">
      <div class="row">
        <div><b>${esc(c.name)}</b><br><span class="muted">${esc(contactOf(c))} • অর্ডার: ${c.order_count}</span></div>
        <div><b>${taka(c.balance)}</b></div>
      </div>
      <div class="actions">
        <button class="btn small" onclick="toggleAdjust(${c.id})">💰 ব্যালেন্স ঠিক করুন</button>
      </div>
      <div id="adjust-${c.id}" class="adjust-box hidden">
        <div class="muted small">হারিয়ে যাওয়া টাকা ফিরিয়ে দিতে বা ভুল ব্যালেন্স ঠিক করতে ব্যবহার করুন।</div>
        <input class="adjust-amount" id="adj-amount-${c.id}" type="number" min="1" placeholder="টাকার পরিমাণ (৳)">
        <input class="adjust-note" id="adj-note-${c.id}" type="text" placeholder="কারণ / নোট (যেমন: হারানো টাকা ফেরত)" maxlength="200">
        <div class="actions">
          <button class="btn success inline" onclick="adjustBalance(${c.id}, 'add')">➕ যোগ করুন</button>
          <button class="btn danger inline" onclick="adjustBalance(${c.id}, 'deduct')">➖ কেটে নিন</button>
        </div>
      </div>
    </div>`).join('') : '<div class="empty">কোনো কাস্টমার নেই</div>';
}
function toggleAdjust(id) {
  document.getElementById('adjust-' + id).classList.toggle('hidden');
}
async function adjustBalance(id, direction) {
  const amount = Number(document.getElementById('adj-amount-' + id).value);
  const note = document.getElementById('adj-note-' + id).value.trim();
  const verb = direction === 'add' ? 'যোগ' : 'কেটে নিতে';
  if (!confirm(`${taka(amount)} ব্যালেন্সে ${verb} চান?`)) return;
  try {
    const d = await api('/api/admin/customers/' + id + '/adjust', { method: 'POST', body: JSON.stringify({ amount, direction, note }) });
    toast('ব্যালেন্স আপডেট হয়েছে — নতুন ব্যালেন্স ' + taka(d.balance));
    loadAdminCustomers();
  } catch (e) { toast(e.message); }
}
async function loadAdminSettings() {
  const s = await api('/api/admin/settings');
  document.getElementById('set-pay-number').value = s.payment_number;
}
async function saveSettings() {
  const payment_number = document.getElementById('set-pay-number').value.trim();
  try {
    await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ payment_number }) });
    state.paymentNumber = payment_number;
    toast('পেমেন্ট নম্বর সংরক্ষিত হয়েছে');
  } catch (e) { toast(e.message); }
}
async function changePin() {
  const old_pin = document.getElementById('pin-old').value.trim();
  const new_pin = document.getElementById('pin-new').value.trim();
  try {
    await api('/api/admin/change-pin', { method: 'POST', body: JSON.stringify({ old_pin, new_pin }) });
    toast('PIN পরিবর্তন হয়েছে');
    document.getElementById('pin-old').value = '';
    document.getElementById('pin-new').value = '';
  } catch (e) { toast(e.message); }
}

// ---------- Admin messaging ----------
async function loadAdminMsgList() {
  try {
    const rows = await api('/api/admin/messages');
    state.adminThreads = rows;
    document.getElementById('admin-msg-list').innerHTML = rows.length ? rows.map(c => `
      <div class="item msg-thread" onclick="openAdminChat(${c.user_id})">
        <div class="row"><b>${esc(c.name)}</b>${c.unread ? `<span class="unread-pill">${c.unread} নতুন</span>` : ''}</div>
        <div class="muted">${esc(contactOf(c))}</div>
        <div class="muted msg-preview">${esc(c.last_text || '')}</div>
        <div class="muted small">${c.last_at ? fmtDate(c.last_at) : ''}</div>
      </div>`).join('') : '<div class="empty">এখনো কেউ মেসেজ করেনি</div>';
  } catch (e) { toast(e.message); }
}
async function openAdminChat(userId) {
  state.adminChatUser = userId;
  const t = (state.adminThreads || []).find(x => x.user_id === userId);
  document.getElementById('admin-chat-name').textContent = t ? t.name : 'কাস্টমার';
  document.getElementById('admin-chat-wrap').classList.remove('hidden');
  document.getElementById('admin-msg-list').classList.add('hidden');
  await loadAdminChat(userId);
  startMsgPolling();
}
function closeAdminChat() {
  state.adminChatUser = null;
  stopMsgPolling();
  document.getElementById('admin-chat-wrap').classList.add('hidden');
  document.getElementById('admin-msg-list').classList.remove('hidden');
  loadAdminMsgList();
}
async function loadAdminChat(userId, silent) {
  try {
    const d = await api('/api/admin/messages/' + userId);
    renderChat(document.getElementById('admin-chat-box'), d.messages, 'admin');
    refreshAdminOverview().catch(() => {});
  } catch (e) { if (!silent) toast(e.message); }
}
async function sendAdminMessage() {
  const input = document.getElementById('admin-chat-text');
  const text = input.value.trim();
  if (!text || !state.adminChatUser) return;
  try {
    await api('/api/admin/messages/' + state.adminChatUser, { method: 'POST', body: JSON.stringify({ text }) });
    input.value = '';
    loadAdminChat(state.adminChatUser);
  } catch (e) { toast(e.message); }
}

// ---------- Init ----------
document.getElementById('chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
document.getElementById('admin-chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAdminMessage(); });
(async () => { await refreshMe(); await loadServices(); })();
