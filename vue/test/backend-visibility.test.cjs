const request = require('supertest');
const session = require('express-session');
const { createApp } = require('../server/app.cjs');
test('共享隐藏名单仍要求登录、允许来源及严格参数，普通账号仅能调整展示字段', async () => {
  const user = { id: '2', auth_provider: 'dev', display_name: '用户', is_admin: false };
  const calls = [];
  const app = createApp({ config: { authMode: 'dev', corsOrigins: ['http://localhost:5174'], sessionSecret: 'visibility-test-secret', sessionMaxAgeSeconds: 3600 },
    sessionStore: new session.MemoryStore(), logger: { error() {} },
    repositories: { users: { findActiveById: async () => user, findActiveDevById: async () => user, touchLastLogin: async () => {} },
      tasks: { async setVisibility(actor, changes) { calls.push({ actor, changes }); return [{ id: '1', isHidden: true }]; } } },
    services: { taskMutation: {}, taskActions: {}, syncCoordinator: {}, scheduleDirectory: {}, executionDetails: {} } });
  const payload = { changes: [{ id: '1', expected_hidden: false, is_hidden: true }] };
  await request(app).patch('/api/tasks/visibility').send(payload).expect(401);
  const agent = request.agent(app);
  await agent.post('/api/auth/dev/switch').set('Origin', 'http://localhost:5174').send({ user_id: '2' }).expect(200);
  await agent.patch('/api/tasks/visibility').set('Origin', 'http://untrusted.test').send(payload).expect(403);
  for (const body of [{ changes: [] }, { changes: [...payload.changes, ...payload.changes] }, { changes: [{ ...payload.changes[0], bot: 'forbidden' }] }, { changes: [{ ...payload.changes[0], id: '9223372036854775808' }] }, { changes: [{ id: '1', is_hidden: true }] }]) {
    await agent.patch('/api/tasks/visibility').set('Origin', 'http://localhost:5174').send(body).expect(400);
  }
  const response = await agent.patch('/api/tasks/visibility').set('Origin', 'http://localhost:5174').send(payload).expect(200);
  expect(calls).toEqual([{ actor: { userId: '2', isAdmin: false }, changes: payload.changes }]);
  expect(response.body.tasks[0].is_hidden).toBe(true);
});
