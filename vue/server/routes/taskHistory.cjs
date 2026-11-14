const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middleware/asyncHandler.cjs');
const { ValidationError } = require('../errors.cjs');
const { parseBigintId } = require('./tasks.cjs');

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) throw new ValidationError('操作记录参数不正确', result.error.flatten());
  return result.data;
}

function createTaskHistoryRouter({ historyRepository, historyService }) {
  const router = express.Router();
  router.get('/task-history', asyncHandler(async (req, res) => {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(50) }), { limit: req.query.limit ?? 5 });
    const filters = { limit };
    if (req.query.page != null) filters.page = parse(z.coerce.number().int().min(1).max(1000000), req.query.page);
    if (req.query.task_ids != null) {
      if (typeof req.query.task_ids !== 'string') throw new ValidationError('任务筛选参数不正确');
      filters.task_ids = req.query.task_ids === '' ? [] : req.query.task_ids.split(',').map(parseBigintId);
    }
    for (const field of ['task_id', 'actor_id', 'before_id']) {
      if (req.query[field] != null && req.query[field] !== '') filters[field] = parseBigintId(req.query[field]);
    }
    res.json(await historyRepository.list(req.actor, filters));
  }));
  router.patch('/task-history/:id/annotation', asyncHandler(async (req, res) => {
    const input = parse(z.object({ annotation: z.string().trim().max(1000), version: z.number().int().nonnegative() }).strict(), req.body);
    res.json(await historyService.annotate(req.actor, parseBigintId(req.params.id), input));
  }));
  router.get('/task-history/:id/restore-preview', asyncHandler(async (req, res) => {
    res.json(await historyService.preview(req.actor, parseBigintId(req.params.id)));
  }));
  router.post('/task-history/:id/restore', asyncHandler(async (req, res) => {
    const { version } = parse(z.object({ version: z.number().int().positive() }).strict(), req.body);
    res.json(await historyService.restore(req.actor, parseBigintId(req.params.id), version));
  }));
  return router;
}

module.exports = { createTaskHistoryRouter };
