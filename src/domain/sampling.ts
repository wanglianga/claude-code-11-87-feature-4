import type {
  CoverageInterval,
  DefectObservation,
  DensityEstimate,
  EstimatorMethod,
  InspectionBatch,
  PlannedSegment,
  StratumEstimate,
} from '../types';

// ============================================================
// 抽检覆盖校正后的缺陷密度估计
// 关键纪律：
//  1. 承包商上报的缺陷“条数”不可直接比较——选段机制不同（风险导向 vs 全网），
//     必须把缺陷观测映射到“实际覆盖长度”并做覆盖校正。
//  2. 覆盖区间先求并集去重，重叠长度只计一次；未检长度单列、附原因，
//     绝不能把空白覆盖按 0 缺陷补零。
//  3. 设计权重（Horvitz–Thompson，w=1/π）保持目标总体定义，
//     但小概率段方差大；无任何受控覆盖的层不提供信息，总体估计标记为不可完全识别。
//  4. 分层校准权重按层内实测率 × 层登记长度汇总，稳定性更好，
//     但无覆盖层只能借用合并率（imputed），依赖“层内可比”假设。
//  5. 无抽样概率的临时加检（ad_hoc）只能列补充证据，不进入总体估计。
// ============================================================

export const CONFIDENCE_LEVEL = 0.95;
const Z_95 = 1.96;

export interface MergedInterval {
  fromKm: number;
  toKm: number;
}

export interface MergeResult {
  merged: MergedInterval[];
  /** 输入区间长度之和（公里） */
  rawLengthKm: number;
  /** 并集长度（公里） */
  unionLengthKm: number;
  /** 因重叠被剔除的长度（公里） */
  overlapRemovedLengthKm: number;
}

/** 同一线性参照系上的区间求并集（半开区间 [from, to)），重叠部分只计一次 */
export function mergeIntervals(intervals: { fromKm: number; toKm: number }[]): MergeResult {
  const valid = intervals
    .filter((iv) => iv.toKm > iv.fromKm)
    .map((iv) => ({ fromKm: iv.fromKm, toKm: iv.toKm }))
    .sort((a, b) => a.fromKm - b.fromKm);
  const rawLengthKm = valid.reduce((sum, iv) => sum + (iv.toKm - iv.fromKm), 0);

  const merged: MergedInterval[] = [];
  for (const iv of valid) {
    const last = merged[merged.length - 1];
    if (last && iv.fromKm <= last.toKm) {
      // 相接或重叠：向右扩展（包含关系时不扩展）
      last.toKm = Math.max(last.toKm, iv.toKm);
    } else {
      merged.push({ fromKm: iv.fromKm, toKm: iv.toKm });
    }
  }
  const unionLengthKm = merged.reduce((sum, iv) => sum + (iv.toKm - iv.fromKm), 0);
  return { merged, rawLengthKm, unionLengthKm, overlapRemovedLengthKm: rawLengthKm - unionLengthKm };
}

function pointInside(p: number, intervals: MergedInterval[]): boolean {
  return intervals.some((iv) => p >= iv.fromKm && p <= iv.toKm);
}

/** 缺陷区间是否整体落在实际覆盖并集内（中点落在覆盖内即视为可映射） */
function observationCovered(obs: { fromKm: number; toKm: number }, coverage: MergedInterval[]): boolean {
  const mid = (obs.fromKm + obs.toKm) / 2;
  return pointInside(mid, coverage);
}

/** 对缺陷观测区间去重叠：相交/相接的观测合并为一个 distinct 缺陷，返回 distinct 数与被合并数 */
export function deduplicateObservations(obs: DefectObservation[]): {
  distinct: DefectObservation[];
  removedCount: number;
} {
  const sorted = [...obs].sort((a, b) => a.fromKm - b.fromKm);
  const distinct: DefectObservation[] = [];
  let removedCount = 0;
  for (const o of sorted) {
    const last = distinct[distinct.length - 1];
    if (last && o.fromKm <= last.toKm) {
      // 重叠观测：保留更早的一条，区间向右吞并
      last.toKm = Math.max(last.toKm, o.toKm);
      removedCount += 1;
    } else {
      distinct.push({ ...o });
    }
  }
  return { distinct, removedCount };
}

// ---------------- 观测器：映射到实际覆盖长度并去重叠 ----------------

export interface MappedObservations {
  /** 受控抽样部分、落在覆盖内、去重叠后的 distinct 缺陷（按层） */
  controlledByStratum: Record<string, DefectObservation[]>;
  /** 临时加检部分的观测（仅补充证据） */
  adHoc: DefectObservation[];
  /** 落在任何覆盖区间之外而被剔除的观测 */
  outside: DefectObservation[];
  /** 因区间重叠被合并的重复观测数 */
  overlapRemovedDefectCount: number;
}

export function mapObservationsToCoverage(batch: InspectionBatch): MappedObservations {
  const controlledSegments = new Set(batch.plannedSegments.filter((s) => s.kind === 'sampled').map((s) => s.segmentId));
  const adHocSegments = new Set(batch.plannedSegments.filter((s) => s.kind === 'ad_hoc').map((s) => s.segmentId));

  // 受控覆盖并集（全体 + 分层），ad_hoc 覆盖不纳入估计覆盖
  const controlledCoverage = mergeIntervals(
    batch.coverage.filter((c) => controlledSegments.has(c.segmentId)),
  ).merged;
  const coverageByStratum: Record<string, MergedInterval[]> = {};
  for (const stratum of batch.strata) {
    coverageByStratum[stratum.stratumId] = mergeIntervals(
      batch.coverage.filter((c) => controlledSegments.has(c.segmentId) && c.stratumId === stratum.stratumId),
    ).merged;
  }

  const controlledRaw: DefectObservation[] = [];
  const adHoc: DefectObservation[] = [];
  const outside: DefectObservation[] = [];
  for (const obs of batch.observations) {
    if (adHocSegments.has(obs.segmentId)) {
      adHoc.push(obs);
      continue;
    }
    if (!controlledSegments.has(obs.segmentId)) {
      outside.push(obs);
      continue;
    }
    if (!observationCovered(obs, controlledCoverage)) {
      outside.push(obs);
      continue;
    }
    controlledRaw.push(obs);
  }

  // 分层去重叠（缺陷区间重叠只计一次）
  const controlledByStratum: Record<string, DefectObservation[]> = {};
  let overlapRemovedDefectCount = 0;
  for (const stratum of batch.strata) {
    const inStratum = controlledRaw.filter((o) => o.stratumId === stratum.stratumId);
    const { distinct, removedCount } = deduplicateObservations(inStratum);
    controlledByStratum[stratum.stratumId] = distinct;
    overlapRemovedDefectCount += removedCount;
  }
  return { controlledByStratum, adHoc, outside, overlapRemovedDefectCount };
}

// ---------------- 覆盖核算 ----------------

export interface CoverageAccounting {
  /** 各层受控覆盖并集 */
  byStratum: Record<string, MergeResult>;
  /** 受控抽样覆盖总并集 */
  total: MergeResult;
  /** 受控覆盖总长度（公里，估计口径） */
  controlledCoveredKm: number;
  /** 临时加检覆盖长度（公里，仅补充证据） */
  adHocCoveredKm: number;
  /** 未覆盖长度 = 目标总体长度 − 受控覆盖（公里，绝不补零） */
  uncoveredKm: number;
}

export function accountCoverage(batch: InspectionBatch): CoverageAccounting {
  const controlledIds = new Set(batch.plannedSegments.filter((s) => s.kind === 'sampled').map((s) => s.segmentId));
  const adHocIds = new Set(batch.plannedSegments.filter((s) => s.kind === 'ad_hoc').map((s) => s.segmentId));
  const byStratum: Record<string, MergeResult> = {};
  for (const stratum of batch.strata) {
    byStratum[stratum.stratumId] = mergeIntervals(
      batch.coverage.filter((c) => controlledIds.has(c.segmentId) && c.stratumId === stratum.stratumId),
    );
  }
  const total = mergeIntervals(batch.coverage.filter((c) => controlledIds.has(c.segmentId)));
  const adHocTotal = mergeIntervals(batch.coverage.filter((c) => adHocIds.has(c.segmentId)));
  const populationKm = batch.strata.reduce((sum, h) => sum + h.populationLengthKm, 0);
  return {
    byStratum,
    total,
    controlledCoveredKm: total.unionLengthKm,
    adHocCoveredKm: adHocTotal.unionLengthKm,
    uncoveredKm: Math.max(0, populationKm - total.unionLengthKm),
  };
}

// ---------------- 通用工具 ----------------

function round6(x: number): number {
  return Math.round((x + Number.EPSILON) * 1e6) / 1e6;
}

function segmentProbabilityOrNull(segments: PlannedSegment[]): number | null {
  const controlled = segments.filter((s) => s.kind === 'sampled');
  if (controlled.length === 0 || controlled.some((s) => s.inclusionProbability === null)) return null;
  // 长度加权的代表入样概率
  const totalLen = controlled.reduce((sum, s) => sum + s.plannedLengthKm, 0);
  if (totalLen === 0) return controlled[0]?.inclusionProbability ?? null;
  return controlled.reduce((sum, s) => sum + (s.inclusionProbability ?? 0) * s.plannedLengthKm, 0) / totalLen;
}

// ---------------- 估计器 ----------------

export function estimateDensity(batch: InspectionBatch, method: EstimatorMethod): DensityEstimate {
  const mapped = mapObservationsToCoverage(batch);
  const coverage = accountCoverage(batch);
  const populationKm = batch.strata.reduce((sum, h) => sum + h.populationLengthKm, 0);
  const warnings: string[] = [];

  const rawObservedCount = Object.values(mapped.controlledByStratum).reduce((n, list) => n + list.length, 0);
  if (mapped.outside.length > 0) {
    warnings.push(`有 ${mapped.outside.length} 条缺陷观测落在实际覆盖区间之外，已剔除（未检长度不得反推缺陷）。`);
  }
  if (mapped.overlapRemovedDefectCount > 0) {
    warnings.push(`缺陷区间去重叠：${mapped.overlapRemovedDefectCount} 条重复观测被合并，distinct 缺陷数为 ${rawObservedCount}。`);
  }
  if (coverage.total.overlapRemovedLengthKm > 0) {
    warnings.push(
      `覆盖区间重叠 ${round6(coverage.total.overlapRemovedLengthKm)} km 已剔除，实际覆盖按并集 ${round6(
        coverage.controlledCoveredKm,
      )} km 计，不重复计长。`,
    );
  }
  if (mapped.adHoc.length > 0) {
    warnings.push(
      `临时加检 ${round6(coverage.adHocCoveredKm)} km、${mapped.adHoc.length} 处缺陷无受控抽样概率，仅列补充证据，不进入目标总体估计。`,
    );
  }
  if (batch.uninspected.length > 0) {
    const km = batch.uninspected.reduce((s, p) => s + p.lengthKm, 0);
    warnings.push(`计划框内未检 ${round6(km)} km（${batch.uninspected.map((p) => p.reason).join('、')}），按未覆盖单列，不补零。`);
  }

  const strataRows: StratumEstimate[] = [];
  let weightedTotal: number;
  let varianceTotal: number;
  let identifiable = true;

  if (method === 'design') {
    // ---- Horvitz–Thompson 设计权重：w=1/π ----
    // 缺陷按泊松点过程近似时，HT 总量估计 T̂=Σ n_j/π_j，方差 V(T̂)=Σ n_j/π_j²。
    weightedTotal = 0;
    varianceTotal = 0;
    for (const stratum of batch.strata) {
      const segments = batch.plannedSegments.filter((s) => s.stratumId === stratum.stratumId && s.kind === 'sampled');
      const cov = coverage.byStratum[stratum.stratumId];
      const coveredKm = cov.unionLengthKm;
      const plannedKm = segments.reduce((s, x) => s + x.plannedLengthKm, 0);
      const nH = mapped.controlledByStratum[stratum.stratumId]?.length ?? 0;
      const pi = segmentProbabilityOrNull(segments);

      let weightedCount: number | null = null;
      let varianceContribution: number | null = null;
      let weight: number | null = null;
      let densityContribution: number | null = null;
      let observedRate: number | null = null;
      let imputed = false;

      if (segments.length === 0 || coveredKm === 0 || pi === null) {
        identifiable = false;
        warnings.push(
          `【${stratum.label}】无受控抽样覆盖（或缺少已知选段概率），设计权重对该层不提供信息：未覆盖长度 ${round6(
            stratum.populationLengthKm - coveredKm,
          )} km 单列，绝不补零。`,
        );
      } else {
        weight = 1 / pi;
        let layerWeighted = 0;
        let layerVariance = 0;
        for (const seg of segments) {
          const pij = seg.inclusionProbability;
          if (pij === null || pij <= 0) continue;
          const nj = mapped.controlledByStratum[stratum.stratumId]?.filter((o) => o.segmentId === seg.segmentId).length ?? 0;
          layerWeighted += nj / pij;
          layerVariance += nj / (pij * pij);
        }
        weightedCount = layerWeighted;
        varianceContribution = layerVariance;
        weightedTotal += layerWeighted;
        varianceTotal += layerVariance;
        observedRate = nH / coveredKm;
        densityContribution = layerWeighted / populationKm;
      }

      strataRows.push({
        stratumId: stratum.stratumId,
        label: stratum.label,
        basis: stratum.basis,
        populationLengthKm: stratum.populationLengthKm,
        coveredLengthKm: round6(coveredKm),
        plannedLengthKm: round6(plannedKm),
        rawDefectCount: nH,
        overlapRemovedLengthKm: round6(cov.overlapRemovedLengthKm),
        inclusionProbability: pi,
        weight,
        weightedDefectCount: weightedCount === null ? null : round6(weightedCount),
        observedRatePerKm: observedRate === null ? null : round6(observedRate),
        densityContribution: densityContribution === null ? null : round6(densityContribution),
        varianceContribution: varianceContribution === null ? null : round6(varianceContribution),
        coverageRatio: round6(coveredKm / stratum.populationLengthKm),
        imputed,
      });
    }
  } else {
    // ---- 分层校准（post-stratification）：层实测率 × 层登记长度 ----
    // 有覆盖层 r_h = n_h / L_h；无覆盖层借用全部受控覆盖的合并率 r_pool，
    // 显式标记 imputed=true，提示结论依赖“层内可比”假设。
    const pooledN = rawObservedCount;
    const pooledL = coverage.controlledCoveredKm;
    const pooledRate = pooledL > 0 ? pooledN / pooledL : null;
    if (pooledRate === null) {
      identifiable = false;
      warnings.push('没有任何受控覆盖长度，校准估计不可识别。');
    }
    weightedTotal = 0;
    varianceTotal = 0;
    for (const stratum of batch.strata) {
      const cov = coverage.byStratum[stratum.stratumId];
      const coveredKm = cov.unionLengthKm;
      const segments = batch.plannedSegments.filter((s) => s.stratumId === stratum.stratumId && s.kind === 'sampled');
      const plannedKm = segments.reduce((s, x) => s + x.plannedLengthKm, 0);
      const nH = mapped.controlledByStratum[stratum.stratumId]?.length ?? 0;
      const pi = segmentProbabilityOrNull(segments);
      const observedRate = coveredKm > 0 ? nH / coveredKm : null;
      const imputed = observedRate === null;
      const rate = observedRate ?? pooledRate;

      let weightedCount: number | null = null;
      let varianceContribution: number | null = null;
      let densityContribution: number | null = null;

      if (rate === null) {
        identifiable = false;
        warnings.push(`【${stratum.label}】无覆盖且无可借用的合并率，该层无法估计，未覆盖长度不补零。`);
      } else {
        if (imputed) {
          identifiable = false;
          warnings.push(
            `【${stratum.label}】无受控覆盖，借用合并率 ${round6(rate)} 处/km 推算（imputed）；该结论依赖管龄/材质/风险层内可比假设，方差异质性未完全计入。`,
          );
        }
        weightedCount = rate * stratum.populationLengthKm;
        // 泊松点过程下方差：有覆盖层 N_h²·n_h/L_h²；借用层用合并率自身抽样方差 N_h²·n_pool/L_pool²
        const rateVariance = imputed
          ? pooledL > 0
            ? pooledN / (pooledL * pooledL)
            : 0
          : coveredKm > 0
            ? nH / (coveredKm * coveredKm)
            : 0;
        varianceContribution = stratum.populationLengthKm * stratum.populationLengthKm * rateVariance;
        varianceTotal += varianceContribution;
        weightedTotal += weightedCount;
        densityContribution = weightedCount / populationKm;
      }

      strataRows.push({
        stratumId: stratum.stratumId,
        label: stratum.label,
        basis: stratum.basis,
        populationLengthKm: stratum.populationLengthKm,
        coveredLengthKm: round6(coveredKm),
        plannedLengthKm: round6(plannedKm),
        rawDefectCount: nH,
        overlapRemovedLengthKm: round6(cov.overlapRemovedLengthKm),
        inclusionProbability: pi,
        weight: null,
        weightedDefectCount: weightedCount === null ? null : round6(weightedCount),
        observedRatePerKm: observedRate === null ? null : round6(observedRate),
        densityContribution: densityContribution === null ? null : round6(densityContribution),
        varianceContribution: varianceContribution === null ? null : round6(varianceContribution),
        coverageRatio: round6(coveredKm / stratum.populationLengthKm),
        imputed,
      });
    }
  }

  const densityPerKm = identifiable || weightedTotal > 0 ? weightedTotal / populationKm : null;
  const varianceRate = varianceTotal / (populationKm * populationKm);
  const stdErrorRate = Math.sqrt(varianceRate);
  const ciLower = densityPerKm === null ? null : Math.max(0, densityPerKm - Z_95 * stdErrorRate);
  const ciUpper = densityPerKm === null ? null : densityPerKm + Z_95 * stdErrorRate;
  const cvPercent = densityPerKm && densityPerKm > 0 ? (stdErrorRate / densityPerKm) * 100 : null;

  return {
    method,
    targetNetworkId: batch.targetNetworkId,
    targetNetworkName: batch.targetNetworkName,
    targetPopulationLengthKm: populationKm,
    totalCoveredLengthKm: round6(coverage.controlledCoveredKm),
    coverageRatio: round6(coverage.controlledCoveredKm / populationKm),
    uncoveredLengthKm: round6(coverage.uncoveredKm),
    rawObservedCount,
    adHocObservedCount: mapped.adHoc.length,
    adHocCoveredLengthKm: round6(coverage.adHocCoveredKm),
    overlapRemovedDefectCount: mapped.overlapRemovedDefectCount,
    outsideCoverageCount: mapped.outside.length,
    weightedDefectEstimate: round6(weightedTotal),
    densityPerKm: densityPerKm === null ? null : round6(densityPerKm),
    variance: round6(varianceRate),
    stdError: round6(stdErrorRate),
    cvPercent: cvPercent === null ? null : round6(cvPercent),
    confidenceLevel: CONFIDENCE_LEVEL,
    ciLower: ciLower === null ? null : round6(ciLower),
    ciUpper: ciUpper === null ? null : round6(ciUpper),
    strata: strataRows,
    warnings,
    identifiable,
  };
}

/** 未加权“现场观察”口径：只描述发生了什么，不做总体推断 */
export interface RawObservationView {
  batchId: string;
  contractor: string;
  /** 受控抽样部分 distinct 现场缺陷数 */
  rawControlledCount: number;
  /** 临时加检缺陷数（补充证据） */
  adHocCount: number;
  /** 受控覆盖长度（公里） */
  controlledCoveredKm: number;
  /** 朴素缺陷率 = 现场缺陷数 / 实际检查公里（未做选段概率校正，不可跨承包商排名） */
  naiveRatePerKm: number;
}

export function rawObservationView(batch: InspectionBatch): RawObservationView {
  const mapped = mapObservationsToCoverage(batch);
  const coverage = accountCoverage(batch);
  const controlledCount = Object.values(mapped.controlledByStratum).reduce((n, l) => n + l.length, 0);
  return {
    batchId: batch.batchId,
    contractor: batch.contractor,
    rawControlledCount: controlledCount,
    adHocCount: mapped.adHoc.length,
    controlledCoveredKm: round6(coverage.controlledCoveredKm),
    naiveRatePerKm: coverage.controlledCoveredKm > 0 ? round6(controlledCount / coverage.controlledCoveredKm) : 0,
  };
}

// ============================================================
// 题目样例：同一登记管网 NET-100（100 km），三层
//   高风险 H 20km / 中风险 M 30km / 低风险 L 50km
//   甲承包商：只查高风险 10km，发现 8 处（另有 2km 无概率临时加检 1 处）
//   乙承包商：全网三层共查 30km，发现 9 处
// ============================================================

export const SAMPLE_NETWORK = {
  targetNetworkId: 'NET-100',
  targetNetworkName: '云江市城区排水登记管网（100 km）',
};

export const SAMPLE_STRATA = [
  { stratumId: 'STR-H', label: '高风险层', basis: '管龄>20年 · 混凝土管 · 历史缺陷高发', populationLengthKm: 20 },
  { stratumId: 'STR-M', label: '中风险层', basis: '管龄10–20年 · 混凝土/球墨铸铁', populationLengthKm: 30 },
  { stratumId: 'STR-L', label: '低风险层', basis: '管龄<10年 · PE/PVC 新管', populationLengthKm: 50 },
];

function pointDefect(id: string, segmentId: string, stratumId: string, atKm: number, ref?: string): DefectObservation {
  return { observationId: id, segmentId, stratumId, fromKm: atKm, toKm: round6(atKm + 0.02), defectRef: ref };
}

export function buildSampleBatches(): InspectionBatch[] {
  // ---------------- 甲承包商：风险导向，仅高风险 ----------------
  const batchA: InspectionBatch = {
    batchId: 'BATCH-A',
    contractor: '甲承包商（恒基检测）',
    projectId: 'P',
    ...SAMPLE_NETWORK,
    inspectedAt: '2026-11-12T09:00:00+08:00',
    strata: SAMPLE_STRATA.map((h) => ({ ...h })),
    plannedSegments: [
      // 计划框 12km，实际覆盖并集 10km（2km 因交通导改未检）
      {
        segmentId: 'SEG-A-H1',
        stratumId: 'STR-H',
        location: '高风险层 WS-01 管段（K0+000~K0+700）',
        plannedLengthKm: 7,
        selectionReason: '风险导向：历史塌陷点周边 500m 重点排查',
        inclusionProbability: 0.5,
        kind: 'sampled',
      },
      {
        segmentId: 'SEG-A-H2',
        stratumId: 'STR-H',
        location: '高风险层 WS-02 管段（K0+480~K0+980）',
        plannedLengthKm: 5,
        selectionReason: '风险导向：管龄>25年混凝土管，年度抽检计划',
        inclusionProbability: 0.5,
        kind: 'sampled',
      },
      {
        segmentId: 'SEG-A-M-ADHOC',
        stratumId: 'STR-M',
        location: '中风险层 WS-09 管段（投诉点周边）',
        plannedLengthKm: 2,
        selectionReason: '群众举报临时加检：无受控抽样设计，未赋抽样概率',
        inclusionProbability: null,
        kind: 'ad_hoc',
      },
    ],
    // 两段覆盖在 [4.8, 5.2] 重叠 0.4km：原始跨度 10.4km，并集 10.0km
    coverage: [
      { intervalId: 'COV-A-1', segmentId: 'SEG-A-H1', stratumId: 'STR-H', fromKm: 0, toKm: 5.2 },
      { intervalId: 'COV-A-2', segmentId: 'SEG-A-H2', stratumId: 'STR-H', fromKm: 4.8, toKm: 10.0 },
      { intervalId: 'COV-A-3', segmentId: 'SEG-A-M-ADHOC', stratumId: 'STR-M', fromKm: 40, toKm: 42 },
    ],
    uninspected: [
      { partId: 'UN-A-1', segmentId: 'SEG-A-H1', lengthKm: 1.8, reason: '主干道交通导改未获批，夜间窗口不足' },
      { partId: 'UN-A-2', segmentId: 'SEG-A-H2', lengthKm: 0.2, reason: '井口被违建占压，权属协调中' },
    ],
    observations: [
      // 高风险层 8 处 distinct（其中 OBS-A-8 与 OBS-A-7 区间重叠，去重后为同一处）
      pointDefect('OBS-A-1', 'SEG-A-H1', 'STR-H', 0.6, 'D-H-001'),
      pointDefect('OBS-A-2', 'SEG-A-H1', 'STR-H', 1.4, 'D-H-002'),
      pointDefect('OBS-A-3', 'SEG-A-H1', 'STR-H', 2.7, 'D-H-003'),
      pointDefect('OBS-A-4', 'SEG-A-H1', 'STR-H', 3.9, 'D-H-004'),
      pointDefect('OBS-A-5', 'SEG-A-H2', 'STR-H', 5.5, 'D-H-005'),
      pointDefect('OBS-A-6', 'SEG-A-H2', 'STR-H', 7.1, 'D-H-006'),
      pointDefect('OBS-A-7', 'SEG-A-H2', 'STR-H', 8.8, 'D-H-007'),
      pointDefect('OBS-A-8', 'SEG-A-H2', 'STR-H', 8.81, 'D-H-007-复测'),
      pointDefect('OBS-A-9', 'SEG-A-H2', 'STR-H', 9.6, 'D-H-008'),
      // 临时加检 1 处（补充证据，不进总体）
      pointDefect('OBS-A-AD1', 'SEG-A-M-ADHOC', 'STR-M', 40.8, 'D-M-AD1'),
    ],
    note: '甲承包商仅进入高风险层作业；中/低风险层 80km 无受控覆盖。',
  };

  // ---------------- 乙承包商：分层随机，全网三层 ----------------
  const batchB: InspectionBatch = {
    batchId: 'BATCH-B',
    contractor: '乙承包商（市政检测中心）',
    projectId: 'P',
    ...SAMPLE_NETWORK,
    inspectedAt: '2026-11-16T09:00:00+08:00',
    strata: SAMPLE_STRATA.map((h) => ({ ...h })),
    plannedSegments: [
      {
        segmentId: 'SEG-B-H1',
        stratumId: 'STR-H',
        location: '高风险层随机抽选 WS-03/05/07',
        plannedLengthKm: 10,
        selectionReason: '分层随机抽样：高风险层抽选概率 0.5',
        inclusionProbability: 0.5,
        kind: 'sampled',
      },
      {
        segmentId: 'SEG-B-M1',
        stratumId: 'STR-M',
        location: '中风险层随机抽选 WS-11/14',
        plannedLengthKm: 10,
        selectionReason: '分层随机抽样：中风险层抽选概率 0.25（整群抽选，实际覆盖 9km）',
        inclusionProbability: 0.25,
        kind: 'sampled',
      },
      {
        segmentId: 'SEG-B-L1',
        stratumId: 'STR-L',
        location: '低风险层随机抽选 WS-22/25/30',
        plannedLengthKm: 14,
        selectionReason: '分层随机抽样：低风险层抽选概率 0.22',
        inclusionProbability: 0.22,
        kind: 'sampled',
      },
    ],
    coverage: [
      { intervalId: 'COV-B-1', segmentId: 'SEG-B-H1', stratumId: 'STR-H', fromKm: 0, toKm: 10 },
      { intervalId: 'COV-B-2', segmentId: 'SEG-B-M1', stratumId: 'STR-M', fromKm: 20, toKm: 29 },
      { intervalId: 'COV-B-3', segmentId: 'SEG-B-L1', stratumId: 'STR-L', fromKm: 50, toKm: 61 },
    ],
    uninspected: [
      { partId: 'UN-B-1', segmentId: 'SEG-B-M1', lengthKm: 1, reason: 'CCTV 爬行器故障，台班中断' },
      { partId: 'UN-B-2', segmentId: 'SEG-B-L1', lengthKm: 3, reason: '低风险段物业小区内管线，进场许可未办结' },
    ],
    observations: [
      // H 层 5 处
      pointDefect('OBS-B-1', 'SEG-B-H1', 'STR-H', 1.2, 'D-H-101'),
      pointDefect('OBS-B-2', 'SEG-B-H1', 'STR-H', 3.5, 'D-H-102'),
      pointDefect('OBS-B-3', 'SEG-B-H1', 'STR-H', 5.8, 'D-H-103'),
      pointDefect('OBS-B-4', 'SEG-B-H1', 'STR-H', 7.4, 'D-H-104'),
      pointDefect('OBS-B-5', 'SEG-B-H1', 'STR-H', 9.1, 'D-H-105'),
      // M 层 3 处
      pointDefect('OBS-B-6', 'SEG-B-M1', 'STR-M', 21.5, 'D-M-101'),
      pointDefect('OBS-B-7', 'SEG-B-M1', 'STR-M', 24.2, 'D-M-102'),
      pointDefect('OBS-B-8', 'SEG-B-M1', 'STR-M', 27.9, 'D-M-103'),
      // L 层 1 处
      pointDefect('OBS-B-9', 'SEG-B-L1', 'STR-L', 55.3, 'D-L-101'),
    ],
    note: '乙承包商按分层随机设计覆盖三层，低风险层仍有 39km 未覆盖。',
  };

  return [batchA, batchB];
}

/** 供 UI 展示的参考结论（与估计器实算一致，测试中独立复算） */
export function expectedSampleFigures() {
  const [a, b] = buildSampleBatches();
  return {
    raw: {
      A: rawObservationView(a),
      B: rawObservationView(b),
    },
    design: {
      A: estimateDensity(a, 'design'),
      B: estimateDensity(b, 'design'),
    },
    calibrated: {
      A: estimateDensity(a, 'calibrated'),
      B: estimateDensity(b, 'calibrated'),
    },
  };
}
