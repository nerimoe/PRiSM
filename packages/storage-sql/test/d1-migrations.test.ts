import { expect,test } from "bun:test";
import { Database } from "bun:sqlite";
import { splitD1MigrationStatements } from "../src";

test("D1 fixture splitter preserves semicolons and BEGIN/END in escaped literals and trigger bodies",()=>{
  const statements=splitD1MigrationStatements(`-- BEGIN is a comment, not a block
    CREATE TABLE example(value TEXT);
    INSERT INTO example VALUES('it''s; BEGIN END');
    /* END; */
    CREATE TRIGGER example_update BEFORE UPDATE ON example
    BEGIN SELECT RAISE(ABORT,'no; updates'); END;
  `);
  expect(statements).toHaveLength(3);
  const db=new Database(":memory:");
  try {
    for(const sql of statements)db.run(sql);
    expect(db.query("SELECT value FROM example").get()).toEqual({value:"it's; BEGIN END"});
    expect(()=>db.run("UPDATE example SET value='changed'")).toThrow("no; updates");
  } finally {db.close();}
});
