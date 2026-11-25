import { useMemo, useState } from 'react';
import type { DensityEstimate, EstimatorMethod, InspectionBatch } from '../types';
import { useStore } from '../state/store';
import {
  accountCoverage,
  buildSampleBatches,
  estimateDensity,
  mapObservationsToCoverage,
  rawObservationView,
  SAMPLE_NETWORK,
  SAMPLE_STRATA,
} from '../domain/sampling';
import { uid } from '../domain/hash';
import { Badge, Btn, Card, Empty, Modal, Stat } from './ui';
import BatchEditor from './BatchEditor';

// ============================================================
// 抽检覆盖校正工作台
// 纪律：现场观察数与加权估计分区呈现；未覆盖单列不补零；
//       无概率临时加检只作补充证据；设计权重与分层校准两条路线
//       始终估计同一登记管网范围的单位长度缺陷率。
// ============================================================

const METHOD_LABELS: Record<EstimatorMethod, string> = {
  design: '设计权重（Horvitz–Thompson，w=1/π）',
  calibrated: '分层校准（层实测率 × 层登记长度）',
};

function fmt(n: number | null | undefined, digits = 3): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

export default function Sampling() {
  const s = useStore();
  const batches = s.samplingBatches;
  const [selectedId, setSelectedId] = useState<string>(batches[0]?.batchId ?? '');
  const [method, setMethod] = useState<EstimatorMethod>('design');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingBatch, setEditingBatch] = useState<InspectionBatch | null>(null);

  const batch = batches.find((b) => b.batchId === selectedId) ?? batches[0];

  const estimate = useMemo<DensityEstimate | null>(
    () => (batch ? estimateDensity(batch, method) : null),
    [batch, method],
  );
  const raw = useMemo(() => (batch ? rawObservationView(batch) : null), [batch]);
  const coverage = useMemo(() => (batch ? accountCoverage(batch) : null), [batch]);
  const mapped = useMemo(() => (batch ? mapObservationsToCoverage(batch) : null), [batch]);

  // 样例甲乙对比（独立于当前选择，始终基于标准样例数据复算）
  const comparison = useMemo(() => {
    const [a, b] = buildSampleBatches();
    return {
      a: { batch: a, raw: rawObservationView(a), design: estimateDensity(a, 'design'), cal: estimateDensity(a, 'calibrated') },
      b: { batch: b, raw: rawObservationView(b), design: estimateDensity(b, 'design'), cal: estimateDensity(b, 'calibrated') },
    };
  }, []);

  function openNew() {
    setEditingBatch(null);
    setEditorOpen(true);
  }
  function openEdit() {
    if (!batch) return;
    setEditingBatch(batch);
    setEditorOpen(true);
  }

  if (!batch || !estimate || !raw || !coverage || !mapped) {
    return (
      <Card>
        <Empty>
          暂无抽检批次。
          <div className="mt12">
            <Btn variant="primary" size="sm" onClick={openNew}>
              新建批次
            </Btn>
          </div>
        </Empty>
      </Card>
    );
  }

  return (
    <div>
      {/* ---------------- 方法学说明 ---------------- */}
      <Card className="mb16">
        <div className="flex gap12 wrap" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 320 }}>
            <Badge tone="brand">为什么不能直接比缺陷条数</Badge>
            <h2 style={{ fontSize: 17, margin: '10px 0 6px' }}>承包商缺陷数不可直接比较：选段机制不同，必须做抽检覆盖校正</h2>
            <p className="small" style={{ color: 'var(--ink-2)' }}>
              一方只查风险段、另一方查了更多低风险长度时，原始缺陷数同时受“真实密度”和“选段概率”影响。
              本工作台按批次保存<strong>计划检查管段框、实际检查长度、选段原因、抽样概率与未检原因</strong>；
              观测器把缺陷区间映射到实际覆盖长度并去除重叠；估计器输出每公里目标管网的缺陷率、置信范围与未覆盖部分。
            </p>
          </div>
          <div className="btn-row">
            <Btn variant="primary" size="sm" onClick={openNew}>
              ＋ 新建批次
            </Btn>
            <Btn variant="ghost" size="sm" onClick={openEdit}>
              编辑当前批次
            </Btn>
            <Btn
              variant="danger"
              size="sm"
              onClick={() => {
                if (window.confirm(`确认删除批次 ${batch.batchId}？该操作不可恢复。`)) void s.deleteSamplingBatch(batch.batchId);
              }}
            >
              删除当前批次
            </Btn>
          </div>
        </div>
      </Card>

      {/* ---------------- 样例核验面板 ---------------- */}
      <SampleComparison comparison={comparison} />

      {/* ---------------- 批次选择 ---------------- */}
      <div className="flex gap8 wrap mb16">
        {batches.map((b) => (
          <button
            key={b.batchId}
            className={`batch-tab ${b.batchId === batch.batchId ? 'active' : ''}`}
            onClick={() => setSelectedId(b.batchId)}
          >
            <span className="batch-tab-id">{b.batchId}</span>
            <span className="batch-tab-name">{b.contractor}</span>
          </button>
        ))}
      </div>

      {/* ---------------- 批次元信息 ---------------- */}
      <Card title={`${batch.contractor} · 批次 ${batch.batchId}`} sub={`${batch.targetNetworkName}（${batch.targetNetworkId}）· 检测时间 ${new Date(batch.inspectedAt).toLocaleString('zh-CN')}`}>
        <div className="stat-grid">
          <Stat label="目标总体长度" value={`${fmt(estimate.targetPopulationLengthKm, 1)} km`} hint="登记管网范围，两条估计路线口径一致" tone="brand" />
          <Stat label="受控覆盖（并集去重后）" value={`${fmt(estimate.totalCoveredLengthKm, 2)} km`} hint={`原始覆盖跨度 ${fmt(coverage.total.rawLengthKm, 2)} km`} tone="teal" />
          <Stat label="覆盖率" value={pct(estimate.coverageRatio)} hint="受控覆盖 / 目标总体长度" />
          <Stat label="未覆盖长度（不补零）" value={`${fmt(estimate.uncoveredLengthKm, 2)} km`} hint="按未检原因单列，绝不按 0 缺陷处理" tone="warn" />
        </div>
        {batch.note && <div className="banner banner-neutral mt8">📝 {batch.note}</div>}
      </Card>

      {/* ---------------- 方法切换 ---------------- */}
      <div className="subtabs">
        {(['design', 'calibrated'] as const).map((m) => (
          <button key={m} className={`subtab ${method === m ? 'active' : ''}`} onClick={() => setMethod(m)}>
            {METHOD_LABELS[m]}
          </button>
        ))}
      </div>

      {/* ---------------- 现场观察 vs 加权估计（严格分区） ---------------- */}
      <div className="grid-2">
        <Card title="① 现场观察（未加权，只陈述事实）" sub="发生了什么：distinct 缺陷数与实际检查公里；不能跨承包商直接排名">
          <div className="stat-grid">
            <Stat label="现场 distinct 缺陷数" value={raw.rawControlledCount} hint={`去重叠合并 ${estimate.overlapRemovedDefectCount} 条重复观测`} tone="teal" />
            <Stat label="实际检查长度" value={`${fmt(raw.controlledCoveredKm, 2)} km`} hint="覆盖区间并集，重叠只计一次" />
            <Stat label="朴素缺陷率（未校正）" value={`${fmt(raw.naiveRatePerKm, 3)} 处/km`} hint="受选段机制影响，不代表目标总体" tone="warn" />
            <Stat label="覆盖外被剔除观测" value={estimate.outsideCoverageCount} hint="落在实际覆盖之外，不反推缺陷" tone="danger" />
          </div>
          <div className="banner banner-warn">
            <span className="bi">⚠️</span>
            <div>
              现场观察数 <strong>不做总体推断</strong>：甲查高风险段 10km 见 8 处、乙查全网 30km 见 9 处，
              选段概率差异未校正前，“8 处 vs 9 处”“0.8 vs 0.3 处/km”都不能作为承包商质量排名依据。
            </div>
          </div>
        </Card>

        <Card
          title="② 加权总体估计（校正后，对目标总体推断）"
          sub={`${METHOD_LABELS[method]} · 目标总体 ${estimate.targetNetworkName}`}
          extra={
            estimate.identifiable ? (
              <Badge tone="ok">可完全识别</Badge>
            ) : (
              <Badge tone="warn" title="存在无受控覆盖的层，未覆盖部分不补零">
                部分不可识别
              </Badge>
            )
          }
        >
          <div className="stat-grid">
            <Stat label="估计缺陷总数" value={`${fmt(estimate.weightedDefectEstimate, 2)} 处`} hint="加权后对 100km 登记管网的总量估计" tone="brand" />
            <Stat label="缺陷率（每公里目标管网）" value={`${fmt(estimate.densityPerKm, 4)} 处/km`} hint="与另一承包商同口径可比" tone="brand" />
            <Stat label="标准误 SE" value={fmt(estimate.stdError, 4)} hint={`方差 ${fmt(estimate.variance, 6)}（率尺度）`} />
            <Stat label={`${(estimate.confidenceLevel * 100).toFixed(0)}% 置信范围`} value={`[${fmt(estimate.ciLower, 3)}, ${fmt(estimate.ciUpper, 3)}]`} hint="处/km，正态近似（下界截断于 0）" />
            <Stat label="变异系数 CV" value={`${fmt(estimate.cvPercent, 1)}%`} hint="小概率段会显著推高 CV" tone="warn" />
            <Stat label="临时加检（补充证据）" value={`${estimate.adHocObservedCount} 处 / ${fmt(estimate.adHocCoveredLengthKm, 1)}km`} hint="无抽样概率，不进入左侧总体估计" tone="purple" />
          </div>
          {!estimate.identifiable && (
            <div className="banner banner-danger">
              <span className="bi">⛔</span>
              <div>
                存在<strong>无受控抽样覆盖的层</strong>：未覆盖长度 {fmt(estimate.uncoveredLengthKm, 2)} km 单列，
                <strong>不能用空白覆盖补零</strong>。下列数字仅来自有信息层，总体结论须连同未覆盖部分一起阅读。
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* ---------------- 过程告警 ---------------- */}
      {estimate.warnings.length > 0 && (
        <Card title="估计过程告警与假设披露">
          <ul className="warn-list">
            {estimate.warnings.map((w, i) => (
              <li key={i} className="warn-item">
                <span className="warn-dot" />
                {w}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ---------------- 分层明细表 ---------------- */}
      <Card title="分层估计明细" sub="每层的覆盖、观察数、权重/率、方差贡献与覆盖率；借用合并率的层显式标记 imputed">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>层</th>
                <th>分层依据</th>
                <th>层登记长度(km)</th>
                <th>受控覆盖(km)</th>
                <th>覆盖率</th>
                <th>现场缺陷数</th>
                <th>代表入样概率 π</th>
                <th>实测率(处/km)</th>
                <th>加权缺陷数</th>
                <th>方差贡献(率尺度)</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {estimate.strata.map((h) => (
                <tr key={h.stratumId}>
                  <td>
                    <strong>{h.label}</strong>
                    <div className="tiny muted mono">{h.stratumId}</div>
                  </td>
                  <td className="small">{h.basis}</td>
                  <td className="mono">{fmt(h.populationLengthKm, 1)}</td>
                  <td className="mono">
                    {fmt(h.coveredLengthKm, 2)}
                    {h.overlapRemovedLengthKm > 0 && <div className="tiny tone-warn">去重叠 {fmt(h.overlapRemovedLengthKm, 2)}</div>}
                  </td>
                  <td className="mono">{pct(h.coverageRatio)}</td>
                  <td className="mono">{h.rawDefectCount}</td>
                  <td className="mono">{h.inclusionProbability === null ? '无概率' : fmt(h.inclusionProbability, 2)}</td>
                  <td className="mono">{fmt(h.observedRatePerKm, 3)}</td>
                  <td className="mono">
                    {h.weightedDefectCount === null ? <span className="muted">不提供信息</span> : fmt(h.weightedDefectCount, 2)}
                  </td>
                  <td className="mono">{h.varianceContribution === null ? '—' : fmt(h.varianceContribution, 6)}</td>
                  <td>
                    {h.imputed ? (
                      <Badge tone="purple" title="无覆盖，借用合并率；依赖层内可比假设">
                        imputed 借用
                      </Badge>
                    ) : h.weightedDefectCount === null ? (
                      <Badge tone="danger">未覆盖·不补零</Badge>
                    ) : (
                      <Badge tone="ok">本层估计</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ---------------- 抽样框 / 覆盖 / 观测 / 未检 / 临时加检 ---------------- */}
      <div className="grid-2">
        <Card title="计划检查管段框（含选段原因与抽样概率）">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>管段</th>
                  <th>层</th>
                  <th>计划长度</th>
                  <th>选段原因</th>
                  <th>π</th>
                  <th>性质</th>
                </tr>
              </thead>
              <tbody>
                {batch.plannedSegments.map((seg) => (
                  <tr key={seg.segmentId}>
                    <td>
                      <div className="mono tiny">{seg.segmentId}</div>
                      <div className="small">{seg.location}</div>
                    </td>
                    <td className="small">{seg.stratumId}</td>
                    <td className="mono">{fmt(seg.plannedLengthKm, 1)} km</td>
                    <td className="small">{seg.selectionReason}</td>
                    <td className="mono">{seg.inclusionProbability === null ? '—' : fmt(seg.inclusionProbability, 2)}</td>
                    <td>
                      {seg.kind === 'ad_hoc' ? <Badge tone="purple">临时加检</Badge> : <Badge tone="teal">受控抽样</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="实际检查覆盖区间（线性桩号，求并集去重）">
          <div className="banner banner-info mb12">
            <span className="bi">📐</span>
            <div>
              原始跨度 {fmt(coverage.total.rawLengthKm, 2)} km → 并集 {fmt(coverage.controlledCoveredKm, 2)} km，
              重叠剔除 {fmt(coverage.total.overlapRemovedLengthKm, 2)} km；临时加检覆盖 {fmt(coverage.adHocCoveredKm, 2)} km 另计。
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>区间</th>
                  <th>管段</th>
                  <th>起(km)</th>
                  <th>止(km)</th>
                  <th>长度</th>
                </tr>
              </thead>
              <tbody>
                {batch.coverage.map((c) => (
                  <tr key={c.intervalId}>
                    <td className="mono tiny">{c.intervalId}</td>
                    <td className="mono small">{c.segmentId}</td>
                    <td className="mono">{fmt(c.fromKm, 2)}</td>
                    <td className="mono">{fmt(c.toKm, 2)}</td>
                    <td className="mono">{fmt(c.toKm - c.fromKm, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="grid-2">
        <Card title={`未检部分（${batch.uninspected.length} 项，按原因单列，不补零）`}>
          {batch.uninspected.length === 0 ? (
            <Empty>本批次无未检部分</Empty>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>管段</th>
                    <th>未检长度(km)</th>
                    <th>未检原因</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.uninspected.map((u) => (
                    <tr key={u.partId}>
                      <td className="mono small">{u.segmentId}</td>
                      <td className="mono tone-warn">{fmt(u.lengthKm, 2)}</td>
                      <td className="small">{u.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="临时加检：补充证据（不能代表总体）">
          {mapped.adHoc.length === 0 ? (
            <Empty>本批次无无概率临时加检</Empty>
          ) : (
            <>
              <div className="banner banner-warn mb12">
                <span className="bi">🧾</span>
                <div>
                  下列 {mapped.adHoc.length} 处观测来自 <strong>无受控抽样概率</strong> 的临时加检（共{' '}
                  {fmt(coverage.adHocCoveredKm, 2)} km）。它们可作为问题线索与补充证据，
                  <strong>但不得加权进入目标总体缺陷率</strong>，也不能因发现缺陷而对未检管网做代表性质态判断。
                </div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>观测</th>
                      <th>管段</th>
                      <th>桩号(km)</th>
                      <th>缺陷引用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mapped.adHoc.map((o) => (
                      <tr key={o.observationId}>
                        <td className="mono tiny">{o.observationId}</td>
                        <td className="mono small">{o.segmentId}</td>
                        <td className="mono">{fmt(o.fromKm, 2)}</td>
                        <td className="small">{o.defectRef ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      </div>

      <Card title={`现场缺陷观测（${batch.observations.length} 条 → distinct ${estimate.rawObservedCount + estimate.adHocObservedCount} 处）`}>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>观测ID</th>
                <th>管段/层</th>
                <th>起(km)</th>
                <th>止(km)</th>
                <th>缺陷引用</th>
                <th>映射结果</th>
              </tr>
            </thead>
            <tbody>
              {batch.observations.map((o) => {
                const isAdHoc = mapped.adHoc.some((x) => x.observationId === o.observationId);
                const isOutside = mapped.outside.some((x) => x.observationId === o.observationId);
                return (
                  <tr key={o.observationId}>
                    <td className="mono tiny">{o.observationId}</td>
                    <td className="small">
                      {o.segmentId} / {o.stratumId}
                    </td>
                    <td className="mono">{fmt(o.fromKm, 2)}</td>
                    <td className="mono">{fmt(o.toKm, 2)}</td>
                    <td className="small">{o.defectRef ?? '—'}</td>
                    <td>
                      {isAdHoc ? (
                        <Badge tone="purple">补充证据·不入估计</Badge>
                      ) : isOutside ? (
                        <Badge tone="danger">覆盖外·已剔除</Badge>
                      ) : (
                        <Badge tone="ok">计入 distinct</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ---------------- 编辑器弹窗 ---------------- */}
      <Modal open={editorOpen} onClose={() => setEditorOpen(false)} title={editingBatch ? `编辑批次 ${editingBatch.batchId}` : '新建抽检批次'} width={1080}>
        <BatchEditor
          initial={editingBatch ?? blankBatch()}
          onCancel={() => setEditorOpen(false)}
          onSave={async (b) => {
            await s.saveSamplingBatch(b);
            setSelectedId(b.batchId);
            setEditorOpen(false);
          }}
        />
      </Modal>
    </div>
  );
}

function blankBatch(): InspectionBatch {
  return {
    batchId: uid('BATCH'),
    contractor: '',
    projectId: 'P',
    targetNetworkId: SAMPLE_NETWORK.targetNetworkId,
    targetNetworkName: SAMPLE_NETWORK.targetNetworkName,
    inspectedAt: new Date().toISOString(),
    strata: SAMPLE_STRATA.map((h) => ({ ...h })),
    plannedSegments: [],
    coverage: [],
    uninspected: [],
    observations: [],
    note: '',
  };
}

// ---------------- 样例甲乙对比 ----------------

function SampleComparison({
  comparison,
}: {
  comparison: {
    a: { batch: InspectionBatch; raw: ReturnType<typeof rawObservationView>; design: DensityEstimate; cal: DensityEstimate };
    b: { batch: InspectionBatch; raw: ReturnType<typeof rawObservationView>; design: DensityEstimate; cal: DensityEstimate };
  };
}) {
  const { a, b } = comparison;
  return (
    <Card
      title="样例核验：甲 vs 乙（同一登记管网 NET-100，100km）"
      sub="甲查高风险区 10km 发现 8 处；乙查全网三层 30km 发现 9 处。观察未加权排名如何在校正后改变，以及方差/覆盖率/临时加检如何披露"
    >
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>口径</th>
              <th>甲承包商（恒基检测）</th>
              <th>乙承包商（市政检测中心）</th>
              <th>解读</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>现场观察（未加权）</strong>
              </td>
              <td className="mono">
                {a.raw.rawControlledCount} 处 / {fmt(a.raw.controlledCoveredKm, 1)} km
                <div className="tiny muted">朴素率 {fmt(a.raw.naiveRatePerKm, 2)} 处/km</div>
              </td>
              <td className="mono">
                {b.raw.rawControlledCount} 处 / {fmt(b.raw.controlledCoveredKm, 1)} km
                <div className="tiny muted">朴素率 {fmt(b.raw.naiveRatePerKm, 2)} 处/km</div>
              </td>
              <td className="small">按总条数乙(9)&gt;甲(8)；按朴素率甲(0.8)&gt;乙(0.3)——两个排名互相矛盾，皆不可用</td>
            </tr>
            <tr>
              <td>
                <strong>设计权重 HT（处/km）</strong>
                <div className="tiny muted">w=1/π，保持总体定义</div>
              </td>
              <td className="mono">
                {fmt(a.design.densityPerKm, 4)}
                <div className="tiny tone-warn">CV {fmt(a.design.cvPercent, 1)}% · 覆盖 {pct(a.design.coverageRatio)}</div>
              </td>
              <td className="mono">
                {fmt(b.design.densityPerKm, 4)}
                <div className="tiny tone-ok">CV {fmt(b.design.cvPercent, 1)}% · 覆盖 {pct(b.design.coverageRatio)}</div>
              </td>
              <td className="small">
                同口径（每公里目标管网）后可比；甲仅高风险层有信息（<Badge tone="warn">部分不可识别</Badge>），乙三层均抽样、覆盖率 3 倍于甲
              </td>
            </tr>
            <tr>
              <td>
                <strong>95% 置信范围</strong>
              </td>
              <td className="mono">
                [{fmt(a.design.ciLower, 3)}, {fmt(a.design.ciUpper, 3)}]
              </td>
              <td className="mono">
                [{fmt(b.design.ciLower, 3)}, {fmt(b.design.ciUpper, 3)}]
              </td>
              <td className="small">小概率段（π=0.22）以 1/π² 放大方差；甲方差仅来自单层，外推风险高</td>
            </tr>
            <tr>
              <td>
                <strong>分层校准（处/km）</strong>
                <div className="tiny muted">层率×层长度，更稳定</div>
              </td>
              <td className="mono">
                {fmt(a.cal.densityPerKm, 4)}
                <div className="tiny tone-purple">中/低风险层 imputed</div>
              </td>
              <td className="mono">{fmt(b.cal.densityPerKm, 4)}</td>
              <td className="small">甲的无覆盖层只能借用合并率，依赖“层内可比”；乙各层均有本层实测率，无需借用</td>
            </tr>
            <tr>
              <td>
                <strong>未覆盖部分</strong>
              </td>
              <td className="mono tone-warn">{fmt(a.design.uncoveredLengthKm, 1)} km（90%）</td>
              <td className="mono tone-warn">{fmt(b.design.uncoveredLengthKm, 1)} km（70%）</td>
              <td className="small">未检长度按交通导改/仪器故障/进场许可等原因单列，绝不补零</td>
            </tr>
            <tr>
              <td>
                <strong>临时加检</strong>
              </td>
              <td className="mono">
                {a.design.adHocObservedCount} 处 / {fmt(a.design.adHocCoveredLengthKm, 1)} km
              </td>
              <td className="mono muted">无</td>
              <td className="small">甲的投诉点加检无抽样概率，只列补充证据，不代表总体、不进加权</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="banner banner-info mt12">
        <span className="bi">🧭</span>
        <div>
          结论：① 缺陷条数与朴素率都不能直接排名；② 两条估计路线针对<strong>同一 100km 登记管网</strong>输出单位长度缺陷率，
          设计权重保持目标总体定义但小概率段方差大，分层校准更稳定但无覆盖层需借用率值（imputed）；
          ③ 甲的估计因 90% 未覆盖而部分不可识别，乙的三层抽样覆盖率更高、可识别性更好；④ 未覆盖不补零、临时加检不外推。
        </div>
      </div>
    </Card>
  );
}
