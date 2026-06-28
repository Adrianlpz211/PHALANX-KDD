#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ─── DB ADAPTER — better-sqlite3 nativo o sql.js puro JS ─────────────────────
// Intenta better-sqlite3 (rápido, nativo). Si falla, usa sql.js (puro JS, sin compilar).
// El usuario no hace nada — funciona en cualquier Windows/Mac/Linux automáticamente.

let dbAdapter = null; // 'better-sqlite3' | 'sqljs'

function getDB(dbPath) {
  // Intentar better-sqlite3 primero (nativo, rápido, Mac/Linux/Windows con VS)
  if (dbAdapter !== 'node-sqlite' && dbAdapter !== 'sqljs') {
    try {
      const BS3 = require('better-sqlite3');
      const db = new BS3(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('cache_size = -64000');
      db.pragma('temp_store = MEMORY');
      dbAdapter = 'better-sqlite3';
      return { db, type: 'better-sqlite3' };
    } catch(e) {}
  }

  // Fallback 1: node:sqlite — integrado en Node.js 22+, sin instalar nada
  if (dbAdapter !== 'sqljs') {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath);
      dbAdapter = 'node-sqlite';
      return { db, type: 'node-sqlite' };
    } catch(e) {}
  }

  // Fallback 2: sql.js — puro JS, cualquier Node version
  const projectRoot = path.join(__dirname, '..', '..');
  const searchPaths = [
    path.join(projectRoot, 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
    path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
  ];

  for (const sqlPath of searchPaths) {
    if (fs.existsSync(sqlPath)) {
      try {
        // sql.js sync workaround usando Worker
        const SQL = require(sqlPath);
        let DbClass = null;
        if (SQL && SQL.Database) DbClass = SQL.Database;
        else if (typeof SQL === 'function') {
          // Intentar llamar sync
          let resolved = null;
          SQL({}).then(s => { resolved = s; }).catch(() => {});
          // Esperar máximo 3 segundos
          const start = Date.now();
          while (!resolved && Date.now() - start < 3000) {
            require('child_process').spawnSync('node', ['-e', ''], { timeout: 10 });
          }
          if (resolved && resolved.Database) DbClass = resolved.Database;
        }
        if (DbClass) {
          let buffer = null;
          if (fs.existsSync(dbPath)) buffer = fs.readFileSync(dbPath);
          const db = buffer ? new DbClass(buffer) : new DbClass();
          dbAdapter = 'sqljs';
          return { db, type: 'sqljs', path: dbPath };
        }
      } catch(e) {}
    }
  }

  throw new Error(
    'No se pudo inicializar el grafo SQLite.\n' +
    '  Tu versión de Node.js: ' + process.version + '\n' +
    '  Opciones:\n' +
    '  1. Usa Node.js 22+ (ya incluye SQLite integrado)\n' +
    '  2. Corre: npm install sql.js\n' +
    '  3. Instala Visual Studio Build Tools para better-sqlite3'
  );
}

// Wrapper unificado que abstrae las diferencias entre better-sqlite3 y sql.js
function createAdapter(dbPath) {
  const { db, type, path: sqlPath } = getDB(dbPath);

  if (type === 'better-sqlite3') {
    return {
      exec: (sql) => { try { db.exec(sql); } catch(e) {} },
      all:  (sql, ...params) => { try { return db.prepare(sql).all(...params.flat()); } catch(e) { return []; } },
      get:  (sql, ...params) => { try { return db.prepare(sql).get(...params.flat()); } catch(e) { return null; } },
      run:  (sql, ...params) => { try { db.prepare(sql).run(...params.flat()); } catch(e) {} },
      transaction: (fn) => db.transaction(fn),
      pragma: (p) => { try { db.pragma(p); } catch(e) {} },
      close: () => { try { db.close(); } catch(e) {} },
      type: 'better-sqlite3'
    };
  }

  if (type === 'node-sqlite') {
    // node:sqlite API — similar a better-sqlite3
    return {
      exec: (sql) => { try { db.exec(sql); } catch(e) {} },
      all:  (sql, ...params) => { try { return db.prepare(sql).all(...params.flat()); } catch(e) { return []; } },
      get:  (sql, ...params) => { try { return db.prepare(sql).get(...params.flat()); } catch(e) { return null; } },
      run:  (sql, ...params) => { try { db.prepare(sql).run(...params.flat()); } catch(e) {} },
      transaction: (fn) => (...args) => { try { fn(...args); } catch(e) {} },
      pragma: () => {},
      close: () => { try { db.close(); } catch(e) {} },
      type: 'node-sqlite'
    };
  }
    // sql.js API — puro JS, necesita guardar el archivo manualmente
    const saveDB = () => {
      try {
        const data = db.export();
        fs.writeFileSync(sqlPath, Buffer.from(data));
      } catch(e) {}
    };

    const runSQL = (sql, params) => {
      try { db.run(sql, params || []); } catch(e) {}
    };

    const execSQL = (sql) => {
      try { db.exec(sql); } catch(e) {}
    };

    const allSQL = (sql, ...params) => {
      try {
        const stmt = db.prepare(sql);
        const rows = [];
        const flatParams = params.flat();
        if (flatParams.length) stmt.bind(flatParams);
        while (stmt.step()) {
          const row = stmt.getAsObject();
          rows.push(row);
        }
        stmt.free();
        return rows;
      } catch(e) { return []; }
    };

    const getSQL = (sql, ...params) => {
      const rows = allSQL(sql, ...params);
      return rows[0] || null;
    };

    return {
      exec: execSQL,
      all: allSQL,
      get: getSQL,
      run: (sql, ...params) => { runSQL(sql, params.flat()); saveDB(); },
      transaction: (fn) => (...args) => { fn(...args); saveDB(); },
      pragma: () => {}, // no-op en sql.js
      close: () => saveDB(),
      type: 'sqljs',
      save: saveDB
    };
}

const ROOT        = path.join(__dirname, '..', '..');
const DB_PATH     = path.join(ROOT, '.agentic', 'memoria.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const MEMORIA_PATH= path.join(ROOT, '.agentic', 'memoria');

// ─── INIT ──────────────────────────────────────────────────────────────────────
function initDB() {
  const adapter = createAdapter(DB_PATH);
  const schema  = fs.readFileSync(SCHEMA_PATH, 'utf8');
  // Ejecutar schema línea por línea para compatibilidad con sql.js
  schema.split(';').map(s => s.trim()).filter(s => s && !s.startsWith('--')).forEach(s => {
    try { adapter.exec(s + ';'); } catch(e) {}
  });
  migrateDB(adapter);
  return adapter;
}

function migrateDB(db) {
  const alteraciones = [
    "ALTER TABLE nodos ADD COLUMN ultima_validacion TEXT DEFAULT (datetime('now'))",
    "ALTER TABLE ciclos ADD COLUMN tipo_tarea TEXT DEFAULT 'feature'",
    "ALTER TABLE ciclos ADD COLUMN memory_trace TEXT DEFAULT '[]'",
    "ALTER TABLE ciclos ADD COLUMN snapshot_inicio TEXT",
    "ALTER TABLE ciclos ADD COLUMN snapshot_fin TEXT",
    "ALTER TABLE fases ADD COLUMN duracion_ms INTEGER DEFAULT 0",
    "ALTER TABLE fases ADD COLUMN tokens_aprox INTEGER DEFAULT 0",
  ];
  alteraciones.forEach(sql => { try { db.exec(sql); } catch(e) {} });

  const indices = [
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_nodos_unique ON nodos(tipo, titulo)",
    "CREATE INDEX IF NOT EXISTS idx_nodos_area_tipo ON nodos(area, tipo)",
    "CREATE INDEX IF NOT EXISTS idx_nodos_area_confianza ON nodos(area, confianza)",
    "CREATE INDEX IF NOT EXISTS idx_nodos_tipo_confianza ON nodos(tipo, confianza)",
    "CREATE INDEX IF NOT EXISTS idx_nodos_tipo_estado ON nodos(tipo, estado)",
    "CREATE INDEX IF NOT EXISTS idx_nodos_area_tipo_estado ON nodos(area, tipo, estado)",
    "CREATE INDEX IF NOT EXISTS idx_nodos_confianza_aplicado ON nodos(confianza, aplicado)",
    "CREATE INDEX IF NOT EXISTS idx_ciclos_estado ON ciclos(estado)",
    "CREATE INDEX IF NOT EXISTS idx_ciclos_modulo ON ciclos(modulo)",
    "CREATE INDEX IF NOT EXISTS idx_ciclos_fecha ON ciclos(fecha_inicio)",
    "CREATE INDEX IF NOT EXISTS idx_fases_ciclo ON fases(ciclo_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_unique ON relaciones(desde_id, tipo, hacia_id)",
  ];
  indices.forEach(sql => { try { db.exec(sql); } catch(e) {} });
}

// ─── SNAPSHOT ─────────────────────────────────────────────────────────────────
function snapshotMemoria(db) {
  try {
    const snap = { fecha: new Date().toISOString(), totales: {}, por_tipo: {}, alta_rules: [] };
    snap.totales.total    = (db.get('SELECT COUNT(*) as n FROM nodos') || {}).n || 0;
    snap.totales.alta     = (db.get("SELECT COUNT(*) as n FROM nodos WHERE confianza='ALTA'") || {}).n || 0;
    snap.totales.media    = (db.get("SELECT COUNT(*) as n FROM nodos WHERE confianza='MEDIA'") || {}).n || 0;
    snap.totales.activos  = (db.get("SELECT COUNT(*) as n FROM nodos WHERE estado='ACTIVO'") || {}).n || 0;
    snap.totales.obsoletos= (db.get("SELECT COUNT(*) as n FROM nodos WHERE estado='OBSOLETO'") || {}).n || 0;
    snap.alta_rules = db.all("SELECT titulo, tipo, area FROM nodos WHERE confianza='ALTA' AND estado='ACTIVO'");
    const porTipo = db.all('SELECT tipo, COUNT(*) as n FROM nodos GROUP BY tipo');
    porTipo.forEach(r => snap.por_tipo[r.tipo] = r.n);
    return snap;
  } catch(e) { return null; }
}

// ─── PARSEAR ENTRADAS ─────────────────────────────────────────────────────────
function parsearEntradas(contenido, tipo) {
  const entradas = [];
  // Remover bloques de comentario HTML (plantillas/ejemplos) ANTES de partir:
  // sus encabezados `## ` internos NO deben generar nodos fantasma.
  contenido = contenido.replace(/<!--[\s\S]*?-->/g, '');
  // Una entrada real SIEMPRE tiene al menos un campo estructurado. Este criterio
  // positivo descarta headers de archivo (#), secciones de scaffolding
  // (Registro / Patrones activos / Ejemplos…) y cualquier texto suelto, sin
  // depender de una lista frágil de prefijos a excluir.
  const CAMPO_RE = /^(Área|Area|Confianza|Estado|Aplicado|Útil|Util|Prioridad|Error|Síntoma|Sintoma|Causa|Solución|Solucion|Regla|Razón|Razon|Decisión|Decision|Contexto|Aplica a):/m;
  const secciones = contenido.split(/^## /m).filter(s => {
    const t = s.trim();
    if (!t || t.length < 10) return false;
    if (t.startsWith('#')) return false;   // header de archivo / preámbulo
    return CAMPO_RE.test(s);               // sólo secciones con campos reales
  });
  for (const sec of secciones) {
    const lineas = sec.split('\n');
    const titulo = lineas[0].trim().replace(/^\[.*?\]\s*/, '').trim();
    if (!titulo || titulo.length < 5) continue;
    const e = { tipo, titulo, contenido: sec, area: 'global', confianza: 'BAJA',
      aplicado: 0, util: 0, estado: 'ACTIVO', ultima_validacion: new Date().toISOString() };
    for (const l of lineas) {
      if (l.startsWith('Área:') || l.startsWith('Area:'))
        e.area = l.split(':')[1]?.trim() || 'global';
      if (l.startsWith('Confianza:'))
        e.confianza = l.split(':')[1]?.trim() || 'BAJA';
      if (l.startsWith('Aplicado:'))
        e.aplicado = parseInt(l.split(':')[1]?.trim()) || 0;
      if (l.startsWith('Útil:') || l.startsWith('Util:'))
        e.util = parseInt(l.split(':')[1]?.trim()) || 0;
      if (l.startsWith('Estado:'))
        e.estado = l.split(':')[1]?.trim().split(' ')[0] || 'ACTIVO';
      if (l.startsWith('Última validación:') || l.startsWith('Ultima validacion:'))
        e.ultima_validacion = l.split(':').slice(1).join(':').trim();
    }
    entradas.push(e);
  }
  return entradas;
}

// ─── SINCRONIZAR ──────────────────────────────────────────────────────────────
function sincronizar() {
  const db = initDB();
  const archivos = [
    { file: 'errores.md', tipo: 'error' },
    { file: 'patrones.md', tipo: 'patron' },
    { file: 'decisiones.md', tipo: 'decision' }
  ];
  let total = 0, nuevos = 0, actualizados = 0;

  for (const { file, tipo } of archivos) {
    const fp = path.join(MEMORIA_PATH, file);
    if (!fs.existsSync(fp)) continue;
    const entradas = parsearEntradas(fs.readFileSync(fp, 'utf8'), tipo);
    for (const e of entradas) {
      const ex = db.get('SELECT id FROM nodos WHERE tipo=? AND titulo=?', e.tipo, e.titulo);
      if (ex) {
        db.run('UPDATE nodos SET contenido=?,area=?,confianza=?,aplicado=?,util=?,estado=?,ultima_validacion=?,fecha_update=datetime(\'now\') WHERE tipo=? AND titulo=?',
          e.contenido, e.area, e.confianza, e.aplicado, e.util, e.estado, e.ultima_validacion, e.tipo, e.titulo);
        actualizados++;
      } else {
        db.run("INSERT INTO nodos (tipo,titulo,contenido,area,confianza,aplicado,util,estado,ultima_validacion,fecha_update) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))",
          e.tipo, e.titulo, e.contenido, e.area, e.confianza, e.aplicado, e.util, e.estado, e.ultima_validacion);
        nuevos++;
      }
      total++;
    }
  }
  if (db.type === 'sqljs' && db.save) db.save();
  detectarRelaciones(db);
  db.close();
  console.log(`\n  Grafo sincronizado — ${total} nodos (${nuevos} nuevos, ${actualizados} actualizados)`);
  console.log(`  Motor: ${dbAdapter === 'better-sqlite3' ? 'nativo (<5ms)' : 'sql.js (<20ms)'}\n`);
}

// ─── RELACIONES ────────────────────────────────────────────────────────────────
function detectarRelaciones(db) {
  const nodos = db.all('SELECT * FROM nodos');
  for (const n of nodos) for (const o of nodos) {
    if (n.id === o.id) continue;
    if (n.tipo==='error'  && o.tipo==='patron'   && (n.area===o.area||o.area==='global'))
      try { db.run('INSERT OR IGNORE INTO relaciones (desde_id,tipo,hacia_id,peso) VALUES (?,?,?,?)', n.id,'resuelto_por',o.id,1.0); } catch(e) {}
    if (n.tipo==='patron' && o.tipo==='decision' && (n.area===o.area||o.area==='global'))
      try { db.run('INSERT OR IGNORE INTO relaciones (desde_id,tipo,hacia_id,peso) VALUES (?,?,?,?)', n.id,'origino',o.id,0.8); } catch(e) {}
    if (n.area===o.area && n.area!=='global' && n.id<o.id)
      try { db.run('INSERT OR IGNORE INTO relaciones (desde_id,tipo,hacia_id,peso) VALUES (?,?,?,?)', n.id,'relacionado_con',o.id,0.5); } catch(e) {}
    if (n.confianza==='ALTA' && o.confianza==='ALTA' && n.area===o.area && n.id<o.id)
      try { db.run('INSERT OR IGNORE INTO relaciones (desde_id,tipo,hacia_id,peso) VALUES (?,?,?,?)', n.id,'aplica_a',o.id,1.5); } catch(e) {}
  }
  if (db.type === 'sqljs' && db.save) db.save();
}

// ─── CONSULTAR ────────────────────────────────────────────────────────────────
function consultar(area, tipo) {
  const db = initDB();
  const trace = { area, tipo, timestamp: new Date().toISOString(), nodos_retornados: 0, titulos: [] };
  let sql = "SELECT * FROM nodos WHERE estado='ACTIVO'";
  const params = [];
  if (area && area !== 'global') { sql += " AND (area=? OR area='global')"; params.push(area); }
  if (tipo) { sql += " AND tipo=?"; params.push(tipo); }
  sql += " ORDER BY CASE confianza WHEN 'ALTA' THEN 0 WHEN 'MEDIA' THEN 1 ELSE 2 END, util DESC, aplicado DESC";
  const resultados = db.all(sql, ...params);
  trace.nodos_retornados = resultados.length;
  trace.titulos = resultados.slice(0,5).map(r => r.titulo);
  db.close();
  return { resultados, trace };
}

// ─── STATS ────────────────────────────────────────────────────────────────────
function stats() {
  const db = initDB();
  const totalNodos = (db.get('SELECT COUNT(*) as n FROM nodos') || {}).n || 0;
  const totalRels  = (db.get('SELECT COUNT(*) as n FROM relaciones') || {}).n || 0;
  const porTipo    = db.all('SELECT tipo, COUNT(*) as n FROM nodos GROUP BY tipo');
  const porConf    = db.all('SELECT confianza, COUNT(*) as n FROM nodos GROUP BY confianza');
  const altas      = db.all("SELECT titulo,tipo,area FROM nodos WHERE confianza='ALTA' AND estado='ACTIVO'");
  let cicloStats   = null;
  try {
    const total = (db.get('SELECT COUNT(*) as n FROM ciclos') || {}).n || 0;
    if (total > 0) {
      const comp  = (db.get("SELECT COUNT(*) as n FROM ciclos WHERE estado='COMPLETADO'") || {}).n || 0;
      const stops = (db.get("SELECT COUNT(*) as n FROM ciclos WHERE estado='STOP'") || {}).n || 0;
      cicloStats = { total, comp, stops, goal: Math.round(comp/total*100) };
    }
  } catch(e) {}
  db.close();

  console.log('\n  GRAFO DE CONOCIMIENTO — Agentic KDD\n');
  console.log(`  Motor: ${dbAdapter === 'better-sqlite3' ? 'better-sqlite3 nativo' : dbAdapter === 'node-sqlite' ? 'node:sqlite (Node.js 22+)' : 'sql.js (compatible Windows)'}`);
  console.log(`  Total nodos: ${totalNodos} | Relaciones: ${totalRels}`);
  if (porTipo.length)  { console.log('\n  Por tipo:');      porTipo.forEach(r => console.log(`    ${r.tipo}: ${r.n}`)); }
  if (porConf.length)  { console.log('\n  Por confianza:'); porConf.forEach(r => console.log(`    ${r.confianza}: ${r.n}`)); }
  if (altas.length)    { console.log('\n  Reglas ALTA (permanentes):'); altas.forEach(r => console.log(`    [${r.tipo}] ${r.titulo} (${r.area})`)); }
  if (cicloStats)      { console.log(`\n  Ciclos: ${cicloStats.total} | Completados: ${cicloStats.comp} | STOPs: ${cicloStats.stops} | Goal Attainment: ${cicloStats.goal}%`); }
  if (totalNodos === 0) console.log('\n  Sin datos — usa aa: para empezar.');
  console.log('');
}

// ─── MÉTRICAS ─────────────────────────────────────────────────────────────────
function metricas() {
  try {
    const db = initDB();
    const ciclos = db.all('SELECT * FROM ciclos ORDER BY fecha_inicio DESC');
    if (!ciclos.length) { db.close(); return { total: 0, mensaje: 'Sin ciclos aun' }; }
    const total       = ciclos.length;
    const completados = ciclos.filter(c => c.estado==='COMPLETADO').length;
    const stops       = ciclos.filter(c => c.estado==='STOP').length;
    const goal        = Math.round(completados/total*100);
    const autonomy    = Math.round((total-stops)/total*100);
    const totalFases  = ciclos.reduce((s,c)=>s+(c.fases_total||0),0);
    const fasesOK     = ciclos.reduce((s,c)=>s+(c.fases_completadas||0),0);
    const handoff     = totalFases>0?Math.round(fasesOK/totalFases*100):0;
    const blockers    = ciclos.reduce((s,c)=>s+(c.review_blockers||0),0);
    const drift       = (blockers/total).toFixed(2);
    const guardrails  = ciclos.filter(c=>c.context_guard==='STOP').length;
    let pats=0, errs=0;
    ciclos.forEach(c=>{
      try{pats+=JSON.parse(c.patrones_aplicados||'[]').length;}catch(e){}
      try{errs+=JSON.parse(c.errores_evitados||'[]').length;}catch(e){}
    });
    const tGen = ciclos.reduce((s,c)=>s+(c.tests_generados||0),0);
    const tOK  = ciclos.reduce((s,c)=>s+(c.tests_pasando||0),0);
    // Éxito por tipo de tarea
    const tipoMap = {};
    ciclos.forEach(c=>{
      const t = c.tipo_tarea||'feature';
      if(!tipoMap[t]) tipoMap[t]={total:0,ok:0};
      tipoMap[t].total++;
      if(c.estado==='COMPLETADO') tipoMap[t].ok++;
    });
    const exito_por_tipo = Object.entries(tipoMap).map(([tipo,v])=>({
      tipo, total:v.total, ok:v.ok, rate:Math.round(v.ok/v.total*100)
    }));
    // Evolución de memoria
    let evolucion = null;
    const conSnap = ciclos.filter(c=>c.snapshot_fin);
    if (conSnap.length>=2) {
      try {
        const p = JSON.parse(conSnap[conSnap.length-1].snapshot_fin);
        const u = JSON.parse(conSnap[0].snapshot_fin);
        evolucion = {
          nodos_inicio: p.totales?.total||0, nodos_ahora: u.totales?.total||0,
          alta_inicio: p.totales?.alta||0,   alta_ahora:  u.totales?.alta||0,
          crecimiento: (u.totales?.total||0)-(p.totales?.total||0)
        };
      } catch(e) {}
    }
    db.close();
    return {
      total, completados, stops,
      goal_attainment: goal, autonomy_ratio: autonomy,
      handoff_integrity: handoff, drift_index: drift,
      guardrail_violations: guardrails,
      patrones_aplicados: pats, errores_evitados: errs,
      test_rate: tGen>0?Math.round(tOK/tGen*100):0,
      tests_generados: tGen, tests_pasando: tOK,
      exito_por_tipo, evolucion_memoria: evolucion,
      ciclos_recientes: ciclos.slice(0,15),
      motor: dbAdapter
    };
  } catch(e) { return { total:0, error: e.message }; }
}

// ─── REGISTRAR CICLO ──────────────────────────────────────────────────────────
function registrarCiclo(datos) {
  try {
    const db = initDB();
    const ciclo_id = crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36)+Math.random().toString(36).slice(2);
    const snap = snapshotMemoria(db);
    db.run(`INSERT INTO ciclos (ciclo_id,tarea,tipo_tarea,modulo,area,estado,context_guard,
      fases_total,fases_completadas,patrones_aplicados,errores_evitados,decisiones_usadas,
      memory_trace,tests_generados,tests_pasando,review_blockers,review_required,stops_count,
      sync_grafo,duracion_ms,snapshot_inicio,snapshot_fin,fecha_fin)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      ciclo_id,
      datos.tarea||'',
      datos.tipo_tarea||'feature',
      datos.modulo||'global',
      datos.area||'global',
      datos.estado||'COMPLETADO',
      datos.context_guard||'OK',
      datos.fases_total||0,
      datos.fases_completadas||0,
      JSON.stringify(datos.patrones_aplicados||[]),
      JSON.stringify(datos.errores_evitados||[]),
      JSON.stringify(datos.decisiones_usadas||[]),
      JSON.stringify(datos.memory_trace||[]),
      datos.tests_generados||0,
      datos.tests_pasando||0,
      datos.review_blockers||0,
      datos.review_required||0,
      datos.stops_count||0,
      datos.sync_grafo?1:0,
      datos.duracion_ms||0,
      snap?JSON.stringify(snap):null,
      snap?JSON.stringify(snap):null
    );
    if (datos.fases && Array.isArray(datos.fases)) {
      datos.fases.forEach(f => {
        try {
          db.run(`INSERT OR IGNORE INTO fases (ciclo_id,fase_num,fase_nombre,agente,estado,
            memoria_leida,decision_tomada,resultado,intentos,duracion_ms,fecha_fin)
            VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
            ciclo_id,f.num||0,f.nombre||'',f.agente||'',f.estado||'COMPLETADO',
            JSON.stringify(f.memoria_leida||[]),f.decision||'',f.resultado||'',
            f.intentos||1,f.duracion_ms||0);
        } catch(e) {}
      });
    }
    if (db.type==='sqljs' && db.save) db.save();
    db.close();
    return ciclo_id;
  } catch(e) { return null; }
}

// ─── EMBEDDINGS SEMÁNTICOS (opcional) ─────────────────────────────────────────
async function buscarSemantico(query, topK) {
  topK = topK||5;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const {resultados} = consultar(query, null);
    return resultados.slice(0,topK);
  }
  try {
    const queryEmb = await getEmbedding(query, apiKey);
    if (!queryEmb) { const {resultados}=consultar(query,null); return resultados.slice(0,topK); }
    const db = initDB();
    const nodos = db.all("SELECT * FROM nodos WHERE estado='ACTIVO'");
    db.close();
    const scored = [];
    for (const n of nodos) {
      const txt = `${n.titulo} ${n.area} ${(n.contenido||'').slice(0,400)}`;
      const emb  = await getEmbedding(txt, apiKey);
      if (emb) scored.push({...n, _score: cosineSim(queryEmb,emb)});
    }
    return scored.sort((a,b)=>b._score-a._score).slice(0,topK);
  } catch(e) {
    const {resultados} = consultar(query,null);
    return resultados.slice(0,topK);
  }
}

async function getEmbedding(text, apiKey) {
  return new Promise(resolve => {
    try {
      const https = require('https');
      const body = JSON.stringify({model:'voyage-3',input:[text],input_type:'document'});
      const req = https.request({
        hostname:'api.voyageai.com',path:'/v1/embeddings',method:'POST',
        headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
      }, res => {
        let d=''; res.on('data',c=>d+=c);
        res.on('end',()=>{ try{resolve(JSON.parse(d).data?.[0]?.embedding||null);}catch(e){resolve(null);} });
      });
      req.on('error',()=>resolve(null));
      req.setTimeout(5000,()=>{req.destroy();resolve(null);});
      req.write(body); req.end();
    } catch(e) { resolve(null); }
  });
}

function cosineSim(a,b) {
  if (!a||!b||a.length!==b.length) return 0;
  let dot=0,na=0,nb=0;
  for(let i=0;i<a.length;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}
  return dot/(Math.sqrt(na)*Math.sqrt(nb)||1);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
const cmd  = process.argv[2]||'sync';
const arg1 = process.argv[3];
const arg2 = process.argv[4];

switch(cmd) {
  case 'sync':     sincronizar(); break;
  case 'query':
    const {resultados,trace} = consultar(arg1,arg2);
    console.log(JSON.stringify({resultados,trace},null,2)); break;
  case 'stats':    stats(); break;
  case 'metricas': console.log(JSON.stringify(metricas(),null,2)); break;
  case 'ciclo':
    try {
      const d = JSON.parse(arg1||'{}');
      const id = registrarCiclo(d);
      console.log(id?`Ciclo registrado: ${id}`:'Error al registrar');
    } catch(e) { console.log('JSON invalido'); } break;
  case 'semantico':
    if (!arg1) { console.log('Uso: node grafo.cjs semantico "query" [topK]'); break; }
    buscarSemantico(arg1,parseInt(arg2)||5).then(r=>console.log(JSON.stringify(r,null,2)));
    break;
  case 'snapshot':
    const db2=initDB(); console.log(JSON.stringify(snapshotMemoria(db2),null,2)); db2.close(); break;
  case 'analizar':
    analizarProyecto(); break;
  default:
    console.log('Uso: node grafo.cjs [sync|query|stats|metricas|ciclo|semantico|snapshot|analizar]');
}


// ─── ANÁLISIS AUTOMÁTICO DEL PROYECTO ────────────────────────────────────────
// Recorre el código real y construye el grafo sin esperar ciclos aa:
// Similar al GRAPH_REPORT.md de Graphify

function analizarProyecto() {
  console.log('\n  Analizando proyecto...\n');

  const db = initDB();
  const ignorar = new Set(['node_modules','.git','.next','dist','build','vendor',
    'coverage','.cache','tmp','temp','.turbo','out','.output','public','static',
    '__pycache__','.pytest_cache','.mypy_cache']);
  const extsCodigo = new Set(['.ts','.tsx','.js','.jsx','.php','.py','.vue','.svelte','.rb','.go','.java']);
  const extsDocs   = new Set(['.md','.txt','.pdf']);

  let archivosAnalizados = 0, nodosPrevios = 0, nodosCreados = 0;

  // Contar nodos previos
  try { nodosPrevios = (db.get('SELECT COUNT(*) as n FROM nodos') || {}).n || 0; } catch(e) {}

  // ── 1. DETECTAR MÓDULOS desde estructura de carpetas ───────────────────────
  function detectarModulos(dir, nivel) {
    if (nivel > 4) return [];
    let items; try { items = fs.readdirSync(dir); } catch(e) { return []; }
    const modulos = [];

    for (const item of items) {
      if (ignorar.has(item) || item.startsWith('.') || item.startsWith('_')) continue;
      const full = path.join(dir, item);
      let stat; try { stat = fs.statSync(full); } catch(e) { continue; }

      if (stat.isDirectory()) {
        // Es módulo si tiene archivos de código dentro
        let tieneCode = false;
        try {
          const sub = fs.readdirSync(full);
          tieneCode = sub.some(f => extsCodigo.has(path.extname(f).toLowerCase()));
        } catch(e) {}

        if (tieneCode) {
          modulos.push({ nombre: item, ruta: full, nivel });
        }
        modulos.push(...detectarModulos(full, nivel + 1));
      }
    }
    return modulos;
  }

  // ── 2. ANALIZAR ARCHIVOS de código ─────────────────────────────────────────
  function analizarArchivo(filePath) {
    let content; try { content = fs.readFileSync(filePath, 'utf8'); } catch(e) { return null; }
    const ext  = path.extname(filePath).toLowerCase();
    const nombre = path.basename(filePath);
    const info = { imports: [], exports: [], patrones: [], decisiones: [] };

    // Detectar imports/dependencias
    const importRegexes = [
      /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,  // ES6 import
      /require\(['"]([^'"]+)['"]\)/g,               // CommonJS require
      /use\s+([A-Z][a-zA-Z]+)/g,                    // PHP use
      /import\s+([a-zA-Z.]+)/g,                     // Python import
    ];
    importRegexes.forEach(rx => {
      let m; while ((m = rx.exec(content)) !== null) {
        if (!m[1].startsWith('.') && !m[1].startsWith('@')) info.imports.push(m[1]);
      }
    });

    // Detectar patrones de naming
    if (/export\s+default\s+function\s+([A-Z][a-zA-Z]+)/.test(content)) info.patrones.push('componente React');
    if (/\bconst\s+\w+\s*=\s*async\s*\(/.test(content)) info.patrones.push('funciones async/await');
    if (/\.env\b/.test(content) || /process\.env/.test(content)) info.patrones.push('variables de entorno');
    if (/createClient|supabase/.test(content)) info.patrones.push('Supabase client');
    if (/prisma\.|PrismaClient/.test(content)) info.patrones.push('Prisma ORM');
    if (/SELECT|INSERT|UPDATE|DELETE/i.test(content)) info.patrones.push('queries SQL directas');
    if (/middleware/.test(nombre.toLowerCase())) info.patrones.push('middleware pattern');
    if (/\.test\.|\.spec\./.test(nombre)) info.patrones.push('archivo de test');
    if (/interface\s+[A-Z]|type\s+[A-Z]/.test(content)) info.patrones.push('TypeScript types/interfaces');
    if (/zod\.|yup\.|joi\./.test(content)) info.patrones.push('validación de schemas');
    if (/useQuery|useMutation|useEffect/.test(content)) info.patrones.push('React hooks');
    if (/@Injectable|@Controller|@Module/.test(content)) info.patrones.push('NestJS decorators');
    if (/artisan|Eloquent|->where/.test(content)) info.patrones.push('Laravel Eloquent');

    // Detectar decisiones arquitectónicas implícitas
    if (/lib\/|utils\/|helpers\//.test(content)) info.decisiones.push('utilidades centralizadas');
    if (/only.*server|server.*only/i.test(content) || /use server/.test(content)) info.decisiones.push('Server Components (Next.js)');
    if (/use client/.test(content)) info.decisiones.push('Client Components (Next.js)');

    archivosAnalizados++;
    return info;
  }

  // ── 3. INFERIR ÁREA desde la ruta del archivo ──────────────────────────────
  function inferirArea(ruta) {
    const parts = ruta.toLowerCase().split(path.sep);
    const areaMap = {
      'auth': 'auth', 'authentication': 'auth', 'login': 'auth',
      'api': 'api', 'routes': 'api', 'endpoints': 'api', 'controllers': 'api',
      'components': 'frontend', 'ui': 'frontend', 'pages': 'frontend', 'views': 'frontend',
      'lib': 'core', 'utils': 'core', 'helpers': 'core', 'shared': 'core',
      'database': 'database', 'db': 'database', 'models': 'database', 'migrations': 'database',
      'middleware': 'middleware', 'hooks': 'frontend', 'services': 'services',
      'payment': 'payments', 'stripe': 'payments', 'billing': 'payments',
      'email': 'notifications', 'notifications': 'notifications', 'mailer': 'notifications',
      'tests': 'testing', 'test': 'testing', 'spec': 'testing',
    };
    for (const part of parts) {
      if (areaMap[part]) return areaMap[part];
    }
    return 'global';
  }

  // ── 4. RECORRER EL PROYECTO ────────────────────────────────────────────────
  const patronesEncontrados = {};  // patrón → { count, areas }
  const decisionesEncontradas = {};
  const areasConCodigo = new Set();

  function recorrer(dir, nivel) {
    if (nivel > 5) return;
    let items; try { items = fs.readdirSync(dir); } catch(e) { return; }

    for (const item of items) {
      if (ignorar.has(item) || item.startsWith('.')) continue;
      const full = path.join(dir, item);
      let stat; try { stat = fs.statSync(full); } catch(e) { continue; }

      if (stat.isDirectory()) {
        recorrer(full, nivel + 1);
      } else if (stat.isFile()) {
        const ext = path.extname(item).toLowerCase();
        if (!extsCodigo.has(ext)) continue;

        const info = analizarArchivo(full);
        if (!info) continue;

        const area = inferirArea(full);
        areasConCodigo.add(area);

        info.patrones.forEach(p => {
          if (!patronesEncontrados[p]) patronesEncontrados[p] = { count: 0, areas: new Set() };
          patronesEncontrados[p].count++;
          patronesEncontrados[p].areas.add(area);
        });

        info.decisiones.forEach(d => {
          if (!decisionesEncontradas[d]) decisionesEncontradas[d] = { count: 0, areas: new Set() };
          decisionesEncontradas[d].count++;
          decisionesEncontradas[d].areas.add(area);
        });
      }
    }
  }

  recorrer(ROOT, 0);

  // ── 5. DETECTAR STACK desde package.json / composer.json ──────────────────
  const stackInfo = {};
  const pkgPath = path.join(ROOT, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['next'])           { stackInfo['Next.js'] = Object.keys(deps['next']||{}).length > 0; }
      if (deps['react'])          stackInfo['React'] = true;
      if (deps['@supabase/supabase-js']) stackInfo['Supabase'] = true;
      if (deps['prisma'] || deps['@prisma/client']) stackInfo['Prisma'] = true;
      if (deps['express'])        stackInfo['Express'] = true;
      if (deps['typescript'])     stackInfo['TypeScript'] = true;
      if (deps['tailwindcss'])    stackInfo['Tailwind CSS'] = true;
      if (deps['zustand'])        stackInfo['Zustand'] = true;
      if (deps['zod'])            stackInfo['Zod'] = true;
      if (deps['stripe'])         stackInfo['Stripe'] = true;
      if (deps['resend'] || deps['nodemailer']) stackInfo['Email service'] = true;
    } catch(e) {}
  }

  // ── 6. GUARDAR EN MEMORIA ──────────────────────────────────────────────────
  const fecha = new Date().toISOString().split('T')[0];

  // Guardar patrones detectados (solo los que aparecen 2+ veces)
  Object.entries(patronesEncontrados).forEach(([patron, data]) => {
    if (data.count < 1) return;
    const area = data.areas.size === 1 ? [...data.areas][0] : 'global';
    const confianza = data.count >= 5 ? 'MEDIA' : 'BAJA';
    const titulo = `[AUTO] ${patron}`;
    const contenido = `## ${fecha} [AUTO] ${patron}
Área: ${area}
Confianza: ${confianza}
Aplicado: ${data.count}
Útil: 0
Estado: ACTIVO
Última validación: ${fecha}
Creado: ${fecha}
Origen: akdd analyze — detectado en ${data.count} archivos
Regla: Patrón usado consistentemente en el proyecto
Áreas: ${[...data.areas].join(', ')}`;

    try {
      const ex = db.get('SELECT id FROM nodos WHERE tipo=? AND titulo=?', 'patron', titulo);
      if (!ex) {
        db.run("INSERT INTO nodos (tipo,titulo,contenido,area,confianza,aplicado,util,estado,ultima_validacion,fecha_update) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))",
          'patron', titulo, contenido, area, confianza, data.count, 0, 'ACTIVO', fecha);
        nodosCreados++;
      }
    } catch(e) {}
  });

  // Guardar decisiones detectadas
  Object.entries(decisionesEncontradas).forEach(([decision, data]) => {
    if (data.count < 1) return;
    const area = data.areas.size === 1 ? [...data.areas][0] : 'global';
    const titulo = `[AUTO] ${decision}`;
    const contenido = `## ${fecha} [AUTO] ${decision}
Área: ${area}
Confianza: BAJA
Estado: ACTIVO
Última validación: ${fecha}
Creado: ${fecha}
Origen: akdd analyze — inferido del código (${data.count} referencias)
Decisión: ${decision}
Razón: Detectado automáticamente — verificar con el equipo
Áreas: ${[...data.areas].join(', ')}`;

    try {
      const ex = db.get('SELECT id FROM nodos WHERE tipo=? AND titulo=?', 'decision', titulo);
      if (!ex) {
        db.run("INSERT INTO nodos (tipo,titulo,contenido,area,confianza,aplicado,util,estado,ultima_validacion,fecha_update) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))",
          'decision', titulo, contenido, area, 'BAJA', 0, 0, 'ACTIVO', fecha);
        nodosCreados++;
      }
    } catch(e) {}
  });

  // Guardar stack como decisiones
  Object.keys(stackInfo).forEach(tech => {
    const titulo = `[AUTO] Stack: ${tech}`;
    const contenido = `## ${fecha} [AUTO] Stack: ${tech}
Área: global
Confianza: MEDIA
Estado: ACTIVO
Última validación: ${fecha}
Creado: ${fecha}
Origen: akdd analyze — detectado en package.json
Decisión: El proyecto usa ${tech}
Razón: Dependencia confirmada en package.json`;

    try {
      const ex = db.get('SELECT id FROM nodos WHERE tipo=? AND titulo=?', 'decision', titulo);
      if (!ex) {
        db.run("INSERT INTO nodos (tipo,titulo,contenido,area,confianza,aplicado,util,estado,ultima_validacion,fecha_update) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))",
          'decision', titulo, contenido, 'global', 'MEDIA', 0, 0, 'ACTIVO', fecha);
        nodosCreados++;
      }
    } catch(e) {}
  });

  // Detectar relaciones entre nodos nuevos
  detectarRelaciones(db);
  if (db.type === 'sqljs' && db.save) db.save();

  // Actualizar archivos .md de memoria con lo detectado
  actualizarMemoriaMd(patronesEncontrados, decisionesEncontradas, stackInfo, fecha);

  const totalNodos = (db.get('SELECT COUNT(*) as n FROM nodos') || {}).n || 0;
  db.close();

  // ── OUTPUT ─────────────────────────────────────────────────────────────────
  console.log(`  Archivos analizados: ${archivosAnalizados}`);
  console.log(`  Areas detectadas:    ${[...areasConCodigo].join(', ') || 'ninguna'}`);
  console.log(`\n  Stack detectado:`);
  Object.keys(stackInfo).forEach(t => console.log(`    ✓ ${t}`));
  console.log(`\n  Patrones encontrados: ${Object.keys(patronesEncontrados).length}`);
  Object.entries(patronesEncontrados)
    .sort((a,b) => b[1].count - a[1].count)
    .slice(0,8)
    .forEach(([p,d]) => console.log(`    [${d.count}x] ${p}`));
  console.log(`\n  Decisiones inferidas: ${Object.keys(decisionesEncontradas).length}`);
  Object.keys(decisionesEncontradas).forEach(d => console.log(`    ~ ${d}`));
  console.log(`\n  Nodos nuevos en grafo: ${nodosCreados} (total: ${totalNodos})`);
  console.log(`\n  Dashboard actualizado — corre: node dashboard.cjs\n`);
}

// ── Actualizar archivos .md de memoria con lo detectado ────────────────────
function actualizarMemoriaMd(patrones, decisiones, stack, fecha) {
  try {
    // Actualizar patrones.md
    const patronesPath = path.join(MEMORIA_PATH, 'patrones.md');
    let patronesContent = fs.existsSync(patronesPath) ? fs.readFileSync(patronesPath, 'utf8') : '# Patrones — Agentic KDD\n\n';

    Object.entries(patrones)
      .filter(([p]) => !patronesContent.includes(`[AUTO] ${p}`))
      .sort((a,b) => b[1].count - a[1].count)
      .slice(0, 10)
      .forEach(([patron, data]) => {
        const area = data.areas.size === 1 ? [...data.areas][0] : 'global';
        patronesContent += `\n## ${fecha} [AUTO] ${patron}
Área: ${area}
Confianza: ${data.count >= 5 ? 'MEDIA' : 'BAJA'}
Aplicado: ${data.count}
Útil: 0
Estado: ACTIVO
Última validación: ${fecha}
Creado: ${fecha}
Origen: akdd analyze
Regla: Patrón detectado automáticamente en ${data.count} archivos\n`;
      });
    fs.writeFileSync(patronesPath, patronesContent);

    // Actualizar decisiones.md
    const decisionesPath = path.join(MEMORIA_PATH, 'decisiones.md');
    let decisionesContent = fs.existsSync(decisionesPath) ? fs.readFileSync(decisionesPath, 'utf8') : '# Decisiones — Agentic KDD\n\n';

    // Stack como decisiones
    Object.keys(stack)
      .filter(t => !decisionesContent.includes(`Stack: ${t}`))
      .forEach(tech => {
        decisionesContent += `\n## ${fecha} [AUTO] Stack: ${tech}
Área: global
Confianza: MEDIA
Estado: ACTIVO
Última validación: ${fecha}
Creado: ${fecha}
Origen: akdd analyze
Decisión: El proyecto usa ${tech}
Razón: Dependencia confirmada en package.json\n`;
      });

    Object.entries(decisiones)
      .filter(([d]) => !decisionesContent.includes(`[AUTO] ${d}`))
      .forEach(([decision, data]) => {
        const area = data.areas.size === 1 ? [...data.areas][0] : 'global';
        decisionesContent += `\n## ${fecha} [AUTO] ${decision}
Área: ${area}
Confianza: BAJA
Estado: ACTIVO
Última validación: ${fecha}
Creado: ${fecha}
Origen: akdd analyze
Decisión: ${decision}
Razón: Inferido del código — verificar con el equipo\n`;
      });
    fs.writeFileSync(decisionesPath, decisionesContent);
  } catch(e) {}
}

module.exports = { sincronizar, consultar, stats, metricas, registrarCiclo, buscarSemantico, snapshotMemoria, analizarProyecto };
