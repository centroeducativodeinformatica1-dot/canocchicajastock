// ════════════════════════════════════════════════════
//   Canocchi Store POS — test.js
//   Script de verificación de conexión a Firebase
//   Ejecutar en consola del navegador o como módulo
// ════════════════════════════════════════════════════

import { initializeApp, getApps }       from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection,
         getDocs, addDoc, deleteDoc,
         doc, serverTimestamp }         from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey:            "AIzaSyBg4WAoETa4fzO_eia4Nc9PraW_dkmeA4w",
  authDomain:        "canocchi-store---stock-control.firebaseapp.com",
  projectId:         "canocchi-store---stock-control",
  storageBucket:     "canocchi-store---stock-control.firebasestorage.app",
  messagingSenderId: "1062366040495",
  appId:             "1:1062366040495:web:2afb9007cc568d11fa1f5a",
  measurementId:     "G-9EB87X6949",
};

// Reutiliza la app si ya fue inicializada (para no duplicar)
const app  = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

const PASS = '✅';
const FAIL = '❌';
const INFO = 'ℹ️';

async function runTests() {
  console.group('%c🔬 Canocchi POS — Test Suite', 'color:#1a56e8;font-weight:bold;font-size:14px');
  console.log(`${INFO} Iniciando pruebas de conexión...`);
  console.log(`${INFO} Timestamp: ${new Date().toLocaleString('es-AR')}`);
  console.groupEnd();

  const results = [];

  // ── TEST 1: App Initialization ────────────────────
  await runTest('Firebase App Init', async () => {
    if (!app) throw new Error('App no inicializada');
    if (app.options.projectId !== 'canocchi-store---stock-control')
      throw new Error('Project ID incorrecto');
    return `Project ID: ${app.options.projectId}`;
  }, results);

  // ── TEST 2: Auth Module ───────────────────────────
  await runTest('Firebase Auth Module', async () => {
    if (!auth) throw new Error('Auth no disponible');
    const user = auth.currentUser;
    return user
      ? `Sesión activa: ${user.email}`
      : 'Auth disponible — sin sesión activa (normal en test)';
  }, results);

  // ── TEST 3: Firestore Read ────────────────────────
  await runTest('Firestore — Lectura (productos)', async () => {
    const snap = await getDocs(collection(db, 'productos'));
    return `${snap.size} producto(s) encontrado(s) en la colección`;
  }, results);

  // ── TEST 4: Firestore Write + Delete (no-op test) ─
  await runTest('Firestore — Escritura y Eliminación', async () => {
    const testCol = collection(db, '_test_connection');
    const docRef  = await addDoc(testCol, {
      testMessage: 'Canocchi POS connection test',
      timestamp:   serverTimestamp(),
      version:     '2.0',
    });
    await deleteDoc(doc(db, '_test_connection', docRef.id));
    return `Doc creado y eliminado: ${docRef.id}`;
  }, results);

  // ── TEST 5: Firestore Collections Check ──────────
  await runTest('Firestore — Colecciones del sistema', async () => {
    const collections = ['productos', 'ventas', 'ranking', 'cierres_caja'];
    const checks = [];
    for (const col of collections) {
      const snap = await getDocs(collection(db, col));
      checks.push(`${col}: ${snap.size} docs`);
    }
    return checks.join(' | ');
  }, results);

  // ── TEST 6: Auth State Listener ───────────────────
  await runTest('Auth State Listener', async () => {
    return new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, (user) => {
        unsub();
        resolve(user ? `Usuario logueado: ${user.email}` : 'Sin sesión — listener OK');
      });
    });
  }, results);

  // ── SUMMARY ──────────────────────────────────────
  console.group('%c📊 Resumen de Tests', 'color:#1a56e8;font-weight:bold;font-size:13px');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  results.forEach(r => {
    const style = r.passed
      ? 'color:#22c55e;font-weight:600'
      : 'color:#ef4444;font-weight:600';
    console.log(`%c${r.passed ? PASS : FAIL} ${r.name}`, style);
    if (r.detail) console.log(`   ${INFO} ${r.detail}`);
    if (r.error)  console.error(`   Error: ${r.error}`);
  });

  const summaryStyle = failed === 0
    ? 'color:#22c55e;font-weight:bold;font-size:13px'
    : 'color:#ef4444;font-weight:bold;font-size:13px';
  console.log(`%c\n${passed}/${results.length} tests pasaron`, summaryStyle);
  if (failed === 0) {
    console.log('%c🎉 ¡Sistema listo para producción!', 'color:#1a56e8;font-weight:bold');
  } else {
    console.warn(`⚠️ ${failed} test(s) fallaron. Revisá la configuración de Firebase y las reglas de Firestore.`);
  }
  console.groupEnd();

  return { passed, failed, total: results.length };
}

async function runTest(name, fn, results) {
  console.group(`🧪 ${name}`);
  try {
    const detail = await fn();
    console.log(`%c${PASS} Pasó`, 'color:#22c55e;font-weight:600');
    if (detail) console.log(`${INFO} ${detail}`);
    results.push({ name, passed: true, detail });
  } catch (e) {
    console.error(`${FAIL} Falló: ${e.message}`);
    results.push({ name, passed: false, error: e.message });
  }
  console.groupEnd();
}

// ── Ejecutar automáticamente si se carga como módulo standalone ──
runTests().then(summary => {
  console.log('\n%cCanocchi POS Test Suite — Finalizado', 'color:#475569;font-size:11px');
}).catch(console.error);

// Exportar para uso externo
export { runTests };

/* 
  ══════════════════════════════════════════════════
  CÓMO USAR ESTE ARCHIVO
  ══════════════════════════════════════════════════
  
  Opción 1 — Agregar temporalmente en index.html:
    <script type="module" src="test.js"></script>
  
  Opción 2 — En la consola del navegador (F12):
    import('./test.js').then(m => m.runTests())
  
  Opción 3 — Como módulo Node.js (requiere adapter):
    Ver: https://firebase.google.com/docs/web/environments-js-sdk
  
  ══════════════════════════════════════════════════
  REGLAS DE FIRESTORE RECOMENDADAS
  ══════════════════════════════════════════════════
  
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      
      // Solo usuarios autenticados pueden leer/escribir
      match /{document=**} {
        allow read, write: if request.auth != null;
      }
      
      // Colección de test (puede borrarse en producción)
      match /_test_connection/{doc} {
        allow read, write, delete: if request.auth != null;
      }
    }
  }
  ══════════════════════════════════════════════════
*/
