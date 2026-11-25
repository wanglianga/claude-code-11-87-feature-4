import { describe, expect, it } from 'vitest';
import type { InspectionBatch } from '../types';
import {
  accountCoverage,
  buildSampleBatches,
  deduplicateObservations,
  estimateDensity,
  mapObservationsToCoverage,
  mergeIntervals,
  rawObservationView,
} from './sampling';

// 样例：同一登记管网 NET-100（100km），高风险20 / 中风险30 / 低风险50
// 甲：高风险 10km 8 处（另 2km 无概率临时加检 1 处）；乙：全网 30km 9 处
const [batchA, batchB] = buildSampleBatches();

describe('观测器：覆盖区间并集去重', () => {
  it('重叠覆盖只计一次：甲的两段 [0,5.2] 与 [4.8,10] 并集为 10km，剔除 0.4km 重叠', () => {
    const cov = accountCoverage(batchA);
    expect(cov.total.rawLengthKm).toBeCloseTo(10.4, 6);
    expect(cov.controlledCoveredKm).toBeCloseTo(10, 6);
    expect(cov.total.overlapRemovedLengthKm).toBeCloseTo(0.4, 6);
    // 临时加检 2km 单独计量，不进受控覆盖
    expect(cov.adHocCoveredKm).toBeCloseTo(2, 6);
    // 未覆盖 = 100 − 10 = 90km
    expect(cov.uncoveredKm).toBeCloseTo(90, 6);
  });

  it('mergeIntervals 处理包含、相接与多段重叠', () => {
    const r = mergeIntervals([
      { fromKm: 2, toKm: 5 },
      { fromKm: 0, toKm: 10 }, // 包含前者
      { fromKm: 10, toKm: 12 }, // 相接
      { fromKm: 13, toKm: 14 },
    ]);
    expect(r.merged).toEqual([
      { fromKm: 0, toKm: 12 },
      { fromKm: 13, toKm: 14 },
    ]);
    expect(r.unionLengthKm).toBe(13);
    expect(r.overlapRemovedLengthKm).toBeCloseTo(3, 6);
  });

  it('缺陷区间重叠被合并：甲高风险 9 条观测 → 8 个 distinct，1 条重复', () => {
    const mapped = mapObservationsToCoverage(batchA);
    expect(mapped.controlledByStratum['STR-H']).toHaveLength(8);
    expect(mapped.overlapRemovedDefectCount).toBe(1);
    // 临时加检观测单独成列
    expect(mapped.adHoc).toHaveLength(1);
    expect(mapped.adHoc[0].defectRef).toBe('D-M-AD1');
  });

  it('deduplicateObservations 对相交点缺陷去重', () => {
    const { distinct, removedCount } = deduplicateObservations([
      { observationId: '1', segmentId: 's', stratumId: 'h', fromKm: 1, toKm: 1.02 },
      { observationId: '2', segmentId: 's', stratumId: 'h', fromKm: 1.01, toKm: 1.03 },
      { observationId: '3', segmentId: 's', stratumId: 'h', fromKm: 5, toKm: 5.02 },
    ]);
    expect(distinct).toHaveLength(2);
    expect(removedCount).toBe(1);
  });

  it('落在覆盖区间之外的观测被剔除，而不是按零处理', () => {
    const synthetic: InspectionBatch = {
      ...batchA,
      batchId: 'BATCH-SYN',
      observations: [
        { observationId: 'X1', segmentId: 'SEG-A-H1', stratumId: 'STR-H', fromKm: 30, toKm: 30.02 },
        { observationId: 'X2', segmentId: 'SEG-A-H1', stratumId: 'STR-H', fromKm: 2, toKm: 2.02 },
      ],
    };
    const mapped = mapObservationsToCoverage(synthetic);
    expect(mapped.outside).toHaveLength(1);
    expect(mapped.outside[0].observationId).toBe('X1');
    expect(mapped.controlledByStratum['STR-H']).toHaveLength(1);
  });
});

describe('未加权现场观察口径（不可直接排名）', () => {
  it('甲 8 处 / 10km = 0.8 处每公里，乙 9 处 / 30km = 0.3；按总条数乙>甲，按朴素率甲>乙', () => {
    const ra = rawObservationView(batchA);
    const rb = rawObservationView(batchB);
    expect(ra.rawControlledCount).toBe(8);
    expect(rb.rawControlledCount).toBe(9);
    expect(ra.naiveRatePerKm).toBeCloseTo(0.8, 6);
    expect(rb.naiveRatePerKm).toBeCloseTo(0.3, 6);
    // 甲的临时加检 1 处不并入受控计数
    expect(ra.adHocCount).toBe(1);
  });
});

describe('设计权重估计（Horvitz–Thompson，w=1/π）', () => {
  it('甲：HT 总量 (4/0.5+4/0.5)=16 处 → 0.16 处/km；方差 V=32 换算率尺度 0.0032，95%CI 可复算', () => {
    const est = estimateDensity(batchA, 'design');
    expect(est.rawObservedCount).toBe(8);
    expect(est.weightedDefectEstimate).toBeCloseTo(16, 6);
    expect(est.densityPerKm).toBeCloseTo(0.16, 6);
    expect(est.variance).toBeCloseTo(32 / 10000, 6);
    expect(est.stdError).toBeCloseTo(Math.sqrt(32) / 100, 6);
    expect(est.ciLower).toBeCloseTo(Math.max(0, 0.16 - 1.96 * Math.sqrt(32) / 100), 6);
    expect(est.ciUpper).toBeCloseTo(0.16 + 1.96 * Math.sqrt(32) / 100, 6);
    expect(est.cvPercent).toBeCloseTo(((Math.sqrt(32) / 100) / 0.16) * 100, 4);
  });

  it('甲只覆盖高风险层：中/低风险层无信息，估计标记为不可完全识别，未覆盖 90km 不补零', () => {
    const est = estimateDensity(batchA, 'design');
    expect(est.identifiable).toBe(false);
    expect(est.coverageRatio).toBeCloseTo(0.1, 6);
    expect(est.uncoveredLengthKm).toBeCloseTo(90, 6);
    const m = est.strata.find((h) => h.stratumId === 'STR-M')!;
    const l = est.strata.find((h) => h.stratumId === 'STR-L')!;
    expect(m.weightedDefectCount).toBeNull();
    expect(l.weightedDefectCount).toBeNull();
    expect(est.warnings.some((w) => w.includes('不提供信息') && w.includes('不补零'))).toBe(true);
  });

  it('乙：三层 HT 合计 5/0.5 + 3/0.25 + 1/0.22 = 26.545… 处 → 0.2655 处/km，可完全识别', () => {
    const est = estimateDensity(batchB, 'design');
    const expectedTotal = 5 / 0.5 + 3 / 0.25 + 1 / 0.22;
    expect(est.weightedDefectEstimate).toBeCloseTo(expectedTotal, 4);
    expect(est.densityPerKm).toBeCloseTo(expectedTotal / 100, 4);
    expect(est.identifiable).toBe(true);
    expect(est.coverageRatio).toBeCloseTo(0.3, 6);
    expect(est.uncoveredLengthKm).toBeCloseTo(70, 6);
    // 各层概率展示
    expect(est.strata.map((h) => h.inclusionProbability)).toEqual([0.5, 0.25, 0.22]);
  });

  it('同口径可比与覆盖率：校正后两估计针对同一 100km 总体；乙三层均有抽样、覆盖率 30% 高于甲 10%，甲不可完全识别而乙可以', () => {
    const ea = estimateDensity(batchA, 'design');
    const eb = estimateDensity(batchB, 'design');
    // 题目样例的关键结论是“不能直接比条数”；校正后两估计针对同一 100km 总体、同口径（处/km）
    expect(ea.targetNetworkId).toBe(eb.targetNetworkId);
    expect(ea.targetPopulationLengthKm).toBe(100);
    expect(eb.targetPopulationLengthKm).toBe(100);
    expect(eb.coverageRatio).toBeGreaterThan(ea.coverageRatio);
    expect(ea.identifiable).toBe(false);
    expect(eb.identifiable).toBe(true);
    // 方差随估计如实披露：甲 V=0.0032（仅高风险层信息），乙含小概率层方差更大但覆盖更全
    expect(ea.variance).toBeCloseTo(0.0032, 6);
    expect(eb.variance).toBeCloseTo((5 / 0.25 + 3 / 0.0625 + 1 / (0.22 * 0.22)) / 10000, 6);
  });

  it('小概率段带来较大方差：乙低风险层 π=0.22 的单位缺陷方差因子 1/π² 高于高风险层 π=0.5', () => {
    const est = estimateDensity(batchB, 'design');
    const h = est.strata.find((x) => x.stratumId === 'STR-H')!;
    const l = est.strata.find((x) => x.stratumId === 'STR-L')!;
    // 每处缺陷的方差因子 1/π²
    expect(1 / (0.22 * 0.22)).toBeGreaterThan(1 / (0.5 * 0.5));
    expect(l.varianceContribution!).toBeCloseTo(1 / (0.22 * 0.22), 4);
    expect(h.varianceContribution!).toBeCloseTo(5 / (0.5 * 0.5), 4);
  });
});

describe('分层校准估计（post-stratification）', () => {
  it('乙：层实测率 × 层登记长度 = 0.5×20 + (3/9)×30 + (1/11)×50 = 24.545… 处', () => {
    const est = estimateDensity(batchB, 'calibrated');
    const expected = 0.5 * 20 + (3 / 9) * 30 + (1 / 11) * 50;
    expect(est.weightedDefectEstimate).toBeCloseTo(expected, 4);
    expect(est.densityPerKm).toBeCloseTo(expected / 100, 4);
    expect(est.identifiable).toBe(true);
    expect(est.strata.every((h) => !h.imputed)).toBe(true);
  });

  it('校准估计比设计权重稳定：乙的校准 CV 不高于设计 CV', () => {
    const design = estimateDensity(batchB, 'design');
    const calibrated = estimateDensity(batchB, 'calibrated');
    expect(calibrated.cvPercent!).toBeLessThanOrEqual(design.cvPercent!);
  });

  it('甲：中/低风险层无覆盖，借用合并率并显式标记 imputed，估计不可完全识别', () => {
    const est = estimateDensity(batchA, 'calibrated');
    const m = est.strata.find((h) => h.stratumId === 'STR-M')!;
    const l = est.strata.find((h) => h.stratumId === 'STR-L')!;
    expect(m.imputed).toBe(true);
    expect(l.imputed).toBe(true);
    expect(est.identifiable).toBe(false);
    expect(est.warnings.some((w) => w.includes('层内可比'))).toBe(true);
    // 高风险层用本层实测率 0.8，不借用
    const h = est.strata.find((x) => x.stratumId === 'STR-H')!;
    expect(h.imputed).toBe(false);
    expect(h.observedRatePerKm).toBeCloseTo(0.8, 6);
  });
});

describe('无抽样概率的临时加检只能作补充证据', () => {
  it('甲的临时加检 1 处 / 2km 不进入任何总体估计口径', () => {
    for (const method of ['design', 'calibrated'] as const) {
      const est = estimateDensity(batchA, method);
      expect(est.adHocObservedCount).toBe(1);
      expect(est.adHocCoveredLengthKm).toBeCloseTo(2, 6);
      expect(est.rawObservedCount).toBe(8);
      expect(est.warnings.some((w) => w.includes('临时加检') && w.includes('补充证据'))).toBe(true);
    }
  });

  it('只有临时加检、没有任何受控概率段时，总体估计不可识别且密度为 null', () => {
    const adHocOnly: InspectionBatch = {
      ...batchA,
      batchId: 'BATCH-ADHOC',
      plannedSegments: [
        {
          segmentId: 'SEG-X',
          stratumId: 'STR-H',
          location: '投诉点临时开挖',
          plannedLengthKm: 1,
          selectionReason: '应急加检，无抽样设计',
          inclusionProbability: null,
          kind: 'ad_hoc',
        },
      ],
      coverage: [{ intervalId: 'C1', segmentId: 'SEG-X', stratumId: 'STR-H', fromKm: 0, toKm: 1 }],
      uninspected: [],
      observations: [{ observationId: 'O1', segmentId: 'SEG-X', stratumId: 'STR-H', fromKm: 0.5, toKm: 0.52 }],
    };
    const design = estimateDensity(adHocOnly, 'design');
    const calibrated = estimateDensity(adHocOnly, 'calibrated');
    expect(design.identifiable).toBe(false);
    expect(design.densityPerKm).toBeNull();
    expect(design.weightedDefectEstimate).toBe(0);
    expect(calibrated.identifiable).toBe(false);
    expect(calibrated.densityPerKm).toBeNull();
    expect(design.adHocObservedCount).toBe(1);
    expect(design.rawObservedCount).toBe(0);
  });
});

describe('未检原因与空白覆盖纪律', () => {
  it('两批次的未检长度都按原因单列，估计中不出现补零', () => {
    const estA = estimateDensity(batchA, 'design');
    const estB = estimateDensity(batchB, 'design');
    expect(batchA.uninspected.reduce((s, p) => s + p.lengthKm, 0)).toBeCloseTo(2, 6);
    expect(batchB.uninspected.reduce((s, p) => s + p.lengthKm, 0)).toBeCloseTo(4, 6);
    expect(estA.warnings.some((w) => w.includes('交通导改') && w.includes('不补零'))).toBe(true);
    expect(estB.warnings.some((w) => w.includes('CCTV') && w.includes('不补零'))).toBe(true);
    // 未覆盖长度恒为 总体 − 受控并集，不因观测数为 0 而改变
    expect(estA.uncoveredLengthKm + estA.totalCoveredLengthKm).toBeCloseTo(100, 6);
    expect(estB.uncoveredLengthKm + estB.totalCoveredLengthKm).toBeCloseTo(100, 6);
  });
});
