import { createPrismWorkerApp, type PrismWorkerEnv } from "./index";

export default {
  fetch(request: Request, env: PrismWorkerEnv): Response | Promise<Response> {
    return createPrismWorkerApp(env).fetch(request);
  },
};
