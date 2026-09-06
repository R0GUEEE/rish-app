import { ProjectViewTasks } from '../src/components/projectViewTasks';

test('late reads do not own a new project or release its busy state', () => {
  const tasks = new ProjectViewTasks();
  tasks.visible = true;
  tasks.invalidate('A');
  const a = tasks.begin('detail');
  tasks.invalidate('B');
  const b = tasks.begin('detail');
  tasks.finish(a);
  expect(tasks.owns(a)).toBe(false);
  expect(tasks.owns(b)).toBe(true);
  expect(tasks.busy).toBe(true);
  tasks.finish(b);
  expect(tasks.busy).toBe(false);
});

test('only the latest same-view detail owns UI or busy state', () => {
  const tasks = new ProjectViewTasks();
  tasks.visible = true;
  const old = tasks.begin('detail');
  const latest = tasks.begin('detail');
  expect(tasks.owns(old)).toBe(false);
  tasks.finish(latest);
  expect(tasks.busy).toBe(false);
});

test('native push stays busy only for its own project across navigation', () => {
  const tasks = new ProjectViewTasks();
  tasks.visible = true;
  tasks.invalidate('A');
  const push = tasks.begin('push');
  tasks.invalidate('B');
  expect(tasks.busy).toBe(false);
  expect(tasks.pushing).toBe(false);
  tasks.invalidate('A');
  expect(tasks.owns(push)).toBe(false);
  expect(tasks.busy).toBe(true);
  expect(tasks.pushing).toBe(true);
  tasks.finish(push);
  expect(tasks.busy).toBe(false);
});

test('an intervening operation invalidates an unconfirmed push', () => {
  const tasks = new ProjectViewTasks();
  tasks.visible = true;
  const confirmation = tasks.begin('push');
  tasks.finish(confirmation);
  expect(tasks.owns(confirmation)).toBe(true);
  const refresh = tasks.begin('detail');
  tasks.finish(refresh);
  expect(tasks.owns(confirmation)).toBe(false);
});

test('a detail refresh does not discard ownership of an already-running push', () => {
  const tasks = new ProjectViewTasks();
  tasks.visible = true;
  const push = tasks.begin('push');
  const refresh = tasks.begin('detail');
  tasks.finish(refresh);
  expect(tasks.owns(push)).toBe(true);
  expect(tasks.pushing).toBe(true);
});
