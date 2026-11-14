const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middleware/asyncHandler.cjs');
const { ValidationError } = require('../errors.cjs');
const { presentUser, presentTask, presentExecution } = require('../presenters.cjs');

const versionSchema = z.coerce.number().int().positive();
const MAX_BIGINT = 9223372036854775807n;
const executionPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200),
  offset: z.coerce.number().int().min(0).max(1_000_000_000),
});

function parseBody(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError('请求数据不正确', parsed.error.flatten());
  return parsed.data;
}

function parseBigintId(value, label = 'ID') {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new ValidationError(`${label} 必须使用精确的正整数字符串`);
  }
  const id = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(id)) {
    throw new ValidationError(`${label} 必须是正整数`);
  }
  try {
    if (BigInt(id) > MAX_BIGINT) throw new Error('out of range');
  } catch (_error) {
    throw new ValidationError(`${label} 超出 BIGINT 范围`);
  }
  return id;
}

function parseTaskId(value) {
  return parseBigintId(value, '任务 ID');
}

function parseExecutionPagination(query = {}) {
  return parseBody(executionPaginationSchema, {
    limit: query.limit ?? 50,
    offset: query.offset ?? 0,
  });
}

function presentSyncCutoff(value = {}) {
  return {
    bound_count: Number(value.boundCount || 0),
    timestamp: value.timestamp || null,
    incomplete: Boolean(value.incomplete),
  };
}

async function readSyncCutoff(tasksRepository) {
  if (typeof tasksRepository.getSyncCutoff !== 'function') {
    return presentSyncCutoff();
  }
  return presentSyncCutoff(await tasksRepository.getSyncCutoff());
}

function createTasksRouter({ usersRepository, tasksRepository, taskMutationService, taskActionService, syncCoordinator, todayExecutions }) {
  const router = express.Router();

  router.get('/users', asyncHandler(async (_req, res) => {
    res.json({ users: (await usersRepository.listActive()).map(presentUser) });
  }));

  if (todayExecutions) router.get('/tasks/today-executions', asyncHandler(async (req, res) => {
    if (typeof req.query.task_ids !== 'string') throw new ValidationError('请指定任务ID');
    const ids = req.query.task_ids ? req.query.task_ids.split(',').map(parseTaskId) : [];
    if (ids.length > 500 || new Set(ids).size !== ids.length) throw new ValidationError('最多查询500个不重复的任务');
    const mode = req.query.refresh;
    if (mode != null && !['cache', 'due', 'force'].includes(mode)) throw new ValidationError('运行记录刷新方式不正确');
    const selected = req.query.refresh_ids;
    if (selected != null && typeof selected !== 'string') throw new ValidationError('核对任务ID不正确');
    const refreshIds = selected == null ? ids : selected ? selected.split(',').map(parseTaskId) : [];
    if (new Set(refreshIds).size !== refreshIds.length || refreshIds.some(id => !ids.includes(id))) throw new ValidationError('核对任务必须属于本次查询范围');
    res.json(await (mode == null && selected == null ? todayExecutions.read(req.actor, ids) : todayExecutions.read(req.actor, ids, { refresh: mode || 'due', refreshIds })));

  }));

  router.get('/tasks', asyncHandler(async (req, res) => {
    const [tasks, syncCutoff] = await Promise.all([
      tasksRepository.listAll(req.userId, {
        currentUserIsAdmin: req.actor.isAdmin,
      }),
      readSyncCutoff(tasksRepository),
    ]);
    res.json({
      tasks: tasks.map(presentTask),
      sync_cutoff: syncCutoff,
      server_time: new Date().toISOString(),
    });
  }));

  router.get('/my/tasks', asyncHandler(async (req, res) => {
    const filters = {
      query: req.query.query || '',
      tags: Array.isArray(req.query.tags)
        ? req.query.tags
        : String(req.query.tags || '').split(',').map(value => value.trim()).filter(Boolean),
      normalizedStatus: req.query.normalized_status || '',
      sort: req.query.sort || 'updated',
    };
    const [tasks, syncCutoff] = await Promise.all([
      tasksRepository.listMine(req.userId, filters),
      readSyncCutoff(tasksRepository),
    ]);
    res.json({
      tasks: tasks.map(presentTask),
      sync_cutoff: syncCutoff,
      server_time: new Date().toISOString(),
    });
  }));

  // Shared display settings: any authenticated user can manage the common list.
  // This endpoint cannot change schedule/configuration fields or execute tasks.
  router.patch('/tasks/visibility', asyncHandler(async (req, res) => {
    const input = parseBody(z.object({ changes: z.array(z.object({
      id: z.string().transform(value => parseTaskId(value)),
      is_hidden: z.boolean(), expected_hidden: z.boolean(),
    }).strict()).min(1).max(500) }).strict(), req.body);
    if (new Set(input.changes.map(change => change.id)).size !== input.changes.length) throw new ValidationError('任务不能重复');
    const tasks = await tasksRepository.setVisibility(req.actor, input.changes);
    res.json({ tasks: tasks.map(presentTask), server_time: new Date().toISOString() });
  }));

  router.post('/tasks/batch', asyncHandler(async (req, res) => {
    const result = await taskMutationService.applyBatch(req.actor, req.body);
    res.json({ ...result, tasks: (result.tasks || []).map(presentTask) });
  }));

  router.delete('/tasks/:id', asyncHandler(async (req, res) => {
    const id = parseTaskId(req.params.id);
    const { version } = parseBody(z.object({ version: versionSchema }), req.body || {});
    const result = await taskMutationService.applyBatch(req.actor, {
      mutations: [{ type: 'delete', id, version }],
    });
    res.json({ ...result, tasks: (result.tasks || []).map(presentTask) });
  }));

  router.post('/tasks/:id/rebind', asyncHandler(async (req, res) => {
    const taskId = parseTaskId(req.params.id);
    const input = parseBody(z.object({
      schedule_uuid: z.string().trim().min(1).max(200),
      version: versionSchema,
    }), req.body);
    const result = await taskActionService.rebind(req.actor, taskId, input);
    res.json({ ...result, task: presentTask(result.task) });
  }));

  router.post('/tasks/:id/transfer', asyncHandler(async (req, res) => {
    const taskId = parseTaskId(req.params.id);
    const input = parseBody(z.object({
      target_user_id: z.union([z.string().min(1), z.number().positive()]),
      version: versionSchema,
    }), req.body);
    input.target_user_id = parseBigintId(input.target_user_id, '接收用户 ID');
    const result = await taskActionService.transfer(req.actor, taskId, input);
    res.json({ ...result, task: presentTask(result.task) });
  }));

  router.post('/tasks/:id/run', asyncHandler(async (req, res) => {
    const taskId = parseTaskId(req.params.id);
    res.status(202).json(await taskActionService.runNow(req.actor, taskId));
  }));

  router.post('/tasks/:id/sync', asyncHandler(async (req, res) => {
    const taskId = parseTaskId(req.params.id);
    res.status(202).json(await syncCoordinator.syncTask(req.actor, taskId));
  }));

  router.post('/my/tasks/sync', asyncHandler(async (req, res) => {
    res.status(202).json(await syncCoordinator.syncUser(req.userId));
  }));

  router.get('/tasks/:id/executions', asyncHandler(async (req, res) => {
    const taskId = parseTaskId(req.params.id);
    const pagination = parseExecutionPagination(req.query);
    const result = typeof tasksRepository.listExecutionsPage === 'function'
      ? await tasksRepository.listExecutionsPage(taskId, pagination)
      : {
          executions: await tasksRepository.listExecutions(taskId, pagination),
          pagination: null,
        };
    const executions = result.executions || [];
    const metadata = result.pagination || {
      ...pagination,
      total: pagination.offset + executions.length,
      hasMore: false,
    };
    res.json({
      executions: executions.map(presentExecution),
      pagination: {
        limit: metadata.limit,
        offset: metadata.offset,
        total: metadata.total,
        has_more: Boolean(metadata.hasMore ?? metadata.has_more),
      },
    });
  }));

  return router;
}

module.exports = { createTasksRouter, parseBigintId, parseTaskId, parseExecutionPagination };
