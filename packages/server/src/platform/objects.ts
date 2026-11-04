/**
 * What the code needs of a Durable Object namespace. Cloudflare's binding has
 * it, and so does the local host (`local/object-host.ts`); callers name the
 * methods they call on the object as `T`, and both platforms honour them.
 *
 * A structural type rather than `DurableObjectNamespace<C>`: that generic is
 * too deep for `tsc` to instantiate when chained.
 */
export type ObjectStub<T = unknown> = T & { fetch(request: Request): Promise<Response> };

export type ObjectNamespace<T = unknown> = {
  getByName(name: string): ObjectStub<T>;
  idFromName(name: string): unknown;
  get(id: unknown): ObjectStub<T>;
};

/** A namespace binding from `Env`, typed by the methods the caller uses. */
export function objectNamespace<T = unknown>(binding: unknown): ObjectNamespace<T> | undefined {
  return binding as ObjectNamespace<T> | undefined;
}
