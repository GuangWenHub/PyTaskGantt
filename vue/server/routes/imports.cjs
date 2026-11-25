const express = require('express');
const asyncHandler = require('../middleware/asyncHandler.cjs');
const { z } = require('zod');
const { ValidationError, ConflictError } = require('../errors.cjs');
const { readImportRows, normalizeImportedTask, exportTasks } = require('../../lib/taskTransfer.cjs');
const { parseBatch, isValidBigintId } = require('../services/taskValidation.cjs');
const { presentTask } = require('../presenters.cjs');

function createImportsRouter({ tasksRepository, taskMutationService }) {
  const router = express.Router();
  const listTasks = req => tasksRepository.listAll(req.userId, { currentUserIsAdmin: req.actor.isAdmin });
  function readImport(req) {
    const format = String(req.body && req.body.format || '').toLowerCase();
    if (!['csv', 'json'].includes(format)) throw new ValidationError('导入格式必须是 csv 或 json');
    return { rows: readImportRows(req.body.content, format), csv: format === 'csv' };
  }
  const makeMutation = (row, index, csv) => ({
    type: 'create', temp_id: `import:${index}`, ...normalizeImportedTask(row, index, csv),
  });

  router.post('/import/preview', asyncHandler(async (req, res) => {
    const { rows, csv } = readImport(req);
    const bound = new Map((await listTasks(req)).map(task => {
      const item = presentTask(task);
      return [item.schedule_uuid, item.task];
    }));
    res.json({ rows: rows.map((row, index) => {
      const info = {
        index, task: String(row?.task ?? row?.Task ?? '').slice(0, 200),
        bot: String(row?.bot ?? row?.Bot ?? '').slice(0, 100),
        start: String(row?.start ?? row?.Start ?? '').slice(0, 20),
        finish: String(row?.finish ?? row?.Finish ?? '').slice(0, 20),
        schedule_uuid: String(row?.schedule_uuid ?? row?.ScheduleUuid ?? '').trim().slice(0, 200),
      };
      try {
        const mutation = makeMutation(row, index, csv);
        parseBatch({ mutations: [mutation] });
        if (bound.has(mutation.schedule_uuid)) {
          return { ...info, error: `计划已绑定到「${bound.get(mutation.schedule_uuid)}」，请跳过该条` };
        }
        return { ...info, error: '' };
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return { ...info, error: error.message };
      }
    }) });
  }));

  router.post('/import', asyncHandler(async (req, res) => {
    const { rows, csv } = readImport(req);
    const requested = req.body.indices;
    const indices = requested === undefined ? rows.map((_, index) => index) : requested;
    if (!Array.isArray(indices) || !indices.length || indices.length > 500 || new Set(indices).size !== indices.length ||
      indices.some(index => !Number.isInteger(index) || index < 0 || index >= rows.length)) {
      throw new ValidationError('请选择 1 至 500 条有效且不重复的文件记录');
    }
    const result = await taskMutationService.applyBatch(req.actor, {
      mutations: indices.map(index => makeMutation(rows[index], index, csv)),
      audit_action: 'import',
    });
    res.json({
      ...result,
      tasks: (result.tasks || []).map(presentTask),
      count: indices.length,
      message: `成功新增 ${indices.length} 条任务`,
    });
  }));

  const sendExport = asyncHandler(async (req, res) => {
    const format = String(req.params.format || '').toLowerCase();
    if (!['csv', 'json'].includes(format)) throw new ValidationError('导出格式必须是 csv 或 json');
    let tasks = (await listTasks(req)).map(presentTask);
    if (req.method === 'POST') {
      const parsed = z.object({ task_ids: z.array(z.string().refine(isValidBigintId)).min(1) }).strict().safeParse(req.body);
      if (!parsed.success) throw new ValidationError('请选择要导出的任务');
      const ids = new Set(parsed.data.task_ids);
      if (ids.size !== parsed.data.task_ids.length) throw new ValidationError('导出任务不能重复');
      tasks = tasks.filter(task => ids.has(task.id));
      if (tasks.length !== ids.size) throw new ConflictError('EXPORT_TASKS_CHANGED', '部分所选任务已不存在，请更新列表后重试');
    }
    const output = exportTasks(tasks, format);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', output.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="tasks_${date}.${format}"`);
    res.send(output.body);
  });
  router.get('/export/:format', sendExport);
  router.post('/export/:format', sendExport);

  return router;
}

module.exports = { createImportsRouter };
