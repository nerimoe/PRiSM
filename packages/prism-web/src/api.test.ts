import { afterEach, expect, test } from "bun:test";
import { api, ApiError, playerOperation } from "./api";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test("v1 client unwraps data and preserves actionable error codes", async () => {
  globalThis.fetch = Object.assign(async () => Response.json({ data: { value: 42 } }), { preconnect: originalFetch.preconnect });
  expect(await api("/api/v1/me")).toEqual({ value: 42 });
  globalThis.fetch = Object.assign(async () => Response.json({ error: { code: "LOCATION_REQUIRED", message: "需要定位" } }, { status: 403 }), { preconnect: originalFetch.preconnect });
  try { await api("/api/v1/me"); throw new Error("Expected an error"); } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("LOCATION_REQUIRED");
  }
});

test("a lost checkout response reuses its operation ID",async()=>{
  const storage=new Map<string,string>();
  const previous=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
  Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)}});
  const bodies:string[]=[];
  globalThis.fetch=Object.assign(async (_url:unknown,init?:RequestInit)=>{bodies.push(String(init?.body));if(bodies.length===1)throw new Error("connection lost");return Response.json({data:{ok:true}});},{preconnect:originalFetch.preconnect});
  try{
    await expect(playerOperation("/api/v1/shops/test/player/checkout/confirm",{})).rejects.toThrow();
    expect(await playerOperation("/api/v1/shops/test/player/checkout/confirm",{})).toEqual({ok:true});
    expect(JSON.parse(bodies[0]!).operationId).toBe(JSON.parse(bodies[1]!).operationId);
    expect(storage.size).toBe(0);
  }finally{if(previous)Object.defineProperty(globalThis,"sessionStorage",previous);else Reflect.deleteProperty(globalThis,"sessionStorage");}
});
