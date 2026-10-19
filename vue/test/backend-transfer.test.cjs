const { parseTaskImport, exportTasks } = require('../lib/taskTransfer.cjs');

describe('任务导入导出', () => {
  it('拒绝旧四列 CSV 创建未绑定任务', () => {
    expect(() => parseTaskImport(
      'Task,Start,Finish,Bot\n测试,09:00:00,10:00:00,机器人A',
      'csv'
    )).toThrow(/schedule_uuid/);
  });

  it('解析带引号逗号、标签和备注的 CSV', () => {
    const rows = parseTaskImport(
      'Task,Start,Finish,Bot,ScheduleUuid,Tags,Note\n"报表,汇总",23:30:00,01:15:00,机器人A,s-1,"日报; 财务;日报","跨天,保留"',
      'csv'
    );
    expect(rows[0]).toMatchObject({
      task: '报表,汇总',
      schedule_uuid: 's-1',
      tags: ['日报', '财务'],
      note: '跨天,保留',
    });
  });

  it('导出只包含任务元数据，不包含执行历史', () => {
    const output = exportTasks([{
      task: '测试', start: '09:00:00', finish: '10:00:00', bot: 'A',
      owner: { display_name: '用户甲' }, schedule_uuid: 's-1', tags: ['日报'], note: '',
      executions: [{ task_uuid: 'secret-history' }],
    }], 'json');
    expect(output.body).toContain('ScheduleUuid');
    expect(output.body).not.toContain('secret-history');
  });

  it('JSON 导出后重新导入保留多个标签、备注和跨天时间', () => {
    const task = {
      task: '报表汇总', start: '23:30:00', finish: '01:15:00', bot: 'A',
      schedule_uuid: 's-1', tags: ['每日', '财务'], note: '跨天运行',
    };
    const output = exportTasks([task], 'json');
    expect(parseTaskImport(output.body, 'json')).toEqual([task]);
  });

  it('JSON 继续兼容标签数组和旧版逗号分隔的标签', () => {
    const task = {
      task: '测试', start: '09:00:00', finish: '10:00:00', bot: 'A',
      schedule_uuid: 's-1', note: '',
    };
    const rows = parseTaskImport(JSON.stringify([
      { ...task, tags: ['每日', '含逗号,的标签'] },
      { ...task, tags: '每日, 财务,每日' },
    ]), 'json');
    expect(rows[0].tags).toEqual(['每日', '含逗号,的标签']);
    expect(rows[1].tags).toEqual(['每日', '财务']);
  });
});
