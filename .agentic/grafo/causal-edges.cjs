/**
 * Agentic KDD — Causal Edges v1.0
 * Gestión de edges causales y bi-temporales en el grafo semántico.
 *
 * TIPOS DE EDGE CAUSAL:
 *   caused_failure     — "tocar A provocó que B fallara"
 *   was_fixed_by       — "el fallo en B fue resuelto haciendo X"
 *   tested_by          — "A es cubierto por el test B"
 *   regressed_by       — "el cambio C introdujo una regresión en D"
 *   depends_on_decision — "la implementación E depende de la decisión ADR-001"
 *
 * EDGES BI-TEMPORALES:
 *   Cada edge tiene valid_at / invalid_at para "olvidar inteligente sin drift"
 *   Inspirado en Zep/Graphiti (arXiv 2501.13956)
 *
 * Uso:
 *   node .agentic/grafo/causal-edges.cjs add caused_failure src/auth.ts src/session.ts
 *   node .agentic/grafo/causal-edges.cjs query caused_failure
 *   node .agentic/grafo/causal-edges.cjs invalidate <id>
 *   node .agentic/grafo/causal-edges.cjs history src/auth.ts
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const CAUSAL_TYPES = new Set([
  'caused_failure',
  'was_fixed_by',
  'tested_by',
  'regressed_by',
  'depends_on_decision',
  // Tipos estructurales existentes (compatibilidad)
  'depende_de', 'importa', 'usa', 'extiende', 'llama', 'define',
]);

// ─── DB HELPER ────────────────────────────────────────────────────────────────

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  throw new Error('No SQLite driver disponible');
}

// ─── MIGRACIÓN BI-TEMPORAL ────────────────────────────────────────────────────

/**
 * Agrega columnas bi-temporales a relaciones_semanticas si no existen.
 * Safe de correr múltiples veces.
 */
function migrateRelacionesBiTemporal(db) {
  const cols = db.prepare("PRAGMA table_info(relaciones_semanticas)").all().map(c => c.name);

  const migrations = [
    { col: 'valid_at',    sql: "ALTER TABLE relaciones_semanticas ADD COLUMN valid_at TEXT DEFAULT (datetime('now'))" },
    { col: 'invalid_at',  sql: "ALTER TABLE relaciones_semanticas ADD COLUMN invalid_at TEXT" },
    { col: 'expired_at',  sql: "ALTER TABLE relaciones_semanticas ADD COLUMN expired_at TEXT" },
    { col: 'episode_id',  sql: "ALTER TABLE relaciones_semanticas ADD COLUMN episode_id TEXT" },
    { col: 'confidence',  sql: "ALTER TABLE relaciones_semanticas ADD COLUMN confidence TEXT DEFAULT 'MEDIA'" },
    { col: 'context',     sql: "ALTER TABLE relaciones_semanticas ADD COLUMN context TEXT" },
    { col: 'source',      sql: "ALTER TABLE relaciones_semanticas ADD COLUMN source TEXT DEFAULT 'agent'" },
  ];

  let migrated = 0;
  for (const m of migrations) {
    if (!cols.includes(m.col)) {
      try { db.exec(m.sql); migrated++; } catch (e) {
        if (!e.message.includes('duplicate column')) throw e;
      }
    }
  }

  // Crear índices para bi-temporalidad
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rel_sem_valid ON relaciones_semanticas(valid_at);
      CREATE INDEX IF NOT EXISTS idx_rel_sem_invalid ON relaciones_semanticas(invalid_at);
      CREATE INDEX IF NOT EXISTS idx_rel_sem_type ON relaciones_semanticas(tipo);
    `);
  } catch {}

  return migrated;
}

// ─── CREAR EDGE CAUSAL ────────────────────────────────────────────────────────

/**
 * Registra un edge causal en el grafo semántico.
 *
 * @param {object} db
 * @param {object} opts
 *   desde_entidad: string — entidad origen (archivo, módulo, símbolo)
 *   tipo: string — uno de CAUSAL_TYPES
 *   hacia_entidad: string — entidad destino
 *   peso: number (default 1.0)
 *   descripcion: string — por qué existe este edge
 *   episode_id: string — FK al episodio origen
 *   confidence: string — BAJA | MEDIA | ALTA
 *   context: string — contexto adicional
 * @returns {object} el edge creado
 */
function addCausalEdge(db, opts) {
  const {
    desde_entidad,
    tipo,
    hacia_entidad,
    peso = 1.0,
    descripcion = '',
    episode_id = null,
    confidence = 'MEDIA',
    context = null,
  } = opts;

  if (!CAUSAL_TYPES.has(tipo)) {
    throw new Error(`Tipo de edge no válido: '${tipo}'. Válidos: ${[...CAUSAL_TYPES].join(', ')}`);
  }

  // Si ya existe un edge activo del mismo tipo, invalidar el anterior (bi-temporalidad)
  try {
    const existing = db.prepare(`
      SELECT id FROM relaciones_semanticas
      WHERE desde_entidad = ? AND tipo = ? AND hacia_entidad = ?
        AND (invalid_at IS NULL OR invalid_at = '')
    `).get(desde_entidad, tipo, hacia_entidad);

    if (existing) {
      db.prepare(`
        UPDATE relaciones_semanticas
        SET invalid_at = datetime('now'), expired_at = datetime('now')
        WHERE id = ?
      `).run(existing.id);
    }
  } catch {}

  // Insertar nuevo edge
  let result;
  try {
    result = db.prepare(`
      INSERT INTO relaciones_semanticas
        (desde_entidad, tipo, hacia_entidad, peso, descripcion,
         valid_at, episode_id, confidence, context, source)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, 'agent')
    `).run(desde_entidad, tipo, hacia_entidad, peso, descripcion, episode_id, confidence, context);
  } catch (e) {
    // Si no existen columnas bi-temporales, insertar sin ellas
    result = db.prepare(`
      INSERT OR REPLACE INTO relaciones_semanticas
        (desde_entidad, tipo, hacia_entidad, peso, descripcion)
      VALUES (?, ?, ?, ?, ?)
    `).run(desde_entidad, tipo, hacia_entidad, peso, descripcion);
  }

  return {
    id: result.lastInsertRowid,
    desde_entidad, tipo, hacia_entidad, peso, descripcion, confidence,
  };
}

// ─── INVALIDAR EDGE (olvidar inteligente) ────────────────────────────────────

/**
 * Invalida un edge sin borrarlo — preserva el historial (modelo Graphiti).
 * El edge invalidado ya no aparece en queries sin --history.
 */
function invalidateEdge(db, edgeId, reason = '') {
  try {
    db.prepare(`
      UPDATE relaciones_semanticas
      SET invalid_at = datetime('now'),
          expired_at = datetime('now'),
          context = COALESCE(context, '') || ' | Invalidado: ' || ?
      WHERE id = ?
    `).run(reason, edgeId);
    return true;
  } catch {
    return false;
  }
}

// ─── QUERY EDGES CAUSALES ────────────────────────────────────────────────────

/**
 * Obtiene edges causales activos (sin invalid_at) de una entidad.
 */
function queryCausalEdges(db, opts = {}) {
  const { tipo = null, entidad = null, includeHistory = false, limit = 50 } = opts;

  let query = `
    SELECT id, desde_entidad, tipo, hacia_entidad, peso, descripcion,
           valid_at, invalid_at, confidence, context, episode_id
    FROM relaciones_semanticas
    WHERE 1=1
  `;
  const params = [];

  if (!includeHistory) {
    query += " AND (invalid_at IS NULL OR invalid_at = '')";
  }

  if (tipo) {
    query += ' AND tipo = ?';
    params.push(tipo);
  }

  if (entidad) {
    query += ' AND (desde_entidad LIKE ? OR hacia_entidad LIKE ?)';
    params.push(`%${entidad}%`, `%${entidad}%`);
  }

  // Solo tipos causales si no se especifica tipo
  if (!tipo) {
    const causalList = ['caused_failure', 'was_fixed_by', 'tested_by', 'regressed_by', 'depends_on_decision'];
    query += ` AND tipo IN (${causalList.map(() => '?').join(',')})`;
    params.push(...causalList);
  }

  query += ` ORDER BY valid_at DESC LIMIT ${limit}`;

  try {
    return db.prepare(query).all(...params);
  } catch {
    return [];
  }
}

// ─── HISTORIAL DE UNA ENTIDAD ────────────────────────────────────────────────

/**
 * Retorna el historial bi-temporal completo de una entidad.
 * Incluye todos los edges pasados y presentes, con timestamps.
 */
function getEntityHistory(db, entidad) {
  try {
    return db.prepare(`
      SELECT id, desde_entidad, tipo, hacia_entidad, peso, descripcion,
             valid_at, invalid_at, expired_at, confidence, context, episode_id
      FROM relaciones_semanticas
      WHERE desde_entidad LIKE ? OR hacia_entidad LIKE ?
      ORDER BY valid_at DESC
    `).all(`%${entidad}%`, `%${entidad}%`);
  } catch { return []; }
}

// ─── POINT-IN-TIME QUERY ─────────────────────────────────────────────────────

/**
 * "¿Qué sabíamos sobre X en la fecha Y?"
 * Retorna edges que eran vigentes en ese momento.
 */
function getEdgesAtTime(db, entidad, timestamp) {
  try {
    return db.prepare(`
      SELECT id, desde_entidad, tipo, hacia_entidad, descripcion, confidence
      FROM relaciones_semanticas
      WHERE (desde_entidad LIKE ? OR hacia_entidad LIKE ?)
        AND valid_at <= ?
        AND (invalid_at IS NULL OR invalid_at > ?)
      ORDER BY valid_at DESC
    `).all(`%${entidad}%`, `%${entidad}%`, timestamp, timestamp);
  } catch { return []; }
}

// ─── EXTRAER CAUSALES DE EPISODIO ─────────────────────────────────────────────

/**
 * Dada la info de un episodio de error + fix, extrae automáticamente
 * los edges causales implícitos.
 *
 * @param {object} episodio
 *   tipo: 'error' | 'fix'
 *   descripcion: string
 *   archivos_tocados: string[] (JSON)
 *   resultado: 'resuelto' | 'fallo' | ...
 *   accion_tomada: string
 * @returns {Array<object>} edges causales sugeridos
 */
function extractCausalsFromEpisode(episodio) {
  const suggested = [];
  const archivos = JSON.parse(episodio.archivos_tocados || '[]');

  if (episodio.tipo === 'error' && episodio.resultado === 'resuelto') {
    // El episodio documenta un error que se resolvió
    // Inferir: el archivo tocado "caused_failure" en el módulo afectado
    for (const file of archivos) {
      if (episodio.descripcion) {
        suggested.push({
          desde_entidad: file,
          tipo: 'caused_failure',
          hacia_entidad: episodio.modulo || episodio.area || 'unknown',
          descripcion: episodio.descripcion.substring(0, 200),
          episode_id: episodio.episodio_id,
          confidence: 'MEDIA',
        });
      }
      if (episodio.accion_tomada) {
        suggested.push({
          desde_entidad: file,
          tipo: 'was_fixed_by',
          hacia_entidad: episodio.accion_tomada.substring(0, 100),
          descripcion: episodio.razon_resultado || '',
          episode_id: episodio.episodio_id,
          confidence: 'MEDIA',
        });
      }
    }
  }

  if (episodio.tipo === 'fix') {
    for (const file of archivos) {
      suggested.push({
        desde_entidad: file,
        tipo: 'was_fixed_by',
        hacia_entidad: episodio.accion_tomada?.substring(0, 100) || 'fix-applied',
        descripcion: episodio.descripcion?.substring(0, 200) || '',
        episode_id: episodio.episodio_id,
        confidence: 'ALTA',
      });
    }
  }

  return suggested;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();
  const db = openDB(projectRoot);

  // Migrar a bi-temporal si necesario
  const migrated = migrateRelacionesBiTemporal(db);
  if (migrated > 0) console.log(`[CAUSAL] Migradas ${migrated} columnas bi-temporales`);

  switch (cmd) {
    case 'add': {
      // add <tipo> <desde> <hacia> [descripcion]
      const [tipo, desde, hacia, ...descParts] = args;
      if (!tipo || !desde || !hacia) {
        console.error('Uso: causal-edges.cjs add <tipo> <desde> <hacia> [descripción]');
        process.exit(1);
      }
      try {
        const edge = addCausalEdge(db, { desde_entidad: desde, tipo, hacia_entidad: hacia, descripcion: descParts.join(' ') });
        console.log(`✅ Edge causal creado: [${edge.id}] ${desde} --${tipo}--> ${hacia}`);
      } catch (e) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
      break;
    }
    case 'query': {
      const [tipo, entidad] = args;
      const edges = queryCausalEdges(db, { tipo, entidad });
      console.log(`\nEdges causales (${edges.length}):\n`);
      edges.forEach(e => {
        const status = e.invalid_at ? '❌' : '✅';
        console.log(`  ${status} [${e.id}] ${e.desde_entidad} --${e.tipo}--> ${e.hacia_entidad}`);
        if (e.descripcion) console.log(`       ${e.descripcion}`);
      });
      break;
    }
    case 'history': {
      const [entidad] = args;
      if (!entidad) { console.error('Uso: causal-edges.cjs history <entidad>'); process.exit(1); }
      const history = getEntityHistory(db, entidad);
      console.log(`\nHistorial bi-temporal de '${entidad}' (${history.length} edges):\n`);
      history.forEach(e => {
        const status = e.invalid_at ? `[EXPIRADO ${e.invalid_at}]` : '[VIGENTE]';
        console.log(`  ${status} ${e.desde_entidad} --${e.tipo}--> ${e.hacia_entidad}`);
        console.log(`    valid_at: ${e.valid_at} | confidence: ${e.confidence || '-'}`);
      });
      break;
    }
    case 'invalidate': {
      const [id, ...reasonParts] = args;
      if (!id) { console.error('Uso: causal-edges.cjs invalidate <id> [razón]'); process.exit(1); }
      const ok = invalidateEdge(db, parseInt(id), reasonParts.join(' '));
      console.log(ok ? `✅ Edge ${id} invalidado (historial preservado)` : `Error invalidando edge ${id}`);
      break;
    }
    case 'migrate': {
      console.log(`Migración bi-temporal: ${migrated} columnas agregadas`);
      break;
    }
    default:
      console.log('Uso: node causal-edges.cjs [add | query | history | invalidate | migrate]');
  }
}

module.exports = {
  addCausalEdge,
  invalidateEdge,
  queryCausalEdges,
  getEntityHistory,
  getEdgesAtTime,
  extractCausalsFromEpisode,
  migrateRelacionesBiTemporal,
  CAUSAL_TYPES,
};
