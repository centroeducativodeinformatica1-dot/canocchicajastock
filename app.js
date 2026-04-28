// ════════════════════════════════════════════════════
//   Canocchi Store — POS System  |  app.js
//   Firebase v10 Modular SDK + html5-qrcode
// ════════════════════════════════════════════════════

import { initializeApp }                     from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword,
         signOut, onAuthStateChanged }        from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc,
         addDoc, getDoc, getDocs, setDoc,
         updateDoc, runTransaction, query,
         orderBy, limit, where,
         onSnapshot, serverTimestamp,
         Timestamp }                          from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Firebase Config ──────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyBg4WAoETa4fzO_eia4Nc9PraW_dkmeA4w",
  authDomain:        "canocchi-store---stock-control.firebaseapp.com",
  projectId:         "canocchi-store---stock-control",
  storageBucket:     "canocchi-store---stock-control.firebasestorage.app",
  messagingSenderId: "1062366040495",
  appId:             "1:1062366040495:web:2afb9007cc568d11fa1f5a",
  measurementId:     "G-9EB87X6949",
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ── State ────────────────────────────────────────────
let cart          = [];        // { id, barcode, name, price, quantity, stock }
let selectedMethod = null;     // payment method string
let html5QrCode   = null;      // scanner instance
let scannerActive = false;
let lastSaleData  = null;      // for ticket generation
let stockUnsubscribe = null;   // realtime listener
let stockHtml5QrCode   = null; // stock tab scanner instance
let stockScannerActive = false;
let lastScannedCode    = '';   // debounce: evitar doble escaneo del mismo código
let scanCooldown       = false;

// ════════════════════════════════════════════════════
//   UTILITIES
// ════════════════════════════════════════════════════

const fmt   = (n) => `$${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);

function toast(msg, type = 'info') {
  const icons = { info: 'ℹ️', success: '✅', error: '❌' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'slideOut 0.3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

function showLoading(btnEl, text = 'Cargando...') {
  btnEl.disabled = true;
  btnEl._origText = btnEl.innerHTML;
  btnEl.innerHTML = `<svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg> ${text}`;
}
function stopLoading(btnEl) {
  btnEl.disabled = false;
  btnEl.innerHTML = btnEl._origText;
}

// ════════════════════════════════════════════════════
//   AUTH
// ════════════════════════════════════════════════════

document.getElementById('btnLogin').addEventListener('click', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  const pass  = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  errEl.classList.add('hidden');

  if (!email || !pass) { errEl.textContent = 'Completá todos los campos.'; errEl.classList.remove('hidden'); return; }

  const btn = document.getElementById('btnLogin');
  showLoading(btn, 'Ingresando...');

  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    const msgs = {
      'auth/user-not-found':  'Usuario no encontrado.',
      'auth/wrong-password':  'Contraseña incorrecta.',
      'auth/invalid-email':   'Email inválido.',
      'auth/invalid-credential': 'Credenciales inválidas.',
    };
    errEl.textContent = msgs[e.code] || 'Error al ingresar. Revisá tus datos.';
    errEl.classList.remove('hidden');
    stopLoading(btn);
  }
});

document.getElementById('loginPass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btnLogin').click();
});

document.getElementById('btnLogout').addEventListener('click', async () => {
  await stopScanner();
  await signOut(auth);
});

onAuthStateChanged(auth, (user) => {
  if (user) {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appShell').classList.remove('hidden');
    document.getElementById('userEmail').textContent = user.email;
    initApp();
  } else {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('appShell').classList.add('hidden');
    if (stockUnsubscribe) stockUnsubscribe();
  }
});

// ════════════════════════════════════════════════════
//   TAB NAVIGATION
// ════════════════════════════════════════════════════

function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
  document.getElementById(`tab-${tabId}`).classList.remove('hidden');

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active-nav'));
  document.querySelector(`.nav-btn[data-tab="${tabId}"]`)?.classList.add('active-nav');

  document.querySelectorAll('.mob-nav').forEach(b => b.classList.remove('active-mob-nav'));
  document.querySelector(`.mob-nav[data-tab="${tabId}"]`)?.classList.add('active-mob-nav');

  if (tabId !== 'pos')   stopScanner();
  if (tabId !== 'stock') stopStockScanner();
  if (tabId === 'dashboard') loadDashboard();
  if (tabId === 'cierre')    loadCierreHistorial();
  if (tabId === 'stock')     loadStockList();
}

document.querySelectorAll('.nav-btn, .mob-nav').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ════════════════════════════════════════════════════
//   SCANNER (html5-qrcode)
// ════════════════════════════════════════════════════

async function startScanner() {
  if (scannerActive) return;
  try {
    html5QrCode = new Html5Qrcode("qr-reader");
    const cameras = await Html5Qrcode.getCameras();
    if (!cameras.length) { toast('No se encontró cámara', 'error'); return; }

    // Prefer rear camera
    const cam = cameras.find(c => /back|rear|environment/i.test(c.label)) || cameras[cameras.length - 1];

    await html5QrCode.start(
      cam.id,
      { fps: 10, qrbox: { width: 250, height: 150 }, aspectRatio: 1.5 },
      onScanSuccess,
      () => {}  // silence errors
    );
    scannerActive = true;
    document.getElementById('btnStartScan').classList.add('hidden');
    document.getElementById('btnStopScan').classList.remove('hidden');
    document.getElementById('scanStatus').textContent = '📡 Escáner activo — apuntá al código';
  } catch (e) {
    toast(`Error de cámara: ${e.message || e}`, 'error');
  }
}

async function stopScanner() {
  if (!scannerActive || !html5QrCode) return;
  try {
    await html5QrCode.stop();
    html5QrCode.clear();
  } catch (_) {}
  scannerActive = false;
  html5QrCode   = null;
  document.getElementById('btnStartScan').classList.remove('hidden');
  document.getElementById('btnStopScan').classList.add('hidden');
  document.getElementById('scanStatus').textContent = '';
  document.getElementById('qr-reader').innerHTML = `
    <div class="text-center text-[#475569] p-8">
      <svg class="w-12 h-12 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
          d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01
             M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0
             001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1
             1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"/>
      </svg>
      <p class="text-sm">Presioná "Activar Cámara" para escanear</p>
    </div>`;
}

async function onScanSuccess(code) {
  if (!code) return;
  // Evitar disparar múltiples veces el mismo código en rápida sucesión
  if (scanCooldown || code === lastScannedCode) return;
  scanCooldown    = true;
  lastScannedCode = code;
  setTimeout(() => { scanCooldown = false; lastScannedCode = ''; }, 2500);

  document.getElementById('scanStatus').textContent = `📦 Buscando: ${code}…`;
  await addProductToCartByBarcode(code);
}

document.getElementById('btnStartScan').addEventListener('click', startScanner);
document.getElementById('btnStopScan').addEventListener('click', stopScanner);

// Manual / laser scanner input
const manualBarcodeInput = document.getElementById('manualBarcode');
document.getElementById('btnSearchBarcode').addEventListener('click', async () => {
  const code = manualBarcodeInput.value.trim();
  if (!code) return;
  await addProductToCartByBarcode(code);
  manualBarcodeInput.value = '';
  manualBarcodeInput.focus();
});
manualBarcodeInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const code = manualBarcodeInput.value.trim();
    if (!code) return;
    await addProductToCartByBarcode(code);
    manualBarcodeInput.value = '';
  }
});

// ════════════════════════════════════════════════════
//   PRODUCT LOOKUP
// ════════════════════════════════════════════════════

// Helper: restores focus to manual barcode input (for USB/pistola scanners)
function refocusBarcode() {
  const input = document.getElementById('manualBarcode');
  if (input) setTimeout(() => { input.focus(); input.select(); }, 150);
}

async function addProductToCartByBarcode(barcode) {
  try {
    const docRef  = doc(db, 'productos', barcode);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      await stopScanner();
      document.getElementById('scanStatus').textContent = `⚠️ Código ${barcode} no registrado`;
      openQuickAddModal(barcode);
      return;
    }

    const product = { id: barcode, ...docSnap.data() };
    addToCart(product);
    document.getElementById('scanStatus').textContent = `✅ Agregado: ${product.name}`;
    setTimeout(() => { document.getElementById('scanStatus').textContent = '📡 Listo para escanear'; }, 2000);
    refocusBarcode(); // ← vuelve el foco al campo para el próximo escaneo
  } catch (e) {
    toast('Error al buscar producto', 'error');
    console.error(e);
  }
}

// ── Quick Add Modal ──────────────────────────────────
function openQuickAddModal(barcode) {
  document.getElementById('qaBarcode').value       = barcode;
  document.getElementById('qaBarcodeDisplay').textContent = barcode;
  document.getElementById('qaName').value          = '';
  document.getElementById('qaSection').value       = '';
  document.getElementById('qaBrand').value         = '';
  document.getElementById('qaPrice').value         = '';
  document.getElementById('qaStock').value         = '';
  document.getElementById('qaMsg').textContent     = '';
  document.getElementById('qaAddToCart').checked   = true;
  openModal('modalQuickAdd');
  setTimeout(() => document.getElementById('qaName').focus(), 100);
}

document.getElementById('btnSaveQuickAdd').addEventListener('click', async () => {
  const barcode = document.getElementById('qaBarcode').value.trim();
  const name    = document.getElementById('qaName').value.trim();
  const section = document.getElementById('qaSection').value.trim();
  const brand   = document.getElementById('qaBrand').value.trim();
  const price   = parseFloat(document.getElementById('qaPrice').value);
  const stock   = parseInt(document.getElementById('qaStock').value);
  const addToCartAfter = document.getElementById('qaAddToCart').checked;
  const msgEl   = document.getElementById('qaMsg');

  if (!name || isNaN(price) || isNaN(stock)) {
    msgEl.textContent = '⚠️ Completá Nombre, Precio y Stock';
    msgEl.className   = 'text-xs text-yellow-400 font-mono text-center';
    return;
  }

  const btn = document.getElementById('btnSaveQuickAdd');
  showLoading(btn, 'Guardando...');

  try {
    const productData = { name, section, brand, price, stock, barcode,
                          createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    await setDoc(doc(db, 'productos', barcode), productData, { merge: true });

    toast(`✅ "${name}" guardado en inventario`, 'success');
    document.getElementById('scanStatus').textContent = `✅ Producto registrado: ${name}`;

    closeModal('modalQuickAdd');
    refocusBarcode();

    if (addToCartAfter) {
      addToCart({ id: barcode, ...productData });
      setTimeout(() => { document.getElementById('scanStatus').textContent = '📡 Listo para escanear'; }, 2000);
    }

    // Refresh stock list si está visible
    if (!document.getElementById('tab-stock').classList.contains('hidden')) loadStockList();

  } catch (e) {
    msgEl.textContent = `❌ Error: ${e.message}`;
    msgEl.className   = 'text-xs text-red-400 font-mono text-center';
  } finally {
    stopLoading(btn);
  }
});

document.getElementById('closeModalQuickAdd').addEventListener('click', () => { closeModal('modalQuickAdd'); refocusBarcode(); });

// Live search by name
document.getElementById('searchProduct').addEventListener('input', async (e) => {
  const q = e.target.value.trim().toLowerCase();
  const resultsEl = document.getElementById('searchResults');
  if (q.length < 2) { resultsEl.innerHTML = ''; return; }

  try {
    const snap = await getDocs(collection(db, 'productos'));
    const matches = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(p =>
        p.name?.toLowerCase().includes(q) ||
        p.brand?.toLowerCase().includes(q) ||
        p.section?.toLowerCase().includes(q)
      )
      .slice(0, 8);

    if (!matches.length) {
      resultsEl.innerHTML = `<p class="text-surface-400 text-sm text-center py-3">Sin resultados</p>`;
      return;
    }

    resultsEl.innerHTML = matches.map(p => `
      <div class="stock-item cursor-pointer hover:border-brand-500" data-id="${p.id}">
        <div class="flex-1 min-w-0">
          <p class="text-sm font-600 text-white truncate">${p.name}</p>
          <p class="text-xs text-surface-400 font-mono">${p.id} • ${p.brand || ''} • Stock: ${p.stock}</p>
        </div>
        <span class="text-brand-400 font-display font-700 text-sm whitespace-nowrap">${fmt(p.price)}</span>
        <button class="btn-primary text-xs px-2 py-1 ml-1">+</button>
      </div>
    `).join('');

    resultsEl.querySelectorAll('[data-id]').forEach(el => {
      el.addEventListener('click', async () => {
        const found = matches.find(p => p.id === el.dataset.id);
        if (found) { addToCart(found); document.getElementById('searchProduct').value = ''; resultsEl.innerHTML = ''; }
      });
    });
  } catch (e) {
    console.error(e);
  }
});

// ════════════════════════════════════════════════════
//   CART LOGIC
// ════════════════════════════════════════════════════

function addToCart(product) {
  const existing = cart.find(i => i.id === product.id);
  if (existing) {
    if (existing.quantity >= product.stock) {
      toast(`Stock insuficiente para ${product.name}`, 'error');
      return;
    }
    existing.quantity++;
  } else {
    if (product.stock < 1) {
      toast(`${product.name} sin stock`, 'error');
      return;
    }
    cart.push({ ...product, quantity: 1 });
  }
  renderCart();
  toast(`${product.name} agregado`, 'success');
}

function removeFromCart(id) {
  cart = cart.filter(i => i.id !== id);
  renderCart();
}

function updateCartQty(id, delta) {
  const item = cart.find(i => i.id === id);
  if (!item) return;
  const newQty = item.quantity + delta;
  if (newQty < 1) { removeFromCart(id); return; }
  if (newQty > item.stock) { toast('Sin stock suficiente', 'error'); return; }
  item.quantity = newQty;
  renderCart();
}

function renderCart() {
  const el    = document.getElementById('cartItems');
  const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const count = cart.reduce((s, i) => s + i.quantity, 0);

  document.getElementById('cartTotal').textContent    = fmt(total);
  document.getElementById('cartSubtotal').textContent = fmt(total);
  document.getElementById('cartCount').textContent    = count;
  document.getElementById('btnPagar').disabled        = cart.length === 0;

  if (!cart.length) {
    el.innerHTML = `<div class="text-center text-[#475569] py-10">
      <p class="text-4xl mb-2">🛒</p><p class="text-sm">El carrito está vacío</p></div>`;
    return;
  }

  el.innerHTML = cart.map(item => `
    <div class="cart-item" data-id="${item.id}">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-600 text-white truncate">${item.name}</p>
        <p class="text-xs text-[#5a90f7] font-mono">${fmt(item.price)} c/u</p>
      </div>
      <div class="flex items-center gap-1.5">
        <button class="qty-btn w-6 h-6 rounded-md bg-[#232d45] hover:bg-[#2d3a54] text-white text-sm flex items-center justify-center"
                onclick="window._posUpdateQty('${item.id}', -1)">−</button>
        <span class="font-mono text-sm w-5 text-center">${item.quantity}</span>
        <button class="qty-btn w-6 h-6 rounded-md bg-[#232d45] hover:bg-[#2d3a54] text-white text-sm flex items-center justify-center"
                onclick="window._posUpdateQty('${item.id}', 1)">+</button>
      </div>
      <span class="font-display font-700 text-sm text-white ml-2 w-16 text-right">${fmt(item.price * item.quantity)}</span>
      <button class="ml-1 text-red-400 hover:text-red-300 text-xs" onclick="window._posRemove('${item.id}')">✕</button>
    </div>
  `).join('');
}

// Expose to inline onclick
window._posRemove    = removeFromCart;
window._posUpdateQty = updateCartQty;

document.getElementById('btnClearCart').addEventListener('click', () => {
  if (!cart.length) return;
  cart = [];
  renderCart();
  toast('Carrito vaciado', 'info');
});

// ════════════════════════════════════════════════════
//   PAYMENT MODAL
// ════════════════════════════════════════════════════

document.getElementById('btnPagar').addEventListener('click', () => {
  const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  document.getElementById('modalTotal').textContent = fmt(total);
  selectedMethod = null;

  document.querySelectorAll('.pay-method-btn').forEach(b => b.classList.remove('pay-method-selected'));
  document.getElementById('qrPagoContainer').classList.add('hidden');
  document.getElementById('efectivoInput').classList.add('hidden');
  document.getElementById('btnConfirmarPago').disabled = true;
  document.getElementById('montoEfectivo').value = '';
  document.getElementById('vuelto').textContent = '$0.00';

  openModal('modalPago');
});

document.querySelectorAll('.pay-method-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pay-method-btn').forEach(b => b.classList.remove('pay-method-selected'));
    btn.classList.add('pay-method-selected');
    selectedMethod = btn.dataset.method;

    document.getElementById('qrPagoContainer').classList.toggle('hidden', selectedMethod !== 'qr');
    document.getElementById('efectivoInput').classList.toggle('hidden', selectedMethod !== 'efectivo');
    document.getElementById('btnConfirmarPago').disabled = (selectedMethod === 'efectivo');
  });
});

document.getElementById('montoEfectivo').addEventListener('input', (e) => {
  const monto = parseFloat(e.target.value) || 0;
  const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const vuelto = monto - total;
  document.getElementById('vuelto').textContent = vuelto >= 0 ? fmt(vuelto) : '—';
  document.getElementById('btnConfirmarPago').disabled = vuelto < 0;
});

document.getElementById('closeModalPago').addEventListener('click', () => closeModal('modalPago'));

// ── Confirm Sale ─────────────────────────────────────
document.getElementById('btnConfirmarPago').addEventListener('click', async () => {
  if (!selectedMethod) return;
  const btn = document.getElementById('btnConfirmarPago');
  showLoading(btn, 'Procesando...');

  try {
    const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
    const saleId = `VTA-${Date.now()}`;

    // Run Firestore transaction: descuenta stock y guarda la venta
    // IMPORTANTE: Firestore requiere TODOS los reads antes de cualquier write
    await runTransaction(db, async (tx) => {
      // ── FASE 1: todos los READS ──────────────────────
      const prodRefs  = cart.map(item => doc(db, 'productos', item.id));
      const rankRefs  = cart.map(item => doc(db, 'ranking',   item.id));

      const prodSnaps = await Promise.all(prodRefs.map(r => tx.get(r)));
      const rankSnaps = await Promise.all(rankRefs.map(r => tx.get(r)));

      // Validar stock antes de escribir nada
      for (let i = 0; i < cart.length; i++) {
        if (!prodSnaps[i].exists()) throw new Error(`Producto "${cart[i].name}" no encontrado en inventario`);
        const currentStock = prodSnaps[i].data().stock;
        if (currentStock < cart[i].quantity) throw new Error(`Stock insuficiente para "${cart[i].name}" (disponible: ${currentStock})`);
      }

      // ── FASE 2: todos los WRITES ─────────────────────
      // 2a. Descontar stock
      for (let i = 0; i < cart.length; i++) {
        const currentStock = prodSnaps[i].data().stock;
        tx.update(prodRefs[i], { stock: currentStock - cart[i].quantity, updatedAt: serverTimestamp() });
      }

      // 2b. Guardar venta
      const saleRef = doc(db, 'ventas', saleId);
      tx.set(saleRef, {
        id:        saleId,
        items:     cart.map(i => ({ id: i.id, name: i.name, price: i.price, quantity: i.quantity })),
        total,
        method:    selectedMethod,
        date:      today(),
        timestamp: serverTimestamp(),
        cashier:   auth.currentUser?.email || 'desconocido',
      });

      // 2c. Actualizar ranking
      for (let i = 0; i < cart.length; i++) {
        const prev = rankSnaps[i].exists() ? rankSnaps[i].data().totalSold : 0;
        tx.set(rankRefs[i], {
          name:      cart[i].name,
          totalSold: prev + cart[i].quantity,
          lastSale:  serverTimestamp(),
        }, { merge: true });
      }
    });

    lastSaleData = { saleId, total, method: selectedMethod, items: [...cart], timestamp: new Date() };

    closeModal('modalPago');
    generateTicket(lastSaleData);
    openModal('modalTicket');

    cart = [];
    renderCart();
    toast('¡Venta registrada con éxito!', 'success');
  } catch (e) {
    toast(`Error: ${e.message}`, 'error');
    console.error(e);
  } finally {
    stopLoading(btn);
  }
});

// ════════════════════════════════════════════════════
//   TICKET GENERATION
// ════════════════════════════════════════════════════

function generateTicket(sale) {
  const now     = sale.timestamp.toLocaleString('es-AR');
  const methods = { efectivo: 'Efectivo', debito_credito: 'Débito/Crédito', transferencia: 'Transferencia', qr: 'QR/MercadoPago' };

  const itemRows = sale.items.map(i =>
    `<tr><td>${i.name}</td><td style="text-align:center">${i.quantity}</td>
     <td style="text-align:right">${fmt(i.price)}</td>
     <td style="text-align:right">${fmt(i.price * i.quantity)}</td></tr>`
  ).join('');

  document.getElementById('ticketContent').innerHTML = `
    <div style="text-align:center;margin-bottom:8px">
      <strong style="font-size:1.1em">CANOCCHI STORE</strong><br/>
      <span style="font-size:0.75em">Sistema de Punto de Venta</span>
    </div>
    <hr style="border-color:#ddd;margin:6px 0"/>
    <table style="width:100%;font-size:0.7em;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid #ddd">
        <th style="text-align:left">Producto</th>
        <th style="text-align:center">Cant</th>
        <th style="text-align:right">P.Unit</th>
        <th style="text-align:right">Subtotal</th>
      </tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    <hr style="border-color:#ddd;margin:6px 0"/>
    <div style="display:flex;justify-content:space-between;font-size:0.8em">
      <strong>TOTAL</strong>
      <strong>${fmt(sale.total)}</strong>
    </div>
    <div style="font-size:0.7em;color:#555;margin-top:4px">
      <div>Pago: ${methods[sale.method] || sale.method}</div>
      <div>N° Venta: ${sale.saleId}</div>
      <div>Fecha: ${now}</div>
      <div>Atendido por: ${auth.currentUser?.email || ''}</div>
    </div>
    <hr style="border-color:#ddd;margin:6px 0"/>
    <div style="text-align:center;font-size:0.65em;color:#777">
      ¡Gracias por su compra!<br/>Conserve este ticket
    </div>
  `;

  // Generate QR with sale data
  const qrContainer = document.getElementById('ticketQR');
  qrContainer.innerHTML = '';
  try {
    new QRCode(qrContainer, {
      text: JSON.stringify({ id: sale.saleId, total: sale.total, date: now, method: sale.method }),
      width: 120, height: 120,
      colorDark: '#000', colorLight: '#fff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch(e) { qrContainer.innerHTML = '<p class="text-xs text-gray-400">QR no disponible</p>'; }
}

document.getElementById('btnPrintTicket').addEventListener('click', () => {
  const content = document.getElementById('ticketContent').innerHTML;
  const w = window.open('', '_blank', 'width=400,height=600');
  w.document.write(`<!DOCTYPE html><html><head>
    <style>body{font-family:monospace;padding:1rem;font-size:12px}table{width:100%;border-collapse:collapse}</style>
    </head><body>${content}<script>window.onload=()=>{window.print();window.close()}</sc` + `ript></body></html>`);
  w.document.close();
});

document.getElementById('btnNuevaVenta').addEventListener('click', () => {
  closeModal('modalTicket');
  loadStockList();
  refocusBarcode(); // listo para el siguiente cliente
});

document.getElementById('closeModalTicket').addEventListener('click', () => closeModal('modalTicket'));

// ════════════════════════════════════════════════════
//   STOCK MANAGEMENT
// ════════════════════════════════════════════════════

document.getElementById('btnAddProduct').addEventListener('click', async () => {
  const barcode = document.getElementById('prodBarcode').value.trim();
  const name    = document.getElementById('prodName').value.trim();
  const section = document.getElementById('prodSection').value.trim();
  const brand   = document.getElementById('prodBrand').value.trim();
  const price   = parseFloat(document.getElementById('prodPrice').value);
  const stock   = parseInt(document.getElementById('prodStock').value);
  const msgEl   = document.getElementById('stockMsg');

  if (!barcode || !name || isNaN(price) || isNaN(stock)) {
    msgEl.textContent = '⚠️ Completá los campos obligatorios (*)';
    msgEl.className   = 'text-sm text-center text-yellow-400 font-mono';
    return;
  }

  const btn = document.getElementById('btnAddProduct');
  showLoading(btn, 'Guardando...');

  try {
    await setDoc(doc(db, 'productos', barcode), {
      name, section, brand, price, stock,
      barcode,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    msgEl.textContent = `✅ Producto "${name}" guardado correctamente`;
    msgEl.className   = 'text-sm text-center text-green-400 font-mono';

    // Clear form
    ['prodBarcode','prodName','prodSection','prodBrand','prodPrice','prodStock']
      .forEach(id => document.getElementById(id).value = '');

    loadStockList();
    toast(`Producto "${name}" guardado`, 'success');
  } catch (e) {
    msgEl.textContent = `❌ Error: ${e.message}`;
    msgEl.className   = 'text-sm text-center text-red-400 font-mono';
  } finally {
    stopLoading(btn);
  }
});

async function loadStockList(filter = '') {
  const el = document.getElementById('stockList');
  el.innerHTML = '<p class="text-[#475569] text-sm text-center py-8">Cargando...</p>';

  try {
    const snap = await getDocs(collection(db, 'productos'));
    let products = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (filter) {
      const f = filter.toLowerCase();
      products = products.filter(p =>
        p.name?.toLowerCase().includes(f) ||
        p.brand?.toLowerCase().includes(f) ||
        p.section?.toLowerCase().includes(f) ||
        p.id?.includes(f)
      );
    }

    products.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (!products.length) {
      el.innerHTML = '<p class="text-[#475569] text-sm text-center py-8">Sin productos</p>';
      return;
    }

    el.innerHTML = products.map(p => {
      const stockColor = p.stock <= 0 ? 'text-red-400' : p.stock < 5 ? 'text-yellow-400' : 'text-green-400';
      const rowClass   = p.stock <= 0 ? 'stock-item border-red-900/40 bg-red-950/10' : p.stock < 5 ? 'stock-item low-stock' : 'stock-item';
      return `
      <div class="${rowClass}" data-id="${p.id}">
        <div class="flex-1 min-w-0">
          <p class="text-sm font-600 text-white truncate">${p.name}</p>
          <p class="text-xs text-surface-400 font-mono">${p.id} · ${p.section || '—'} · ${p.brand || '—'}</p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <p class="text-brand-400 font-mono font-700 text-sm">${fmt(p.price)}</p>
          <!-- Stock editable inline -->
          <div class="flex items-center gap-1 bg-surface-700 border border-surface-500 rounded-lg px-1.5 py-0.5">
            <button onclick="window._adjustStock('${p.id}', -1, ${p.stock})"
              class="w-5 h-5 flex items-center justify-center text-surface-300 hover:text-white text-base leading-none transition-colors font-bold">−</button>
            <span id="stock-val-${p.id}" class="font-mono text-sm w-6 text-center ${stockColor}">${p.stock}</span>
            <button onclick="window._adjustStock('${p.id}', 1, ${p.stock})"
              class="w-5 h-5 flex items-center justify-center text-surface-300 hover:text-white text-base leading-none transition-colors font-bold">+</button>
          </div>
        </div>
      </div>
    `}).join('');
  } catch (e) {
    el.innerHTML = `<p class="text-red-400 text-sm text-center py-4">Error: ${e.message}</p>`;
  }
}

document.getElementById('filterStock').addEventListener('input', (e) => {
  loadStockList(e.target.value.trim());
});

// ════════════════════════════════════════════════════
//   DASHBOARD
// ════════════════════════════════════════════════════

async function loadDashboard() {
  // Stats for today
  try {
    const q    = query(collection(db, 'ventas'), where('date', '==', today()));
    const snap = await getDocs(q);
    const ventas = snap.docs.map(d => d.data());

    const totalHoy = ventas.reduce((s, v) => s + (v.total || 0), 0);
    const txHoy    = ventas.length;
    const avgTicket = txHoy ? totalHoy / txHoy : 0;

    document.getElementById('statSalesToday').textContent  = fmt(totalHoy);
    document.getElementById('statTxToday').textContent     = txHoy;
    document.getElementById('statAvgTicket').textContent   = fmt(avgTicket);

    // Payment breakdown
    const byMethod = {};
    ventas.forEach(v => {
      byMethod[v.method] = (byMethod[v.method] || 0) + v.total;
    });

    const methodLabels = { efectivo: '💵 Efectivo', debito_credito: '💳 Débito/Crédito', transferencia: '🏦 Transferencia', qr: '📱 QR/MP' };
    const payEl = document.getElementById('paymentBreakdown');

    if (!Object.keys(byMethod).length) {
      payEl.innerHTML = '<p class="text-[#475569] text-sm text-center py-8">Sin ventas hoy</p>';
    } else {
      payEl.innerHTML = Object.entries(byMethod).map(([method, amount]) => `
        <div class="flex items-center justify-between p-3 bg-[#1a2236] rounded-xl border border-[#232d45]">
          <span class="text-sm">${methodLabels[method] || method}</span>
          <span class="font-display font-700 text-[#2d6ef4]">${fmt(amount)}</span>
        </div>
      `).join('');
    }
  } catch(e) { console.error(e); }

  // Top 5 ranking
  try {
    const q    = query(collection(db, 'ranking'), orderBy('totalSold', 'desc'), limit(5));
    const snap = await getDocs(q);
    const items = snap.docs.map((d, i) => ({ rank: i + 1, id: d.id, ...d.data() }));

    const maxSold = items[0]?.totalSold || 1;
    const el = document.getElementById('rankingList');

    if (!items.length) {
      el.innerHTML = '<p class="text-[#475569] text-sm text-center py-8">Sin datos de ventas aún</p>';
      return;
    }

    el.innerHTML = items.map(item => `
      <div class="rank-item">
        <div class="rank-badge rank-${item.rank <= 3 ? item.rank : 'other'}">${item.rank}</div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-600 text-white truncate">${item.name}</p>
          <div class="progress-bar mt-1">
            <div class="progress-fill" style="width:${(item.totalSold / maxSold * 100).toFixed(0)}%"></div>
          </div>
        </div>
        <div class="text-right">
          <p class="font-display font-700 text-[#2d6ef4]">${item.totalSold}</p>
          <p class="text-xs text-[#475569]">vendidos</p>
        </div>
      </div>
    `).join('');
  } catch(e) { console.error(e); }
}

document.getElementById('btnRefreshDashboard').addEventListener('click', loadDashboard);

// ════════════════════════════════════════════════════
//   CIERRE DE CAJA
// ════════════════════════════════════════════════════

let cierreData = null;

async function calculateCierre() {
  try {
    const q    = query(collection(db, 'ventas'), where('date', '==', today()));
    const snap = await getDocs(q);
    const ventas = snap.docs.map(d => d.data());

    const total = ventas.reduce((s, v) => s + (v.total || 0), 0);
    const tx    = ventas.length;
    const byMethod = { efectivo: 0, debito_credito: 0, transferencia: 0, qr: 0 };
    ventas.forEach(v => { if (v.method in byMethod) byMethod[v.method] += v.total; });

    document.getElementById('cierreFecha').textContent    = new Date().toLocaleDateString('es-AR');
    document.getElementById('cTotal').textContent         = fmt(total);
    document.getElementById('cTx').textContent            = tx;
    document.getElementById('cEfectivo').textContent      = fmt(byMethod.efectivo);
    document.getElementById('cTarjeta').textContent       = fmt(byMethod.debito_credito);
    document.getElementById('cTransferencia').textContent = fmt(byMethod.transferencia);
    document.getElementById('cQR').textContent            = fmt(byMethod.qr);

    cierreData = { date: today(), total, tx, ...byMethod };
  } catch(e) {
    toast('Error calculando cierre', 'error');
  }
}

document.getElementById('btnCalcularCierre').addEventListener('click', calculateCierre);

document.getElementById('btnGuardarCierre').addEventListener('click', async () => {
  if (!cierreData) { await calculateCierre(); }
  if (!cierreData) return;

  const btn = document.getElementById('btnGuardarCierre');
  showLoading(btn, 'Guardando...');
  const msgEl = document.getElementById('cierreMsg');

  try {
    await setDoc(doc(db, 'cierres_caja', `${today()}_${Date.now()}`), {
      ...cierreData,
      closedBy:  auth.currentUser?.email || 'sistema',
      closedAt:  serverTimestamp(),
    });
    msgEl.textContent = `✅ Cierre guardado — ${new Date().toLocaleTimeString('es-AR')}`;
    msgEl.className   = 'text-sm text-center text-green-400 font-mono';
    toast('Cierre de caja guardado', 'success');
    loadCierreHistorial();
    cierreData = null;
  } catch(e) {
    msgEl.textContent = `❌ Error: ${e.message}`;
    msgEl.className   = 'text-sm text-center text-red-400 font-mono';
  } finally {
    stopLoading(btn);
  }
});

async function loadCierreHistorial() {
  const el = document.getElementById('cierreHistorial');
  try {
    const q    = query(collection(db, 'cierres_caja'), orderBy('closedAt', 'desc'), limit(10));
    const snap = await getDocs(q);

    if (snap.empty) {
      el.innerHTML = '<p class="text-[#475569] text-sm text-center py-6">Sin cierres registrados</p>';
      return;
    }

    el.innerHTML = snap.docs.map(d => {
      const c = d.data();
      const ts = c.closedAt?.toDate ? c.closedAt.toDate().toLocaleString('es-AR') : c.date;
      return `
        <div class="cierre-item">
          <div class="flex justify-between items-center text-[#5a90f7] mb-1">
            <span>${c.date}</span>
            <span>${fmt(c.total)}</span>
          </div>
          <div class="text-[#475569] text-xs space-y-0.5">
            <div class="flex justify-between"><span>Transacciones:</span><span>${c.tx}</span></div>
            <div class="flex justify-between"><span>Efectivo:</span><span class="text-green-400">${fmt(c.efectivo || 0)}</span></div>
            <div class="flex justify-between"><span>Tarjeta:</span><span class="text-blue-400">${fmt(c.debito_credito || 0)}</span></div>
            <div class="flex justify-between"><span>QR:</span><span class="text-yellow-400">${fmt(c.qr || 0)}</span></div>
            <div class="text-[#3d4f6e] mt-1">${ts} · ${c.closedBy || ''}</div>
          </div>
        </div>
      `;
    }).join('');
  } catch(e) {
    el.innerHTML = `<p class="text-red-400 text-sm text-center py-4">Error: ${e.message}</p>`;
  }
}

// ════════════════════════════════════════════════════
//   MODAL HELPERS
// ════════════════════════════════════════════════════

function openModal(id) {
  const el = document.getElementById(id);
  el.classList.remove('hidden');
  el.classList.add('flex');
}
function closeModal(id) {
  const el = document.getElementById(id);
  el.classList.add('hidden');
  el.classList.remove('flex');
}

// Close on backdrop click
['modalPago', 'modalTicket'].forEach(id => {
  document.getElementById(id).addEventListener('click', (e) => {
    if (e.target.id === id) closeModal(id);
  });
});

// ── Adjust stock inline ───────────────────────────────
window._adjustStock = async function(productId, delta, currentStock) {
  const newStock = Math.max(0, currentStock + delta);
  const spanEl   = document.getElementById(`stock-val-${productId}`);

  // Optimistic UI update
  if (spanEl) {
    spanEl.textContent = newStock;
    spanEl.className = `font-mono text-sm w-6 text-center ${newStock <= 0 ? 'text-red-400' : newStock < 5 ? 'text-yellow-400' : 'text-green-400'}`;
    // Update the onclick attributes of surrounding buttons
    const row = document.querySelector(`[data-id="${productId}"]`);
    if (row) {
      const [btnMinus, btnPlus] = row.querySelectorAll('button[onclick*="_adjustStock"]');
      if (btnMinus) btnMinus.setAttribute('onclick', `window._adjustStock('${productId}', -1, ${newStock})`);
      if (btnPlus)  btnPlus.setAttribute('onclick',  `window._adjustStock('${productId}', 1, ${newStock})`);
      // Update row color
      row.className = newStock <= 0
        ? 'stock-item border-red-900/40 bg-red-950/10'
        : newStock < 5 ? 'stock-item low-stock' : 'stock-item';
    }
  }

  try {
    await updateDoc(doc(db, 'productos', productId), {
      stock: newStock,
      updatedAt: serverTimestamp(),
    });
  } catch (e) {
    toast(`Error al actualizar stock: ${e.message}`, 'error');
    // Revert
    if (spanEl) spanEl.textContent = currentStock;
  }
};

// ── Export to Excel ───────────────────────────────────
async function exportStockToExcel() {
  try {
    const snap     = await getDocs(collection(db, 'productos'));
    const products = snap.docs.map(d => {
      const p = d.data();
      return {
        'Código de Barras': d.id,
        'Nombre':           p.name    || '',
        'Sección':          p.section || '',
        'Marca':            p.brand   || '',
        'Precio ($)':       p.price   ?? 0,
        'Stock':            p.stock   ?? 0,
        'Valor en Stock ($)': (p.price ?? 0) * (p.stock ?? 0),
      };
    });

    products.sort((a, b) => a['Nombre'].localeCompare(b['Nombre']));

    const ws = XLSX.utils.json_to_sheet(products);

    // Column widths
    ws['!cols'] = [
      { wch: 18 }, { wch: 32 }, { wch: 16 }, { wch: 16 },
      { wch: 12 }, { wch: 8  }, { wch: 18 },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Inventario');

    const fecha = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `inventario_canocchi_${fecha}.xlsx`);
    toast('✅ Excel exportado', 'success');
  } catch (e) {
    toast(`Error al exportar: ${e.message}`, 'error');
  }
}

document.getElementById('btnExportExcel').addEventListener('click', exportStockToExcel);

// ════════════════════════════════════════════════════
//   STOCK TAB — BARCODE SCANNER
// ════════════════════════════════════════════════════

async function startStockScanner() {
  if (stockScannerActive) return;
  const wrap = document.getElementById('stock-qr-reader-wrap');
  const statusEl = document.getElementById('stockScanStatus');
  try {
    stockHtml5QrCode = new Html5Qrcode('stock-qr-reader');
    const cameras = await Html5Qrcode.getCameras();
    if (!cameras.length) { toast('No se encontró cámara', 'error'); return; }

    const cam = cameras.find(c => /back|rear|environment/i.test(c.label)) || cameras[cameras.length - 1];

    wrap.classList.remove('hidden');
    await stockHtml5QrCode.start(
      cam.id,
      { fps: 10, qrbox: { width: 220, height: 120 }, aspectRatio: 1.5 },
      (code) => {
        if (!code) return;
        document.getElementById('prodBarcode').value = code;
        statusEl.textContent = `✅ Código: ${code}`;
        stopStockScanner();
        setTimeout(() => document.getElementById('prodName').focus(), 200);
      },
      () => {}
    );
    stockScannerActive = true;
    statusEl.textContent = '📡 Escáner activo — apuntá al código';
  } catch (e) {
    wrap.classList.add('hidden');
    toast(`Error de cámara: ${e.message || e}`, 'error');
  }
}

async function stopStockScanner() {
  if (!stockScannerActive || !stockHtml5QrCode) return;
  try {
    await stockHtml5QrCode.stop();
    stockHtml5QrCode.clear();
  } catch (_) {}
  stockScannerActive = false;
  stockHtml5QrCode   = null;
  document.getElementById('stock-qr-reader-wrap').classList.add('hidden');
}

document.getElementById('btnStockScan').addEventListener('click', startStockScanner);
document.getElementById('btnStockStopScan').addEventListener('click', stopStockScanner);

// ════════════════════════════════════════════════════
//   INIT
// ════════════════════════════════════════════════════

function initApp() {
  renderCart();
  switchTab('pos');

  // Pre-fill cierre date
  document.getElementById('cierreFecha').textContent = new Date().toLocaleDateString('es-AR');

  console.log('%c🛒 Canocchi POS — Sistema iniciado', 'color:#1a56e8;font-weight:bold;font-size:14px');
}
