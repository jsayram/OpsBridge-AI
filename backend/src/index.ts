import { app, type Bindings } from "./app";
import { dispatchDue } from "./jobs/dispatch";
import { sweepDemoWorkspaces } from "./jobs/sweep";

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(sweepDemoWorkspaces(env));
    // The safety net for after-commit dispatch: at most three events a tick (PRD 6.2).
    ctx.waitUntil(dispatchDue(env));
  },
};
