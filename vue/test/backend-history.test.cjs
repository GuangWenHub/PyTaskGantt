const request = require('supertest');
const session = require('express-session');
const { createApp } = require('../server/app.cjs');

function historyApp() {
  const actor = { id: '7', display_name: '用户甲', auth_provider: 'dev', is_admin: false };
  const calls = [];
  const record = { id: '10', task_id: '1', annotation_version: 0 };
  const app = createApp({
    pool: {},
    config: { authMode: 'dev', corsOrigins: ['http://localhost:5174'], sessionSecret: 'history-test-session-secret', sessionMaxAgeSeconds: 3600 },
    sessionStore: new session.MemoryStore(), logger: { error() {} },
    repositories: {
      users: { findActiveById: async () => actor, findActiveDevById: async () => actor, touchLastLogin: async () => {} },
      tasks: {},
      taskHistory: { list: async (actor, filters) => { calls.push({ type: 'list', actor, filters }); return { records: [record], has_more: false }; } },
    },
    services: {
      taskMutation: {}, taskActions: {}, syncCoordinator: {}, scheduleDirectory: {}, executionDetails: {},
      taskHistory: Object.fromEntries(['annotate', 'preview', 'restore'].map(type => [type, async (...args) => {
        calls.push({ type, args }); return { success: true };
      }])),
    },
  });
  return { app, calls };
}

describe('操作记录 API 会话、参数和来源边界', () => {
  it('匿名不能查看、备注或还原，外部来源不能写入', async () => {
    const { app, calls } = historyApp();
    await request(app).get('/api/task-history').expect(401);
    await request(app).patch('/api/task-history/10/annotation').send({ annotation: 'x', version: 0 }).expect(401);
    await request(app).post('/api/task-history/10/restore').send({ version: 1 }).expect(401);
    const agent = request.agent(app);
    await agent.post('/api/auth/dev/switch').send({ user_id: '7' }).expect(200);
    await agent.post('/api/task-history/10/restore').set('Origin', 'https://outside.example').send({ version: 1 }).expect(403);
    expect(calls).toEqual([]);
  });

  it('从会话传递可信操作人，支持游标分页；拒绝客户端快照和非法参数', async () => {
    const { app, calls } = historyApp();
    const agent = request.agent(app);
    await agent.post('/api/auth/dev/switch').send({ user_id: '7' }).expect(200);
    await agent.get('/api/task-history?task_id=1&actor_id=7&before_id=20&limit=5').expect(200);
    expect(calls[0]).toMatchObject({ actor: { userId: '7', isAdmin: false }, filters: { task_id: '1', actor_id: '7', before_id: '20', limit: 5 } });
    await agent.get('/api/task-history?limit=999').expect(400);
    await agent.get('/api/task-history?before_id=0').expect(400);
    await agent.get('/api/task-history?page=0').expect(400);
    await agent.get('/api/task-history?task_ids=1,invalid').expect(400);
    await agent.get('/api/task-history?task_ids=1,2&page=2&limit=3').expect(200);
    expect(calls.at(-1).filters).toEqual({ task_ids: ['1', '2'], page: 2, limit: 3 });
    await agent.get('/api/task-history?task_ids=').expect(200);
    expect(calls.at(-1).filters.task_ids).toEqual([]);
    await agent.post('/api/task-history/10/restore').send({ version: 4, snapshot: { owner_user_id: '7' } }).expect(400);
    await agent.patch('/api/task-history/10/annotation').send({ annotation: 'x'.repeat(1001), version: 0 }).expect(400);
    await agent.patch('/api/task-history/10/annotation').send({ annotation: '7:30 前没数据', version: 0 }).expect(200);
    await agent.get('/api/task-history/10/restore-preview').expect(200);
    await agent.post('/api/task-history/10/restore').send({ version: 4 }).expect(200);
    expect(calls.find(call => call.type === 'restore').args).toEqual([{ userId: '7', isAdmin: false }, '10', 4]);
  });
});
