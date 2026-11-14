const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middleware/asyncHandler.cjs');
const { ValidationError } = require('../errors.cjs');
const { presentTask } = require('../presenters.cjs');
function createScheduleReconciliationRouter(service) {
  const router = express.Router();
  const ruleSchema = z.union([
    z.object({ task_id: z.string().regex(/^[1-9]\d*$/), schedule_uuid: z.string().min(1).max(200),
      field: z.enum(['task','bot','timing_mode','start','finish','schedule_dispatch','schedule_cron_expression']) }).strict(),
    z.object({ task_id: z.null(), schedule_uuid: z.string().min(1).max(200), field: z.literal('plan') }).strict(),
  ]);
  router.get('/yingdao/reconciliation/state', asyncHandler(async (req, res) => { res.json(await service.sharedState(req.actor)); }));
  router.delete('/yingdao/reconciliation/whitelist/batch', asyncHandler(async (req, res) => {
    const parsed = z.object({ rules: z.array(ruleSchema).min(1).max(500) }).strict().safeParse(req.body);
    if (!parsed.success) throw new ValidationError('白名单选择不正确', parsed.error.flatten());
    res.json(await service.restoreRules(req.actor, parsed.data.rules));
  }));
  for (const method of ['post', 'delete']) router[method]('/yingdao/reconciliation/whitelist', asyncHandler(async (req, res) => {
    const parsed = ruleSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('白名单属性不正确', parsed.error.flatten());
    res.json(await service.changeRule(req.actor, parsed.data, method === 'delete'));
  }));
  router.post('/yingdao/reconciliation', asyncHandler(async (req, res) => { res.status(202).json(await service.start(req.actor)); }));
  router.get('/yingdao/reconciliation/:id', asyncHandler(async (req, res) => { res.json(await service.get(String(req.params.id), req.actor)); }));
  router.post('/yingdao/reconciliation/:id/recheck', asyncHandler(async (req, res) => {
    const parsed = z.object({ entry_ids: z.array(z.string().uuid()).min(1).max(500) }).strict().safeParse(req.body);
    if (!parsed.success) throw new ValidationError('异常记录选择不正确', parsed.error.flatten());
    res.json(await service.recheck(String(req.params.id), req.actor, parsed.data.entry_ids));
  }));
  router.post('/yingdao/reconciliation/:id/apply', asyncHandler(async (req, res) => {
    const parsed = z.object({ entry_ids: z.array(z.string().uuid()).min(1).max(500), form: z.unknown().optional(), bulk_create: z.boolean().optional() }).strict().safeParse(req.body);
    if (!parsed.success) throw new ValidationError('差异选择不正确', parsed.error.flatten());
    const result = await service.apply(String(req.params.id), req.actor, parsed.data);
    res.json({ ...result, tasks: (result.tasks || []).map(presentTask) });
  }));
  return router;
}
module.exports = { createScheduleReconciliationRouter };
