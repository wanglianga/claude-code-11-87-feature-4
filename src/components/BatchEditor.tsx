import { useState } from 'react';
import type {
  CoverageInterval,
  DefectObservation,
  InspectionBatch,
  PlannedSegment,
  SamplingStratum,
  UninspectedPart,
} from '../types';
import { uid } from '../domain/hash';
import { Btn } from './ui';

// ============================================================
// 抽检批次编辑器：维护“计划框 / 实际覆盖 / 未检原因 / 观测”四张表
// 数字输入在本地以字符串暂存，保存时统一解析；抽样概率留空 = 无概率
// （仅 kind=ad_hoc 允许，受控段缺失概率会在保存校验中提示）。
// ============================================================

function num(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export default function BatchEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: InspectionBatch;
  onSave: (batch: InspectionBatch) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [meta, setMeta] = useState({
    batchId: initial.batchId,
    contractor: initial.contractor,
    targetNetworkId: initial.targetNetworkId,
    targetNetworkName: initial.targetNetworkName,
    inspectedAt: initial.inspectedAt.slice(0, 16),
    note: initial.note ?? '',
  });
  const [strata, setStrata] = useState<SamplingStratum[]>(initial.strata.map((h) => ({ ...h })));
  const [segments, setSegments] = useState<PlannedSegment[]>(initial.plannedSegments.map((x) => ({ ...x })));
  const [coverage, setCoverage] = useState<CoverageInterval[]>(initial.coverage.map((x) => ({ ...x })));
  const [uninspected, setUninspected] = useState<UninspectedPart[]>(initial.uninspected.map((x) => ({ ...x })));
  const [observations, setObservations] = useState<DefectObservation[]>(initial.observations.map((x) => ({ ...x })));
  const [error, setError] = useState<string | null>(null);

  function update<T extends object>(list: T[], set: (v: T[]) => void, idx: number, patch: Partial<T>) {
    set(list.map((item, i) => (i === idx ? { ...item, ...patch } : item)));
  }
  function remove<T>(list: T[], set: (v: T[]) => void, idx: number) {
    set(list.filter((_, i) => i !== idx));
  }

  function handleSave() {
    if (!meta.contractor.trim()) return setError('请填写承包商 / 检测单位名称。');
    if (!meta.targetNetworkName.trim()) return setError('请填写目标登记管网名称。');
    const popTotal = strata.reduce((s, h) => s + h.populationLengthKm, 0);
    if (!(popTotal > 0)) return setError('分层登记长度之和必须大于 0（目标总体长度）。');
    for (const seg of segments) {
      if (seg.kind === 'sampled' && (seg.inclusionProbability === null || seg.inclusionProbability <= 0)) {
        return setError(`受控抽样管段 ${seg.segmentId} 缺少有效的抽样概率 π；无概率请改为“临时加检”。`);
      }
      if (seg.inclusionProbability !== null && (seg.inclusionProbability <= 0 || seg.inclusionProbability > 1)) {
        return setError(`管段 ${seg.segmentId} 的抽样概率必须在 (0, 1] 区间。`);
      }
    }
    for (const c of coverage) {
      if (!(c.toKm > c.fromKm)) return setError(`覆盖区间 ${c.intervalId} 的止桩号必须大于起桩号。`);
    }

    const batch: InspectionBatch = {
      ...initial,
      batchId: meta.batchId.trim() || uid('BATCH'),
      contractor: meta.contractor.trim(),
      targetNetworkId: meta.targetNetworkId.trim(),
      targetNetworkName: meta.targetNetworkName.trim(),
      inspectedAt: new Date(meta.inspectedAt).toISOString(),
      note: meta.note.trim() || undefined,
      strata,
      plannedSegments: segments,
      coverage,
      uninspected,
      observations,
    };
    void onSave(batch);
  }

  return (
    <div className="editor">
      {error && <div className="banner banner-danger mb12">❌ {error}</div>}

      {/* 元信息 */}
      <section className="editor-section">
        <h4>批次元信息</h4>
        <div className="form-grid">
          <label className="form-row">
            批次ID
            <input className="input mono" value={meta.batchId} onChange={(e) => setMeta({ ...meta, batchId: e.target.value })} />
          </label>
          <label className="form-row">
            承包商 / 检测单位
            <input className="input" value={meta.contractor} onChange={(e) => setMeta({ ...meta, contractor: e.target.value })} />
          </label>
          <label className="form-row">
            目标管网ID
            <input className="input mono" value={meta.targetNetworkId} onChange={(e) => setMeta({ ...meta, targetNetworkId: e.target.value })} />
          </label>
          <label className="form-row">
            目标管网名称
            <input className="input" value={meta.targetNetworkName} onChange={(e) => setMeta({ ...meta, targetNetworkName: e.target.value })} />
          </label>
          <label className="form-row">
            检测时间
            <input
              className="input"
              type="datetime-local"
              value={meta.inspectedAt}
              onChange={(e) => setMeta({ ...meta, inspectedAt: e.target.value })}
            />
          </label>
          <label className="form-row">
            备注
            <input className="input" value={meta.note} onChange={(e) => setMeta({ ...meta, note: e.target.value })} />
          </label>
        </div>
      </section>

      {/* 分层 */}
      <section className="editor-section">
        <div className="flex mb8">
          <h4>分层定义（管龄 / 材质 / 风险层）</h4>
          <span className="spacer" />
          <Btn
            size="sm"
            onClick={() =>
              setStrata([
                ...strata,
                { stratumId: uid('STR'), label: '新层', basis: '', populationLengthKm: 0 },
              ])
            }
          >
            ＋ 新增层
          </Btn>
        </div>
        <div className="editor-rows">
          {strata.map((h, i) => (
            <div className="editor-row" key={h.stratumId}>
              <input className="input mono" value={h.stratumId} onChange={(e) => update(strata, setStrata, i, { stratumId: e.target.value })} title="层ID" />
              <input className="input" value={h.label} onChange={(e) => update(strata, setStrata, i, { label: e.target.value })} placeholder="层名称" />
              <input className="input" value={h.basis} onChange={(e) => update(strata, setStrata, i, { basis: e.target.value })} placeholder="分层依据" />
              <input
                className="input"
                type="number"
                value={h.populationLengthKm}
                onChange={(e) => update(strata, setStrata, i, { populationLengthKm: num(e.target.value) })}
                placeholder="层登记长度 km"
              />
              <Btn variant="danger" size="sm" onClick={() => remove(strata, setStrata, i)}>
                删
              </Btn>
            </div>
          ))}
        </div>
        <div className="tiny muted mt8">层登记长度合计：{strata.reduce((s, h) => s + h.populationLengthKm, 0).toFixed(2)} km（= 目标总体长度）</div>
      </section>

      {/* 计划管段框 */}
      <section className="editor-section">
        <div className="flex mb8">
          <h4>计划检查管段框（选段原因 + 抽样概率）</h4>
          <span className="spacer" />
          <Btn
            size="sm"
            onClick={() =>
              setSegments([
                ...segments,
                {
                  segmentId: uid('SEG'),
                  stratumId: strata[0]?.stratumId ?? '',
                  location: '',
                  plannedLengthKm: 0,
                  selectionReason: '',
                  inclusionProbability: null,
                  kind: 'sampled',
                },
              ])
            }
          >
            ＋ 新增管段
          </Btn>
        </div>
        <div className="editor-rows">
          {segments.map((g, i) => (
            <div className="editor-row wide" key={g.segmentId}>
              <input className="input mono" value={g.segmentId} onChange={(e) => update(segments, setSegments, i, { segmentId: e.target.value })} placeholder="管段ID" />
              <select className="select" value={g.stratumId} onChange={(e) => update(segments, setSegments, i, { stratumId: e.target.value })}>
                {strata.map((h) => (
                  <option key={h.stratumId} value={h.stratumId}>
                    {h.label}
                  </option>
                ))}
              </select>
              <input className="input" value={g.location} onChange={(e) => update(segments, setSegments, i, { location: e.target.value })} placeholder="定位/桩号" />
              <input
                className="input"
                type="number"
                value={g.plannedLengthKm}
                onChange={(e) => update(segments, setSegments, i, { plannedLengthKm: num(e.target.value) })}
                placeholder="计划 km"
              />
              <input className="input" value={g.selectionReason} onChange={(e) => update(segments, setSegments, i, { selectionReason: e.target.value })} placeholder="选段原因" />
              <input
                className="input"
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={g.inclusionProbability ?? ''}
                onChange={(e) =>
                  update(segments, setSegments, i, {
                    inclusionProbability: e.target.value === '' ? null : num(e.target.value),
                  })
                }
                placeholder="π（空=无概率）"
              />
              <select
                className="select"
                value={g.kind}
                onChange={(e) => update(segments, setSegments, i, { kind: e.target.value as PlannedSegment['kind'] })}
              >
                <option value="sampled">受控抽样</option>
                <option value="ad_hoc">临时加检</option>
              </select>
              <Btn variant="danger" size="sm" onClick={() => remove(segments, setSegments, i)}>
                删
              </Btn>
            </div>
          ))}
        </div>
      </section>

      {/* 覆盖区间 */}
      <section className="editor-section">
        <div className="flex mb8">
          <h4>实际检查覆盖区间（公里桩号，重叠自动去重）</h4>
          <span className="spacer" />
          <Btn
            size="sm"
            onClick={() =>
              setCoverage([
                ...coverage,
                { intervalId: uid('COV'), segmentId: segments[0]?.segmentId ?? '', stratumId: strata[0]?.stratumId ?? '', fromKm: 0, toKm: 0 },
              ])
            }
          >
            ＋ 新增区间
          </Btn>
        </div>
        <div className="editor-rows">
          {coverage.map((c, i) => (
            <div className="editor-row" key={c.intervalId}>
              <input className="input mono" value={c.intervalId} onChange={(e) => update(coverage, setCoverage, i, { intervalId: e.target.value })} placeholder="区间ID" />
              <select className="select" value={c.segmentId} onChange={(e) => update(coverage, setCoverage, i, { segmentId: e.target.value })}>
                {segments.map((g) => (
                  <option key={g.segmentId} value={g.segmentId}>
                    {g.segmentId}
                  </option>
                ))}
              </select>
              <select className="select" value={c.stratumId} onChange={(e) => update(coverage, setCoverage, i, { stratumId: e.target.value })}>
                {strata.map((h) => (
                  <option key={h.stratumId} value={h.stratumId}>
                    {h.label}
                  </option>
                ))}
              </select>
              <input className="input" type="number" value={c.fromKm} onChange={(e) => update(coverage, setCoverage, i, { fromKm: num(e.target.value) })} placeholder="起 km" />
              <input className="input" type="number" value={c.toKm} onChange={(e) => update(coverage, setCoverage, i, { toKm: num(e.target.value) })} placeholder="止 km" />
              <Btn variant="danger" size="sm" onClick={() => remove(coverage, setCoverage, i)}>
                删
              </Btn>
            </div>
          ))}
        </div>
      </section>

      {/* 未检部分 */}
      <section className="editor-section">
        <div className="flex mb8">
          <h4>未检部分与原因（空白覆盖不补零）</h4>
          <span className="spacer" />
          <Btn
            size="sm"
            onClick={() =>
              setUninspected([
                ...uninspected,
                { partId: uid('UN'), segmentId: segments[0]?.segmentId ?? '', lengthKm: 0, reason: '' },
              ])
            }
          >
            ＋ 新增未检项
          </Btn>
        </div>
        <div className="editor-rows">
          {uninspected.map((u, i) => (
            <div className="editor-row" key={u.partId}>
              <input className="input mono" value={u.partId} onChange={(e) => update(uninspected, setUninspected, i, { partId: e.target.value })} placeholder="未检ID" />
              <select className="select" value={u.segmentId} onChange={(e) => update(uninspected, setUninspected, i, { segmentId: e.target.value })}>
                {segments.map((g) => (
                  <option key={g.segmentId} value={g.segmentId}>
                    {g.segmentId}
                  </option>
                ))}
              </select>
              <input className="input" type="number" value={u.lengthKm} onChange={(e) => update(uninspected, setUninspected, i, { lengthKm: num(e.target.value) })} placeholder="未检 km" />
              <input className="input" value={u.reason} onChange={(e) => update(uninspected, setUninspected, i, { reason: e.target.value })} placeholder="未检原因" />
              <Btn variant="danger" size="sm" onClick={() => remove(uninspected, setUninspected, i)}>
                删
              </Btn>
            </div>
          ))}
        </div>
      </section>

      {/* 缺陷观测 */}
      <section className="editor-section">
        <div className="flex mb8">
          <h4>现场缺陷观测区间（重叠自动合并为 distinct）</h4>
          <span className="spacer" />
          <Btn
            size="sm"
            onClick={() =>
              setObservations([
                ...observations,
                {
                  observationId: uid('OBS'),
                  segmentId: segments[0]?.segmentId ?? '',
                  stratumId: strata[0]?.stratumId ?? '',
                  fromKm: 0,
                  toKm: 0.02,
                  defectRef: '',
                },
              ])
            }
          >
            ＋ 新增观测
          </Btn>
        </div>
        <div className="editor-rows">
          {observations.map((o, i) => (
            <div className="editor-row" key={o.observationId}>
              <input className="input mono" value={o.observationId} onChange={(e) => update(observations, setObservations, i, { observationId: e.target.value })} placeholder="观测ID" />
              <select className="select" value={o.segmentId} onChange={(e) => update(observations, setObservations, i, { segmentId: e.target.value })}>
                {segments.map((g) => (
                  <option key={g.segmentId} value={g.segmentId}>
                    {g.segmentId}
                  </option>
                ))}
              </select>
              <select className="select" value={o.stratumId} onChange={(e) => update(observations, setObservations, i, { stratumId: e.target.value })}>
                {strata.map((h) => (
                  <option key={h.stratumId} value={h.stratumId}>
                    {h.label}
                  </option>
                ))}
              </select>
              <input className="input" type="number" value={o.fromKm} onChange={(e) => update(observations, setObservations, i, { fromKm: num(e.target.value) })} placeholder="起 km" />
              <input className="input" type="number" value={o.toKm} onChange={(e) => update(observations, setObservations, i, { toKm: num(e.target.value) })} placeholder="止 km" />
              <input className="input" value={o.defectRef ?? ''} onChange={(e) => update(observations, setObservations, i, { defectRef: e.target.value })} placeholder="缺陷引用" />
              <Btn variant="danger" size="sm" onClick={() => remove(observations, setObservations, i)}>
                删
              </Btn>
            </div>
          ))}
        </div>
      </section>

      <div className="btn-row mt16">
        <Btn variant="primary" onClick={handleSave}>
          保存批次
        </Btn>
        <Btn variant="ghost" onClick={onCancel}>
          取消
        </Btn>
      </div>
    </div>
  );
}
