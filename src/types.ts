// ============================================================
// 交付契约平台 · 共享领域类型
// 所有跨层（领域逻辑 / Worker / IndexedDB / UI）结构均定义于此
// ============================================================

export type Role = 'builder' | 'supervisor' | 'auditor' | 'admin';

export type Purpose = 'deliver' | 'review' | 'audit';

/** 字段组：授权交集的“字段组”维度 */
export type FieldGroup =
  | 'identity' // 报告号 / 修订号 / 缺陷ID
  | 'location' // 标段 / 坐标
  | 'measurement' // 裂缝宽度 / 检测方法
  | 'workflow' // 整改状态 / 核验时间
  | 'media' // 影像原件引用
  | 'attachmentIndex' // 经授权的附件索引
  | 'assurance'; // 哈希 / 签名 / 修订链

export type FieldValueType =
  | 'string'
  | 'integer'
  | 'decimal'
  | 'datetime'
  | 'enum'
  | 'coordinate'
  | 'attachmentRefs'
  | 'hash'
  | 'signature';

/** 字段契约：明确类型、单位、舍入精度、空值含义、枚举、来源与可见角色 */
export interface FieldContract {
  key: string;
  label: string;
  group: FieldGroup;
  valueType: FieldValueType;
  unit?: string;
  /** 保留小数位（舍入精度） */
  scale?: number;
  /** 仪器检出限；低于此值必须表达为“<检出限”，严禁舍入成 0 */
  detectionLimit?: number;
  /** 空值的业务含义（null 绝不等于 0 / 未整改） */
  nullMeaning: string;
  required: boolean;
  enumValues?: { value: string; label: string }[];
  /** 数据来源系统 / 责任方 */
  source: string;
  /** 契约层面允许可见的角色（最终还需与授权许可求交集） */
  visibleRoles: Role[];
  description?: string;
}

// ---------------- 源数据 ----------------

export interface Coordinate {
  /** 地方工程坐标系 X（米，源数据保留 3 位小数） */
  x: number;
  y: number;
}

export type RectificationStatus = 'open' | 'in_progress' | 'rectified' | 'verified';

export type DetectionMethod = 'visual' | 'crack_gauge' | 'ultrasonic' | 'ground_penetrating_radar';

export interface Defect {
  defectId: string;
  projectId: string;
  sectionId: string;
  coordinate: Coordinate | null;
  /** 裂缝宽度原始读数（毫米，可能低于检出限；null 表示未测量） */
  crackWidthMm: number | null;
  detectionMethod: DetectionMethod | null;
  imageSummary: string | null;
  rectificationStatus: RectificationStatus | null;
  verifiedAt: string | null;
  attachmentIds: string[];
}

export interface Attachment {
  attachmentId: string;
  projectId: string;
  sectionId: string;
  defectId: string | null;
  filename: string;
  kind: 'photo' | 'reading' | 'certificate' | 'internal';
  contentType: string;
  /** 演示环境中以内联 SVG 文本作为“附件原件” */
  contentText: string;
  sha256: string;
  bytes: number;
  /** 是否可进入监理的授权附件索引 */
  supervisorIndexable: boolean;
}

export interface ReportRevision {
  reportNo: string;
  revision: number;
  projectId: string;
  title: string;
  publishedAt: string;
  /** 本修订相对上一修订的变更说明 */
  changeNote: string;
  /** 本修订发生变化的缺陷字段（用于重审标记与差异展示） */
  changes: { defectId: string; field: string; before: unknown; after: unknown }[];
  defects: Defect[];
  /** 对该修订规范化内容计算出的报告哈希 */
  reportHash: string;
  signedBy: string;
  signature: string;
  signedAt: string;
}

export interface Report {
  reportNo: string;
  projectId: string;
  currentRevision: number;
  revisions: ReportRevision[];
}

export interface Project {
  projectId: string;
  name: string;
  sections: { sectionId: string; name: string }[];
}

export interface Account {
  accountId: string;
  username: string;
  password: string;
  displayName: string;
  role: Role;
  org: string;
  /** 施工方账号所属标段；监理/审计为跨标段授权，用许可表达 */
  sectionIds?: string[];
}

// ---------------- 授权 ----------------

export interface Authorization {
  licenseId: string;
  /** 许可版本：换发/变更字段组时递增，物化包固定此版本 */
  licenseVersion: number;
  accountId: string;
  role: Role;
  projectId: string;
  /** 授权标段；['*'] 表示项目内全部标段 */
  sectionIds: string[];
  fieldGroups: FieldGroup[];
  purposes: Purpose[];
  validFrom: string;
  validUntil: string;
  status: 'active' | 'revoked';
  issuedAt: string;
  revokedAt?: string;
  revokeReason?: string;
}

/** 六维交集的逐维结论 */
export interface AuthDimensionTrace {
  dimension: 'project' | 'section' | 'role' | 'fieldGroup' | 'purpose' | 'validity';
  label: string;
  required: string;
  granted: string;
  passed: boolean;
}

// ---------------- 投影编译器 ----------------

export type DecisionOutcome = 'included' | 'excluded' | 'transformed';

export type ReasonCode =
  | 'included'
  | 'contract_role_denied'
  | 'project_not_authorized'
  | 'section_not_authorized'
  | 'role_license_mismatch'
  | 'field_group_not_licensed'
  | 'purpose_not_licensed'
  | 'license_revoked'
  | 'license_expired'
  | 'license_not_yet_valid'
  | 'below_detection_limit'
  | 'rounded_to_contract_scale'
  | 'coordinate_precision_applied'
  | 'null_meaning_preserved'
  | 'attachment_unauthorized_section'
  | 'attachment_not_in_authorized_index'
  | 'source_revision_pinned';

export interface FieldReason {
  code: ReasonCode;
  message: string;
}

export interface FieldDecision {
  uid: string;
  entityType: 'report' | 'defect' | 'attachment';
  entityId: string;
  fieldKey: string;
  fieldLabel: string;
  outcome: DecisionOutcome;
  reasons: FieldReason[];
}

export interface ProjectedField<T = unknown> {
  value: T;
  /** 展示文本（含单位 / 检出限表达 / 空值语义） */
  display: string;
  unit?: string;
  decision: FieldDecision;
}

export interface ProjectedDefect {
  defectId: string;
  sectionId?: ProjectedField<string>;
  coordinate?: ProjectedField<{ x: string; y: string }>;
  crackWidth?: ProjectedField<string | number | null> & { belowDetectionLimit?: boolean };
  detectionMethod?: ProjectedField<string>;
  imageSummary?: ProjectedField<string>;
  rectificationStatus?: ProjectedField<string>;
  verifiedAt?: ProjectedField<string>;
  attachments?: ProjectedField<ProjectedAttachmentRef[]>;
}

export interface ProjectedAttachmentRef {
  attachmentId: string;
  filename: string;
  kind: Attachment['kind'];
  sha256: string;
  bytes: number;
  indexOnly: boolean;
}

export interface Projection {
  projectionId: string;
  generatedAt: string;
  mode: 'dynamic' | 'materialized';
  projectId: string;
  reportNo: string;
  revision: number;
  receiverAccountId: string;
  receiverRole: Role;
  purpose: Purpose;
  /** 授权快照（固定许可版本）；无有效许可时为 null */
  licenseSnapshot: Pick<
    Authorization,
    'licenseId' | 'licenseVersion' | 'fieldGroups' | 'sectionIds' | 'purposes'
  > | null;
  contractVersion: string;
  sourceReportHash: string;
  reportHeader: Record<string, ProjectedField>;
  defects: ProjectedDefect[];
  attachmentIndex: ProjectedAttachmentRef[];
  assurance?: {
    reportHash: string;
    signature: string;
    signedBy: string;
    signedAt: string;
    revisionChain: { revision: number; reportHash: string; signedAt: string; changeNote: string }[];
  };
  decisions: FieldDecision[];
  authTrace: AuthDimensionTrace[];
  /** 整体拒绝原因（如项目级无授权 / 许可撤销） */
  deniedReason?: FieldReason;
}

// ---------------- 交付包与校验 ----------------

export interface ValidationCheck {
  id: 'required-fields' | 'units' | 'signature' | 'attachment-refs' | 'report-hash' | 'auth-version';
  label: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

export interface ValidationReport {
  valid: boolean;
  checks: ValidationCheck[];
  validatedAt: string;
}

export type PackageStatus = 'available' | 'release_blocked' | 'superseded';

export interface PackagePins {
  contractVersion: string;
  licenseId: string;
  licenseVersionAtMaterialize: number;
  reportNo: string;
  revision: number;
  sourceReportHash: string;
}

export interface DeliveryPackage {
  packageId: string;
  kind: 'materialized' | 'dynamic';
  projectId: string;
  reportNo: string;
  revision: number;
  receiverAccountId: string;
  receiverName: string;
  receiverRole: Role;
  purpose: Purpose;
  pins: PackagePins;
  projection: Projection;
  manifest: {
    requiredPaths: string[];
    units: Record<string, string>;
    files: { path: string; sha256: string; bytes: number }[];
  };
  reportHash: string;
  signer: string;
  algorithm: 'HMAC-SHA256-DEMO';
  signature: string;
  status: PackageStatus;
  createdAt: string;
  downloadCount: number;
  lastReleaseAt?: string;
  /** 演示“传输中/存储后被篡改”开关：为 true 时 payload 与签名不一致 */
  tampered: boolean;
  auditEventIds: string[];
}

// ---------------- 回执账 ----------------

export type ReceiptType =
  | 'transmit_received'
  | 'structure_parsed'
  | 'semantic_confirmed'
  | 'questioned'
  | 'corrected';

export interface Receipt {
  receiptId: string;
  /** 同一接收方 + 报告修订构成一本语义账 */
  ledgerKey: string;
  projectId: string;
  reportNo: string;
  revision: number;
  receiverAccountId: string;
  receiverName: string;
  receiverRole: Role;
  type: ReceiptType;
  at: string;
  note?: string;
  packageId?: string;
  /** corrected 类型：指向被更正的旧修订 / 回执 */
  correctsRevision?: number;
  correctsReceiptId?: string;
  /** 传输回执等机器来源标记 */
  source: 'receiver' | 'gateway' | 'platform';
}

export type LedgerState =
  | 'none'
  | 'transmit_received'
  | 'structure_parsed'
  | 'semantic_confirmed'
  | 'questioned'
  | 'conflict'
  | 'adjudicated_confirm'
  | 'adjudicated_question'
  | 'corrected';

export interface Adjudication {
  adjudicationId: string;
  ledgerKey: string;
  at: string;
  adminAccountId: string;
  outcome: 'uphold_confirmation' | 'uphold_question';
  rationale: string;
}

// ---------------- 离线审阅意见 ----------------

export type CommentSyncState = 'local-only' | 'pending' | 'synced' | 'merge-conflict';

export interface ReviewComment {
  /** 意见ID：离线创建即生成，恢复联网后按此 ID 合并 */
  commentId: string;
  projectId: string;
  reportNo: string;
  defectId: string;
  body: string;
  authorAccountId: string;
  authorName: string;
  /** 基线版本：离线意见必须绑定某个报告修订与哈希 */
  baseline: {
    reportNo: string;
    revision: number;
    reportHash: string;
    packageId?: string;
  };
  createdAt: string;
  updatedAt: string;
  syncState: CommentSyncState;
  /** 服务端已存在同 ID 且更新时，保存服务端文本供冲突裁定 */
  serverBody?: string;
  serverUpdatedAt?: string;
  /** 合并后计算：基线之后相关字段发生变化，需对新修订重审 */
  needsReReviewFor?: number;
  changedFields?: string[];
}

export interface ReceiptDraft {
  draftId: string;
  ledgerKey: string;
  projectId: string;
  reportNo: string;
  revision: number;
  receiverAccountId: string;
  type: ReceiptType;
  note?: string;
  createdAt: string;
  syncState: 'local-only' | 'pending';
}

// ---------------- 审计 ----------------

export type AuditEventType =
  | 'package_materialized'
  | 'package_released'
  | 'package_release_blocked'
  | 'package_rebuilt'
  | 'dynamic_projection_generated'
  | 'validation_failed'
  | 'license_revoked'
  | 'license_renewed'
  | 'revision_published'
  | 'comments_merged'
  | 'receipt_registered'
  | 'conflict_adjudicated'
  | 'offline_edit_blocked'
  | 'sampling_batch_saved'
  | 'sampling_batch_deleted';

export interface AuditEvent {
  eventId: string;
  at: string;
  type: AuditEventType;
  actorAccountId: string;
  actorName: string;
  summary: string;
  detail?: Record<string, unknown>;
  /** 已签署交付的审计摘要在任何授权变更后都保留 */
  signedDeliverySummary?: {
    packageId: string;
    reportHash: string;
    signature: string;
    receiverAccountId: string;
    revision: number;
  };
}

// ---------------- 抽检覆盖与缺陷密度估计 ----------------

/** 估计层：按管龄 / 材质 / 风险等级划分的分层（分层校准要求层内可比） */
export interface SamplingStratum {
  stratumId: string;
  label: string;
  /** 分层依据，如 管龄段 / 材质 / 风险等级 */
  basis: string;
  /** 该层在目标总体（登记管网）中的总长度（公里），各层之和=目标总体长度 */
  populationLengthKm: number;
}

/** 计划检查管段框：抽样框中的一个抽选单元 */
export interface PlannedSegment {
  segmentId: string;
  stratumId: string;
  /** 管段在登记管网中的定位描述（桩号 / 管段编号） */
  location: string;
  /** 计划检查长度（公里） */
  plannedLengthKm: number;
  /** 选段原因：风险导向 / 分层随机 / 群众举报复核 / 临时加检 … */
  selectionReason: string;
  /**
   * 已知入样（选段）概率 π。
   * 临时加检没有受控抽样概率时为 null —— 不能补零，也不能据此代表总体。
   */
  inclusionProbability: number | null;
  /** sampled=受控抽样框内单元；ad_hoc=无概率临时加检，仅作补充证据 */
  kind: 'sampled' | 'ad_hoc';
}

/** 实际检查覆盖区间：同一线性参照系（公里桩号）上的实测起止，支持求并集去重 */
export interface CoverageInterval {
  intervalId: string;
  segmentId: string;
  stratumId: string;
  fromKm: number;
  toKm: number;
}

/** 未检部分：计划框内未实际覆盖的长度与原因（空白覆盖不得补零） */
export interface UninspectedPart {
  partId: string;
  segmentId: string;
  /** 未检长度（公里） */
  lengthKm: number;
  /** 未检原因：交通导改 / 仪器故障 / 权属阻挡 / 工期边界 … */
  reason: string;
}

/** 现场缺陷观测区间，观测器将其映射到实际覆盖长度并去重叠 */
export interface DefectObservation {
  observationId: string;
  segmentId: string;
  stratumId: string;
  /** 同一线性参照系上的缺陷起止（公里桩号）；点缺陷可记为等长起止 */
  fromKm: number;
  toKm: number;
  /** 关联缺陷编号（可选） */
  defectRef?: string;
  note?: string;
}

/** 一次承包商抽检批次：保存抽样框、实际覆盖、选段原因、抽样概率与未检原因 */
export interface InspectionBatch {
  batchId: string;
  /** 承包商 / 检测单位 */
  contractor: string;
  projectId: string;
  /** 登记管网范围标识：两条估计路线必须针对同一目标总体 */
  targetNetworkId: string;
  targetNetworkName: string;
  inspectedAt: string;
  /** 分层定义（层长度之和 = 目标总体长度） */
  strata: SamplingStratum[];
  /** 计划检查管段框 */
  plannedSegments: PlannedSegment[];
  /** 实际检查覆盖区间 */
  coverage: CoverageInterval[];
  /** 未检部分（含原因） */
  uninspected: UninspectedPart[];
  /** 现场缺陷观测 */
  observations: DefectObservation[];
  note?: string;
}

export type EstimatorMethod = 'design' | 'calibrated';

/** 单层估计明细 */
export interface StratumEstimate {
  stratumId: string;
  label: string;
  basis: string;
  populationLengthKm: number;
  /** 去重后实际覆盖长度（公里） */
  coveredLengthKm: number;
  plannedLengthKm: number;
  /** 现场观察到的缺陷数（去重叠、且落在实际覆盖内） */
  rawDefectCount: number;
  /** 覆盖区间重叠被剔除的长度（公里） */
  overlapRemovedLengthKm: number;
  /** 该层使用的代表入样概率（无概率层为 null） */
  inclusionProbability: number | null;
  /** 实际采用的权重（设计权重=1/π；校准权重按层内覆盖率推导） */
  weight: number | null;
  /** 加权后缺陷数（对目标总体该层的估计） */
  weightedDefectCount: number | null;
  /** 覆盖段上的观测缺陷率（处/公里），未覆盖层为 null */
  observedRatePerKm: number | null;
  /** 对总体密度（处/公里）的贡献 */
  densityContribution: number | null;
  /** 对总体率估计的方差贡献（率尺度） */
  varianceContribution: number | null;
  /** 该层覆盖率 = 去重覆盖 / 层总体长度 */
  coverageRatio: number;
  /** 校准法下该层无任何覆盖、率值借自其他层（依赖层内可比假设） */
  imputed: boolean;
}

export interface DensityEstimate {
  method: EstimatorMethod;
  targetNetworkId: string;
  targetNetworkName: string;
  targetPopulationLengthKm: number;
  /** 去重后实际覆盖总长度（公里） */
  totalCoveredLengthKm: number;
  /** 覆盖率 = 去重覆盖 / 目标总体长度 */
  coverageRatio: number;
  /** 未覆盖长度（公里，单列，绝不补零） */
  uncoveredLengthKm: number;
  /** 现场观察数（去重叠且落在覆盖内、受控抽样部分） */
  rawObservedCount: number;
  /** 无抽样概率的临时加检观察数（仅补充证据，不入总体估计） */
  adHocObservedCount: number;
  /** 临时加检覆盖长度（公里，仅补充证据） */
  adHocCoveredLengthKm: number;
  /** 因缺陷区间重叠被合并的重复观测数 */
  overlapRemovedDefectCount: number;
  /** 落在任何覆盖区间之外、被剔除的观测数 */
  outsideCoverageCount: number;
  /** 目标总体缺陷总数估计（处） */
  weightedDefectEstimate: number | null;
  /** 每公里目标管网缺陷率（处/公里） */
  densityPerKm: number | null;
  /** 率估计方差与标准误 */
  variance: number | null;
  stdError: number | null;
  /** 变异系数（%） */
  cvPercent: number | null;
  confidenceLevel: number;
  ciLower: number | null;
  ciUpper: number | null;
  strata: StratumEstimate[];
  /** 过程告警（无概率、未覆盖、跨层借用等） */
  warnings: string[];
  /** 是否可对目标总体给出可识别估计（没有任何受控概率层时为 false） */
  identifiable: boolean;
}

// ---------------- 持久化根状态 ----------------

export interface ServerState {
  licenses: Authorization[];
  reports: Record<string, Report>; // key reportNo
  currentReportNo: string;
  adjudications: Adjudication[];
  /** 服务端意见（模拟“云端”，同步合并的对端） */
  serverComments: ReviewComment[];
}

export const CONTRACT_VERSION = 'fc-2026.1';
