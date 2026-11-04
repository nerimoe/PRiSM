import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * The `ASSETS` binding from a built `prism-web/dist`, as Wrangler serves it:
 * a file, then `<path>.html` or `<path>/index.html`, and otherwise the app's
 * `index.html` (`not_found_handling: "single-page-application"`). Which paths
 * reach it at all is still decided by `worker.ts`.
 */
export function localAssets(directory: string) {
  const root = resolve(directory);
  const index = resolve(root, "index.html");
  if (!existsSync(index)) throw new Error(`No built web app at ${root}; run bun run build:web`);
  const file = (path: string) => {
    if (path !== root && !path.startsWith(root + sep)) return null;
    return existsSync(path) && statSync(path).isFile() ? path : null;
  };
  return {
    async fetch(input: Request | string): Promise<Response> {
      const request = typeof input === "string" ? new Request(input) : input;
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const target = resolve(root, `.${pathname}`);
      const found = file(target) ?? file(`${target}.html`) ?? file(resolve(target, "index.html")) ?? index;
      // Hashed build files never change; everything else is checked on each load.
      const immutable = found !== index && pathname.startsWith("/assets/");
      const headers = {
        "content-type": Bun.file(found).type,
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
      };
      return new Response(request.method === "HEAD" ? null : Bun.file(found), { headers });
    },
  };
}
