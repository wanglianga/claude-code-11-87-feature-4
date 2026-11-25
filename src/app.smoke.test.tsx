// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// 在 jsdom 中把 Worker 客户端替换为直接调用领域实现（Worker 本身由 vite build 单独打包验证）
vi.mock('./state/workerClient', () => ({
  workerApi: {
    compile: async (input: unknown) => {
      const { compileProjection } = await import('./domain/compiler');
      return compileProjection(input as never);
    },
    buildPackage: async (args: unknown) => {
      const { buildDeliveryPackage } = await import('./domain/package');
      return buildDeliveryPackage(args as never);
    },
    validate: async (pkg: unknown, ctx: unknown) => {
      const { validatePackage } = await import('./domain/validator');
      return validatePackage(pkg as never, ctx as never);
    },
  },
}));

import App from './App';
import { StoreProvider } from './state/store';

function renderApp() {
  return render(
    <StoreProvider>
      <App />
    </StoreProvider>,
  );
}

async function bodyMatches(re: RegExp, timeout = 8000) {
  await waitFor(
    () => {
      expect(document.body.textContent ?? '').toMatch(re);
    },
    { timeout, interval: 80 },
  );
}

async function clickButton(re: RegExp) {
  const btn = await screen.findByRole('button', { name: re });
  await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(btn);
  return btn;
}

describe('浏览器全流程冒烟（jsdom + IndexedDB）', () => {
  beforeEach(() => {
    cleanup();
  });

  it('登录后完整推演题目剧本并遍历所有工作台', async () => {
    renderApp();

    // 1) 启动播种 → 登录页
    const loginBtn = await screen.findByRole('button', { name: /登录并进入控制台/ }, { timeout: 15000 });
    fireEvent.click(loginBtn);

    // 2) 进入场景页
    await screen.findByText(/端到端场景推演/, undefined, { timeout: 8000 });

    // 3) 投影自检
    await clickButton(/运行投影自检/);
    await bodyMatches(/施工方仅得到本标段\(B1\) 3 条缺陷/);
    expect(document.body.textContent).toMatch(/低于检出限/);

    // 4) 离线写入固定ID意见
    await clickButton(/切离线并写入意见/);
    await bodyMatches(/状态 local-only/);

    // 5) 撤销许可
    await clickButton(/撤销施工方许可/);
    await bodyMatches(/许可已撤销/);

    // 6) 发布修订2
    await clickButton(/签署并发布修订2/);
    await bodyMatches(/当前修订 r2/);

    // 7) 联网同步合并 → 重审标记
    await clickButton(/恢复联网并同步合并/);
    await bodyMatches(/重审目标\s*r?2/, 10000);

    // 8) 旧包释放被拦截（修订 + 授权双重原因）
    await clickButton(/尝试释放旧的修订1包/);
    await bodyMatches(/已拦截：/, 10000);
    expect(document.body.textContent).toMatch(/报告已修订至 r2/);

    // 9) 传输回执不是语义确认
    await clickButton(/登记.?传输已收到/);
    await bodyMatches(/语义确认=false/);

    // 10) 确认 + 质疑 → 冲突 → 管理员裁定
    await clickButton(/登记语义确认/);
    await clickButton(/同时提出质疑/);
    await bodyMatches(/切换到管理员进行裁定/);
    await clickButton(/切换到管理员进行裁定/);
    await bodyMatches(/裁定：质疑成立（需重审）/);
    await clickButton(/裁定：质疑成立（需重审）/);
    await bodyMatches(/已裁定：质疑成立/);

    // 11) 编译工作台：真实走 mock worker 编译 + 校验
    fireEvent.click(screen.getByRole('button', { name: /交付编译/ }));
    await screen.findByText(/动态投影编译器/);
    await clickButton(/实时生成动态投影并校验/);
    await bodyMatches(/字段级过滤原因账本/, 10000);
    expect(document.body.textContent).toMatch(/包校验器实时报告/);

    // 12) 交付包页
    fireEvent.click(screen.getByRole('button', { name: /签名交付包/ }));
    await bodyMatches(/物化并签名新包/);
    expect(document.body.textContent).toMatch(/PKG_/);

    // 13) 离线审阅页（当前是管理员 → 切换施工方）
    fireEvent.click(screen.getByRole('button', { name: /离线审阅/ }));
    await bodyMatches(/审阅意见必须以施工方或监理/);
    await clickButton(/切换到施工方王建国/);
    await bodyMatches(/可审阅缺陷/);
    fireEvent.click(screen.getByRole('button', { name: /回执草案/ }));
    await bodyMatches(/新建回执草案/);

    // 14) 回执账页
    fireEvent.click(screen.getByRole('button', { name: /回执账/ }));
    await bodyMatches(/登记回执/);
    expect(document.body.textContent).toMatch(/冲突已裁定|冲突裁定队列/);

    // 15) 历史页三个子页签
    fireEvent.click(screen.getByRole('button', { name: /版本与审计/ }));
    await bodyMatches(/修订1 → 修订2 字段差异/);
    fireEvent.click(screen.getByRole('button', { name: /审阅意见历史/ }));
    await bodyMatches(/全部审阅意见/);
    fireEvent.click(screen.getByRole('button', { name: /审计账本/ }));
    await bodyMatches(/审计账本（/);
    expect(document.body.textContent).toMatch(/package_release_blocked/);

    // 16) 契约与授权页 + 模拟器
    fireEvent.click(screen.getByRole('button', { name: /契约与授权/ }));
    await bodyMatches(/字段契约注册表/);
    expect(document.body.textContent).toMatch(/授权六维交集模拟器/);

    // 17) 抽检覆盖校正工作台：样例甲乙对比、两种估计、批次编辑器
    fireEvent.click(screen.getByRole('button', { name: /抽检覆盖校正/ }));
    await bodyMatches(/样例核验：甲 vs 乙/);
    // 现场观察与加权估计分区呈现
    expect(document.body.textContent).toMatch(/现场观察（未加权/);
    expect(document.body.textContent).toMatch(/加权总体估计/);
    // 未覆盖不补零、临时加检补充证据
    expect(document.body.textContent).toMatch(/未覆盖长度（不补零）/);
    expect(document.body.textContent).toMatch(/临时加检：补充证据/);
    // 默认设计权重：甲 0.16 处/km、乙 0.2655 处/km（同一 100km 总体）
    await bodyMatches(/0\.16/);
    // 切换到分层校准
    fireEvent.click(screen.getByRole('button', { name: /分层校准/ }));
    await bodyMatches(/imputed 借用|借用合并率/);
    // 打开新建批次编辑器并取消
    fireEvent.click(screen.getByRole('button', { name: /新建批次/ }));
    await bodyMatches(/批次元信息/);
    fireEvent.click(screen.getByRole('button', { name: /取消/ }));
  }, 120000);

  it('刷新式重新挂载后 IndexedDB 数据仍在（持久化）', async () => {
    // 上一个用例已在同一个 fake-indexeddb 中完成全流程；重新渲染应直接进入已登录态（session 已持久化）
    renderApp();
    // session 中保存的是管理员（最后切换），因此直接看到侧边导航
    const nav = await screen.findAllByRole('button', { name: /场景推演/ }, { timeout: 15000 });
    expect(nav.length).toBeGreaterThan(0);
    await bodyMatches(/当前修订 r2|签署并发布修订2/);
  }, 30000);
});
