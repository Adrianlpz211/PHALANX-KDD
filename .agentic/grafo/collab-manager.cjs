/**
 * Agentic KDD — Collab Manager v1.0 (Scaffold)
 * Modo colaborativo: varios devs comparten la misma memoria del agente.
 *
 * Backend: libSQL / Turso Sync
 *   - libSQL es un fork de SQLite con sync local↔remoto
 *   - Compatible con better-sqlite3 API
 *   - Sin Postgres ni infra pesada
 *
 * Alternativa P2P: sqlite-sync (CRDT, experimental)
 *
 * ESTADO: SCAFFOLD — requiere activación manual.
 * Activar en config.md: collab_mode: turso
 *
 * Setup (una vez por equipo):
 *   1. npm install @libsql/client
 *   2. Crear DB en Turso: turso db create agentic-kdd-[proyecto]
 *   3. Obtener URL y token: turso db tokens create agentic-kdd-[proyecto]
 *   4. Agregar a .env: TURSO_URL=... TURSO_TOKEN=...
 *   5. En config.md: collab_mode: turso
 *   6. node .agentic/grafo/collab-manager.cjs sync-up (primera sincronización)
 *
 * Uso:
 *   node .agentic/grafo/collab-manager.cjs status
 *   node .agentic/grafo/collab-manager.cjs sync-up    (local → remoto)
 *   node .agentic/grafo/collab-manager.cjs sync-down  (remoto → local)
 *   node .agentic/grafo/collab-manager.cjs enable
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────

function getCollabConfig(projectRoot) {
  const configPath = path.join(projectRoot, '.agentic/config.md');
  const envPath    = path.join(projectRoot, '.env');

  let collabMode = 'disabled';
  let tursoUrl = process.env.TURSO_URL || '';
  let tursoToken = process.env.TURSO_TOKEN || '';

  if (fs.existsSync(configPath)) {
    const config = fs.readFileSync(configPath, 'utf8');
    const modeMatch = config.match(/collab_mode:\s*(.+)/);
    if (modeMatch) collabMode = modeMatch[1].trim();
  }

  if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf8');
    const urlMatch = env.match(/TURSO_URL\s*=\s*(.+)/);
    const tokenMatch = env.match(/TURSO_TOKEN\s*=\s*(.+)/);
    if (urlMatch) tursoUrl = urlMatch[1].trim();
    if (tokenMatch) tursoToken = tokenMatch[1].trim();
  }

  return { collabMode, tursoUrl, tursoToken };
}

// ─── DRIVER libSQL ────────────────────────────────────────────────────────────

async function getLibSQLClient(config) {
  let createClient;
  try {
    ({ createClient } = require('@libsql/client'));
  } catch {
    throw new Error(
      'libSQL no instalado. Ejecutar: npm install @libsql/client\n' +
      'O con yarn: yarn add @libsql/client'
    );
  }

  if (!config.tursoUrl) {
    throw new Error('TURSO_URL no configurado. Ver docs en .agentic/grafo/collab-manager.cjs');
  }

  return createClient({
    url: config.tursoUrl,
    authToken: config.tursoToken || undefined,
  });
}

// ─── TABLAS A SINCRONIZAR ─────────────────────────────────────────────────────

// Solo se sincronizan las tablas de conocimiento (no working memory ni ciclos)
const SYNC_TABLES = [
  'nodos',            // patrones, errores, decisiones
  'relaciones',       // relaciones procedurales
  'relaciones_semanticas', // grafo semántico + causal edges
  'episodios',        // memoria episódica
  'entidades',        // mapa semántico
  'knowledge_docs',   // ADRs y gotchas
  'ast_symbols',      // grafo AST
  'ast_edges',        // edges AST
];

// ─── SYNC LOCAL → REMOTO ─────────────────────────────────────────────────────

async function syncUp(projectRoot) {
  const config = getCollabConfig(projectRoot);
  if (config.collabMode === 'disabled') {
    console.log('[COLLAB] Modo colaborativo desactivado. Activar en config.md: collab_mode: turso');
    return { synced: false };
  }

  console.log('[COLLAB] Sincronizando local → Turso...');

  const localDB = openLocalDB(projectRoot);
  let client;
  try {
    client = await getLibSQLClient(config);
  } catch (e) {
    console.error('[COLLAB] Error conectando a Turso:', e.message);
    return { synced: false, error: e.message };
  }

  let totalRows = 0;

  for (const table of SYNC_TABLES) {
    try {
      // Obtener rows con fecha_update reciente (últimas 24 horas)
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const rows = localDB.prepare(`
        SELECT * FROM ${table}
        WHERE fecha_update > ? OR fecha_creacion > ? OR last_indexed > ?
        LIMIT 1000
      `).all(cutoff, cutoff, cutoff);

      if (rows.length === 0) continue;

      console.log(`  ${table}: ${rows.length} rows a sincronizar`);

      // Upsert en remoto (libSQL soporta INSERT OR REPLACE)
      for (const row of rows) {
        const keys = Object.keys(row);
        const vals = Object.values(row);
        const placeholders = keys.map(() => '?').join(', ');
        try {
          await client.execute({
            sql: `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
            args: vals,
          });
          totalRows++;
        } catch {}
      }
    } catch (e) {
      // Tabla puede no existir en remoto — silenciar
    }
  }

  console.log(`[COLLAB] ✅ Sync-up completado: ${totalRows} rows enviados`);
  return { synced: true, rows: totalRows };
}

// ─── SYNC REMOTO → LOCAL ─────────────────────────────────────────────────────

async function syncDown(projectRoot) {
  const config = getCollabConfig(projectRoot);
  if (config.collabMode === 'disabled') {
    console.log('[COLLAB] Modo colaborativo desactivado.');
    return { synced: false };
  }

  console.log('[COLLAB] Sincronizando Turso → local...');

  const localDB = openLocalDB(projectRoot);
  let client;
  try {
    client = await getLibSQLClient(config);
  } catch (e) {
    console.error('[COLLAB] Error conectando:', e.message);
    return { synced: false, error: e.message };
  }

  let totalRows = 0;

  for (const table of SYNC_TABLES) {
    try {
      const rs = await client.execute(`SELECT * FROM ${table} LIMIT 10000`);
      if (!rs.rows?.length) continue;

      console.log(`  ${table}: ${rs.rows.length} rows recibidos`);

      for (const row of rs.rows) {
        const keys = Object.keys(row);
        const vals = keys.map(k => row[k]);
        const placeholders = keys.map(() => '?').join(', ');
        try {
          localDB.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`).run(vals);
          totalRows++;
        } catch {}
      }
    } catch {}
  }

  console.log(`[COLLAB] ✅ Sync-down completado: ${totalRows} rows recibidos`);
  return { synced: true, rows: totalRows };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function openLocalDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  throw new Error('No SQLite driver local disponible');
}

function enableCollabMode(projectRoot) {
  const configPath = path.join(projectRoot, '.agentic/config.md');
  if (!fs.existsSync(configPath)) {
    console.error('config.md no encontrado');
    return;
  }
  let content = fs.readFileSync(configPath, 'utf8');
  if (content.includes('collab_mode:')) {
    content = content.replace(/collab_mode:\s*.+/, 'collab_mode: turso');
  } else {
    content += '\n\n## Colaborativo\ncollab_mode: turso\n';
  }
  fs.writeFileSync(configPath, content);
  console.log('✅ collab_mode: turso activado en config.md');
  console.log('Próximo paso: configurar TURSO_URL y TURSO_TOKEN en .env');
}

// ─── STATUS ───────────────────────────────────────────────────────────────────

function status(projectRoot) {
  const config = getCollabConfig(projectRoot);
  console.log('\n[COLLAB] Estado del modo colaborativo:');
  console.log(`  Modo:       ${config.collabMode}`);
  console.log(`  Turso URL:  ${config.tursoUrl ? '✅ configurado' : '❌ no configurado (TURSO_URL)'}`);
  console.log(`  Turso Token: ${config.tursoToken ? '✅ configurado' : '⚠️  no configurado (opcional para DBs públicas)'}`);

  if (config.collabMode === 'disabled') {
    console.log('\nPara activar:');
    console.log('  1. npm install @libsql/client');
    console.log('  2. turso db create agentic-kdd-[proyecto]');
    console.log('  3. turso db tokens create agentic-kdd-[proyecto] → agregar a .env');
    console.log('  4. node .agentic/grafo/collab-manager.cjs enable');
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'status': status(projectRoot); break;
    case 'enable': enableCollabMode(projectRoot); break;
    case 'sync-up':
      syncUp(projectRoot).then(r => {
        process.exit(r.synced ? 0 : 1);
      }).catch(e => { console.error(e.message); process.exit(1); });
      break;
    case 'sync-down':
      syncDown(projectRoot).then(r => {
        process.exit(r.synced ? 0 : 1);
      }).catch(e => { console.error(e.message); process.exit(1); });
      break;
    default:
      console.log('Uso: node collab-manager.cjs [status | enable | sync-up | sync-down]');
  }
}

module.exports = { syncUp, syncDown, status, enableCollabMode, getCollabConfig, SYNC_TABLES };
