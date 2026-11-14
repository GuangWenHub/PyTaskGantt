// Persist only display metadata, never upstream app parameters or credentials.
export function normalizeScheduleDispatch(schedule = {}) {
  schedule ||= {};
  const clients = new Map();
  for (const client of Array.isArray(schedule.robotClientList) ? schedule.robotClientList : []) {
    if (!client || typeof client !== 'object') continue;
    const id = String(client.uuid || client.robotClientUuid || '').trim();
    const name = String(client.robotClientName || '').trim();
    if (id && name) clients.set(id, { id, name });
  }
  return {
    execute_scope: ['any', 'all'].includes(schedule.executeScope) ? schedule.executeScope : '',
    client_scope: ['assign', 'group'].includes(schedule.clientScope) ? schedule.clientScope : '',
    clients: [...clients.values()],
  };
}

export function isSharedTask(task) {
  return task.schedule_dispatch?.execute_scope === 'any' && task.schedule_dispatch.clients?.length > 1;
}

export function sourceTask(task) { return task._sourceTask || task; }

export function candidateExecutionText(task) {
  const source = sourceTask(task);
  if (!isSharedTask(source)) return '';
  const names = [...new Set(source.schedule_dispatch.clients.map(client => client.name).filter(Boolean))];
  return `所有候选机器：${names.join('、')}（随机选择一台执行）`;
}

export function candidateName(client) { return client.name.split('@')[0]; }

export function candidateNames(task) {
  return task.shared_candidate ? [task.bot] : isSharedTask(task) ? task.schedule_dispatch.clients.map(candidateName) : [task.bot];
}

export function projectSharedTasks(tasks) {
  return tasks.flatMap(task => !isSharedTask(task) ? [task] : task.schedule_dispatch.clients.map(client => ({
    ...task,
    view_id: `${task.id}:candidate:${client.id}`,
    bot: candidateName(client),
    candidate_client: client,
    shared_candidate: true,
    _sourceTask: task,
  })));
}
