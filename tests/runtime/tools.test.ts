// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { benchCodingTools, benchReadOnlyTools, makeJsonOutputTool } from "../../src/runtime/tools.js";

const TMP = import.meta.dirname ?? ".";

describe("benchReadOnlyTools", () => {
  it("returns the read-only core tools (read/grep/find/ls) for the given cwd", () => {
    const names = benchReadOnlyTools(TMP).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read", "grep", "find", "ls"]));
    // mutating tools must NOT be present in the read-only set
    expect(names).not.toContain("bash");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("write");
  });
});

describe("benchCodingTools", () => {
  it("returns pi's coding tool set (bash/edit/read/write) for the given cwd", () => {
    // pi partitions tools: createCodingTools = {bash,edit,read,write}; createReadOnlyTools
    // = {find,grep,ls,read}. A stage needing both sets combines them at its call site.
    const names = benchCodingTools(TMP).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["bash", "edit", "read", "write"]));
  });
});

describe("makeJsonOutputTool", () => {
  it("builds a valid AgentTool (name/description/parameters/execute)", () => {
    const schema = Type.Object({ value: Type.Integer() });
    const tool = makeJsonOutputTool("write_thing", "Emit the thing as JSON.", schema);
    expect(tool.name).toBe("write_thing");
    expect(tool.description).toBe("Emit the thing as JSON.");
    expect(tool.label).toBe("write_thing");
    expect(tool.parameters).toBe(schema);
    expect(typeof tool.execute).toBe("function");
  });

  it("execute validates params against the schema, accumulates the emitted JSON, and acks the agent", async () => {
    const schema = Type.Object({ value: Type.Integer() });
    const tool = makeJsonOutputTool("write_thing", "Emit the thing as JSON.", schema);
    const result = await tool.execute("call-1", { value: 7 } as unknown as never);
    expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/recorded|captured|done/i) }]);
    expect(tool._captured).toEqual([{ value: 7 }]);
  });

  it("execute rejects params that fail schema validation (does not accumulate)", async () => {
    const schema = Type.Object({ value: Type.Integer() });
    const tool = makeJsonOutputTool("write_thing", "Emit the thing as JSON.", schema);
    const result = await tool.execute("call-1", { value: "not-an-int" } as unknown as never);
    // rejection surfaces as an error text result; nothing accumulated
    expect(tool._captured).toEqual([]);
    expect(result.content[0]).toMatchObject({ type: "text" });
  });
});
