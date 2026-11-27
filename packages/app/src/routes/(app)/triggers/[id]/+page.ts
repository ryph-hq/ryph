import type { PageLoad } from "./$types";
import { getAgents } from "#lib/api/agents.ts";
import { getAutomation, getAutomationFires } from "#lib/api/automations.ts";
import { getChatrooms } from "#lib/api/chatrooms.ts";
import { getConnectedRepos } from "#lib/api/repos.ts";
import { getResponses } from "#lib/api/responses.ts";
import { getTask } from "#lib/api/tasks.ts";
import { getWorkspaces } from "#lib/api/workspaces.ts";

export const load: PageLoad = async ({ fetch, params, depends }) => {
  depends("app:automation");
  const [automation, fires, agents, repos, workspaces, chatrooms, responses] = await Promise.all([
    getAutomation(fetch, params.id),
    getAutomationFires(fetch, params.id),
    getAgents(fetch),
    getConnectedRepos(fetch),
    getWorkspaces(fetch),
    // Only to name the bound room and offer the live ones in the edit dialog; a chat service
    // that is absent or down costs the page a name, not the automation.
    getChatrooms(fetch).catch(() => []),
    // The responses this trigger opened, to show each as one row with its fire count. A list
    // that will not load leaves those runs shown as plain runs, not the page failing.
    getResponses(fetch).catch(() => []),
  ]);
  const mine = responses.filter((r) => r.automationId === automation.id);
  // Only the plain runs' tasks, for their state: a response's row reads its run's state off the
  // response itself. A task that fails to load simply shows no badge.
  const responseTasks = new Set(mine.map((r) => r.taskId));
  const taskIds = [
    ...new Set(
      fires.flatMap((f) => (f.taskId === null || responseTasks.has(f.taskId) ? [] : [f.taskId])),
    ),
  ];
  const tasks = (await Promise.all(taskIds.map(async (id) => {
    try {
      const run = (await getTask(fetch, id)).runs.at(-1);
      return run === undefined ? null : { id, state: run.state, phase: run.phase };
    } catch {
      return null;
    }
  }))).filter((task) => task !== null);
  return {
    automation,
    fires,
    agents,
    repos,
    workspaces,
    chatrooms,
    tasks,
    responses: mine,
    breadcrumb: automation.name,
  };
};
