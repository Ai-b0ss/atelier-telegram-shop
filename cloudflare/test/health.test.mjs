import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const request=()=>new Request("https://example.test/health");
const fakeD1=queries=>({
  prepare(sql){
    queries.push(sql);
    return {
      async first(){return {alive:1}}
    };
  }
});

test("health verifies D1 with a real read rather than just a DB binding",async()=>{
  const queries=[];
  const response=await worker.fetch(request(),{DB:fakeD1(queries),DEMO_MODE:"1"},{});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{
    ok:true,bot:"atelier",mode:"demo",database:true
  });
  assert.equal(queries.length,1,"health must execute one D1 query");
  assert.match(queries[0],/^SELECT\s+1\s+AS\s+alive$/i);
  assert.equal(response.headers.get("Cache-Control"),"no-store");
});

test("health reports 503 if D1 is missing or its query fails",async()=>{
  const absent=await worker.fetch(request(),{DEMO_MODE:"1"},{});
  assert.equal(absent.status,503);
  assert.deepEqual(await absent.json(),{
    ok:false,bot:"atelier",mode:"demo",database:false
  });
  const saved=console.error;
  console.error=()=>{};
  try{
    const broken=await worker.fetch(request(),{
      DB:{prepare(){throw new Error("Synthetic D1 outage; no real credentials")}},
      DEMO_MODE:"1"
    },{});
    assert.equal(broken.status,503);
    assert.deepEqual(await broken.json(),{
      ok:false,bot:"atelier",mode:"demo",database:false
    });
    assert.equal(broken.headers.get("Cache-Control"),"no-store");
  }finally{console.error=saved}
});
