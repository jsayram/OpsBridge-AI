import { app, type Bindings } from "./app";
import { sweepDemoWorkspaces } from "./jobs/sweep";

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(sweepDemoWorkspaces(env));
  },
};
