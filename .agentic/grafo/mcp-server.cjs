/**
 * Agentic KDD MCP Server — v2.0
 * Expone TODOS los módulos v3 como MCP tools nativos.
 *
 * Tools nuevas en v2.0:
 *   ast_impact       — analyzeImpact(target)
 *   ast_index        — indexProject()
 *   ast_symbols      — getSymbols(file)
 *   spec_waves       — getWaves(module)
 *   spec_status      — getStatus(module)
 *   spec_create      — createSpec(module, tipo)
 *   impact_precheck  — preCheck(module)
 *   impact_diff      — analyzeDiff(files[])
 *   knowledge_query  — queryKnowledge(module)
 *   adr_ingest       — ingestADRs(dir?)
 *   causal_add       — addCausalEdge(desde, tipo, hacia, descripcion)
 *   causal_query     — queryCausalEdges(tipo?, entidad?)
 *   decision_trail   — getCicloTrail(ciclo_id)
 *   decision_why     — whyExists(target)
 *   metrics_summary  — computeMetrics()
 *   health_check     — runHealthCheck()
 *   memory_audit     — generateAuditReport()
 *   memory_forget    — forgetMemory(id, razon)
 *
 * Transporte: stdio (compatible con Cursor, Claude Code, VS Code)
 *
 * Uso:
 *   node .agentic/grafo/mcp-server.cjs
 *   (registrar como MCP server en .cursor/mcp.json o claude_desktop_config.json)
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const readline = require('readline');

const ROOT = process.env.PROJECT_ROOT || process.cwd();

// ─── LAZY LOADERS ─────────────────────────────────────────────────────────────
// Carga cada módulo bajo demanda — el MCP server arranca sin cargar todo.

function loadModule(name) {
  const p = path.join(ROOT, '.agentic/grafo', name);
  if (fs.existsSync(p)) return require(p);
  throw new Error(`Módulo ${name} no encontrado en ${path.dirname(p)}`);
}

function getDB() {
  const dbPath = path.join(ROOT, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  throw new Error('No SQLite driver disponible');
}

// ─── DEFINICIÓN DE TOOLS ──────────────────────────────────────────────────────

const TOOLS = [
  // ── CORE (v1, ya existían) ────────────────────────────────────────────────
  {
    name: 'grafo_buscar',
    description: 'Búsqueda híbrida en las 4 capas de memoria CoALA (procedural + episódica + semántica). Retorna los items más relevantes para la tarea actual.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Descripción de la tarea o concepto a buscar' },
        area: { type: 'string', description: 'Área o módulo del proyecto (opcional)' },
        limit: { type: 'number', description: 'Máximo de resultados (default: 10)' },
      },
      required: ['query'],
    },
    handler: async ({ query, area, limit = 10 }) => {
      const g = loadModule('grafo.cjs');
      const r = g.buscarHibrido ? g.buscarHibrido(query, area, limit) : [];
      return { resultados: r };
    },
  },
  {
    name: 'registrar_episodio',
    description: 'Registra un episodio crudo en memoria episódica. Usar al final de cada ciclo para preservar lo que ocurrió.',
    inputSchema: {
      type: 'object',
      properties: {
        episodio: { type: 'object', description: 'Objeto episodio con: tipo, descripcion, resultado, archivos_tocados, area' },
      },
      required: ['episodio'],
    },
    handler: async ({ episodio }) => {
      const g = loadModule('grafo.cjs');
      const id = g.registrarEpisodio ? g.registrarEpisodio(episodio) : null;
      return { episodio_id: id };
    },
  },
  {
    name: 'grafo_sync',
    description: 'Sincroniza la memoria markdown (.md) con el grafo SQLite. Ejecutar al final de cada ciclo.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const g = loadModule('grafo.cjs');
      const r = g.sincronizar ? g.sincronizar() : { ok: false };
      return r;
    },
  },
  {
    name: 'grafo_coala',
    description: 'Stats completo de las 4 capas CoALA de memoria del proyecto.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const g = loadModule('grafo.cjs');
      if (g.statsCoala) g.statsCoala();
      return { ok: true };
    },
  },

  // ── AST (v2 nuevo) ────────────────────────────────────────────────────────
  {
    name: 'ast_impact',
    description: 'Analiza el impacto de tocar un archivo o módulo. Retorna dependencias directas, indirectas, historial causal y severidad ALTO/MEDIO/BAJO.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Ruta relativa del archivo o nombre del módulo' },
      },
      required: ['target'],
    },
    handler: async ({ target }) => {
      const m = loadModule('impact-analyzer.cjs');
      const db = getDB();
      return m.analyzeImpact(db, target);
    },
  },
  {
    name: 'ast_index',
    description: 'Indexa el proyecto en el grafo AST. Extrae símbolos, imports, call graph y calcula PageRank. Ejecutar una vez por sesión o cuando cambien muchos archivos.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Subdirectorio a indexar (opcional, default: proyecto completo)' },
      },
      required: [],
    },
    handler: async ({ dir }) => {
      const m = loadModule('ast-indexer.cjs');
      return m.indexProject(ROOT, dir);
    },
  },
  {
    name: 'ast_symbols',
    description: 'Retorna todos los símbolos (funciones, clases, exports) de un archivo específico.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Ruta relativa del archivo' },
      },
      required: ['file'],
    },
    handler: async ({ file }) => {
      const db = getDB();
      try {
        const symbols = db.prepare('SELECT symbol_name, kind, line_start, exported, pagerank FROM ast_symbols WHERE file = ? ORDER BY line_start').all(file);
        return { file, symbols };
      } catch { return { file, symbols: [], error: 'AST no indexado' }; }
    },
  },

  // ── IMPACT (v2 nuevo) ─────────────────────────────────────────────────────
  {
    name: 'impact_precheck',
    description: 'Pre-check de impacto para un módulo. Combina AST + causal + knowledge. Usar ANTES de planificar cualquier cambio.',
    inputSchema: {
      type: 'object',
      properties: {
        modulo: { type: 'string', description: 'Nombre del módulo o ruta del archivo' },
      },
      required: ['modulo'],
    },
    handler: async ({ modulo }) => {
      const m = loadModule('impact-analyzer.cjs');
      return m.preCheck(ROOT, modulo);
    },
  },
  {
    name: 'impact_diff',
    description: 'Analiza el impacto combinado de un conjunto de archivos que se van a modificar. Retorna severidad máxima y recomendaciones.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Array de rutas relativas de archivos a modificar' },
      },
      required: ['files'],
    },
    handler: async ({ files }) => {
      const m = loadModule('impact-analyzer.cjs');
      const db = getDB();
      return m.analyzeDiff(db, files);
    },
  },

  // ── SPECS (v2 nuevo) ──────────────────────────────────────────────────────
  {
    name: 'spec_waves',
    description: 'Retorna las waves de ejecución de un módulo (wave 1 = tareas sin deps, wave 2 = deps de wave 1, etc.). Usar para saber exactamente qué ejecutar ahora.',
    inputSchema: {
      type: 'object',
      properties: {
        modulo: { type: 'string', description: 'Nombre del módulo' },
      },
      required: ['modulo'],
    },
    handler: async ({ modulo }) => {
      const m = loadModule('spec-manager.cjs');
      const specDir = path.join(ROOT, '.agentic/specs', modulo);
      const tasksPath = path.join(specDir, 'tasks.md');
      if (!fs.existsSync(tasksPath)) return { error: `spec '${modulo}' no tiene tasks.md` };
      const tasks = m.parseTasks(fs.readFileSync(tasksPath, 'utf8'));
      const { waves } = m.buildWaves(tasks);
      return { modulo, waves: waves.map((w, i) => ({ wave: i + 1, tasks: w })) };
    },
  },
  {
    name: 'spec_status',
    description: 'Estado actual de un spec: progreso, tareas completadas, bloqueadas, próxima wave.',
    inputSchema: {
      type: 'object',
      properties: {
        modulo: { type: 'string', description: 'Nombre del módulo' },
      },
      required: ['modulo'],
    },
    handler: async ({ modulo }) => {
      const m = loadModule('spec-manager.cjs');
      const specDir = path.join(ROOT, '.agentic/specs', modulo);
      return m.getSpecStatus(specDir) ?? { error: `spec '${modulo}' no encontrado` };
    },
  },
  {
    name: 'spec_create',
    description: 'Crea un spec nuevo para un módulo (feature o bugfix). Genera requirements.md + design.md + tasks.md con template.',
    inputSchema: {
      type: 'object',
      properties: {
        modulo: { type: 'string', description: 'Nombre del módulo' },
        tipo: { type: 'string', enum: ['feature', 'bugfix'], description: 'Tipo de spec (default: feature)' },
      },
      required: ['modulo'],
    },
    handler: async ({ modulo, tipo = 'feature' }) => {
      const m = loadModule('spec-manager.cjs');
      const dir = m.createSpecFromTemplate(ROOT, modulo, tipo);
      return { created: true, path: path.relative(ROOT, dir) };
    },
  },

  // ── KNOWLEDGE (v2 nuevo) ──────────────────────────────────────────────────
  {
    name: 'knowledge_query',
    description: 'Consulta la base de conocimiento (ADRs y gotchas) para un módulo. Retorna decisiones arquitectónicas y restricciones aplicables.',
    inputSchema: {
      type: 'object',
      properties: {
        modulo: { type: 'string', description: 'Módulo o área a consultar' },
        tipo: { type: 'string', description: 'Filtrar por tipo: adr | gotcha | convention (opcional)' },
      },
      required: [],
    },
    handler: async ({ modulo, tipo }) => {
      const m = loadModule('adr-ingestor.cjs');
      const db = getDB();
      return m.queryKnowledge(db, { modulo, tipo, status: 'accepted' });
    },
  },
  {
    name: 'adr_ingest',
    description: 'Ingesta ADRs del directorio docs/adr/ en el grafo de conocimiento.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Directorio de ADRs (default: docs/adr)' },
      },
      required: [],
    },
    handler: async ({ dir = 'docs/adr' }) => {
      const m = loadModule('adr-ingestor.cjs');
      return m.ingestDirectory(ROOT, dir);
    },
  },

  // ── CAUSAL EDGES (v2 nuevo) ───────────────────────────────────────────────
  {
    name: 'causal_add',
    description: 'Registra un edge causal en memoria. Tipos: caused_failure, was_fixed_by, tested_by, regressed_by.',
    inputSchema: {
      type: 'object',
      properties: {
        desde: { type: 'string', description: 'Entidad origen (archivo o módulo)' },
        tipo: { type: 'string', enum: ['caused_failure','was_fixed_by','tested_by','regressed_by','depends_on_decision'] },
        hacia: { type: 'string', description: 'Entidad destino' },
        descripcion: { type: 'string', description: 'Descripción del edge' },
        confidence: { type: 'string', enum: ['BAJA','MEDIA','ALTA'], description: 'Confianza del edge' },
      },
      required: ['desde', 'tipo', 'hacia'],
    },
    handler: async ({ desde, tipo, hacia, descripcion = '', confidence = 'MEDIA' }) => {
      const m = loadModule('causal-edges.cjs');
      const db = getDB();
      return m.addCausalEdge(db, { desde_entidad: desde, tipo, hacia_entidad: hacia, descripcion, confidence });
    },
  },
  {
    name: 'causal_query',
    description: 'Consulta edges causales. Usar para entender qué causó qué en el proyecto.',
    inputSchema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', description: 'Tipo de edge a filtrar (opcional)' },
        entidad: { type: 'string', description: 'Entidad a consultar (opcional)' },
        includeHistory: { type: 'boolean', description: 'Incluir edges invalidados' },
      },
      required: [],
    },
    handler: async ({ tipo, entidad, includeHistory = false }) => {
      const m = loadModule('causal-edges.cjs');
      const db = getDB();
      return m.queryCausalEdges(db, { tipo, entidad, includeHistory });
    },
  },

  // ── DECISION TRAIL (v2 nuevo) ─────────────────────────────────────────────
  {
    name: 'decision_trail',
    description: 'Trail completo de un ciclo: qué cambió, qué memoria influyó, qué quedó invalidado.',
    inputSchema: {
      type: 'object',
      properties: {
        ciclo_id: { type: 'string', description: 'ID del ciclo' },
      },
      required: ['ciclo_id'],
    },
    handler: async ({ ciclo_id }) => {
      const m = loadModule('decision-trail.cjs');
      const db = getDB();
      return m.getCicloTrail(db, ciclo_id);
    },
  },
  {
    name: 'decision_why',
    description: 'Explica por qué existe algo en el código/memoria: cadena causal + ADRs + episodios históricos.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Archivo, módulo o entidad a explicar' },
      },
      required: ['target'],
    },
    handler: async ({ target }) => {
      const m = loadModule('decision-trail.cjs');
      const db = getDB();
      return m.whyExists(db, target);
    },
  },

  // ── MÉTRICAS (v2 nuevo) ───────────────────────────────────────────────────
  {
    name: 'metrics_summary',
    description: 'Métricas operacionales del proyecto: tasa de éxito, retrabajo, calidad de memoria, autonomy score, token savings estimado.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const m = loadModule('metrics.cjs');
      const db = getDB();
      return {
        cycles: m.computeCycleMetrics(db),
        memory: m.computeMemoryMetrics(db),
        autonomy: m.computeAutonomyScore(db),
        tokens: m.estimateTokenSavings(db),
      };
    },
  },

  // ── HEALTH CHECK (v2 nuevo) ───────────────────────────────────────────────
  {
    name: 'health_check',
    description: 'Diagnóstico completo del sistema: qué funciona, qué falta, qué comando ejecutar para arreglarlo.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const m = loadModule('health-check.cjs');
      return m.runHealthCheck(ROOT);
    },
  },

  // ── MEMORY AUDIT (v2 nuevo) ───────────────────────────────────────────────
  {
    name: 'memory_audit',
    description: 'Reporte de auditoría de memoria: entradas stale, contradicciones, consolidaciones propuestas.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const m = loadModule('memory-audit.cjs');
      const db = getDB();
      m.migrateVigenciaTipo(db);
      return m.generateAuditReport(db);
    },
  },
  {
    name: 'memory_forget',
    description: 'Olvida explícitamente una entrada de memoria con evidencia. No borra — invalida con razón documentada.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'ID del nodo a olvidar' },
        razon: { type: 'string', description: 'Razón por la que se invalida (requerido para audit trail)' },
      },
      required: ['id', 'razon'],
    },
    handler: async ({ id, razon }) => {
      const m = loadModule('memory-audit.cjs');
      const db = getDB();
      return m.forgetMemory(db, id, razon, ROOT);
    },
  },
  {
    name: 'verdad_vigente',
    description: 'Retorna SOLO la memoria vigente (no histórica, no evidencia, no obsoleta). Úsalo en lugar de grafo_buscar cuando necesitas reglas que aplican HOY.',
    inputSchema: {
      type: 'object',
      properties: {
        area: { type: 'string', description: 'Área o módulo del proyecto' },
        tipo: { type: 'string', description: 'Tipo de nodo: error | patron | decision' },
        limit: { type: 'number', description: 'Máximo de resultados (default: 20)' },
      },
      required: [],
    },
    handler: async ({ area, tipo, limit = 20 }) => {
      const m = loadModule('memory-audit.cjs');
      const db = getDB();
      m.migrateVigenciaTipo(db);
      return m.verdadVigente(db, area, tipo, limit);
    },
  },
];

// ─── MCP PROTOCOL (JSON-RPC 2.0 over stdio) ───────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }

  const { id, method, params } = request;

  try {
    if (method === 'initialize') {
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentic-kdd', version: '2.0.0' },
      });
    } else if (method === 'tools/list') {
      sendResponse(id, {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    } else if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;
      const tool = TOOLS.find(t => t.name === name);
      if (!tool) {
        sendError(id, -32601, `Tool '${name}' no encontrada`);
        return;
      }
      try {
        const result = await tool.handler(args);
        sendResponse(id, {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        sendError(id, -32603, `Error ejecutando ${name}: ${e.message}`);
      }
    } else {
      sendError(id, -32601, `Método '${method}' no soportado`);
    }
  } catch (e) {
    sendError(id, -32603, e.message);
  }
});

function sendResponse(id, result) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(response + '\n');
}

function sendError(id, code, message) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(response + '\n');
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

console.error(`[Agentic KDD MCP v2.0] ${TOOLS.length} tools disponibles. ROOT: ${ROOT}`);
