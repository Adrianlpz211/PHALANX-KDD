/**
 * Agentic KDD — Metrics v1.0
 * KPIs operacionales del proyecto: éxito por ciclo, retrabajo, tokens ahorrados,
 * tasa de autonomía, drift de confianza, memoria aplicada vs ignorada.
 *
 * Cierra el Gap #4: el sistema mejoraba en silencio. Ahora el dev ve el valor.
 *
 * Uso:
 *   node .agentic/grafo/metrics.cjs summary
 *   node .agentic/grafo/metrics.cjs trend [N_ciclos]
 *   node .agentic/grafo/metrics.cjs memory
 *   node .agentic/grafo/metrics.cjs tokens [tarea_descripcion]
 *   node .agentic/grafo/metrics.cjs autonomy
 */

'use strict';

const path = require('path');

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  throw new Error('No SQLite driver disponible');
}

// ─── MÉTRICAS DE CICLOS ───────────────────────────────────────────────────────

function computeCycleMetrics(db) {
  let ciclos = [];
  try {
    ciclos = db.prepare(`
      SELECT estado, stops_count, tests_pasando, tests_generados,
             review_blockers, fases_completadas, fases_total, duracion_ms,
             patrones_aplicados, errores_evitados, sync_grafo, fecha_inicio
      FROM ciclos ORDER BY fecha_inicio DESC LIMIT 100
    `).all();
  } catch { return null; }

  if (ciclos.length === 0) return { error: 'Sin ciclos registrados' };

  const total = ciclos.length;
  const completados = ciclos.filter(c => c.estado === 'COMPLETADO').length;
  const stops = ciclos.filter(c => c.estado === 'STOP').length;
  const conRework = ciclos.filter(c => c.stops_count > 0).length;

  const successRate = total > 0 ? Math.round((completados / total) * 100) : 0;
  const reworkRate  = total > 0 ? Math.round((conRework / total) * 100) : 0;
  const stopRate    = total > 0 ? Math.round((stops / total) * 100) : 0;

  // Tests
  const totalTests   = ciclos.reduce((s, c) => s + (c.tests_generados || 0), 0);
  const passingTests = ciclos.reduce((s, c) => s + (c.tests_pasando || 0), 0);
  const testPassRate = totalTests > 0 ? Math.round((passingTests / totalTests) * 100) : 0;

  // Fases
  const totalFases = ciclos.reduce((s, c) => s + (c.fases_total || 0), 0);
  const compFases  = ciclos.reduce((s, c) => s + (c.fases_completadas || 0), 0);
  const faseRate   = totalFases > 0 ? Math.round((compFases / totalFases) * 100) : 0;

  // Memoria aplicada
  let patronesAplicados = 0, erroresEvitados = 0;
  ciclos.forEach(c => {
    try { patronesAplicados += JSON.parse(c.patrones_aplicados || '[]').length; } catch {}
    try { erroresEvitados   += JSON.parse(c.errores_evitados   || '[]').length; } catch {}
  });

  // Review blockers
  const totalBlockers = ciclos.reduce((s, c) => s + (c.review_blockers || 0), 0);

  // Duración promedio
  const duraciones = ciclos.filter(c => c.duracion_ms > 0).map(c => c.duracion_ms);
  const avgDuracion = duraciones.length > 0 ? Math.round(duraciones.reduce((s, d) => s + d, 0) / duraciones.length) : 0;

  return {
    ciclos_total: total,
    success_rate: successRate,
    rework_rate: reworkRate,
    stop_rate: stopRate,
    test_pass_rate: testPassRate,
    fase_completion_rate: faseRate,
    patrones_aplicados: patronesAplicados,
    errores_evitados: erroresEvitados,
    review_blockers_total: totalBlockers,
    avg_duracion_ms: avgDuracion,
    ciclos_con_sync: ciclos.filter(c => c.sync_grafo).length,
  };
}

// ─── MÉTRICAS DE MEMORIA ──────────────────────────────────────────────────────

function computeMemoryMetrics(db) {
  const mem = {};

  try {
    mem.total_nodos    = db.prepare("SELECT COUNT(*) as n FROM nodos").get()?.n ?? 0;
    mem.nodos_alta     = db.prepare("SELECT COUNT(*) as n FROM nodos WHERE confianza='ALTA' AND estado='ACTIVO'").get()?.n ?? 0;
    mem.nodos_media    = db.prepare("SELECT COUNT(*) as n FROM nodos WHERE confianza='MEDIA' AND estado='ACTIVO'").get()?.n ?? 0;
    mem.nodos_obsoletos= db.prepare("SELECT COUNT(*) as n FROM nodos WHERE estado='OBSOLETO'").get()?.n ?? 0;
    mem.episodios      = db.prepare("SELECT COUNT(*) as n FROM episodios").get()?.n ?? 0;
    mem.sin_consolidar = db.prepare("SELECT COUNT(*) as n FROM episodios WHERE consolidado=0").get()?.n ?? 0;
    mem.entidades      = db.prepare("SELECT COUNT(*) as n FROM entidades").get()?.n ?? 0;
    mem.relaciones_sem = db.prepare("SELECT COUNT(*) as n FROM relaciones_semanticas WHERE invalid_at IS NULL OR invalid_at=''").get()?.n ?? 0;

    // Edges causales
    const causalTypes = ['caused_failure','was_fixed_by','tested_by','regressed_by'];
    const causalPlaceholders = causalTypes.map(() => '?').join(',');
    mem.edges_causales = db.prepare(`SELECT COUNT(*) as n FROM relaciones_semanticas WHERE tipo IN (${causalPlaceholders}) AND (invalid_at IS NULL OR invalid_at='')`).get(...causalTypes)?.n ?? 0;

    // AST
    try {
      mem.ast_symbols = db.prepare("SELECT COUNT(*) as n FROM ast_symbols").get()?.n ?? 0;
      mem.ast_edges   = db.prepare("SELECT COUNT(*) as n FROM ast_edges").get()?.n ?? 0;
      mem.ast_files   = db.prepare("SELECT COUNT(DISTINCT file) as n FROM ast_symbols").get()?.n ?? 0;
    } catch { mem.ast_symbols = 0; mem.ast_edges = 0; mem.ast_files = 0; }

    // Knowledge docs
    try {
      mem.knowledge_docs = db.prepare("SELECT COUNT(*) as n FROM knowledge_docs WHERE status='accepted'").get()?.n ?? 0;
    } catch { mem.knowledge_docs = 0; }

    // Vigencia types (v3.1)
    try {
      const vigencias = db.prepare("SELECT vigencia_tipo, COUNT(*) as n FROM nodos GROUP BY vigencia_tipo").all();
      mem.por_vigencia = {};
      vigencias.forEach(v => { mem.por_vigencia[v.vigencia_tipo || 'sin_clasificar'] = v.n; });
    } catch { mem.por_vigencia = {}; }

    // Calidad memoria: ratio alta/(alta+media)
    const activos = mem.nodos_alta + mem.nodos_media;
    mem.quality_score = activos > 0 ? Math.round((mem.nodos_alta / activos) * 100) : 0;
    mem.consolidation_debt = mem.sin_consolidar; // episodios sin procesar

  } catch (e) { return { error: e.message }; }

  return mem;
}

// ─── ESTIMACIÓN DE TOKEN SAVINGS ─────────────────────────────────────────────

/**
 * Estima el ahorro de tokens en el proyecto actual vs trabajar sin Agentic.
 * Basado en: ciclos completados + patrones aplicados + queries SQLite vs lecturas de archivo.
 */
function estimateTokenSavings(db) {
  const cycleMetrics = computeCycleMetrics(db);
  const memMetrics   = computeMemoryMetrics(db);
  if (cycleMetrics?.error || memMetrics?.error) return { error: 'Datos insuficientes' };

  // Cada patrón aplicado via SQLite en lugar de leer archivo: ~200 tokens ahorrados
  const savingsFromPatterns = (cycleMetrics.patrones_aplicados || 0) * 200;
  // Cada error evitado (no tuvo que debuggear ni re-ejecutar): ~500 tokens ahorrados
  const savingsFromErrors = (cycleMetrics.errores_evitados || 0) * 500;
  // Cada ciclo completo sin stop: ~800 tokens ahorrados vs tener que re-contextualizar
  const successCiclos = Math.round((cycleMetrics.ciclos_total || 0) * (cycleMetrics.success_rate || 0) / 100);
  const savingsFromFlow = successCiclos * 800;
  // AST queries: evitar lecturas manuales de archivos
  const savingsFromAST = (memMetrics.ast_files || 0) * 150;

  const totalEstimado = savingsFromPatterns + savingsFromErrors + savingsFromFlow + savingsFromAST;

  return {
    total_tokens_estimados_ahorrados: totalEstimado,
    por_patrones: savingsFromPatterns,
    por_errores_evitados: savingsFromErrors,
    por_flujo_sin_interrupciones: savingsFromFlow,
    por_ast_queries: savingsFromAST,
    nota: 'Estimación conservadora. Variación real: ±40% según complejidad del proyecto.',
    baseline_comparacion: 'Claude sin memoria: re-explora codebase en cada sesión',
  };
}

// ─── AUTONOMY SCORE ───────────────────────────────────────────────────────────

/**
 * Score de autonomía real basado en datos medibles.
 * No es una estimación del roadmap — es lo que los datos muestran.
 */
function computeAutonomyScore(db) {
  const cycles = computeCycleMetrics(db);
  const mem    = computeMemoryMetrics(db);
  if (cycles?.error) return { error: 'Sin datos' };

  const scores = {};

  // 1. Tasa de éxito sin intervención (40% del score)
  scores.success_rate = Math.min(cycles.success_rate || 0, 100);
  scores.success_weight = 0.4;

  // 2. Tasa de tests automáticos (20%)
  scores.test_coverage = Math.min(cycles.test_pass_rate || 0, 100);
  scores.test_weight = 0.2;

  // 3. Uso de memoria (20%): patrones aplicados / ciclos
  const memUsage = cycles.ciclos_total > 0
    ? Math.min(Math.round(((cycles.patrones_aplicados || 0) / cycles.ciclos_total) * 20), 100)
    : 0;
  scores.memory_usage = memUsage;
  scores.memory_weight = 0.2;

  // 4. Completitud del grafo (20%): AST + knowledge + causal
  const graphCompleteness = Math.min(
    Math.round(((mem.ast_files || 0) > 0 ? 40 : 0) +
               ((mem.knowledge_docs || 0) > 0 ? 30 : 0) +
               ((mem.edges_causales || 0) > 0 ? 30 : 0)),
    100
  );
  scores.graph_completeness = graphCompleteness;
  scores.graph_weight = 0.2;

  const overall = Math.round(
    scores.success_rate   * scores.success_weight +
    scores.test_coverage  * scores.test_weight +
    scores.memory_usage   * scores.memory_weight +
    scores.graph_completeness * scores.graph_weight
  );

  return {
    overall_autonomy: overall,
    componentes: {
      tasa_exito: { score: scores.success_rate, peso: '40%' },
      cobertura_tests: { score: scores.test_coverage, peso: '20%' },
      uso_memoria: { score: scores.memory_usage, peso: '20%' },
      completitud_grafo: { score: scores.graph_completeness, peso: '20%' },
    },
    nivel: overall >= 85 ? 'MUY ALTO' : overall >= 70 ? 'ALTO' : overall >= 50 ? 'MEDIO' : 'EN DESARROLLO',
  };
}

// ─── TREND (últimos N ciclos) ─────────────────────────────────────────────────

function computeTrend(db, n = 10) {
  let ciclos = [];
  try {
    ciclos = db.prepare(`
      SELECT ciclo_id, estado, tests_pasando, tests_generados, stops_count, fecha_inicio
      FROM ciclos ORDER BY fecha_inicio DESC LIMIT ?
    `).all(n);
  } catch { return []; }

  return ciclos.reverse().map((c, i) => ({
    ciclo: i + 1,
    id: c.ciclo_id,
    estado: c.estado,
    test_rate: c.tests_generados > 0 ? Math.round((c.tests_pasando / c.tests_generados) * 100) : null,
    rework: c.stops_count > 0 ? 1 : 0,
    fecha: c.fecha_inicio?.substring(0, 10),
  }));
}

// ─── PRINT ────────────────────────────────────────────────────────────────────

function printSummary(projectRoot) {
  const db = openDB(projectRoot);
  const cycles = computeCycleMetrics(db);
  const mem    = computeMemoryMetrics(db);
  const savings = estimateTokenSavings(db);
  const autonomy = computeAutonomyScore(db);

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Agentic KDD — Project Metrics');
  console.log('═══════════════════════════════════════════════════');

  if (!cycles?.error) {
    console.log('\n  ── CICLOS ──────────────────────────────────────');
    console.log(`  Total ciclos:       ${cycles.ciclos_total}`);
    console.log(`  Tasa de éxito:      ${cycles.success_rate}%`);
    console.log(`  Tasa de retrabajo:  ${cycles.rework_rate}%`);
    console.log(`  Tests pass rate:    ${cycles.test_pass_rate}%`);
    console.log(`  Fases completadas:  ${cycles.fase_completion_rate}%`);
    console.log(`  Patrones aplicados: ${cycles.patrones_aplicados}`);
    console.log(`  Errores evitados:   ${cycles.errores_evitados}`);
  }

  if (!mem?.error) {
    console.log('\n  ── MEMORIA ─────────────────────────────────────');
    console.log(`  Nodos procedurales: ${mem.total_nodos} (ALTA: ${mem.nodos_alta}, MEDIA: ${mem.nodos_media})`);
    console.log(`  Quality score:      ${mem.quality_score}%`);
    console.log(`  Episodios:          ${mem.episodios} (${mem.sin_consolidar} sin consolidar)`);
    console.log(`  Entidades semántic: ${mem.entidades}`);
    console.log(`  Edges causales:     ${mem.edges_causales}`);
    console.log(`  AST: ${mem.ast_files} archivos, ${mem.ast_symbols} símbolos, ${mem.ast_edges} edges`);
    console.log(`  Knowledge docs:     ${mem.knowledge_docs}`);
  }

  if (!savings?.error) {
    console.log('\n  ── TOKEN SAVINGS (estimado) ────────────────────');
    console.log(`  Total ahorrado:     ~${savings.total_tokens_estimados_ahorrados.toLocaleString()} tokens`);
    console.log(`  Por patrones KDD:   ~${savings.por_patrones.toLocaleString()}`);
    console.log(`  Por errores evitad: ~${savings.por_errores_evitados.toLocaleString()}`);
    console.log(`  Por flujo continuo: ~${savings.por_flujo_sin_interrupciones.toLocaleString()}`);
  }

  if (!autonomy?.error) {
    console.log('\n  ── AUTONOMY SCORE ──────────────────────────────');
    console.log(`  Score global:       ${autonomy.overall_autonomy}% — ${autonomy.nivel}`);
    console.log(`  Éxito sin interv.:  ${autonomy.componentes.tasa_exito.score}%`);
    console.log(`  Cobertura tests:    ${autonomy.componentes.cobertura_tests.score}%`);
    console.log(`  Uso de memoria:     ${autonomy.componentes.uso_memoria.score}%`);
    console.log(`  Grafo completo:     ${autonomy.componentes.completitud_grafo.score}%`);
  }

  console.log('\n═══════════════════════════════════════════════════\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'summary':
      printSummary(projectRoot);
      break;
    case 'memory': {
      const db = openDB(projectRoot);
      const m = computeMemoryMetrics(db);
      console.log(JSON.stringify(m, null, 2));
      break;
    }
    case 'tokens': {
      const db = openDB(projectRoot);
      const s = estimateTokenSavings(db);
      console.log('\nToken savings estimado:');
      console.log(`  Total: ~${s.total_tokens_estimados_ahorrados?.toLocaleString() ?? 'N/A'} tokens`);
      console.log(`  Nota: ${s.nota}`);
      break;
    }
    case 'autonomy': {
      const db = openDB(projectRoot);
      const a = computeAutonomyScore(db);
      console.log(`\nAutonomy Score: ${a.overall_autonomy}% — ${a.nivel}`);
      Object.entries(a.componentes || {}).forEach(([k, v]) =>
        console.log(`  ${k}: ${v.score}% (peso ${v.peso})`)
      );
      break;
    }
    case 'trend': {
      const n = parseInt(args[0]) || 10;
      const db = openDB(projectRoot);
      const trend = computeTrend(db, n);
      console.log(`\nTrend últimos ${n} ciclos:`);
      trend.forEach(t => {
        const ok = t.estado === 'COMPLETADO' ? '✅' : '🛑';
        const tests = t.test_rate !== null ? `tests:${t.test_rate}%` : 'sin tests';
        console.log(`  ${ok} ${t.fecha} [${t.id}] ${tests}`);
      });
      break;
    }
    default:
      console.log('Uso: node metrics.cjs [summary | memory | tokens | autonomy | trend [N]]');
  }
}

module.exports = {
  computeCycleMetrics,
  computeMemoryMetrics,
  estimateTokenSavings,
  computeAutonomyScore,
  computeTrend,
};
