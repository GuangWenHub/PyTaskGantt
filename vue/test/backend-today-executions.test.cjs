const request = require('supertest');
const session = require('express-session');
const { createApp } = require('../server/app.cjs');
test('批量今日运行状态要求登录，精确验证ID并保持所有用户可读，不接受写计划参数', async () => {
  const user = { id: '2', auth_provider: 'dev', display_name: '用户' }, read = vi.fn(async () => ({ date: '2026-11-13', tasks: [], records: [] }));
  const app = createApp({ config: { authMode: 'dev', corsOrigins: ['http://localhost:5174'], sessionSecret: 'today-read-test-secret', sessionMaxAgeSeconds: 3600 },
    sessionStore: new session.MemoryStore(), logger: { error() {} },
    repositories: { users: { findActiveById: async () => user, findActiveDevById: async () => user, touchLastLogin: async () => {} }, tasks: {} },
    services: { todayExecutions: { read }, taskMutation: {}, taskActions: {}, syncCoordinator: {}, scheduleDirectory: {}, executionDetails: {} } });
  await request(app).get('/api/tasks/today-executions?task_ids=1').expect(401);
  const agent = request.agent(app); await agent.post('/api/auth/dev/switch').send({ user_id: '2' }).expect(200);
  for (const query of ['task_ids=0', 'task_ids=1,1', 'task_ids=tmp:1', 'task_ids=9223372036854775808', '']) await agent.get(`/api/tasks/today-executions?${query}`).expect(400);
  await agent.get('/api/tasks/today-executions?task_ids=1,9007199254740993').expect(200);
  expect(read).toHaveBeenCalledWith({ userId: '2', isAdmin: false }, ['1', '9007199254740993']);
  for (const suffix of ['&refresh=invalid', '&refresh=force&refresh_ids=2', '&refresh=due&refresh_ids=1,1']) await agent.get('/api/tasks/today-executions?task_ids=1' + suffix).expect(400);
  await agent.get('/api/tasks/today-executions?task_ids=1&refresh=cache').expect(200);
  expect(read).toHaveBeenLastCalledWith({ userId: '2', isAdmin: false }, ['1'], { refresh: 'cache', refreshIds: ['1'] });
  await agent.get('/api/tasks/today-executions?task_ids=1&refresh=force&refresh_ids=1').expect(200);
  expect(read).toHaveBeenLastCalledWith({ userId: '2', isAdmin: false }, ['1'], { refresh: 'force', refreshIds: ['1'] });
  await agent.post('/api/tasks/today-executions').send({ run: true }).expect(404);
});
